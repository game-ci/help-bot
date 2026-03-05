"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadState = loadState;
exports.saveState = saveState;
exports.updateState = updateState;
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
