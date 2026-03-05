"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.markFeedback = markFeedback;
exports.readFeedbackEntries = readFeedbackEntries;
const fs_1 = require("./utils/fs");
const paths_1 = require("./utils/paths");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const FEEDBACK_FILE = (0, node_path_1.join)(paths_1.RESPONSES_DIR, 'feedback.jsonl');
async function markFeedback(responseId, verdict, note) {
    const entry = {
        responseId,
        verdict,
        note,
        timestamp: new Date().toISOString(),
    };
    await (0, fs_1.appendText)(FEEDBACK_FILE, JSON.stringify(entry) + '\n');
}
async function readFeedbackEntries() {
    try {
        const content = await (0, promises_1.readFile)(FEEDBACK_FILE, 'utf-8');
        return content
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => JSON.parse(line));
    }
    catch {
        return [];
    }
}
