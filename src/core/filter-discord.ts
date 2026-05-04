import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { guildChannelDir, guildForumDir } from '../utils/paths'
import { getConfig, getValue, resolveGuilds, GuildConfig, ChannelConfig } from '../config'
import { loadState } from '../state'

export interface DiscordMessageMeta {
  guildName: string
  channelName: string
  channelId: string
  messageId: string
  threadId?: string
  threadName?: string
  isThread: boolean
  isForumPost: boolean
}

export interface EligibleDiscordMessage {
  /** Unique string ID (message snowflake) */
  messageId: string
  /** Display title — first line or truncated content */
  title: string
  author: string
  authorId: string
  content: string
  timestamp: string
  /** Reactions on the message */
  reactions: Record<string, number>
  /** Referenced message content (if this is a reply) */
  replyContext?: {
    author: string
    content: string
    messageId: string
  }
  /** Thread context for forum posts / threads */
  threadMessages?: Array<{
    author: string
    content: string
    messageId: string
    timestamp: string
  }>
  /** Channel system prompt (if configured) */
  channelSystemPrompt?: string
  /** Source metadata */
  discord: DiscordMessageMeta
}

export interface DiscordFilterResult {
  eligible: EligibleDiscordMessage[]
  skippedCount: number
  skipReasons: Record<string, number>
}

interface SyncedMessage {
  id: string
  author: string
  author_id: string
  content: string
  timestamp: string
  channel_id: string
  channel_name: string
  guild_name: string
  is_bot: boolean
  has_reply: boolean
  message_type: number
  is_official: boolean
  reactions?: Record<string, number>
  referenced_message?: {
    author: string
    content: string
    id: string
  }
  thread_id?: string
  thread_name?: string
  is_thread?: boolean
  is_forum_post?: boolean
  thread_messages?: Array<{
    author: string
    content: string
    id: string
    timestamp: string
  }>
}

/**
 * Filter synced Discord messages for eligible help requests.
 * Returns messages that are likely questions or help requests
 * and haven't been responded to yet.
 */
export async function filterDiscordMessages(guildConfig: GuildConfig): Promise<DiscordFilterResult> {
  const config = await getConfig()
  const officialRoles = (getValue(config, ['discord', 'official_roles'], []) as string[]).map(r => r.toLowerCase())
  const officialUsers = (getValue(config, ['discord', 'official_users'], []) as string[]).map(u => u.toLowerCase())
  const ignoreBots = Boolean(getValue(config, ['discord', 'ignore_bots'], true))
  const minLength = Number(getValue(config, ['discord', 'min_message_length'], 15))

  const state = await loadState()
  const postedDiscordResponses = (state.meta?.postedDiscordResponses as Record<string, string>) ?? {}

  const eligible: EligibleDiscordMessage[] = []
  const skipReasons: Record<string, number> = {}

  function skip(reason: string) {
    skipReasons[reason] = (skipReasons[reason] ?? 0) + 1
  }

  // Build channel config lookup
  const channelConfigs = new Map<string, ChannelConfig>()
  for (const ch of guildConfig.channels) {
    channelConfigs.set(ch.name, ch)
  }

  for (const channel of guildConfig.channels) {
    const dataDirs = [guildChannelDir(guildConfig.name, channel.name)]
    if (channel.channel_type === 'forum') {
      dataDirs.push(guildForumDir(guildConfig.name, channel.name))
    }

    for (const channelDir of dataDirs) {
      let files: string[] = []
      try {
        files = await readdir(channelDir)
      } catch {
        continue
      }

      // Only process recent JSONL files (last 7 days by default)
      const jsonlFiles = files.filter(f => f.endsWith('.jsonl')).sort().reverse().slice(0, 7)

      for (const file of jsonlFiles) {
        const fullPath = join(channelDir, file)
        let content: string
        try {
          content = await readFile(fullPath, 'utf-8')
        } catch {
          continue
        }

        const lines = content.split(/\r?\n/).filter(Boolean)
        for (const line of lines) {
          let msg: SyncedMessage
          try {
            msg = JSON.parse(line) as SyncedMessage
          } catch {
            continue
          }

          // SKIP: bot messages
          if (ignoreBots && msg.is_bot) {
            skip('bot')
            continue
          }

          // SKIP: too short
          if (msg.content.trim().length < minLength) {
            skip('too-short')
            continue
          }

          // SKIP: official user/role already present
          if (msg.is_official) {
            skip('official-author')
            continue
          }

          // SKIP: already responded to
          const responseKey = `discord:${guildConfig.name}/${channel.name}#${msg.id}`
          if (postedDiscordResponses[responseKey]) {
            skip('already-responded')
            continue
          }

          // SKIP: not a question or help request
          if (!isLikelyHelpRequest(msg.content)) {
            skip('not-help-request')
            continue
          }

          const title = msg.content.split('\n')[0].substring(0, 120) || msg.content.substring(0, 120)

          eligible.push({
            messageId: msg.id,
            title,
            author: msg.author,
            authorId: msg.author_id,
            content: msg.content,
            timestamp: msg.timestamp,
            reactions: msg.reactions ?? {},
            replyContext: msg.referenced_message ? {
              author: msg.referenced_message.author,
              content: msg.referenced_message.content,
              messageId: msg.referenced_message.id,
            } : undefined,
            threadMessages: msg.thread_messages?.map(tm => ({
              author: tm.author,
              content: tm.content,
              messageId: tm.id,
              timestamp: tm.timestamp,
            })),
            channelSystemPrompt: channel.system_prompt,
            discord: {
              guildName: guildConfig.name,
              channelName: channel.name,
              channelId: msg.channel_id,
              messageId: msg.id,
              threadId: msg.thread_id,
              threadName: msg.thread_name,
              isThread: msg.is_thread ?? false,
              isForumPost: msg.is_forum_post ?? false,
            },
          })
        }
      }
    }
  }

  return {
    eligible,
    skippedCount: Object.values(skipReasons).reduce((a, b) => a + b, 0),
    skipReasons,
  }
}

