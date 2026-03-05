import { request } from 'undici'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { parseFrontMatter } from '../utils/frontmatter'
import { RESPONSES_DIR } from '../utils/paths'
import { getConfig, getValue, resolveGuilds, GuildConfig } from '../config'
import { recordStat } from '../metrics'

const MAX_LENGTH = 2000

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

export interface PostDiscordOptions {
  dryRun: boolean
  allowOfficial?: boolean
  forceReplyId?: string
  seenYouMessage?: string
  seenYouEmoji?: string
}

/**
 * Post Discord responses, iterating over configured guilds to resolve
 * per-guild webhook URLs.
 */
export async function postDiscordResponses(options: PostDiscordOptions): Promise<void> {
  const config = await getConfig()
  const discordConfig = getValue(config, ['discord'], {} as Record<string, unknown>)
  const guilds = resolveGuilds(discordConfig)

  if (guilds.length === 0) {
    console.warn('No Discord guilds configured. Skipping Discord posting.')
    return
  }

  // Build a lookup from guild name to webhook URL
  const guildWebhooks = new Map<string, string>()
  for (const guild of guilds) {
    const webhookUrl = process.env[guild.webhook_url_env]
    if (webhookUrl) {
      guildWebhooks.set(guild.name, webhookUrl)
    }
  }

  // Fallback: global DISCORD_WEBHOOK_URL for any guild without a specific one
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

    // Determine the webhook for this response
    const responseGuild = meta.guild_name ?? ''
    const webhook = guildWebhooks.get(responseGuild) ?? globalWebhook
    if (!webhook) {
      console.warn(
        `Skipping Discord response ${responseId}: no webhook URL found for guild "${responseGuild}". ` +
          'Set the appropriate env var or DISCORD_WEBHOOK_URL.',
      )
      continue
    }

    if (isOfficial && !options.allowOfficial && options.forceReplyId !== responseId) {
      console.log(`Skipping Discord response ${responseId} because an official contributor already replied.`)
      recordStat('discordResponsesSkipped', 1)
      if (!options.dryRun && options.seenYouMessage) {
        const emojiPrefix = options.seenYouEmoji ? `${options.seenYouEmoji} ` : ''
        await sendSeenYouNotification(webhook, `${emojiPrefix}${options.seenYouMessage}`)
      }
      continue
    }

    if (options.dryRun) {
      console.log(`DRY RUN: would post Discord response from ${file}`)
      continue
    }

    const trimmed = body.trim()
    if (!trimmed) {
      continue
    }
    const chunks = splitContent(trimmed)
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
