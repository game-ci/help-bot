import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureDir } from './utils/fs'
import { DATA_DIR } from './utils/paths'

export interface GitHubRepoState {
  issueCursor?: string
  commentCursor?: string
  releaseCursor?: string
  tagCursor?: string
}

export interface DiscordGuildCursors {
  [channelId: string]: string
}

export interface SyncState {
  github?: Record<string, GitHubRepoState>
  /** Legacy flat cursor map -- kept for backward compatibility */
  discord?: Record<string, string>
  /** Per-guild cursor state: cursors.discord.{guildName}.{channelId} */
  cursors?: {
    discord?: Record<string, DiscordGuildCursors>
  }
  meta?: Record<string, unknown>
}

const STATE_FILE = join(DATA_DIR, 'state.json')
let cachedState: SyncState | null = null

export async function loadState(): Promise<SyncState> {
  if (cachedState) {
    return cachedState
  }
  try {
    await ensureDir(DATA_DIR)
    const contents = await readFile(STATE_FILE, 'utf-8')
    cachedState = JSON.parse(contents)
  } catch {
    cachedState = {}
  }
  return cachedState ?? {}
}

export async function saveState(state: SyncState): Promise<void> {
  await ensureDir(DATA_DIR)
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8')
  cachedState = state
}

export async function updateState(mutator: (state: SyncState) => void): Promise<void> {
  const state = await loadState()
  mutator(state)
  await saveState(state)
}

// --- Detection helpers ---

import type { DetectionRecord, DetectionKey } from './dispatch/types'

export function getDetections(state: SyncState): Record<DetectionKey, DetectionRecord> {
  return (state.meta?.detections as Record<DetectionKey, DetectionRecord>) ?? {}
}

export function setDetections(state: SyncState, detections: Record<DetectionKey, DetectionRecord>): void {
  state.meta ??= {}
  state.meta.detections = detections
}

export function getPostedInvestigations(state: SyncState): Record<string, string> {
  return (state.meta?.postedInvestigations as Record<string, string>) ?? {}
}

/**
 * Get the set of issues the bot has already responded to.
 * Keys are `{repo}#{issueNumber}`, values are ISO timestamps of when the response was posted.
 */
export function getPostedResponses(state: SyncState): Record<string, string> {
  return (state.meta?.postedResponses as Record<string, string>) ?? {}
}

/**
 * Record that the bot responded to an issue.
 */
export function setPostedResponse(state: SyncState, repo: string, issueNumber: number): void {
  state.meta ??= {}
  const posted = getPostedResponses(state)
  posted[`${repo}#${issueNumber}`] = new Date().toISOString()
  state.meta.postedResponses = posted
}

/**
 * Get the set of Discord messages the bot has already responded to.
 * Keys are `discord:{guildName}/{channelName}#{messageId}`, values are ISO timestamps.
 */
export function getPostedDiscordResponses(state: SyncState): Record<string, string> {
  return (state.meta?.postedDiscordResponses as Record<string, string>) ?? {}
}

/**
 * Record that the bot responded to a Discord message.
 */
export function setPostedDiscordResponse(
  state: SyncState,
  guildName: string,
  channelName: string,
  messageId: string,
): void {
  state.meta ??= {}
  const posted = getPostedDiscordResponses(state)
  posted[`discord:${guildName}/${channelName}#${messageId}`] = new Date().toISOString()
  state.meta.postedDiscordResponses = posted
}

// --- Live mode online timestamp ---

/**
 * Get the last time the bot was known to be online.
 * Returns undefined on first-ever run (no catch-up should happen).
 */
export function getLastOnlineAt(state: SyncState): string | undefined {
  return state.meta?.lastOnlineAt as string | undefined
}

/**
 * Get the first-ever online timestamp. Nothing before this should ever be processed.
 */
export function getFirstOnlineAt(state: SyncState): string | undefined {
  return state.meta?.firstOnlineAt as string | undefined
}

/**
 * Update the last-online timestamp (call periodically while running).
 * Also sets firstOnlineAt on first-ever call (never overwritten after that).
 */
export function setLastOnlineAt(state: SyncState, iso?: string): void {
  state.meta ??= {}
  const now = iso ?? new Date().toISOString()
  if (!state.meta.firstOnlineAt) {
    state.meta.firstOnlineAt = now
  }
  state.meta.lastOnlineAt = now
}

// --- Triage helpers ---

import type { TriageRecord } from './triage/types'

export function getTriageRecords(state: SyncState): Record<string, TriageRecord> {
  return (state.meta?.triageRecords as Record<string, TriageRecord>) ?? {}
}

export function setTriageRecords(state: SyncState, records: Record<string, TriageRecord>): void {
  state.meta ??= {}
  state.meta.triageRecords = records
}

export function getTriageRecord(state: SyncState, key: string): TriageRecord | undefined {
  return getTriageRecords(state)[key]
}

export function setTriageRecord(state: SyncState, key: string, record: TriageRecord): void {
  const records = getTriageRecords(state)
  records[key] = record
  setTriageRecords(state, records)
}

// --- Guild-namespaced cursor helpers ---

export function getGuildCursor(state: SyncState, guildName: string, channelId: string): string | undefined {
  return state.cursors?.discord?.[guildName]?.[channelId]
}

export function setGuildCursor(state: SyncState, guildName: string, channelId: string, cursor: string): void {
  state.cursors ??= {}
  state.cursors.discord ??= {}
  state.cursors.discord[guildName] ??= {}
  state.cursors.discord[guildName][channelId] = cursor
}
