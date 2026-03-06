import { EligibleIssue, FilterResult } from '../core/filter-issues'
import { DispatchConfig, DispatchMode } from './types'
import { createDetections } from './detection'
import { checkApprovals } from './approval'
import { cleanupStaleDetections } from './lifecycle'

export interface DispatchOptions {
  filterResult: FilterResult
  repoSlug: string
  fullRepo: string
  config: DispatchConfig
  targetRepo: string
  collaborators: string[]
  dryRun: boolean
}

export interface DispatchResult {
  /** Issues approved for LLM processing */
  approved: EligibleIssue[]
  /** Number of new detections created */
  detectionsCreated: number
  /** Number still pending */
  pending: number
  /** Number cancelled */
  cancelled: number
  /** Number auto-dispatched (countdown expired) */
  expired: number
  /** Number of warnings posted this cycle */
  warningsPosted: number
  /** Whether to skip LLM (no approved issues) */
  skipLlm: boolean
}

/**
 * Main dispatch orchestrator. Called from cycle.ts after filtering.
 *
 * For 'auto' mode: returns all eligible issues immediately (passthrough).
 * For 'approval'/'countdown' modes:
 *   1. Creates detection issues for new eligible issues
 *   2. Cleans up stale detections (source no longer eligible)
 *   3. Checks approvals on existing detections
 *   4. Returns only approved issues
 */
export async function runDispatch(options: DispatchOptions): Promise<DispatchResult> {
  // Auto mode: passthrough — no dispatch gate
  if (options.config.mode === 'auto') {
    return {
      approved: options.filterResult.eligible,
      detectionsCreated: 0,
      pending: 0,
      cancelled: 0,
      expired: 0,
      warningsPosted: 0,
      skipLlm: false,
    }
  }

  console.log(`  Dispatch mode: ${options.config.mode}`)

  // Step 1: Create detections for new eligible issues
  const createResult = await createDetections({
    eligibleIssues: options.filterResult.eligible,
    repoSlug: options.repoSlug,
    fullRepo: options.fullRepo,
    targetRepo: options.targetRepo,
    config: options.config,
    dryRun: options.dryRun,
  })
  console.log(`  Detections created: ${createResult.created} (${createResult.skippedExisting} existing, ${createResult.skippedInvestigated} investigated, ${createResult.skippedLimit} over limit)`)

  // Step 2: Clean up stale detections
  const staleCount = await cleanupStaleDetections({
    eligibleIssues: options.filterResult.eligible,
    fullRepo: options.fullRepo,
    targetRepo: options.targetRepo,
    dryRun: options.dryRun,
  })
  if (staleCount > 0) {
    console.log(`  Stale detections cleaned: ${staleCount}`)
  }

  // Step 3: Check approvals / advance countdown stages
  const approvalResult = await checkApprovals({
    eligibleIssues: options.filterResult.eligible,
    fullRepo: options.fullRepo,
    targetRepo: options.targetRepo,
    config: options.config,
    collaborators: options.collaborators,
    dryRun: options.dryRun,
  })

  return {
    approved: approvalResult.approved,
    detectionsCreated: createResult.created,
    pending: approvalResult.pending,
    cancelled: approvalResult.cancelled,
    expired: approvalResult.expired,
    warningsPosted: approvalResult.warningsPosted,
    skipLlm: approvalResult.approved.length === 0,
  }
}
