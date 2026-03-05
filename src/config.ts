import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

let cachedConfig: Record<string, unknown> = {} as Record<string, unknown>
let configLoaded = false

export async function getConfig(): Promise<Record<string, unknown>> {
  if (configLoaded) {
    return cachedConfig
  }
  const configPath = join(process.cwd(), 'config.json')
  try {
    const payload = await readFile(configPath, 'utf-8')
    cachedConfig = JSON.parse(payload)
  } catch {
    cachedConfig = {}
  }
  configLoaded = true
  return cachedConfig
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
  system_prompt?: string
}

export interface GuildConfig {
  name: string
  guild_id_env: string
  webhook_url_env: string
  channels: ChannelConfig[]
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
 * Build a layered system prompt by combining:
 *   1. Base prompt (discord.system_prompt) -- applies to all guilds/channels
 *   2. Guild-level prompt (guild.system_prompt) -- if present (reserved for future use)
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

  // Guild-level prompt (future-proofing -- the GuildConfig type doesn't mandate it yet,
  // but if someone adds system_prompt to a guild object it will be picked up)
  if (guild) {
    const guildPrompt = (guild as unknown as Record<string, unknown>)['system_prompt'] as string | undefined
    if (guildPrompt) {
      layers.push(guildPrompt.trim())
    }
  }

  // Channel-level prompt
  if (channel?.system_prompt) {
    layers.push(channel.system_prompt.trim())
  }

  return layers.filter(Boolean).join('\n\n')
}
