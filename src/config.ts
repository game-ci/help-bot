import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

let cachedConfig: Record<string, unknown> = {} as Record<string, unknown>
let configLoaded = false

export function getConfigPath(): string {
  return join(process.cwd(), 'config.json')
}

export async function getConfig(): Promise<Record<string, unknown>> {
  if (configLoaded) {
    return cachedConfig
  }
  try {
    const payload = await readFile(getConfigPath(), 'utf-8')
    cachedConfig = JSON.parse(payload)
  } catch {
    cachedConfig = {}
  }
  configLoaded = true
  return cachedConfig
}

/** Re-read config.json from disk and update the cache. Returns the fresh config. */
export async function reloadConfig(): Promise<Record<string, unknown>> {
  configLoaded = false
  return getConfig()
}

/** Write the current cached config back to config.json. */
export async function saveConfig(): Promise<void> {
  await writeFile(getConfigPath(), JSON.stringify(cachedConfig, null, 2) + '\n', 'utf-8')
}

export function getValue<T>(config: Record<string, unknown>, path: string[], fallback: T): T {
  let current: unknown = config
  for (const segment of path) {
    if (!current || typeof current !== 'object') {
      return fallback
    }
    current = (current as Record<string, unknown>)[segment]
  }
  return (current as T) ?? fallback
}

// --- Multi-guild types ---

export interface ChannelConfig {
  name: string
  /** Per-channel system prompt appended to the base prompt */
  system_prompt?: string
  /** Channel type: 'text' (default), 'forum', 'announcement' */
  channel_type?: 'text' | 'forum' | 'announcement'
  /** How the bot replies: 'bot_api' (default — direct reply in channel), 'thread' (create/reply in thread), 'webhook' (legacy webhook posting) */
  reply_mode?: 'bot_api' | 'thread' | 'webhook'
  /** Whether to read threads within this channel */
  read_threads?: boolean
  /** Whether the bot should monitor this channel for help requests (default: true) */
  monitor?: boolean
}

export interface GuildConfig {
  name: string
  /** Direct guild ID (preferred over guild_id_env) */
  guild_id?: string
  /** Environment variable name containing the guild ID (fallback if guild_id not set) */
  guild_id_env?: string
  /** Direct webhook URL (preferred over webhook_url_env) */
  webhook_url?: string
  /** Environment variable name containing the webhook URL */
  webhook_url_env?: string
  /** Guild-level system prompt (applied after base, before channel) */
  system_prompt?: string
  /** Channel ID of the private admin channel for triage notifications */
  triage_channel_id?: string
  channels: ChannelConfig[]
}

/** System prompt for a specific GitHub label */
export interface LabelPromptConfig {
  /** Label name (case-insensitive match) */
  label: string
  /** System prompt to append when processing issues with this label */
  system_prompt: string
}

/**
 * Resolve the guilds array from config. Supports both the new guilds[] format
 * and the legacy single-guild format (guild_id_env at the top level of discord).
 *
 * Legacy format is converted to a single guild named "default" with a
 * deprecation warning.
 */
export function resolveGuilds(discordConfig: Record<string, unknown>): GuildConfig[] {
  // New format: discord.guilds[]
  const guilds = discordConfig['guilds'] as GuildConfig[] | undefined
  if (Array.isArray(guilds)) {
    return guilds
  }

  // Legacy format: discord.guild_id_env at top level
  const legacyGuildIdEnv = discordConfig['guild_id_env'] as string | undefined
  if (legacyGuildIdEnv) {
    console.warn(
      'DEPRECATION WARNING: discord.guild_id_env at top level is deprecated. ' +
        'Please migrate to the guilds[] array format. See config.json for the new structure.',
    )
    const legacyChannels = discordConfig['channels'] as (string | ChannelConfig)[] | undefined
    const channelConfigs: ChannelConfig[] = (legacyChannels ?? []).map((ch) => {
      if (typeof ch === 'string') {
        return { name: ch }
      }
      return ch
    })
    return [
      {
        name: 'default',
        guild_id_env: legacyGuildIdEnv,
        webhook_url_env: 'DISCORD_WEBHOOK_URL',
        channels: channelConfigs,
      },
    ]
  }

  // No guilds configured
  return []
}

/**
 * Resolve a guild's ID from either the direct guild_id field or the guild_id_env environment variable.
 */
export function resolveGuildId(guild: GuildConfig): string | undefined {
  if (guild.guild_id) return guild.guild_id
  if (guild.guild_id_env) return process.env[guild.guild_id_env]
  return undefined
}

/**
 * Resolve a guild's webhook URL from either the direct webhook_url field or the webhook_url_env environment variable.
 */
export function resolveWebhookUrl(guild: GuildConfig): string | undefined {
  if (guild.webhook_url) return guild.webhook_url
  if (guild.webhook_url_env) return process.env[guild.webhook_url_env]
  return undefined
}

/**
 * Build a layered system prompt by combining:
 *   1. Base prompt (discord.system_prompt) -- applies to all guilds/channels
 *   2. Guild-level prompt (guild.system_prompt) -- if present
 *   3. Channel-level prompt (channel.system_prompt) -- if present
 *
 * Each layer is concatenated with double newlines.
 */
export function getSystemPrompt(
  discordConfig: Record<string, unknown>,
  guild?: GuildConfig,
  channel?: ChannelConfig,
): string {
  const layers: string[] = []

  // Base prompt
  const base = discordConfig['system_prompt'] as string | undefined
  if (base) {
    layers.push(base.trim())
  }

  // Guild-level prompt
  if (guild?.system_prompt) {
    layers.push(guild.system_prompt.trim())
  }

  // Channel-level prompt
  if (channel?.system_prompt) {
    layers.push(channel.system_prompt.trim())
  }

  return layers.filter(Boolean).join('\n\n')
}

/**
 * Get per-label system prompts from config.
 * These are appended to the LLM prompt when processing issues with matching labels.
 */
export function getLabelPrompts(config: Record<string, unknown>): LabelPromptConfig[] {
  return (getValue(config, ['github', 'label_prompts'], []) as LabelPromptConfig[])
}

/**
 * Build a combined system prompt for a set of issue labels.
 * Returns concatenated label-specific prompts, or empty string if none match.
 */
export function buildLabelSystemPrompt(config: Record<string, unknown>, labels: string[]): string {
  const labelPrompts = getLabelPrompts(config)
  if (labelPrompts.length === 0 || labels.length === 0) return ''

  const lowerLabels = labels.map(l => l.toLowerCase())
  const matched = labelPrompts.filter(lp => lowerLabels.includes(lp.label.toLowerCase()))
  if (matched.length === 0) return ''

  return matched.map(lp => lp.system_prompt.trim()).join('\n\n')
}
