import type { Interaction, Client, TextChannel, ThreadChannel, Message } from 'discord.js'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseSocialButtonId, buildContentId } from './types'
import type { ContentRecord, ContentStatus } from './types'
import { updateContentNotification, postContentNotification, type ContentEmbedOptions } from './notification'
import { runContentDraft, readDraftBody } from './drafting'
import { commitAndPushContent } from './commit'
import { loadState, updateState } from '../state'
import { getContentRecord, setContentRecord } from '../state'
import { REPO_ROOT } from '../utils/paths'
import { parseFrontMatter } from '../utils/frontmatter'

export interface SocialHandlerContext {
  config: Record<string, unknown>
  model: string
  collaborators: string[]
  triageUserIds: string[]
}

const MAX_DISCORD_LENGTH = 2000

/**
 * Handle a social content request triggered by "@bot social <topic>".
 * Posts a notification to the triage channel and saves a ContentRecord.
 */
export async function handleSocialRequest(
  message: Message,
  topic: string,
  triageChannel: TextChannel,
  context: SocialHandlerContext,
): Promise<void> {
  const authorTag = message.author.tag ?? message.author.username
  const userId = message.author.id

  // Permission check
  const isCollaborator = context.collaborators.some((c) => c.toLowerCase() === authorTag.toLowerCase())
  const isTriageUser = context.triageUserIds.includes(userId)
  if (!isCollaborator && !isTriageUser) {
    await message.reply({ content: 'Only maintainers can create social content.', allowedMentions: { repliedUser: false } }).catch(() => {})
    return
  }

  const contentId = buildContentId(userId)
  const contentKey = `content:linkedin:${contentId}`
  const platform = 'linkedin'

  const embedOptions: ContentEmbedOptions = {
    platform: 'LinkedIn',
    topic,
    requestedBy: authorTag,
    status: 'topic_received',
  }

  const notificationMsg = await postContentNotification(triageChannel, embedOptions, contentId)

  const record: ContentRecord = {
    contentKey,
    notificationMessageId: notificationMsg.id,
    notificationChannelId: triageChannel.id,
    platform,
    topic,
    requestedBy: authorTag,
    requestedByUserId: userId,
    sourceGuildId: message.guild!.id,
    sourceChannelId: message.channelId,
    sourceMessageId: message.id,
    status: 'topic_received',
    revisionCount: 0,
    createdAt: new Date().toISOString(),
  }

  await updateState((s) => setContentRecord(s, contentKey, record))

  await message.reply({
    content: `Social content request received. Check the triage channel for drafting controls.`,
    allowedMentions: { repliedUser: false },
  }).catch(() => {})

  console.log(`  Social: content request from ${authorTag} — topic: ${topic.substring(0, 80)}`)
}

/**
 * Main InteractionCreate handler for social content buttons.
 */
export async function handleSocialInteraction(
  interaction: Interaction,
  client: Client,
  context: SocialHandlerContext,
): Promise<void> {
  if (!interaction.isButton()) return

  const parsed = parseSocialButtonId(interaction.customId)
  if (!parsed) return

  const { action, contentId } = parsed

  // Find the content record by contentId suffix
  const state = await loadState()
  const allRecords = getContentRecords(state)
  const entry = Object.entries(allRecords).find(([key]) => key.endsWith(contentId))
  if (!entry) {
    await interaction.reply({ content: 'This content request is no longer active.', ephemeral: true })
    return
  }

  const [contentKey, record] = entry

  // Permission check
  const userId = interaction.user.id
  const username = interaction.user.tag ?? interaction.user.username
  const isCollaborator = context.collaborators.some((c) => c.toLowerCase() === username.toLowerCase())
  const isTriageUser = context.triageUserIds.includes(userId)
  if (!isCollaborator && !isTriageUser) {
    await interaction.reply({ content: 'Only maintainers can use social content controls.', ephemeral: true })
    return
  }

  await interaction.deferUpdate()

  const channel = interaction.channel as TextChannel

  switch (action) {
    case 'draft':
      await handleDraft(record, contentKey, contentId, channel, context)
      break
    case 'revise':
      await handleRevise(record, contentKey, contentId, channel, client, context)
      break
    case 'approve':
      await handleApprove(record, contentKey, contentId, channel, username)
      break
    case 'commit':
      await handleCommit(record, contentKey, contentId, channel)
      break
    case 'view':
      await handleView(record, contentKey, channel)
      break
    case 'discard':
      await handleDiscard(record, contentKey, contentId, channel, username)
      break
  }
}

