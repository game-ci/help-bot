import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseFrontMatter } from '../utils/frontmatter'
import { RESPONSES_DIR } from '../utils/paths'
import { recordStat } from '../metrics'
import { loadState, updateState } from '../state'

const execFileAsync = promisify(execFile)

export interface PostInvestigationOptions {
  dryRun: boolean
  targetRepo: string
  labels: string[]
}

/**
 * Attempt to read a file, returning empty string if not found.
 */
async function tryRead(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return ''
  }
}

/**
 * Build a well-decorated GitHub issue body from investigation artifacts.
 * Supports all source types: GitHub issues, PRs, and Discord messages.
 */
function buildInvestigationIssueBody(options: {
  meta: Record<string, unknown>
  findingsBody: string
  analysisBody: string
  responseBody: string
  /** Legacy: old-style investigation body (pre-multi-phase) */
  legacyInvestigationBody?: string
}): string {
  const { meta, findingsBody, analysisBody, responseBody } = options
  const sections: string[] = []

  // --- Header with source link ---
  const source = String(meta.source ?? 'github_issue')
  const repo = String(meta.repo ?? '')
  const issueNumber = Number(meta.issue_number ?? 0)
  const guildName = String(meta.guild_name ?? '')
  const channelName = String(meta.channel_name ?? '')
  const author = String(meta.author ?? 'unknown')
  const title = String(meta.title ?? '')
  const classification = String(meta.classification ?? '')
  const severity = String(meta.severity ?? '')

  // Source link
  if (source === 'discord') {
    sections.push(`> **Source:** Discord message from **@${author}** in **#${channelName}** (${guildName})`)
  } else if (repo && issueNumber) {
    const sourceUrl = `https://github.com/${repo}/issues/${issueNumber}`
    sections.push(`> **Source:** [${repo}#${issueNumber}](${sourceUrl})${title ? ` — ${title}` : ''}`)
  }
  sections.push('')

  // --- Metadata table ---
  const metaRows: string[] = []
  metaRows.push(`| Field | Value |`)
  metaRows.push(`|-------|-------|`)
  metaRows.push(`| **Author** | @${author} |`)
  if (source === 'discord') {
    metaRows.push(`| **Channel** | #${channelName} |`)
    metaRows.push(`| **Guild** | ${guildName} |`)
  } else {
    if (repo) metaRows.push(`| **Repository** | [${repo}](https://github.com/${repo}) |`)
    if (issueNumber) metaRows.push(`| **Issue/PR** | [#${issueNumber}](https://github.com/${repo}/issues/${issueNumber}) |`)
  }
  if (classification) metaRows.push(`| **Classification** | \`${classification}\` |`)
  if (severity) metaRows.push(`| **Severity** | \`${severity}\` |`)
  metaRows.push(`| **Source Type** | ${source} |`)
  metaRows.push(`| **Investigated** | ${new Date().toISOString().split('T')[0]} |`)
  sections.push(metaRows.join('\n'))
  sections.push('')

  // --- Original message/question ---
  const content = String(meta.original_content ?? '')
  if (content) {
    sections.push(`## Original Message`)
    sections.push('')
    sections.push(`> ${content.replace(/\n/g, '\n> ').substring(0, 2000)}`)
    sections.push('')
  }

  // --- Findings (Phase 1) ---
  if (findingsBody) {
    sections.push(`## :mag: Investigation Findings`)
    sections.push('')
    sections.push(`<details>`)
    sections.push(`<summary>Click to expand search results and evidence</summary>`)
    sections.push('')
    sections.push(findingsBody.trim())
    sections.push('')
    sections.push(`</details>`)
    sections.push('')
  }

  // --- Analysis (Phase 2) ---
  if (analysisBody) {
    sections.push(`## :brain: Analysis`)
    sections.push('')
    sections.push(analysisBody.trim())
    sections.push('')
  }

  // --- Legacy investigation body (pre-multi-phase) ---
  if (!findingsBody && !analysisBody && options.legacyInvestigationBody) {
    sections.push(`## Investigation`)
    sections.push('')
    sections.push(options.legacyInvestigationBody.trim())
    sections.push('')
  }

  // --- Generated Response (Phase 3) ---
  if (responseBody) {
    sections.push(`---`)
    sections.push('')
    sections.push(`## :speech_balloon: Generated Response`)
    sections.push('')
    sections.push(`The following response was generated for the user:`)
    sections.push('')
    sections.push(`> ${responseBody.replace(/\n/g, '\n> ').trim()}`)
    sections.push('')
  }

  // --- Cross-references ---
  const relatedIssues = meta.related_issues
  if (Array.isArray(relatedIssues) && relatedIssues.length > 0) {
    sections.push(`## :link: Related Issues`)
    sections.push('')
    for (const related of relatedIssues) {
      if (repo && typeof related === 'number') {
        sections.push(`- [${repo}#${related}](https://github.com/${repo}/issues/${related})`)
      } else {
        sections.push(`- ${related}`)
      }
    }
    sections.push('')
  }

  // --- Footer ---
  sections.push(`---`)
  sections.push('')
  sections.push(`<sub>`)
  sections.push(`Generated by [GameCI Help Bot](https://github.com/game-ci/help-bot) | `)
  if (source === 'discord') {
    sections.push(`Source: Discord #${channelName}`)
  } else if (repo && issueNumber) {
    sections.push(`Source: [${repo}#${issueNumber}](https://github.com/${repo}/issues/${issueNumber})`)
  }
  sections.push(`</sub>`)

  return sections.join('\n')
}

