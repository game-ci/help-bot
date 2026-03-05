"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.postGitHubResponses = postGitHubResponses;
const node_child_process_1 = require("node:child_process");
const node_util_1 = require("node:util");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const frontmatter_1 = require("../utils/frontmatter");
const paths_1 = require("../utils/paths");
const execFileAsync = (0, node_util_1.promisify)(node_child_process_1.execFile);
async function postGitHubResponses(dryRun = false) {
    const repoDir = (0, node_path_1.join)(paths_1.RESPONSES_DIR, 'github');
    let files = [];
    try {
        files = await (0, promises_1.readdir)(repoDir);
    }
    catch {
        return;
    }
    if (dryRun) {
        console.log('GitHub posting skipped (dry run)');
        return;
    }
    for (const file of files.filter((f) => f.endsWith('.md'))) {
        const fullPath = (0, node_path_1.join)(repoDir, file);
        const content = await (0, promises_1.readFile)(fullPath, 'utf-8');
        const { meta, body } = (0, frontmatter_1.parseFrontMatter)(content);
        const repo = typeof meta.repo === 'string' ? meta.repo : '';
        const number = Number(meta.issue_number ?? meta.number);
        if (!repo || !number) {
            console.warn(`Skipping ${file}: missing repo or issue number`);
            continue;
        }
        try {
            await execFileAsync('gh', ['issue', 'comment', String(number), '--repo', repo, '--body', body]);
        }
        catch (error) {
            console.warn(`Failed to post GitHub response for ${repo}#${number}: ${error.message ?? error}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
}
