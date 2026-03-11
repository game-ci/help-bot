export type DispatchMode = 'auto' | 'approval' | 'countdown' | 'triage'

export type DetectionStatus = 'pending' | 'approved' | 'cancelled' | 'dispatched'

export type DetectionSourceType = 'github' | 'discord'

export interface DispatchConfig {
  mode: DispatchMode
  warnings_required: number
  warning_interval_hours: number
  approve_reactions: string[]
  cancel_reactions: string[]
  max_detections_per_cycle: number
  close_on_dispatch: boolean
}

export interface DetectionRecord {
  detectionIssueNumber: number
  sourceRepo: string
  sourceIssueNumber: number
  /** Source type: 'github' (default) or 'discord' */
  sourceType?: DetectionSourceType
  /** Discord-specific: message ID */
  sourceMessageId?: string
  /** Discord-specific: guild/channel path */
  sourceDiscordPath?: string
  status: DetectionStatus
  createdAt: string
  /** 0 = just created, 1+ = warnings posted */
  currentStage: number
  /** ISO timestamp of when the current stage was entered */
  stageAdvancedAt: string
  /** Number of warnings required before auto-dispatch (snapshot from config at creation) */
  warningsRequired: number
  /** Hours between stages (snapshot from config at creation) */
  warningIntervalHours: number
  approvedBy?: string
  cancelledBy?: string
  dispatchedAt?: string
}

export type DetectionKey = string

export function makeDetectionKey(repo: string, issueNumber: number): DetectionKey {
  return `${repo}#${issueNumber}`
}

/** Create a detection key for a Discord message */
export function makeDiscordDetectionKey(guildName: string, channelName: string, messageId: string): DetectionKey {
  return `discord:${guildName}/${channelName}#${messageId}`
}
