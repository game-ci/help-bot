"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncDiscord = syncDiscord;
const undici_1 = require("undici");
const fs_1 = require("../utils/fs");
const paths_1 = require("../utils/paths");
const config_1 = require("../config");
const node_path_1 = require("node:path");
const state_1 = require("../state");
const metrics_1 = require("../metrics");
const DISCORD_API = 'https://discord.com/api/v10';
function buildHeaders(token) {
    return {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
    };
}
function snowflakeFromHoursAgo(hours) {
    const now = BigInt(Date.now());
    const offset = BigInt(hours) * 3600n * 1000n;
    const target = now - offset;
    const discordEpoch = 1420070400000n;
    return (target - discordEpoch) << 22n;
}
async function fetchWithRetry(url, headers) {
    const res = await (0, undici_1.request)(url, { method: 'GET', headers });
    if (res.statusCode === 429) {
        const body = await res.body.text();
        const data = JSON.parse(body);
        const wait = (data.retry_after ?? 1) * 1000;
        await new Promise((resolve) => setTimeout(resolve, wait));
        return (0, undici_1.request)(url, { method: 'GET', headers });
    }
    return res;
}
async function syncGuild(guild, token, config) {
    const guildId = process.env[guild.guild_id_env];
    if (!guildId) {
        console.warn(`Skipping guild "${guild.name}": env var ${guild.guild_id_env} is not set`);
        return;
    }
    const syncHours = Number((0, config_1.getValue)(config, ['discord', 'sync_hours'], 6));
    const ignoreBots = Boolean((0, config_1.getValue)(config, ['discord', 'ignore_bots'], true));
    const minMessage = Number((0, config_1.getValue)(config, ['discord', 'min_message_length'], 15));
    const ignorePrefixes = (0, config_1.getValue)(config, ['discord', 'ignore_prefixes'], ['!', '/', '$', '.']);
    const officialRoles = (0, config_1.getValue)(config, ['discord', 'official_roles'], []).map((role) => role.toLowerCase());
    const officialUsers = (0, config_1.getValue)(config, ['discord', 'official_users'], []).map((id) => id.toLowerCase());
    const channelNames = guild.channels.map((ch) => ch.name);
    const afterSnowflake = snowflakeFromHoursAgo(syncHours);
    const headers = buildHeaders(token);
    const channelResponse = await fetchWithRetry(`${DISCORD_API}/guilds/${guildId}/channels`, headers);
    if (channelResponse.statusCode >= 400) {
        throw new Error(`Failed to list guild channels for "${guild.name}": ${channelResponse.statusCode}`);
    }
    const channelList = JSON.parse(await channelResponse.body.text());
    const channels = Array.isArray(channelList) ? channelList : [];
    const state = await (0, state_1.loadState)();
    for (const channelName of channelNames) {
        const channel = channels.find((c) => c.name === channelName && c.type === 0);
        if (!channel) {
            console.warn(`Channel ${channelName} not found in guild "${guild.name}", skipping.`);
            continue;
        }
        const channelId = channel.id;
        console.log(`Syncing guild "${guild.name}" channel ${channelName} (${channelId})...`);
        const storedCursor = (0, state_1.getGuildCursor)(state, guild.name, channelId);
        let currentAfter = storedCursor ? BigInt(storedCursor) : afterSnowflake;
        const channelDir = (0, paths_1.guildChannelDir)(guild.name, channelName);
        await (0, fs_1.ensureDir)(channelDir);
        while (true) {
            const url = `${DISCORD_API}/channels/${channelId}/messages?limit=100&after=${currentAfter}`;
            const response = await fetchWithRetry(url, headers);
            const text = await response.body.text();
            if (response.statusCode !== 200) {
                console.warn(`Discord API returned ${response.statusCode} for ${channelName} in guild "${guild.name}"`);
                break;
            }
            const messages = JSON.parse(text);
            if (!Array.isArray(messages) || messages.length === 0) {
                break;
            }
            (0, metrics_1.recordStat)('discordMessagesSynced', messages.length, guild.name);
            for (const msg of messages) {
                if (ignoreBots && msg?.author?.bot) {
                    continue;
                }
                if (typeof msg.content !== 'string' || msg.content.trim().length < minMessage) {
                    continue;
                }
                const trimmed = msg.content.trim();
                if (ignorePrefixes.some((prefix) => trimmed.startsWith(prefix))) {
                    continue;
                }
                const timestamp = msg.timestamp ?? new Date().toISOString();
                const dateKey = new Date(timestamp).toISOString().slice(0, 10);
                const memberRoles = (msg.member?.roles ?? []);
                const isOfficial = memberRoles.some((role) => officialRoles.includes(role.toLowerCase())) ||
                    officialUsers.includes((msg.author?.id ?? '').toLowerCase());
                const record = JSON.stringify({
                    id: msg.id,
                    author: msg?.author?.username ?? 'unknown',
                    author_id: msg?.author?.id,
                    content: msg.content,
                    timestamp,
                    channel_id: channelId,
                    channel_name: channelName,
                    guild_name: guild.name,
                    is_bot: msg?.author?.bot ?? false,
                    has_reply: Boolean(msg.referenced_message),
                    message_type: msg.type ?? 0,
                    is_official: isOfficial,
                });
                const targetFile = (0, node_path_1.join)(channelDir, `${dateKey}.jsonl`);
                await (0, fs_1.appendText)(targetFile, `${record}\n`);
            }
            const lastId = messages[messages.length - 1]?.id;
            if (!lastId) {
                break;
            }
            currentAfter = BigInt(lastId);
            if (messages.length < 100) {
                break;
            }
        }
        (0, state_1.setGuildCursor)(state, guild.name, channelId, currentAfter.toString());
    }
    await (0, state_1.saveState)(state);
}
async function syncDiscord() {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) {
        throw new Error('DISCORD_BOT_TOKEN is required');
    }
    const config = await (0, config_1.getConfig)();
    const discordConfig = (0, config_1.getValue)(config, ['discord'], {});
    const guilds = (0, config_1.resolveGuilds)(discordConfig);
    if (guilds.length === 0) {
        console.warn('No Discord guilds configured. Skipping Discord sync.');
        return;
    }
    for (const guild of guilds) {
        await syncGuild(guild, token, config);
    }
}
