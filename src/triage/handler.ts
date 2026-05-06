import type { Interaction, ButtonInteraction, Client, TextChannel, ThreadChannel } from 'discord.js'
import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { parseButtonId, parseDiscordCompactId, parseGithubCompactId } from './types'
import type { TriageRecord } from './types'
import { updateTriageNotification, type TriageEmbedOptions } from './notification'
import {
  runTriageInvestigation,
  fetchMaintainerInstructions,
  type TriageInvestigationOptions,
} from './investigation'
import { sendTriageResponse } from './send'
import { loadState, updateState, getTriageRecord, setTriageRecord } from '../state'
import { getValue, type GuildConfig, type ChannelConfig } from '../config'
import { REPO_ROOT } from '../utils/paths'
import { parseFrontMatter } from '../utils/frontmatter'

export interface TriageHandlerContext {
  config: Record<string, unknown>
  model: string
  repoDir?: string
  docsDir?: string
  /** Resolve guild/channel config from guild name and channel name */
  resolveGuildChannel: (
    guildName: string,
    channelName: string,
  ) =>
    | {
        guildConfig: GuildConfig
        channelConfig: ChannelConfig
      }
    | undefined
  /** GitHub collaborator usernames (also checked for triage access) */
  collaborators: string[]
  /** Discord user IDs allowed to use triage controls */
  triageUserIds: string[]
  /** Set bot status to "investigating" */
  setInvestigating: (channelName: string, author: string) => void
  /** Clear bot investigation status */
  clearInvestigating: () => void
}

/**
 * Main InteractionCreate handler for triage buttons.
 * Registered once in live.ts.
 */
export async function handleTriageInteraction(
  interaction: Interaction,
  client: Client,
  context: TriageHandlerContext,
): Promise<void> {
  if (!interaction.isButton()) return

  const parsed = parseButtonId(interaction.customId)
  if (!parsed) return // Not a triage button

  const { action, sourceType, compactId } = parsed

  // Build the triage key to look up the record
  const triageKey = `triage:${sourceType}:${compactId}`

  // Load the triage record
  const state = await loadState()
  const record = getTriageRecord(state, triageKey)

  if (!record) {
    // Stale button -- record was cleaned up
    await interaction.reply({
      content: 'This triage request is no longer active.',
      ephemeral: true,
    })
    return
  }

  // Verify the user is allowed to use triage controls
  const userId = interaction.user.id
  const username = interaction.user.username
  const displayName = interaction.user.tag ?? username
  const isCollaborator = context.collaborators.some(
    (c) => c.toLowerCase() === username.toLowerCase(),
  )
  const isTriageUser = context.triageUserIds.includes(userId)

  if (!isCollaborator && !isTriageUser) {
    await interaction.reply({
      content: 'Only maintainers can use triage controls.',
      ephemeral: true,
    })
    return
  }

  // Acknowledge the interaction
  await interaction.deferUpdate()

  const triageChannel = interaction.channel as TextChannel

  switch (action) {
    case 'investigate':
      await handleInvestigate(record, triageKey, triageChannel, client, context, displayName)
      break
    case 'ignore':
      await handleIgnore(record, triageKey, triageChannel, sourceType, compactId, displayName)
      break
    case 'send':
      await handleSend(record, triageKey, triageChannel, client, sourceType, compactId, displayName)
      break
    case 'reinvestigate':
      await handleReinvestigate(record, triageKey, triageChannel, client, context, displayName)
      break
    case 'view':
      await handleView(
        record,
        triageKey,
        triageChannel,
        displayName,
        interaction as ButtonInteraction,
      )
      break
    case 'file_bug':
      await handleFileBug(record, triageKey, triageChannel, sourceType, compactId, displayName)
      break
  }
}

/**
 * Handle "Investigate" button click.
 * Updates embed to investigating, runs Claude, updates to ready with preview.
 */
