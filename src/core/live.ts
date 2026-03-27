import { Client, GatewayIntentBits, Events, Message, ChannelType, ActivityType, Attachment, type TextChannel } from 'discord.js'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { getConfig, getValue, resolveGuilds, resolveGuildId, getSystemPrompt, GuildConfig, ChannelConfig } from '../config'
import { updateState, setPostedDiscordResponse, loadState, getPostedDiscordResponses, getLastOnlineAt, getFirstOnlineAt, setLastOnlineAt, getTriageRecord, setTriageRecord } from '../state'
import { ensureDir } from '../utils/fs'
import { REPO_ROOT, RESPONSES_DIR, DATA_DIR } from '../utils/paths'
import { parseFrontMatter } from '../utils/frontmatter'
import { isMonitoredChannel, formatMessagePreview, buildSingleMessagePrompt, buildInvestigationPrompt, formatTime, writeContextFile, ReplyChainMessage } from './live-utils'
import { handleTriageInteraction, postTriageNotification, discordCompactId, githubCompactId, type TriageHandlerContext } from '../triage'
import { syncGitHub } from '../sync/github'
import { filterIssues, type EligibleIssue } from './filter-issues'

const DISCORD_API = 'https://discord.com/api/v10'
const MAX_DISCORD_LENGTH = 2000
const FEEDBACK_PROMPT = '\n\n-# Was this helpful? React :thumbsup: or :thumbsdown: | React :repeat: to request a re-investigation'

// --- Status management ---
let idleStatusText = 'help requests'
let activeInvestigations = 0

function setIdleStatus(client: Client): void {
  client.user?.setPresence({
    status: 'online',
    activities: [{
      name: idleStatusText,
      type: ActivityType.Watching,
    }],
  })
}

function setInvestigatingStatus(client: Client, channelName: string, author: string): void {
  activeInvestigations++
  const suffix = activeInvestigations > 1 ? ` (+${activeInvestigations - 1} more)` : ''
  client.user?.setPresence({
    status: 'dnd',
    activities: [{
      name: `@${author} in #${channelName}${suffix}`,
      type: ActivityType.Custom,
      state: `Investigating @${author} in #${channelName}${suffix}`,
    }],
  })
}

