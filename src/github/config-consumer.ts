import { GitHub } from '@octokit/rest'
import { loadRemoteConfig, validateConfig, mergeConfigs } from '../config/config-repo'
import type { ConfigRepoConfig } from '../config/config-repo'

/**
 * Config repo consumer module.
 * Automatically processes configuration PRs from help-bot-config repository.
 */

export interface ConfigConsumerOptions {
  /** GitHub token for API access */
  githubToken: string
  /** Repository owner (e.g., 'game-ci') */
  owner?: string
  /** Configuration repository name (e.g., 'help-bot-config') */
  configRepo?: string
  /** Branch to fetch config from */
  branch?: string
  /** Auto-merge validated PRs */
  autoMerge?: boolean
}

/**
 * Initialize GitHub client.
 */
export function createGitHubClient(token: string): GitHub {
  return new GitHub({ auth: `Bearer ${token}` })
}

/**
 * Process configuration PRs and handle auto-merging.
 */
export async function processConfigPRs(
  client: GitHub,
  owner: string,
  repoName: string,
  options: ConfigConsumerOptions
): Promise<{ merged: number; rejected: number }> {
  const configBranch = options.branch || 'main'
  
  try {
    // List open PRs for the config repo
    const { data: pullRequests } = await client.pulls.listForRepo({
      owner,
      repo: repoName,
      state: 'open',
      per_page: 100,
    })

    let merged = 0
    let rejected = 0

    for (const pr of pullRequests) {
      // Skip non-config PRs
      if (!pr.title.toLowerCase().includes('config') && 
          !pr.body?.toLowerCase().includes('configuration')) continue

      try {
        // Fetch the config file from the PR branch
        const remoteConfig = await loadRemoteConfig(owner, repoName, options.githubToken, pr.head.ref)
        
        if (!remoteConfig) {
          console.log(`PR #${pr.number}: No config.json found in ${pr.head.ref}`)
          rejected++
          continue
        }

        // Validate the configuration
        const validation = await validateConfig(remoteConfig, options)
        
        if (!validation.valid) {
          console.log(
            `PR #${pr.number} (${pr.title}): Rejected - ${validation.message ?? 'Validation failed'}`
          )
          rejected++
          continue
        }

        // Auto-merge validated PR
        if (options.autoMerge && pr.mergeable === true) {
          console.log(`Merging validated PR #${pr.number}: ${pr.title}`)
          
          try {
            await client.pulls.merge({
              owner,
              repo: repoName,
              pull_number: pr.number,
              merge_method: 'merge',
            })
            merged++
          } catch (error: unknown) {
            const errorMsg = error instanceof Error ? error.message : String(error)
            console.error(`Failed to merge PR #${pr.number}:`, errorMsg)
          }
        } else {
          console.log(`PR #${pr.number} validated but requires manual review.`)
        }

      } catch (error: unknown) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        console.error(`Error processing PR #${pr.number}:`, errorMsg)
      }
    }

    return { merged, rejected }
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.error(`Failed to process config PRs:`, errorMsg)
    throw error
  }
}

/**
 * Fetch current configuration from the config repo branch.
 */
export async function fetchConfigFromBranch(
  client: GitHub,
  owner: string,
  repoName: string,
  branch: string
): Promise<ConfigRepoConfig | null> {
  try {
    const { data: content } = await client.repos.getContents({
      owner,
      repo: repoName,
      path: 'config.json',
      ref: branch,
    })

    if (!content || !content.type === 'file') {
      console.warn(`Config not found in ${owner}/${repoName}:${branch}`)
      return null
    }

    const decoded = Buffer.from(content.content, 'base64').toString('utf-8')
    return JSON.parse(decoded) as ConfigRepoConfig
  } catch (error: unknown) {
    console.warn(`Failed to fetch config from ${owner}/${repoName}:${branch}`)
    return null
  }
}

/**
 * Get configuration PR number for current changes.
 */
export async function findCurrentConfigPR(
  client: GitHub,
  owner: string,
  repoName: string
): Promise<{ prNumber?: number; prUrl?: string } | null> {
  try {
    const { data: pullRequests } = await client.pulls.listForRepo({
      owner,
      repo: repoName,
      state: 'open',
      per_page: 30,
      sort: 'created',
      direction: 'desc',
    })

    for (const pr of pullRequests) {
      // Check if this PR contains config.json
      const files = pr.files
      if (!files || files.length === 0) continue
      
      const hasConfigFile = files.some((f) => 
        f.filename === 'config.json'
      )

      if (hasConfigFile) {
        return {
          prNumber: pr.number,
          prUrl: pr.html_url,
        }
      }
    }

    return null
  } catch (error: unknown) {
    console.error(`Failed to find config PR:`, error)
    return null
  }
}

/**
 * Mark a config PR as ready for review by adding a comment.
 */
export async function markConfigReadyForReview(
  client: GitHub,
  owner: string,
  repoName: string,
  prNumber: number
): Promise<void> {
  try {
    await client.issues.createComment({
      owner,
      repo: repoName,
      issue_number: prNumber,
      body: '🤖 Auto-validation: Configuration validated and ready for manual review. Please check before merging.',
    })
  } catch (error: unknown) {
    console.error(`Failed to mark PR #${prNumber} as ready for review:`, error)
    throw error
  }
}
