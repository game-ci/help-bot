import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

let cachedConfig: Record<string, unknown> = {} as Record<string, unknown>
let configLoaded = false

export async function getConfig(): Promise<Record<string, unknown>> {
  if (configLoaded) {
    return cachedConfig
  }
  const configPath = join(process.cwd(), 'config.json')
  try {
    const payload = await readFile(configPath, 'utf-8')
    cachedConfig = JSON.parse(payload)
  } catch {
    cachedConfig = {}
  }
  configLoaded = true
  return cachedConfig
}

export function getValue<T>(config: Record<string, unknown>, path: string[], fallback: T): T {
  let current: unknown = config
  for (const segment of path) {
    if (!current || typeof current !== 'object') {
      return fallback
    }
    current = (current as Record<string, unknown>)[segment]
  }
  return (current as T) ?? fallback
}
