import { Client, GatewayIntentBits, Events, Message, ChannelType } from 'discord.js'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { getConfig, getValue, resolveGuilds, resolveGuildId, getSystemPrompt, GuildConfig, ChannelConfig } from '../config'
import { updateState, setPostedDiscordResponse, loadState, getPostedDiscordResponses } from '../state'
import { ensureDir } from '../utils/fs'
import { REPO_ROOT, RESPONSES_DIR } from '../utils/paths'
import { parseFrontMatter } from '../utils/frontmatter'
import { isMonitoredChannel, isLikelyHelpRequest, formatMessagePreview, buildSingleMessagePrompt, formatTime } from './live-utils'

const DISCORD_API = 'https://discord.com/api/v10'
const MAX_DISCORD_LENGTH = 2000
const FEEDBACK_PROMPT = '\n\n-# Was this helpful? React with :thumbsup: or :thumbsdown: to help improve future responses.'

export interface LiveOptions {
  dispatchMode?: string
  repos?: string[]
  repoDir?: string
  docsDir?: string
  modelOverride?: string
  dryRun: boolean
}

interface GuildMapping {
  guildConfig: GuildConfig
  /** Map of Discord channel ID -> channel config */
  channelMap: Map<string, ChannelConfig>
  /** Map of Discord channel name -> channel config */
  channelNameMap: Map<string, ChannelConfig>
}

// Track messages currently being processed to prevent duplicates
const processingMessages = new Set<string>()

/**
 * Run the bot in live mode — persistent Discord Gateway connection.
 */
