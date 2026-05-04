"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncGitHub = syncGitHub;
const node_path_1 = require("node:path");
const fs_1 = require("../utils/fs");
const promises_1 = require("node:fs/promises");
const paths_1 = require("../utils/paths");
const config_1 = require("../config");
const state_1 = require("../state");
const metrics_1 = require("../metrics");
const DEFAULT_REPOS = [
    'game-ci/unity-builder',
    'game-ci/unity-test-runner',
    'game-ci/unity-actions',
    'game-ci/docker',
    'game-ci/steam-deploy',
];
const ISSUE_HEADERS = {
    accept: 'application/vnd.github.squirrel-girl-preview+json',
};
async function getOctokitConstructor() {
    const module = await import('@octokit/rest');
    return module.Octokit;
}
function slugRepo(repo) {
    return repo.replace(/\//g, '-');
}
function escapeFrontMatter(value) {
    return (value ?? '').replace(/"/g, '\\"');
}
function summarizeReactions(source) {
    const scores = {};
    if (Array.isArray(source)) {
        for (const reaction of source) {
            const name = reaction.content ?? 'unknown';
            scores[name] = (scores[name] ?? 0) + 1;
        }
        return scores;
    }
    if (source && typeof source === 'object') {
        for (const [key, value] of Object.entries(source)) {
            if (['url', 'total_count'].includes(key)) {
                continue;
            }
            if (typeof value === 'number' && value > 0) {
                scores[key] = value;
            }
        }
    }
    return scores;
}
function formatComments(title, comments) {
    if (!comments.length) {
        return '';
    }
    let section = `\n\n## ${title}\n`;
    for (const comment of comments) {
        const author = comment.user?.login ?? 'unknown';
        const date = comment.created_at ?? comment.createdAt ?? 'unknown';
        const body = (comment.body ?? '').trim();
        const reactions = summarizeReactions(comment.reactions?.nodes ?? comment.reactions ?? []);
        const reactionLines = Object.entries(reactions)
            .map(([key, value]) => `${key}: ${value}`)
            .join(', ');
        section += `\n### @${author} (${date})\n`;
        if (reactionLines) {
            section += `> reactions: ${reactionLines}\n\n`;
        }
        section += `${body}\n\n---\n`;
    }
    return section;
}
function buildMetadata(issue, repo, repoShort, hasOfficial, reactions, commentCount, reviewCommentCount) {
    const labelNames = (issue.labels ?? []).map((label) => label.name?.trim()).filter(Boolean);
    const metadata = `---
title: "${escapeFrontMatter(issue.title ?? '')}"
number: ${issue.number}
state: ${issue.state}
repo: ${repo}
type: ${issue.pull_request ? 'pull_request' : 'issue'}
labels: ${JSON.stringify(labelNames)}
author: "${escapeFrontMatter(issue.user?.login ?? 'unknown')}"
created: ${issue.created_at}
updated: ${issue.updated_at}
url: ${issue.html_url}
comment_count: ${commentCount}
review_comment_count: ${reviewCommentCount}
official_response: ${hasOfficial ? 'true' : 'false'}
reactions: ${JSON.stringify(reactions)}
response_id: "${repoShort}-${issue.number}"
---
`;
    return metadata;
}
async function syncGitHub(options = {}) {
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    if (!token) {
        console.warn('GitHub sync skipped: GITHUB_TOKEN/GH_TOKEN is missing.');
        return;
    }
    const config = await (0, config_1.getConfig)();
    const repoList = options.repos?.length
        ? options.repos
        : (0, config_1.getValue)(config, ['github', 'repos'], DEFAULT_REPOS);
    const collaboratorList = ((0, config_1.getValue)(config, ['github', 'collaborators'], []).map((entry) => entry.toLowerCase()));
    const Octokit = await getOctokitConstructor();
    const octokit = new Octokit({ auth: token, userAgent: 'GameCI Help Bot' });
    const state = await (0, state_1.loadState)();
    state.github ??= {};
    await (0, fs_1.ensureDir)(paths_1.GITHUB_DATA_DIR);
    for (const repo of repoList) {
        const [owner, name] = repo.split('/');
        if (!owner || !name) {
            continue;
        }
        const repoShort = slugRepo(repo);
        const repoDir = (0, node_path_1.join)(paths_1.GITHUB_DATA_DIR, repoShort);
        await (0, fs_1.ensureDir)(repoDir);
        console.log(`Syncing GitHub repo ${repo}...`);
        const repoState = state.github?.[repo] ?? {};
        // Fall back to sync_days config when no cursor exists (first run / reset)
        const syncDays = Number((0, config_1.getValue)(config, ['github', 'sync_days'], 7));
        const sinceFallback = new Date(Date.now() - syncDays * 24 * 60 * 60 * 1000).toISOString();
        const issues = await octokit.paginate(octokit.rest.issues.listForRepo, {
            owner,
            repo: name,
            state: 'all',
            since: repoState.issueCursor ?? sinceFallback,
            per_page: 100,
            headers: ISSUE_HEADERS,
        });
        (0, metrics_1.recordStat)('githubIssuesSynced', issues.length);
        for (const issue of issues) {
            const description = issue.body ?? '';
            const comments = await octokit.paginate(octokit.rest.issues.listComments, {
                owner,
                repo: name,
                issue_number: issue.number,
                since: repoState.commentCursor,
                per_page: 100,
            });
            const reviewComments = issue.pull_request
                ? await octokit.paginate(octokit.rest.pulls.listReviewComments, {
                    owner,
                    repo: name,
                    pull_number: issue.number,
                    since: repoState.commentCursor,
                    per_page: 100,
                })
                : [];
            const allAuthors = new Set();
            const trackAuthor = (value) => {
                if (!value)
                    return;
                allAuthors.add(value.toLowerCase());
            };
            trackAuthor(issue.user?.login);
            for (const comment of comments) {
                trackAuthor(comment.user?.login);
            }
            for (const review of reviewComments) {
                trackAuthor(review.user?.login);
            }
            const hasOfficial = collaboratorList.some((login) => allAuthors.has(login));
            const issueReactions = summarizeReactions(issue.reactions ?? {});
            const metadata = buildMetadata(issue, repo, repoShort, hasOfficial, issueReactions, comments.length, reviewComments.length);
            const bodySections = [
                metadata,
                description.trim(),
                formatComments('Issue comments', comments),
                formatComments('Review comments', reviewComments),
            ].map((section) => section.trim()).filter(Boolean);
            const markdownContent = bodySections.join('\n\n');
            const markdownFile = (0, node_path_1.join)(repoDir, `${issue.number}.md`);
            await (0, promises_1.writeFile)(markdownFile, markdownContent, 'utf-8');
        }
        const releasesDir = (0, node_path_1.join)(paths_1.GITHUB_DATA_DIR, 'releases');
        const tagsDir = (0, node_path_1.join)(paths_1.GITHUB_DATA_DIR, 'tags');
        await (0, fs_1.ensureDir)(releasesDir);
        await (0, fs_1.ensureDir)(tagsDir);
        const releases = await octokit.paginate(octokit.rest.repos.listReleases, {
            owner,
            repo: name,
            per_page: 100,
        });
        await (0, fs_1.writeJson)((0, node_path_1.join)(releasesDir, `${repoShort}.json`), releases);
        (0, metrics_1.recordStat)('githubReleasesSynced', releases.length);
        const tags = await octokit.paginate(octokit.rest.repos.listTags, {
            owner,
            repo: name,
            per_page: 100,
        });
        await (0, fs_1.writeJson)((0, node_path_1.join)(tagsDir, `${repoShort}.json`), tags);
        (0, metrics_1.recordStat)('githubTagsSynced', tags.length);
        const now = new Date().toISOString();
        state.github[repo] = {
            ...repoState,
            issueCursor: now,
            commentCursor: now,
            releaseCursor: now,
            tagCursor: now,
        };
    }
    await (0, state_1.saveState)(state);
}
