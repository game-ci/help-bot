"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.postGitHubResponses = postGitHubResponses;
const node_child_process_1 = require("node:child_process");
const node_util_1 = require("node:util");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const frontmatter_1 = require("../utils/frontmatter");
const paths_1 = require("../utils/paths");
const metrics_1 = require("../metrics");
const state_1 = require("../state");
const execFileAsync = (0, node_util_1.promisify)(node_child_process_1.execFile);
const FEEDBACK_PROMPT = '\n\n---\n<sub>Was this helpful? React with :+1: or :-1: to help improve future responses.</sub>';
async function postGitHubResponses(options) {
    const repoDir = (0, node_path_1.join)(paths_1.RESPONSES_DIR, 'github');
    let files = [];
    try {
        files = await (0, promises_1.readdir)(repoDir);
    }
    catch {
        return;
    }
    const state = await (0, state_1.loadState)();
    const postedResponses = (0, state_1.getPostedResponses)(state);
    const postedResponseIds = (0, state_1.getPostedResponseIds)(state);
    for (const file of files.filter((f) => f.endsWith('.md') && !f.includes('-investigation'))) {
        const fullPath = (0, node_path_1.join)(repoDir, file);
        const content = await (0, promises_1.readFile)(fullPath, 'utf-8');
        const { meta, body } = (0, frontmatter_1.parseFrontMatter)(content);
        const repo = typeof meta.repo === 'string' ? meta.repo : '';
        const number = Number(meta.issue_number ?? meta.number);
        if (!repo || !number) {
            console.warn(`Skipping ${file}: missing repo or issue number`);
            continue;
        }
        const responseId = meta.response_id ?? file.replace(/\.md$/, '');
        const isOfficial = String(meta.official_response)?.toLowerCase() === 'true';
        if (options.forceReplyId !== responseId) {
            if (postedResponseIds[responseId]) {
                console.log(`Skipping GitHub response ${responseId}: response artifact already posted.`);
                (0, metrics_1.recordStat)('githubResponsesSkipped', 1);
                continue;
            }
            const postedAt = postedResponses[`${repo}#${number}`];
            if (postedAt && await isFileOlderThan(fullPath, postedAt)) {
                console.log(`Skipping GitHub response ${responseId}: ${repo}#${number} was already answered after this file was written.`);
                (0, metrics_1.recordStat)('githubResponsesSkipped', 1);
                continue;
            }
        }
        if (isOfficial && !options.allowOfficial && options.forceReplyId !== responseId) {
            console.log(`Skipping GitHub response ${responseId} because an official collaborator already replied.`);
            (0, metrics_1.recordStat)('githubResponsesSkipped', 1);
            continue;
        }
        if (options.dryRun) {
            console.log(`DRY RUN: would post GitHub response for ${repo}#${number}`);
            continue;
        }
        // Strip any LLM-generated feedback prompt to avoid duplicates, then append ours
        const cleanedBody = body
            .replace(/<sub>\s*Was this helpful\?[^<]*<\/sub>/gi, '')
            .replace(/Was this helpful\?\s*React with[^\n]*/gi, '')
            .trim();
        const bodyWithFeedback = cleanedBody + FEEDBACK_PROMPT;
        try {
            // Post comment and capture the comment URL (contains comment ID)
            const { stdout } = await execFileAsync('gh', [
                'issue', 'comment', String(number),
                '--repo', repo,
                '--body', bodyWithFeedback,
            ]);
            const commentUrl = stdout.trim();
            // Extract comment ID from URL like https://github.com/.../issues/N#issuecomment-XXXXX
            const commentIdMatch = commentUrl.match(/issuecomment-(\d+)/);
            const commentId = commentIdMatch ? commentIdMatch[1] : undefined;
            (0, metrics_1.recordStat)('githubResponsesPosted', 1);
            // Track the posted response with comment ID for feedback polling
            await (0, state_1.updateState)((s) => {
                (0, state_1.setPostedResponseId)(s, responseId);
                (0, state_1.setPostedResponse)(s, repo, number);
                if (commentId) {
                    s.meta ??= {};
                    const botComments = s.meta.botComments ?? {};
                    botComments[`${repo}#${number}`] = {
                        commentId,
                        repo,
                        issueNumber: number,
                        postedAt: new Date().toISOString(),
                    };
                    s.meta.botComments = botComments;
                }
            });
            postedResponseIds[responseId] = new Date().toISOString();
            postedResponses[`${repo}#${number}`] = postedResponseIds[responseId];
            console.log(`Posted GitHub response for ${repo}#${number}${commentId ? ` (comment ${commentId})` : ''}`);
        }
        catch (error) {
            console.warn(`Failed to post GitHub response for ${repo}#${number}: ${error.message ?? error}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
}
async function isFileOlderThan(filePath, isoTimestamp) {
    const timestamp = new Date(isoTimestamp).getTime();
    if (!Number.isFinite(timestamp))
        return false;
    try {
        const fileStat = await (0, promises_1.stat)(filePath);
        return fileStat.mtime.getTime() <= timestamp;
    }
    catch {
        return false;
    }
}
