import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { loadState, updateState, getDetections } from '../state'
import { recordStat } from '../metrics'
import { EligibleIssue } from '../core/filter-issues'
import { DispatchConfig, DetectionRecord, makeDetectionKey, makeDiscordDetectionKey } from './types'
import { buildWarningComment } from './sanitize'
import type { EligibleDiscordMessage } from '../core/filter-discord'

const execFileAsync = promisify(execFile)

interface GitHubReaction {
  user: { login: string }
  content: string
}

interface GitHubComment {
  user: { login: string }
  body: string
}

export interface CheckApprovalsOptions {
  eligibleIssues: EligibleIssue[]
  fullRepo: string
  targetRepo: string
  config: DispatchConfig
  collaborators: string[]
  dryRun: boolean
}

export interface CheckApprovalsResult {
  approved: EligibleIssue[]
  pending: number
  cancelled: number
  expired: number
  warningsPosted: number
}

/**
 * Fetch reactions on a GitHub issue via gh api.
 */
async function fetchReactions(repo: string, issueNumber: number): Promise<GitHubReaction[]> {
  try {
    const { stdout } = await execFileAsync('gh', [
      'api',
      `repos/${repo}/issues/${issueNumber}/reactions`,
      '--header', 'Accept: application/vnd.github+json',
    ])
    return JSON.parse(stdout)
  } catch {
    return []
  }
}

/**
 * Fetch comments on a GitHub issue via gh api.
 */
async function fetchComments(repo: string, issueNumber: number): Promise<GitHubComment[]> {
  try {
    const { stdout } = await execFileAsync('gh', [
      'api',
      `repos/${repo}/issues/${issueNumber}/comments`,
      '--header', 'Accept: application/vnd.github+json',
    ])
    return JSON.parse(stdout)
  } catch {
    return []
  }
}

/**
 * Post a comment on a GitHub issue.
 */
async function postComment(repo: string, issueNumber: number, body: string): Promise<void> {
  await execFileAsync('gh', [
    'issue', 'comment',
    String(issueNumber),
    '--repo', repo,
    '--body', body,
  ])
}

/**
 * Core approval/countdown logic for a single detection record.
 * Returns: 'approved' | 'cancelled' | 'pending' | 'expired'
 */
async function processDetection(
  record: DetectionRecord,
  key: string,
  options: {
    targetRepo: string
    config: DispatchConfig
    collaborators: string[]
    dryRun: boolean
  },
): Promise<{ result: 'approved' | 'cancelled' | 'pending' | 'expired'; approvedBy?: string; cancelledBy?: string; warningPosted: boolean }> {
  const collaboratorsLower = options.collaborators.map((c) => c.toLowerCase())

  // Check reactions from collaborators
  const reactions = await fetchReactions(options.targetRepo, record.detectionIssueNumber)
  let approved = false
  let cancelled = false
  let approvedBy: string | undefined
  let cancelledBy: string | undefined

  for (const reaction of reactions) {
    const login = reaction.user.login.toLowerCase()
    if (!collaboratorsLower.includes(login)) continue

    if (options.config.approve_reactions.includes(reaction.content)) {
      approved = true
      approvedBy = reaction.user.login
      break
    }
    if (options.config.cancel_reactions.includes(reaction.content)) {
      cancelled = true
      cancelledBy = reaction.user.login
      break
    }
  }

  // Check comments from collaborators (any comment = approval)
  if (!approved && !cancelled) {
    const comments = await fetchComments(options.targetRepo, record.detectionIssueNumber)
    for (const comment of comments) {
      const login = comment.user.login.toLowerCase()
      if (!collaboratorsLower.includes(login)) continue
      // Skip bot-generated warning comments
      if (comment.body.includes('GameCI Help Bot dispatch system')) continue
      approved = true
      approvedBy = comment.user.login
      break
    }
  }

  if (cancelled) {
    return { result: 'cancelled', cancelledBy, warningPosted: false }
  }

  if (approved) {
    return { result: 'approved', approvedBy, warningPosted: false }
  }

  // Countdown mode: advance stages if time has elapsed
  if (options.config.mode === 'countdown') {
    const now = Date.now()
    const stageAdvancedAt = new Date(record.stageAdvancedAt).getTime()
    const intervalMs = record.warningIntervalHours * 60 * 60 * 1000
    const elapsed = now - stageAdvancedAt

    if (elapsed >= intervalMs) {
      if (record.currentStage < record.warningsRequired) {
        // Post warning and advance one stage
        const nextStage = record.currentStage + 1

        if (!options.dryRun) {
          try {
            const warningBody = buildWarningComment({
              stage: nextStage,
              totalStages: record.warningsRequired,
              intervalHours: record.warningIntervalHours,
              sourceRepo: record.sourceRepo,
              sourceNumber: record.sourceIssueNumber,
              createdAt: record.createdAt,
              approveReactions: options.config.approve_reactions,
              cancelReactions: options.config.cancel_reactions,
            })
            await postComment(options.targetRepo, record.detectionIssueNumber, warningBody)
            console.log(`  Detection ${key}: posted warning ${nextStage}/${record.warningsRequired}`)
          } catch (error: any) {
            console.warn(`  Failed to post warning for ${key}: ${error.message ?? error}`)
          }
        } else {
          console.log(`  DRY RUN: would post warning ${nextStage}/${record.warningsRequired} for ${key}`)
        }

        record.currentStage = nextStage
        record.stageAdvancedAt = new Date().toISOString()
        return { result: 'pending', warningPosted: true }
      } else {
        // All warnings posted and final interval elapsed — auto-approve
        return { result: 'expired', approvedBy: '[auto-dispatch]', warningPosted: false }
      }
    }
  }

  return { result: 'pending', warningPosted: false }
}