function clearInvestigatingStatus(client: Client): void {
  activeInvestigations = Math.max(0, activeInvestigations - 1)
  if (activeInvestigations === 0) {
    setIdleStatus(client)
  }
}

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
  const githubTriage = Boolean(getValue(config, ['dispatch', 'github_triage'], false))
  const githubPollMinutes = Number(getValue(config, ['dispatch', 'github_poll_interval_minutes'], 10))
  const githubRepos = getValue(config, ['github', 'repos'], [] as string[])
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
  if (githubTriage && dispatchMode === 'triage') {
    console.log(`  GitHub triage: enabled (polling every ${githubPollMinutes}m)`)
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

  // --- Triage setup ---
  const triageChannels = new Map<string, TextChannel>()
  const collaborators = getValue(config, ['github', 'collaborators'], [] as string[])

  /** Resolve guild+channel config by name (used by triage handler) */
  function resolveGuildChannel(guildName: string, channelName: string) {
    for (const [, mapping] of guildMappings) {
      if (mapping.guildConfig.name === guildName) {
        const channelConfig = mapping.channelNameMap.get(channelName)
        if (channelConfig) {
          return { guildConfig: mapping.guildConfig, channelConfig }
        }
      }
    }
    return undefined
  }

  const triageUserIds = getValue(config, ['discord', 'triage_user_ids'], [] as string[])

  const triageHandlerContext: TriageHandlerContext = {
    config,
    model: llmModel,
    repoDir: options.repoDir,
    docsDir: options.docsDir,
    resolveGuildChannel,
    collaborators,
    triageUserIds,
    setInvestigating: (channelName: string, author: string) => setInvestigatingStatus(client, channelName, author),
    clearInvestigating: () => clearInvestigatingStatus(client),
  }

  // --- Create client ---
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
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

    // Resolve triage channels (supports cross-guild routing — channel can be in any guild the bot is in)
    for (const [guildId, mapping] of guildMappings) {
      const triageChannelId = mapping.guildConfig.triage_channel_id
      if (!triageChannelId) continue
      const triageCh = readyClient.channels.cache.get(triageChannelId)
      if (triageCh?.isTextBased()) {
        triageChannels.set(guildId, triageCh as TextChannel)
        const chName = 'name' in triageCh ? triageCh.name : triageChannelId
        const targetGuild = 'guild' in triageCh ? (triageCh as any).guild?.name : 'unknown'
        const crossGuild = targetGuild !== mapping.guildConfig.name ? ` (cross-guild → ${targetGuild})` : ''
        console.log(`  ✓ Triage channel: #${chName} for ${mapping.guildConfig.name}${crossGuild}`)
      } else {
        console.warn(`  ⚠ Triage channel ${triageChannelId} not found for ${mapping.guildConfig.name}`)
      }
    }

    // Set bot presence/status
    const monitoredCount = [...guildMappings.values()]
      .reduce((acc, m) => acc + [...m.channelNameMap.values()].filter(ch => ch.monitor !== false).length, 0)
    idleStatusText = `${monitoredCount} channels for help requests`
    setIdleStatus(readyClient)

    console.log('')
    console.log(`Ready. Listening for messages...`)
    console.log('─'.repeat(50))

    // --- Timestamp-based catch-up: never process messages before firstOnlineAt ---
    ;(async () => {
      const state = await loadState()
      const lastOnline = getLastOnlineAt(state)

      if (!lastOnline) {
        // First-ever run — stamp now, skip catch-up, never answer anything older
        console.log(`First run — stamping firstOnlineAt. Will never process messages before this point.`)
        await updateState((s) => setLastOnlineAt(s))
      } else if (dispatchMode === 'auto') {
        const cutoff = new Date(lastOnline)
        console.log(`Last online: ${cutoff.toISOString()} — catching up from there.`)
        await catchUpMissedMessages(readyClient, guildMappings, options, config, llmModel, {
          ignoreBots, ignorePrefixes, minMessageLength,
        }, cutoff)
        await updateState((s) => setLastOnlineAt(s))
      } else {
        await updateState((s) => setLastOnlineAt(s))
      }

      // Heartbeat: update lastOnlineAt every 5 minutes so restarts know the gap
      setInterval(async () => {
        await updateState((s) => setLastOnlineAt(s)).catch(() => {})
      }, 5 * 60 * 1000)

      // GitHub triage polling (opt-in)
      if (githubTriage && dispatchMode === 'triage' && triageChannels.size > 0) {
        // Run an initial poll after a short delay, then on interval
        setTimeout(() => pollGitHubForTriage().catch((e) => console.warn(`  GitHub poll error: ${e.message ?? e}`)), 15_000)
        setInterval(() => pollGitHubForTriage().catch((e) => console.warn(`  GitHub poll error: ${e.message ?? e}`)), githubPollMinutes * 60 * 1000)
        console.log(`  GitHub triage polling started (every ${githubPollMinutes}m)`)
      }
    })().catch((err) => {
      console.warn(`  Catch-up scan failed: ${err.message ?? err}`)
    })
  })

  // --- Message handler ---
  client.on(Events.MessageCreate, async (message: Message) => {
    // Skip DMs
    if (!message.guild) return

    // Find guild mapping
    const mapping = guildMappings.get(message.guild.id)
    if (!mapping) return // Not a configured guild

    // Get channel info — resolve parent for threads and forum posts
    let channelName = ('name' in message.channel ? message.channel.name : '') ?? ''
    let resolvedChannelId = message.channelId
    let channelConfig = mapping.channelMap.get(message.channelId)
      ?? mapping.channelNameMap.get(channelName)

    // If not found, check if this is a thread/forum post and resolve the parent
    if (!channelConfig && message.channel.isThread()) {
      const parentId = message.channel.parentId
      if (parentId) {
        channelConfig = mapping.channelMap.get(parentId)
        if (channelConfig) {
          channelName = channelConfig.name
          resolvedChannelId = parentId
        } else {
          // Try resolving parent by name
          const parentChannel = message.guild.channels.cache.get(parentId)
          const parentName = parentChannel && 'name' in parentChannel ? parentChannel.name : ''
          if (parentName) {
            channelConfig = mapping.channelNameMap.get(parentName)
            if (channelConfig) {
              channelName = parentName
              resolvedChannelId = parentId
            }
          }
        }
      }
    }

    // Check if channel is monitored
    if (!channelConfig || channelConfig.monitor === false) return

    const guildName = mapping.guildConfig.name
    const timestamp = formatTime()
    const authorTag = message.author.tag ?? message.author.username

    // Skip: bot messages
    if (ignoreBots && message.author.bot) {
      return
    }

    // Only respond if the user @mentions the bot or is replying to the bot
    const botId = client.user?.id
    const isMentioned = botId ? message.mentions.users.has(botId) : false
    const isReplyToBot = message.reference?.messageId
      ? await message.channel.messages.fetch(message.reference.messageId)
          .then((ref) => ref.author.id === botId)
          .catch(() => false)
      : false

    if (!isMentioned && !isReplyToBot) {
      return
    }

    // Skip: messages older than firstOnlineAt — never process pre-existing messages
    const state0 = await loadState()
    const firstOnline = getFirstOnlineAt(state0)
    if (firstOnline && message.createdAt < new Date(firstOnline)) {
      return
    }

    // Skip: command prefixes
    const content = message.content.trim()
    if (ignorePrefixes.some((p) => content.startsWith(p))) {
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

    console.log(`  → Responding to ${isMentioned ? '@mention' : 'reply'}...`)

    // Dispatch gate
    if (dispatchMode === 'auto') {
      // Auto mode: investigate immediately
      console.log(`  → Investigating...`)
      processingMessages.add(message.id)
      setInvestigatingStatus(client, channelName, authorTag)
      // React with 🔍 to show investigation has started
      await message.react('🔍').catch(() => {})
      try {
        await investigateAndRespond(message, mapping, channelConfig, options, config, llmModel)
        // Replace 🔍 with ✅ on success
        await message.reactions.cache.get('🔍')?.users.remove(client.user!.id).catch(() => {})
        await message.react('✅').catch(() => {})
      } catch (err) {
        // Replace 🔍 with ❌ on failure
        await message.reactions.cache.get('🔍')?.users.remove(client.user!.id).catch(() => {})
        await message.react('❌').catch(() => {})
        throw err
      } finally {
        processingMessages.delete(message.id)
        clearInvestigatingStatus(client)
      }
    } else if (dispatchMode === 'triage') {
      // Triage mode: post notification to admin channel
      const triageChannel = triageChannels.get(message.guild!.id)
      if (!triageChannel) {
        console.log(`  → Triage mode but no triage channel configured for this guild. Skipping.`)
        return
      }

      const compactId = discordCompactId(guildName, channelName, message.id)
      const triageKey = `triage:d:${compactId}`

      // Check if triage already exists
      const triageState = await loadState()
      const existing = getTriageRecord(triageState, triageKey)
      if (existing) {
        console.log(`  → Triage already exists for this message. Skipping.`)
        return
      }

      try {
        const triageMsg = await postTriageNotification(
          triageChannel,
          {
            sourceType: 'd',
            title: formatMessagePreview(content, 200),
            content,
            author: authorTag,
            guildName,
            guildId: message.guild!.id,
            channelName,
            channelId: message.channelId,
            messageId: message.id,
            status: 'pending',
          },
          'd',
          compactId,
        )

        // Save triage record
        await updateState((s) => {
          setTriageRecord(s, triageKey, {
            triageKey,
            triageMessageId: triageMsg.id,
            triageChannelId: triageChannel.id,
            sourceType: 'discord',
            sourceDiscordPath: `${guildName}/${channelName}`,
            sourceGuildId: message.guild!.id,
            sourceChannelId: message.channelId,
            sourceMessageId: message.id,
            sourceTitle: formatMessagePreview(content, 200),
            sourceContent: content,
            sourceAuthor: authorTag,
            status: 'pending',
            createdAt: new Date().toISOString(),
            reinvestigationCount: 0,
          })
        })

        // Let the user know their question was received (configurable)
        const ackEnabled = getValue(config, ['triage', 'acknowledge_user'], true as boolean) !== false
        if (ackEnabled) {
          await message.reply({
            content: 'Your question has been received and is queued for investigation. A maintainer will review it shortly.',
            allowedMentions: { repliedUser: false },
          }).catch(() => {})
        }
        console.log(`  → Triage notification posted to #${'name' in triageChannel ? triageChannel.name : 'triage'}`)
      } catch (err: any) {
        console.warn(`  → Failed to post triage notification: ${err.message ?? err}`)
      }
    } else {
      // Approval / countdown mode: log and defer
      console.log(`  → Dispatch mode is "${dispatchMode}" — message queued for next cycle.`)
      console.log(`    Run "gameci-help-bot cycle" to create detection issues and check approvals.`)
    }
  })

  // --- Interaction handler (triage buttons) ---
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      await handleTriageInteraction(interaction, client, triageHandlerContext)
    } catch (err: any) {
      console.warn(`  Interaction handler error: ${err.message ?? err}`)
    }
  })

  // --- Reaction handler (feedback + re-investigate) ---
  const REINVESTIGATE_EMOJI = '🔁'
  const FEEDBACK_DIR = join(DATA_DIR, 'feedback', 'negative')

  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    // Ignore bot's own reactions
    if (user.id === client.user?.id) return

    // Ensure full message is fetched (partials)
    try {
      if (reaction.partial) await reaction.fetch()
      if (reaction.message.partial) await reaction.message.fetch()
    } catch {
      return
    }

    const msg = reaction.message
    // Only care about reactions on messages the bot authored
    if (msg.author?.id !== client.user?.id) return

    const emoji = reaction.emoji.name
    const channelName = ('name' in msg.channel ? msg.channel.name : '') ?? ''
    const timestamp = formatTime()

    // --- Downvote feedback logging ---
    if (emoji === '👎') {
      console.log(`[${timestamp}] 👎 Downvote on bot response in #${channelName}`)

      try {
        await ensureDir(FEEDBACK_DIR)

        // Find the original question (the message the bot replied to)
        let originalContent = '(unknown — could not fetch original message)'
        let originalAuthor = 'unknown'
        if (msg.reference?.messageId) {
          try {
            const original = await msg.channel.messages.fetch(msg.reference.messageId)
            originalContent = original.content
            originalAuthor = original.author.tag ?? original.author.username
          } catch { /* original deleted or inaccessible */ }
        }

        const feedbackId = `${Date.now()}-${msg.id}`
        const feedbackContent = [
          `# Negative Feedback`,
          ``,
          `- **Date:** ${new Date().toISOString()}`,
          `- **Channel:** #${channelName}`,
          `- **Downvoted by:** ${user.tag ?? (user as any).username ?? user.id}`,
          `- **Bot message ID:** ${msg.id}`,
          ``,
          `## Original Question`,
          `**@${originalAuthor}:**`,
          originalContent,
          ``,
          `## Bot Response (downvoted)`,
          msg.content ?? '(empty)',
          ``,
          `## Analysis`,
          `(To be reviewed — what went wrong with this response?)`,
          ``,
        ].join('\n')

        await writeFile(join(FEEDBACK_DIR, `${feedbackId}.md`), feedbackContent, 'utf-8')
        console.log(`  → Feedback logged: data/feedback/negative/${feedbackId}.md`)
      } catch (err: any) {
        console.warn(`  → Failed to log feedback: ${err.message ?? err}`)
      }
    }

    // --- Re-investigate trigger ---
    if (emoji === REINVESTIGATE_EMOJI) {
      // Only allow re-investigation from non-bot users
      if (!msg.reference?.messageId) return
      if (processingMessages.has(msg.reference.messageId)) return

      // Find which guild/channel this is in
      if (!msg.guild) return
      const mapping = guildMappings.get(msg.guild.id)
      if (!mapping) return
      const channelConfig = mapping.channelMap.get(msg.channelId)
        ?? mapping.channelNameMap.get(channelName)
      if (!channelConfig) return

      console.log(`[${timestamp}] 🔁 Re-investigate requested in #${channelName} by @${user.tag ?? (user as any).username ?? user.id}`)

      // Fetch the original user message
      let originalMessage: Message
      try {
        originalMessage = await msg.channel.messages.fetch(msg.reference.messageId) as Message
      } catch {
        console.warn(`  → Could not fetch original message for re-investigation`)
        return
      }

      // Mark as processing
      processingMessages.add(originalMessage.id)
      await originalMessage.react('🔍').catch(() => {})
      setInvestigatingStatus(client, channelName, originalMessage.author.tag ?? originalMessage.author.username)

      try {
        await reinvestigateAndRespond(originalMessage, msg.content ?? '', mapping, channelConfig, options, config, llmModel)
        await originalMessage.reactions.cache.get('🔍')?.users.remove(client.user!.id).catch(() => {})
        await originalMessage.react('✅').catch(() => {})
      } catch {
        await originalMessage.reactions.cache.get('🔍')?.users.remove(client.user!.id).catch(() => {})
        await originalMessage.react('❌').catch(() => {})
      } finally {
        processingMessages.delete(originalMessage.id)
        clearInvestigatingStatus(client)
      }
    }

    // --- Post investigation to GitHub (📋 reaction in game-ci-develop) ---
    if (emoji === '📋') {
      // Only trigger if a non-bot user reacts (the bot pre-seeds 📋 on its own replies)
      if (!msg.reference?.messageId) return
      if (!msg.guild) return

      const mapping = guildMappings.get(msg.guild.id)
      if (!mapping) return

      // Only in game-ci-develop
      if (mapping.guildConfig.name !== 'game-ci-develop') return

      console.log(`[${timestamp}] 📋 Post investigation requested in #${channelName} by @${user.tag ?? (user as any).username ?? user.id}`)

      // Find the response files for this investigation
      const guildName = mapping.guildConfig.name
      // The response ID pattern: live-{guild}-{channel}-{messageId}
      // The bot reply references the original user message
      const originalMsgId = msg.reference.messageId
      const responseId = `live-${guildName}-${channelName}-${originalMsgId}`
      const responseDir = join(RESPONSES_DIR, 'discord')

      try {
        // Check if investigation artifacts exist
        const findingsPath = join(responseDir, `${responseId}-findings.md`)
        const analysisPath = join(responseDir, `${responseId}-analysis.md`)
        const responsePath = join(responseDir, `${responseId}.md`)

        let hasArtifacts = false
        try { await readFile(findingsPath, 'utf-8'); hasArtifacts = true } catch { /* file not found */ }
        try { await readFile(analysisPath, 'utf-8'); hasArtifacts = true } catch { /* file not found */ }

        if (!hasArtifacts) {
          console.log(`  → No investigation artifacts found for ${responseId}`)
          return
        }

        // Use postInvestigationIssues to create the GitHub issue
        const { postInvestigationIssues } = await import('../post/investigations.js')
        await postInvestigationIssues({
          dryRun: options.dryRun,
          targetRepo: 'game-ci/help-bot',
          labels: ['investigation', 'discord'],
        })

        // Remove the bot's 📋 reaction to show it's been handled
        await msg.reactions.cache.get('📋')?.users.remove(client.user!.id).catch(() => {})
        await msg.react('✅').catch(() => {})
        console.log(`  ✓ Investigation posted to GitHub`)
      } catch (err: any) {
        console.warn(`  → Failed to post investigation: ${err.message ?? err}`)
      }
    }
  })

  // --- GitHub triage polling ---
  let githubPollRunning = false

  async function pollGitHubForTriage(): Promise<void> {
    if (githubPollRunning) return
    githubPollRunning = true
    try {
      const timestamp = formatTime()
      console.log(`[${timestamp}] GitHub poll: syncing issues...`)

      // Sync latest GitHub data
      await syncGitHub({ repos: options.repos ?? githubRepos })

      // Pick the first available triage channel (for now, post all GitHub triage to the first guild's triage channel)
      const triageChannel = [...triageChannels.values()][0]
      if (!triageChannel) return

      // Filter eligible issues from each repo
      let totalNew = 0
      for (const repo of (options.repos ?? githubRepos)) {
        const repoSlug = repo.replace(/\//g, '-')
        const result = await filterIssues(repoSlug, repo)
        if (result.eligible.length === 0) continue

        for (const issue of result.eligible) {
          const compactId = githubCompactId(repo, issue.number)
          const triageKey = `triage:g:${compactId}`

          // Skip if already triaged
          const state = await loadState()
          if (getTriageRecord(state, triageKey)) continue

          // Read issue content from the synced markdown file
          let issueContent = ''
          try {
            const fileContent = await readFile(issue.file, 'utf-8')
            const { body } = parseFrontMatter(fileContent)
            issueContent = body.substring(0, 4000) // Truncate for embed
          } catch {
            issueContent = `(Could not read issue content from ${issue.file})`
          }

          // Post triage notification
          try {
            const triageMsg = await postTriageNotification(
              triageChannel,
              {
                sourceType: 'g',
                title: issue.title,
                content: issueContent,
                author: issue.author,
                repo,
                issueNumber: issue.number,
                labels: issue.labels,
                status: 'pending',
              },
              'g',
              compactId,
            )

            // Save triage record
            await updateState((s) => {
              setTriageRecord(s, triageKey, {
                triageKey,
                triageMessageId: triageMsg.id,
                triageChannelId: triageChannel.id,
                sourceType: issue.type === 'pull_request' ? 'github_pr' : 'github_issue',
                sourceRepo: repo,
                sourceIssueNumber: issue.number,
                sourceTitle: issue.title,
                sourceContent: issueContent,
                sourceAuthor: issue.author,
                sourceLabels: issue.labels,
                status: 'pending',
                createdAt: new Date().toISOString(),
                reinvestigationCount: 0,
              })
            })

            totalNew++
            console.log(`  → Triage: ${repo}#${issue.number} "${issue.title}" by @${issue.author}`)
          } catch (err: any) {
            console.warn(`  → Failed to post triage for ${repo}#${issue.number}: ${err.message ?? err}`)
          }
        }
      }

      if (totalNew > 0) {
        console.log(`[${timestamp}] GitHub poll: ${totalNew} new issue(s) posted to triage`)
      } else {
        console.log(`[${timestamp}] GitHub poll: no new issues`)
      }
    } finally {
      githubPollRunning = false
    }
  }

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
 * Fetch the reply chain for a message by following message.reference links.
 * Returns messages in chronological order (oldest first).
 */
async function fetchReplyChain(message: Message, maxDepth = 15): Promise<ReplyChainMessage[]> {
  const chain: ReplyChainMessage[] = []
  let current = message
  let depth = 0

  while (current.reference?.messageId && depth < maxDepth) {
    try {
      const parent = await current.channel.messages.fetch(current.reference.messageId)
      chain.unshift({
        author: parent.author.tag ?? parent.author.username,
        content: parent.content,
        timestamp: parent.createdAt.toISOString(),
        isBot: parent.author.bot,
        messageId: parent.id,
      })
      current = parent
      depth++
    } catch {
      break // Can't fetch further — permission issue or deleted message
    }
  }

  return chain
}

/** Allowed text file extensions for attachment downloads. */
const TEXT_EXTENSIONS = new Set(['.txt', '.log', '.yml', '.yaml', '.json', '.xml', '.csv', '.md', '.ini', '.cfg', '.conf', '.toml', '.env.example'])

/** Max attachment size to download (256 KB). */
const MAX_ATTACHMENT_SIZE = 256 * 1024

/**
 * Download text file attachments from a Discord message.
 * Writes each file to the response directory and returns relative paths.
 * Only downloads safe text-based files; skips images, binaries, and oversized files.
 */
async function downloadTextAttachments(
  message: Message,
  responseDir: string,
  responseId: string,
): Promise<Array<{ filename: string; path: string; size: number }>> {
  const downloaded: Array<{ filename: string; path: string; size: number }> = []

  for (const [, attachment] of message.attachments) {
    const name = attachment.name ?? 'unknown'
    const ext = name.includes('.') ? '.' + name.split('.').pop()!.toLowerCase() : ''

    // Only allow known text extensions
    if (!TEXT_EXTENSIONS.has(ext)) {
      console.log(`  → Attachment skipped (not a text file): ${name}`)
      continue
    }

    // Size guard
    if (attachment.size > MAX_ATTACHMENT_SIZE) {
      console.log(`  → Attachment skipped (too large: ${Math.round(attachment.size / 1024)}KB): ${name}`)
      continue
    }

    try {
      const response = await fetch(attachment.url)
      if (!response.ok) {
        console.log(`  → Attachment download failed (${response.status}): ${name}`)
        continue
      }
      const text = await response.text()

      // Write to response dir with a safe filename
      const safeFilename = `${responseId}-attachment-${name.replace(/[^a-zA-Z0-9._-]/g, '_')}`
      const filePath = join(responseDir, safeFilename)
      await writeFile(filePath, text, 'utf-8')

      const relPath = filePath.replace(/\\/g, '/').replace(/^.*?(data\/)/, '$1')
      downloaded.push({ filename: name, path: relPath, size: text.length })
      console.log(`  → Attachment downloaded: ${name} (${text.length} chars) → ${relPath}`)
    } catch (err: any) {
      console.log(`  → Attachment download failed: ${name}: ${err.message ?? err}`)
    }
  }

  return downloaded
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

  // Fetch reply chain (follow message.reference links backwards)
  let replyChain: ReplyChainMessage[] = []
  try {
    replyChain = await fetchReplyChain(message)
    if (replyChain.length > 0) {
      console.log(`  → Fetched reply chain: ${replyChain.length} message(s)`)
    }
  } catch {
    // Reply chain fetch failed — continue without it
  }

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

  // Download text file attachments (.txt, .log, .json, .yaml, etc.)
  const responseDir = join(RESPONSES_DIR, 'discord')
  await ensureDir(responseDir)

  let attachments: Array<{ filename: string; path: string; size: number }> = []
  if (message.attachments.size > 0) {
    attachments = await downloadTextAttachments(message, responseDir, responseId)
  }

  // Write context file if we have reply chain, thread context, or attachments
  let contextFilePath: string | undefined
  if (replyChain.length > 0 || (threadContext && threadContext.length > 0) || attachments.length > 0) {
    try {
      contextFilePath = await writeContextFile({
        responseId,
        responseDir,
        replyChain,
        threadContext,
        triggerMessage: {
          author: authorTag,
          content: message.content,
          timestamp: message.createdAt.toISOString(),
          messageId: message.id,
        },
        attachments,
      })
      // Make path relative to repo root for the LLM
      contextFilePath = contextFilePath.replace(/\\/g, '/').replace(/^.*?(data\/)/, '$1')
      console.log(`  → Context written to ${contextFilePath}`)
    } catch {
      // Context file write failed — continue without it
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
    threadContext: contextFilePath ? undefined : threadContext, // Skip inline if written to file
    channelSystemPrompt,
    repoDir: options.repoDir,
    docsDir: options.docsDir,
    responseId,
    contextFile: contextFilePath,
  })

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

    // Unset CLAUDECODE to allow nested Claude invocation
    const env = { ...process.env }
    delete env.CLAUDECODE

    const proc = spawn('claude', args, {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'inherit', 'inherit'],
      env,
    })
    proc.stdin.end(prompt)
    await once(proc, 'exit')
  } catch (error: any) {
    console.warn(`  ✗ LLM investigation failed: ${error.message ?? error}`)
    throw new Error(`LLM investigation failed: ${error.message ?? error}`)
  }

  // Log investigation artifacts
  const findingsFile = join(responseDir, `${responseId}-findings.md`)
  const analysisFile = join(responseDir, `${responseId}-analysis.md`)
  try {
    await readFile(findingsFile, 'utf-8')
    console.log(`  → Findings captured: ${responseId}-findings.md`)
  } catch { /* findings file is optional */ }
  try {
    await readFile(analysisFile, 'utf-8')
    console.log(`  → Analysis captured: ${responseId}-analysis.md`)
  } catch { /* analysis file is optional */ }

  // Read the response file
  const responseFile = join(responseDir, `${responseId}.md`)
  let responseContent: string
  try {
    responseContent = await readFile(responseFile, 'utf-8')
  } catch {
    console.warn(`  ✗ No response file produced at ${responseFile}`)
    throw new Error(`No response file produced at ${responseFile}`)
  }

  const { body } = parseFrontMatter(responseContent)
  // Strip any LLM-generated feedback prompt to avoid duplicates
  const cleaned = body
    .replace(/-#\s*Was this helpful\?[^\n]*/gi, '')
    .replace(/Was this helpful\?\s*React with[^\n]*/gi, '')
    .trim()
  if (!cleaned) {
    console.warn(`  ✗ Response file is empty`)
    throw new Error('Response file is empty')
  }

  console.log(`  → Response ready (${cleaned.length} chars).`)

  if (options.dryRun) {
    console.log(`  → DRY RUN: would post response. Preview:`)
    console.log(`    ${formatMessagePreview(cleaned, 200)}`)
    return
  }

  // Post the response to Discord
  console.log(`  → Posting...`)
  try {
    const bodyWithFeedback = cleaned + FEEDBACK_PROMPT
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

    // In development guild, offer to post investigation to GitHub
    if (guildName === 'game-ci-develop' && lastMessageId) {
      try {
        const botReply = await message.channel.messages.fetch(lastMessageId)
        await botReply.react('📋').catch(() => {})
      } catch { /* non-critical */ }
    }

    console.log(`  ✓ Response posted to #${channelName} (reply to @${authorTag})`)
  } catch (error: any) {
    console.warn(`  ✗ Failed to post response: ${error.message ?? error}`)
  }
}

