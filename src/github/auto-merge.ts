import { GitHub } from '@octokit/rest'
import { readFile, writeFile, readdir, lstat, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Auto-merge service for help-bot.
 * Handles automatic merging of PRs that meet configuration criteria.
 */

export interface AutoMergeConfig {
  /** Repository name (owner/repo format) */
  repo: string
  /** GitHub token */
  token: string
  /** Branches to consider for auto-merge */
  targetBranches?: string[]
  /** Minimum approvals required */
  minApprovals?: number
  /** Auto-approve labels (optional) */
  autoApproveLabels?: string[]
  /** Skip merge if there are failing CI checks */
  requireGreenCI?: boolean
  /** Merge method: 'merge', 'rebase', or 'squash' */
  mergeMethod?: 'merge' | 'rebase' | 'squash'
}

export interface AutoMergeResult {
  mergedPRs: number
  rejectedPRs: number
  skippedPRs: number
  errors: string[]
}

/**
 * Initialize GitHub client with token.
 */
function createGitHubClient(token: string): GitHub {
  return new GitHub({ auth: `Bearer ${token}` })
}

/**
 * Check if a PR meets the criteria for auto-merge.
 */
export async function isReadyForAutoMerge(
  pr: Awaited<ReturnType<typeof GitHub.prototype.pulls.get>>['data'],
  config: AutoMergeConfig
): Promise<{ ready: boolean; reason?: string }> {
  const {
    minApprovals = 1,
    autoApproveLabels = [],
    requireGreenCI = true,
  } = config

  // Check mergeability
  if (!pr.mergeable) {
    return {
      ready: false,
      reason: `PR is not mergeable. Current state: ${pr.mergeable_state || 'unknown'}`,
    }
  }

  // Check for auto-approve labels
  const hasAutoApprove = pr.labels.some((label) =>
    autoApproveLabels.includes(label.name.toLowerCase())
  )
  if (hasAutoApprove) {
    return { ready: true, reason: 'Has auto-approve label' }
  }

  // Check minimum approvals
  const approvalCount = pr.reviews.filter((review) => review.state === 'APPROVED').length
  if (approvalCount < minApprovals) {
    return {
      ready: false,
      reason: `Insufficient approvals: ${approvalCount}/${minApprovals}`,
    }
  }

  // Check CI status
  if (requireGreenCI && pr.head.repo.name === pr.base.repo.name) {
    const { data: statuses } = await githubClient.pulls.listCommitStatusesForHead({
      owner: pr.head.repo.owner.login,
      repo: pr.head.repo.name,
      sha: pr.head.sha,
    })

    const hasFailingChecks = statuses.some(
      (status) => status.state === 'error' || status.state === 'failure'
    )
    if (hasFailingChecks) {
      return {
        ready: false,
        reason: 'CI checks are failing',
      }
    }
  }

  // Check for conflict markers or merge conflicts
  const state = pr.mergeable_state
  if (state === 'behind' || state === 'blocked') {
    return {
      ready: false,
      reason: `PR is ${state.toLowerCase()}`,
    }
  }

  return { ready: true, reason: 'All criteria met' }
}

/**
 * Merge a PR with automatic merge method selection.
 */
export async function mergePR(
  githubClient: GitHub,
  repoName: string,
  prNumber: number,
  config: AutoMergeConfig
): Promise<void> {
  const owner = repoName.split('/')[0]
  const mergeMethod = config.mergeMethod || 'merge'

  try {
    await githubClient.pulls.merge({
      owner,
      repo: repoName,
      pull_number: prNumber,
      merge_method: mergeMethod as 'merge' | 'rebase' | 'squash',
    })
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to merge PR #${prNumber}: ${errorMsg}`)
  }
}

/**
 * Close a PR without merging when it's not ready.
 */
export async function closePR(
  githubClient: GitHub,
  repoName: string,
  prNumber: number,
  comment?: string
): Promise<void> {
  const owner = repoName.split('/')[0]

  let commentText = comment || 'Auto-closing PR due to merge criteria not being met.'

  try {
    await githubClient.repos.updateFile({
      owner,
      repo: repoName,
      path: `.github/PR-STATUS-${prNumber}.md`,
      message: `Closed PR #${prNumber}`,
      content: Buffer.from(commentText).toString('base64'),
      sha: '', // Creates file if doesn't exist
    })

    // Optionally close the PR
    await githubClient.pulls.update({
      owner,
      repo: repoName,
      pull_number: prNumber,
      state: 'closed',
    })
  } catch (error: unknown) {
    console.warn(`Failed to auto-close PR #${prNumber}:`, error)
  }
}

/**
 * Process all open PRs and handle auto-merging.
 */
export async function processPRsForAutoMerge(
  githubClient: GitHub,
  repoName: string,
  owner: string,
  config: AutoMergeConfig
): Promise<AutoMergeResult> {
  const result = {
    mergedPRs: 0,
    rejectedPRs: 0,
    skippedPRs: 0,
    errors: [],
  }

  const targetBranches = config.targetBranches || ['main']
  const minApprovals = config.minApprovals ?? 1
  const mergeMethod = config.mergeMethod || 'merge'
  const repoState = await githubClient.repos.get({ owner, repo: repoName })
  const defaultBranch = repoState.data.default_branch

  try {
    // List all open PRs for the repo
    const { data: pullRequests } = await githubClient.pulls.listForRepo({
      owner,
      repo: repoName,
      state: 'open',
      per_page: 100,
    })

    for (const pr of pullRequests) {
      try {
        // Check if PR is targeting a relevant branch
        if (!targetBranches.includes(pr.base.ref)) {
          result.skippedPRs++
          continue
        }

        // Check readiness for auto-merge
        const readiness = await isReadyForAutoMerge(pr, config)

        if (!readiness.ready) {
          // Log rejection reason but don't close automatically to avoid noise
          console.log(
            `Skipped PR #${pr.number} (${pr.title}): ${readiness.reason}`
          )
          result.rejectedPRs++
          continue
        }

        // Auto-merge the PR
        console.log(`Merging PR #${pr.number}: ${pr.title}`)
        try {
          await mergePR(githubClient, repoName, pr.number, config)
          result.mergedPRs++
        } catch (error: unknown) {
          const errorMsg = error instanceof Error ? error.message : String(error)
          console.error(`Error merging PR #${pr.number}: ${errorMsg}`)
          
          // Optionally close with comment on merge error
          if (config.autoMergeEnabled === false && errorMsg.includes('merge_base_sh')) {
            await closePR(githubClient, repoName, pr.number, 
              `Auto-merge failed: ${errorMsg}. PR closed automatically.`
            )
          }
          
          result.errors.push(`Merge #${pr.number}: ${errorMsg}`)
        }
      } catch (error: unknown) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        console.error(`Error processing PR #${pr.number}:`, errorMsg)
        result.errors.push(errorMsg)
      }
    }
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.error('Failed to list PRs:', errorMsg)
    result.errors.push(`List PRs failed: ${errorMsg}`)
  }

  return result
}

/**
 * Load auto-merge configuration from config file.
 */
export async function loadAutoMergeConfig(
  configPath: string = join(process.cwd(), 'config.json')
): Promise<AutoMergeConfig> {
  const configContent = await readFile(configPath, 'utf-8')
  const config = JSON.parse(configContent)

  // Extract auto-merge settings from config
  const githubConfig = config.github as Record<string, unknown> || {}
  
  return {
    repo: String(githubConfig.repo || githubConfig.remote_repo || '').split('/').slice(-1)[0],
    token: process.env.GITHUB_TOKEN || '',
    targetBranches: ['main', 'develop'].filter(Boolean) as string[],
    minApprovals: githubConfig.auto_merge_min_approvals ?? 1,
    autoApproveLabels: (githubConfig.auto_approve_labels as string[])?.filter(Boolean),
    requireGreenCI: githubConfig.require_green_ci !== false,
    mergeMethod: ('merge' | 'rebase' | 'squash') ?? 'merge',
    autoMergeEnabled: true,
  }
}
