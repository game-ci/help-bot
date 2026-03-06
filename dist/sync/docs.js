"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncDocs = syncDocs;
const undici_1 = require("undici");
const node_html_parser_1 = require("node-html-parser");
const turndown_1 = __importDefault(require("turndown"));
const promises_1 = require("node:fs/promises");
const fs_1 = require("../utils/fs");
const paths_1 = require("../utils/paths");
const config_1 = require("../config");
const node_path_1 = require("node:path");
const turndown = new turndown_1.default({ codeBlockStyle: 'fenced' });
async function fetchPage(page, baseUrl) {
    const normalizedBase = baseUrl.replace(/\/$/, '');
    const fullUrl = `${normalizedBase}/${page}`;
    try {
        let url = fullUrl;
        let response = await (0, undici_1.request)(url, {
            headers: { 'User-Agent': 'GameCI Help Bot/TS' },
            maxRedirections: 5,
        });
        if (response.statusCode !== 200) {
            throw new Error(`Status ${response.statusCode}`);
        }
        const html = await response.body.text();
        const root = (0, node_html_parser_1.parse)(html);
        const article = root.querySelector('article') ?? root.querySelector('main') ?? root.querySelector('.markdown');
        if (!article) {
            throw new Error('No article content found');
        }
        const markdown = turndown.turndown(article.toString()).trim();
        const output = (0, node_path_1.join)(paths_1.DOCS_DATA_DIR, `${page.replace(/\//g, '--')}.md`);
        const text = `---
source: ${fullUrl}
---

${markdown}
`;
        await (0, fs_1.ensureDir)(paths_1.DOCS_DATA_DIR);
        await (0, promises_1.writeFile)(output, text, 'utf-8');
    }
    catch (error) {
        console.warn(`Failed to fetch ${fullUrl}: ${error.message}`);
    }
}
async function syncDocs() {
    const config = await (0, config_1.getConfig)();
    const baseUrl = (0, config_1.getValue)(config, ['docs', 'base_url'], 'https://game.ci/docs').replace(/\/$/, '');
    const pages = (0, config_1.getValue)(config, ['docs', 'pages'], [
        'github/getting-started',
        'github/activation',
        'github/builder',
        'github/test-runner',
        'github/returning-a-license',
        'docker/docker-images',
        'docker/versions',
        'github/deployment/steam',
    ]);
    await (0, fs_1.ensureDir)(paths_1.DOCS_DATA_DIR);
    for (const entry of pages) {
        console.log(`Fetching documentation page: ${entry}`);
        await fetchPage(entry, baseUrl);
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
}
