import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadState, updateState } from '../state'
import { ensureDir } from '../utils/fs'
import { DATA_DIR } from '../utils/paths'

const execFileAsync = promisify(execFile)

interface BotComment {
  commentId: string
  repo: string
  issueNumber: number
  postedAt: string
}

interface ReactionData {
  user: { login: string }
  content: string
}

export interface FeedbackRecord {
  repo: string
  issueNumber: number
  commentId: string
  postedAt: string
  thumbsUp: number
  thumbsDown: number
  thumbsUpUsers: string[]
  thumbsDownUsers: string[]
  lastChecked: string
  netSentiment: 'positive' | 'negative' | 'neutral' | 'unknown'
}

/**
 * Sync feedback reactions on all bot comments.
 * Fetches reactions via GitHub API and writes a summary file
 * that the LLM can read during investigations.
 */
export async function syncFeedback(): Promise<FeedbackRecord[]> {
  const state = await loadState()
  const botComments = (state.meta?.botComments as Record<string, BotComment>) ?? {}

  if (Object.keys(botComments).length === 0) {
    return []
  }

  const feedbackDir = join(DATA_DIR, 'feedback')
  await ensureDir(feedbackDir)

  const records: FeedbackRecord[] = []
  const feedbackState: Record<string, FeedbackRecord> = (state.meta?.feedback as Record<string, FeedbackRecord>) ?? {}

  for (const [key, comment] of Object.entries(botComments)) {
    try {
      const { stdout } = await execFileAsync('gh', [
        'api',
        `repos/${comment.repo}/issues/comments/${comment.commentId}/reactions`,
        '--header', 'Accept: application/vnd.github+json',
      ])
      const reactions: ReactionData[] = JSON.parse(stdout)

      const thumbsUp = reactions.filter(r => r.content === '+1')
      const thumbsDown = reactions.filter(r => r.content === '-1')

      const record: FeedbackRecord = {
        repo: comment.repo,
        issueNumber: comment.issueNumber,
        commentId: comment.commentId,
        postedAt: comment.postedAt,
        thumbsUp: thumbsUp.length,
        thumbsDown: thumbsDown.length,
        thumbsUpUsers: thumbsUp.map(r => r.user.login),
        thumbsDownUsers: thumbsDown.map(r => r.user.login),
        lastChecked: new Date().toISOString(),
        netSentiment: thumbsUp.length > thumbsDown.length ? 'positive'
          : thumbsDown.length > thumbsUp.length ? 'negative'
          : (thumbsUp.length > 0 || thumbsDown.length > 0) ? 'neutral'
          : 'unknown',
      }

      feedbackState[key] = record
      records.push(record)
    } catch (error: any) {
      console.warn(`  Failed to check feedback for ${key}: ${error.message ?? error}`)
    }

    // Rate limit
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  // Save feedback state
  await updateState((s) => {
    s.meta ??= {}
    s.meta.feedback = feedbackState
  })

  // Write feedback summary file for LLM consumption
  if (records.length > 0) {
    await writeFeedbackSummary(records, feedbackDir)
  }

  return records
}

/**
 * Write a human-readable feedback summary that the LLM can read
 * during investigations to understand response quality patterns.
 */
async function writeFeedbackSummary(records: FeedbackRecord[], feedbackDir: string): Promise<void> {
  const lines: string[] = []
  lines.push('# Response Feedback Summary')
  lines.push('')
  lines.push('This file contains user feedback on previous bot responses.')
  lines.push('Use this to improve future responses — learn from what worked and what didn\'t.')
  lines.push('')

  const withFeedback = records.filter(r => r.thumbsUp > 0 || r.thumbsDown > 0)
  if (withFeedback.length === 0) {
    lines.push('No feedback received yet.')
  } else {
    // Stats
    const totalUp = withFeedback.reduce((sum, r) => sum + r.thumbsUp, 0)
    const totalDown = withFeedback.reduce((sum, r) => sum + r.thumbsDown, 0)
    const positiveCount = withFeedback.filter(r => r.netSentiment === 'positive').length
    const negativeCount = withFeedback.filter(r => r.netSentiment === 'negative').length

    lines.push(`## Overall Stats`)
    lines.push('')
    lines.push(`- Responses with feedback: ${withFeedback.length}`)
    lines.push(`- Total thumbs up: ${totalUp}`)
    lines.push(`- Total thumbs down: ${totalDown}`)
    lines.push(`- Positive responses: ${positiveCount}`)
    lines.push(`- Negative responses: ${negativeCount}`)
    lines.push('')

    // Negative feedback — most important for improvement
    const negative = withFeedback.filter(r => r.netSentiment === 'negative')
    if (negative.length > 0) {
      lines.push('## Responses Needing Improvement')
      lines.push('')
      lines.push('These responses received negative feedback. Learn from these to avoid similar issues:')
      lines.push('')
      for (const r of negative) {
        lines.push(`- **${r.repo}#${r.issueNumber}**: ${r.thumbsDown} thumbs down, ${r.thumbsUp} thumbs up`)
      }
      lines.push('')
    }

    // Positive feedback — what's working
    const positive = withFeedback.filter(r => r.netSentiment === 'positive')
    if (positive.length > 0) {
      lines.push('## Well-Received Responses')
      lines.push('')
      for (const r of positive) {
        lines.push(`- **${r.repo}#${r.issueNumber}**: ${r.thumbsUp} thumbs up, ${r.thumbsDown} thumbs down`)
      }
      lines.push('')
    }
  }

  const summaryPath = join(feedbackDir, 'feedback-summary.md')
  await writeFile(summaryPath, lines.join('\n'), 'utf-8')
}
