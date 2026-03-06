import yargs from 'yargs/yargs'
import { hideBin } from 'yargs/helpers'
import { runCycle } from './core/cycle'
import { runContinuous } from './core/continuous'
import { syncDiscord } from './sync/discord'
import { syncGitHub } from './sync/github'
import { syncDocs } from './sync/docs'
import { vectorBake } from './core/vector-bake'
import { manageService, Mode } from './core/nssm-service'
import { ensureDiscordToken } from './token/helper'
import { markFeedback } from './feedback'
import { reportSummary } from './report'

yargs(hideBin(process.argv))
  .scriptName('gameci-help-bot')
  .command('cycle', 'run a single help cycle', (y) => y
    .option('dry-run', { type: 'boolean', description: 'Draft responses without posting' })
    .option('skip-sync', { type: 'boolean', description: 'Skip data syncing' })
    .option('skip-github-post', { type: 'boolean', description: 'Do not post to GitHub' })
    .option('allow-official', { type: 'boolean', description: 'Allow posting even if an official responded' })
    .option('force-reply-id', { type: 'string', description: 'Force posting for this response id even if a reply already exists' })
    .option('seen-you-message', { type: 'string', description: 'Custom text for the seen-you notification' })
    .option('seen-you-emoji', { type: 'string', description: 'Emoji to prefix the seen-you notification' })
    .option('provider', { type: 'string', description: 'Override LLM provider (claude|lm_studio|continue|codex)' })
    .option('github-only', { type: 'boolean', description: 'Skip Discord entirely (no token needed)' })
    .option('repos', { type: 'string', array: true, description: 'Override repos to sync (e.g. game-ci/unity-builder)' })
    .option('repo-dir', { type: 'string', description: 'Path to local clone of target repo (Claude reads code directly)' })
    .option('docs-dir', { type: 'string', description: 'Path to local clone of documentation repo (skips HTTP docs sync)' })
    .option('investigation-issues', { type: 'boolean', description: 'Create GitHub issues for each investigation in the target repo' })
    .option('investigation-repo', { type: 'string', description: 'Target repo for investigation issues (default: game-ci/help-bot)' })
    .option('dispatch-mode', { type: 'string', choices: ['auto', 'approval', 'countdown'] as const, description: 'Dispatch mode: auto (immediate), approval (require reaction), countdown (staged warnings)' })
    .option('countdown-hours', { type: 'number', description: 'Hours between countdown warning stages (default: 24)' })
    .option('model', { type: 'string', description: 'Override LLM model (e.g. claude-opus-4-20250514 for deep investigation)' })
  , async (args) => {
    if (!args['github-only']) {
      await ensureDiscordToken()
    }
    await runCycle({
      dryRun: args['dry-run'] || false,
      skipSync: args['skip-sync'] || false,
      skipGithubPost: args['skip-github-post'] || false,
      allowOfficial: args['allow-official'] || false,
      forceReplyId: args['force-reply-id'],
      seenYouMessage: args['seen-you-message'],
      seenYouEmoji: args['seen-you-emoji'],
      provider: args.provider,
      githubOnly: args['github-only'] || false,
      repos: args.repos,
      repoDir: args['repo-dir'],
      docsDir: args['docs-dir'],
      investigationIssues: args['investigation-issues'] || false,
      investigationRepo: args['investigation-repo'],
      dispatchMode: args['dispatch-mode'] as 'auto' | 'approval' | 'countdown' | undefined,
      countdownHours: args['countdown-hours'],
      modelOverride: args.model,
    })
  })
  .command('continuous', 'run continuous mode', (y) => y
    .option('interval', { type: 'number', description: 'Cycle interval in minutes' })
    .option('provider', { type: 'string', description: 'Override LLM provider' })
    .option('github-only', { type: 'boolean', description: 'Skip Discord entirely (no token needed)' })
    .option('repos', { type: 'string', array: true, description: 'Override repos to sync' })
    .option('dispatch-mode', { type: 'string', choices: ['auto', 'approval', 'countdown'] as const, description: 'Dispatch mode: auto (immediate), approval (require reaction), countdown (staged warnings)' })
    .option('countdown-hours', { type: 'number', description: 'Hours between countdown warning stages (default: 24)' })
    .option('investigation-issues', { type: 'boolean', description: 'Create GitHub issues for each investigation' })
    .option('investigation-repo', { type: 'string', description: 'Target repo for investigation issues' })
    .option('dry-run', { type: 'boolean', description: 'Draft responses without posting' })
  , async (args) => {
    if (!args['github-only']) {
      await ensureDiscordToken()
    }
    await runContinuous({
      intervalMinutes: args.interval,
      provider: args.provider,
      githubOnly: args['github-only'] || false,
      repos: args.repos,
      dispatchMode: args['dispatch-mode'] as 'auto' | 'approval' | 'countdown' | undefined,
      countdownHours: args['countdown-hours'],
      investigationIssues: args['investigation-issues'] || false,
      investigationRepo: args['investigation-repo'],
      dryRun: args['dry-run'] || false,
    })
  })
  .command('live', 'run as a live Discord bot (persistent Gateway connection)', (y) => y
    .option('dispatch-mode', { type: 'string', choices: ['auto', 'approval', 'countdown'] as const, description: 'Dispatch mode for incoming messages (default: discord_mode from config)' })
    .option('repos', { type: 'string', array: true, description: 'GitHub repos for cross-referencing' })
    .option('repo-dir', { type: 'string', description: 'Path to local clone of target repo (Claude reads code directly)' })
    .option('docs-dir', { type: 'string', description: 'Path to local docs clone' })
    .option('model', { type: 'string', description: 'Override LLM model (e.g. claude-opus-4-20250514)' })
    .option('dry-run', { type: 'boolean', description: 'Investigate but do not post responses' })
  , async (args) => {
    await ensureDiscordToken()
    const { runLive } = await import('./core/live.js')
    await runLive({
      dispatchMode: args['dispatch-mode'],
      repos: args.repos,
      repoDir: args['repo-dir'],
      docsDir: args['docs-dir'],
      modelOverride: args.model,
      dryRun: args['dry-run'] || false,
    })
  })
  .command('sync-discord', 'sync Discord messages', () => {}, async () => { await ensureDiscordToken(); await syncDiscord() })
  .command('sync-github', 'sync GitHub issues', () => {}, async () => { await syncGitHub() })
  .command('sync-docs', 'sync docs pages', () => {}, async () => { await syncDocs() })
  .command('vector-bake', 'build the LlamaIndex vector store', () => {}, async () => { await vectorBake() })
  .command('nssm <action>', 'manage the Windows NSSM service', (y) => y
    .positional('action', { choices: ['install', 'start', 'stop', 'restart', 'status', 'remove'] })
    .option('mode', { type: 'string', description: 'live or incremental', default: 'live' })
    .option('env-vars', { type: 'string', description: 'Inline env vars for NSSM' })
    .option('env-file', { type: 'string', description: 'Path to dotenv file' })
  , async (args) => {
    const action = args.action
    if (!action) {
      throw new Error('NSSM action is required')
    }
    await manageService(action, { mode: args.mode as Mode, envFile: args['env-file'], envVars: args['env-vars'] })
  })
  .command('feedback mark-good <responseId>', 'Mark a response as helpful', (y) => y
    .positional('responseId', { type: 'string', description: 'ID of the response file (without extension)' })
    .option('note', { type: 'string', description: 'Optional note describing why the response was helpful' })
  , async (args) => {
    const id = args.responseId
    if (!id) {
      throw new Error('responseId is required')
    }
    await markFeedback(id, 'good', args.note)
    console.log(`Marked ${id} as good`)
  })
  .command('feedback mark-bad <responseId>', 'Flag a response for review', (y) => y
    .positional('responseId', { type: 'string', description: 'ID of the response file (without extension)' })
    .option('note', { type: 'string', description: 'Optional note describing why it needs improvement' })
  , async (args) => {
    const id = args.responseId
    if (!id) {
      throw new Error('responseId is required')
    }
    await markFeedback(id, 'bad', args.note)
    console.log(`Marked ${id} as needing review`)
  })
  .command('report summary', 'Show the most recent cycle statistics', () => {}, async () => {
    await reportSummary()
  })
  .command('security-test', 'run prompt injection security tests', () => {}, async () => {
    const { runSecurityTests } = await import('./security/index.js')
    const results = runSecurityTests()
    let passed = 0
    let failed = 0
    for (const r of results) {
      const status = r.passed ? 'PASS' : 'FAIL'
      console.log(`[${status}] ${r.name}: expected=${r.expected}, actual=${r.actual}`)
      if (r.passed) passed++
      else failed++
    }
    console.log(`\n${passed} passed, ${failed} failed out of ${results.length} tests`)
    if (failed > 0) process.exit(1)
  })
  .command('security-scan <repo>', 'scan synced issues for prompt injection', (y) => y
    .positional('repo', { type: 'string', description: 'Repo slug (e.g. game-ci-unity-builder)' })
  , async (args) => {
    const { scanSyncedIssues, writeSecurityReport } = await import('./security/index.js')
    const slug = args.repo
    if (!slug) throw new Error('repo slug required')
    console.log(`Scanning ${slug}...`)
    const findings = await scanSyncedIssues(slug)
    const dateStr = new Date().toISOString().split('T')[0]
    if (findings.length > 0) {
      const reportPath = await writeSecurityReport(findings, dateStr)
      console.log(`Found ${findings.length} findings. Report: ${reportPath}`)
      for (const f of findings) {
        console.log(`  [${f.severity.toUpperCase()}] ${f.pattern} in ${f.location}${f.lineNumber ? `:${f.lineNumber}` : ''}: ${f.matchedText.substring(0, 80)}`)
      }
    } else {
      console.log('No security concerns found.')
    }
  })
  .command('review-quality', 'interactive quality review of recent responses', (y) => y
    .option('model', { type: 'string', description: 'Override model for review (e.g. claude-opus-4-20250514)' })
  , async (args) => {
    const { runQualityReview } = await import('./review/quality.js')
    await runQualityReview({ modelOverride: args.model })
  })
  .command('review-security', 'interactive security audit of recent responses and system output', (y) => y
    .option('model', { type: 'string', description: 'Override model for review (e.g. claude-opus-4-20250514)' })
  , async (args) => {
    const { runSecurityReview } = await import('./review/security.js')
    await runSecurityReview({ modelOverride: args.model })
  })
  .demandCommand(1, 'Specify a command')
  .strict()
  .help()
  .parse()
