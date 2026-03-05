import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureDir } from './utils/fs'
import { DATA_DIR } from './utils/paths'

export interface GitHubRepoState {
  issueCursor?: string
  commentCursor?: string
  releaseCursor?: string
  tagCursor?: string
}

export interface SyncState {
  github?: Record<string, GitHubRepoState>
  discord?: Record<string, string>
  meta?: Record<string, unknown>
}

const STATE_FILE = join(DATA_DIR, 'state.json')
let cachedState: SyncState | null = null

export async function loadState(): Promise<SyncState> {
  if (cachedState) {
    return cachedState
  }
  try {
    await ensureDir(DATA_DIR)
    const contents = await readFile(STATE_FILE, 'utf-8')
    cachedState = JSON.parse(contents)
  } catch {
    cachedState = {}
  }
  return cachedState ?? {}
}

export async function saveState(state: SyncState): Promise<void> {
  await ensureDir(DATA_DIR)
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8')
  cachedState = state
}

export async function updateState(mutator: (state: SyncState) => void): Promise<void> {
  const state = await loadState()
  mutator(state)
  await saveState(state)
}
