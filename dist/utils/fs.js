"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureDir = ensureDir;
exports.writeJsonl = writeJsonl;
exports.appendText = appendText;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
async function ensureDir(path) {
    try {
        await (0, promises_1.mkdir)(path, { recursive: true });
    }
    catch {
        // ignore
    }
}
async function writeJsonl(filePath, records) {
    const lines = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
    await ensureDir((0, node_path_1.dirname)(filePath));
    await (0, promises_1.writeFile)(filePath, lines, 'utf-8');
}
async function appendText(filePath, text) {
    await ensureDir((0, node_path_1.dirname)(filePath));
    await (0, promises_1.appendFile)(filePath, text, 'utf-8');
}
