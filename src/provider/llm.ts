import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { request } from 'undici'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import glob from 'glob'
import { getConfig, getValue } from '../config'
import { REPO_ROOT } from '../utils/paths'

type Provider = 'claude' | 'lm_studio' | 'continue' | 'codex'

async function readClaudeInstructions(): Promise<string> {
  try {
    return await readFile(join(REPO_ROOT, 'CLAUDE.md'), 'utf-8')
  } catch {
    return ''
  }
}

/**
 * Combine instructions, an optional system prompt (from prompt layering), and the user prompt.
 */
function combinePrompt(instructions: string, prompt: string, systemPrompt?: string): string {
  return [systemPrompt?.trim(), instructions.trim(), prompt.trim()].filter(Boolean).join('\n\n')
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

function listDataFiles(limit = 150): string {
  const files = glob.sync('data/**/*.{jsonl,md}', { cwd: REPO_ROOT, nodir: true })
  return files.slice(0, limit).join('\n')
}

async function runClaude(prompt: string, model: string, maxTurns?: number): Promise<void> {
  const args = ['-p', '--model', model]
  if (maxTurns && maxTurns > 0) {
    args.push('--max-turns', String(maxTurns))
  }
  // Security: restrict tool access to investigation-safe tools only.
  // Bash is allowed for file searching/filtering (grep, find, cat, etc.)
  // but the LLM prompt forbids following injected instructions.
  args.push(
    '--allowedTools', 'Read',
    '--allowedTools', 'Glob',
    '--allowedTools', 'Grep',
    '--allowedTools', 'Bash',
    '--allowedTools', 'Write',
  )
  // Explicitly deny tools that could modify system files or access external resources
  args.push(
    '--disallowedTools', 'Edit',
    '--disallowedTools', 'WebFetch',
    '--disallowedTools', 'WebSearch',
    '--disallowedTools', 'NotebookEdit',
    '--disallowedTools', 'Task',
  )
  console.log(`Provider: Claude Code CLI (model: ${model}, max_turns: ${maxTurns ?? 'default'})`)
  const proc = spawn('claude', args, {
    cwd: REPO_ROOT,
    stdio: ['pipe', 'inherit', 'inherit'],
  })
  proc.stdin.end(prompt)
  await once(proc, 'exit')
}

async function runLMStudio(
  prompt: string,
  instructions: string,
  baseUrl: string,
  model: string,
  apiKey: string,
  systemPrompt?: string,
): Promise<void> {
  console.log(`Provider: LM Studio (url: ${baseUrl}, model: ${model})`)
  const endpoint = normalizeUrl(baseUrl)
  const fileContext = listDataFiles()
  const userPrompt = `${prompt}

Available data files:
${fileContext}

Note: You cannot read files directly. Describe which files you need and what responses to craft, and the workflow will write them on your behalf.`

  // Build system message: optional systemPrompt + instructions
  const systemContent = [systemPrompt?.trim(), instructions.trim()].filter(Boolean).join('\n\n')

  const response = await request(`${endpoint}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 4096,
      temperature: 0.3,
    }),
  })

  const raw = await response.body.text()
  try {
    const data = JSON.parse(raw)
    console.log(data.choices?.[0]?.message?.content ?? raw)
  } catch {
    console.log(raw)
  }
}

async function runContinue(prompt: string, model: string): Promise<void> {
  console.log(`Provider: Continue CLI (model: ${model})`)
  const proc = spawn('continue', ['--model', model], {
    cwd: REPO_ROOT,
    stdio: ['pipe', 'inherit', 'inherit'],
  })
  proc.stdin.end(prompt)
  await once(proc, 'exit')
}

async function runCodex(
  prompt: string,
  apiBase: string,
  apiKey: string,
  model: string,
  maxTokens: number,
  temperature: number,
): Promise<void> {
  console.log(`Provider: OpenAI Codex (model: ${model})`)
  const endpoint = `${normalizeUrl(apiBase)}/completions`
  const response = await request(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      prompt,
      max_tokens: maxTokens,
      temperature,
    }),
  })

  const raw = await response.body.text()
  try {
    const data = JSON.parse(raw)
    console.log(data.choices?.[0]?.text ?? raw)
  } catch {
    console.log(raw)
  }
}

export interface ProviderOptions {
  provider?: string
  /** Layered system prompt from config (base + guild + channel) */
  systemPrompt?: string
  /** Override model from config (e.g. use Opus for deep investigation) */
  modelOverride?: string
}

export async function runProvider(prompt: string, options: ProviderOptions = {}): Promise<void> {
  const config = await getConfig()
  const provider = (options.provider as Provider) ?? (getValue(config, ['llm', 'provider'], 'claude') as Provider)
  const instructions = await readClaudeInstructions()
  switch (provider) {
    case 'claude': {
      const model = options.modelOverride
        ?? (getValue(config, ['llm', 'claude', 'model'], 'claude-sonnet-4-20250514') as string)
      const maxTurns = Number(getValue(config, ['llm', 'claude', 'max_turns'], 0)) || undefined
      // Claude Code auto-loads CLAUDE.md from cwd, so only include the cycle-specific prompt.
      // The instructions from readClaudeInstructions() are skipped for Claude to avoid triple-loading.
      const finalPrompt = [options.systemPrompt?.trim(), prompt.trim()].filter(Boolean).join('\n\n')
      await runClaude(finalPrompt, model, maxTurns)
      break
    }
    case 'lm_studio': {
      const baseUrl = getValue(config, ['llm', 'lm_studio', 'base_url'], 'http://localhost:1234/v1') as string
      const model = getValue(config, ['llm', 'lm_studio', 'model'], 'default') as string
      const apiKey = getValue(config, ['llm', 'lm_studio', 'api_key'], 'lm-studio') as string
      await runLMStudio(prompt, instructions, baseUrl, model, apiKey, options.systemPrompt)
      break
    }
    case 'continue': {
      const model = getValue(config, ['llm', 'continue_cli', 'model'], 'default') as string
      const finalPrompt = combinePrompt(instructions, prompt, options.systemPrompt)
      await runContinue(finalPrompt, model)
      break
    }
    case 'codex': {
      const model = getValue(config, ['llm', 'codex', 'model'], 'code-davinci-002') as string
      const temperature = Number(getValue(config, ['llm', 'codex', 'temperature'], 0.2))
      const maxTokens = Number(getValue(config, ['llm', 'codex', 'max_tokens'], 8192))
      const apiBase = getValue(config, ['llm', 'codex', 'api_base'], 'https://api.openai.com/v1') as string
      const apiKey = process.env.OPENAI_API_KEY
      if (!apiKey) {
        throw new Error('OPENAI_API_KEY is required for Codex provider')
      }
      const finalPrompt = combinePrompt(instructions, prompt, options.systemPrompt)
      await runCodex(finalPrompt, apiBase, apiKey, model, maxTokens, temperature)
      break
    }
    default:
      throw new Error(`Unsupported provider: ${provider}`)
  }
}