async function handleInvestigate(
  record: TriageRecord,
  triageKey: string,
  triageChannel: TextChannel,
  client: Client,
  context: TriageHandlerContext,
  username: string,
): Promise<void> {
  if (record.status !== 'pending') {
    console.log(`  Triage ${triageKey}: already ${record.status}, skipping investigate`)
    return
  }

  console.log(`  Triage: ${username} clicked Investigate for ${triageKey}`)

  const channelName = record.sourceDiscordPath?.split('/')[1] ?? record.sourceRepo ?? 'triage'
  const author = record.sourceAuthor ?? 'unknown'

  // Update to investigating
  record.status = 'investigating'
  record.investigatedBy = username
  record.investigationStartedAt = new Date().toISOString()
  await updateState((s) => setTriageRecord(s, triageKey, record))

  const embedOptions = buildEmbedOptions(record)
  const [sourceType, compactId] = extractSourceInfo(triageKey)
  await updateTriageNotification(
    triageChannel,
    record.triageMessageId,
    embedOptions,
    sourceType,
    compactId,
  )

  // Set bot status
  context.setInvestigating(channelName, author)

  // Run investigation
  const investigationOptions = buildInvestigationOptions(record, client, context)
  const result = await runTriageInvestigation(record, investigationOptions)

  // Clear bot status
  context.clearInvestigating()

  if (result && 'responseFile' in result) {
    record.status = 'ready'
    record.responseFile = result.responseFile
    record.investigationCompletedAt = new Date().toISOString()
    await updateState((s) => setTriageRecord(s, triageKey, record))

    const readyEmbed = buildEmbedOptions(record, result.responsePreview)
    await updateTriageNotification(
      triageChannel,
      record.triageMessageId,
      readyEmbed,
      sourceType,
      compactId,
    )

    // Auto-post full response to thread so maintainers can review before sending
    await postFullResponseToThread(triageChannel, record, triageKey)

    console.log(
      `  Triage: Investigation complete for ${triageKey} (${result.responsePreview.length} char preview)`,
    )
  } else {
    // Investigation failed -- revert to pending
    record.status = 'pending'
    record.investigatedBy = undefined
    await updateState((s) => setTriageRecord(s, triageKey, record))

    const failedEmbed = buildEmbedOptions(record)
    await updateTriageNotification(
      triageChannel,
      record.triageMessageId,
      failedEmbed,
      sourceType,
      compactId,
    )

    const errorMsg = result && 'error' in result ? result.error : 'Unknown error'
    console.warn(`  Triage: Investigation failed for ${triageKey}: ${errorMsg}`)

    // Post error details to the triage thread so maintainers see what went wrong
    await postErrorToThread(triageChannel, record, triageKey, errorMsg)
  }
}

/**
 * Handle "Ignore" / "Discard" / "Cancel" button click.
 */
async function handleIgnore(
  record: TriageRecord,
  triageKey: string,
  triageChannel: TextChannel,
  sourceType: 'd' | 'g',
  compactId: string,
  username: string,
): Promise<void> {
  console.log(`  Triage: ${username} clicked Ignore for ${triageKey}`)

  record.status = 'ignored'
  record.ignoredBy = username
  await updateState((s) => setTriageRecord(s, triageKey, record))

  const embedOptions = buildEmbedOptions(record)
  await updateTriageNotification(
    triageChannel,
    record.triageMessageId,
    embedOptions,
    sourceType,
    compactId,
  )
}

/**
 * Handle "Send Response" button click.
 * Posts the response to the original source and updates the triage message.
 */
async function handleSend(
  record: TriageRecord,
  triageKey: string,
  triageChannel: TextChannel,
  client: Client,
  sourceType: 'd' | 'g',
  compactId: string,
  username: string,
): Promise<void> {
  if (record.status !== 'ready') {
    console.log(`  Triage ${triageKey}: not ready, skipping send`)
    return
  }

  console.log(`  Triage: ${username} clicked Send for ${triageKey}`)

  const success = await sendTriageResponse(record, client)

  if (success) {
    record.status = 'sent'
    record.sentBy = username
    await updateState((s) => setTriageRecord(s, triageKey, record))

    const embedOptions = buildEmbedOptions(record)
    await updateTriageNotification(
      triageChannel,
      record.triageMessageId,
      embedOptions,
      sourceType,
      compactId,
    )
    console.log(`  Triage: Response sent for ${triageKey}`)
  } else {
    console.warn(`  Triage: Failed to send response for ${triageKey}`)
  }
}

