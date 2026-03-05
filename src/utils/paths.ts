import { join } from 'node:path'

export const REPO_ROOT = process.cwd()
export const DATA_DIR = join(REPO_ROOT, 'data')
export const RESPONSES_DIR = join(DATA_DIR, 'responses')
export const DISCORD_DATA_DIR = join(DATA_DIR, 'discord', 'channels')
export const GITHUB_DATA_DIR = join(DATA_DIR, 'github', 'issues')
export const DOCS_DATA_DIR = join(DATA_DIR, 'docs')
export const LOGS_DIR = join(DATA_DIR, 'logs')
