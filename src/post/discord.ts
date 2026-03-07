import { request } from 'undici'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { parseFrontMatter } from '../utils/frontmatter'
import { RESPONSES_DIR } from '../utils/paths'
import { getConfig, getValue, resolveGuilds, resolveWebhookUrl, GuildConfig, ChannelConfig } from '../config'
import { recordStat } from '../metrics'
import { updateState, setPostedDiscordResponse } from '../state'

const DISCORD_API = 'https://discord.com/api/v10'
const MAX_LENGTH = 2000

const FEEDBACK_PROMPT = '\n\n-# Was this helpful? React with :thumbsup: or :thumbsdown: to help improve future responses.'

function splitContent(content: string): string[] {
  const chunks: string[] = []
  let remaining = content.trim()
  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining)
      break
    }
    let splitAt = remaining.lastIndexOf('\n', MAX_LENGTH)
    if (splitAt < 0 || splitAt < MAX_LENGTH / 2) {
      splitAt = MAX_LENGTH
    }
    chunks.push(remaining.slice(0, splitAt).trim())
    remaining = remaining.slice(splitAt).trimStart()
  }
  return chunks
}

// --- Webhook posting (legacy) ---

async function postToWebhook(webhook: string, payload: Record<string, unknown>): Promise<boolean> {
  const response = await request(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return response.statusCode === 204 || response.statusCode === 200
}

async function sendSeenYouNotification(webhook: string, message: string): Promise<void> {
  await postToWebhook(webhook, { content: message })
}

// --- Bot API posting (new) ---

interface BotApiPostResult {
  success: boolean
  messageId?: string
}

/**
 * Post a message to a Discord channel via Bot API.
 * Supports message_reference for chain-replying.
 */
async function postViaBotApi(
  channelId: string,
  content: string,
  token: string,
  options?: {
    replyToMessageId?: string
    threadId?: string
  },
): Promise<BotApiPostResult> {
  try {
    const body: Record<string, unknown> = { content }

    // If replying to a specific message, add message_reference
    if (options?.replyToMessageId) {
      body.message_reference = {
        message_id: options.replyToMessageId,
      }
      // Allow the reply even if the referenced message is deleted
      body.allowed_mentions = {
        replied_user: true,
      }
    }

    const targetChannelId = options?.threadId ?? channelId

    const response = await request(`${DISCORD_API}/channels/${targetChannelId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (response.statusCode === 200) {
      const data = await response.body.json() as { id: string }
      return { success: true, messageId: data.id }
    }

    const errorText = await response.body.text()
    console.warn(`  Bot API returned ${response.statusCode}: ${errorText.substring(0, 200)}`)
    return { success: false }
  } catch (error: any) {
    console.warn(`  Bot API post failed: ${error.message ?? error}`)
    return { success: false }
  }
}

/**
 * Create a new thread in a channel and post the first message.
 */
async function createThreadWithMessage(
  channelId: string,
  threadName: string,
  content: string,
  token: string,
): Promise<BotApiPostResult & { threadId?: string }> {
  try {
    // Create the thread via the threads endpoint
    const response = await request(`${DISCORD_API}/channels/${channelId}/threads`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: threadName.substring(0, 100),
        type: 11, // PUBLIC_THREAD
        auto_archive_duration: 1440, // 24 hours
      }),
    })

    if (response.statusCode !== 201) {
      const errorText = await response.body.text()
      console.warn(`  Failed to create thread: ${response.statusCode}: ${errorText.substring(0, 200)}`)
      return { success: false }
    }

    const thread = await response.body.json() as { id: string }

    // Post the message in the thread
    const msgResult = await postViaBotApi(thread.id, content, token)
    return { ...msgResult, threadId: thread.id }
  } catch (error: any) {
    console.warn(`  Thread creation failed: ${error.message ?? error}`)
    return { success: false }
  }
}

// --- Main posting logic ---

export interface PostDiscordOptions {
  dryRun: boolean
  allowOfficial?: boolean
  forceReplyId?: string
  seenYouMessage?: string
  seenYouEmoji?: string
}

/**
 * Post Discord responses, supporting both webhook (legacy) and Bot API (new) modes.
 * Bot API supports direct channel replies, thread replies, and chain-replying.
 */
export async function postDiscordResponses(options: PostDiscordOptions): Promise<void> {
  const config = await getConfig()
  const discordConfig = getValue(config, ['discord'], {} as Record<string, unknown>)
  const guilds = resolveGuilds(discordConfig)
  const token = process.env.DISCORD_BOT_TOKEN

  if (guilds.length === 0) {
    console.warn('No Discord guilds configured. Skipping Discord posting.')
    return
  }

  // Build lookups
  const guildWebhooks = new Map<string, string>()
  const channelConfigs = new Map<string, ChannelConfig>()
  for (const guild of guilds) {
    const webhookUrl = resolveWebhookUrl(guild)
    if (webhookUrl) {
      guildWebhooks.set(guild.name, webhookUrl)
    }
    for (const ch of guild.channels) {
      channelConfigs.set(`${guild.name}/${ch.name}`, ch)
    }
  }

  const globalWebhook = process.env.DISCORD_WEBHOOK_URL

  const discordDir = join(RESPONSES_DIR, 'discord')
  let files: string[] = []
  try {
    files = await readdir(discordDir)
  } catch {
    return
  }

  for (const file of files.filter((f) => f.endsWith('.md'))) {
    const fullPath = join(discordDir, file)
    const content = await readFile(fullPath, 'utf-8')
    const { meta, body } = parseFrontMatter(content)
    const responseId = meta.response_id ?? file.replace(/\.md$/, '')
    const isOfficial = String(meta.official_response)?.toLowerCase() === 'true'

    const responseGuild = meta.guild_name ?? ''
    const responseChannel = meta.channel_name ?? ''
    const replyToMessageId = meta.reply_to_message_id ?? ''
    const threadId = meta.thread_id ?? ''

    // Determine reply mode
    const channelKey = `${responseGuild}/${responseChannel}`
    const channelConfig = channelConfigs.get(channelKey)
    const replyMode = channelConfig?.reply_mode ?? 'bot_api'

    // Check official skip
    if (isOfficial && !options.allowOfficial && options.forceReplyId !== responseId) {
      console.log(`Skipping Discord response ${responseId} because an official contributor already replied.`)
      recordStat('discordResponsesSkipped', 1)
      const webhook = guildWebhooks.get(responseGuild) ?? globalWebhook
      if (!options.dryRun && options.seenYouMessage && webhook) {
        const emojiPrefix = options.seenYouEmoji ? `${options.seenYouEmoji} ` : ''
        await sendSeenYouNotification(webhook, `${emojiPrefix}${options.seenYouMessage}`)
      }
      continue
    }

    if (options.dryRun) {
      console.log(`DRY RUN: would post Discord response from ${file} (mode: ${replyMode})`)
      continue
    }

    // Strip any LLM-generated feedback prompt to avoid duplicates
    const trimmed = body
      .replace(/-#\s*Was this helpful\?[^\n]*/gi, '')
      .replace(/Was this helpful\?\s*React with[^\n]*/gi, '')
      .trim()
    if (!trimmed) {
      continue
    }

    // Append feedback prompt
    const bodyWithFeedback = trimmed + FEEDBACK_PROMPT

    if (replyMode === 'bot_api' && token) {
      // Post via Bot API with reply chain support
      const channelId = meta.channel_id ?? ''
      if (!channelId) {
        console.warn(`Skipping ${responseId}: no channel_id in response metadata`)
        continue
      }

      const chunks = splitContent(bodyWithFeedback)
      let lastMessageId: string | undefined
      let firstReplyTo = replyToMessageId || undefined

      for (const [index, chunk] of chunks.entries()) {
        const chunkContent = chunks.length > 1
          ? `(part ${index + 1}/${chunks.length})\n${chunk}`
          : chunk

        const result = await postViaBotApi(channelId, chunkContent, token, {
          replyToMessageId: index === 0 ? firstReplyTo : lastMessageId,
          threadId: threadId || undefined,
        })

        if (result.success) {
          lastMessageId = result.messageId
          recordStat('discordBotRepliesPosted', 1)
        } else {
          console.warn(`Failed to post Bot API chunk ${index + 1}/${chunks.length} for ${file}`)
        }

        await new Promise((resolve) => setTimeout(resolve, 1000))
      }

      recordStat('discordResponsesPosted', 1)

      // Track the response
      if (responseGuild && responseChannel && replyToMessageId) {
        await updateState((s) => {
          setPostedDiscordResponse(s, responseGuild, responseChannel, replyToMessageId)
        })
      }

      console.log(`Posted Discord response for ${responseId} via Bot API${replyToMessageId ? ` (reply to ${replyToMessageId})` : ''}`)
    } else if (replyMode === 'thread' && token) {
      // Create or reply in a thread
      const channelId = meta.channel_id ?? ''
      if (!channelId) {
        console.warn(`Skipping ${responseId}: no channel_id for thread mode`)
        continue
      }

      const threadName = `Help: ${meta.title?.substring(0, 80) ?? responseId}`
      const result = await createThreadWithMessage(channelId, threadName, bodyWithFeedback, token)

      if (result.success) {
        recordStat('discordBotRepliesPosted', 1)
        recordStat('discordResponsesPosted', 1)
        console.log(`Posted Discord response for ${responseId} in new thread${result.threadId ? ` (thread ${result.threadId})` : ''}`)
      } else {
        console.warn(`Failed to create thread for ${responseId}`)
      }

      if (responseGuild && responseChannel && replyToMessageId) {
        await updateState((s) => {
          setPostedDiscordResponse(s, responseGuild, responseChannel, replyToMessageId)
        })
      }
    } else {
      // Fallback: webhook posting (legacy)
      const webhook = guildWebhooks.get(responseGuild) ?? globalWebhook
      if (!webhook) {
        console.warn(
          `Skipping Discord response ${responseId}: no webhook URL found for guild "${responseGuild}". ` +
            'Set the appropriate env var or DISCORD_WEBHOOK_URL.',
        )
        continue
      }

      const chunks = splitContent(bodyWithFeedback)
      for (const [index, chunk] of chunks.entries()) {
        const payload: Record<string, unknown> = {
          content: chunk,
          username: 'GameCI Help Bot',
        }
        if (chunks.length > 1) {
          payload.content = `(part ${index + 1}/${chunks.length})\n${chunk}`
        }
        const success = await postToWebhook(webhook, payload)
        if (!success) {
          console.warn(`Failed to post Discord chunk ${index + 1}/${chunks.length} for ${file}`)
        }
        recordStat('discordResponsesPosted', 1)
        await new Promise((resolve) => setTimeout(resolve, 1500))
      }
    }
  }
}
