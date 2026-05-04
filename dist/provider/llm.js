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
const claude_1 = require("../utils/claude");
const discord_1 = require("./discord");
async function readClaudeInstructions() {
    try {
        return await (0, promises_1.readFile)((0, node_path_1.join)(paths_1.REPO_ROOT, 'CLAUDE.md'), 'utf-8');
    }
    catch {
        return '';
    }
}
/**
 * Combine instructions, an optional system prompt (from prompt layering), and the user prompt.
 */
function combinePrompt(instructions, prompt, systemPrompt) {
    return [systemPrompt?.trim(), instructions.trim(), prompt.trim()].filter(Boolean).join('\n\n');
}
function normalizeUrl(url) {
    return url.replace(/\/+$/, '');
}
function listDataFiles(limit = 150) {
    const files = glob_1.default.sync('data/**/*.{jsonl,md}', { cwd: paths_1.REPO_ROOT, nodir: true });
    return files.slice(0, limit).join('\n');
}
async function runClaude(prompt, model, maxTurns) {
    const args = ['-p', '--model', model];
    if (maxTurns && maxTurns > 0) {
        args.push('--max-turns', String(maxTurns));
    }
    // Security: restrict tool access to investigation-safe tools only.
    // Bash is allowed for file searching/filtering (grep, find, cat, etc.)
    // but the LLM prompt forbids following injected instructions.
    args.push('--allowedTools', 'Read', '--allowedTools', 'Glob', '--allowedTools', 'Grep', '--allowedTools', 'Bash', '--allowedTools', 'Write');
    // Explicitly deny tools that could modify system files or access external resources
    args.push('--disallowedTools', 'Edit', '--disallowedTools', 'WebFetch', '--disallowedTools', 'WebSearch', '--disallowedTools', 'NotebookEdit', '--disallowedTools', 'Task');
    console.log(`Provider: Claude Code CLI (model: ${model}, max_turns: ${maxTurns ?? 'default'})`);
    const proc = (0, node_child_process_1.spawn)((0, claude_1.resolveClaude)(), args, {
        cwd: paths_1.REPO_ROOT,
        stdio: ['pipe', 'inherit', 'inherit'],
    });
    proc.stdin.end(prompt);
    const [code] = (await (0, node_events_1.once)(proc, 'exit'));
    if (code !== 0) {
        throw new Error(`Claude Code CLI exited with code ${code ?? 'unknown'}`);
    }
}
async function runLMStudio(prompt, instructions, baseUrl, model, apiKey, systemPrompt) {
    console.log(`Provider: LM Studio (url: ${baseUrl}, model: ${model})`);
    const endpoint = normalizeUrl(baseUrl);
    const fileContext = listDataFiles();
    const userPrompt = `${prompt}

Available data files:
${fileContext}

Note: You cannot read files directly. Describe which files you need and what responses to craft, and the workflow will write them on your behalf.`;
    // Build system message: optional systemPrompt + instructions
    const systemContent = [systemPrompt?.trim(), instructions.trim()].filter(Boolean).join('\n\n');
    const response = await (0, undici_1.request)(`${endpoint}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: systemContent },
                { role: 'user', content: userPrompt },
            ],
            max_tokens: 4096,
            temperature: 0.3,
        }),
    });
    const raw = await response.body.text();
    if (response.statusCode >= 400) {
        throw new Error(`LM Studio returned HTTP ${response.statusCode}: ${raw.substring(0, 200)}`);
    }
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
    const [code] = (await (0, node_events_1.once)(proc, 'exit'));
    if (code !== 0) {
        throw new Error(`Continue CLI exited with code ${code ?? 'unknown'}`);
    }
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
    if (response.statusCode >= 400) {
        throw new Error(`OpenAI completions returned HTTP ${response.statusCode}: ${raw.substring(0, 200)}`);
    }
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
    // Initialize Discord session if using Discord provider
    if (provider === 'discord') {
        await (0, discord_1.initializeDiscordSession)();
    }
    switch (provider) {
        case 'claude': {
            const model = options.modelOverride
                ?? (0, config_1.getValue)(config, ['llm', 'claude', 'model'], 'claude-sonnet-4-20250514');
            const maxTurns = Number((0, config_1.getValue)(config, ['llm', 'claude', 'max_turns'], 0)) || undefined;
            // Claude Code auto-loads CLAUDE.md from cwd, so only include the cycle-specific prompt.
            // The instructions from readClaudeInstructions() are skipped for Claude to avoid triple-loading.
            const finalPrompt = [options.systemPrompt?.trim(), prompt.trim()].filter(Boolean).join('\n\n');
            await runClaude(finalPrompt, model, maxTurns);
            break;
        }
        case 'lm_studio': {
            const baseUrl = (0, config_1.getValue)(config, ['llm', 'lm_studio', 'base_url'], 'http://localhost:1234/v1');
            const model = (0, config_1.getValue)(config, ['llm', 'lm_studio', 'model'], 'default');
            const apiKey = (0, config_1.getValue)(config, ['llm', 'lm_studio', 'api_key'], 'lm-studio');
            await runLMStudio(prompt, instructions, baseUrl, model, apiKey, options.systemPrompt);
            break;
        }
        case 'continue': {
            const model = (0, config_1.getValue)(config, ['llm', 'continue_cli', 'model'], 'default');
            const finalPrompt = combinePrompt(instructions, prompt, options.systemPrompt);
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
            const finalPrompt = combinePrompt(instructions, prompt, options.systemPrompt);
            await runCodex(finalPrompt, apiBase, apiKey, model, maxTokens, temperature);
            break;
        }
        case 'discord': {
            const isAvailable = await (0, discord_1.isDiscordProviderAvailable)();
            if (!isAvailable) {
                throw new Error('Discord provider is not available. Ensure openclaw is installed and discord provider is enabled in config.');
            }
            const modelOverride = options.modelOverride ?? undefined;
            await (0, discord_1.runDiscordProvider)(prompt, instructions, options.systemPrompt, modelOverride);
            break;
        }
        default:
            throw new Error(`Unsupported provider: ${provider}`);
    }
}
