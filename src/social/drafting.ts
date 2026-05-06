import { execSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { getValue } from '../config'
import { ensureDir } from '../utils/fs'
import { REPO_ROOT, RESPONSES_DIR } from '../utils/paths'
import { parseFrontMatter } from '../utils/frontmatter'
import { resolveClaude } from '../utils/claude'
import type { ContentRecord } from './types'

const SOCIAL_RESPONSES_DIR = join(RESPONSES_DIR, 'social')

export interface DraftOptions {
  config: Record<string, unknown>
  model: string
  /** Previous draft text for revision */
  previousDraft?: string
  /** Maintainer feedback from thread */
  feedback?: string
}

export async function runContentDraft(
  record: ContentRecord,
  options: DraftOptions,
): Promise<{ draftFile: string; draftPreview: string } | null> {
  await ensureDir(SOCIAL_RESPONSES_DIR)

  const revSuffix = record.revisionCount > 0 ? `-rev${record.revisionCount}` : ''
  const contentId = record.contentKey.replace('content:', '').replace(/[:/]/g, '-')
  const responseId = `social-${contentId}${revSuffix}`

  const linkedinConfig = getValue(
    options.config,
    ['social', 'linkedin'],
    {} as Record<string, unknown>,
  )
  const maxLength = Number(getValue(linkedinConfig, ['max_length'], 3000))
  const defaultHashtags = getValue(
    linkedinConfig,
    ['default_hashtags'],
    ['#GameCI', '#Unity', '#CICD', '#GameDev'],
  ) as string[]
  const tone = getValue(
    linkedinConfig,
    ['tone'],
    'professional, technically credible, community-focused',
  ) as string

  // Gather recent activity from configured GitHub repos
  const repos = getValue(options.config, ['github', 'repos'], []) as string[]
  const repoContext = gatherRepoContext(repos)

  const prompt = buildPrompt(record, responseId, {
    maxLength,
    defaultHashtags,
    tone,
    previousDraft: options.previousDraft,
    feedback: options.feedback,
    repoContext,
  })

  // Spawn Claude with cwd set to parent so it can explore sibling repos
  const workspaceCwd = dirname(REPO_ROOT)
  const maxTurns = 15
  const args = ['-p', '--model', options.model, '--max-turns', String(maxTurns)]
  args.push(
    '--allowedTools',
    'Read',
    '--allowedTools',
    'Glob',
    '--allowedTools',
    'Grep',
    '--allowedTools',
    'Bash',
    '--allowedTools',
    'Write',
  )
  args.push(
    '--disallowedTools',
    'Edit',
    '--disallowedTools',
    'WebFetch',
    '--disallowedTools',
    'WebSearch',
    '--disallowedTools',
    'NotebookEdit',
    '--disallowedTools',
    'Task',
  )

  const env = { ...process.env }
  delete env.CLAUDECODE

  try {
    const proc = spawn(resolveClaude(), args, {
      cwd: workspaceCwd,
      stdio: ['pipe', 'inherit', 'inherit'],
      env,
    })
    proc.stdin.end(prompt)
    const [code] = (await once(proc, 'exit')) as [number | null]
    if (code !== 0) {
      throw new Error(`Claude Code CLI exited with code ${code ?? 'unknown'}`)
    }
  } catch (error: any) {
    console.warn(`  Social draft failed: ${error.message ?? error}`)
    return null
  }

  // Read the response file
  const responseFile = join(SOCIAL_RESPONSES_DIR, `${responseId}.md`)
  let content: string
  try {
    content = await readFile(responseFile, 'utf-8')
  } catch {
    console.warn(`  No draft file produced at ${responseFile}`)
    return null
  }

  const { body } = parseFrontMatter(content)
  const cleaned = body.trim()
  if (!cleaned) {
    console.warn(`  Draft file is empty`)
    return null
  }

  const relPath = responseFile.replace(/\\/g, '/').replace(/^.*?(data\/)/, '$1')
  const preview = cleaned.substring(0, 200) + (cleaned.length > 200 ? '...' : '')

  return { draftFile: relPath, draftPreview: preview }
}

/** Read the body of a draft file */
export async function readDraftBody(draftFile: string): Promise<string | undefined> {
  const filePath = draftFile.startsWith('data/') ? join(REPO_ROOT, draftFile) : draftFile
  try {
    const content = await readFile(filePath, 'utf-8')
    const { body } = parseFrontMatter(content)
    return body.trim() || undefined
  } catch {
    return undefined
  }
}

interface PromptConfig {
  maxLength: number
  defaultHashtags: string[]
  tone: string
  previousDraft?: string
  feedback?: string
  repoContext?: string
}

/**
 * Gather recent activity from configured GitHub repos using gh CLI.
 * Returns a markdown summary of recent commits, PRs, and releases.
 */
function gatherRepoContext(repos: string[]): string {
  if (repos.length === 0) return ''

  const sections: string[] = []

  for (const repo of repos) {
    try {
      const repoName = repo.split('/').pop() || repo

      // Recent commits (last 7 days)
      let commits = ''
      try {
        commits = execSync(
          `gh api repos/${repo}/commits --jq '.[0:10] | .[] | "- \\(.commit.message | split("\\n") | .[0]) (\\(.sha[0:7]), \\(.commit.author.date[0:10]))"'`,
          { encoding: 'utf8', timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'] },
        ).trim()
      } catch {}

      // Recent merged PRs
      let prs = ''
      try {
        prs = execSync(
          `gh pr list --repo ${repo} --state merged --limit 5 --json title,number,mergedAt --jq '.[] | "- #\\(.number) \\(.title) (\\(.mergedAt[0:10]))"'`,
          { encoding: 'utf8', timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'] },
        ).trim()
      } catch {}

      // Latest release
      let release = ''
      try {
        release = execSync(
          `gh api repos/${repo}/releases/latest --jq '"\\(.tag_name) — \\(.name) (\\(.published_at[0:10]))"'`,
          { encoding: 'utf8', timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] },
        ).trim()
      } catch {}

      if (commits || prs || release) {
        const lines = [`### ${repoName} (\`${repo}\`)`]
        if (release) lines.push(`**Latest release:** ${release}`)
        if (prs) lines.push('**Recent merged PRs:**', prs)
        if (commits) lines.push('**Recent commits:**', commits)
        sections.push(lines.join('\n'))
      }
    } catch {
      // Skip repos that fail
    }
  }

  return sections.length > 0 ? '## Recent Repository Activity\n\n' + sections.join('\n\n') : ''
}

function buildPrompt(record: ContentRecord, responseId: string, cfg: PromptConfig): string {
  const sections: string[] = []

  sections.push(`You are a social media content strategist for GameCI, an open-source project that provides CI/CD tools for Unity game development (GitHub Actions, Docker images, test runners).

## Task

Create a LinkedIn post plan document about the following topic:

**Topic:** ${record.topic}
**Requested by:** ${record.requestedBy}
**Platform:** LinkedIn

## Research Phase

Before writing, investigate the topic using the tools available to you. The working directory is the game-ci workspace root with sibling repos (orchestrator, unity-builder, documentation, docker, etc.). Use Bash with \`gh\` CLI, Read, Glob, and Grep to:

1. Check recent commits, PRs, and releases related to the topic
2. Read relevant source code or changelogs for technical accuracy
3. Find specific details, numbers, or improvements to cite in the post

${cfg.repoContext ? `Here is a summary of recent activity to start from:\n\n${cfg.repoContext}\n` : ''}
## LinkedIn Content Guidelines

- **Tone:** ${cfg.tone}. Write as the GameCI project speaking to the broader gamedev and DevOps community.
- **Length:** 1300-2500 characters (LinkedIn optimal range). Never exceed ${cfg.maxLength} characters.
- **Structure:**
  1. Opening hook (1-2 sentences that grab attention -- a surprising fact, bold claim, or relatable pain point)
  2. Context/problem statement (2-3 sentences)
  3. Solution/announcement/insight (the core content, 3-5 sentences)
  4. Call to action (soft -- "Try it out", "Join the conversation", "Check the docs")
  5. Hashtags (5-8 relevant hashtags, always include ${cfg.defaultHashtags.join(', ')})
- **Voice:** First-person plural ("we") is appropriate here since this IS an official project communication.
- **No emoji in body text.** Hashtags only at the end.
- **Technical credibility:** Include specific technical details when relevant. Avoid vague marketing language.

## Image Concept

Suggest 1-2 image concepts that would accompany this post. Describe:
- What the image should show (screenshot, diagram, infographic, etc.)
- Key visual elements
- Suggested dimensions (1200x627 for LinkedIn link preview, or 1080x1080 for in-feed)
- Alt text suggestion

Do NOT generate images. Just describe concepts.

## Output Format

Write the final content plan to: help-bot/data/responses/social/${responseId}.md

Use this exact frontmatter format:

---
type: social-content
platform: linkedin
topic: "${record.topic.replace(/"/g, '\\"')}"
requested_by: "${record.requestedBy}"
status: draft
revision: ${record.revisionCount}
created_at: "${new Date().toISOString()}"
---

Then include these sections in the body:

## Post Content

(The LinkedIn post text here -- ready to copy-paste into LinkedIn)

## Image Concepts

(Image concept descriptions with dimensions and alt text)

## Hashtags

(Hashtag suggestions with brief rationale for each)

## Posting Notes

(Timing suggestions, audience targeting notes, or complementary actions)`)

  if (cfg.previousDraft) {
    sections.push(`

## Previous Draft (REVISION REQUESTED)

The following draft was previously generated but needs revision:

${cfg.previousDraft}`)
  }

  if (cfg.feedback) {
    sections.push(`

## Maintainer Feedback

The following feedback was provided by the team. Follow it carefully:

${cfg.feedback}

**Your task:** Revise the content based on the feedback above. Keep what works, fix what doesn't.`)
  }

  return sections.join('\n')
}
