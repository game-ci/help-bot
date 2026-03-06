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
/** Discord channel types */
const CHANNEL_TEXT = 0;
const CHANNEL_ANNOUNCEMENT = 5;
const CHANNEL_ANNOUNCEMENT_THREAD = 10;
const CHANNEL_PUBLIC_THREAD = 11;
const CHANNEL_PRIVATE_THREAD = 12;
const CHANNEL_FORUM = 15;
const CHANNEL_MEDIA = 16;
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
/**
 * Summarize reactions on a message into a count map.
 */
function summarizeReactions(reactions) {
    const counts = {};
    if (!Array.isArray(reactions))
        return counts;
    for (const r of reactions) {
        const name = r.emoji?.name ?? 'unknown';
        counts[name] = r.count ?? 1;
    }
    return counts;
}
/**
 * Build a serializable referenced message object from the Discord API response.
 */
function buildReferencedMessage(ref) {
    if (!ref)
        return undefined;
    return {
        author: ref.author?.username ?? 'unknown',
        content: ref.content ?? '',
        id: ref.id ?? '',
    };
}
/**
 * Sync messages from a text channel.
 */
async function syncTextChannel(channel, guild, token, config, state, syncHours, ignoreBots, minMessage, ignorePrefixes, officialRoles, officialUsers) {
    const channelId = channel.id;
    const channelName = channel.name;
    const headers = buildHeaders(token);
    const afterSnowflake = snowflakeFromHoursAgo(syncHours);
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
                reactions: summarizeReactions(msg.reactions ?? []),
                referenced_message: buildReferencedMessage(msg.referenced_message),
                is_thread: false,
                is_forum_post: false,
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
/**
 * Sync threads within a text channel.
 * Fetches active threads and archived threads, then syncs messages from each.
 */
async function syncChannelThreads(parentChannelId, parentChannelName, guild, guildId, token, config, state, syncHours, ignoreBots, minMessage, ignorePrefixes, officialRoles, officialUsers) {
    const headers = buildHeaders(token);
    // Fetch active threads for the guild (Discord doesn't scope this to a channel, so we filter)
    let activeThreads = [];
    try {
        const res = await fetchWithRetry(`${DISCORD_API}/guilds/${guildId}/threads/active`, headers);
        if (res.statusCode === 200) {
            const data = JSON.parse(await res.body.text());
            activeThreads = (data.threads ?? []).filter((t) => t.parent_id === parentChannelId);
        }
    }
    catch (error) {
        console.warn(`  Failed to fetch active threads for ${parentChannelName}: ${error.message ?? error}`);
    }
    // Also fetch recently archived public threads
    try {
        const res = await fetchWithRetry(`${DISCORD_API}/channels/${parentChannelId}/threads/archived/public?limit=50`, headers);
        if (res.statusCode === 200) {
            const data = JSON.parse(await res.body.text());
            const archived = data.threads ?? [];
            activeThreads.push(...archived);
        }
    }
    catch {
        // Archived thread access may not be available
    }
    if (activeThreads.length === 0)
        return;
    console.log(`  Found ${activeThreads.length} threads in #${parentChannelName}`);
    (0, metrics_1.recordStat)('discordThreadsSynced', activeThreads.length, guild.name);
    const afterSnowflake = snowflakeFromHoursAgo(syncHours);
    for (const thread of activeThreads) {
        const threadId = thread.id;
        const threadName = thread.name ?? 'unnamed-thread';
        const storedCursor = (0, state_1.getGuildCursor)(state, guild.name, threadId);
        let currentAfter = storedCursor ? BigInt(storedCursor) : afterSnowflake;
        const channelDir = (0, paths_1.guildChannelDir)(guild.name, parentChannelName);
        await (0, fs_1.ensureDir)(channelDir);
        let messageCount = 0;
        while (true) {
            const url = `${DISCORD_API}/channels/${threadId}/messages?limit=100&after=${currentAfter}`;
            const response = await fetchWithRetry(url, headers);
            const text = await response.body.text();
            if (response.statusCode !== 200)
                break;
            const messages = JSON.parse(text);
            if (!Array.isArray(messages) || messages.length === 0)
                break;
            for (const msg of messages) {
                if (ignoreBots && msg?.author?.bot)
                    continue;
                if (typeof msg.content !== 'string' || msg.content.trim().length < minMessage)
                    continue;
                const trimmed = msg.content.trim();
                if (ignorePrefixes.some((prefix) => trimmed.startsWith(prefix)))
                    continue;
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
                    channel_id: parentChannelId,
                    channel_name: parentChannelName,
                    guild_name: guild.name,
                    is_bot: msg?.author?.bot ?? false,
                    has_reply: Boolean(msg.referenced_message),
                    message_type: msg.type ?? 0,
                    is_official: isOfficial,
                    reactions: summarizeReactions(msg.reactions ?? []),
                    referenced_message: buildReferencedMessage(msg.referenced_message),
                    thread_id: threadId,
                    thread_name: threadName,
                    is_thread: true,
                    is_forum_post: false,
                });
                const targetFile = (0, node_path_1.join)(channelDir, `${dateKey}.jsonl`);
                await (0, fs_1.appendText)(targetFile, `${record}\n`);
                messageCount++;
            }
            const lastId = messages[messages.length - 1]?.id;
            if (!lastId)
                break;
            currentAfter = BigInt(lastId);
            if (messages.length < 100)
                break;
        }
        (0, state_1.setGuildCursor)(state, guild.name, threadId, currentAfter.toString());
        if (messageCount > 0) {
            (0, metrics_1.recordStat)('discordMessagesSynced', messageCount, guild.name);
        }
    }
}
/**
 * Sync forum channel posts (each post is a thread).
 * Fetches active threads from the forum and syncs their messages.
 */
