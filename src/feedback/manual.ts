import { appendText } from '../utils/fs'
import { RESPONSES_DIR } from '../utils/paths'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface FeedbackEntry {
  responseId: string
  verdict: 'good' | 'bad'
  note?: string
  timestamp: string
}

const FEEDBACK_FILE = join(RESPONSES_DIR, 'feedback.jsonl')

export async function markFeedback(responseId: string, verdict: 'good' | 'bad', note?: string): Promise<void> {
  const entry: FeedbackEntry = {
    responseId,
    verdict,
    note,
    timestamp: new Date().toISOString(),
  }
  await appendText(FEEDBACK_FILE, JSON.stringify(entry) + '\n')
}

export async function readFeedbackEntries(): Promise<FeedbackEntry[]> {
  try {
    const content = await readFile(FEEDBACK_FILE, 'utf-8')
    return content
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FeedbackEntry)
  } catch {
    return []
  }
}