export async function runLive(options: LiveOptions): Promise<void> {
  const config = await getConfig()
  const botConfig = getValue(config, ['bot'], {} as Record<string, unknown>)
  const botName = (getValue(botConfig, ['name'], 'GameCI Help Bot') as string)
  const botVersion = (getValue(botConfig, ['version'], '3.0.0') as string)
  const discordConfig = getValue(config, ['discord'], {} as Record<string, unknown>)
  const guilds = resolveGuilds(discordConfig)
  const dispatchConfig = getValue(config, ['dispatch'], {} as Record<string, unknown>)
  const dispatchMode = options.dispatchMode ?? (getValue(dispatchConfig, ['discord_mode'], 'auto') as string)
  const llmModel = options.modelOverride
    ?? (getValue(config, ['llm', 'claude', 'model'], 'claude-sonnet-4-20250514') as string)
  const ignoreBots = Boolean(getValue(discordConfig, ['ignore_bots'], true))
  const ignorePrefixes = (getValue(discordConfig, ['ignore_prefixes'], ['!', '/', '$', '.']) as string[])
  const minMessageLength = Number(getValue(discordConfig, ['min_message_length'], 15))

  const token = process.env.DISCORD_BOT_TOKEN
  if (!token) {
    console.error('Error: DISCORD_BOT_TOKEN environment variable is not set.')
    console.error('Run: npx gameci-help-bot cycle  (it will prompt you to store the token)')
    console.error('Or set DISCORD_BOT_TOKEN in your environment.')
    process.exit(1)
  }

  // --- Startup banner ---
  console.log('')
  console.log(`${botName} v${botVersion} — Live Mode`)
  console.log('═'.repeat(50))
  console.log(`  Dispatch mode: ${dispatchMode}`)
  console.log(`  Model: ${llmModel}`)
  if (options.dryRun) {
    console.log(`  DRY RUN: responses will not be posted`)
  }
  if (options.repoDir) {
    console.log(`  Repo: ${options.repoDir}`)
  }
  if (options.docsDir) {
    console.log(`  Docs: ${options.docsDir}`)
  }
  console.log('')
  console.log('Connecting to Discord...')

  // --- Build guild lookup ---
  const guildMappings = new Map<string, GuildMapping>()
  for (const guild of guilds) {
    const guildId = resolveGuildId(guild)
    if (!guildId) {
      console.warn(`  ⚠ Guild "${guild.name}": no guild ID configured — skipping`)
      continue
    }
    guildMappings.set(guildId, {
      guildConfig: guild,
      channelMap: new Map(),
      channelNameMap: new Map(),
    })
    for (const ch of guild.channels) {
      guildMappings.get(guildId)!.channelNameMap.set(ch.name, ch)
    }
  }

  // --- Create client ---
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  })

  // --- Ready handler ---
  client.once(Events.ClientReady, (readyClient) => {
    console.log(`  ✓ Logged in as ${readyClient.user.tag}`)
    console.log('')

    // Show guild status
    console.log('Guilds:')
    for (const [guildId, mapping] of guildMappings) {
      const discordGuild = readyClient.guilds.cache.get(guildId)
      if (discordGuild) {
        // Build channel map from actual Discord channels
        for (const [, channel] of discordGuild.channels.cache) {
          if (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildForum) {
            const channelConfig = mapping.channelNameMap.get(channel.name)
            if (channelConfig) {
              mapping.channelMap.set(channel.id, channelConfig)
            }
          }
        }

        const monitoredChannels = [...mapping.channelNameMap.entries()]
          .filter(([, ch]) => ch.monitor !== false)
          .map(([name]) => `#${name}`)
        console.log(`  ✓ ${mapping.guildConfig.name} — monitoring: ${monitoredChannels.join(', ') || '(none)'}`)
      } else {
        console.log(`  ⚠ ${mapping.guildConfig.name} — bot not in this server (invite needed)`)
      }
    }

    console.log('')
    console.log(`Ready. Listening for messages...`)
    console.log('─'.repeat(50))
  })

  // --- Message handler ---
  client.on(Events.MessageCreate, async (message: Message) => {
    // Skip DMs
    if (!message.guild) return

    // Find guild mapping
    const mapping = guildMappings.get(message.guild.id)
    if (!mapping) return // Not a configured guild

    // Get channel info
    const channelName = ('name' in message.channel ? message.channel.name : '') ?? ''
    const channelConfig = mapping.channelMap.get(message.channelId)
      ?? mapping.channelNameMap.get(channelName)

    // Check if channel is monitored
    if (!channelConfig || channelConfig.monitor === false) return

    const guildName = mapping.guildConfig.name
    const timestamp = formatTime()
    const authorTag = message.author.tag ?? message.author.username

    // Skip: bot messages
    if (ignoreBots && message.author.bot) {
      return
    }

    // Skip: command prefixes
    const content = message.content.trim()
    if (ignorePrefixes.some((p) => content.startsWith(p))) {
      return
    }

    // Skip: too short
    if (content.length < minMessageLength) {
      return
    }

    const preview = formatMessagePreview(content)
    console.log(`[${timestamp}] #${channelName} @${authorTag}: ${preview}`)

    // Skip: already responded
    const state = await loadState()
    const postedResponses = getPostedDiscordResponses(state)
    const responseKey = `discord:${guildName}/${channelName}#${message.id}`
    if (postedResponses[responseKey]) {
      console.log(`  → Skipped (already responded)`)
      return
    }

    // Skip: currently processing this message
    if (processingMessages.has(message.id)) {
      return
    }

    // Check: is this a help request?
    if (!isLikelyHelpRequest(content)) {
      console.log(`  → Skipped (not a help request)`)
      return
    }

    console.log(`  → Help request detected.`)

    // Dispatch gate
    if (dispatchMode === 'auto') {
      // Auto mode: investigate immediately
      console.log(`  → Investigating...`)
      processingMessages.add(message.id)
      try {
        await investigateAndRespond(message, mapping, channelConfig, options, config, llmModel)
      } finally {
        processingMessages.delete(message.id)
      }
    } else {
      // Approval / countdown mode: log and defer
      console.log(`  → Dispatch mode is "${dispatchMode}" — message queued for next cycle.`)
      console.log(`    Run "gameci-help-bot cycle" to create detection issues and check approvals.`)
    }
  })

  // --- Graceful shutdown ---
  function shutdown() {
    console.log('')
    console.log('Shutting down gracefully...')
    client.destroy()
    console.log('  ✓ Disconnected from Discord.')
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // --- Login ---
  try {
    await client.login(token)
  } catch (error: any) {
    console.error(`Failed to connect to Discord: ${error.message ?? error}`)
    if (error.code === 'TokenInvalid') {
      console.error('The bot token is invalid. Check DISCORD_BOT_TOKEN.')
    }
    if (error.code === 'DisallowedIntents') {
      console.error('Message Content Intent is not enabled.')
      console.error('Go to https://discord.com/developers/applications → Bot → enable "Message Content Intent"')
    }
    process.exit(1)
  }
}

/**
 * Investigate a single message via LLM and post the response.
 */
