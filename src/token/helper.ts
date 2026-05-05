import keytar from 'keytar'
import prompts from 'prompts'
import { request } from 'undici'

const SERVICE_NAME = 'GameCI Help Bot'
const ACCOUNT_NAME = 'discord-bot-token'

async function loadFromStore(): Promise<string | null> {
  try {
    return await keytar.getPassword(SERVICE_NAME, ACCOUNT_NAME)
  } catch {
    return null
  }
}

async function saveToStore(token: string): Promise<void> {
  try {
    await keytar.setPassword(SERVICE_NAME, ACCOUNT_NAME, token)
  } catch {
    // ignore failures
  }
}

async function validateToken(token: string): Promise<boolean> {
  try {
    const response = await request('https://discord.com/api/v10/users/@me', {
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
      },
      method: 'GET',
    })
    return response.statusCode === 200
  } catch {
    return false
  }
}

export async function ensureDiscordToken(): Promise<string> {
  // If token is already in the environment, trust it — let client.login() handle
  // validation. This avoids network issues on service restart (NSSM/SYSTEM account)
  // and prevents falling through to the interactive prompt.
  if (process.env.DISCORD_BOT_TOKEN) {
    return process.env.DISCORD_BOT_TOKEN
  }

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)

  const stored = await loadFromStore()
  if (stored) {
    if (!interactive) {
      process.env.DISCORD_BOT_TOKEN = stored
      return stored
    }
    if (await validateToken(stored)) {
      process.env.DISCORD_BOT_TOKEN = stored
      return stored
    }
  }

  if (!interactive) {
    throw new Error('Discord bot token is required — set DISCORD_BOT_TOKEN environment variable')
  }

  const response = await prompts({
    type: 'password',
    name: 'token',
    message: 'Discord bot token',
  })

  if (!response.token) {
    throw new Error('Discord bot token is required')
  }

  if (!(await validateToken(response.token))) {
    throw new Error('Discord bot token validation failed')
  }

  process.env.DISCORD_BOT_TOKEN = response.token
  await saveToStore(response.token)
  return response.token
}
