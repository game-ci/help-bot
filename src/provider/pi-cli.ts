import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { getRecommendedPiModel, isPiConfigured, runPiWithConfig } from '../pi-coding-agent'

type PiProviderOptions = {
  modelOverride?: string
  systemPrompt?: string
  cwd?: string
}

/**
 * Run a coding prompt using PI CLI.
 * PI CLI handles the entire conversation and writes responses to files.
 */
export async function runPiProvider(
  prompt: string,
  options: PiProviderOptions = {}
): Promise<void> {
  const cwd = options.cwd ?? process.cwd()

  // Default model from config or use recommended investigation model
  const model = options.modelOverride || getRecommendedPiModel({})

  console.log(`Provider: PI CLI Coding Agent (model: ${model})`)
  
  try {
    // PI CLI runs as a separate process that handles the full conversation
    // We provide the prompt and let PI handle it with allowed tools
    const proc = spawn('pi', ['-p', `--model`, model, '--allowedTools', 'Read,Glob,Grep,Bash,Write'], {
      cwd: cwd,
      stdio: ['pipe', 'pipe', 'inherit'],
    })

    // Send the prompt to PI CLI
    proc.stdin.write(prompt)
    proc.stdin.end()

    const [code] = (await once(proc, 'exit')) as [number | null]
    
    if (code !== 0) {
      throw new Error(`PI CLI exited with code ${code ?? 'unknown'}`)
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error(`PI CLI failed: ${msg}`)
    throw new Error(`PI provider failed: ${msg}`)
  }
}

/**
 * Run PI CLI with config from bot configuration.
 */
export async function runPiWithConfig(
  prompt: string,
  config: Record<string, unknown>,
  options?: { modelOverride?: string; cwd?: string }
): Promise<void> {
  const cwd = options?.cwd ?? process.cwd()
  
  // Check if PI is configured in the bot config
  if (!isPiConfigured(config)) {
    console.log('PI not configured in bot config. Using default configuration.')
  }

  const model = options?.modelOverride || getRecommendedPiModel(config)
  console.log(`Provider: PI CLI (model: ${model})`)
  
  try {
    const proc = spawn('pi', ['-p', `--model`, model, '--allowedTools', 'Read,Glob,Grep,Bash,Write'], {
      cwd: cwd,
      stdio: ['pipe', 'pipe', 'inherit'],
    })

    // Send prompt to PI CLI
    proc.stdin.write(prompt)
    proc.stdin.end()

    const [code] = (await once(proc, 'exit')) as [number | null]
    
    if (code !== 0) {
      throw new Error(`PI CLI exited with code ${code ?? 'unknown'}`)
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error(`PI CLI failed: ${msg}`)
    throw new Error(`PI provider failed: ${msg}`)
  }
}

/**
 * Check if PI CLI is available.
 */
export async function checkPiAvailability(): Promise<boolean> {
  try {
    const result = await spawn('pi', ['--version'])
    return true
  } catch {
    return false
  }
}