/**
 * Check all pending GitHub detections for approval reactions/comments.
 * For countdown mode, advance stages and post warnings.
 * Returns the subset of eligible issues that have been approved.
 */
export async function checkApprovals(options: CheckApprovalsOptions): Promise<CheckApprovalsResult> {
  const state = await loadState()
  const detections = getDetections(state)

  const result: CheckApprovalsResult = {
    approved: [],
    pending: 0,
    cancelled: 0,
    expired: 0,
    warningsPosted: 0,
  }

  for (const issue of options.eligibleIssues) {
    const key = makeDetectionKey(options.fullRepo, issue.number)
    const record = detections[key]

    if (!record) continue // No detection yet — will be created by createDetections
    if (record.status === 'dispatched') continue // Already dispatched
    if (record.status === 'cancelled') {
      result.cancelled++
      continue
    }

    const processResult = await processDetection(record, key, {
      targetRepo: options.targetRepo,
      config: options.config,
      collaborators: options.collaborators,
      dryRun: options.dryRun,
    })

    switch (processResult.result) {
      case 'cancelled':
        record.status = 'cancelled'
        record.cancelledBy = processResult.cancelledBy
        result.cancelled++
        recordStat('detectionsCancelled')
        console.log(`  Detection ${key}: cancelled by ${processResult.cancelledBy}`)
        break

      case 'approved':
        record.status = 'approved'
        record.approvedBy = processResult.approvedBy
        result.approved.push(issue)
        recordStat('detectionsApproved')
        console.log(`  Detection ${key}: approved by ${processResult.approvedBy}`)
        break

      case 'expired':
        record.status = 'approved'
        record.approvedBy = processResult.approvedBy
        result.approved.push(issue)
        result.expired++
        recordStat('detectionsExpired')
        console.log(`  Detection ${key}: auto-dispatched (all ${record.warningsRequired} stages elapsed)`)
        break

      case 'pending':
        result.pending++
        recordStat('detectionsPending')
        if (processResult.warningPosted) {
          result.warningsPosted++
          recordStat('detectionsWarningsPosted')
        }
        break
    }

    // Rate limit between API calls
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  // Save updated state
  await updateState((s) => {
    s.meta ??= {}
    s.meta.detections = detections
  })

  return result
}

// --- Discord approval checking ---

export interface CheckDiscordApprovalsOptions {
  eligibleMessages: EligibleDiscordMessage[]
  targetRepo: string
  config: DispatchConfig
  collaborators: string[]
  dryRun: boolean
}

export interface CheckDiscordApprovalsResult {
  approved: EligibleDiscordMessage[]
  pending: number
  cancelled: number
  expired: number
  warningsPosted: number
}

/**
 * Check Discord detection issues for approval.
 * Same mechanics as GitHub but uses Discord detection keys.
 */
export async function checkDiscordApprovals(options: CheckDiscordApprovalsOptions): Promise<CheckDiscordApprovalsResult> {
  const state = await loadState()
  const detections = getDetections(state)

  const result: CheckDiscordApprovalsResult = {
    approved: [],
    pending: 0,
    cancelled: 0,
    expired: 0,
    warningsPosted: 0,
  }

  for (const msg of options.eligibleMessages) {
    const key = makeDiscordDetectionKey(
      msg.discord.guildName,
      msg.discord.channelName,
      msg.messageId,
    )
    const record = detections[key]

    if (!record) continue
    if (record.status === 'dispatched') continue
    if (record.status === 'cancelled') {
      result.cancelled++
      continue
    }

    const processResult = await processDetection(record, key, {
      targetRepo: options.targetRepo,
      config: options.config,
      collaborators: options.collaborators,
      dryRun: options.dryRun,
    })

    switch (processResult.result) {
      case 'cancelled':
        record.status = 'cancelled'
        record.cancelledBy = processResult.cancelledBy
        result.cancelled++
        recordStat('detectionsCancelled')
        console.log(`  Discord detection ${key}: cancelled by ${processResult.cancelledBy}`)
        break

      case 'approved':
        record.status = 'approved'
        record.approvedBy = processResult.approvedBy
        result.approved.push(msg)
        recordStat('detectionsApproved')
        console.log(`  Discord detection ${key}: approved by ${processResult.approvedBy}`)
        break

      case 'expired':
        record.status = 'approved'
        record.approvedBy = processResult.approvedBy
        result.approved.push(msg)
        result.expired++
        recordStat('detectionsExpired')
        console.log(`  Discord detection ${key}: auto-dispatched`)
        break

      case 'pending':
        result.pending++
        recordStat('detectionsPending')
        if (processResult.warningPosted) {
          result.warningsPosted++
          recordStat('detectionsWarningsPosted')
        }
        break
    }

    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  // Save updated state
  await updateState((s) => {
    s.meta ??= {}
    s.meta.detections = detections
  })

  return result
}
