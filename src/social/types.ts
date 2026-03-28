export type ContentStatus = 'topic_received' | 'drafting' | 'draft_ready' | 'revising' | 'approved' | 'committed' | 'discarded'

export type ContentPlatform = 'linkedin'

export interface ContentRecord {
  /** Unique content key: content:{platform}:{contentId} */
  contentKey: string
  /** Discord message ID of the notification in the admin channel */
  notificationMessageId: string
  /** Discord channel ID where the notification lives */
  notificationChannelId: string
  /** Target platform */
  platform: ContentPlatform
  /** The topic/prompt provided by the user */
  topic: string
  /** Who requested the content */
  requestedBy: string
  /** Discord user ID of requester */
  requestedByUserId: string
  /** Discord guild ID where request originated */
  sourceGuildId: string
  /** Discord channel ID where request originated */
  sourceChannelId: string
  /** Discord message ID of the original request */
  sourceMessageId: string
  /** Content lifecycle status */
  status: ContentStatus
  /** Thread ID for drafting review */
  draftThreadId?: string
  /** Path to the latest draft file (relative to repo root) */
  draftFile?: string
  /** Path to the final committed file */
  committedFile?: string
  /** Commit SHA after pushing */
  commitSha?: string
  /** Number of revision rounds */
  revisionCount: number
  /** Timestamps */
  createdAt: string
  draftStartedAt?: string
  draftCompletedAt?: string
  approvedAt?: string
  committedAt?: string
  /** Who approved */
  approvedBy?: string
}

// --- Button custom ID helpers ---

const MAX_CUSTOM_ID = 100

export type SocialAction = 'draft' | 'revise' | 'approve' | 'discard' | 'commit' | 'view'

export function buildSocialButtonId(action: SocialAction, contentId: string): string {
  const id = `social|${action}|${contentId}`
  if (id.length > MAX_CUSTOM_ID) {
    throw new Error(`Button custom_id exceeds ${MAX_CUSTOM_ID} chars: ${id.length}`)
  }
  return id
}

export function parseSocialButtonId(customId: string): { action: SocialAction; contentId: string } | null {
  if (!customId.startsWith('social|')) return null
  const parts = customId.split('|')
  if (parts.length !== 3) return null
  return { action: parts[1] as SocialAction, contentId: parts[2] }
}

/** Build a compact content ID from user ID and timestamp */
export function buildContentId(userId: string): string {
  const ts = Math.floor(Date.now() / 1000)
  return `${userId.slice(-8)}-${ts}`
}
