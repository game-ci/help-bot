import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { REPO_ROOT } from '../utils/paths'

export type Mode = 'live' | 'incremental'

interface ServiceOptions {
  serviceName?: string
  mode?: Mode
  dispatchMode?: string
  envFile?: string
  envVars?: string
  logFile?: string
}

async function runCommand(command: string, args: string[]): Promise<void> {
  const proc = spawn(command, args, { stdio: 'inherit' })
  const [code] = (await once(proc, 'exit')) as [number, string | null]
  if (code !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`)
  }
}

async function parseEnvFile(path: string): Promise<string[]> {
  try {
    const contents = await readFile(path, 'utf-8')
    return contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
  } catch {
    return []
  }
}

export async function manageService(action: string, opts: ServiceOptions = {}): Promise<void> {
  const serviceName = opts.serviceName ?? 'gameci-help-bot'
  const mode = opts.mode ?? 'live'
  const logFile = opts.logFile ?? join(REPO_ROOT, 'logs', 'service.log')
  const nodePath = process.execPath
  const scriptPath = join(REPO_ROOT, 'dist', 'cli.js')
  const baseArgs = mode === 'incremental' ? ['cycle'] : mode === 'live' ? ['live'] : ['continuous']
  const scriptArgs = opts.dispatchMode
    ? [...baseArgs, '--dispatch-mode', opts.dispatchMode]
    : baseArgs
  const envEntries = opts.envVars
    ? opts.envVars
        .split(/\r?\n/)
        .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
    : opts.envFile
      ? await parseEnvFile(opts.envFile)
      : []

  switch (action) {
    case 'install': {
      const startupScript = join(REPO_ROOT, 'startup.ps1')
      await runCommand('nssm', [
        'install',
        serviceName,
        'powershell.exe',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        startupScript,
      ])
      await runCommand('nssm', ['set', serviceName, 'AppDirectory', REPO_ROOT])
      await runCommand('nssm', ['set', serviceName, 'AppStdout', logFile])
      await runCommand('nssm', ['set', serviceName, 'AppStderr', logFile])
      await runCommand('nssm', ['set', serviceName, 'AppStdoutCreationDisposition', '1'])
      await runCommand('nssm', ['set', serviceName, 'AppStderrCreationDisposition', '1'])
      if (envEntries.length > 0) {
        await runCommand('nssm', ['set', serviceName, 'AppEnvironmentExtra', ...envEntries])
      }
      break
    }
    case 'start':
      await runCommand('nssm', ['start', serviceName])
      break
    case 'stop':
      await runCommand('nssm', ['stop', serviceName])
      break
    case 'restart':
      await runCommand('nssm', ['restart', serviceName])
      break
    case 'status':
      await runCommand('nssm', ['status', serviceName])
      break
    case 'remove':
      await runCommand('nssm', ['stop', serviceName])
      await runCommand('nssm', ['remove', serviceName, 'confirm'])
      break
    default:
      throw new Error(`Unknown action: ${action}`)
  }
}
