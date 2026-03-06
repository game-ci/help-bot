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

export interface DiscordGuildCursors {
  [channelId: string]: string
}

export interface SyncState {
  github?: Record<string, GitHubRepoState>
  /** Legacy flat cursor map -- kept for backward compatibility */
  discord?: Record<string, string>
  /** Per-guild cursor state: cursors.discord.{guildName}.{channelId} */
  cursors?: {
    discord?: Record<string, DiscordGuildCursors>
  }
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

// --- Detection helpers ---

import type { DetectionRecord, DetectionKey } from './dispatch/types'

export function getDetections(state: SyncState): Record<DetectionKey, DetectionRecord> {
  return (state.meta?.detections as Record<DetectionKey, DetectionRecord>) ?? {}
}

export function setDetections(state: SyncState, detections: Record<DetectionKey, DetectionRecord>): void {
  state.meta ??= {}
  state.meta.detections = detections
}

export function getPostedInvestigations(state: SyncState): Record<string, string> {
  return (state.meta?.postedInvestigations as Record<string, string>) ?? {}
}

/**
 * Get the set of issues the bot has already responded to.
 * Keys are `{repo}#{issueNumber}`, values are ISO timestamps of when the response was posted.
 */
export function getPostedResponses(state: SyncState): Record<string, string> {
  return (state.meta?.postedResponses as Record<string, string>) ?? {}
}

/**
 * Record that the bot responded to an issue.
 */
export function setPostedResponse(state: SyncState, repo: string, issueNumber: number): void {
  state.meta ??= {}
  const posted = getPostedResponses(state)
  posted[`${repo}#${issueNumber}`] = new Date().toISOString()
  state.meta.postedResponses = posted
}

// --- Guild-namespaced cursor helpers ---

export function getGuildCursor(state: SyncState, guildName: string, channelId: string): string | undefined {
  return state.cursors?.discord?.[guildName]?.[channelId]
}

export function setGuildCursor(state: SyncState, guildName: string, channelId: string, cursor: string): void {
  state.cursors ??= {}
  state.cursors.discord ??= {}
  state.cursors.discord[guildName] ??= {}
  state.cursors.discord[guildName][channelId] = cursor
}
