"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.postDiscordResponses = postDiscordResponses;
const undici_1 = require("undici");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const frontmatter_1 = require("../utils/frontmatter");
const paths_1 = require("../utils/paths");
const config_1 = require("../config");
const metrics_1 = require("../metrics");
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
async function sendSeenYouNotification(webhook, message) {
    await postToWebhook(webhook, { content: message });
}
/**
 * Post Discord responses, iterating over configured guilds to resolve
 * per-guild webhook URLs.
 */
async function postDiscordResponses(options) {
    const config = await (0, config_1.getConfig)();
    const discordConfig = (0, config_1.getValue)(config, ['discord'], {});
    const guilds = (0, config_1.resolveGuilds)(discordConfig);
    if (guilds.length === 0) {
        console.warn('No Discord guilds configured. Skipping Discord posting.');
        return;
    }
    // Build a lookup from guild name to webhook URL
    const guildWebhooks = new Map();
    for (const guild of guilds) {
        const webhookUrl = process.env[guild.webhook_url_env];
        if (webhookUrl) {
            guildWebhooks.set(guild.name, webhookUrl);
        }
    }
    // Fallback: global DISCORD_WEBHOOK_URL for any guild without a specific one
    const globalWebhook = process.env.DISCORD_WEBHOOK_URL;
    const discordDir = (0, node_path_1.join)(paths_1.RESPONSES_DIR, 'discord');
    let files = [];
    try {
        files = await (0, promises_1.readdir)(discordDir);
    }
    catch {
        return;
    }
    for (const file of files.filter((f) => f.endsWith('.md'))) {
        const fullPath = (0, node_path_1.join)(discordDir, file);
        const content = await (0, promises_1.readFile)(fullPath, 'utf-8');
        const { meta, body } = (0, frontmatter_1.parseFrontMatter)(content);
        const responseId = meta.response_id ?? file.replace(/\.md$/, '');
        const isOfficial = String(meta.official_response)?.toLowerCase() === 'true';
        // Determine the webhook for this response
        const responseGuild = meta.guild_name ?? '';
        const webhook = guildWebhooks.get(responseGuild) ?? globalWebhook;
        if (!webhook) {
            console.warn(`Skipping Discord response ${responseId}: no webhook URL found for guild "${responseGuild}". ` +
                'Set the appropriate env var or DISCORD_WEBHOOK_URL.');
            continue;
        }
        if (isOfficial && !options.allowOfficial && options.forceReplyId !== responseId) {
            console.log(`Skipping Discord response ${responseId} because an official contributor already replied.`);
            (0, metrics_1.recordStat)('discordResponsesSkipped', 1);
            if (!options.dryRun && options.seenYouMessage) {
                const emojiPrefix = options.seenYouEmoji ? `${options.seenYouEmoji} ` : '';
                await sendSeenYouNotification(webhook, `${emojiPrefix}${options.seenYouMessage}`);
            }
            continue;
        }
        if (options.dryRun) {
            console.log(`DRY RUN: would post Discord response from ${file}`);
            continue;
        }
        const trimmed = body.trim();
        if (!trimmed) {
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
            (0, metrics_1.recordStat)('discordResponsesPosted', 1);
            await new Promise((resolve) => setTimeout(resolve, 1500));
        }
    }
}
