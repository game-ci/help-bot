import {
  Client,
  GatewayIntentBits,
  Events,
  Message,
  ChannelType,
  ActivityType,
  Attachment,
  InteractionType,
  type TextChannel,
} from 'discord.js'
import { spawn, execSync } from 'node:child_process'
import { once } from 'node:events'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  getConfig,
  getValue,
  resolveGuilds,
  resolveGuildId,
  getSystemPrompt,
  GuildConfig,
  ChannelConfig,
  reloadConfig,
  saveConfig,
} from '../config'
import {
  updateState,
  setPostedDiscordResponse,
  loadState,
  getPostedDiscordResponses,
  getLastOnlineAt,
  getFirstOnlineAt,
  setLastOnlineAt,
  getTriageRecord,
  setTriageRecord,
  setContentRecord,
} from '../state'
import { ensureDir } from '../utils/fs'
import { REPO_ROOT, RESPONSES_DIR, DATA_DIR } from '../utils/paths'
import { parseFrontMatter } from '../utils/frontmatter'
import {
  isMonitoredChannel,
  formatMessagePreview,
  buildSingleMessagePrompt,
  buildInvestigationPrompt,
  formatTime,
  writeContextFile,
  ReplyChainMessage,
} from './live-utils'
import {
  handleTriageInteraction,
  postTriageNotification,
  discordCompactId,
  githubCompactId,
  type TriageHandlerContext,
} from '../triage'
import { handleSocialRequest, handleSocialInteraction, type SocialHandlerContext } from '../social'
import { buildContentId, type ContentRecord } from '../social/types'
import { postContentNotification } from '../social/notification'
import { syncGitHub } from '../sync/github'
import { filterIssues, type EligibleIssue } from './filter-issues'
import { resolveClaude } from '../utils/claude'
import { initLogger, logInfo, logWarn, logError } from '../utils/logger'
import { syncDataToGitHub } from '../sync/data-backup'

const DISCORD_API = 'https://discord.com/api/v10'
const MAX_DISCORD_LENGTH = 2000
const FEEDBACK_PROMPT =
  '\n\n-# Was this helpful? React :thumbsup: or :thumbsdown: | React :repeat: to request a re-investigation'

// --- Status management ---
let idleStatusText = 'help requests'
let activeInvestigations = 0

function setIdleStatus(client: Client): void {
  client.user?.setPresence({
    status: 'online',
    activities: [
      {
        name: idleStatusText,
        type: ActivityType.Watching,
      },
    ],
  })
}

function setInvestigatingStatus(client: Client, channelName: string, author: string): void {
  activeInvestigations++
  const suffix = activeInvestigations > 1 ? ` (+${activeInvestigations - 1} more)` : ''
  client.user?.setPresence({
    status: 'dnd',
    activities: [
      {
        name: `@${author} in #${channelName}${suffix}`,
        type: ActivityType.Custom,
        state: `Investigating @${author} in #${channelName}${suffix}`,
      },
    ],
  })
}

function clearInvestigatingStatus(client: Client): void {
  activeInvestigations = Math.max(0, activeInvestigations - 1)
  if (activeInvestigations === 0) {
    setIdleStatus(client)
  }
}

// --- Deploy changelog ---
const DEPLOY_SHA_FILE = join(DATA_DIR, 'last-deploy-sha.txt')

/** Get version string from git: tag + commits since tag + short sha */
function getGitVersion(): string {
  try {
    return execSync('git describe --tags --always', { cwd: REPO_ROOT, encoding: 'utf-8' }).trim()
  } catch {
    try {
      return execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT, encoding: 'utf-8' }).trim()
    } catch {
      return 'unknown'
    }
  }
}

/** Post deploy changelog to triage channels (idempotent — saves SHA before posting) */
async function postDeployChangelog(
  triageChannels: Map<string, TextChannel>,
  botName: string,
): Promise<void> {
  try {
    const currentSha = execSync('git rev-parse HEAD', { cwd: REPO_ROOT, encoding: 'utf-8' }).trim()
    let lastSha = ''
    try {
      lastSha = (await readFile(DEPLOY_SHA_FILE, 'utf-8')).trim()
    } catch {
      // First deploy — no previous SHA
    }
    if (lastSha === currentSha) return // Same deploy, skip

    // Save SHA immediately so restarts don't re-post
    await ensureDir(DATA_DIR)
    await writeFile(DEPLOY_SHA_FILE, currentSha, 'utf-8')

    const version = getGitVersion()
    const shortSha = currentSha.substring(0, 7)

    // Get commits since last deploy
    let commitList = ''
    if (lastSha) {
      try {
        const log = execSync(`git log ${lastSha}..HEAD --oneline --no-decorate`, {
          cwd: REPO_ROOT,
          encoding: 'utf-8',
        }).trim()
        if (log) {
          const commits = log.split('\n').slice(0, 15)
          commitList = commits.map((c) => `- \`${c}\``).join('\n')
        }
      } catch {
        // lastSha might not exist in history (force push, etc.)
      }
    }

    const lines = [`**${botName} ${version}** deployed (\`${shortSha}\`)`]
    if (commitList) {
      lines.push('', commitList)
    }
    lines.push(
      '',
      '**Commands:** `!status` `!channels` `!settings` `!channel` `!config` `!sync-data` `!help` | `/ask` `/post` | `@bot social <topic>`',
    )

    const msg = lines.join('\n')
    for (const [, ch] of triageChannels) {
      await ch
        .send(msg)
        .catch((e: any) => console.warn(`  Failed to post changelog: ${e.message ?? e}`))
    }
    console.log(`  Deploy changelog posted (${version}, ${shortSha})`)
  } catch (err: any) {
    console.warn(`  Deploy changelog failed: ${err.message ?? err}`)
  }
}

