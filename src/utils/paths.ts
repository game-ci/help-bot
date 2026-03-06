import { join } from 'node:path'

export const REPO_ROOT = process.cwd()
export const DATA_DIR = join(REPO_ROOT, 'data')
export const RESPONSES_DIR = join(DATA_DIR, 'responses')
export const DISCORD_DATA_DIR = join(DATA_DIR, 'discord', 'channels')
export const GITHUB_DATA_DIR = join(DATA_DIR, 'github', 'issues')
export const DOCS_DATA_DIR = join(DATA_DIR, 'docs')
export const LOGS_DIR = join(DATA_DIR, 'logs')

// --- Guild-aware path helpers ---

/** Root data directory for a specific guild: data/discord/guilds/{guildName} */
export function guildDataDir(guildName: string): string {
  return join(DATA_DIR, 'discord', 'guilds', guildName)
}

/** Channel data directory within a guild: data/discord/guilds/{guildName}/channels/{channelName} */
export function guildChannelDir(guildName: string, channelName: string): string {
  return join(DATA_DIR, 'discord', 'guilds', guildName, 'channels', channelName)
}

/** Thread data directory within a channel: data/discord/guilds/{guildName}/channels/{channelName}/threads/{threadId} */
export function guildThreadDir(guildName: string, channelName: string, threadId: string): string {
  return join(DATA_DIR, 'discord', 'guilds', guildName, 'channels', channelName, 'threads', threadId)
}

/** Forum data directory within a guild: data/discord/guilds/{guildName}/forums/{channelName} */
export function guildForumDir(guildName: string, channelName: string): string {
  return join(DATA_DIR, 'discord', 'guilds', guildName, 'forums', channelName)
}
