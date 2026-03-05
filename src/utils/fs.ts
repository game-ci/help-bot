import { mkdir, writeFile, appendFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function ensureDir(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true })
  } catch {
    // ignore
  }
}

export async function writeJsonl(filePath: string, records: object[]): Promise<void> {
  const lines = records.map((r) => JSON.stringify(r)).join('\n') + '\n'
  await ensureDir(dirname(filePath))
  await writeFile(filePath, lines, 'utf-8')
}

export async function appendText(filePath: string, text: string): Promise<void> {
  await ensureDir(dirname(filePath))
  await appendFile(filePath, text, 'utf-8')
}
