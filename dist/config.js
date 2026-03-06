"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getConfig = getConfig;
exports.getValue = getValue;
exports.resolveGuilds = resolveGuilds;
exports.getSystemPrompt = getSystemPrompt;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
let cachedConfig = {};
let configLoaded = false;
async function getConfig() {
    if (configLoaded) {
        return cachedConfig;
    }
    const configPath = (0, node_path_1.join)(process.cwd(), 'config.json');
    try {
        const payload = await (0, promises_1.readFile)(configPath, 'utf-8');
        cachedConfig = JSON.parse(payload);
    }
    catch {
        cachedConfig = {};
    }
    configLoaded = true;
    return cachedConfig;
}
function getValue(config, path, fallback) {
    let current = config;
    for (const segment of path) {
        if (!current || typeof current !== 'object') {
            return fallback;
        }
        current = current[segment];
    }
    return current ?? fallback;
}
/**
 * Resolve the guilds array from config. Supports both the new guilds[] format
 * and the legacy single-guild format (guild_id_env at the top level of discord).
 *
 * Legacy format is converted to a single guild named "default" with a
 * deprecation warning.
 */
function resolveGuilds(discordConfig) {
    // New format: discord.guilds[]
    const guilds = discordConfig['guilds'];
    if (Array.isArray(guilds)) {
        return guilds;
    }
    // Legacy format: discord.guild_id_env at top level
    const legacyGuildIdEnv = discordConfig['guild_id_env'];
    if (legacyGuildIdEnv) {
        console.warn('DEPRECATION WARNING: discord.guild_id_env at top level is deprecated. ' +
            'Please migrate to the guilds[] array format. See config.json for the new structure.');
        const legacyChannels = discordConfig['channels'];
        const channelConfigs = (legacyChannels ?? []).map((ch) => {
            if (typeof ch === 'string') {
                return { name: ch };
            }
            return ch;
        });
        return [
            {
                name: 'default',
                guild_id_env: legacyGuildIdEnv,
                webhook_url_env: 'DISCORD_WEBHOOK_URL',
                channels: channelConfigs,
            },
        ];
    }
    // No guilds configured
    return [];
}
/**
 * Build a layered system prompt by combining:
 *   1. Base prompt (discord.system_prompt) -- applies to all guilds/channels
 *   2. Guild-level prompt (guild.system_prompt) -- if present (reserved for future use)
 *   3. Channel-level prompt (channel.system_prompt) -- if present
 *
 * Each layer is concatenated with double newlines.
 */
function getSystemPrompt(discordConfig, guild, channel) {
    const layers = [];
    // Base prompt
    const base = discordConfig['system_prompt'];
    if (base) {
        layers.push(base.trim());
    }
    // Guild-level prompt (future-proofing -- the GuildConfig type doesn't mandate it yet,
    // but if someone adds system_prompt to a guild object it will be picked up)
    if (guild) {
        const guildPrompt = guild['system_prompt'];
        if (guildPrompt) {
            layers.push(guildPrompt.trim());
        }
    }
    // Channel-level prompt
    if (channel?.system_prompt) {
        layers.push(channel.system_prompt.trim());
    }
    return layers.filter(Boolean).join('\n\n');
}
