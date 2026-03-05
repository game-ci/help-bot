import { request } from 'undici'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { parseFrontMatter } from '../utils/frontmatter'
import { RESPONSES_DIR } from '../utils/paths'

const MAX_LENGTH = 2000

function splitContent(content: string): string[] {
  const chunks: string[] = []
  let remaining = content.trim()
  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining)
      break
    }
    let splitAt = remaining.lastIndexOf('\n', MAX_LENGTH)
    if (splitAt < 0 || splitAt < MAX_LENGTH / 2) {
      splitAt = MAX_LENGTH
    }
    chunks.push(remaining.slice(0, splitAt).trim())
    remaining = remaining.slice(splitAt).trimStart()
  }
  return chunks
}

async function postToWebhook(webhook: string, payload: Record<string, unknown>): Promise<boolean> {
  const response = await request(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return response.statusCode === 204 || response.statusCode === 200
}

export async function postDiscordResponses(dryRun = false): Promise<void> {
  const discordDir = join(RESPONSES_DIR, 'discord')
  let files: string[] = []
  try {
    files = await readdir(discordDir)
  } catch {
    return
  }
  const webhook = process.env.DISCORD_WEBHOOK_URL
  if (!webhook) {
    throw new Error('DISCORD_WEBHOOK_URL is required to post Discord responses')
  }

  for (const file of files.filter((f) => f.endsWith('.md'))) {
    const fullPath = join(discordDir, file)
    const content = await readFile(fullPath, 'utf-8')
    const { body } = parseFrontMatter(content)
    const trimmed = body.trim()
    if (!trimmed) {
      continue
    }
    if (dryRun) {
      console.log(`DRY RUN: would post Discord response from ${file}`)
      continue
    }
    const chunks = splitContent(trimmed)
    for (const [index, chunk] of chunks.entries()) {
      const payload: Record<string, unknown> = {
        content: chunk,
        username: 'GameCI Help Bot',
      }
      if (chunks.length > 1) {
        payload.content = `(part ${index + 1}/${chunks.length})\n${chunk}`
      }
      const success = await postToWebhook(webhook, payload)
      if (!success) {
        console.warn(`Failed to post Discord chunk ${index + 1}/${chunks.length} for ${file}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }
  }
}
