import { EligibleIssue, FilterResult } from '../core/filter-issues'
import { DispatchConfig, DispatchMode } from './types'
import { createDetections, createDiscordDetections } from './detection'
import { checkApprovals } from './approval'
import { cleanupStaleDetections } from './lifecycle'
import type { EligibleDiscordMessage, DiscordFilterResult } from '../core/filter-discord'

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

// --- Discord dispatch ---

export interface DiscordDispatchOptions {
  filterResult: DiscordFilterResult
  config: DispatchConfig
  targetRepo: string
  collaborators: string[]
  dryRun: boolean
}

export interface DiscordDispatchResult {
  /** Messages approved for LLM processing */
  approvedMessages: EligibleDiscordMessage[]
  /** Number of new detections created */
  detectionsCreated: number
  /** Number still pending */
  pending: number
  /** Number cancelled */
  cancelled: number
  /** Number auto-dispatched */
  expired: number
  /** Number of warnings posted */
  warningsPosted: number
  /** Whether to skip LLM */
  skipLlm: boolean
}

/**
 * Discord dispatch orchestrator.
 * Creates detection issues for Discord messages and checks approvals.
 * Discord dispatch NEVER uses 'auto' mode — always requires approval.
 */
export async function runDiscordDispatch(options: DiscordDispatchOptions): Promise<DiscordDispatchResult> {
  const config = { ...options.config }
  // Discord dispatch is NEVER auto — force to approval or countdown
  if (config.mode === 'auto') {
    config.mode = 'approval'
  }

  console.log(`  Discord dispatch mode: ${config.mode}`)

  // Step 1: Create detections for new eligible Discord messages
  const createResult = await createDiscordDetections({
    eligibleMessages: options.filterResult.eligible,
    targetRepo: options.targetRepo,
    config,
    dryRun: options.dryRun,
  })
  console.log(`  Discord detections created: ${createResult.created} (${createResult.skippedExisting} existing)`)

  // Step 2: Check approvals on existing Discord detections
  // We reuse the GitHub approval checking since detection issues
  // are always GitHub issues in the help-bot repo
  const { checkDiscordApprovals } = await import('./approval.js')
  const approvalResult = await checkDiscordApprovals({
    eligibleMessages: options.filterResult.eligible,
    targetRepo: options.targetRepo,
    config,
    collaborators: options.collaborators,
    dryRun: options.dryRun,
  })

  return {
    approvedMessages: approvalResult.approved,
    detectionsCreated: createResult.created,
    pending: approvalResult.pending,
    cancelled: approvalResult.cancelled,
    expired: approvalResult.expired,
    warningsPosted: approvalResult.warningsPosted,
    skipLlm: approvalResult.approved.length === 0,
  }
}