/**
 * Handle "Re-investigate" button click.
 * Fetches thread instructions, re-runs investigation with previous response context.
 */
async function handleReinvestigate(
  record: TriageRecord,
  triageKey: string,
  triageChannel: TextChannel,
  client: Client,
  context: TriageHandlerContext,
  username: string,
): Promise<void> {
  if (record.status !== 'ready') {
    console.log(`  Triage ${triageKey}: not ready, skipping reinvestigate`)
    return
  }

  console.log(`  Triage: ${username} clicked Re-investigate for ${triageKey}`)

  // Check if the triage message has a thread for maintainer instructions
  let maintainerInstructions: string | undefined
  try {
    const triageMsg = await triageChannel.messages.fetch(record.triageMessageId)
    if (triageMsg.thread) {
      record.instructionThreadId = triageMsg.thread.id
      maintainerInstructions = await fetchMaintainerInstructions(client, triageMsg.thread.id)
    }
  } catch {
    // No thread or couldn't fetch
  }

  // Read the previous response for correction context
  let previousResponse: string | undefined
  if (record.responseFile) {
    try {
      const filePath = record.responseFile.startsWith('data/')
        ? join(REPO_ROOT, record.responseFile)
        : record.responseFile
      const content = await readFile(filePath, 'utf-8')
      const { body } = parseFrontMatter(content)
      previousResponse = body.trim()
    } catch {
      // Previous response not available -- that's ok
    }
  }

  // Update to investigating
  record.status = 'investigating'
  record.reinvestigationCount++
  record.investigatedBy = username
  record.investigationStartedAt = new Date().toISOString()
  await updateState((s) => setTriageRecord(s, triageKey, record))

  const [sourceType, compactId] = extractSourceInfo(triageKey)
  const investigatingEmbed = buildEmbedOptions(record)
  await updateTriageNotification(
    triageChannel,
    record.triageMessageId,
    investigatingEmbed,
    sourceType,
    compactId,
  )

  // Set bot status
  const channelName = record.sourceDiscordPath?.split('/')[1] ?? record.sourceRepo ?? 'triage'
  const author = record.sourceAuthor ?? 'unknown'
  context.setInvestigating(channelName, author)

  // Run re-investigation
  const investigationOptions = buildInvestigationOptions(
    record,
    client,
    context,
    previousResponse,
    maintainerInstructions,
  )
  const result = await runTriageInvestigation(record, investigationOptions)

  // Clear bot status
  context.clearInvestigating()

  if (result && 'responseFile' in result) {
    record.status = 'ready'
    record.responseFile = result.responseFile
    record.investigationCompletedAt = new Date().toISOString()
    await updateState((s) => setTriageRecord(s, triageKey, record))

    const readyEmbed = buildEmbedOptions(record, result.responsePreview)
    await updateTriageNotification(
      triageChannel,
      record.triageMessageId,
      readyEmbed,
      sourceType,
      compactId,
    )

    // Auto-post full response to thread so maintainers can review before sending
    await postFullResponseToThread(triageChannel, record, triageKey)

    console.log(`  Triage: Re-investigation complete for ${triageKey}`)
  } else {
    record.status = 'ready' // Revert to ready (keep old response)
    record.reinvestigationCount-- // Undo increment
    await updateState((s) => setTriageRecord(s, triageKey, record))

    const failedEmbed = buildEmbedOptions(record)
    await updateTriageNotification(
      triageChannel,
      record.triageMessageId,
      failedEmbed,
      sourceType,
      compactId,
    )

    const errorMsg = result && 'error' in result ? result.error : 'Unknown error'
    console.warn(`  Triage: Re-investigation failed for ${triageKey}: ${errorMsg}`)
    await postErrorToThread(triageChannel, record, triageKey, errorMsg)
  }
}

