export type TriageStatus = 'pending' | 'investigating' | 'ready' | 'sent' | 'ignored'

export type TriageSourceType = 'discord' | 'github_issue' | 'github_pr'

export interface TriageRecord {
  /** Unique triage key */
  triageKey: string
  /** Discord message ID of the triage notification in the admin channel */
  triageMessageId: string
  /** Discord channel ID of the admin/triage channel */
  triageChannelId: string
  /** Source type */
  sourceType: TriageSourceType
  /** For discord sources: guild/channel path */
  sourceDiscordPath?: string
  /** For discord sources: guild snowflake ID */
  sourceGuildId?: string
  /** For discord sources: channel snowflake ID */
  sourceChannelId?: string
  /** For discord sources: original message ID */
  sourceMessageId?: string
  /** For GitHub sources: owner/repo */
  sourceRepo?: string
  /** For GitHub sources: issue or PR number */
  sourceIssueNumber?: number
  /** Short title / preview */
  sourceTitle?: string
  /** Original content (for prompt building) */
  sourceContent?: string
  /** Original author */
  sourceAuthor?: string
  /** GitHub labels */
  sourceLabels?: string[]
  /** Triage lifecycle status */
  status: TriageStatus
  createdAt: string
  /** Who performed each action */
  investigatedBy?: string
  ignoredBy?: string
  sentBy?: string
  /** Response file path (relative to repo root) */
  responseFile?: string
  /** Investigation timestamps */
  investigationStartedAt?: string
  investigationCompletedAt?: string
  /** Thread ID for maintainer instructions */
  instructionThreadId?: string
  /** Number of re-investigations performed */
  reinvestigationCount: number
}

// --- Button custom ID helpers ---

/** Max custom_id length in Discord */
const MAX_CUSTOM_ID = 100

export type TriageAction = 'investigate' | 'ignore' | 'send' | 'reinvestigate' | 'view'

/** Guild shortname mapping for compact button IDs */
const GUILD_SHORT: Record<string, string> = {
  'game-ci': 'gci',
  'game-ci-develop': 'gci-dev',
}
const GUILD_LONG: Record<string, string> = Object.fromEntries(
  Object.entries(GUILD_SHORT).map(([k, v]) => [v, k]),
)

export function guildToShort(name: string): string {
  return GUILD_SHORT[name] ?? name.substring(0, 10)
}

export function shortToGuild(short: string): string {
  return GUILD_LONG[short] ?? short
}

export interface TriageButtonId {
  action: TriageAction
  sourceType: 'd' | 'g' // discord or github
  compactId: string // guild:channel:msgId or repo:issueNum
}

export function buildButtonId(
  action: TriageAction,
  sourceType: 'd' | 'g',
  compactId: string,
): string {
  const id = `triage|${action}|${sourceType}|${compactId}`
  if (id.length > MAX_CUSTOM_ID) {
    throw new Error(`Button custom_id exceeds ${MAX_CUSTOM_ID} chars: ${id.length}`)
  }
  return id
}

export function parseButtonId(customId: string): TriageButtonId | null {
  if (!customId.startsWith('triage|')) return null
  const parts = customId.split('|')
  if (parts.length !== 4) return null
  return {
    action: parts[1] as TriageAction,
    sourceType: parts[2] as 'd' | 'g',
    compactId: parts[3],
  }
}

/** Build compact ID for a Discord source */
export function discordCompactId(
  guildName: string,
  channelName: string,
  messageId: string,
): string {
  return `${guildToShort(guildName)}:${channelName}:${messageId}`
}

/** Parse a Discord compact ID back to components */
export function parseDiscordCompactId(
  compactId: string,
): { guildName: string; channelName: string; messageId: string } | null {
  const [guildShort, channelName, ...messageIdParts] = compactId.split(':')
  if (!guildShort || !channelName || messageIdParts.length === 0) return null
  return {
    guildName: shortToGuild(guildShort),
    channelName,
    messageId: messageIdParts.join(':'),
  }
}

/** Build compact ID for a GitHub source */
export function githubCompactId(repo: string, issueNumber: number): string {
  return `${repo}:${issueNumber}`
}

/** Parse a GitHub compact ID */
export function parseGithubCompactId(
  compactId: string,
): { repo: string; issueNumber: number } | null {
  const lastColon = compactId.lastIndexOf(':')
  if (lastColon < 0) return null
  const num = Number(compactId.substring(lastColon + 1))
  if (isNaN(num)) return null
  return {
    repo: compactId.substring(0, lastColon),
    issueNumber: num,
  }
}
