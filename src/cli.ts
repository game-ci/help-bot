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

yargs(hideBin(process.argv))
  .scriptName('gameci-help-bot')
  .command('cycle', 'run a single help cycle', (y) => y
    .option('dry-run', { type: 'boolean', description: 'Draft responses without posting' })
    .option('skip-sync', { type: 'boolean', description: 'Skip data syncing' })
    .option('skip-github-post', { type: 'boolean', description: 'Do not post to GitHub' })
    .option('provider', { type: 'string', description: 'Override LLM provider (claude|lm_studio|continue|codex)' })
  , async (args) => {
    await ensureDiscordToken()
    await runCycle({ dryRun: args['dry-run'] || false, skipSync: args['skip-sync'] || false, skipGithubPost: args['skip-github-post'] || false, provider: args.provider })
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
  .demandCommand(1, 'Specify a command')
  .strict()
  .help()
  .parse()
