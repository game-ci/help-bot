import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { ensureDir } from '../utils/fs'
import { GITHUB_DATA_DIR } from '../utils/paths'
import { getConfig, getValue } from '../config'

type IssueRecord = {
  number: number
  title: string
  state: string
  labels: { name: string }[]
  author: { login: string } | null
  createdAt: string
  updatedAt: string
  body: string | null
  comments: { author: { login: string } | null; createdAt: string; body: string | null }[]
  url: string
  pullRequest?: { url: string } | null
}

const execFileAsync = promisify(execFile)

async function ghJson(args: string[]): Promise<any> {
  try {
    const { stdout } = await execFileAsync('gh', args)
    return JSON.parse(stdout)
  } catch (error: any) {
    console.error('gh command failed', error.message)
    throw error
  }
}

function escapeFrontMatter(value?: string): string {
  return (value ?? '').replace(/"/g, '\\"')
}

function formatIssue(issue: IssueRecord, repo: string): string {
  const labelNames = issue.labels.map((label) => label.name?.trim()).filter(Boolean)
  const commentCount = issue.comments.length
  let commentsSection = ''
  if (commentCount > 0) {
    commentsSection = '\n\n## Comments\n'
    for (const comment of issue.comments) {
      const author = comment.author?.login ?? 'unknown'
      const body = comment.body?.trim() ?? ''
      const date = comment.createdAt
      commentsSection += `\n### @${author} (${date})\n\n${body}\n\n---\n`
    }
  }
  const metadata = `---
title: "${escapeFrontMatter(issue.title)}"
number: ${issue.number}
state: ${issue.state}
repo: ${repo}
type: ${issue.pullRequest ? 'pull_request' : 'issue'}
labels: ${JSON.stringify(labelNames)}
author: "${escapeFrontMatter(issue.author?.login ?? 'unknown')}"
created: ${issue.createdAt}
updated: ${issue.updatedAt}
url: ${issue.url}
comment_count: ${commentCount}
---
`
  const body = issue.body ?? ''
  return `${metadata}\n${body.trim()}\n${commentsSection}`.trim() + '\n'
}

export async function syncGitHub(): Promise<void> {
  if (!process.env.GITHUB_TOKEN && !process.env.GH_TOKEN) {
    console.warn('gh CLI requires authentication. Skipping GitHub sync.')
    return
  }
  const config = await getConfig()
  const repoList = (getValue(config, ['github', 'repos'], [
    'game-ci/unity-builder',
    'game-ci/unity-test-runner',
    'game-ci/unity-actions',
    'game-ci/docker',
    'game-ci/steam-deploy',
  ]) as string[])
  const maxIssues = Number(getValue(config, ['github', 'max_issues_per_repo'], 200))

  await ensureDir(GITHUB_DATA_DIR)

  for (const repo of repoList) {
    const repoShort = repo.replace(/\//g, '-')
    const path = join(GITHUB_DATA_DIR, repoShort)
    await ensureDir(path)
    console.log(`Syncing issues for ${repo}...`)
    const issues = (await ghJson([
      'issue',
      'list',
      '--repo',
      repo,
      '--state',
      'open',
      '--limit',
      String(maxIssues),
      '--json',
      'number,title,state,labels,author,createdAt,updatedAt,body,comments,url,pullRequest',
    ])) as IssueRecord[]

    for (const issue of issues) {
      const file = join(path, `${issue.number}.md`)
      const content = formatIssue(issue, repo)
      await writeFile(file, content, 'utf-8')
    }
  }
}
