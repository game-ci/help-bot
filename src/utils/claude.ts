import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'

let cachedPath: string | null = null

/**
 * Resolve the full path to the Claude CLI binary.
 * Checks (in order):
 *   1. CLAUDE_PATH environment variable
 *   2. `where claude` (Windows) or `which claude` (Unix)
 *   3. Common install locations
 * Caches the result after first successful resolution.
 */
export function resolveClaude(): string {
  if (cachedPath) return cachedPath

  // 1. Environment variable override
  const envPath = process.env.CLAUDE_PATH
  if (envPath && existsSync(envPath)) {
    cachedPath = envPath
    console.log(`  Claude CLI: using CLAUDE_PATH=${envPath}`)
    return cachedPath
  }

  // 2. Try `where claude` (Windows) or `which claude` (Unix)
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which'
    const result = execFileSync(cmd, ['claude'], {
      encoding: 'utf-8',
      timeout: 5000,
    })
      .trim()
      .split(/\r?\n/)[0]
    if (result && existsSync(result)) {
      cachedPath = result
      console.log(`  Claude CLI: found via ${cmd} at ${result}`)
      return cachedPath
    }
  } catch {
    // Not on PATH — fall through
  }

  // 3. Check common locations
  const home = homedir()
  const candidates = [
    join(home, '.local', 'bin', 'claude.cmd'),
    join(home, '.local', 'bin', 'claude'),
    join(home, '.local', 'bin', 'claude.exe'),
    join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd'),
    join(home, 'AppData', 'Roaming', 'npm', 'claude'),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      cachedPath = candidate
      console.log(`  Claude CLI: found at ${candidate}`)
      return cachedPath
    }
  }

  // Last resort: return bare 'claude' and let it fail with a clear message
  console.warn(
    '  Claude CLI: could not resolve path. Falling back to bare "claude" command.\n' +
      '  Set CLAUDE_PATH environment variable to the full path of the claude binary.',
  )
  cachedPath = 'claude'
  return cachedPath
}
