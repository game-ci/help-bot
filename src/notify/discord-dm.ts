import { request } from 'undici'
import { getConfig, getValue } from '../config'
import { CycleStats } from '../metrics'

const DISCORD_API = 'https://discord.com/api/v10'

export interface DmRecipient {
  discord_user_id: string
  github_username: string
  filters: DmFilters
}

export interface DmFilters {
  new_detections: boolean
  approvals: boolean
  countdown_warnings: boolean
  investigations_complete: boolean
  cycle_reports: boolean
}

export interface DmNotifyOptions {
  dryRun: boolean
}

interface DmNotificationConfig {
  enabled: boolean
  recipients: DmRecipient[]
}

/**
 * Read DM notification config from config.json.
 */
async function getDmConfig(): Promise<DmNotificationConfig> {
  const config = await getConfig()
  return {
    enabled: Boolean(getValue(config, ['notifications', 'discord_dm', 'enabled'], false)),
    recipients: getValue(
      config,
      ['notifications', 'discord_dm', 'recipients'],
      [],
    ) as DmRecipient[],
  }
}

/**
 * Get the bot token from the environment.
 */
function getBotToken(): string | undefined {
  return process.env.DISCORD_BOT_TOKEN
}

/**
 * Create a DM channel with a user and return the channel ID.
 */
async function createDmChannel(userId: string, token: string): Promise<string | null> {
  try {
    const response = await request(`${DISCORD_API}/users/@me/channels`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ recipient_id: userId }),
    })

    if (response.statusCode !== 200) {
      console.warn(
        `  Failed to create DM channel for user ${userId}: status ${response.statusCode}`,
      )
      return null
    }

    const data = (await response.body.json()) as { id: string }
    return data.id
  } catch (error: any) {
    console.warn(`  Failed to create DM channel for user ${userId}: ${error.message ?? error}`)
    return null
  }
}

/**
 * Send a message to a DM channel.
 */
async function sendDmMessage(channelId: string, content: string, token: string): Promise<boolean> {
  try {
    const response = await request(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content }),
    })
    return response.statusCode === 200
  } catch {
    return false
  }
}

/**
 * Send a DM notification to a specific user.
 */
async function notifyUser(
  recipient: DmRecipient,
  message: string,
  token: string,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) {
    console.log(
      `  DRY RUN: would DM ${recipient.github_username} (${recipient.discord_user_id}): ${message.substring(0, 80)}...`,
    )
    return
  }

  const channelId = await createDmChannel(recipient.discord_user_id, token)
  if (!channelId) return

  const success = await sendDmMessage(channelId, message, token)
  if (success) {
    console.log(`  Sent DM to ${recipient.github_username}`)
  } else {
    console.warn(`  Failed to send DM to ${recipient.github_username}`)
  }

  // Rate limit
  await new Promise((resolve) => setTimeout(resolve, 1000))
}

/**
 * Filter recipients by a specific notification type.
 */
function filterRecipients(recipients: DmRecipient[], filterKey: keyof DmFilters): DmRecipient[] {
  return recipients.filter((r) => r.filters[filterKey])
}

/**
 * Notify maintainers about new detection issues created this cycle.
 */
export async function notifyNewDetections(
  options: DmNotifyOptions & {
    detections: Array<{ repo: string; issueNumber: number; title: string; detectionUrl?: string }>
  },
): Promise<void> {
  if (options.detections.length === 0) return

  const dmConfig = await getDmConfig()
  if (!dmConfig.enabled || dmConfig.recipients.length === 0) return

  const token = getBotToken()
  if (!token) return

  const recipients = filterRecipients(dmConfig.recipients, 'new_detections')
  if (recipients.length === 0) return

  const lines = options.detections.map(
    (d) =>
      `- **${d.repo}#${d.issueNumber}**: ${d.title}${d.detectionUrl ? ` ([detection](${d.detectionUrl}))` : ''}`,
  )
  const message = `**GameCI Help Bot** - New detections created:\n${lines.join('\n')}\n\nReact on the detection issues to approve or cancel.`

  console.log(`  Sending DM notifications for ${options.detections.length} new detections...`)
  for (const recipient of recipients) {
    await notifyUser(recipient, message, token, options.dryRun)
  }
}

/**
 * Notify maintainers about countdown warnings posted this cycle.
 */
