import { appendFile, stat, rename, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureDir } from './fs'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'
type LogCategory = 'system' | 'triage' | 'discord' | 'github' | 'social' | 'sync' | 'llm'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }
const LEVEL_LABELS: Record<LogLevel, string> = { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR' }

let logDir = ''
let currentLogDate = ''
let minLevel: LogLevel = 'info'
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB
const RETENTION_DAYS = 7

export function initLogger(opts: { logDir: string; level?: LogLevel }): void {
  logDir = opts.logDir
  minLevel = opts.level ?? 'info'
}

export function log(
  level: LogLevel,
  category: LogCategory,
  message: string,
  context?: Record<string, unknown>,
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return

  const now = new Date()
  const timestamp = now.toISOString()
  const label = LEVEL_LABELS[level]

  // Console output (formatted)
  const prefix = `[${timestamp.substring(11, 19)}] [${label}] [${category}]`
  const consoleMethod = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  consoleMethod(`${prefix} ${message}`)

  // File output (JSON lines) — fire and forget
  if (logDir) {
    const dateStr = timestamp.substring(0, 10)
    const entry = JSON.stringify({ ts: timestamp, level, cat: category, msg: message, ...context })
    writeToLog(dateStr, entry + '\n').catch(() => {})
  }
}

async function writeToLog(dateStr: string, line: string): Promise<void> {
  await ensureDir(logDir)
  const logFile = join(logDir, `bot-${dateStr}.jsonl`)

  // Rotate if file is too large
  try {
    const stats = await stat(logFile)
    if (stats.size > MAX_FILE_SIZE) {
      const rotated = join(logDir, `bot-${dateStr}-${Date.now()}.jsonl`)
      await rename(logFile, rotated)
    }
  } catch {
    // File doesn't exist yet
  }

  await appendFile(logFile, line, 'utf-8')

  // Cleanup old logs on date change
  if (dateStr !== currentLogDate) {
    currentLogDate = dateStr
    cleanOldLogs().catch(() => {})
  }
}

async function cleanOldLogs(): Promise<void> {
  const files = await readdir(logDir)
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS)

  for (const file of files) {
    if (!file.startsWith('bot-') || !file.endsWith('.jsonl')) continue
    const dateMatch = file.match(/bot-(\d{4}-\d{2}-\d{2})/)
    if (!dateMatch) continue
    const fileDate = new Date(dateMatch[1])
    if (fileDate < cutoff) {
      await unlink(join(logDir, file)).catch(() => {})
    }
  }
}

export const logInfo = (cat: LogCategory, msg: string, ctx?: Record<string, unknown>) =>
  log('info', cat, msg, ctx)
export const logWarn = (cat: LogCategory, msg: string, ctx?: Record<string, unknown>) =>
  log('warn', cat, msg, ctx)
export const logError = (cat: LogCategory, msg: string, ctx?: Record<string, unknown>) =>
  log('error', cat, msg, ctx)
export const logDebug = (cat: LogCategory, msg: string, ctx?: Record<string, unknown>) =>
  log('debug', cat, msg, ctx)