/**
 * Creates GitHub issues in the target repo for each investigation.
 * Scans both github/ and discord/ response directories.
 * Includes multi-phase artifacts: findings, analysis, and response.
 * Tracks posted investigations in state.json to avoid duplicates.
 */
export async function postInvestigationIssues(options: PostInvestigationOptions): Promise<void> {
  const state = await loadState()
  const postedInvestigations: Record<string, string> = (state.meta?.postedInvestigations as Record<string, string>) ?? {}

  // Scan both github and discord response directories
  for (const subdir of ['github', 'discord']) {
    const dir = join(RESPONSES_DIR, subdir)
    let files: string[] = []
    try {
      files = await readdir(dir)
    } catch {
      continue
    }

    // Find response files (not -findings, -analysis, -context, -investigation)
    const responseFiles = files.filter((f) =>
      f.endsWith('.md')
      && !f.includes('-findings')
      && !f.includes('-analysis')
      && !f.includes('-context')
      && !f.includes('-investigation')
    )

    for (const file of responseFiles) {
      const responseId = file.replace(/\.md$/, '')

      // Check if we have any investigation artifacts for this response
      const findingsRaw = await tryRead(join(dir, `${responseId}-findings.md`))
      const analysisRaw = await tryRead(join(dir, `${responseId}-analysis.md`))
      const legacyInvestigationRaw = await tryRead(join(dir, `${responseId}-investigation.md`))

      // Skip if no investigation artifacts exist (just a bare response)
      if (!findingsRaw && !analysisRaw && !legacyInvestigationRaw) continue

      const responseRaw = await tryRead(join(dir, file))
      const { meta, body: responseBody } = parseFrontMatter(responseRaw)
      const { body: findingsBody } = findingsRaw ? parseFrontMatter(findingsRaw) : { body: '' }
      const { body: analysisBody } = analysisRaw ? parseFrontMatter(analysisRaw) : { body: '' }
      const { body: legacyInvestigationBody } = legacyInvestigationRaw ? parseFrontMatter(legacyInvestigationRaw) : { body: '' }

      // Build investigation key for dedup
      const source = String(meta.source ?? (subdir === 'discord' ? 'discord' : 'github_issue'))
      let investigationKey: string
      if (source === 'discord') {
        const guild = String(meta.guild_name ?? '')
        const channel = String(meta.channel_name ?? '')
        investigationKey = `discord:${guild}/${channel}#${responseId}`
      } else {
        const repo = String(meta.repo ?? '')
        const num = Number(meta.issue_number ?? 0)
        investigationKey = repo && num ? `${repo}#${num}` : responseId
      }

      if (postedInvestigations[investigationKey]) {
        continue
      }

      // Build labels
      const labels = [...options.labels]
      const repo = String(meta.repo ?? '')
      if (repo) {
        const repoShortName = repo.split('/').pop() ?? repo
        if (!labels.includes(repoShortName)) labels.push(repoShortName)
      }
      if (source === 'discord') {
        if (!labels.includes('discord')) labels.push('discord')
      }
      const classification = String(meta.classification ?? '')
      if (classification && !labels.includes(classification)) {
        labels.push(classification)
      }

      // Build issue title
      const author = String(meta.author ?? 'unknown')
      let title: string
      if (source === 'discord') {
        const channel = String(meta.channel_name ?? '')
        const preview = String(meta.title ?? meta.original_content ?? '').substring(0, 60)
        title = `[Investigation] Discord #${channel} — @${author}${preview ? `: ${preview}` : ''}`
      } else {
        const num = Number(meta.issue_number ?? 0)
        const issueTitle = String(meta.title ?? '')
        title = issueTitle
          ? `[Investigation] ${repo}#${num}: ${issueTitle}`
          : `[Investigation] ${repo}#${num}`
      }

      // Build issue body
      const body = buildInvestigationIssueBody({
        meta,
        findingsBody,
        analysisBody,
        responseBody,
        legacyInvestigationBody,
      })

      if (options.dryRun) {
        console.log(`DRY RUN: would create investigation issue in ${options.targetRepo}:`)
        console.log(`  Title: ${title}`)
        console.log(`  Labels: ${labels.join(', ')}`)
        console.log(`  Key: ${investigationKey}`)
        recordStat('investigationIssuesSkipped', 1)
        continue
      }

      try {
        const labelArgs = labels.flatMap((l) => ['--label', l])
        const { stdout } = await execFileAsync('gh', [
          'issue', 'create',
          '--repo', options.targetRepo,
          '--title', title,
          ...labelArgs,
          '--body', body,
        ])
        const createdUrl = stdout.trim()
        const createdNumber = createdUrl.split('/').pop() ?? ''
        console.log(`Created investigation issue: ${createdUrl}`)

        postedInvestigations[investigationKey] = createdNumber
        recordStat('investigationIssuesPosted', 1)
      } catch (error: any) {
        console.warn(`Failed to create investigation issue for ${investigationKey}: ${error.message ?? error}`)
      }

      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  }

  await updateState((s) => {
    s.meta ??= {}
    s.meta.postedInvestigations = postedInvestigations
  })
}
