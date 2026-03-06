import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { loadState, updateState, getDetections, getPostedInvestigations } from '../state'
import { EligibleIssue } from '../core/filter-issues'
import { makeDetectionKey } from './types'

const execFileAsync = promisify(execFile)

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
