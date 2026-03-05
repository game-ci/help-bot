"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncGitHub = syncGitHub;
const node_child_process_1 = require("node:child_process");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const node_util_1 = require("node:util");
const fs_1 = require("../utils/fs");
const paths_1 = require("../utils/paths");
const config_1 = require("../config");
const execFileAsync = (0, node_util_1.promisify)(node_child_process_1.execFile);
async function ghJson(args) {
    try {
        const { stdout } = await execFileAsync('gh', args);
        return JSON.parse(stdout);
    }
    catch (error) {
        console.error('gh command failed', error.message);
        throw error;
    }
}
function escapeFrontMatter(value) {
    return (value ?? '').replace(/"/g, '\\"');
}
function formatIssue(issue, repo) {
    const labelNames = issue.labels.map((label) => label.name?.trim()).filter(Boolean);
    const commentCount = issue.comments.length;
    let commentsSection = '';
    if (commentCount > 0) {
        commentsSection = '\n\n## Comments\n';
        for (const comment of issue.comments) {
            const author = comment.author?.login ?? 'unknown';
            const body = comment.body?.trim() ?? '';
            const date = comment.createdAt;
            commentsSection += `\n### @${author} (${date})\n\n${body}\n\n---\n`;
        }
    }
    const metadata = `---
title: "${escapeFrontMatter(issue.title)}"
number: ${issue.number}
state: ${issue.state}
repo: ${repo}
type: ${issue.pullRequest ? 'pull_request' : 'issue'}
labels: ${JSON.stringify(labelNames)}
author: "${escapeFrontMatter(issue.author?.login ?? 'unknown')}"
created: ${issue.createdAt}
updated: ${issue.updatedAt}
url: ${issue.url}
comment_count: ${commentCount}
---
`;
    const body = issue.body ?? '';
    return `${metadata}\n${body.trim()}\n${commentsSection}`.trim() + '\n';
}
async function syncGitHub() {
    if (!process.env.GITHUB_TOKEN && !process.env.GH_TOKEN) {
        console.warn('gh CLI requires authentication. Skipping GitHub sync.');
        return;
    }
    const config = await (0, config_1.getConfig)();
    const repoList = (0, config_1.getValue)(config, ['github', 'repos'], [
        'game-ci/unity-builder',
        'game-ci/unity-test-runner',
        'game-ci/unity-actions',
        'game-ci/docker',
        'game-ci/steam-deploy',
    ]);
    const maxIssues = Number((0, config_1.getValue)(config, ['github', 'max_issues_per_repo'], 200));
    await (0, fs_1.ensureDir)(paths_1.GITHUB_DATA_DIR);
    for (const repo of repoList) {
        const repoShort = repo.replace(/\//g, '-');
        const path = (0, node_path_1.join)(paths_1.GITHUB_DATA_DIR, repoShort);
        await (0, fs_1.ensureDir)(path);
        console.log(`Syncing issues for ${repo}...`);
        const issues = (await ghJson([
            'issue',
            'list',
            '--repo',
            repo,
            '--state',
            'open',
            '--limit',
            String(maxIssues),
            '--json',
            'number,title,state,labels,author,createdAt,updatedAt,body,comments,url,pullRequest',
        ]));
        for (const issue of issues) {
            const file = (0, node_path_1.join)(path, `${issue.number}.md`);
            const content = formatIssue(issue, repo);
            await (0, promises_1.writeFile)(file, content, 'utf-8');
        }
    }
}
