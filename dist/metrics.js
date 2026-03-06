"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resetStats = resetStats;
exports.recordStat = recordStat;
exports.getStats = getStats;
let currentStats = makeEmptyStats();
function makeEmptyStats() {
    return {
        discordMessagesSynced: 0,
        discordResponsesPosted: 0,
        discordResponsesSkipped: 0,
        discordThreadsSynced: 0,
        discordForumPostsSynced: 0,
        discordBotRepliesPosted: 0,
        githubIssuesSynced: 0,
        githubReleasesSynced: 0,
        githubTagsSynced: 0,
        githubResponsesPosted: 0,
        githubResponsesSkipped: 0,
        investigationIssuesPosted: 0,
        investigationIssuesSkipped: 0,
        cycleReportsPosted: 0,
        detectionsCreated: 0,
        detectionsApproved: 0,
        detectionsCancelled: 0,
        detectionsExpired: 0,
        detectionsPending: 0,
        detectionsWarningsPosted: 0,
        feedbackSynced: 0,
        feedbackPositive: 0,
        feedbackNegative: 0,
        discordGuildStats: {},
    };
}
function resetStats() {
    currentStats = makeEmptyStats();
}
/**
 * Record a stat increment. When guildName is provided and the key is a Discord-related
 * stat, per-guild tracking is also updated.
 */
function recordStat(key, amount = 1, guildName) {
    if (key === 'discordGuildStats') {
        // This key is an object, not a number -- don't increment directly
        return;
    }
    ;
    currentStats[key] += amount;
    // Per-guild tracking for Discord messages
    if (guildName && key === 'discordMessagesSynced') {
        currentStats.discordGuildStats[guildName] ??= { messagesSynced: 0 };
        currentStats.discordGuildStats[guildName].messagesSynced += amount;
    }
}
function getStats() {
    return {
        ...currentStats,
        discordGuildStats: { ...currentStats.discordGuildStats },
    };
}
