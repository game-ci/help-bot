import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Client, TextChannel } from 'discord.js'
import {
  buildInvestigationPrompt,
  buildSingleMessagePrompt,
  type InvestigationSource,
} from '../core/live-utils'
import { getSystemPrompt, getValue, type GuildConfig, type ChannelConfig } from '../config'
import { ensureDir } from '../utils/fs'
import { REPO_ROOT, RESPONSES_DIR } from '../utils/paths'
import { parseFrontMatter } from '../utils/frontmatter'
import { resolveClaude } from '../utils/claude'
import type { TriageRecord } from './types'

export interface TriageInvestigationOptions {
  client: Client
  config: Record<string, unknown>
  model: string
  repoDir?: string
  docsDir?: string
  /** Guild config (for discord sources, to build system prompt) */
  guildConfig?: GuildConfig
  /** Channel config (for discord sources) */
  channelConfig?: ChannelConfig
  /** Previous response text (for re-investigation) */
  previousResponse?: string
  /** Maintainer instructions from thread */
  maintainerInstructions?: string
}

/**
 * Fetch maintainer instructions from a triage notification thread.
 * Reads all non-bot messages from the thread in chronological order.
 */
export async function fetchMaintainerInstructions(
  client: Client,
  threadId: string,
): Promise<string | undefined> {
  try {
    const thread = await client.channels.fetch(threadId)
    if (!thread || !thread.isThread()) return undefined

    const messages = await thread.messages.fetch({ limit: 50 })
    const humanMessages = [...messages.values()]
      .filter((m) => !m.author.bot)
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)

    if (humanMessages.length === 0) return undefined

    const lines = [
      '## Maintainer Guidance',
      '',
      'The following instructions were provided by maintainers. Follow them carefully:',
      '',
    ]
    for (const msg of humanMessages) {
      lines.push(`**@${msg.author.tag ?? msg.author.username}:**`)
      lines.push(msg.content)
      lines.push('')
    }

    return lines.join('\n')
  } catch {
    return undefined
  }
}

/**
 * Run investigation for a triage request.
 * Spawns Claude with the investigation prompt and returns the response file path + preview.
 */
