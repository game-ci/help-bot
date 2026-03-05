"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runCycle = runCycle;
const fs_1 = require("../utils/fs");
const paths_1 = require("../utils/paths");
const discord_1 = require("../sync/discord");
const github_1 = require("../sync/github");
const docs_1 = require("../sync/docs");
const llm_1 = require("../provider/llm");
const discord_2 = require("../post/discord");
const github_2 = require("../post/github");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const config_1 = require("../config");
async function runCycle(options = {}) {
    await (0, fs_1.ensureDir)(paths_1.RESPONSES_DIR);
    await (0, fs_1.ensureDir)((0, node_path_1.join)(paths_1.RESPONSES_DIR, 'discord'));
    await (0, fs_1.ensureDir)((0, node_path_1.join)(paths_1.RESPONSES_DIR, 'github'));
    await (0, fs_1.ensureDir)(paths_1.LOGS_DIR);
    const config = await (0, config_1.getConfig)();
    const dryRun = options.dryRun ?? Boolean((0, config_1.getValue)(config, ['bot', 'dry_run'], false));
    const skipSync = options.skipSync ?? process.env.SKIP_SYNC === 'true';
    const skipGithubPost = options.skipGithubPost ?? process.env.SKIP_GITHUB_POST === 'true';
    if (!skipSync) {
        console.log('Syncing Discord...');
        await (0, discord_1.syncDiscord)();
        console.log('Syncing GitHub...');
        await (0, github_1.syncGitHub)();
        console.log('Syncing docs...');
        await (0, docs_1.syncDocs)();
    }
    else {
        console.log('Skipping sync steps (skipSync=true)');
    }
    const claudeInstructions = await (0, promises_1.readFile)((0, node_path_1.join)(paths_1.REPO_ROOT, 'CLAUDE.md'), 'utf-8').catch(() => '');
    const prompt = `${claudeInstructions}

You are running a help cycle for the GameCI Community Help Bot.
Process the synced data under data/ and write structured responses into data/responses/discord and data/responses/github.
`;
    console.log('Running LLM provider...');
    await (0, llm_1.runProvider)(prompt, { provider: options.provider });
    console.log('Posting Discord responses (dry run: ' + dryRun + ')...');
    await (0, discord_2.postDiscordResponses)(dryRun);
    if (skipGithubPost) {
        console.log('Skipping GitHub posting (skipGithubPost=true)');
    }
    else {
        console.log('Posting GitHub responses (dry run: ' + dryRun + ')...');
        await (0, github_2.postGitHubResponses)(dryRun);
    }
}
