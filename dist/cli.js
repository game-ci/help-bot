"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const yargs_1 = __importDefault(require("yargs/yargs"));
const helpers_1 = require("yargs/helpers");
const cycle_1 = require("./core/cycle");
const continuous_1 = require("./core/continuous");
const discord_1 = require("./sync/discord");
const github_1 = require("./sync/github");
const docs_1 = require("./sync/docs");
const vector_bake_1 = require("./core/vector-bake");
const nssm_service_1 = require("./core/nssm-service");
const helper_1 = require("./token/helper");
(0, yargs_1.default)((0, helpers_1.hideBin)(process.argv))
    .scriptName('gameci-help-bot')
    .command('cycle', 'run a single help cycle', (y) => y
    .option('dry-run', { type: 'boolean', description: 'Draft responses without posting' })
    .option('skip-sync', { type: 'boolean', description: 'Skip data syncing' })
    .option('skip-github-post', { type: 'boolean', description: 'Do not post to GitHub' })
    .option('provider', { type: 'string', description: 'Override LLM provider (claude|lm_studio|continue|codex)' }), async (args) => {
    await (0, helper_1.ensureDiscordToken)();
    await (0, cycle_1.runCycle)({ dryRun: args['dry-run'] || false, skipSync: args['skip-sync'] || false, skipGithubPost: args['skip-github-post'] || false, provider: args.provider });
})
    .command('continuous', 'run continuous mode', (y) => y
    .option('interval', { type: 'number', description: 'Cycle interval in minutes' })
    .option('provider', { type: 'string', description: 'Override LLM provider' }), async (args) => {
    await (0, helper_1.ensureDiscordToken)();
    await (0, continuous_1.runContinuous)({ intervalMinutes: args.interval, provider: args.provider });
})
    .command('sync-discord', 'sync Discord messages', () => { }, async () => { await (0, helper_1.ensureDiscordToken)(); await (0, discord_1.syncDiscord)(); })
    .command('sync-github', 'sync GitHub issues', () => { }, async () => { await (0, github_1.syncGitHub)(); })
    .command('sync-docs', 'sync docs pages', () => { }, async () => { await (0, docs_1.syncDocs)(); })
    .command('vector-bake', 'build the LlamaIndex vector store', () => { }, async () => { await (0, vector_bake_1.vectorBake)(); })
    .command('nssm <action>', 'manage the Windows NSSM service', (y) => y
    .positional('action', { choices: ['install', 'start', 'stop', 'restart', 'status', 'remove'] })
    .option('mode', { type: 'string', description: 'live or incremental', default: 'live' })
    .option('env-vars', { type: 'string', description: 'Inline env vars for NSSM' })
    .option('env-file', { type: 'string', description: 'Path to dotenv file' }), async (args) => {
    const action = args.action;
    if (!action) {
        throw new Error('NSSM action is required');
    }
    await (0, nssm_service_1.manageService)(action, { mode: args.mode, envFile: args['env-file'], envVars: args['env-vars'] });
})
    .demandCommand(1, 'Specify a command')
    .strict()
    .help()
    .parse();