async function syncForumChannel(channel, guild, guildId, token, config, state, syncHours, ignoreBots, minMessage, ignorePrefixes, officialRoles, officialUsers) {
    const headers = buildHeaders(token);
    const channelId = channel.id;
    const channelName = channel.name;
    console.log(`Syncing guild "${guild.name}" forum #${channelName} (${channelId})...`);
    // Fetch active threads in this forum
    let forumThreads = [];
    try {
        const res = await fetchWithRetry(`${DISCORD_API}/guilds/${guildId}/threads/active`, headers);
        if (res.statusCode === 200) {
            const data = JSON.parse(await res.body.text());
            forumThreads = (data.threads ?? []).filter((t) => t.parent_id === channelId);
        }
    }
    catch (error) {
        console.warn(`  Failed to fetch forum threads for ${channelName}: ${error.message ?? error}`);
        return;
    }
    // Also fetch recently archived threads
    try {
        const res = await fetchWithRetry(`${DISCORD_API}/channels/${channelId}/threads/archived/public?limit=50`, headers);
        if (res.statusCode === 200) {
            const data = JSON.parse(await res.body.text());
            forumThreads.push(...(data.threads ?? []));
        }
    }
    catch {
        // Archived thread access may not be available
    }
    if (forumThreads.length === 0) {
        console.log(`  No threads found in forum #${channelName}`);
        return;
    }
    console.log(`  Found ${forumThreads.length} forum posts in #${channelName}`);
    (0, metrics_1.recordStat)('discordForumPostsSynced', forumThreads.length, guild.name);
    const afterSnowflake = snowflakeFromHoursAgo(syncHours);
    const forumDir = (0, paths_1.guildForumDir)(guild.name, channelName);
    await (0, fs_1.ensureDir)(forumDir);
    for (const thread of forumThreads) {
        const threadId = thread.id;
        const threadName = thread.name ?? 'unnamed-post';
        const storedCursor = (0, state_1.getGuildCursor)(state, guild.name, threadId);
        let currentAfter = storedCursor ? BigInt(storedCursor) : afterSnowflake;
        // Collect all messages in this forum thread for context
        const threadMessages = [];
        while (true) {
            const url = `${DISCORD_API}/channels/${threadId}/messages?limit=100&after=${currentAfter}`;
            const response = await fetchWithRetry(url, headers);
            const text = await response.body.text();
            if (response.statusCode !== 200)
                break;
            const messages = JSON.parse(text);
            if (!Array.isArray(messages) || messages.length === 0)
                break;
            for (const msg of messages) {
                // Collect thread messages regardless of filters (for context)
                threadMessages.push({
                    author: msg?.author?.username ?? 'unknown',
                    content: msg.content ?? '',
                    id: msg.id,
                    timestamp: msg.timestamp ?? new Date().toISOString(),
                });
                if (ignoreBots && msg?.author?.bot)
                    continue;
                if (typeof msg.content !== 'string' || msg.content.trim().length < minMessage)
                    continue;
                const trimmed = msg.content.trim();
                if (ignorePrefixes.some((prefix) => trimmed.startsWith(prefix)))
                    continue;
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
                    reactions: summarizeReactions(msg.reactions ?? []),
                    referenced_message: buildReferencedMessage(msg.referenced_message),
                    thread_id: threadId,
                    thread_name: threadName,
                    is_thread: true,
                    is_forum_post: true,
                    thread_messages: threadMessages.slice(-10), // Last 10 messages for context
                });
                const targetFile = (0, node_path_1.join)(forumDir, `${dateKey}.jsonl`);
                await (0, fs_1.appendText)(targetFile, `${record}\n`);
            }
            const lastId = messages[messages.length - 1]?.id;
            if (!lastId)
                break;
            currentAfter = BigInt(lastId);
            if (messages.length < 100)
                break;
        }
        (0, state_1.setGuildCursor)(state, guild.name, threadId, currentAfter.toString());
        if (threadMessages.length > 0) {
            (0, metrics_1.recordStat)('discordMessagesSynced', threadMessages.length, guild.name);
        }
    }
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
    const headers = buildHeaders(token);
    const channelResponse = await fetchWithRetry(`${DISCORD_API}/guilds/${guildId}/channels`, headers);
    if (channelResponse.statusCode >= 400) {
        throw new Error(`Failed to list guild channels for "${guild.name}": ${channelResponse.statusCode}`);
    }
    const channelList = JSON.parse(await channelResponse.body.text());
    const channels = Array.isArray(channelList) ? channelList : [];
    const state = await (0, state_1.loadState)();
    // Build a lookup for configured channel types
    const channelTypeOverrides = new Map();
    for (const ch of guild.channels) {
        if (ch.channel_type) {
            channelTypeOverrides.set(ch.name, ch.channel_type);
        }
    }
    for (const channelName of channelNames) {
        const configuredType = channelTypeOverrides.get(channelName);
        const channelConfig = guild.channels.find(ch => ch.name === channelName);
        // Find the Discord channel — support text, forum, and announcement types
        let channel;
        if (configuredType === 'forum') {
            channel = channels.find((c) => c.name === channelName && (c.type === CHANNEL_FORUM || c.type === CHANNEL_MEDIA));
        }
        else if (configuredType === 'announcement') {
            channel = channels.find((c) => c.name === channelName && c.type === CHANNEL_ANNOUNCEMENT);
        }
        else {
            // Default: try text first, then forum, then announcement
            channel = channels.find((c) => c.name === channelName && c.type === CHANNEL_TEXT)
                ?? channels.find((c) => c.name === channelName && c.type === CHANNEL_FORUM)
                ?? channels.find((c) => c.name === channelName && c.type === CHANNEL_ANNOUNCEMENT);
        }
        if (!channel) {
            console.warn(`Channel ${channelName} not found in guild "${guild.name}", skipping.`);
            continue;
        }
        const isForumType = channel.type === CHANNEL_FORUM || channel.type === CHANNEL_MEDIA;
        const isTextType = channel.type === CHANNEL_TEXT || channel.type === CHANNEL_ANNOUNCEMENT;
        if (isForumType) {
            // Forum channels: sync all thread posts
            await syncForumChannel(channel, guild, guildId, token, config, state, syncHours, ignoreBots, minMessage, ignorePrefixes, officialRoles, officialUsers);
        }
        else if (isTextType) {
            // Text/announcement channels: sync messages
            await syncTextChannel(channel, guild, token, config, state, syncHours, ignoreBots, minMessage, ignorePrefixes, officialRoles, officialUsers);
            // Also sync threads if configured
            const readThreads = channelConfig?.read_threads ?? true;
            if (readThreads) {
                await syncChannelThreads(channel.id, channelName, guild, guildId, token, config, state, syncHours, ignoreBots, minMessage, ignorePrefixes, officialRoles, officialUsers);
            }
        }
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