// --- Action handlers ---

async function handleDraft(
  record: ContentRecord,
  contentKey: string,
  contentId: string,
  channel: TextChannel,
  context: SocialHandlerContext,
): Promise<void> {
  if (record.status !== 'topic_received') return

  console.log(`  Social: drafting content for ${contentKey}`)

  record.status = 'drafting'
  record.draftStartedAt = new Date().toISOString()
  await updateState((s) => setContentRecord(s, contentKey, record))
  await updateContentNotification(channel, record.notificationMessageId, buildEmbedOpts(record), contentId)

  const result = await runContentDraft(record, {
    config: context.config,
    model: context.model,
  })

  if (result) {
    record.status = 'draft_ready'
    record.draftFile = result.draftFile
    record.draftCompletedAt = new Date().toISOString()
    await updateState((s) => setContentRecord(s, contentKey, record))
    await updateContentNotification(channel, record.notificationMessageId, buildEmbedOpts(record, result.draftPreview), contentId)
    await postDraftToThread(channel, record, contentKey)
    console.log(`  Social: draft ready for ${contentKey}`)
  } else {
    record.status = 'topic_received'
    record.draftStartedAt = undefined
    await updateState((s) => setContentRecord(s, contentKey, record))
    await updateContentNotification(channel, record.notificationMessageId, buildEmbedOpts(record), contentId)
    console.warn(`  Social: draft failed for ${contentKey}`)
  }
}

async function handleRevise(
  record: ContentRecord,
  contentKey: string,
  contentId: string,
  channel: TextChannel,
  client: Client,
  context: SocialHandlerContext,
): Promise<void> {
  if (record.status !== 'draft_ready' && record.status !== 'approved') return

  console.log(`  Social: revising content for ${contentKey}`)

  // Fetch feedback from thread
  let feedback: string | undefined
  if (record.draftThreadId) {
    feedback = await fetchThreadFeedback(client, record.draftThreadId)
  }

  // Read previous draft
  const previousDraft = record.draftFile ? await readDraftBody(record.draftFile) : undefined

  record.status = 'revising'
  record.revisionCount++
  record.draftStartedAt = new Date().toISOString()
  await updateState((s) => setContentRecord(s, contentKey, record))
  await updateContentNotification(channel, record.notificationMessageId, buildEmbedOpts(record), contentId)

  const result = await runContentDraft(record, {
    config: context.config,
    model: context.model,
    previousDraft,
    feedback,
  })

  if (result) {
    record.status = 'draft_ready'
    record.draftFile = result.draftFile
    record.draftCompletedAt = new Date().toISOString()
    await updateState((s) => setContentRecord(s, contentKey, record))
    await updateContentNotification(channel, record.notificationMessageId, buildEmbedOpts(record, result.draftPreview), contentId)
    await postDraftToThread(channel, record, contentKey)
    console.log(`  Social: revision complete for ${contentKey}`)
  } else {
    record.status = 'draft_ready'
    record.revisionCount--
    await updateState((s) => setContentRecord(s, contentKey, record))
    await updateContentNotification(channel, record.notificationMessageId, buildEmbedOpts(record), contentId)
    console.warn(`  Social: revision failed for ${contentKey}`)
  }
}

async function handleApprove(
  record: ContentRecord,
  contentKey: string,
  contentId: string,
  channel: TextChannel,
  username: string,
): Promise<void> {
  if (record.status !== 'draft_ready') return

  record.status = 'approved'
  record.approvedBy = username
  record.approvedAt = new Date().toISOString()
  await updateState((s) => setContentRecord(s, contentKey, record))
  await updateContentNotification(channel, record.notificationMessageId, buildEmbedOpts(record), contentId)
  console.log(`  Social: approved by ${username} for ${contentKey}`)
}

