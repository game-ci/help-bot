import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseFrontMatter } from '../utils/frontmatter'
import { RESPONSES_DIR } from '../utils/paths'

const execFileAsync = promisify(execFile)

export async function postGitHubResponses(dryRun = false): Promise<void> {
  const repoDir = join(RESPONSES_DIR, 'github')
  let files: string[] = []
  try {
    files = await readdir(repoDir)
  } catch {
    return
  }
  if (dryRun) {
    console.log('GitHub posting skipped (dry run)')
    return
  }
  for (const file of files.filter((f) => f.endsWith('.md'))) {
    const fullPath = join(repoDir, file)
    const content = await readFile(fullPath, 'utf-8')
    const { meta, body } = parseFrontMatter(content)
    const repo = typeof meta.repo === 'string' ? meta.repo : ''
    const number = Number(meta.issue_number ?? meta.number)
    if (!repo || !number) {
      console.warn(`Skipping ${file}: missing repo or issue number`)
      continue
    }

    try {
      await execFileAsync('gh', ['issue', 'comment', String(number), '--repo', repo, '--body', body])
    } catch (error: any) {
      console.warn(`Failed to post GitHub response for ${repo}#${number}: ${error.message ?? error}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}
