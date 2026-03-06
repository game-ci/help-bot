import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { parseFrontMatter } from '../utils/frontmatter'
import { RESPONSES_DIR, DATA_DIR } from '../utils/paths'
import { loadState, updateState } from '../state'
import { CycleStats } from '../metrics'

const execFileAsync = promisify(execFile)

export interface CycleReportOptions {
  dryRun: boolean
  targetRepo: string
  repos: string[]
  stats: CycleStats
}

interface InvestigationSummary {
  number: number
  repo: string
  title: string
  classification: string
  relatedIssues: string
  hasBugDiscovery: boolean
  hasResponse: boolean
}

/**
 * Build and write a cycle report summarizing all investigations, filter results,
 * and cross-issue patterns from this cycle.
 */
export async function writeCycleReport(options: CycleReportOptions): Promise<string> {
  const repoDir = join(RESPONSES_DIR, 'github')
  let files: string[] = []
  try {
    files = await readdir(repoDir)
  } catch {
    files = []
  }

  const investigations: InvestigationSummary[] = []
  const investigationFiles = files.filter((f) => f.endsWith('-investigation.md'))
  const responseFiles = files.filter((f) => f.endsWith('.md') && !f.includes('-investigation') && !f.startsWith('cycle-report'))

  for (const file of investigationFiles) {
    const content = await readFile(join(repoDir, file), 'utf-8')
    const { meta, body } = parseFrontMatter(content)
    const responseFile = file.replace('-investigation.md', '.md')
    investigations.push({
      number: Number(meta.issue_number ?? 0),
      repo: (meta.repo ?? '').replace(/"/g, ''),
      title: (meta.title ?? '').replace(/"/g, ''),
      classification: (meta.classification ?? 'unknown').replace(/"/g, ''),
      relatedIssues: (meta.related_issues ?? '[]').replace(/"/g, ''),
      hasBugDiscovery: body.includes('## Bug Discovery'),
      hasResponse: files.includes(responseFile),
    })
  }

  // Read filter manifests
  const filterSummaries: string[] = []
  for (const repo of options.repos) {
    const slug = repo.replace(/\//g, '-')
    const manifestPath = join(DATA_DIR, 'github', `filtered-${slug}.md`)
    if (existsSync(manifestPath)) {
      const manifestContent = await readFile(manifestPath, 'utf-8')
      // Extract just the stats lines
      const lines = manifestContent.split('\n')
      const statsLines = lines.filter(l =>
        l.startsWith('Total synced:') || l.startsWith('Eligible:') || l.startsWith('Skipped:') || l.startsWith('- ')
      )
      filterSummaries.push(`### ${repo}\n${statsLines.join('\n')}`)
    }
  }

  const now = new Date()
  const dateStr = now.toISOString().split('T')[0]
  const timeStr = now.toISOString().split('T')[1].split('.')[0]

  // Build the report
  const sections: string[] = []

  sections.push(`---`)
  sections.push(`type: cycle-report`)
  sections.push(`date: ${dateStr}`)
  sections.push(`time: ${timeStr}`)
  sections.push(`repos: ${JSON.stringify(options.repos)}`)
  sections.push(`investigations_count: ${investigations.length}`)
  sections.push(`responses_count: ${responseFiles.length}`)
  sections.push(`---`)
  sections.push('')
  sections.push(`# Help Bot Cycle Report — ${dateStr}`)
  sections.push('')

  // Filter summary
  if (filterSummaries.length > 0) {
    sections.push('## Issue Filtering')
    sections.push('')
    sections.push(...filterSummaries)
    sections.push('')
  }

  // Investigation summary table
  if (investigations.length > 0) {
    sections.push('## Investigations')
    sections.push('')
    sections.push('| Issue | Classification | Related | Bug Found | Response |')
    sections.push('|-------|---------------|---------|-----------|----------|')
    for (const inv of investigations) {
      const sourceUrl = `https://github.com/${inv.repo}/issues/${inv.number}`
      const bugIcon = inv.hasBugDiscovery ? 'Yes' : 'No'
      const respIcon = inv.hasResponse ? 'Yes' : 'No'
      sections.push(`| [${inv.repo}#${inv.number}](${sourceUrl}) | ${inv.classification} | ${inv.relatedIssues} | ${bugIcon} | ${respIcon} |`)
    }
    sections.push('')

    // Classification breakdown
    const classificationCounts: Record<string, number> = {}
    for (const inv of investigations) {
      classificationCounts[inv.classification] = (classificationCounts[inv.classification] ?? 0) + 1
    }
    sections.push('### Classification Breakdown')
    sections.push('')
    for (const [classification, count] of Object.entries(classificationCounts)) {
      sections.push(`- **${classification}**: ${count}`)
    }
    sections.push('')

    // Bug discoveries
    const bugs = investigations.filter(i => i.hasBugDiscovery)
    if (bugs.length > 0) {
      sections.push('### Bug Discoveries')
      sections.push('')
      sections.push('The following issues were identified as potential bugs in the source code:')
      sections.push('')
      for (const bug of bugs) {
        sections.push(`- [${bug.repo}#${bug.number}](https://github.com/${bug.repo}/issues/${bug.number}): ${bug.title}`)
      }
      sections.push('')
    }

    // Cross-issue patterns
    const relatedMap = new Map<number, Set<number>>()
    for (const inv of investigations) {
      try {
        const related = JSON.parse(inv.relatedIssues) as number[]
        if (related.length > 0) {
          relatedMap.set(inv.number, new Set(related))
        }
      } catch {
        // skip
      }
    }
    if (relatedMap.size > 0) {
      sections.push('### Cross-Issue Patterns')
      sections.push('')
      for (const [issue, related] of relatedMap) {
        const relatedStr = [...related].map(r => `#${r}`).join(', ')
        sections.push(`- #${issue} is related to: ${relatedStr}`)
      }
      sections.push('')
    }
  } else {
    sections.push('## Investigations')
    sections.push('')
    sections.push('No investigations were produced this cycle.')
    sections.push('')
  }

  // Investigation details (expandable)
  for (const file of investigationFiles) {
    const content = await readFile(join(repoDir, file), 'utf-8')
    const { meta, body } = parseFrontMatter(content)
    const repo = (meta.repo ?? '').replace(/"/g, '')
    const number = meta.issue_number ?? ''
    const title = (meta.title ?? '').replace(/"/g, '')
    const sourceUrl = `https://github.com/${repo}/issues/${number}`

    sections.push(`<details>`)
    sections.push(`<summary>${repo}#${number}: ${title}</summary>`)
    sections.push('')
    sections.push(`> Source: ${sourceUrl}`)
    sections.push('')
    sections.push(body)

    // Include response if exists
    const responseFile = file.replace('-investigation.md', '.md')
    const responsePath = join(repoDir, responseFile)
    if (existsSync(responsePath)) {
      const responseContent = await readFile(responsePath, 'utf-8')
      const { body: responseBody } = parseFrontMatter(responseContent)
      sections.push('')
      sections.push('#### Generated Response')
      sections.push('')
      sections.push(responseBody)
    }

    sections.push('')
    sections.push(`</details>`)
    sections.push('')
  }

  // Dispatch pipeline status
  const hasDispatchStats = options.stats.detectionsCreated > 0 ||
    options.stats.detectionsApproved > 0 ||
    options.stats.detectionsPending > 0 ||
    options.stats.detectionsCancelled > 0 ||
    options.stats.detectionsExpired > 0 ||
    options.stats.detectionsWarningsPosted > 0
  if (hasDispatchStats) {
    sections.push('## Dispatch Pipeline')
    sections.push('')
    sections.push(`- Detections created: ${options.stats.detectionsCreated}`)
    sections.push(`- Approved: ${options.stats.detectionsApproved}`)
    sections.push(`- Pending: ${options.stats.detectionsPending}`)
    sections.push(`- Cancelled: ${options.stats.detectionsCancelled}`)
    sections.push(`- Auto-dispatched (expired): ${options.stats.detectionsExpired}`)
    sections.push(`- Warnings posted: ${options.stats.detectionsWarningsPosted}`)
    sections.push('')
  }

  // Stats
  sections.push('## Cycle Stats')
  sections.push('')
  sections.push(`- GitHub issues synced: ${options.stats.githubIssuesSynced}`)
  sections.push(`- GitHub responses posted: ${options.stats.githubResponsesPosted}`)
  sections.push(`- GitHub responses skipped: ${options.stats.githubResponsesSkipped}`)
  sections.push(`- Investigation issues posted: ${options.stats.investigationIssuesPosted}`)
  sections.push(`- Investigation issues skipped: ${options.stats.investigationIssuesSkipped}`)
  sections.push('')
  sections.push('---')
  sections.push(`*Generated by [GameCI Help Bot](https://github.com/game-ci/help-bot) at ${now.toISOString()}*`)

  const reportContent = sections.join('\n')
  const reportPath = join(repoDir, 'cycle-report.md')
  await writeFile(reportPath, reportContent, 'utf-8')
  console.log(`Cycle report written to ${reportPath}`)

  return reportPath
}

/**
 * Check if this cycle has any meaningful activity worth reporting.
 * Prevents spam from cycles that produced no new work.
 */
function hasMeaningfulActivity(options: CycleReportOptions, investigationCount: number): boolean {
  const s = options.stats
  return investigationCount > 0 ||
    s.githubResponsesPosted > 0 ||
    s.discordResponsesPosted > 0 ||
    s.investigationIssuesPosted > 0 ||
    s.detectionsCreated > 0 ||
    s.detectionsApproved > 0 ||
    s.detectionsExpired > 0 ||
    s.detectionsWarningsPosted > 0
}

/**
 * Post the cycle report as a GitHub issue in the target repo.
 *
 * Spam prevention:
 * - Skips posting if no meaningful activity (no investigations, no responses, no dispatch activity)
 * - Deduplicates by date: only one report per calendar date
 */
export async function postCycleReport(options: CycleReportOptions): Promise<void> {
  const reportPath = join(RESPONSES_DIR, 'github', 'cycle-report.md')
  if (!existsSync(reportPath)) {
    console.log('No cycle report found to post.')
    return
  }

  const content = await readFile(reportPath, 'utf-8')
  const { meta, body } = parseFrontMatter(content)
  const date = meta.date ?? new Date().toISOString().split('T')[0]
  const investigationsCount = Number(meta.investigations_count ?? '0')

  // Spam prevention: skip if no meaningful activity
  if (!hasMeaningfulActivity(options, investigationsCount)) {
    console.log('No meaningful activity this cycle. Skipping cycle report posting.')
    return
  }

  // Spam prevention: dedup by date — only one report per calendar date
  const state = await loadState()
  const lastReportDate = state.meta?.lastCycleReportDate as string | undefined
  if (lastReportDate === date) {
    console.log(`Cycle report already posted for ${date}. Skipping duplicate.`)
    return
  }

  const title = `[Cycle Report] ${date} — ${investigationsCount} investigations across ${options.repos.join(', ')}`
  const labels = ['help-bot', 'cycle-report']

  if (options.dryRun) {
    console.log(`DRY RUN: would create cycle report issue in ${options.targetRepo}:`)
    console.log(`  Title: ${title}`)
    console.log(`  Labels: ${labels.join(', ')}`)
    return
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
    console.log(`Created cycle report issue: ${stdout.trim()}`)

    await updateState((s) => {
      s.meta ??= {}
      s.meta.lastCycleReportUrl = stdout.trim()
      s.meta.lastCycleReportDate = date
    })
  } catch (error: any) {
    console.warn(`Failed to create cycle report issue: ${error.message ?? error}`)
  }
}
