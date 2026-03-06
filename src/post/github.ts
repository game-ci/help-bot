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
    try {
      await execFileAsync('gh', ['issue', 'comment', String(number), '--repo', repo, '--body', body])
      recordStat('githubResponsesPosted', 1)
      // Track that the bot responded to this issue (for future cycle filtering)
      await updateState((s) => setPostedResponse(s, repo, number))
    } catch (error: any) {
      console.warn(`Failed to post GitHub response for ${repo}#${number}: ${error.message ?? error}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}