/**
 * Handle "View Investigation" button click.
 * Posts the investigation artifacts (analysis + findings) to a thread.
 */
async function handleView(
  record: TriageRecord,
  triageKey: string,
  triageChannel: TextChannel,
  username: string,
  interaction: ButtonInteraction,
): Promise<void> {
  if (record.status !== 'ready') {
    console.log(`  Triage ${triageKey}: not ready, skipping view`)
    return
  }

  console.log(`  Triage: ${username} clicked View Investigation for ${triageKey}`)

  const posted = await postInvestigationToThread(triageChannel, record, triageKey)
  if (posted) {
    console.log(`  Triage: Investigation artifacts posted to thread for ${triageKey}`)
  } else {
    try {
      await interaction.followUp({
        content: `Failed to post investigation to thread. Check bot console for details.`,
        ephemeral: true,
      })
    } catch {
      // followUp can fail if interaction expired
    }
  }
}

/**
 * Handle "File Bug" button click.
 * Creates a GitHub issue in the source repo (or help-bot repo for Discord sources)
 * based on the investigation's bug discovery section.
 */
async function handleFileBug(
  record: TriageRecord,
  triageKey: string,
  triageChannel: TextChannel,
  sourceType: 'd' | 'g',
  compactId: string,
  username: string,
): Promise<void> {
  if (record.status !== 'ready') {
    console.log(`  Triage ${triageKey}: not ready, skipping file_bug`)
    return
  }

  if (record.filedBugUrl) {
    // Already filed — post the URL to the thread
    try {
      const triageMsg = await triageChannel.messages.fetch(record.triageMessageId)
      const thread = triageMsg.thread
      if (thread) {
        await thread.send(`Bug already filed: ${record.filedBugUrl}`)
      }
    } catch {
      /* best-effort */
    }
    return
  }

  console.log(`  Triage: ${username} clicked File Bug for ${triageKey}`)

  // Read the investigation response to extract bug details
  if (!record.responseFile) {
    console.warn(`  Triage: no response file for bug filing ${triageKey}`)
    return
  }

  const filePath = record.responseFile.startsWith('data/')
    ? join(REPO_ROOT, record.responseFile)
    : record.responseFile

  let responseBody: string
  try {
    const content = await readFile(filePath, 'utf-8')
    const { body } = parseFrontMatter(content)
    responseBody = body.trim()
  } catch {
    console.warn(`  Triage: could not read response for bug filing ${triageKey}`)
    return
  }

  // Also try to read analysis file for more detail
  const analysisPath = filePath.replace(/\.md$/, '-analysis.md')
  let analysisBody = ''
  try {
    analysisBody = (await readFile(analysisPath, 'utf-8')).trim()
  } catch {
    /* analysis is optional */
  }

  // Determine target repo
  const targetRepo = record.sourceRepo ?? 'game-ci/help-bot'

  // Build issue title and body
  const sourceRef =
    record.sourceRepo && record.sourceIssueNumber
      ? `${record.sourceRepo}#${record.sourceIssueNumber}`
      : record.sourceDiscordPath
        ? `Discord: ${record.sourceDiscordPath}`
        : 'Investigation'

  const issueTitle = `[Bug] ${record.sourceTitle ?? 'Bug discovered during investigation'}`

  const bodyParts: string[] = [
    `## Bug Report (from help bot investigation)`,
    ``,
    `**Source:** ${sourceRef}`,
    `**Reported by:** ${record.sourceAuthor ?? 'unknown'}`,
    `**Filed by:** ${username} via help bot triage`,
    ``,
    `## Investigation Summary`,
    ``,
    responseBody.substring(0, 3000),
  ]

  if (analysisBody) {
    bodyParts.push(``, `## Detailed Analysis`, ``, analysisBody.substring(0, 3000))
  }

  bodyParts.push(``, `---`, `-# Filed by GameCI Help Bot from triage investigation`)

  const issueBody = bodyParts.join('\n')

  // Create the GitHub issue via gh CLI
  const execFileAsync = promisify(execFile)
  try {
    // Try with 'bug' label first, fall back without label if it doesn't exist
    let stdout: string
    try {
      const result = await execFileAsync('gh', [
        'issue',
        'create',
        '--repo',
        targetRepo,
        '--title',
        issueTitle,
        '--body',
        issueBody,
        '--label',
        'bug',
      ])
      stdout = result.stdout
    } catch {
      // Label might not exist — create without it
      const result = await execFileAsync('gh', [
        'issue',
        'create',
        '--repo',
        targetRepo,
        '--title',
        issueTitle,
        '--body',
        issueBody,
      ])
      stdout = result.stdout
    }
    const issueUrl = stdout.trim()
    console.log(`  Triage: Bug filed at ${issueUrl}`)

    // Update record
    record.filedBugUrl = issueUrl
    record.filedBugRepo = targetRepo
    await updateState((s) => setTriageRecord(s, triageKey, record))

    // Update embed
    const embedOptions = buildEmbedOptions(record)
    await updateTriageNotification(
      triageChannel,
      record.triageMessageId,
      embedOptions,
      sourceType,
      compactId,
    )

    // Post to thread
    try {
      const triageMsg = await triageChannel.messages.fetch(record.triageMessageId)
      let thread: ThreadChannel | null = triageMsg.thread
      if (!thread) {
        thread = await triageMsg.startThread({
          name: `Investigation: ${(record.sourceTitle ?? 'Help request').substring(0, 84)}`,
          autoArchiveDuration: 1440,
        })
      } else if (thread.archived) {
        await thread.setArchived(false)
      }
      await thread.send(`**Bug filed** by ${username}: ${issueUrl}`)
    } catch {
      /* thread post is best-effort */
    }
  } catch (err: any) {
    console.error(`  Triage: Bug filing failed for ${triageKey}: ${err.message ?? err}`)
    // Post error to thread
    try {
      const triageMsg = await triageChannel.messages.fetch(record.triageMessageId)
      const thread = triageMsg.thread
      if (thread) {
        await thread.send(`**Bug filing failed:** ${err.message ?? err}`)
      }
    } catch {
      /* best-effort */
    }
  }
}

