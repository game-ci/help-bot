import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseFrontMatter } from '../utils/frontmatter'
import { GITHUB_DATA_DIR, DATA_DIR } from '../utils/paths'
import { getConfig, getValue } from '../config'
import { loadState, getPostedResponses, getPostedInvestigations } from '../state'

export interface FilterResult {
  eligible: EligibleIssue[]
  skippedCount: number
  skipReasons: Record<string, number>
}

export interface EligibleIssue {
  number: number
  file: string
  title: string
  author: string
  labels: string[]
  commentCount: number
  state: string
  type: string
}

export async function filterIssues(repoSlug: string): Promise<FilterResult> {
  const config = await getConfig()
  const collaborators = (getValue(config, ['github', 'collaborators'], []) as string[]).map(c => c.toLowerCase())
  const skipLabels = (getValue(config, ['github', 'skip_labels'], ['wontfix', 'invalid', 'duplicate']) as string[]).map(l => l.toLowerCase())

  const repoDir = join(GITHUB_DATA_DIR, repoSlug)
  let files: string[] = []
  try {
    files = await readdir(repoDir)
  } catch {
    return { eligible: [], skippedCount: 0, skipReasons: {} }
  }

  // Load state to check for bot's own prior responses
  const state = await loadState()
  const postedResponses = getPostedResponses(state)
  const postedInvestigations = getPostedInvestigations(state)

  // Resolve the full repo name from the slug (e.g., "game-ci-unity-builder" -> "game-ci/unity-builder")
  const fullRepoFromSlug = repoSlug.replace(/-/, '/')

  const eligible: EligibleIssue[] = []
  const skipReasons: Record<string, number> = {}

  function skip(reason: string) {
    skipReasons[reason] = (skipReasons[reason] ?? 0) + 1
  }

  const now = Date.now()
  const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000

  for (const file of files.filter(f => f.endsWith('.md'))) {
    const fullPath = join(repoDir, file)
    const content = await readFile(fullPath, 'utf-8')
    const { meta, body } = parseFrontMatter(content)

    const number = Number(meta.number)
    if (!number) continue

    const state = (meta.state ?? '').toLowerCase()
    const type = meta.type ?? 'issue'
    const author = (meta.author ?? '').toLowerCase()
    const title = meta.title ?? ''
    const commentCount = Number(meta.comment_count ?? 0)
    const updated = meta.updated ?? meta.created ?? ''
    const officialResponse = meta.official_response === 'true'

    // Parse labels from frontmatter (stored as JSON string like ["bug", "macOS"])
    let labels: string[] = []
    try {
      const rawLabels = meta.labels ?? '[]'
      labels = JSON.parse(rawLabels).map((l: string) => l.toLowerCase())
    } catch {
      labels = []
    }

    // SKIP: closed issues
    if (state === 'closed') {
      skip('closed')
      continue
    }

    // SKIP: author is a collaborator
    if (collaborators.includes(author)) {
      skip('collaborator-authored')
      continue
    }

    // SKIP: has skip labels
    if (labels.some(l => skipLabels.includes(l))) {
      skip('skip-label')
      continue
    }

    // SKIP: official_response is true (collaborator already commented)
    if (officialResponse) {
      skip('collaborator-responded')
      continue
    }

    // SKIP: double-check by scanning comment body for collaborator usernames
    // This catches cases where official_response wasn't set correctly
    const hasCollaboratorComment = collaborators.some(collab => {
      const pattern = `### @${collab} (`
      return body.toLowerCase().includes(pattern)
    })
    if (hasCollaboratorComment) {
      skip('collaborator-responded-body')
      continue
    }

    // SKIP: stale (>90 days since last update, no comments)
    if (updated) {
      const updatedTime = new Date(updated).getTime()
      if (now - updatedTime > NINETY_DAYS && commentCount === 0) {
        skip('stale')
        continue
      }
    }

    // SKIP: bot already responded to this issue (requires redispatch for follow-ups)
    // Check both posted responses and posted investigations
    const issueKey = `${fullRepoFromSlug}#${number}`
    if (postedResponses[issueKey] || postedInvestigations[issueKey]) {
      // Allow follow-up if there's new activity since bot's last response
      const botRespondedAt = postedResponses[issueKey] ?? postedInvestigations[issueKey]
      const respondedTime = new Date(botRespondedAt).getTime()
      const updatedTime = updated ? new Date(updated).getTime() : 0
      if (updatedTime <= respondedTime) {
        skip('bot-already-responded')
        continue
      }
      // New activity since bot responded — allow through (requires redispatch in approval/countdown modes)
    }

    eligible.push({
      number,
      file,
      title,
      author,
      labels,
      commentCount,
      state,
      type,
    })
  }

  return {
    eligible,
    skippedCount: Object.values(skipReasons).reduce((a, b) => a + b, 0),
    skipReasons,
  }
}

/**
 * Write a filtered issue manifest that the LLM reads instead of scanning all files.
 * This prevents the LLM from seeing or responding to issues it should skip.
 */
export async function writeFilteredManifest(repoSlug: string, result: FilterResult): Promise<string> {
  const manifestPath = join(DATA_DIR, 'github', `filtered-${repoSlug}.md`)

  const lines: string[] = []
  lines.push(`# Eligible Issues for ${repoSlug}`)
  lines.push('')
  lines.push(`Total synced: ${result.eligible.length + result.skippedCount}`)
  lines.push(`Eligible: ${result.eligible.length}`)
  lines.push(`Skipped: ${result.skippedCount}`)
  lines.push('')

  if (Object.keys(result.skipReasons).length > 0) {
    lines.push('## Skip breakdown')
    for (const [reason, count] of Object.entries(result.skipReasons)) {
      lines.push(`- ${reason}: ${count}`)
    }
    lines.push('')
  }

  lines.push('## Issues to process')
  lines.push('')
  lines.push('Process ONLY the issues listed below. Do NOT read or respond to any other issues.')
  lines.push('')

  // Sort by comment count (0 first -- unanswered), then by number (newest first)
  const sorted = [...result.eligible].sort((a, b) => {
    if (a.commentCount !== b.commentCount) return a.commentCount - b.commentCount
    return b.number - a.number
  })

  for (const issue of sorted) {
    const labelStr = issue.labels.length ? ` [${issue.labels.join(', ')}]` : ''
    lines.push(`- **#${issue.number}** (${issue.type}, ${issue.commentCount} comments${labelStr}): ${issue.title}`)
    lines.push(`  File: data/github/issues/${repoSlug}/${issue.file}`)
  }

  await writeFile(manifestPath, lines.join('\n'), 'utf-8')
  return manifestPath
}
