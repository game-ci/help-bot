import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import type { Client, TextChannel, Message } from 'discord.js'
import { parseFrontMatter } from '../utils/frontmatter'
import { REPO_ROOT } from '../utils/paths'
import { updateState, setPostedDiscordResponse, setPostedResponse } from '../state'
import type { TriageRecord } from './types'

const MAX_DISCORD_LENGTH = 2000
const FEEDBACK_PROMPT = '\n\n-# Was this helpful? React :thumbsup: or :thumbsdown: | React :repeat: to request a re-investigation'

/**
 * Post the triage-approved response to the original source.
 */
export async function sendTriageResponse(
  record: TriageRecord,
  client: Client,
): Promise<boolean> {
  if (!record.responseFile) {
    console.warn('  No response file in triage record')
    return false
  }

  // Read the response file (could be relative or absolute)
  const filePath = record.responseFile.startsWith('data/')
    ? join(REPO_ROOT, record.responseFile)
    : record.responseFile
  let content: string
  try {
    content = await readFile(filePath, 'utf-8')
  } catch (err: any) {
    console.warn(`  Could not read response file ${filePath}: ${err.message ?? err}`)
    return false
  }

  const { body } = parseFrontMatter(content)
  const cleaned = body
    .replace(/-#\s*Was this helpful\?[^\n]*/gi, '')
    .replace(/Was this helpful\?\s*React with[^\n]*/gi, '')
    .trim()

  if (!cleaned) {
    console.warn('  Response content is empty')
    return false
  }

  if (record.sourceType === 'discord') {
    return sendDiscordResponse(record, client, cleaned)
  } else {
    return sendGithubResponse(record, cleaned)
  }
}

/**
 * Post a response as a Discord reply to the original message.
 */
async function sendDiscordResponse(
  record: TriageRecord,
  client: Client,
  content: string,
): Promise<boolean> {
  if (!record.sourceMessageId || !record.sourceDiscordPath) {
    console.warn('  Missing Discord source info in triage record')
    return false
  }

  const [guildName, channelName] = record.sourceDiscordPath.split('/')
  if (!guildName || !channelName) {
    console.warn('  Invalid sourceDiscordPath format')
    return false
  }

  // Find the guild and channel
  const guild = client.guilds.cache.find((g) => {
    // Match by name -- guild mappings use config names
    return true // We'll iterate and find the channel
  })

  // Search all guilds for the channel containing the original message
  let originalMessage: Message | undefined
  for (const [, g] of client.guilds.cache) {
    for (const [, ch] of g.channels.cache) {
      if (!ch.isTextBased()) continue
      if (!('name' in ch) || ch.name !== channelName) continue
      try {
        originalMessage = await (ch as TextChannel).messages.fetch(record.sourceMessageId)
        if (originalMessage) break
      } catch {
        continue
      }
    }
    if (originalMessage) break
  }

  if (!originalMessage) {
    console.warn(`  Could not find original message ${record.sourceMessageId} in #${channelName}`)
    return false
  }

  try {
    const bodyWithFeedback = content + FEEDBACK_PROMPT
    const chunks = splitContent(bodyWithFeedback)

    for (const [index, chunk] of chunks.entries()) {
      const chunkContent = chunks.length > 1
        ? `(part ${index + 1}/${chunks.length})\n${chunk}`
        : chunk

      await originalMessage.reply({
        content: chunkContent,
        allowedMentions: { repliedUser: true },
      })

      if (index < chunks.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }

    // Record in state
    await updateState((s) => {
      setPostedDiscordResponse(s, guildName, channelName, record.sourceMessageId!)
    })

    console.log(`  Response posted to #${channelName} (reply to original message)`)
    return true
  } catch (err: any) {
    console.warn(`  Failed to post Discord response: ${err.message ?? err}`)
    return false
  }
}

/**
 * Post a response as a GitHub issue/PR comment.
 */
async function sendGithubResponse(
  record: TriageRecord,
  content: string,
): Promise<boolean> {
  if (!record.sourceRepo || !record.sourceIssueNumber) {
    console.warn('  Missing GitHub source info in triage record')
    return false
  }

  const bodyWithFeedback = content + '\n\n---\nWas this helpful? React with :+1: or :-1: to help improve future responses.'

  const command = record.sourceType === 'github_pr' ? 'pr' : 'issue'

  try {
    const proc = spawn('gh', [command, 'comment', String(record.sourceIssueNumber),
      '--repo', record.sourceRepo, '--body', bodyWithFeedback], {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'inherit', 'inherit'],
    })
    await once(proc, 'exit')

    // Record in state
    await updateState((s) => {
      setPostedResponse(s, record.sourceRepo!, record.sourceIssueNumber!)
    })

    console.log(`  Response posted to ${record.sourceRepo}#${record.sourceIssueNumber}`)
    return true
  } catch (err: any) {
    console.warn(`  Failed to post GitHub response: ${err.message ?? err}`)
    return false
  }
}

/**
 * Split long content into Discord-safe chunks.
 */
function splitContent(content: string): string[] {
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
