import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { REPO_ROOT } from '../utils/paths'
import { getConfig, getValue } from '../config'

export interface DiscordProviderConfig {
  enabled: boolean
  agent_path?: string // Path to the Discord agent (default: uses openclaw if available)
  session_label?: string // Session label to target
  model?: string // Model to use for the Discord agent
  timeout_seconds?: number // Timeout for agent responses
  workspace_path?: string // Custom workspace path for the agent
}

/**
 * Get Discord provider configuration from config.json
 */
export async function getDiscordProviderConfig(): Promise<DiscordProviderConfig> {
  const config = await getConfig()
  return {
    enabled: Boolean(getValue(config, ['llm', 'discord', 'enabled'], false)),
    agent_path: getValue(config, ['llm', 'discord', 'agent_path'], undefined) as string | undefined,
    session_label: getValue(config, ['llm', 'discord', 'session_label'], 'help-bot-assistant') as
      | string
      | undefined,
    model: getValue(config, ['llm', 'discord', 'model'], undefined) as string | undefined,
    timeout_seconds: Number(getValue(config, ['llm', 'discord', 'timeout_seconds'], 300)),
    workspace_path: getValue(config, ['llm', 'discord', 'workspace_path'], undefined) as
      | string
      | undefined,
  }
}

/**
 * Check if the Discord provider is properly configured and available
 */
export async function isDiscordProviderAvailable(): Promise<boolean> {
  const config = await getDiscordProviderConfig()
  if (!config.enabled) return false

  // Check if openclaw is available
  try {
    const proc = spawn('openclaw', ['--version'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const [code] = await once(proc, 'exit')
    return code === 0
  } catch {
    return false
  }
}

/**
 * Run a Discord agent session for help bot queries
 */
export async function runDiscordProvider(
  prompt: string,
  instructions: string,
  systemPrompt?: string,
  modelOverride?: string,
): Promise<void> {
  const config = await getDiscordProviderConfig()

  console.log(
    `Provider: Discord Agent (session: ${config.session_label}, model: ${modelOverride || config.model || 'default'})`,
  )

  // Prepare the full prompt with context
  const fullPrompt = [
    systemPrompt?.trim(),
    instructions.trim(),
    '',
    'Help Bot Request:',
    prompt.trim(),
    '',
    'Available data files in help-bot/data:',
    '- reference/repo/* - GameCI repository structure and code',
    '- issues/* - GitHub issues data',
    '- discord/* - Discord messages and threads',
    '',
    'Note: Use the Read tool to examine files as needed. Focus on providing helpful responses based on the GameCI documentation and codebase.',
  ]
    .filter(Boolean)
    .join('\n')

  // Use openclaw sessions to send the message
  const args = ['sessions', 'send', '--label', config.session_label!, '--message', fullPrompt]

  if (config.timeout_seconds && config.timeout_seconds > 0) {
    args.push('--timeout-seconds', String(config.timeout_seconds))
  }

  const proc = spawn('openclaw', args, {
    cwd: config.workspace_path || REPO_ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      // Pass model override if specified
      ...(modelOverride && { OPENCLAW_MODEL_OVERRIDE: modelOverride }),
    },
  })

  const [code] = await once(proc, 'exit')
  if (code !== 0) {
    throw new Error(`Discord provider failed with exit code ${code}`)
  }
}

/**
 * Initialize a Discord agent session if it doesn't exist
 */
export async function initializeDiscordSession(): Promise<void> {
  const config = await getDiscordProviderConfig()
  if (!config.enabled) return

  console.log('Checking Discord agent session...')

  // Check if session exists
  const checkProc = spawn('openclaw', ['sessions', 'list', '--json'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const output: Buffer[] = []
  checkProc.stdout.on('data', (chunk) => output.push(chunk))

  const [checkCode] = await once(checkProc, 'exit')
  if (checkCode === 0) {
    try {
      const sessions = JSON.parse(Buffer.concat(output).toString())
      const existingSession = sessions.find((s: any) => s.label === config.session_label)
      if (existingSession) {
        console.log(`Discord agent session '${config.session_label}' already exists`)
        return
      }
    } catch {
      // Ignore parse errors, proceed to create session
    }
  }

  // Create new session
  console.log(`Creating Discord agent session '${config.session_label}'...`)

  const createArgs = [
    'sessions',
    'spawn',
    '--runtime',
    'subagent',
    '--mode',
    'session',
    '--label',
    config.session_label!,
    '--task',
    'You are a GameCI help bot assistant. Your role is to answer questions about GameCI, Unity CI/CD, and related topics using the documentation and codebase available in the help-bot/data directory.',
  ]

  if (config.model) {
    createArgs.push('--model', config.model)
  }

  if (config.workspace_path) {
    createArgs.push('--cwd', config.workspace_path)
  }

  const createProc = spawn('openclaw', createArgs, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  })

  const [createCode] = await once(createProc, 'exit')
  if (createCode !== 0) {
    throw new Error(`Failed to create Discord agent session with exit code ${createCode}`)
  }

  console.log(`Discord agent session '${config.session_label}' created successfully`)
}