/**
 * Re-investigate a message after a 🔁 reaction.
 * Uses a stricter correction prompt that includes the previous (bad) response.
 */
async function reinvestigateAndRespond(
  originalMessage: Message,
  previousResponse: string,
  mapping: GuildMapping,
  channelConfig: ChannelConfig,
  options: LiveOptions,
  config: Record<string, unknown>,
  model: string,
): Promise<void> {
  const guildName = mapping.guildConfig.name
  const channelName = channelConfig.name
  const authorTag = originalMessage.author.tag ?? originalMessage.author.username
  const responseId = `reinvestigate-${guildName}-${channelName}-${originalMessage.id}-${Date.now()}`

  console.log(`  → Re-investigating @${authorTag}'s message in #${channelName}...`)

  const responseDir = join(RESPONSES_DIR, 'discord')
  await ensureDir(responseDir)

  // Fetch reply chain for context
  let replyChain: ReplyChainMessage[] = []
  try {
    replyChain = await fetchReplyChain(originalMessage)
  } catch { /* continue without */ }

  let contextFilePath: string | undefined
  if (replyChain.length > 0) {
    try {
      contextFilePath = await writeContextFile({
        responseId,
        responseDir,
        replyChain,
        triggerMessage: {
          author: authorTag,
          content: originalMessage.content,
          timestamp: originalMessage.createdAt.toISOString(),
          messageId: originalMessage.id,
        },
      })
      contextFilePath = contextFilePath.replace(/\\/g, '/').replace(/^.*?(data\/)/, '$1')
    } catch { /* continue without */ }
  }

  // Build correction-aware prompt
  const discordConfig = getValue(config, ['discord'], {} as Record<string, unknown>)
  const channelSystemPrompt = getSystemPrompt(discordConfig, mapping.guildConfig, channelConfig)

  const correctionNote = [
    `## Previous Response (REJECTED — received negative feedback)`,
    ``,
    `The following response was previously given but was downvoted or flagged for re-investigation:`,
    ``,
    `> ${previousResponse.replace(/\n/g, '\n> ').substring(0, 2000)}`,
    ``,
    `**Your task:** Investigate from scratch. Do NOT repeat the same answer. Verify every claim against source code. The previous response likely contained incorrect CLI syntax, wrong parameter names, or hallucinated information. Find the correct answer.`,
    ``,
  ].join('\n')

  const prompt = buildInvestigationPrompt({
    author: authorTag,
    content: originalMessage.content,
    responseId,
    source: { type: 'discord', guildName, channelName },
    systemPrompt: (channelSystemPrompt ? channelSystemPrompt + '\n\n' : '') + correctionNote,
    contextFile: contextFilePath,
    repoDir: options.repoDir,
    docsDir: options.docsDir,
    isFollowUp: true, // Always thorough for re-investigation
  })

  console.log(`  → LLM running (${model}) — correction mode...`)

  try {
    const args = ['-p', '--model', model, '--max-turns', '30']
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

    const env = { ...process.env }
    delete env.CLAUDECODE

    const proc = spawn('claude', args, {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'inherit', 'inherit'],
      env,
    })
    proc.stdin.end(prompt)
    await once(proc, 'exit')
  } catch (error: any) {
    console.warn(`  ✗ Re-investigation LLM failed: ${error.message ?? error}`)
    throw new Error(`Re-investigation LLM failed: ${error.message ?? error}`)
  }

  // Read the new response
  const responseFile = join(responseDir, `${responseId}.md`)
  let responseContent: string
  try {
    responseContent = await readFile(responseFile, 'utf-8')
  } catch {
    console.warn(`  ✗ No response file from re-investigation`)
    throw new Error('No response file from re-investigation')
  }

  const { body } = parseFrontMatter(responseContent)
  const cleaned = body
    .replace(/-#\s*Was this helpful\?[^\n]*/gi, '')
    .replace(/Was this helpful\?\s*React with[^\n]*/gi, '')
    .trim()
  if (!cleaned) {
    throw new Error('Re-investigation response is empty')
  }

  console.log(`  → Corrected response ready (${cleaned.length} chars).`)

  if (options.dryRun) {
    console.log(`  → DRY RUN: would post corrected response.`)
    return
  }

  // Post as a reply to the original message with a correction header
  try {
    const header = `**Corrected response** (previous answer was flagged for re-investigation):\n\n`
    const bodyWithFeedback = header + cleaned + FEEDBACK_PROMPT
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

    console.log(`  ✓ Corrected response posted to #${channelName} (reply to @${authorTag})`)
  } catch (error: any) {
    console.warn(`  ✗ Failed to post corrected response: ${error.message ?? error}`)
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

/**
 * Scan recent messages in monitored channels for any that were missed while offline.
 * Only processes messages not already responded to (state.json dedup).
 */
async function catchUpMissedMessages(
  client: Client,
  guildMappings: Map<string, GuildMapping>,
  options: LiveOptions,
  config: Record<string, unknown>,
  model: string,
  filters: { ignoreBots: boolean; ignorePrefixes: string[]; minMessageLength: number },
  since: Date,
): Promise<void> {
  const cutoff = since.getTime()
  const ago = Math.round((Date.now() - cutoff) / 60000)

  console.log('')
  console.log(`Catch-up: scanning messages since ${since.toISOString()} (${ago}m ago)...`)

  let total = 0
  let eligible = 0

  for (const [guildId, mapping] of guildMappings) {
    const discordGuild = client.guilds.cache.get(guildId)
    if (!discordGuild) continue

    for (const [channelId, channelConfig] of mapping.channelMap) {
      if (channelConfig.monitor === false) continue

      const channel = discordGuild.channels.cache.get(channelId)
      if (!channel || !channel.isTextBased() || !('messages' in channel)) continue

      try {
        const messages = await channel.messages.fetch({ limit: 50 })
        const sorted = [...messages.values()]
          .filter((m) => m.createdTimestamp >= cutoff)
          .sort((a, b) => a.createdTimestamp - b.createdTimestamp)

        for (const message of sorted) {
          total++

          // Same filters as the live handler
          if (filters.ignoreBots && message.author.bot) continue

          // Only process @mentions or replies to the bot
          const botId = client.user?.id
          const isMentioned = botId ? message.mentions.users.has(botId) : false
          const isReplyToBot = message.reference?.messageId
            ? await channel.messages.fetch(message.reference.messageId)
                .then((ref) => ref.author.id === botId)
                .catch(() => false)
            : false
          if (!isMentioned && !isReplyToBot) continue

          const content = message.content.trim()
          if (filters.ignorePrefixes.some((p) => content.startsWith(p))) continue

          // Dedup: check state
          const state = await loadState()
          const posted = getPostedDiscordResponses(state)
          const guildName = mapping.guildConfig.name
          const channelName = channelConfig.name
          const responseKey = `discord:${guildName}/${channelName}#${message.id}`
          if (posted[responseKey]) continue

          // Already processing
          if (processingMessages.has(message.id)) continue

          eligible++
          const authorTag = message.author.tag ?? message.author.username
          const preview = formatMessagePreview(content)
          console.log(`  [catch-up] #${channelName} @${authorTag}: ${preview}`)
          console.log(`    → Investigating...`)

          processingMessages.add(message.id)
          setInvestigatingStatus(client, channelName, authorTag)
          await message.react('🔍').catch(() => {})
          try {
            await investigateAndRespond(message, mapping, channelConfig, options, config, model)
            await message.reactions.cache.get('🔍')?.users.remove(client.user!.id).catch(() => {})
            await message.react('✅').catch(() => {})
          } catch {
            await message.reactions.cache.get('🔍')?.users.remove(client.user!.id).catch(() => {})
            await message.react('❌').catch(() => {})
          } finally {
            processingMessages.delete(message.id)
            clearInvestigatingStatus(client)
          }
        }
      } catch (err: any) {
        console.warn(`  Catch-up: failed to fetch #${channelConfig.name}: ${err.message ?? err}`)
      }
    }
  }

  if (eligible > 0) {
    console.log(`Catch-up complete: ${eligible} messages processed out of ${total} scanned.`)
  } else {
    console.log(`Catch-up complete: no missed messages found (${total} scanned).`)
  }
  console.log('─'.repeat(50))
}