export async function notifyCountdownWarnings(
  options: DmNotifyOptions & {
    warnings: Array<{ repo: string; issueNumber: number; stage: number; totalStages: number }>
  },
): Promise<void> {
  if (options.warnings.length === 0) return

  const dmConfig = await getDmConfig()
  if (!dmConfig.enabled || dmConfig.recipients.length === 0) return

  const token = getBotToken()
  if (!token) return

  const recipients = filterRecipients(dmConfig.recipients, 'countdown_warnings')
  if (recipients.length === 0) return

  const lines = options.warnings.map(
    (w) => `- **${w.repo}#${w.issueNumber}**: Warning ${w.stage}/${w.totalStages}`,
  )
  const message = `**GameCI Help Bot** - Countdown warnings:\n${lines.join('\n')}\n\nReact on detection issues to approve or cancel before auto-dispatch.`

  console.log(`  Sending DM notifications for ${options.warnings.length} countdown warnings...`)
  for (const recipient of recipients) {
    await notifyUser(recipient, message, token, options.dryRun)
  }
}

/**
 * Notify maintainers about approved/dispatched investigations.
 */
export async function notifyApprovals(
  options: DmNotifyOptions & {
    approved: Array<{ repo: string; issueNumber: number; approvedBy: string }>
  },
): Promise<void> {
  if (options.approved.length === 0) return

  const dmConfig = await getDmConfig()
  if (!dmConfig.enabled || dmConfig.recipients.length === 0) return

  const token = getBotToken()
  if (!token) return

  const recipients = filterRecipients(dmConfig.recipients, 'approvals')
  if (recipients.length === 0) return

  const lines = options.approved.map(
    (a) => `- **${a.repo}#${a.issueNumber}** (approved by ${a.approvedBy})`,
  )
  const message = `**GameCI Help Bot** - Issues approved for investigation:\n${lines.join('\n')}`

  console.log(`  Sending DM notifications for ${options.approved.length} approvals...`)
  for (const recipient of recipients) {
    await notifyUser(recipient, message, token, options.dryRun)
  }
}

/**
 * Notify maintainers when investigations are complete.
 */
export async function notifyInvestigationsComplete(
  options: DmNotifyOptions & {
    investigations: Array<{
      repo: string
      issueNumber: number
      classification: string
      investigationUrl?: string
    }>
  },
): Promise<void> {
  if (options.investigations.length === 0) return

  const dmConfig = await getDmConfig()
  if (!dmConfig.enabled || dmConfig.recipients.length === 0) return

  const token = getBotToken()
  if (!token) return

  const recipients = filterRecipients(dmConfig.recipients, 'investigations_complete')
  if (recipients.length === 0) return

  const lines = options.investigations.map(
    (inv) =>
      `- **${inv.repo}#${inv.issueNumber}** [${inv.classification}]${inv.investigationUrl ? ` — [view](${inv.investigationUrl})` : ''}`,
  )
  const message = `**GameCI Help Bot** - Investigations completed:\n${lines.join('\n')}`

  console.log(
    `  Sending DM notifications for ${options.investigations.length} completed investigations...`,
  )
  for (const recipient of recipients) {
    await notifyUser(recipient, message, token, options.dryRun)
  }
}

/**
 * Send a cycle summary DM to opted-in maintainers.
 */
export async function notifyCycleSummary(
  options: DmNotifyOptions & {
    stats: CycleStats
    repos: string[]
  },
): Promise<void> {
  const dmConfig = await getDmConfig()
  if (!dmConfig.enabled || dmConfig.recipients.length === 0) return

  const token = getBotToken()
  if (!token) return

  const recipients = filterRecipients(dmConfig.recipients, 'cycle_reports')
  if (recipients.length === 0) return

  const s = options.stats
  // Skip if nothing happened
  const hasActivity =
    s.githubResponsesPosted > 0 ||
    s.investigationIssuesPosted > 0 ||
    s.detectionsCreated > 0 ||
    s.detectionsApproved > 0 ||
    s.detectionsExpired > 0 ||
    s.detectionsWarningsPosted > 0
  if (!hasActivity) return

  const lines: string[] = []
  lines.push(`**GameCI Help Bot** - Cycle summary for ${options.repos.join(', ')}:`)
  if (s.detectionsCreated > 0) lines.push(`- Detections created: ${s.detectionsCreated}`)
  if (s.detectionsApproved > 0) lines.push(`- Approved: ${s.detectionsApproved}`)
  if (s.detectionsPending > 0) lines.push(`- Pending: ${s.detectionsPending}`)
  if (s.detectionsExpired > 0) lines.push(`- Auto-dispatched: ${s.detectionsExpired}`)
  if (s.detectionsWarningsPosted > 0) lines.push(`- Warnings posted: ${s.detectionsWarningsPosted}`)
  if (s.investigationIssuesPosted > 0)
    lines.push(`- Investigations posted: ${s.investigationIssuesPosted}`)
  if (s.githubResponsesPosted > 0) lines.push(`- Responses posted: ${s.githubResponsesPosted}`)

  const message = lines.join('\n')

  console.log(`  Sending cycle summary DM to ${recipients.length} recipients...`)
  for (const recipient of recipients) {
    await notifyUser(recipient, message, token, options.dryRun)
  }
}
