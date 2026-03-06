"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LOGS_DIR = exports.DOCS_DATA_DIR = exports.GITHUB_DATA_DIR = exports.DISCORD_DATA_DIR = exports.RESPONSES_DIR = exports.DATA_DIR = exports.REPO_ROOT = void 0;
exports.guildDataDir = guildDataDir;
exports.guildChannelDir = guildChannelDir;
const node_path_1 = require("node:path");
exports.REPO_ROOT = process.cwd();
exports.DATA_DIR = (0, node_path_1.join)(exports.REPO_ROOT, 'data');
exports.RESPONSES_DIR = (0, node_path_1.join)(exports.DATA_DIR, 'responses');
exports.DISCORD_DATA_DIR = (0, node_path_1.join)(exports.DATA_DIR, 'discord', 'channels');
exports.GITHUB_DATA_DIR = (0, node_path_1.join)(exports.DATA_DIR, 'github', 'issues');
exports.DOCS_DATA_DIR = (0, node_path_1.join)(exports.DATA_DIR, 'docs');
exports.LOGS_DIR = (0, node_path_1.join)(exports.DATA_DIR, 'logs');
// --- Guild-aware path helpers ---
/** Root data directory for a specific guild: data/discord/guilds/{guildName} */
function guildDataDir(guildName) {
    return (0, node_path_1.join)(exports.DATA_DIR, 'discord', 'guilds', guildName);
}
/** Channel data directory within a guild: data/discord/guilds/{guildName}/channels/{channelName} */
function guildChannelDir(guildName, channelName) {
    return (0, node_path_1.join)(exports.DATA_DIR, 'discord', 'guilds', guildName, 'channels', channelName);
}
