import { Octokit } from '@octokit/rest'
import { join } from 'node:path'
import { ensureDir, writeJson } from '../utils/fs'
import { writeFile } from 'node:fs/promises'
import { GITHUB_DATA_DIR } from '../utils/paths'
import { getConfig, getValue } from '../config'
import { loadState, saveState } from '../state'
import { recordStat } from '../metrics'

const DEFAULT_REPOS = [
  'game-ci/unity-builder',
  'game-ci/unity-test-runner',
  'game-ci/unity-actions',
  'game-ci/docker',
  'game-ci/steam-deploy',
]

const ISSUE_HEADERS = {
  accept: 'application/vnd.github.squirrel-girl-preview+json',
}

function slugRepo(repo: string): string {
  return repo.replace(/\//g, '-')
}

function escapeFrontMatter(value?: string): string {
  return (value ?? '').replace(/"/g, '\\"')
}

function summarizeReactions(source: any): Record<string, number> {
  const scores: Record<string, number> = {}
  if (Array.isArray(source)) {
    for (const reaction of source) {
      const name = reaction.content ?? 'unknown'
      scores[name] = (scores[name] ?? 0) + 1
    }
    return scores
  }
  if (source && typeof source === 'object') {
    for (const [key, value] of Object.entries(source)) {
      if (['url', 'total_count'].includes(key)) {
        continue
      }
      if (typeof value === 'number' && value > 0) {
        scores[key] = value
      }
    }
  }
  return scores
}

function formatComments(title: string, comments: any[]): string {
  if (!comments.length) {
    return ''
  }
  let section = `\n\n## ${title}\n`
  for (const comment of comments) {
    const author = comment.user?.login ?? 'unknown'
    const date = comment.created_at ?? comment.createdAt ?? 'unknown'
    const body = (comment.body ?? '').trim()
    const reactions = summarizeReactions(comment.reactions?.nodes ?? comment.reactions ?? [])
    const reactionLines = Object.entries(reactions)
      .map(([key, value]) => `${key}: ${value}`)
      .join(', ')
    section += `\n### @${author} (${date})\n`
    if (reactionLines) {
      section += `> reactions: ${reactionLines}\n\n`
    }
      section += `${body}\n\n---\n`
  }
  return section
}

function buildMetadata(issue: any, repo: string, repoShort: string, hasOfficial: boolean, reactions: Record<string, number>, commentCount: number, reviewCommentCount: number): string {
  const labelNames = (issue.labels ?? []).map((label: any) => label.name?.trim()).filter(Boolean)
  const metadata = `---
title: "${escapeFrontMatter(issue.title ?? '')}"
number: ${issue.number}
state: ${issue.state}
repo: ${repo}
type: ${issue.pull_request ? 'pull_request' : 'issue'}
labels: ${JSON.stringify(labelNames)}
author: "${escapeFrontMatter(issue.user?.login ?? 'unknown')}"
created: ${issue.created_at}
updated: ${issue.updated_at}
url: ${issue.html_url}
comment_count: ${commentCount}
review_comment_count: ${reviewCommentCount}
official_response: ${hasOfficial ? 'true' : 'false'}
reactions: ${JSON.stringify(reactions)}
response_id: "${repoShort}-${issue.number}"
---
`
  return metadata
}

export interface GitHubSyncOptions {
  repos?: string[]
}

export async function syncGitHub(options: GitHubSyncOptions = {}): Promise<void> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (!token) {
    console.warn('GitHub sync skipped: GITHUB_TOKEN/GH_TOKEN is missing.')
    return
  }
  const config = await getConfig()
  const repoList = options.repos?.length
    ? options.repos
    : (getValue(config, ['github', 'repos'], DEFAULT_REPOS) as string[])
  const collaboratorList = ((getValue(config, ['github', 'collaborators'], []) as string[]).map((entry) => entry.toLowerCase()))
  const octokit = new Octokit({ auth: token, userAgent: 'GameCI Help Bot' })
  const state = await loadState()
  state.github ??= {}
  await ensureDir(GITHUB_DATA_DIR)

  for (const repo of repoList) {
    const [owner, name] = repo.split('/')
    if (!owner || !name) {
      continue
    }
    const repoShort = slugRepo(repo)
    const repoDir = join(GITHUB_DATA_DIR, repoShort)
    await ensureDir(repoDir)
    console.log(`Syncing GitHub repo ${repo}...`)

    const repoState = state.github?.[repo] ?? {}
    const issues = await octokit.paginate(
      octokit.rest.issues.listForRepo,
      {
        owner,
        repo: name,
        state: 'all',
        since: repoState.issueCursor,
        per_page: 100,
        headers: ISSUE_HEADERS,
      },
    )

    recordStat('githubIssuesSynced', issues.length)

    for (const issue of issues) {
      const description = issue.body ?? ''
      const comments = await octokit.paginate(
        octokit.rest.issues.listComments,
        {
          owner,
          repo: name,
          issue_number: issue.number,
          since: repoState.commentCursor,
          per_page: 100,
        },
      )
      const reviewComments = issue.pull_request
        ? await octokit.paginate(
            octokit.rest.pulls.listReviewComments,
            {
              owner,
              repo: name,
              pull_number: issue.number,
              since: repoState.commentCursor,
              per_page: 100,
            },
          )
        : []

      const allAuthors = new Set<string>()
      function trackAuthor(value?: string) {
        if (!value) return
        allAuthors.add(value.toLowerCase())
      }
      trackAuthor(issue.user?.login)
      for (const comment of comments) {
        trackAuthor(comment.user?.login)
      }
      for (const review of reviewComments) {
        trackAuthor(review.user?.login)
      }

      const hasOfficial = collaboratorList.some((login) => allAuthors.has(login))

      const issueReactions = summarizeReactions(issue.reactions ?? {})

      const metadata = buildMetadata(
        issue,
        repo,
        repoShort,
        hasOfficial,
        issueReactions,
        comments.length,
        reviewComments.length,
      )

      const bodySections = [
        metadata,
        description.trim(),
        formatComments('Issue comments', comments),
        formatComments('Review comments', reviewComments),
      ].map((section) => section.trim()).filter(Boolean)

      const markdownContent = bodySections.join('\n\n')
      const markdownFile = join(repoDir, `${issue.number}.md`)
      await writeFile(markdownFile, markdownContent, 'utf-8')
    }

    const releasesDir = join(GITHUB_DATA_DIR, 'releases')
    const tagsDir = join(GITHUB_DATA_DIR, 'tags')
    await ensureDir(releasesDir)
    await ensureDir(tagsDir)

    const releases = await octokit.paginate(octokit.rest.repos.listReleases, {
      owner,
      repo: name,
      per_page: 100,
    })
    await writeJson(join(releasesDir, `${repoShort}.json`), releases)
    recordStat('githubReleasesSynced', releases.length)

    const tags = await octokit.paginate(octokit.rest.repos.listTags, {
      owner,
      repo: name,
      per_page: 100,
    })
    await writeJson(join(tagsDir, `${repoShort}.json`), tags)
    recordStat('githubTagsSynced', tags.length)

    const now = new Date().toISOString()
    state.github![repo] = {
      ...repoState,
      issueCursor: now,
      commentCursor: now,
      releaseCursor: now,
      tagCursor: now,
    }
  }

  await saveState(state)
}
