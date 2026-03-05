"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.manageService = manageService;
const node_child_process_1 = require("node:child_process");
const node_events_1 = require("node:events");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const paths_1 = require("../utils/paths");
async function runCommand(command, args) {
    const proc = (0, node_child_process_1.spawn)(command, args, { stdio: 'inherit' });
    const [code] = (await (0, node_events_1.once)(proc, 'exit'));
    if (code !== 0) {
        throw new Error(`Command failed: ${command} ${args.join(' ')}`);
    }
}
async function parseEnvFile(path) {
    try {
        const contents = await (0, promises_1.readFile)(path, 'utf-8');
        return contents
            .split(/\\r?\\n/)
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith('#'))
            .join('\\n');
    }
    catch {
        return '';
    }
}
async function manageService(action, opts = {}) {
    const serviceName = opts.serviceName ?? 'gameci-help-bot';
    const mode = opts.mode ?? 'live';
    const logFile = opts.logFile ?? (0, node_path_1.join)(paths_1.REPO_ROOT, 'logs', 'service.log');
    const nodePath = process.execPath;
    const scriptPath = (0, node_path_1.join)(paths_1.REPO_ROOT, 'dist', 'cli.js');
    const scriptArgs = mode === 'incremental' ? ['cycle'] : ['continuous'];
    const envString = opts.envVars ?? (opts.envFile ? await parseEnvFile(opts.envFile) : '');
    switch (action) {
        case 'install':
            await runCommand('nssm', ['install', serviceName, nodePath, scriptPath, ...scriptArgs]);
            await runCommand('nssm', ['set', serviceName, 'AppDirectory', paths_1.REPO_ROOT]);
            await runCommand('nssm', ['set', serviceName, 'AppStdout', logFile]);
            await runCommand('nssm', ['set', serviceName, 'AppStderr', logFile]);
            await runCommand('nssm', ['set', serviceName, 'AppStdoutCreationDisposition', '1']);
            await runCommand('nssm', ['set', serviceName, 'AppStderrCreationDisposition', '1']);
            if (envString) {
                await runCommand('nssm', ['set', serviceName, 'AppEnvironmentExtra', envString]);
            }
            break;
        case 'start':
            await runCommand('nssm', ['start', serviceName]);
            break;
        case 'stop':
            await runCommand('nssm', ['stop', serviceName]);
            break;
        case 'restart':
            await runCommand('nssm', ['restart', serviceName]);
            break;
        case 'status':
            await runCommand('nssm', ['status', serviceName]);
            break;
        case 'remove':
            await runCommand('nssm', ['stop', serviceName]);
            await runCommand('nssm', ['remove', serviceName, 'confirm']);
            break;
        default:
            throw new Error(`Unknown action: ${action}`);
    }
}
