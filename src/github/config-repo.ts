import { GitHub } from '@octokit/rest'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Configuration repo consumer module.
 * Fetches PRs/branches from a config repository and applies their configurations.
 * Handles auto-merge for validated configuration PRs.
 */

export interface ConfigRepoConfig {
  /** URL or owner/repo format (e.g., 'game-ci/help-bot-config') */
  repo: string
  /** GitHub authentication token */
  token: string
  /** Branch to fetch config from (defaults to main) */
  branch?: string
  /** Auto-merge PRs that pass validation checks */
  autoMergeEnabled?: boolean
  /** Minimum approval count for auto-merge */
  minApprovals?: number
}

export interface ConfigUpdateResult {
  success: boolean
  appliedPath?: string
  message?: string
  errors?: string[]
}

/**
 * Initialize GitHub client with token.
 */
function createGitHubClient(token: string): GitHub {
  return new GitHub({
    auth: `Bearer ${token}`,
  })
}

/**
 * Fetch the latest config.json from a remote repository branch.
 */
export async function fetchConfigFromRepo(configRepo: ConfigRepoConfig): Promise<Record<string, unknown> | null> {
  const client = createGitHubClient(configRepo.token)
  
  try {
    const owner = configRepo.repo.split('/')[0]
    const repoName = configRepo.repo.split('/')[1]
    const branch = configRepo.branch || 'main'
    
    // Get contents of config.json from the specified branch
    const contents = await client.repos.getContents({
      owner,
      repo: repoName,
      path: 'config.json',
      ref: branch,
    })

    const decoded = Buffer.from(contents.data.content, 'base64').toString('utf-8')
    return JSON.parse(decoded)
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    
    // Handle common GitHub API errors gracefully
    if (errorMessage.includes('Not Found') || errorMessage.includes('resource_not_found')) {
      console.warn(`Config repo '${configRepo.repo}' not found. Using local config.`)
      return null
    } else if (errorMessage.includes('unauthenticated') || errorMessage.includes('rate limit')) {
      throw new Error(`GitHub authentication failed for config repo: ${error}`)
    }
    
    console.warn(`Failed to fetch config from repo '${configRepo.repo}': ${errorMessage}`)
    return null
  }
}

/**
 * Create a PR with the specified configuration.
 */
export async function createConfigPR(
  client: GitHub,
  repoName: string,
  title: string,
  body: string,
  configPath: string,
  baseBranch: string,
  branch: string
): Promise<{ prNumber: number; url: string }> {
  const owner = repoName.split('/')[0]

  // Create a new branch based on the commit SHA or current date
  let defaultBranch: string | undefined
  try {
    const { data: head } = await client.repos.get({ owner, repo: repoName })
    defaultBranch = head.default_branch
  } catch {
    console.warn('Could not determine default branch, using main')
    defaultBranch = 'main'
  }

  // Create commit and push
  await client.git.createRef({
    owner,
    repo: repoName,
    ref: `refs/heads/${branch}`,
    sha: defaultBranch!,
  })

  const filesToStage = [configPath]
  
  for (const filePath of filesToStage) {
    const contentsFile = await client.repos.getContent({
      owner,
      repo: repoName,
      path: filePath,
    })
    
    const decodedContent = Buffer.from(contentsFile.data.content, 'base64').toString('utf-8')

    await client.git.createBlob({
      owner,
      repo: repoName,
      content: encodedContent(decodedContent),
    })
  }

  await client.repos.createOrUpdateFile({
    owner,
    repo: repoName,
    path: configPath,
    message: title,
    sha: contentsFile?.data.sha,
    branch: defaultBranch!,
  })

  // Create PR
  const { data: pr } = await client.pulls.create({
    owner,
    repo: repoName,
    title,
    body,
    head: `${branch}:${repoName}`,
    base: baseBranch,
  })

  return {
    prNumber: pr.number,
    url: pr.html_url,
  }
}

/**
 * Auto-merge a PR after validation.
 */
