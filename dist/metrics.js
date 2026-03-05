"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resetStats = resetStats;
exports.recordStat = recordStat;
exports.getStats = getStats;
let currentStats = {
    discordMessagesSynced: 0,
    discordResponsesPosted: 0,
    discordResponsesSkipped: 0,
    githubIssuesSynced: 0,
    githubReleasesSynced: 0,
    githubTagsSynced: 0,
    githubResponsesPosted: 0,
    githubResponsesSkipped: 0,
};
function resetStats() {
    currentStats = {
        discordMessagesSynced: 0,
        discordResponsesPosted: 0,
        discordResponsesSkipped: 0,
        githubIssuesSynced: 0,
        githubReleasesSynced: 0,
        githubTagsSynced: 0,
        githubResponsesPosted: 0,
        githubResponsesSkipped: 0,
    };
}
function recordStat(key, amount = 1) {
    currentStats[key] += amount;
}
function getStats() {
    return { ...currentStats };
}
