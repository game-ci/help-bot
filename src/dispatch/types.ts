export type DispatchMode = 'auto' | 'approval' | 'countdown'

export type DetectionStatus = 'pending' | 'approved' | 'cancelled' | 'dispatched'

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
