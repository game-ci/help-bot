"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runProvider = runProvider;
const node_child_process_1 = require("node:child_process");
const node_events_1 = require("node:events");
const undici_1 = require("undici");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const glob_1 = __importDefault(require("glob"));
const config_1 = require("../config");
const paths_1 = require("../utils/paths");
async function readClaudeInstructions() {
    try {
        return await (0, promises_1.readFile)((0, node_path_1.join)(paths_1.REPO_ROOT, 'CLAUDE.md'), 'utf-8');
    }
    catch {
        return '';
    }
}
function combinePrompt(instructions, prompt) {
    return [instructions.trim(), prompt.trim()].filter(Boolean).join('\n\n');
}
function normalizeUrl(url) {
    return url.replace(/\/+$/, '');
}
function listDataFiles(limit = 150) {
    const files = glob_1.default.sync('data/**/*.{jsonl,md}', { cwd: paths_1.REPO_ROOT, nodir: true });
    return files.slice(0, limit).join('\n');
}
async function runClaude(prompt, model) {
    console.log(`Provider: Claude Code CLI (model: ${model})`);
    const proc = (0, node_child_process_1.spawn)('claude', ['-p', '--model', model], {
        cwd: paths_1.REPO_ROOT,
        stdio: ['pipe', 'inherit', 'inherit'],
    });
    proc.stdin.end(prompt);
    await (0, node_events_1.once)(proc, 'exit');
}
async function runLMStudio(prompt, instructions, baseUrl, model, apiKey) {
    console.log(`Provider: LM Studio (url: ${baseUrl}, model: ${model})`);
    const endpoint = normalizeUrl(baseUrl);
    const fileContext = listDataFiles();
    const userPrompt = `${prompt}

Available data files:
${fileContext}

Note: You cannot read files directly. Describe which files you need and what responses to craft, and the workflow will write them on your behalf.`;
    const response = await (0, undici_1.request)(`${endpoint}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: instructions },
                { role: 'user', content: userPrompt },
            ],
            max_tokens: 4096,
            temperature: 0.3,
        }),
    });
    const raw = await response.body.text();
    try {
        const data = JSON.parse(raw);
        console.log(data.choices?.[0]?.message?.content ?? raw);
    }
    catch {
        console.log(raw);
    }
}
async function runContinue(prompt, model) {
    console.log(`Provider: Continue CLI (model: ${model})`);
    const proc = (0, node_child_process_1.spawn)('continue', ['--model', model], {
        cwd: paths_1.REPO_ROOT,
        stdio: ['pipe', 'inherit', 'inherit'],
    });
    proc.stdin.end(prompt);
    await (0, node_events_1.once)(proc, 'exit');
}
async function runCodex(prompt, apiBase, apiKey, model, maxTokens, temperature) {
    console.log(`Provider: OpenAI Codex (model: ${model})`);
    const endpoint = `${normalizeUrl(apiBase)}/completions`;
    const response = await (0, undici_1.request)(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model,
            prompt,
            max_tokens: maxTokens,
            temperature,
        }),
    });
    const raw = await response.body.text();
    try {
        const data = JSON.parse(raw);
        console.log(data.choices?.[0]?.text ?? raw);
    }
    catch {
        console.log(raw);
    }
}
async function runProvider(prompt, options = {}) {
    const config = await (0, config_1.getConfig)();
    const provider = options.provider ?? (0, config_1.getValue)(config, ['llm', 'provider'], 'claude');
    const instructions = await readClaudeInstructions();
    switch (provider) {
        case 'claude': {
            const model = (0, config_1.getValue)(config, ['llm', 'claude', 'model'], 'claude-sonnet-4-20250514');
            const finalPrompt = combinePrompt(instructions, prompt);
            await runClaude(finalPrompt, model);
            break;
        }
        case 'lm_studio': {
            const baseUrl = (0, config_1.getValue)(config, ['llm', 'lm_studio', 'base_url'], 'http://localhost:1234/v1');
            const model = (0, config_1.getValue)(config, ['llm', 'lm_studio', 'model'], 'default');
            const apiKey = (0, config_1.getValue)(config, ['llm', 'lm_studio', 'api_key'], 'lm-studio');
            await runLMStudio(prompt, instructions, baseUrl, model, apiKey);
            break;
        }
        case 'continue': {
            const model = (0, config_1.getValue)(config, ['llm', 'continue_cli', 'model'], 'default');
            const finalPrompt = combinePrompt(instructions, prompt);
            await runContinue(finalPrompt, model);
            break;
        }
        case 'codex': {
            const model = (0, config_1.getValue)(config, ['llm', 'codex', 'model'], 'code-davinci-002');
            const temperature = Number((0, config_1.getValue)(config, ['llm', 'codex', 'temperature'], 0.2));
            const maxTokens = Number((0, config_1.getValue)(config, ['llm', 'codex', 'max_tokens'], 8192));
            const apiBase = (0, config_1.getValue)(config, ['llm', 'codex', 'api_base'], 'https://api.openai.com/v1');
            const apiKey = process.env.OPENAI_API_KEY;
            if (!apiKey) {
                throw new Error('OPENAI_API_KEY is required for Codex provider');
            }
            const finalPrompt = combinePrompt(instructions, prompt);
            await runCodex(finalPrompt, apiBase, apiKey, model, maxTokens, temperature);
            break;
        }
        default:
            throw new Error(`Unsupported provider: ${provider}`);
    }
}
