/**
 * Sanitize a string from untrusted source issue data before embedding
 * in a detection issue body. Prevents markdown injection, HTML injection,
 * and excessively long strings.
 */
export function sanitizeText(value: string, maxLength = 200): string {
  let safe = value
  // Strip HTML tags
  safe = safe.replace(/<[^>]*>/g, '')
  // Escape markdown special characters that could create links/images
  safe = safe.replace(/([[\]()!])/g, '\\$1')
  // Collapse whitespace
  safe = safe.replace(/\s+/g, ' ').trim()
  // Truncate
  if (safe.length > maxLength) {
    safe = safe.substring(0, maxLength) + '...'
  }
  return safe
}

/**
 * Validate and sanitize a GitHub username.
 * Valid usernames match ^[a-zA-Z0-9_-]+$
 */
export function sanitizeUsername(username: string): string {
  const trimmed = username.trim()
  if (/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    return trimmed
  }
  return '[invalid-username]'
}

/**
 * Sanitize a label string — alphanumeric, hyphens, spaces, colons only.
 */
export function sanitizeLabel(label: string): string {
  return label.replace(/[^a-zA-Z0-9\s:_-]/g, '').trim()
}

/**
 * Map GitHub reaction content values to display emoji.
 */
const REACTION_EMOJI: Record<string, string> = {
  '+1': '👍',
  '-1': '👎',
  'rocket': '🚀',
  'eyes': '👀',
  'heart': '❤️',
  'hooray': '🎉',
  'laugh': '😄',
  'confused': '😕',
}

export function reactionToEmoji(content: string): string {
  return REACTION_EMOJI[content] ?? content
}

// --- Discord detection body ---

export interface DiscordDetectionBodyParams {
  guildName: string
  channelName: string
  messageId: string
  author: string
  content: string
  timestamp: string
  threadName?: string
  isForumPost: boolean
  dispatchMode: 'approval' | 'countdown'
  warningsRequired?: number
  warningIntervalHours?: number
  approveReactions: string[]
  cancelReactions: string[]
}

/**
 * Build a safe detection issue body from a Discord message.
 */
export function buildDiscordDetectionBody(params: DiscordDetectionBodyParams): string {
  const safeContent = sanitizeText(params.content, 500)
  const safeAuthor = sanitizeText(params.author, 50)
  const channelDisplay = params.threadName
    ? `${params.channelName}/${sanitizeText(params.threadName, 100)}`
    : params.channelName

  const approveEmoji = params.approveReactions.map(reactionToEmoji).join(' or ')
  const cancelEmoji = params.cancelReactions.map(reactionToEmoji).join(' or ')

  const sections: string[] = []

  sections.push(`> Detection for Discord message in ${params.guildName}/${channelDisplay}`)
  sections.push('')
  sections.push(`**Source:** Discord — ${params.guildName} / #${channelDisplay}`)
  sections.push(`**Message ID:** ${params.messageId}`)
  sections.push(`**Author:** ${safeAuthor}`)
  sections.push(`**Timestamp:** ${params.timestamp}`)
  sections.push(`**Type:** ${params.isForumPost ? 'Forum post' : 'Channel message'}`)
  sections.push('')
  sections.push('**Message content:**')
  sections.push('```')
  sections.push(safeContent)
  sections.push('```')
  sections.push('')
  sections.push('---')
  sections.push('')
  sections.push('### Maintainer Action Required')
  sections.push('')
  sections.push('React to this issue to control whether the help bot responds:')
  sections.push('')
  sections.push(`- **Approve:** React with ${approveEmoji} to dispatch response immediately`)
  sections.push(`- **Cancel:** React with ${cancelEmoji} to skip this message`)
  sections.push('- **Comment:** Any comment from a listed maintainer also approves')

  if (params.dispatchMode === 'countdown') {
    const totalHours = (params.warningsRequired ?? 3) * (params.warningIntervalHours ?? 24)
    const totalDays = Math.round(totalHours / 24 * 10) / 10
    sections.push('')
    sections.push(`**Auto-dispatch:** This detection will progress through ${params.warningsRequired ?? 3} warning stages (${params.warningIntervalHours ?? 24}h apart). ` +
      `If no maintainer action is taken, response auto-dispatches after ~${totalDays} day(s).`)
    sections.push('')
    sections.push(`Each warning stage must elapse individually — the bot cannot skip stages even if it hasn't run for a while.`)
  }

  sections.push('')
  sections.push('---')
  sections.push('*Created by [GameCI Help Bot](https://github.com/game-ci/help-bot) dispatch system*')

  return sections.join('\n')
}

