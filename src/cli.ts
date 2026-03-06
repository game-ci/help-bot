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
    })
  })
  .command('continuous', 'run continuous mode', (y) => y
    .option('interval', { type: 'number', description: 'Cycle interval in minutes' })
    .option('provider', { type: 'string', description: 'Override LLM provider' })
  , async (args) => {
    await ensureDiscordToken()
    await runContinuous({ intervalMinutes: args.interval, provider: args.provider })
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
  .demandCommand(1, 'Specify a command')
  .strict()
  .help()
  .parse()
