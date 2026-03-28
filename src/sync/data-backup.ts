import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { getConfig, getValue } from '../config'
import { DATA_DIR } from '../utils/paths'

async function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    proc.on('close', (code) => {
      if (code !== 0) reject(new Error(`git ${args[0]} failed (${code}): ${stderr.trim()}`))
      else resolve(stdout.trim())
    })
  })
}

export interface SyncDataOptions {
  remoteRepo?: string
  dryRun?: boolean
}

/**
 * Sync the data/ directory to a private GitHub repo.
 * Initializes data/ as a separate git repo if needed,
 * commits all changes, and pushes.
 */
export async function syncDataToGitHub(options: SyncDataOptions = {}): Promise<string> {
  const config = await getConfig()
  const remoteRepo =
    options.remoteRepo ?? (getValue(config, ['data_backup', 'remote_repo'], '') as string)

  if (!remoteRepo) {
    const msg = 'data_backup.remote_repo not configured. Skipping sync.'
    console.warn(msg)
    return msg
  }

  const remoteUrl = `https://github.com/${remoteRepo}.git`
  console.log(`Data sync: targeting ${remoteRepo}`)

  // Check if data/ is already a git repo
  try {
    await stat(join(DATA_DIR, '.git'))
  } catch {
    console.log('  Initializing git repo in data/...')
    await runGit(['init'], DATA_DIR)
    await runGit(['remote', 'add', 'origin', remoteUrl], DATA_DIR)
    // Set default branch to main
    await runGit(['checkout', '-b', 'main'], DATA_DIR).catch(() => {})
    // Try to pull existing content
    try {
      await runGit(['pull', 'origin', 'main', '--allow-unrelated-histories'], DATA_DIR)
    } catch {
      // Empty remote or first push
    }
  }

  // Configure git user for commits
  await runGit(['config', 'user.email', 'help-bot@game.ci'], DATA_DIR).catch(() => {})
  await runGit(['config', 'user.name', 'GameCI Help Bot'], DATA_DIR).catch(() => {})

  // Stage all data files
  await runGit(['add', '-A'], DATA_DIR)

  // Check if there are changes
  try {
    await runGit(['diff', '--cached', '--exit-code'], DATA_DIR)
    const msg = 'No changes to sync.'
    console.log(`  ${msg}`)
    return msg
  } catch {
    // There are staged changes
  }

  const timestamp = new Date().toISOString()
  const message = `data sync: ${timestamp}`

  if (options.dryRun) {
    const diffStat = await runGit(['diff', '--cached', '--stat'], DATA_DIR)
    await runGit(['reset', 'HEAD'], DATA_DIR)
    const msg = `DRY RUN: would commit and push:\n${diffStat}`
    console.log(`  ${msg}`)
    return msg
  }

  await runGit(['commit', '-m', message], DATA_DIR)
  console.log(`  Committed: ${message}`)

  try {
    await runGit(['push', '-u', 'origin', 'main'], DATA_DIR)
    const msg = `Synced to ${remoteRepo}`
    console.log(`  ${msg}`)
    return msg
  } catch (err: any) {
    const msg = `Push failed: ${err.message}`
    console.warn(`  ${msg}`)
    return msg
  }
}
