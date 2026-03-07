import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseFrontMatter } from '../utils/frontmatter'
import { RESPONSES_DIR } from '../utils/paths'
import { recordStat } from '../metrics'
import { updateState, setPostedResponse } from '../state'

const execFileAsync = promisify(execFile)

export interface PostGitHubOptions {
  dryRun: boolean
  allowOfficial?: boolean
  forceReplyId?: string
}

const FEEDBACK_PROMPT = '\n\n---\n<sub>Was this helpful? React with :+1: or :-1: to help improve future responses.</sub>'

export async function postGitHubResponses(options: PostGitHubOptions): Promise<void> {
  const repoDir = join(RESPONSES_DIR, 'github')
  let files: string[] = []
  try {
    files = await readdir(repoDir)
  } catch {
    return
  }
  for (const file of files.filter((f) => f.endsWith('.md') && !f.includes('-investigation'))) {
    const fullPath = join(repoDir, file)
    const content = await readFile(fullPath, 'utf-8')
    const { meta, body } = parseFrontMatter(content)
    const repo = typeof meta.repo === 'string' ? meta.repo : ''
    const number = Number(meta.issue_number ?? meta.number)
    if (!repo || !number) {
      console.warn(`Skipping ${file}: missing repo or issue number`)
      continue
    }
    const responseId = meta.response_id ?? file.replace(/\.md$/, '')
    const isOfficial = String(meta.official_response)?.toLowerCase() === 'true'
    if (isOfficial && !options.allowOfficial && options.forceReplyId !== responseId) {
      console.log(`Skipping GitHub response ${responseId} because an official collaborator already replied.`)
      recordStat('githubResponsesSkipped', 1)
      continue
    }
    if (options.dryRun) {
      console.log(`DRY RUN: would post GitHub response for ${repo}#${number}`)
      continue
    }

    // Strip any LLM-generated feedback prompt to avoid duplicates, then append ours
    const cleanedBody = body
      .replace(/<sub>\s*Was this helpful\?[^<]*<\/sub>/gi, '')
      .replace(/Was this helpful\?\s*React with[^\n]*/gi, '')
      .trim()
    const bodyWithFeedback = cleanedBody + FEEDBACK_PROMPT

    try {
      // Post comment and capture the comment URL (contains comment ID)
      const { stdout } = await execFileAsync('gh', [
        'issue', 'comment', String(number),
        '--repo', repo,
        '--body', bodyWithFeedback,
      ])
      const commentUrl = stdout.trim()
      // Extract comment ID from URL like https://github.com/.../issues/N#issuecomment-XXXXX
      const commentIdMatch = commentUrl.match(/issuecomment-(\d+)/)
      const commentId = commentIdMatch ? commentIdMatch[1] : undefined

      recordStat('githubResponsesPosted', 1)
      // Track the posted response with comment ID for feedback polling
      await updateState((s) => {
        setPostedResponse(s, repo, number)
        if (commentId) {
          s.meta ??= {}
          const botComments = (s.meta.botComments as Record<string, { commentId: string; repo: string; issueNumber: number; postedAt: string }>) ?? {}
          botComments[`${repo}#${number}`] = {
            commentId,
            repo,
            issueNumber: number,
            postedAt: new Date().toISOString(),
          }
          s.meta.botComments = botComments
        }
      })
      console.log(`Posted GitHub response for ${repo}#${number}${commentId ? ` (comment ${commentId})` : ''}`)
    } catch (error: any) {
      console.warn(`Failed to post GitHub response for ${repo}#${number}: ${error.message ?? error}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}