export interface DetectionBodyParams {
  sourceRepo: string
  sourceNumber: number
  title: string
  author: string
  labels: string[]
  commentCount: number
  dispatchMode: 'approval' | 'countdown'
  warningsRequired?: number
  warningIntervalHours?: number
  approveReactions: string[]
  cancelReactions: string[]
}

/**
 * Build a safe detection issue body from source issue data.
 */
export function buildDetectionBody(params: DetectionBodyParams): string {
  const safeTitle = sanitizeText(params.title)
  const safeAuthor = sanitizeUsername(params.author)
  const safeLabels = params.labels.map(sanitizeLabel).filter(Boolean)
  const sourceUrl = `https://github.com/${params.sourceRepo}/issues/${params.sourceNumber}`

  const approveEmoji = params.approveReactions.map(reactionToEmoji).join(' or ')
  const cancelEmoji = params.cancelReactions.map(reactionToEmoji).join(' or ')

  const sections: string[] = []

  sections.push(`> Detection for ${params.sourceRepo}#${params.sourceNumber}`)
  sections.push('')
  sections.push(`**Source Issue:** ${sourceUrl}`)
  sections.push(`**Title:** ${safeTitle}`)
  sections.push(`**Author:** @${safeAuthor}`)
  sections.push(`**Labels:** ${safeLabels.length > 0 ? safeLabels.join(', ') : 'none'}`)
  sections.push(`**Comments:** ${params.commentCount}`)
  sections.push('')
  sections.push('---')
  sections.push('')
  sections.push('### Maintainer Action Required')
  sections.push('')
  sections.push('React to this issue to control whether the help bot investigates:')
  sections.push('')
  sections.push(`- **Approve:** React with ${approveEmoji} to dispatch investigation immediately`)
  sections.push(`- **Cancel:** React with ${cancelEmoji} to skip this issue`)
  sections.push('- **Comment:** Any comment from a listed maintainer also approves')

  if (params.dispatchMode === 'countdown') {
    const totalHours = (params.warningsRequired ?? 3) * (params.warningIntervalHours ?? 24)
    const totalDays = Math.round(totalHours / 24 * 10) / 10
    sections.push('')
    sections.push(`**Auto-dispatch:** This detection will progress through ${params.warningsRequired ?? 3} warning stages (${params.warningIntervalHours ?? 24}h apart). ` +
      `If no maintainer action is taken, investigation auto-dispatches after ~${totalDays} day(s).`)
    sections.push('')
    sections.push(`Each warning stage must elapse individually — the bot cannot skip stages even if it hasn't run for a while.`)
  }

  sections.push('')
  sections.push('---')
  sections.push('*Created by [GameCI Help Bot](https://github.com/game-ci/help-bot) dispatch system*')

  return sections.join('\n')
}

/**
 * Build a warning comment for a countdown stage.
 */
export function buildWarningComment(params: {
  stage: number
  totalStages: number
  intervalHours: number
  sourceRepo: string
  sourceNumber: number
  createdAt: string
  approveReactions: string[]
  cancelReactions: string[]
}): string {
  const remaining = params.totalStages - params.stage
  const approveEmoji = params.approveReactions.map(reactionToEmoji).join(' or ')
  const cancelEmoji = params.cancelReactions.map(reactionToEmoji).join(' or ')
  const sourceUrl = `https://github.com/${params.sourceRepo}/issues/${params.sourceNumber}`
  const earliestDispatchHours = remaining * params.intervalHours
  const earliestDispatchDays = Math.round(earliestDispatchHours / 24 * 10) / 10

  const lines: string[] = []
  lines.push(`### Stage ${params.stage}/${params.totalStages} — Countdown Warning`)
  lines.push('')
  lines.push(`Investigation will auto-dispatch after **${remaining}** more stage(s) (~${earliestDispatchDays} day(s)).`)
  lines.push('')
  lines.push(`- React ${approveEmoji} to **approve now**`)
  lines.push(`- React ${cancelEmoji} to **cancel**`)
  lines.push('')
  lines.push(`Source: ${sourceUrl}`)
  lines.push(`Created: ${params.createdAt}`)
  lines.push(`Next stage in: ${params.intervalHours} hours`)
  lines.push('')
  lines.push('---')
  lines.push('*GameCI Help Bot dispatch system*')

  return lines.join('\n')
}
