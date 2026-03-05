"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.reportSummary = reportSummary;
const state_1 = require("./state");
const feedback_1 = require("./feedback");
async function reportSummary() {
    const state = await (0, state_1.loadState)();
    const stats = (state.meta?.lastCycleStats ?? undefined);
    const runAt = state.meta?.lastCycleAt;
    console.log('=== Help Cycle Summary ===');
    if (runAt) {
        console.log(`Last cycle recorded at: ${runAt}`);
    }
    if (stats) {
        console.log(`Discord messages synced: ${stats.discordMessagesSynced}`);
        console.log(`Discord responses posted: ${stats.discordResponsesPosted}`);
        console.log(`Discord responses skipped: ${stats.discordResponsesSkipped}`);
        console.log(`GitHub issues synced: ${stats.githubIssuesSynced}`);
        console.log(`GitHub releases synced: ${stats.githubReleasesSynced}`);
        console.log(`GitHub tags synced: ${stats.githubTagsSynced}`);
        console.log(`GitHub responses posted: ${stats.githubResponsesPosted}`);
        console.log(`GitHub responses skipped: ${stats.githubResponsesSkipped}`);
    }
    else {
        console.log('No cycle stats recorded yet.');
    }
    const feedback = await (0, feedback_1.readFeedbackEntries)();
    if (feedback.length) {
        const good = feedback.filter((entry) => entry.verdict === 'good').length;
        const bad = feedback.filter((entry) => entry.verdict === 'bad').length;
        console.log(`Feedback entries: ${feedback.length} (good: ${good}, bad: ${bad})`);
    }
    else {
        console.log('No feedback entries recorded yet.');
    }
}