/** Commit config.json and push to main so changes persist and deploy. */
async function commitAndPushConfig(description: string): Promise<string> {
  const execOpts = { cwd: REPO_ROOT, encoding: 'utf-8' as const }
  try {
    execSync('git add config.json', execOpts)
    execSync(
      `git commit -m "config: ${description}\n\nCo-Authored-By: GameCI Help Bot <help-bot@game.ci>"`,
      execOpts,
    )
    execSync('git pull --rebase origin main', execOpts)
    execSync('git push origin main', execOpts)
    return 'Pushed to main. Deploy will trigger automatically.'
  } catch (err: any) {
    return `Push failed: ${err.message ?? err}`
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
  initLogger({ logDir: join(REPO_ROOT, 'logs') })
  const config = await getConfig()
  const botConfig = getValue(config, ['bot'], {} as Record<string, unknown>)
  const botName = getValue(botConfig, ['name'], 'GameCI Help Bot') as string
  const botVersion = getValue(botConfig, ['version'], '3.0.0') as string
  const discordConfig = getValue(config, ['discord'], {} as Record<string, unknown>)
  const guilds = resolveGuilds(discordConfig)
  const dispatchConfig = getValue(config, ['dispatch'], {} as Record<string, unknown>)
  const dispatchMode =
    options.dispatchMode ?? (getValue(dispatchConfig, ['discord_mode'], 'auto') as string)
  const llmModel =
    options.modelOverride ??
    (getValue(config, ['llm', 'claude', 'model'], 'claude-sonnet-4-20250514') as string)
  const ignoreBots = Boolean(getValue(discordConfig, ['ignore_bots'], true))
  const ignorePrefixes = getValue(
    discordConfig,
    ['ignore_prefixes'],
    ['!', '/', '$', '.'],
  ) as string[]
  const githubTriage = Boolean(getValue(config, ['dispatch', 'github_triage'], false))
  const githubPollMinutes = Number(
    getValue(config, ['dispatch', 'github_poll_interval_minutes'], 10),
  )
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
    setInvestigating: (channelName: string, author: string) =>
      setInvestigatingStatus(client, channelName, author),
    clearInvestigating: () => clearInvestigatingStatus(client),
  }

  const socialHandlerContext: SocialHandlerContext = {
    config,
    model: llmModel,
    collaborators: collaborators as string[],
    triageUserIds: triageUserIds as string[],
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
        // Build channel map from actual Discord channels (by name match)
        for (const [, channel] of discordGuild.channels.cache) {
          if (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildForum) {
            const channelConfig = mapping.channelNameMap.get(channel.name)
            if (channelConfig) {
              mapping.channelMap.set(channel.id, channelConfig)
            }
          }
        }
        // Also index channels by explicit channel_id (overrides name-based resolution)
        for (const ch of mapping.guildConfig.channels) {
          if (ch.channel_id) {
            mapping.channelMap.set(ch.channel_id, ch)
          }
        }

        const monitoredChannels = [...mapping.channelNameMap.entries()]
          .filter(([, ch]) => ch.monitor !== false)
          .map(([name]) => `#${name}`)
        console.log(
          `  ✓ ${mapping.guildConfig.name} — monitoring: ${monitoredChannels.join(', ') || '(none)'}`,
        )
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
        const crossGuild =
          targetGuild !== mapping.guildConfig.name ? ` (cross-guild → ${targetGuild})` : ''
        console.log(`  ✓ Triage channel: #${chName} for ${mapping.guildConfig.name}${crossGuild}`)
      } else {
        console.warn(
          `  ⚠ Triage channel ${triageChannelId} not found for ${mapping.guildConfig.name}`,
        )
      }
    }

    // --- Register guild-scoped slash commands (avoids DM permission issues) ---
    const slashCommands = [
      {
        name: 'ask',
        description: 'Ask the help bot a question (sent to triage for investigation)',
        options: [
          {
            name: 'question',
            description: 'Your question about GameCI, Unity CI/CD, Docker, etc.',
            type: 3, // STRING
            required: true,
          },
        ],
      },
      {
        name: 'post',
        description: 'Draft a social media post or community announcement',
        options: [
          {
            name: 'topic',
            description:
              'What the post should be about (feature, release, tip, announcement, etc.)',
            type: 3, // STRING
            required: true,
          },
        ],
      },
      {
        name: 'help',
        description: 'Show bot info, available commands, and how to get help',
      },
    ]

    const registerSlashCommands = async () => {
      try {
        // Clear stale global commands (we now use guild-scoped commands)
        if (readyClient.application) {
          const globalCmds = await readyClient.application.commands.fetch()
          if (globalCmds.size > 0) {
            console.log(
              `  Clearing ${globalCmds.size} stale global command(s): ${globalCmds.map((c) => `/${c.name}`).join(', ')}`,
            )
            await readyClient.application.commands.set([])
          }
        }

        // Register commands per guild so they appear immediately and don't require DM scope
        for (const [guildId] of guildMappings) {
          const discordGuild = readyClient.guilds.cache.get(guildId)
          if (!discordGuild) continue
          await discordGuild.commands.set(slashCommands)
          console.log(`  ✓ Registered /ask, /post, /help in ${discordGuild.name}`)
        }
      } catch (err: any) {
        console.warn(`  ⚠ Failed to register slash commands: ${err.message ?? err}`)
      }
    }
    registerSlashCommands()

    // --- Post deploy changelog ---
    postDeployChangelog(triageChannels, botName).catch(() => {})

    // Set bot presence/status
    const monitoredCount = [...guildMappings.values()].reduce(
      (acc, m) => acc + [...m.channelNameMap.values()].filter((ch) => ch.monitor !== false).length,
      0,
    )
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
        console.log(
          `First run — stamping firstOnlineAt. Will never process messages before this point.`,
        )
        await updateState((s) => setLastOnlineAt(s))
      } else if (dispatchMode === 'auto') {
        const cutoff = new Date(lastOnline)
        console.log(`Last online: ${cutoff.toISOString()} — catching up from there.`)
        await catchUpMissedMessages(
          readyClient,
          guildMappings,
          options,
          config,
          llmModel,
          {
            ignoreBots,
            ignorePrefixes,
            minMessageLength,
          },
          cutoff,
        )
        await updateState((s) => setLastOnlineAt(s))
      } else {
        await updateState((s) => setLastOnlineAt(s))
      }

      // Heartbeat: update lastOnlineAt every 5 minutes so restarts know the gap
      setInterval(
        async () => {
          await updateState((s) => setLastOnlineAt(s)).catch(() => {})
        },
        5 * 60 * 1000,
      )

      // GitHub triage polling (opt-in)
      if (githubTriage && dispatchMode === 'triage' && triageChannels.size > 0) {
        // Run an initial poll after a short delay, then on interval
        setTimeout(
          () =>
            pollGitHubForTriage().catch((e) =>
              console.warn(`  GitHub poll error: ${e.message ?? e}`),
            ),
          15_000,
        )
        setInterval(
          () =>
            pollGitHubForTriage().catch((e) =>
              console.warn(`  GitHub poll error: ${e.message ?? e}`),
            ),
          githubPollMinutes * 60 * 1000,
        )
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
    let channelConfig =
      mapping.channelMap.get(message.channelId) ?? mapping.channelNameMap.get(channelName)

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

    // --- Triage channel commands (! prefix, + prefix, or @mention) ---
    // The triage channel is not a "monitored" channel, so handle commands here before the filter
    const triageCh = triageChannels.get(message.guild.id)
    if (triageCh && message.channelId === triageCh.id) {
      if (message.author.bot) return
      const raw = message.content.trim()
      const botId0 = client.user?.id
      const isMentionCmd = botId0 && message.mentions.users.has(botId0)
      const isPrefixCmd = raw.startsWith('!') || raw.startsWith('+')
      if (!isMentionCmd && !isPrefixCmd) return // Not a command → drop
      // Extract command text: strip @mentions and prefix
      let stripped = raw.replace(/<@!?\d+>/g, '').trim()
      if (stripped.startsWith('!') || stripped.startsWith('+')) stripped = stripped.slice(1).trim()
      stripped = stripped.toLowerCase()
      const userId = message.author.id
      const username = message.author.username
      const isCollab = collaborators.some((c: string) => c.toLowerCase() === username.toLowerCase())
      const isTriage = triageUserIds.includes(userId)
      {
        if (isCollab || isTriage) {
          if (stripped === 'status') {
            const st = await loadState()
            const lastOnline = getLastOnlineAt(st)
            const firstOnline = getFirstOnlineAt(st)
            const uptime = process.uptime()
            const h = Math.floor(uptime / 3600)
            const m = Math.floor((uptime % 3600) / 60)
            const lines = [
              `**${getValue(botConfig, ['name'], 'GameCI Help Bot')} v${getValue(botConfig, ['version'], '3.0.0')}**`,
              `Dispatch mode: \`${dispatchMode}\``,
              `Model: \`${llmModel}\``,
              `Uptime: ${h}h ${m}m`,
              `First online: ${firstOnline ?? 'unknown'}`,
              `Last heartbeat: ${lastOnline ?? 'unknown'}`,
              `Claude CLI: \`${resolveClaude()}\``,
            ]
            await message
              .reply({ content: lines.join('\n'), allowedMentions: { repliedUser: false } })
              .catch(() => {})
            return
          }
          if (stripped === 'channels') {
            const lines: string[] = ['**Guilds & Monitored Channels:**']
            for (const [gId, gm] of guildMappings) {
              const dGuild = client.guilds.cache.get(gId)
              const status = dGuild ? 'online' : 'not in server'
              lines.push(`\n**${gm.guildConfig.name}** (${status})`)
              for (const ch of gm.guildConfig.channels ?? []) {
                const mon = ch.monitor !== false ? 'monitoring' : 'not monitored'
                const typ = ch.channel_type ?? 'text'
                lines.push(`  \`#${ch.name}\` — ${typ}, ${mon}`)
              }
            }
            await message
              .reply({ content: lines.join('\n'), allowedMentions: { repliedUser: false } })
              .catch(() => {})
            return
          }
          if (stripped === 'settings') {
            const dc = getValue(config, ['dispatch'], {} as Record<string, unknown>)
            const gc = getValue(config, ['github'], {} as Record<string, unknown>)
            const lc = getValue(config, ['llm'], {} as Record<string, unknown>)
            const lines = [
              '**Current Settings:**',
              `Dispatch mode: \`${getValue(dc, ['mode'], 'auto')}\``,
              `Discord dispatch: \`${getValue(dc, ['discord_mode'], 'auto')}\``,
              `GitHub triage: \`${getValue(dc, ['github_triage'], false)}\``,
              `Poll interval: \`${getValue(dc, ['github_poll_interval_minutes'], 10)}\` min`,
              `Model: \`${getValue(lc, ['claude', 'model'], 'claude-sonnet-4-20250514')}\``,
              `Max turns: \`${getValue(lc, ['claude', 'max_turns'], 25)}\``,
              `Repos: ${(getValue(gc, ['repos'], []) as string[]).map((r) => `\`${r}\``).join(', ')}`,
            ]
            await message
              .reply({ content: lines.join('\n'), allowedMentions: { repliedUser: false } })
              .catch(() => {})
            return
          }
          if (stripped === 'sync-data') {
            await message
              .reply({
                content: 'Syncing data to GitHub...',
                allowedMentions: { repliedUser: false },
              })
              .catch(() => {})
            try {
              const result = await syncDataToGitHub()
              await message
                .reply({ content: `Data sync: ${result}`, allowedMentions: { repliedUser: false } })
                .catch(() => {})
            } catch (err: any) {
              await message
                .reply({
                  content: `Data sync failed: ${err.message ?? err}`,
                  allowedMentions: { repliedUser: false },
                })
                .catch(() => {})
            }
            return
          }
          // --- Channel management commands ---
          if (stripped.startsWith('channel ')) {
            const parts = stripped.slice('channel '.length).trim().split(/\s+/)
            const sub = parts[0]

            // Helper: find guild config by name (case-insensitive)
            const findGuild = (name: string) => {
              const dc = getValue(config, ['discord'], {} as Record<string, unknown>)
              const gs = dc['guilds'] as GuildConfig[] | undefined
              if (!gs) return undefined
              return gs.find((g: GuildConfig) => g.name.toLowerCase() === name.toLowerCase())
            }

            // Helper: rebuild in-memory guild mappings after config change
            const refreshMappings = () => {
              const dc = getValue(config, ['discord'], {} as Record<string, unknown>)
              const freshGuilds = resolveGuilds(dc)
              for (const guild of freshGuilds) {
                const gId = resolveGuildId(guild)
                if (!gId) continue
                const existing = guildMappings.get(gId)
                if (existing) {
                  existing.guildConfig = guild
                  existing.channelNameMap.clear()
                  existing.channelMap.clear()
                  for (const ch of guild.channels) {
                    existing.channelNameMap.set(ch.name, ch)
                  }
                  // Re-resolve channel IDs from cache
                  const dGuild = client.guilds.cache.get(gId)
                  if (dGuild) {
                    for (const [, channel] of dGuild.channels.cache) {
                      if (
                        channel.type === ChannelType.GuildText ||
                        channel.type === ChannelType.GuildForum
                      ) {
                        const chCfg = existing.channelNameMap.get(channel.name)
                        if (chCfg) existing.channelMap.set(channel.id, chCfg)
                      }
                    }
                  }
                }
              }
            }

            // !channel list <guild>
            if (sub === 'list') {
              const guildName = parts.slice(1).join(' ')
              if (!guildName) {
                await message
                  .reply({
                    content: 'Usage: `!channel list <guild-name>`',
                    allowedMentions: { repliedUser: false },
                  })
                  .catch(() => {})
                return
              }
              const guild = findGuild(guildName)
              if (!guild) {
                await message
                  .reply({
                    content: `Guild "${guildName}" not found in config.`,
                    allowedMentions: { repliedUser: false },
                  })
                  .catch(() => {})
                return
              }
              const lines = [`**Channels for ${guild.name}:**`]
              for (const ch of guild.channels) {
                const props = [
                  ch.channel_type ?? 'text',
                  ch.monitor !== false ? 'monitoring' : 'not monitored',
                  ch.read_threads !== false ? 'threads' : 'no threads',
                  ch.reply_mode ?? 'bot_api',
                  `trigger: ${ch.trigger_mode ?? 'mention'}`,
                ]
                if (ch.channel_id) props.push(`id: ${ch.channel_id}`)
                lines.push(`\`#${ch.name}\` — ${props.join(', ')}`)
                if (ch.system_prompt)
                  lines.push(
                    `  *prompt:* ${ch.system_prompt.substring(0, 100)}${ch.system_prompt.length > 100 ? '...' : ''}`,
                  )
              }
              await message
                .reply({ content: lines.join('\n'), allowedMentions: { repliedUser: false } })
                .catch(() => {})
              return
            }

            // !channel set <guild> <channel> <key> <value>
            if (sub === 'set') {
              if (parts.length < 5) {
                await message
                  .reply({
                    content:
                      'Usage: `!channel set <guild> <channel> <key> <value>`\nKeys: `monitor`, `read_threads`, `channel_type`, `reply_mode`, `system_prompt`',
                    allowedMentions: { repliedUser: false },
                  })
                  .catch(() => {})
                return
              }
              const guildName = parts[1]
              const channelName = parts[2]
              const key = parts[3]
              const value = parts.slice(4).join(' ')
              const guild = findGuild(guildName)
              if (!guild) {
                await message
                  .reply({
                    content: `Guild "${guildName}" not found.`,
                    allowedMentions: { repliedUser: false },
                  })
                  .catch(() => {})
                return
              }
              const ch = guild.channels.find(
                (c: ChannelConfig) => c.name.toLowerCase() === channelName.toLowerCase(),
              )
              if (!ch) {
                await message
                  .reply({
                    content: `Channel "${channelName}" not found in guild "${guild.name}".`,
                    allowedMentions: { repliedUser: false },
                  })
                  .catch(() => {})
                return
              }
              const validKeys = [
                'monitor',
                'read_threads',
                'channel_type',
                'reply_mode',
                'system_prompt',
                'channel_id',
                'trigger_mode',
              ]
              if (!validKeys.includes(key)) {
                await message
                  .reply({
                    content: `Invalid key "${key}". Valid keys: ${validKeys.map((k) => `\`${k}\``).join(', ')}`,
                    allowedMentions: { repliedUser: false },
                  })
                  .catch(() => {})
                return
              }
              // Parse booleans
              let parsed: unknown = value
              if (value === 'true') parsed = true
              else if (value === 'false') parsed = false
              ;(ch as any)[key] = parsed
              await saveConfig()
              refreshMappings()
              const pushResult = await commitAndPushConfig(
                `${key}=${value} for #${ch.name} in ${guild.name}`,
              )
              await message
                .reply({
                  content: `Updated \`#${ch.name}\` → \`${key}\` = \`${value}\`\n${pushResult}`,
                  allowedMentions: { repliedUser: false },
                })
                .catch(() => {})
              return
            }

            // !channel add <guild> <channel-name> [channel_type]
            if (sub === 'add') {
              if (parts.length < 3) {
                await message
                  .reply({
                    content: 'Usage: `!channel add <guild> <channel-name> [text|forum]`',
                    allowedMentions: { repliedUser: false },
                  })
                  .catch(() => {})
                return
              }
              const guildName = parts[1]
              const channelName = parts[2]
              const channelType = (parts[3] ?? 'text') as 'text' | 'forum'
              const guild = findGuild(guildName)
              if (!guild) {
                await message
                  .reply({
                    content: `Guild "${guildName}" not found.`,
                    allowedMentions: { repliedUser: false },
                  })
                  .catch(() => {})
                return
              }
              if (
                guild.channels.find(
                  (c: ChannelConfig) => c.name.toLowerCase() === channelName.toLowerCase(),
                )
              ) {
                await message
                  .reply({
                    content: `Channel "${channelName}" already exists in guild "${guild.name}".`,
                    allowedMentions: { repliedUser: false },
                  })
                  .catch(() => {})
                return
              }
              const newCh: ChannelConfig = {
                name: channelName,
                channel_type: channelType,
                reply_mode: 'bot_api',
                read_threads: true,
                monitor: true,
              }
              guild.channels.push(newCh)
              await saveConfig()
              refreshMappings()
              const pushResult = await commitAndPushConfig(`add #${channelName} to ${guild.name}`)
              await message
                .reply({
                  content: `Added \`#${channelName}\` (${channelType}, monitored) to **${guild.name}**\n${pushResult}`,
                  allowedMentions: { repliedUser: false },
                })
                .catch(() => {})
              return
            }

            // !channel remove <guild> <channel-name>
            if (sub === 'remove') {
              if (parts.length < 3) {
                await message
                  .reply({
                    content: 'Usage: `!channel remove <guild> <channel-name>`',
                    allowedMentions: { repliedUser: false },
                  })
                  .catch(() => {})
                return
              }
              const guildName = parts[1]
              const channelName = parts[2]
              const guild = findGuild(guildName)
              if (!guild) {
                await message
                  .reply({
                    content: `Guild "${guildName}" not found.`,
                    allowedMentions: { repliedUser: false },
                  })
                  .catch(() => {})
                return
              }
              const idx = guild.channels.findIndex(
                (c: ChannelConfig) => c.name.toLowerCase() === channelName.toLowerCase(),
              )
              if (idx === -1) {
                await message
                  .reply({
                    content: `Channel "${channelName}" not found in guild "${guild.name}".`,
                    allowedMentions: { repliedUser: false },
                  })
                  .catch(() => {})
                return
              }
              guild.channels.splice(idx, 1)
              await saveConfig()
              refreshMappings()
              const pushResult = await commitAndPushConfig(
                `remove #${channelName} from ${guild.name}`,
              )
              await message
                .reply({
                  content: `Removed \`#${channelName}\` from **${guild.name}**\n${pushResult}`,
                  allowedMentions: { repliedUser: false },
                })
                .catch(() => {})
              return
            }

            // Unknown subcommand
            await message
              .reply({
                content:
                  '**Channel commands:**\n`!channel list <guild>` — Show channel details\n`!channel set <guild> <channel> <key> <value>` — Update a channel property\n`!channel add <guild> <channel> [text|forum]` — Add a new channel\n`!channel remove <guild> <channel>` — Remove a channel',
                allowedMentions: { repliedUser: false },
              })
              .catch(() => {})
            return
          }

          // --- Config management commands ---
          if (stripped.startsWith('config ')) {
            const parts = stripped.slice('config '.length).trim().split(/\s+/)
            const sub = parts[0]

            if (sub === 'get') {
              const path = parts.slice(1).join('.').split('.')
              if (path.length === 0 || !path[0]) {
                await message
                  .reply({
                    content: 'Usage: `!config get <key.path>` (e.g. `!config get dispatch.mode`)',
                    allowedMentions: { repliedUser: false },
                  })
                  .catch(() => {})
                return
              }
              const val = getValue(config, path, undefined as unknown)
              const display =
                val === undefined
                  ? '(not set)'
                  : typeof val === 'object'
                    ? '```json\n' + JSON.stringify(val, null, 2) + '\n```'
                    : `\`${val}\``
              await message
                .reply({
                  content: `**${path.join('.')}** = ${display}`,
                  allowedMentions: { repliedUser: false },
                })
                .catch(() => {})
              return
            }

            if (sub === 'set') {
              if (parts.length < 3) {
                await message
                  .reply({
                    content:
                      'Usage: `!config set <key.path> <value>` (e.g. `!config set dispatch.mode triage`)',
                    allowedMentions: { repliedUser: false },
                  })
                  .catch(() => {})
                return
              }
              const keyPath = parts[1].split('.')
              const rawValue = parts.slice(2).join(' ')

              // Navigate to parent and set the value
              let current: any = config
              for (let i = 0; i < keyPath.length - 1; i++) {
                if (!current[keyPath[i]] || typeof current[keyPath[i]] !== 'object') {
                  current[keyPath[i]] = {}
                }
                current = current[keyPath[i]]
              }
              const lastKey = keyPath[keyPath.length - 1]

              // Parse value types
              let parsed: unknown = rawValue
              if (rawValue === 'true') parsed = true
              else if (rawValue === 'false') parsed = false
              else if (/^\d+$/.test(rawValue)) parsed = Number(rawValue)

              current[lastKey] = parsed
              await saveConfig()
              await message
                .reply({
                  content: `Set \`${parts[1]}\` = \`${rawValue}\``,
                  allowedMentions: { repliedUser: false },
                })
                .catch(() => {})
              return
            }

            if (sub === 'sync') {
              const pushResult = await commitAndPushConfig('config sync from Discord')
              await message
                .reply({ content: pushResult, allowedMentions: { repliedUser: false } })
                .catch(() => {})
              return
            }

            if (sub === 'reload') {
              await reloadConfig()
              await message
                .reply({
                  content: 'Config reloaded from disk.',
                  allowedMentions: { repliedUser: false },
                })
                .catch(() => {})
              return
            }

            await message
              .reply({
                content:
                  '**Config commands:**\n`!config get <key.path>` — Read a config value\n`!config set <key.path> <value>` — Set a config value\n`!config sync` — Commit & push config to repo\n`!config reload` — Reload config from disk',
                allowedMentions: { repliedUser: false },
              })
              .catch(() => {})
            return
          }

          if (stripped === 'help') {
            const lines = [
              '**Triage commands** (`!` or `+` prefix):',
              '`!status` — Bot uptime, version, dispatch mode',
              '`!channels` — List monitored guilds and channels',
              '`!settings` — Show current configuration',
              '`!sync-data` — Sync data to private GitHub repo',
              '`!channel list|set|add|remove` — Manage channel config',
              '`!config get|set|sync|reload` — Manage bot configuration',
              '`!help` — This message',
              '',
              '**Slash commands:**',
              '`/ask <question>` — Submit a help question for triage',
              '`/post <topic>` — Draft a social media post on a topic',
              '',
              '**In any monitored channel:**',
              '`@bot <question>` — Ask a help question (sent to triage)',
              '`@bot social <topic>` — Draft a LinkedIn post on a topic',
            ]
            await message
              .reply({ content: lines.join('\n'), allowedMentions: { repliedUser: false } })
              .catch(() => {})
            return
          }
        }
      }
      return // All triage channel messages that aren't commands get dropped
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

    // Determine trigger mode: 'all' means every message triggers pipeline, 'mention' (default) requires @mention
    const triggerMode = channelConfig.trigger_mode ?? 'mention'
    const botId = client.user?.id
    const isMentioned = botId ? message.mentions.users.has(botId) : false
    const isReplyToBot = message.reference?.messageId
      ? await message.channel.messages
          .fetch(message.reference.messageId)
          .then((ref) => ref.author.id === botId)
          .catch(() => false)
      : false

    if (triggerMode === 'mention' && !isMentioned && !isReplyToBot) {
      return
    }

    // For trigger_mode:'all', apply additional filters to reduce noise
    if (triggerMode === 'all' && !isMentioned && !isReplyToBot) {
      // Skip very short messages (likely greetings, reactions, etc.)
      if (message.content.trim().length < minMessageLength) return
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

    // --- Social content trigger: "@bot social <topic>" ---
    const socialEnabled = getValue(config, ['social', 'enabled'], false)
    if (socialEnabled) {
      // Strip the @mention and check for "social" keyword
      const stripped = content.replace(/<@!?\d+>/g, '').trim()
      const socialMatch = stripped.match(/^social\s+(.+)/is)
      if (socialMatch) {
        const topic = socialMatch[1].trim()
        if (topic.length > 0) {
          // Find the triage channel for this guild
          const triageCh = triageChannels.get(message.guild!.id)
          if (triageCh) {
            console.log(`  → Social content request: "${topic.substring(0, 80)}"`)
            await handleSocialRequest(message, topic, triageCh, socialHandlerContext)
          } else {
            await message
              .reply({
                content: 'No triage channel configured for social content.',
                allowedMentions: { repliedUser: false },
              })
              .catch(() => {})
          }
          return
        }
      }
    }

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

    const triggerLabel = isMentioned ? '@mention' : isReplyToBot ? 'reply' : 'message'
    console.log(`  → Responding to ${triggerLabel}...`)

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
        await message.reactions.cache
          .get('🔍')
          ?.users.remove(client.user!.id)
          .catch(() => {})
        await message.react('✅').catch(() => {})
      } catch (err) {
        // Replace 🔍 with ❌ on failure
        await message.reactions.cache
          .get('🔍')
          ?.users.remove(client.user!.id)
          .catch(() => {})
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
        const ackEnabled =
          getValue(config, ['triage', 'acknowledge_user'], true as boolean) !== false
        if (ackEnabled) {
          await message
            .reply({
              content:
                'Your question has been received and is queued for investigation. A maintainer will review it shortly.',
              allowedMentions: { repliedUser: false },
            })
            .catch(() => {})
        }
        console.log(
          `  → Triage notification posted to #${'name' in triageChannel ? triageChannel.name : 'triage'}`,
        )
      } catch (err: any) {
        console.warn(`  → Failed to post triage notification: ${err.message ?? err}`)
      }
    } else {
      // Approval / countdown mode: log and defer
      console.log(`  → Dispatch mode is "${dispatchMode}" — message queued for next cycle.`)
      console.log(`    Run "gameci-help-bot cycle" to create detection issues and check approvals.`)
    }
  })

  // --- Interaction handler (slash commands + triage/social buttons) ---
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      // Handle /help slash command — info for everyone, extra details for admins
      if (interaction.isChatInputCommand() && interaction.commandName === 'help') {
        const userId = interaction.user.id
        const username = interaction.user.username
        const isCollaborator = (collaborators as string[]).some(
          (c: string) => c.toLowerCase() === username.toLowerCase(),
        )
        const isTriageUser = (triageUserIds as string[]).includes(userId)
        const isAdmin = isCollaborator || isTriageUser

        const lines: string[] = [
          `**${botName} v${botVersion}**`,
          '',
          'I help with GameCI, Unity CI/CD, Docker, and build automation questions.',
          '',
          '**Commands:**',
          '`/ask <question>` — Submit a help question for investigation',
          '`/help` — Show this message',
        ]

        const socialEnabled = getValue(config, ['social', 'enabled'], false)
        if (socialEnabled && isAdmin) {
          lines.push('`/post <topic>` — Draft a social media post (maintainers)')
        }

        lines.push('', '**In any monitored channel:**', '`@bot <question>` — Ask a help question')

        if (isAdmin) {
          const uptime = process.uptime()
          const h = Math.floor(uptime / 3600)
          const m = Math.floor((uptime % 3600) / 60)

          lines.push(
            '',
            '---',
            '**Admin Info:**',
            `Dispatch: \`${dispatchMode}\` | Model: \`${llmModel}\``,
            `Uptime: ${h}h ${m}m | Claude: \`${resolveClaude()}\``,
          )

          // Inline channel list
          lines.push('', '**Guilds & Channels:**')
          for (const [gId, gm] of guildMappings) {
            const dGuild = client.guilds.cache.get(gId)
            const status = dGuild ? 'online' : 'not in server'
            lines.push(`**${gm.guildConfig.name}** (${status})`)
            for (const ch of gm.guildConfig.channels ?? []) {
              const mon = ch.monitor !== false ? 'monitoring' : 'not monitored'
              const typ = ch.channel_type ?? 'text'
              lines.push(`  \`#${ch.name}\` — ${typ}, ${mon}`)
            }
          }

          // Inline settings
          const dc = getValue(config, ['dispatch'], {} as Record<string, unknown>)
          const gc = getValue(config, ['github'], {} as Record<string, unknown>)
          const lc = getValue(config, ['llm'], {} as Record<string, unknown>)
          lines.push(
            '',
            '**Settings:**',
            `Dispatch: \`${getValue(dc, ['mode'], 'auto')}\` | Discord: \`${getValue(dc, ['discord_mode'], 'auto')}\` | GitHub triage: \`${getValue(dc, ['github_triage'], false)}\``,
            `Model: \`${getValue(lc, ['claude', 'model'], 'claude-sonnet-4-20250514')}\` | Max turns: \`${getValue(lc, ['claude', 'max_turns'], 25)}\``,
            `Repos: ${(getValue(gc, ['repos'], []) as string[]).map((r) => `\`${r}\``).join(', ')}`,
          )

          lines.push(
            '',
            '**Triage channel commands** (`!` or `+` prefix):',
            '`!status` `!channels` `!settings` `!channel` `!config` `!sync-data` `!help`',
          )
        }

        await interaction.reply({ content: lines.join('\n'), ephemeral: true })
        return
      }

      // Handle /post slash command — social content creation
      if (interaction.isChatInputCommand() && interaction.commandName === 'post') {
        const topic = interaction.options.getString('topic', true)
        const guildId = interaction.guildId
        if (!guildId) {
          await interaction.reply({
            content: 'This command only works in a server.',
            ephemeral: true,
          })
          return
        }
        // Restrict /post to the designated social content channel (if configured)
        const allowedPostChannel = getValue(config, ['social', 'post_channel_id'], '') as string
        if (allowedPostChannel && interaction.channelId !== allowedPostChannel) {
          await interaction.reply({
            content: `\`/post\` can only be used in <#${allowedPostChannel}>.`,
            ephemeral: true,
          })
          return
        }
        const socialEnabled = getValue(config, ['social', 'enabled'], false)
        if (!socialEnabled) {
          await interaction.reply({
            content: 'Social content module is not enabled.',
            ephemeral: true,
          })
          return
        }
        const triageChannel = triageChannels.get(guildId)
        if (!triageChannel) {
          await interaction.reply({
            content: 'No triage channel configured for social content.',
            ephemeral: true,
          })
          return
        }

        // Permission check
        const userId = interaction.user.id
        const username = interaction.user.tag ?? interaction.user.username
        const isCollaborator = (collaborators as string[]).some(
          (c: string) => c.toLowerCase() === username.toLowerCase(),
        )
        const isTriageUser = (triageUserIds as string[]).includes(userId)
        if (!isCollaborator && !isTriageUser) {
          await interaction.reply({
            content: 'Only maintainers can create social content.',
            ephemeral: true,
          })
          return
        }

        await interaction.reply({
          content: `Social content request received for topic: "${topic}". Check the triage channel for drafting controls.`,
          ephemeral: true,
        })

        const contentId = buildContentId(userId)
        const contentKey = `content:linkedin:${contentId}`

        const notificationMsg = await postContentNotification(
          triageChannel,
          {
            platform: 'LinkedIn',
            topic,
            requestedBy: username,
            status: 'topic_received',
          },
          contentId,
        )

        const record: ContentRecord = {
          contentKey,
          notificationMessageId: notificationMsg.id,
          notificationChannelId: triageChannel.id,
          platform: 'linkedin',
          topic,
          requestedBy: username,
          requestedByUserId: userId,
          sourceGuildId: guildId,
          sourceChannelId: interaction.channelId ?? '',
          sourceMessageId: interaction.id,
          status: 'topic_received',
          revisionCount: 0,
          createdAt: new Date().toISOString(),
        }

        await updateState((s) => {
          setContentRecord(s, contentKey, record)
        })

        console.log(`[${formatTime()}] /post from @${username}: ${topic.substring(0, 80)}`)
        console.log(`  → Social content notification posted`)
        return
      }

      // Handle /ask slash command
      if (interaction.isChatInputCommand() && interaction.commandName === 'ask') {
        const question = interaction.options.getString('question', true)
        const guildId = interaction.guildId
        if (!guildId) {
          await interaction.reply({
            content: 'This command only works in a server.',
            ephemeral: true,
          })
          return
        }
        const triageChannel = triageChannels.get(guildId)
        if (!triageChannel) {
          await interaction.reply({
            content: 'No triage channel configured for this server.',
            ephemeral: true,
          })
          return
        }
        await interaction.reply({
          content: 'Your question has been received and is queued for investigation.',
          ephemeral: true,
        })
        // Post a triage notification for this slash command
        const mapping = guildMappings.get(guildId)
        if (mapping) {
          const guildName = mapping.guildConfig.name
          const authorTag = interaction.user.tag ?? interaction.user.username
          const compactId = discordCompactId(guildName, 'slash-ask', interaction.id)
          const triageKey = `triage:d:${compactId}`
          const notification = await postTriageNotification(
            triageChannel,
            {
              sourceType: 'd',
              title: question.substring(0, 200),
              content: question,
              author: authorTag,
              guildName,
              guildId,
              channelName: 'slash-ask',
              channelId: interaction.channelId,
              messageId: interaction.id,
              status: 'pending',
            },
            'd',
            compactId,
          )
          if (notification) {
            await updateState((s) => {
              setTriageRecord(s, triageKey, {
                triageKey,
                triageMessageId: notification.id,
                triageChannelId: triageChannel.id,
                sourceType: 'discord',
                sourceDiscordPath: `${guildName}/slash-ask`,
                sourceGuildId: guildId,
                sourceChannelId: interaction.channelId,
                sourceMessageId: interaction.id,
                sourceTitle: question.substring(0, 200),
                sourceContent: question,
                sourceAuthor: authorTag,
                status: 'pending',
                createdAt: new Date().toISOString(),
                reinvestigationCount: 0,
              })
            })
            console.log(`[${formatTime()}] /ask from @${authorTag}: ${question.substring(0, 80)}`)
            console.log(`  → Triage notification posted`)
          }
        }
        return
      }
      await handleTriageInteraction(interaction, client, triageHandlerContext)
      await handleSocialInteraction(interaction, client, socialHandlerContext)
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
          } catch {
            /* original deleted or inaccessible */
          }
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
      const channelConfig =
        mapping.channelMap.get(msg.channelId) ?? mapping.channelNameMap.get(channelName)
      if (!channelConfig) return

      console.log(
        `[${timestamp}] 🔁 Re-investigate requested in #${channelName} by @${user.tag ?? (user as any).username ?? user.id}`,
      )

      // Fetch the original user message
      let originalMessage: Message
      try {
        originalMessage = (await msg.channel.messages.fetch(msg.reference.messageId)) as Message
      } catch {
        console.warn(`  → Could not fetch original message for re-investigation`)
        return
      }

      // Mark as processing
      processingMessages.add(originalMessage.id)
      await originalMessage.react('🔍').catch(() => {})
      setInvestigatingStatus(
        client,
        channelName,
        originalMessage.author.tag ?? originalMessage.author.username,
      )

      try {
        await reinvestigateAndRespond(
          originalMessage,
          msg.content ?? '',
          mapping,
          channelConfig,
          options,
          config,
          llmModel,
        )
        await originalMessage.reactions.cache
          .get('🔍')
          ?.users.remove(client.user!.id)
          .catch(() => {})
        await originalMessage.react('✅').catch(() => {})
      } catch {
        await originalMessage.reactions.cache
          .get('🔍')
          ?.users.remove(client.user!.id)
          .catch(() => {})
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

      console.log(
        `[${timestamp}] 📋 Post investigation requested in #${channelName} by @${user.tag ?? (user as any).username ?? user.id}`,
      )

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
        try {
          await readFile(findingsPath, 'utf-8')
          hasArtifacts = true
        } catch {
          /* file not found */
        }
        try {
          await readFile(analysisPath, 'utf-8')
          hasArtifacts = true
        } catch {
          /* file not found */
        }

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
        await msg.reactions.cache
          .get('📋')
          ?.users.remove(client.user!.id)
          .catch(() => {})
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
      for (const repo of options.repos ?? githubRepos) {
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
            console.warn(
              `  → Failed to post triage for ${repo}#${issue.number}: ${err.message ?? err}`,
            )
          }
        }
      }

      if (totalNew > 0) {
        console.log(`[${timestamp}] GitHub poll: ${totalNew} new issue(s) posted to triage`)
      } else {
        console.log(`[${timestamp}] GitHub poll: no new issues`)
      }

      // Sync data to private repo after each poll
      try {
        await syncDataToGitHub()
      } catch (err: any) {
        console.warn(`  Data sync failed: ${err.message ?? err}`)
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
      console.error(
        'Go to https://discord.com/developers/applications → Bot → enable "Message Content Intent"',
      )
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
const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.log',
  '.yml',
  '.yaml',
  '.json',
  '.xml',
  '.csv',
  '.md',
  '.ini',
  '.cfg',
  '.conf',
  '.toml',
  '.env.example',
])

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
      console.log(
        `  → Attachment skipped (too large: ${Math.round(attachment.size / 1024)}KB): ${name}`,
      )
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
  if (
    replyChain.length > 0 ||
    (threadContext && threadContext.length > 0) ||
    attachments.length > 0
  ) {
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

    // Unset CLAUDECODE to allow nested Claude invocation
    const env = { ...process.env }
    delete env.CLAUDECODE

    const proc = spawn(resolveClaude(), args, {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'inherit', 'inherit'],
      env,
    })
    proc.stdin.end(prompt)
    const [code] = (await once(proc, 'exit')) as [number | null]
    if (code !== 0) {
      throw new Error(`Claude Code CLI exited with code ${code ?? 'unknown'}`)
    }
  } catch (error: any) {
    console.warn(`  ✗ LLM investigation failed: ${error.message ?? error}`)
    throw new Error(`LLM investigation failed: ${error.message ?? error}`, { cause: error })
  }

  // Log investigation artifacts
  const findingsFile = join(responseDir, `${responseId}-findings.md`)
  const analysisFile = join(responseDir, `${responseId}-analysis.md`)
  try {
    await readFile(findingsFile, 'utf-8')
    console.log(`  → Findings captured: ${responseId}-findings.md`)
  } catch {
    /* findings file is optional */
  }
  try {
    await readFile(analysisFile, 'utf-8')
    console.log(`  → Analysis captured: ${responseId}-analysis.md`)
  } catch {
    /* analysis file is optional */
  }

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
      const chunkContent =
        chunks.length > 1 ? `(part ${index + 1}/${chunks.length})\n${chunk}` : chunk

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
      } catch {
        /* non-critical */
      }
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
  } catch {
    /* continue without */
  }

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
    } catch {
      /* continue without */
    }
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

    const proc = spawn(resolveClaude(), args, {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'inherit', 'inherit'],
      env,
    })
    proc.stdin.end(prompt)
    const [code] = (await once(proc, 'exit')) as [number | null]
    if (code !== 0) {
      throw new Error(`Claude Code CLI exited with code ${code ?? 'unknown'}`)
    }
  } catch (error: any) {
    console.warn(`  ✗ Re-investigation LLM failed: ${error.message ?? error}`)
    throw new Error(`Re-investigation LLM failed: ${error.message ?? error}`, { cause: error })
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
      const chunkContent =
        chunks.length > 1 ? `(part ${index + 1}/${chunks.length})\n${chunk}` : chunk

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

          // Respect trigger_mode: 'all' processes every message, 'mention' requires @mention
          const triggerMode = channelConfig.trigger_mode ?? 'mention'
          const botId = client.user?.id
          const isMentioned = botId ? message.mentions.users.has(botId) : false
          const isReplyToBot = message.reference?.messageId
            ? await channel.messages
                .fetch(message.reference.messageId)
                .then((ref) => ref.author.id === botId)
                .catch(() => false)
            : false
          if (triggerMode === 'mention' && !isMentioned && !isReplyToBot) continue
          if (triggerMode === 'all' && !isMentioned && !isReplyToBot) {
            if (message.content.trim().length < filters.minMessageLength) continue
          }

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
            await message.reactions.cache
              .get('🔍')
              ?.users.remove(client.user!.id)
              .catch(() => {})
            await message.react('✅').catch(() => {})
          } catch {
            await message.reactions.cache
              .get('🔍')
              ?.users.remove(client.user!.id)
              .catch(() => {})
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