async function handleCommit(
  record: ContentRecord,
  contentKey: string,
  contentId: string,
  channel: TextChannel,
): Promise<void> {
  if (record.status !== 'approved' || !record.draftFile) return

  console.log(`  Social: committing content for ${contentKey}`)

  try {
    const { committedFile, commitSha } = await commitAndPushContent(
      record.draftFile,
      record.platform,
      record.topic,
    )

    record.status = 'committed'
    record.committedFile = committedFile
    record.commitSha = commitSha
    record.committedAt = new Date().toISOString()
    await updateState((s) => setContentRecord(s, contentKey, record))
    await updateContentNotification(channel, record.notificationMessageId, buildEmbedOpts(record), contentId)

    // Post commit info to thread
    if (record.draftThreadId) {
      try {
        const thread = await channel.client.channels.fetch(record.draftThreadId) as ThreadChannel
        if (thread?.isThread()) {
          if (thread.archived) await thread.setArchived(false)
          await thread.send(`Committed and pushed: \`${commitSha}\` — \`${committedFile}\``)
        }
      } catch { /* thread post is best-effort */ }
    }

    console.log(`  Social: committed ${commitSha} — ${committedFile}`)
  } catch (err: any) {
    console.error(`  Social: commit failed for ${contentKey}: ${err.message ?? err}`)
    // Post error to thread
    if (record.draftThreadId) {
      try {
        const thread = await channel.client.channels.fetch(record.draftThreadId) as ThreadChannel
        if (thread?.isThread()) {
          await thread.send(`Commit failed: ${err.message ?? err}`)
        }
      } catch { /* best-effort */ }
    }
  }
}

async function handleView(
  record: ContentRecord,
  contentKey: string,
  channel: TextChannel,
): Promise<void> {
  if (!record.draftFile) return
  await postDraftToThread(channel, record, contentKey)
}

async function handleDiscard(
  record: ContentRecord,
  contentKey: string,
  contentId: string,
  channel: TextChannel,
  username: string,
): Promise<void> {
  record.status = 'discarded'
  await updateState((s) => setContentRecord(s, contentKey, record))
  await updateContentNotification(channel, record.notificationMessageId, buildEmbedOpts(record), contentId)
  console.log(`  Social: discarded by ${username} for ${contentKey}`)
}

// --- Helpers ---

async function postDraftToThread(
  channel: TextChannel,
  record: ContentRecord,
  contentKey: string,
): Promise<void> {
  if (!record.draftFile) return

  const filePath = record.draftFile.startsWith('data/')
    ? join(REPO_ROOT, record.draftFile)
    : record.draftFile

  let body: string
  try {
    const content = await readFile(filePath, 'utf-8')
    const parsed = parseFrontMatter(content)
    body = parsed.body.trim()
  } catch {
    return
  }

  if (!body) return

  try {
    const msg = await channel.messages.fetch(record.notificationMessageId)

    let thread: ThreadChannel
    if (msg.thread) {
      thread = msg.thread
      if (thread.archived) await thread.setArchived(false)
    } else {
      thread = await msg.startThread({
        name: `Content: ${record.topic.substring(0, 88)}`,
        autoArchiveDuration: 1440,
      })
    }

    const header = record.revisionCount > 0
      ? `**Revision #${record.revisionCount}:**\n\n`
      : `**Draft:**\n\n`

    const chunks = splitForDiscord(header + body)
    for (const chunk of chunks) {
      await thread.send(chunk)
    }

    record.draftThreadId = thread.id
    await updateState((s) => setContentRecord(s, contentKey, record))
  } catch (err: any) {
    console.warn(`  Social thread post failed for ${contentKey}: ${err.message ?? err}`)
  }
}

async function fetchThreadFeedback(client: Client, threadId: string): Promise<string | undefined> {
  try {
    const thread = await client.channels.fetch(threadId)
    if (!thread || !thread.isThread()) return undefined

    const messages = await thread.messages.fetch({ limit: 50 })
    const humanMessages = [...messages.values()]
      .filter((m) => !m.author.bot)
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)

    if (humanMessages.length === 0) return undefined

    const lines: string[] = []
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

function buildEmbedOpts(record: ContentRecord, draftPreview?: string): ContentEmbedOptions {
  return {
    platform: 'LinkedIn',
    topic: record.topic,
    requestedBy: record.requestedBy,
    status: record.status,
    draftPreview,
    revisionCount: record.revisionCount,
    approvedBy: record.approvedBy,
    committedFile: record.committedFile,
    commitSha: record.commitSha,
  }
}

function getContentRecords(state: any): Record<string, ContentRecord> {
  return state.meta?.contentRecords ?? {}
}