/**
 * Heuristic to determine if a message is likely a help request.
 * Looks for question marks, error-related keywords, help phrases.
 */
function isLikelyHelpRequest(content: string): boolean {
  const lower = content.toLowerCase()

  // Direct question markers
  if (content.includes('?')) return true

  // Help/error keywords
  const helpKeywords = [
    'help', 'error', 'issue', 'problem', 'fail', 'broken',
    'not working', 'doesn\'t work', 'can\'t', 'cannot', 'unable',
    'how do i', 'how to', 'any idea', 'anyone know',
    'getting an error', 'stuck', 'struggling', 'confused',
    'exception', 'crash', 'bug', 'unexpected', 'wrong',
    'please help', 'need help', 'having trouble',
    'does anyone', 'is there a way', 'is it possible',
    'what am i doing wrong', 'what\'s wrong',
  ]

  return helpKeywords.some(kw => lower.includes(kw))
}

/**
 * Write a filtered Discord message manifest for the LLM.
 */
export async function writeDiscordManifest(
  guildName: string,
  result: DiscordFilterResult,
  outputDir: string,
): Promise<string> {
  const { writeFile: writeFileAsync } = await import('node:fs/promises')
  const { ensureDir } = await import('../utils/fs.js')

  await ensureDir(outputDir)

  const lines: string[] = []
  lines.push(`# Eligible Discord Messages — ${guildName}`)
  lines.push('')
  lines.push(`Eligible: ${result.eligible.length}`)
  lines.push(`Skipped: ${result.skippedCount}`)
  lines.push('')

  if (Object.keys(result.skipReasons).length > 0) {
    lines.push('## Skip breakdown')
    for (const [reason, count] of Object.entries(result.skipReasons)) {
      lines.push(`- ${reason}: ${count}`)
    }
    lines.push('')
  }

  lines.push('## Messages to process')
  lines.push('')
  lines.push('Process ONLY the messages listed below. Do NOT respond to any other messages.')
  lines.push('')

  for (const msg of result.eligible) {
    const loc = msg.discord.isThread
      ? `${msg.discord.channelName}/${msg.discord.threadName ?? msg.discord.threadId}`
      : msg.discord.channelName
    lines.push(`### ${msg.discord.guildName}/${loc} — ${msg.author} (${msg.timestamp})`)
    lines.push(`Message ID: ${msg.messageId}`)
    if (msg.replyContext) {
      lines.push(`> Replying to @${msg.replyContext.author}: ${msg.replyContext.content.substring(0, 200)}`)
    }
    lines.push('')
    lines.push(msg.content)
    if (msg.threadMessages && msg.threadMessages.length > 0) {
      lines.push('')
      lines.push('**Thread context:**')
      for (const tm of msg.threadMessages.slice(-5)) {
        lines.push(`> @${tm.author} (${tm.timestamp}): ${tm.content.substring(0, 300)}`)
      }
    }
    if (Object.keys(msg.reactions).length > 0) {
      const reactionStr = Object.entries(msg.reactions).map(([k, v]) => `${k}: ${v}`).join(', ')
      lines.push(`Reactions: ${reactionStr}`)
    }
    lines.push('')
    lines.push('---')
    lines.push('')
  }

  const manifestPath = join(outputDir, `discord-${guildName}.md`)
  await writeFileAsync(manifestPath, lines.join('\n'), 'utf-8')
  return manifestPath
}
