import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'

const execAsync = promisify(exec)

/**
 * PI Coding Agent integration module.
 * Provides utilities for interacting with the PI CLI for code operations.
 */

export interface PiCommandOptions {
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
}

export interface PiCommandResult {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * Run a PI command and get the result.
 */
export async function runPiCommand(
  command: string,
  args?: string[],
  options: PiCommandOptions = {}
): Promise<PiCommandResult> {
  const fullCommand = `${command} ${args?.join(' ') || ''}`
  const { cwd = process.cwd(), env = {}, timeoutMs = 300000 } = options

  try {
    const { stdout, stderr, exitCode } = await execAsync(fullCommand, {
      cwd,
      env: { ...process.env, ...env },
      timeout: timeoutMs,
    })
    return { stdout, stderr, exitCode }
  } catch (error: unknown) {
    if (error instanceof Error && 'stderr' in error) {
      const err = error as NodeJS.ErrnoException & { stderr: string }
      throw new Error(`PI command failed: ${err.stderr}\nCommand: ${fullCommand}`)
    }
    throw error
  }
}

/**
 * Check if PI CLI is available and get version.
 */
export async function checkPiAvailability(): Promise<{ available: boolean; version?: string }> {
  try {
    const { stdout } = await runPiCommand('pi', ['--version'])
    const match = stdout.match(/v([\d.-]+)/)
    return {
      available: true,
      version: match ? `v${match[1]}` : undefined,
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes('PI command failed')) {
      return { available: false }
    }
    throw error
  }
}

/**
 * Get the PI coding agent CLI path.
 * Tries multiple locations to find the pi executable.
 */
export function getPiPath(): string {
  // Try common locations
  const possiblePaths = [
    'pi',
    './pi',
    path.join(process.cwd(), 'node_modules', '@earendil-works', 'pi-coding-agent', 'bin', 'pi'),
    process.env['PI_PATH'],
  ]

  for (const p of possiblePaths) {
    if (p && typeof p === 'string') {
      return p
    }
  }

  return 'pi'
}

/**
 * Run a PI coding session with the configured model.
 */
export async function runCodingSession(
  prompt: string,
  options?: PiCommandOptions & { model?: string; maxTurns?: number }
): Promise<string> {
  const piPath = getPiPath()
  const { cwd = process.cwd(), env = {}, timeoutMs = 300000 } = options ?? {}
  const model = options?.model || ''
  const maxTurns = options?.maxTurns || 75

  const cmd = piPath

  try {
    const { stdout, stderr } = await execAsync(
      `${cmd} -p "${prompt.replace(/"/g, '\\"')}"`,
      {
        cwd,
        env: { ...process.env, ...env },
        timeout: timeoutMs,
      }
    )
    return stdout
  } catch (error: unknown) {
    if (error instanceof Error && 'stderr' in error) {
      const err = error as NodeJS.ErrnoException & { stderr: string }
      throw new Error(`PI coding session failed:\n${err.stderr}\nPrompt:\n${prompt}`)
    }
    throw error
  }
}

/**
 * Get PI suggestions for a file.
 */
export async function getPiSuggestions(
  fileContent: string,
  context?: string,
  options?: PiCommandOptions & { model?: string }
): Promise<string[]> {
  const piPath = getPiPath()
  const { cwd = process.cwd(), env = {}, timeoutMs = 60000 } = options ?? {}
  const model = options?.model || ''

  try {
    const command = `${piPath} --suggestions`
    
    const args = ['-c', fileContent]
    if (context) args.push('-C', context)
    if (model) args.push('-m', model)

    const { stdout } = await execAsync(`${command} ${args.join(' ')}`, {
      cwd,
      env: { ...process.env, ...env },
      timeout: timeoutMs,
    })

    return stdout.split('\n').filter((line) => line.trim().length > 0)
  } catch (error: unknown) {
    console.error('Failed to get PI suggestions:', error)
    return []
  }
}

/**
 * Run PI in a coding session with the configured command from config.
 */
export async function runPiWithConfig(
  prompt: string,
  llmConfig: Record<string, unknown>,
  options?: PiCommandOptions
): Promise<string> {
  const piPath = getPiPath()

  // Default to PI CLI with coding agent
  let command = '-p'
  
  // Check if there's a custom command configured (from config)
  if (llmConfig.llm?.['continue_cli'] && llmConfig.llm.continue_cli.command) {
    const continueCli = llmConfig.llm.continue_cli as Record<string, unknown>
    command = String(continueCli.command).trim() || '-p'
  }

  try {
    const fullCommand = `${piPath} ${command} "${prompt.replace(/"/g, '\\"')}"`
    
    const envVars: Record<string, string> = {}
    if (llmConfig.llm?.claude) {
      const claude = llmConfig.llm.claude as Record<string, unknown>
      envVars['PI_MODEL'] = String(claude.model || 'claude-sonnet-4-20250514').trim()
    }

    const { stdout } = await execAsync(fullCommand, {
      cwd: options?.cwd,
      env: { ...process.env, ...envVars },
      timeout: 300000,
    })
    
    return stdout
  } catch (error: unknown) {
    throw error
  }
}

/**
 * Check if PI CLI is configured in the bot config.
 */
export function isPiConfigured(
  config: Record<string, unknown>
): boolean {
  const llmConfig = config.llm as Record<string, unknown> || {}
  
  // Check for continue_cli configuration
  if (llmConfig.continue_cli) {
    return true
  }

  // Default: assume PI CLI is the default provider
  return true
}

/**
 * Get the recommended PI model from config.
 */
export function getRecommendedPiModel(config: Record<string, unknown>): string {
  const llmConfig = config.llm as Record<string, unknown> || {}
  
  // Check for investigation model preference
  if (llmConfig.claude?.investigation_model) {
    return String(llmConfig.claude.investigation_model).trim()
  }

  // Default investigation model
  return 'claude-opus-4-20250514'
}
