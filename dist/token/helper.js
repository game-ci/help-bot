"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureDiscordToken = ensureDiscordToken;
const keytar_1 = __importDefault(require("keytar"));
const prompts_1 = __importDefault(require("prompts"));
const undici_1 = require("undici");
const SERVICE_NAME = 'GameCI Help Bot';
const ACCOUNT_NAME = 'discord-bot-token';
async function loadFromStore() {
    try {
        return await keytar_1.default.getPassword(SERVICE_NAME, ACCOUNT_NAME);
    }
    catch {
        return null;
    }
}
async function saveToStore(token) {
    try {
        await keytar_1.default.setPassword(SERVICE_NAME, ACCOUNT_NAME, token);
    }
    catch {
        // ignore failures
    }
}
async function validateToken(token) {
    try {
        const response = await (0, undici_1.request)('https://discord.com/api/v10/users/@me', {
            headers: {
                Authorization: `Bot ${token}`,
                'Content-Type': 'application/json',
            },
            method: 'GET',
        });
        return response.statusCode === 200;
    }
    catch {
        return false;
    }
}
async function ensureDiscordToken() {
    if (process.env.DISCORD_BOT_TOKEN) {
        const valid = await validateToken(process.env.DISCORD_BOT_TOKEN);
        if (valid) {
            return process.env.DISCORD_BOT_TOKEN;
        }
        console.warn('Existing DISCORD_BOT_TOKEN is invalid');
    }
    let stored = await loadFromStore();
    if (stored && await validateToken(stored)) {
        process.env.DISCORD_BOT_TOKEN = stored;
        return stored;
    }
    const response = await (0, prompts_1.default)({
        type: 'password',
        name: 'token',
        message: 'Discord bot token',
    });
    if (!response.token) {
        throw new Error('Discord bot token is required');
    }
    if (!await validateToken(response.token)) {
        throw new Error('Discord bot token validation failed');
    }
    process.env.DISCORD_BOT_TOKEN = response.token;
    await saveToStore(response.token);
    return response.token;
}
