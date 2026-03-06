import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { loadState, updateState, getDetections, getPostedInvestigations } from '../state'
import { EligibleIssue } from '../core/filter-issues'
import { makeDetectionKey } from './types'

const execFileAsync = promisify(execFile)

/**
 * Add a reaction emoji to a detection issue via GitHub API.
 * Used to show investigation status on the detection issue itself.
 *
 * Reactions: 'eyes' (investigating), 'rocket' (dispatched),
 * '+1' (approved), 'heart' (complete), 'confused' (failed)
 */
async function addReaction(
  repo: string,
  issueNumber: number,
  reaction: string,
): Promise<void> {
  try {
    await execFileAsync('gh', [
      'api',
      `repos/${repo}/issues/${issueNumber}/reactions`,
      '--method', 'POST',
      '--header', 'Accept: application/vnd.github+json',
      '--field', `content=${reaction}`,
    ])
  } catch (error: any) {
    console.warn(`  Failed to add ${reaction} reaction to #${issueNumber}: ${error.message ?? error}`)
  }
}

/**
 * React on detection issues to indicate investigation has started.
 * Adds an 'eyes' emoji to show the bot is investigating.
 */
export async function reactInvestigationStarted(options: {
  approvedIssues: EligibleIssue[]
  fullRepo: string
  targetRepo: string
  dryRun: boolean
}): Promise<void> {
  const state = await loadState()
  const detections = getDetections(state)

  for (const issue of options.approvedIssues) {
    const key = makeDetectionKey(options.fullRepo, issue.number)
    const record = detections[key]
    if (!record) continue

    if (options.dryRun) {
      console.log(`  DRY RUN: would react 'eyes' on detection #${record.detectionIssueNumber}`)
      continue
    }

    await addReaction(options.targetRepo, record.detectionIssueNumber, 'eyes')
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

/**
 * React on detection issues to indicate investigation completed successfully.
 * Adds a checkmark ('+1') emoji. Called after investigations post successfully.
 */
export async function reactInvestigationComplete(options: {
  fullRepo: string
  targetRepo: string
  dryRun: boolean
}): Promise<void> {
  const state = await loadState()
  const detections = getDetections(state)
  const postedInvestigations = getPostedInvestigations(state)

  for (const [key, record] of Object.entries(detections)) {
    if (record.status !== 'dispatched') continue
    // Only react if an investigation was actually posted for this detection
    if (!postedInvestigations[key]) continue

    if (options.dryRun) {
      console.log(`  DRY RUN: would react 'checkmark' on detection #${record.detectionIssueNumber}`)
      continue
    }

    await addReaction(options.targetRepo, record.detectionIssueNumber, 'heart')
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

/**
 * React on detection issues to indicate investigation failed.
 * Adds a 'confused' (X-like) emoji. Called when LLM or posting fails.
 */
export async function reactInvestigationFailed(options: {
  approvedIssues: EligibleIssue[]
  fullRepo: string
  targetRepo: string
  dryRun: boolean
}): Promise<void> {
  const state = await loadState()
  const detections = getDetections(state)

  for (const issue of options.approvedIssues) {
    const key = makeDetectionKey(options.fullRepo, issue.number)
    const record = detections[key]
    if (!record) continue

    if (options.dryRun) {
      console.log(`  DRY RUN: would react 'confused' on detection #${record.detectionIssueNumber}`)
      continue
    }

    await addReaction(options.targetRepo, record.detectionIssueNumber, 'confused')
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

/**
 * Mark detection records as 'dispatched' for all issues that were
 * included in the LLM manifest this cycle.
 */
export async function markDispatched(
  approvedIssues: EligibleIssue[],
  fullRepo: string,
): Promise<void> {
  await updateState((state) => {
    const detections = getDetections(state)
    const now = new Date().toISOString()
    for (const issue of approvedIssues) {
      const key = makeDetectionKey(fullRepo, issue.number)
      if (detections[key] && detections[key].status === 'approved') {
        detections[key].status = 'dispatched'
        detections[key].dispatchedAt = now
      }
    }
    state.meta ??= {}
    state.meta.detections = detections
  })
}

/**
 * After investigations complete, close detection issues with a comment
 * linking to the investigation issue (cross-linking).
 */
export async function closeDispatchedDetections(options: {
  targetRepo: string
  dryRun: boolean
}): Promise<void> {
  const state = await loadState()
  const detections = getDetections(state)
  const postedInvestigations = getPostedInvestigations(state)

  for (const [key, record] of Object.entries(detections)) {
    if (record.status !== 'dispatched') continue

    // Find corresponding investigation issue
    const investigationNumber = postedInvestigations[key]
    let closeMessage: string

    if (investigationNumber) {
      closeMessage = `Investigation dispatched and completed. See investigation issue #${investigationNumber}.\n\n` +
        `Source: https://github.com/${record.sourceRepo}/issues/${record.sourceIssueNumber}\n` +
        `Investigation: https://github.com/${options.targetRepo}/issues/${investigationNumber}\n\n` +
        '*Closed by GameCI Help Bot dispatch system*'
    } else {
      closeMessage = `Investigation dispatched.\n\n` +
        `Source: https://github.com/${record.sourceRepo}/issues/${record.sourceIssueNumber}\n\n` +
        '*Closed by GameCI Help Bot dispatch system*'
    }

    if (options.dryRun) {
      console.log(`  DRY RUN: would close detection #${record.detectionIssueNumber} for ${key}`)
      continue
    }

    try {
      await execFileAsync('gh', [
        'issue', 'close',
        String(record.detectionIssueNumber),
        '--repo', options.targetRepo,
        '--comment', closeMessage,
      ])
      console.log(`  Closed detection #${record.detectionIssueNumber} for ${key}`)
    } catch (error: any) {
      console.warn(`  Failed to close detection #${record.detectionIssueNumber}: ${error.message ?? error}`)
    }

    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

/**
 * Clean up detections for issues that are no longer eligible
 * (closed by maintainer, collaborator responded, etc.).
 */
export async function cleanupStaleDetections(options: {
  eligibleIssues: EligibleIssue[]
  fullRepo: string
  targetRepo: string
  dryRun: boolean
}): Promise<number> {
  const state = await loadState()
  const detections = getDetections(state)
  const eligibleNumbers = new Set(options.eligibleIssues.map((i) => i.number))
  let cleaned = 0

  for (const [key, record] of Object.entries(detections)) {
    if (record.sourceRepo !== options.fullRepo) continue
    if (record.status !== 'pending') continue
    if (eligibleNumbers.has(record.sourceIssueNumber)) continue

    // Source issue is no longer eligible — cancel the detection
    record.status = 'cancelled'
    record.cancelledBy = '[source-ineligible]'
    cleaned++

    if (options.dryRun) {
      console.log(`  DRY RUN: would cancel stale detection #${record.detectionIssueNumber} for ${key}`)
      continue
    }

    try {
      await execFileAsync('gh', [
        'issue', 'close',
        String(record.detectionIssueNumber),
        '--repo', options.targetRepo,
        '--comment', 'Source issue is no longer eligible (closed, collaborator responded, or filtered out). Detection cancelled.\n\n*Closed by GameCI Help Bot dispatch system*',
      ])
      console.log(`  Cancelled stale detection #${record.detectionIssueNumber} for ${key}`)
    } catch (error: any) {
      console.warn(`  Failed to cancel detection #${record.detectionIssueNumber}: ${error.message ?? error}`)
    }

    await new Promise((resolve) => setTimeout(resolve, 1000))
  }

  if (cleaned > 0) {
    await updateState((s) => {
      s.meta ??= {}
      s.meta.detections = detections
    })
  }

  return cleaned
}
