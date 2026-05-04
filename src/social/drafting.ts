import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
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

  const linkedinConfig = getValue(options.config, ['social', 'linkedin'], {} as Record<string, unknown>)
  const maxLength = Number(getValue(linkedinConfig, ['max_length'], 3000))
  const defaultHashtags = getValue(linkedinConfig, ['default_hashtags'], ['#GameCI', '#Unity', '#CICD', '#GameDev']) as string[]
  const tone = getValue(linkedinConfig, ['tone'], 'professional, technically credible, community-focused') as string

  const prompt = buildPrompt(record, responseId, {
    maxLength,
    defaultHashtags,
    tone,
    previousDraft: options.previousDraft,
    feedback: options.feedback,
  })

  // Spawn Claude
  const maxTurns = 15
  const args = ['-p', '--model', options.model, '--max-turns', String(maxTurns)]
  args.push(
    '--allowedTools', 'Read',
    '--allowedTools', 'Glob',
    '--allowedTools', 'Grep',
    '--allowedTools', 'Bash',
    '--allowedTools', 'Write',
  )
  args.push(
    '--disallowedTools', 'Edit',
    '--disallowedTools', 'WebFetch',
    '--disallowedTools', 'WebSearch',
    '--disallowedTools', 'NotebookEdit',
    '--disallowedTools', 'Task',
  )

  const env = { ...process.env }
  delete env.CLAUDECODE

  try {
    const proc = spawn(resolveClaude(), args, {
      cwd: REPO_ROOT,
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
  const filePath = draftFile.startsWith('data/')
    ? join(REPO_ROOT, draftFile)
    : draftFile
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
}

function buildPrompt(record: ContentRecord, responseId: string, cfg: PromptConfig): string {
  const sections: string[] = []

  sections.push(`You are a social media content strategist for GameCI, an open-source project that provides CI/CD tools for Unity game development (GitHub Actions, Docker images, test runners).

## Task

Create a LinkedIn post plan document about the following topic:

**Topic:** ${record.topic}
**Requested by:** ${record.requestedBy}
**Platform:** LinkedIn

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

Write the final content plan to: data/responses/social/${responseId}.md

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
