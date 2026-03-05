"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getConfig = getConfig;
exports.getValue = getValue;
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