async function investigateAndRespond(
  message: Message,
  mapping: GuildMapping,
  channelConfig: ChannelConfig,
  options: LiveOptions,
  config: Record<string, unknown>,
  model: string,
): Promise<void> {
  const guildName = mapping.guildConfig.name
  const channelName = channelConfig.name
  const authorTag = message.author.tag ?? message.author.username
  const responseId = `live-${guildName}-${channelName}-${message.id}`

  // Build thread context if in a thread
  let threadContext: Array<{ author: string; content: string; timestamp: string }> | undefined
  if (message.channel.isThread()) {
    try {
      const threadMessages = await message.channel.messages.fetch({ limit: 10 })
      threadContext = [...threadMessages.values()]
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
        .filter((m) => m.id !== message.id)
        .map((m) => ({
          author: m.author.tag ?? m.author.username,
          content: m.content,
          timestamp: m.createdAt.toISOString(),
        }))
    } catch {
      // Thread fetch failed — continue without context
    }
  }

  // Build the channel system prompt
  const discordConfig = getValue(config, ['discord'], {} as Record<string, unknown>)
  const channelSystemPrompt = getSystemPrompt(discordConfig, mapping.guildConfig, channelConfig)

  // Build the investigation prompt
  const prompt = buildSingleMessagePrompt({
    author: authorTag,
    channelName,
    guildName,
    content: message.content,
    threadContext,
    channelSystemPrompt,
    repoDir: options.repoDir,
    docsDir: options.docsDir,
    responseId,
  })

  // Ensure response directory exists
  const responseDir = join(RESPONSES_DIR, 'discord')
  await ensureDir(responseDir)

  // Run Claude investigation
  console.log(`  → LLM running (${model})...`)

  const maxTurns = Number(getValue(config, ['llm', 'claude', 'max_turns'], 0)) || 25

  try {
    const args = ['-p', '--model', model, '--max-turns', String(maxTurns)]
    args.push(
      '--allowedTools', 'Read',
      '--allowedTools', 'Glob',
      '--allowedTools', 'Grep',
      '--allowedTools', 'Bash',
      '--allowedTools', 'Write',
    )
    args.push(
      '--disallowedTools', 'Edit',
      '--disallowedTools', 'WebFetch',
      '--disallowedTools', 'WebSearch',
      '--disallowedTools', 'NotebookEdit',
      '--disallowedTools', 'Task',
    )

    const proc = spawn('claude', args, {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'inherit', 'inherit'],
    })
    proc.stdin.end(prompt)
    await once(proc, 'exit')
  } catch (error: any) {
    console.warn(`  ✗ LLM investigation failed: ${error.message ?? error}`)
    return
  }

  // Read the response file
  const responseFile = join(responseDir, `${responseId}.md`)
  let responseContent: string
  try {
    responseContent = await readFile(responseFile, 'utf-8')
  } catch {
    console.warn(`  ✗ No response file produced at ${responseFile}`)
    return
  }

  const { body } = parseFrontMatter(responseContent)
  const trimmed = body.trim()
  if (!trimmed) {
    console.warn(`  ✗ Response file is empty`)
    return
  }

  console.log(`  → Response ready (${trimmed.length} chars).`)

  if (options.dryRun) {
    console.log(`  → DRY RUN: would post response. Preview:`)
    console.log(`    ${formatMessagePreview(trimmed, 200)}`)
    return
  }

  // Post the response to Discord
  console.log(`  → Posting...`)
  try {
    const bodyWithFeedback = trimmed + FEEDBACK_PROMPT
    const chunks = splitContent(bodyWithFeedback)
    let lastMessageId: string | undefined

    for (const [index, chunk] of chunks.entries()) {
      const chunkContent = chunks.length > 1
        ? `(part ${index + 1}/${chunks.length})\n${chunk}`
        : chunk

      const reply = await message.reply({
        content: chunkContent,
        allowedMentions: { repliedUser: true },
      })

      lastMessageId = reply.id

      if (index < chunks.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }

    // Record in state
    await updateState((s) => {
      setPostedDiscordResponse(s, guildName, channelName, message.id)
    })

    console.log(`  ✓ Response posted to #${channelName} (reply to @${authorTag})`)
  } catch (error: any) {
    console.warn(`  ✗ Failed to post response: ${error.message ?? error}`)
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