export async function runTriageInvestigation(
  record: TriageRecord,
  options: TriageInvestigationOptions,
): Promise<{ responseFile: string; responsePreview: string } | { error: string } | null> {
  const isDiscord = record.sourceType === 'discord'
  const dir = isDiscord ? 'discord' : 'github'
  const responseDir = join(RESPONSES_DIR, dir)
  await ensureDir(responseDir)

  // Build a unique response ID
  const reinvSuffix = record.reinvestigationCount > 0 ? `-reinv${record.reinvestigationCount}` : ''
  let responseId: string
  if (isDiscord) {
    const parts = record.sourceDiscordPath?.split('/') ?? ['unknown', 'unknown']
    responseId = `triage-${parts[0]}-${parts[1]}-${record.sourceMessageId}${reinvSuffix}`
  } else {
    const repoSlug = record.sourceRepo?.replace(/\//g, '-') ?? 'unknown'
    responseId = `triage-${repoSlug}-${record.sourceIssueNumber}${reinvSuffix}`
  }

  // Build prompt
  let systemPrompt = ''
  if (isDiscord && options.guildConfig && options.channelConfig) {
    const discordConfig = getValue(options.config, ['discord'], {} as Record<string, unknown>)
    systemPrompt = getSystemPrompt(discordConfig, options.guildConfig, options.channelConfig)
  }

  // Append maintainer instructions and/or correction note
  const extraSections: string[] = []

  if (options.previousResponse) {
    extraSections.push(
      '## Previous Response (REJECTED -- maintainer requested re-investigation)',
      '',
      'The following response was previously generated but was rejected:',
      '',
      `> ${options.previousResponse.replace(/\n/g, '\n> ').substring(0, 2000)}`,
      '',
      '**Your task:** Investigate from scratch. Do NOT repeat the same answer. Verify every claim against source code.',
      '',
    )
  }

  if (options.maintainerInstructions) {
    extraSections.push(options.maintainerInstructions)
  }

  const fullSystemPrompt = [systemPrompt, ...extraSections].filter(Boolean).join('\n\n')

  const source: InvestigationSource = isDiscord
    ? {
        type: 'discord',
        guildName: record.sourceDiscordPath?.split('/')[0] ?? 'unknown',
        channelName: record.sourceDiscordPath?.split('/')[1] ?? 'unknown',
      }
    : {
        type: 'github_issue',
        repo: record.sourceRepo ?? 'unknown',
        issueNumber: record.sourceIssueNumber ?? 0,
        title: record.sourceTitle ?? '',
      }

  const prompt = buildInvestigationPrompt({
    author: record.sourceAuthor ?? 'unknown',
    content: record.sourceContent ?? '',
    responseId,
    source,
    systemPrompt: fullSystemPrompt || undefined,
    repoDir: options.repoDir,
    docsDir: options.docsDir,
    isFollowUp: record.reinvestigationCount > 0,
    labels: record.sourceLabels,
  })

  // Spawn Claude
  const maxTurns = Number(getValue(options.config, ['llm', 'claude', 'max_turns'], 0)) || 25
  const args = ['-p', '--model', options.model, '--max-turns', String(maxTurns)]
  args.push(
    '--allowedTools',
    'Read',
    '--allowedTools',
    'Glob',
    '--allowedTools',
    'Grep',
    '--allowedTools',
    'Bash',
    '--allowedTools',
    'Write',
  )
  args.push(
    '--disallowedTools',
    'Edit',
    '--disallowedTools',
    'WebFetch',
    '--disallowedTools',
    'WebSearch',
    '--disallowedTools',
    'NotebookEdit',
    '--disallowedTools',
    'Task',
  )

  const env = { ...process.env }
  delete env.CLAUDECODE

  let stderrOutput = ''
  let exitCode: number | null = null

  try {
    const claudePath = resolveClaude()
    const proc = spawn(claudePath, args, {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'inherit', 'pipe'],
      env,
    })
    proc.stderr.on('data', (d: Buffer) => {
      const chunk = d.toString()
      stderrOutput += chunk
      process.stderr.write(chunk)
    })
    proc.stdin.end(prompt)
    const [code] = (await once(proc, 'exit')) as [number | null]
    exitCode = code
  } catch (error: any) {
    const msg = error.message ?? String(error)
    console.warn(`  Triage investigation failed: ${msg}`)
    return { error: `Claude CLI spawn failed: ${msg}` }
  }

  // Detect common failure modes from stderr
  const combined = stderrOutput.toLowerCase()
  if (combined.includes('not logged in') || combined.includes('please run /login')) {
    const msg =
      'Claude CLI is not logged in. The service user needs to authenticate: run `claude /login` as the service account user.'
    console.warn(`  ${msg}`)
    return { error: msg }
  }
  if (combined.includes('invalid api key') || combined.includes('authentication')) {
    return {
      error: 'Claude CLI authentication failed. Check ANTHROPIC_API_KEY or run `claude /login`.',
    }
  }
  if (exitCode && exitCode !== 0 && !stderrOutput.trim()) {
    return { error: `Claude CLI exited with code ${exitCode}` }
  }

  // Read the response file
  const responseFile = join(responseDir, `${responseId}.md`)
  let responseContent: string
  try {
    responseContent = await readFile(responseFile, 'utf-8')
  } catch {
    const hint = stderrOutput.trim()
      ? `\nClaude output: ${stderrOutput.trim().substring(0, 200)}`
      : ''
    console.warn(`  No response file produced at ${responseFile}`)
    return { error: `No response file produced.${hint}` }
  }

  const { body } = parseFrontMatter(responseContent)
  const cleaned = body
    .replace(/-#\s*Was this helpful\?[^\n]*/gi, '')
    .replace(/Was this helpful\?\s*React with[^\n]*/gi, '')
    .trim()

  if (!cleaned) {
    console.warn(`  Response file is empty`)
    return { error: 'Claude produced an empty response.' }
  }

  // Return the relative path and a preview
  const relPath = responseFile.replace(/\\/g, '/').replace(/^.*?(data\/)/, '$1')
  const preview = cleaned.substring(0, 200) + (cleaned.length > 200 ? '...' : '')

  return { responseFile: relPath, responsePreview: preview }
}