export async function autoMergePR(
  client: GitHub,
  repoName: string,
  prNumber: number,
  mergeMethod: 'merge' | 'rebase' | 'squash' = 'merge'
): Promise<void> {
  const owner = repoName.split('/')[0]

  await client.pulls.merge({
    owner,
    repo: repoName,
    pull_number: prNumber,
    merge_method: mergeMethod,
  })
}

/**
 * Validate a configuration object before applying it.
 */
export async function validateConfig(
  config: Record<string, unknown>,
  configRepo: ConfigRepoConfig
): Promise<{ valid: boolean; message?: string; violations?: string[] }> {
  const violations: string[] = []

  // Check required fields based on deployment environment
  if (!config.discord?.system_prompt) {
    violations.push('Missing required field: discord.system_prompt')
  }

  if (!config.github?.repos?.length && !config.github?.repos) {
    violations.push('Missing or empty github.repos array')
  }

  // Check for sensitive data that shouldn't be in the config repo
  if (config.notifications?.discord_dm?.recipients && config.notifications.discord_dm.recipients.length > 0) {
    violations.push('Discord DM recipients should not be stored in public config repo')
  }

  if (config.triage?.acknowledge_user === true) {
    // This is allowed but flagged for review
    violations.push('Triage acknowledgement enabled - requires admin approval')
  }

  return {
    valid: violations.length === 0,
    message: violations.length === 0 ? 'Configuration validated successfully' : `Validation failed with ${violations.length} issue(s)`,
    violations,
  }
}

/**
 * Process config repo PRs and handle auto-merge based on configuration.
 */
export async function processConfigPRs(
  client: GitHub,
  repoName: string,
  owner: string,
  configRepo: ConfigRepoConfig
): Promise<{ merged: number; rejected: number; errors: string[] }> {
  const result = {
    merged: 0,
    rejected: 0,
    errors: [],
  }

  const configBranch = configRepo.branch || 'main'
  const baseBranch = configBranch === 'main' ? 'develop' : 'main'

  try {
    // List open PRs for the repo
    const { data: pullRequests } = await client.pulls.listForRepo({
      owner,
      repo: repoName,
      state: 'open',
      per_page: 100,
    })

    for (const pr of pullRequests) {
      // Skip non-configuration PRs
      if (!pr.title.toLowerCase().includes('config')) continue

      const configData = await fetchConfigFromRepo({
        repo: `${owner}/${repoName}`,
        token: configRepo.token,
        branch: pr.head.ref,
      })

      if (!configData) {
        continue
      }

      // Validate the configuration
      const validation = await validateConfig(configData, configRepo)
      
      if (!validation.valid) {
        console.log(`Rejected PR #${pr.number} (${pr.title}): ${validation.message}`)
        result.rejected++
        continue
      }

      // Auto-merge if enabled and requirements met
      if (configRepo.autoMergeEnabled && pr.mergeable === true) {
        try {
          console.log(`Merging PR #${pr.number} automatically`)
          await autoMergePR(client, repoName, pr.number)
          result.merged++
        } catch (error: unknown) {
          const errorMsg = error instanceof Error ? error.message : String(error)
          console.error(`Failed to merge PR #${pr.number}: ${errorMsg}`)
          result.errors.push(`Merge failed for PR #${pr.number}: ${errorMsg}`)
        }
      } else {
        // Mark as ready for manual review if needed
        try {
          await client.repos.updateFile({
            owner,
            repo: repoName,
            path: '.github/PR-STATUS',
            message: 'Marking PR #' + pr.number + ' as ready for review',
            content: `PR #${pr.number} (base ${baseBranch}) needs manual review`,
            sha: '', // Will read current file or create
          })
        } catch {
          // File may not exist, that's okay
        }
      }
    }
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.error(`Error processing config PRs: ${errorMsg}`)
    result.errors.push(errorMsg)
  }

  return result
}

/**
 * Helper to encode content for Git API (add line ending normalization).
 */
function encodedContent(content: string): string {
  // Ensure Unix line endings and normalize CRLF to LF
  return content.replace(/\r\n/g, '\n')
}
