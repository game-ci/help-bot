"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadState = loadState;
exports.saveState = saveState;
exports.updateState = updateState;
exports.getDetections = getDetections;
exports.setDetections = setDetections;
exports.getPostedInvestigations = getPostedInvestigations;
exports.getPostedResponses = getPostedResponses;
exports.setPostedResponse = setPostedResponse;
exports.getPostedDiscordResponses = getPostedDiscordResponses;
exports.setPostedDiscordResponse = setPostedDiscordResponse;
exports.getGuildCursor = getGuildCursor;
exports.setGuildCursor = setGuildCursor;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const fs_1 = require("./utils/fs");
const paths_1 = require("./utils/paths");
const STATE_FILE = (0, node_path_1.join)(paths_1.DATA_DIR, 'state.json');
let cachedState = null;
async function loadState() {
    if (cachedState) {
        return cachedState;
    }
    try {
        await (0, fs_1.ensureDir)(paths_1.DATA_DIR);
        const contents = await (0, promises_1.readFile)(STATE_FILE, 'utf-8');
        cachedState = JSON.parse(contents);
    }
    catch {
        cachedState = {};
    }
    return cachedState ?? {};
}
async function saveState(state) {
    await (0, fs_1.ensureDir)(paths_1.DATA_DIR);
    await (0, promises_1.writeFile)(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
    cachedState = state;
}
async function updateState(mutator) {
    const state = await loadState();
    mutator(state);
    await saveState(state);
}
function getDetections(state) {
    return state.meta?.detections ?? {};
}
function setDetections(state, detections) {
    state.meta ??= {};
    state.meta.detections = detections;
}
function getPostedInvestigations(state) {
    return state.meta?.postedInvestigations ?? {};
}
/**
 * Get the set of issues the bot has already responded to.
 * Keys are `{repo}#{issueNumber}`, values are ISO timestamps of when the response was posted.
 */
function getPostedResponses(state) {
    return state.meta?.postedResponses ?? {};
}
/**
 * Record that the bot responded to an issue.
 */
function setPostedResponse(state, repo, issueNumber) {
    state.meta ??= {};
    const posted = getPostedResponses(state);
    posted[`${repo}#${issueNumber}`] = new Date().toISOString();
    state.meta.postedResponses = posted;
}
/**
 * Get the set of Discord messages the bot has already responded to.
 * Keys are `discord:{guildName}/{channelName}#{messageId}`, values are ISO timestamps.
 */
function getPostedDiscordResponses(state) {
    return state.meta?.postedDiscordResponses ?? {};
}
/**
 * Record that the bot responded to a Discord message.
 */
function setPostedDiscordResponse(state, guildName, channelName, messageId) {
    state.meta ??= {};
    const posted = getPostedDiscordResponses(state);
    posted[`discord:${guildName}/${channelName}#${messageId}`] = new Date().toISOString();
    state.meta.postedDiscordResponses = posted;
}
// --- Guild-namespaced cursor helpers ---
function getGuildCursor(state, guildName, channelId) {
    return state.cursors?.discord?.[guildName]?.[channelId];
}
function setGuildCursor(state, guildName, channelId, cursor) {
    state.cursors ??= {};
    state.cursors.discord ??= {};
    state.cursors.discord[guildName] ??= {};
    state.cursors.discord[guildName][channelId] = cursor;
}