// --- Helpers ---

const MAX_DISCORD_LENGTH = 2000

/**
 * Post the full investigation response to a thread on the triage message.
 * Creates the thread if it doesn't exist.
 * Returns true on success, false on failure.
 */
async function postFullResponseToThread(
  triageChannel: TextChannel,
  record: TriageRecord,
  triageKey: string,
): Promise<boolean> {
  if (!record.responseFile) {
    console.warn(`  Thread post: no responseFile for ${triageKey}`)
    return false
  }

  // Read the response file first (before touching Discord) to fail fast
  const filePath = record.responseFile.startsWith('data/')
    ? join(REPO_ROOT, record.responseFile)
    : record.responseFile

  let cleaned: string
  try {
    const content = await readFile(filePath, 'utf-8')
    const { body } = parseFrontMatter(content)
    cleaned = body
      .replace(/-#\s*Was this helpful\?[^\n]*/gi, '')
      .replace(/Was this helpful\?\s*React with[^\n]*/gi, '')
      .trim()
  } catch (err: any) {
    console.warn(`  Thread post: could not read response file ${filePath}: ${err.message ?? err}`)
    return false
  }

  if (!cleaned) {
    console.warn(`  Thread post: response body is empty for ${triageKey}`)
    return false
  }

  try {
    console.log(`    Thread post: fetching triage message ${record.triageMessageId}...`)
    const triageMsg = await triageChannel.messages.fetch(record.triageMessageId)
    console.log(`    Thread post: message fetched, hasThread=${!!triageMsg.thread}`)

    // Create or get existing thread
    let thread: ThreadChannel
    if (triageMsg.thread) {
      thread = triageMsg.thread
      // Unarchive if needed
      if (thread.archived) {
        console.log(`    Thread post: unarchiving thread ${thread.id}...`)
        await thread.setArchived(false)
      }
    } else {
      console.log(`    Thread post: creating new thread...`)
      thread = await triageMsg.startThread({
        name: `Investigation: ${(record.sourceTitle ?? 'Help request').substring(0, 84)}`,
        autoArchiveDuration: 1440, // 24 hours
      })
      console.log(`    Thread post: thread created ${thread.id}`)
    }

    // Post the full response in chunks
    const header =
      record.reinvestigationCount > 0
        ? `**Re-investigation #${record.reinvestigationCount} — Full Response:**\n\n`
        : `**Full Response:**\n\n`
    const fullText = header + cleaned
    const chunks = splitForDiscord(fullText)
    console.log(
      `    Thread post: sending ${chunks.length} chunk(s), total ${fullText.length} chars`,
    )

    for (const [i, chunk] of chunks.entries()) {
      await thread.send(chunk)
      console.log(`    Thread post: chunk ${i + 1}/${chunks.length} sent (${chunk.length} chars)`)
    }

    // Save the thread ID on the record
    record.instructionThreadId = thread.id
    await updateState((s) => setTriageRecord(s, triageKey, record))
    return true
  } catch (err: any) {
    console.error(`  Thread post FAILED for ${triageKey}: ${err.message ?? err}`)
    if (err.code) console.error(`    Discord API error code: ${err.code}`)
    if (err.stack) console.error(`    Stack: ${err.stack}`)
    return false
  }
}

/**
 * Post investigation artifacts (-analysis.md, -findings.md) to a thread on the triage message.
 * This shows the bot's reasoning/research, not the user-facing response.
 */
async function postInvestigationToThread(
  triageChannel: TextChannel,
  record: TriageRecord,
  triageKey: string,
): Promise<boolean> {
  if (!record.responseFile) {
    console.warn(`  Investigation thread: no responseFile for ${triageKey}`)
    return false
  }

  // Derive investigation file paths from the response file path
  // e.g. triage-...-reinv2.md -> triage-...-reinv2-analysis.md, triage-...-reinv2-findings.md
  const basePath = record.responseFile.replace(/\.md$/, '')
  const analysisSuffix = `${basePath}-analysis.md`
  const findingsSuffix = `${basePath}-findings.md`

  const sections: { label: string; content: string }[] = []

  for (const { label, relPath } of [
    { label: 'Analysis', relPath: analysisSuffix },
    { label: 'Findings', relPath: findingsSuffix },
  ]) {
    const filePath = relPath.startsWith('data/') ? join(REPO_ROOT, relPath) : relPath
    try {
      const raw = await readFile(filePath, 'utf-8')
      const text = raw.trim()
      if (text) sections.push({ label, content: text })
    } catch {
      // File doesn't exist — skip
    }
  }

  if (sections.length === 0) {
    // Fall back to posting the response file itself if no investigation artifacts exist
    console.log(`  Investigation thread: no artifacts found, falling back to response file`)
    return postFullResponseToThread(triageChannel, record, triageKey)
  }

  try {
    const triageMsg = await triageChannel.messages.fetch(record.triageMessageId)

    let thread: ThreadChannel
    if (triageMsg.thread) {
      thread = triageMsg.thread
      if (thread.archived) {
        await thread.setArchived(false)
      }
    } else {
      thread = await triageMsg.startThread({
        name: `Investigation: ${(record.sourceTitle ?? 'Help request').substring(0, 84)}`,
        autoArchiveDuration: 1440,
      })
    }

    for (const section of sections) {
      const header = `**${section.label}:**\n\n`
      const chunks = splitForDiscord(header + section.content)
      for (const chunk of chunks) {
        await thread.send(chunk)
      }
    }

    record.instructionThreadId = thread.id
    await updateState((s) => setTriageRecord(s, triageKey, record))
    console.log(`  Investigation thread: posted ${sections.length} artifact(s) for ${triageKey}`)
    return true
  } catch (err: any) {
    console.error(`  Investigation thread FAILED for ${triageKey}: ${err.message ?? err}`)
    if (err.code) console.error(`    Discord API error code: ${err.code}`)
    return false
  }
}

async function postErrorToThread(
  triageChannel: TextChannel,
  record: TriageRecord,
  triageKey: string,
  errorMsg: string,
): Promise<void> {
  try {
    const triageMsg = await triageChannel.messages.fetch(record.triageMessageId)
    let thread: ThreadChannel
    if (triageMsg.thread) {
      thread = triageMsg.thread
      if (thread.archived) await thread.setArchived(false)
    } else {
      thread = await triageMsg.startThread({
        name: `Investigation: ${(record.sourceTitle ?? 'Help request').substring(0, 84)}`,
        autoArchiveDuration: 1440,
      })
    }
    await thread.send(`**Investigation failed**\n\n${errorMsg}`)
  } catch (err: any) {
    console.warn(`  Could not post error to thread for ${triageKey}: ${err.message ?? err}`)
  }
}

function splitForDiscord(content: string): string[] {
  const chunks: string[] = []
  let remaining = content.trim()
  while (remaining.length > 0) {
    if (remaining.length <= MAX_DISCORD_LENGTH) {
      chunks.push(remaining)
      break
    }
    let splitAt = remaining.lastIndexOf('\n', MAX_DISCORD_LENGTH)
    if (splitAt < 0 || splitAt < MAX_DISCORD_LENGTH / 2) {
      splitAt = MAX_DISCORD_LENGTH
    }
    chunks.push(remaining.slice(0, splitAt).trim())
    remaining = remaining.slice(splitAt).trimStart()
  }
  return chunks
}

function buildEmbedOptions(record: TriageRecord, responsePreview?: string): TriageEmbedOptions {
  const isDiscord = record.sourceType === 'discord'
  const [guildName, channelName] = (record.sourceDiscordPath ?? '/').split('/')

  return {
    sourceType: isDiscord ? 'd' : 'g',
    title: record.sourceTitle ?? 'Help request',
    content: record.sourceContent ?? '',
    author: record.sourceAuthor ?? 'unknown',
    guildName: isDiscord ? guildName : undefined,
    guildId: record.sourceGuildId,
    channelName: isDiscord ? channelName : undefined,
    channelId: record.sourceChannelId,
    messageId: record.sourceMessageId,
    repo: record.sourceRepo,
    issueNumber: record.sourceIssueNumber,
    labels: record.sourceLabels,
    status: record.status,
    investigatedBy: record.investigatedBy,
    responsePreview,
    reinvestigationCount: record.reinvestigationCount,
    filedBugUrl: record.filedBugUrl,
  }
}

function extractSourceInfo(triageKey: string): ['d' | 'g', string] {
  // triageKey format: triage:{d|g}:{compactId}
  const parts = triageKey.split(':')
  // triage:d:gci-dev:help:1234567890 → sourceType='d', compactId='gci-dev:help:1234567890'
  const sourceType = parts[1] as 'd' | 'g'
  const compactId = parts.slice(2).join(':')
  return [sourceType, compactId]
}

function buildInvestigationOptions(
  record: TriageRecord,
  client: Client,
  context: TriageHandlerContext,
  previousResponse?: string,
  maintainerInstructions?: string,
): TriageInvestigationOptions {
  let guildConfig: GuildConfig | undefined
  let channelConfig: ChannelConfig | undefined

  if (record.sourceType === 'discord' && record.sourceDiscordPath) {
    const [guildName, channelName] = record.sourceDiscordPath.split('/')
    const resolved = context.resolveGuildChannel(guildName, channelName)
    if (resolved) {
      guildConfig = resolved.guildConfig
      channelConfig = resolved.channelConfig
    }
  }

  return {
    client,
    config: context.config,
    model: context.model,
    repoDir: context.repoDir,
    docsDir: context.docsDir,
    guildConfig,
    channelConfig,
    previousResponse,
    maintainerInstructions,
  }
}
