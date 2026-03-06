import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { getConfig, getValue } from '../config'
import { REPO_ROOT } from '../utils/paths'

export interface ReviewOptions {
  modelOverride?: string
}

/**
 * Interactive quality review mode.
 * Launches a Claude session that reads all recent response/investigation files
 * and produces a graded quality assessment.
 */
export async function runQualityReview(options: ReviewOptions = {}): Promise<void> {
  const config = await getConfig()
  const model = options.modelOverride
    ?? (getValue(config, ['llm', 'claude', 'model'], 'claude-sonnet-4-20250514') as string)

  const prompt = `You are reviewing the quality of recent GameCI Help Bot responses.

## Instructions

1. First, use Glob to find all files matching data/responses/github/*.md
2. Read ALL response files (those NOT ending in -investigation.md) and their corresponding investigation files
3. If data/feedback/feedback-summary.md exists, read it for user feedback context
4. If any files exist in data/security/, read the most recent security report

## Quality Criteria

For EACH response file, evaluate and grade (A/B/C/D/F):

1. **TL;DR Present** (required): Does the response begin with a "**TL;DR:**" line?
2. **Accuracy**: Does the response correctly identify the root cause? Cross-check against the investigation file.
3. **Actionability**: Does the response include copy-paste-ready workarounds (code blocks, YAML snippets, commands)?
4. **Verification**: Were claims verified against source code? Check the investigation's "Source Verification" section.
5. **Structure**: Does the response follow: TL;DR → Root Cause → Workaround → Why This Works → Related Issues?
6. **Related Issues**: Are related issues cross-referenced? Is the related_issues array in the investigation populated?
7. **Comment Thread**: Were comments from the issue thread incorporated into the investigation?
8. **Tone**: Professional, not overly verbose, no emoji, no greetings, no sign-offs?
9. **Classification**: Is the classification (bug/user-error/limitation/feature-request) correct?
10. **Severity**: Is the severity rating (critical/high/medium/low) present and appropriate?

## Output Format

For each response, write:

### #{issue_number}: {title}
- **Grade**: {A/B/C/D/F}
- **TL;DR**: {present/missing}
- **Actionable Code**: {yes/no — does it have a code block the user can copy?}
- **Related Issues**: {count found vs count in investigation}
- **Issues**: {specific problems with this response}
- **Improvements**: {what would make this an A-grade response}

Then write an overall summary:

## Overall Assessment
- **Average Grade**: {letter}
- **Responses Reviewed**: {count}
- **Most Common Issues**: {top 3 patterns}
- **System Prompt Recommendations**: {specific changes to improve future output}
- **Top 3 Priorities**: {ranked list of what to fix first}

Write the full review to data/reviews/quality-review-${new Date().toISOString().split('T')[0]}.md`

  const args = ['-p', '--model', model]
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

  console.log(`Quality Review: launching Claude (model: ${model})...`)
  const proc = spawn('claude', args, {
    cwd: REPO_ROOT,
    stdio: ['pipe', 'inherit', 'inherit'],
  })
  proc.stdin.end(prompt)
  await once(proc, 'exit')
  console.log('Quality review complete.')
}
