"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.postDiscordResponses = postDiscordResponses;
const undici_1 = require("undici");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const frontmatter_1 = require("../utils/frontmatter");
const paths_1 = require("../utils/paths");
const MAX_LENGTH = 2000;
function splitContent(content) {
    const chunks = [];
    let remaining = content.trim();
    while (remaining.length > 0) {
        if (remaining.length <= MAX_LENGTH) {
            chunks.push(remaining);
            break;
        }
        let splitAt = remaining.lastIndexOf('\n', MAX_LENGTH);
        if (splitAt < 0 || splitAt < MAX_LENGTH / 2) {
            splitAt = MAX_LENGTH;
        }
        chunks.push(remaining.slice(0, splitAt).trim());
        remaining = remaining.slice(splitAt).trimStart();
    }
    return chunks;
}
async function postToWebhook(webhook, payload) {
    const response = await (0, undici_1.request)(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    return response.statusCode === 204 || response.statusCode === 200;
}
async function postDiscordResponses(dryRun = false) {
    const discordDir = (0, node_path_1.join)(paths_1.RESPONSES_DIR, 'discord');
    let files = [];
    try {
        files = await (0, promises_1.readdir)(discordDir);
    }
    catch {
        return;
    }
    const webhook = process.env.DISCORD_WEBHOOK_URL;
    if (!webhook) {
        throw new Error('DISCORD_WEBHOOK_URL is required to post Discord responses');
    }
    for (const file of files.filter((f) => f.endsWith('.md'))) {
        const fullPath = (0, node_path_1.join)(discordDir, file);
        const content = await (0, promises_1.readFile)(fullPath, 'utf-8');
        const { body } = (0, frontmatter_1.parseFrontMatter)(content);
        const trimmed = body.trim();
        if (!trimmed) {
            continue;
        }
        if (dryRun) {
            console.log(`DRY RUN: would post Discord response from ${file}`);
            continue;
        }
        const chunks = splitContent(trimmed);
        for (const [index, chunk] of chunks.entries()) {
            const payload = {
                content: chunk,
                username: 'GameCI Help Bot',
            };
            if (chunks.length > 1) {
                payload.content = `(part ${index + 1}/${chunks.length})\n${chunk}`;
            }
            const success = await postToWebhook(webhook, payload);
            if (!success) {
                console.warn(`Failed to post Discord chunk ${index + 1}/${chunks.length} for ${file}`);
            }
            await new Promise((resolve) => setTimeout(resolve, 1500));
        }
    }
}
