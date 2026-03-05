import { request } from 'undici'
import { ensureDir, appendText } from '../utils/fs'
import { DISCORD_DATA_DIR } from '../utils/paths'
import { getConfig, getValue } from '../config'
import { join } from 'node:path'
import { loadState, saveState } from '../state'
import { recordStat } from '../metrics'

const DISCORD_API = 'https://discord.com/api/v10'

function buildHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bot ${token}`,
    'Content-Type': 'application/json',
  }
}

function snowflakeFromHoursAgo(hours: number): bigint {
  const now = BigInt(Date.now())
  const offset = BigInt(hours) * 3600n * 1000n
  const target = now - offset
  const discordEpoch = 1420070400000n
  return (target - discordEpoch) << 22n
}

async function fetchWithRetry(url: string, headers: Record<string, string>) {
  const res = await request(url, { method: 'GET', headers })
  if (res.statusCode === 429) {
    const body = await res.body.text()
    const data = JSON.parse(body)
    const wait = (data.retry_after ?? 1) * 1000
    await new Promise((resolve) => setTimeout(resolve, wait))
    return request(url, { method: 'GET', headers })
  }
  return res
}

export async function syncDiscord(): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN
  const guildId = process.env.DISCORD_GUILD_ID
  if (!token || !guildId) {
    throw new Error('DISCORD_BOT_TOKEN and DISCORD_GUILD_ID are required')
  }

  const config = await getConfig()
  const syncHours = Number(getValue(config, ['discord', 'sync_hours'], 6))
  const ignoreBots = Boolean(getValue(config, ['discord', 'ignore_bots'], true))
  const minMessage = Number(getValue(config, ['discord', 'min_message_length'], 15))
  const ignorePrefixes = (getValue(config, ['discord', 'ignore_prefixes'], ['!', '/', '$', '.']) as string[])
  const rawChannels = (getValue(config, ['discord', 'channels'], [
    'help',
    'support',
    'general',
    'bugs',
    'unity-builder',
    'unity-test-runner',
    'docker',
  ]) as string[])

  const afterSnowflake = snowflakeFromHoursAgo(syncHours)
  const headers = buildHeaders(token)

  const channelResponse = await fetchWithRetry(`${DISCORD_API}/guilds/${guildId}/channels`, headers)
  if (channelResponse.statusCode >= 400) {
    throw new Error(`Failed to list guild channels: ${channelResponse.statusCode}`)
  }
  const channelList = JSON.parse(await channelResponse.body.text())
  const channels = Array.isArray(channelList) ? channelList : []

  const state = await loadState()
  state.discord ??= {}
  const officialRoles = ((getValue(config, ['discord', 'official_roles'], []) as string[]).map((role) => role.toLowerCase()))
  const officialUsers = ((getValue(config, ['discord', 'official_users'], []) as string[]).map((id) => id.toLowerCase()))
  await ensureDir(DISCORD_DATA_DIR)

  for (const channelName of rawChannels) {
    const channel = channels.find((c: any) => c.name === channelName && c.type === 0)
    if (!channel) {
      console.warn(`Channel ${channelName} not found, skipping.`)
      continue
    }
    const channelId = channel.id
    console.log(`Syncing channel ${channelName} (${channelId})...`)

    const storedCursor = state.discord[channelId]
    let currentAfter = storedCursor ? BigInt(storedCursor) : afterSnowflake
    while (true) {
      const url = `${DISCORD_API}/channels/${channelId}/messages?limit=100&after=${currentAfter}`
      const response = await fetchWithRetry(url, headers)
      const text = await response.body.text()
      if (response.statusCode !== 200) {
        console.warn(`Discord API returned ${response.statusCode} for ${channelName}`)
        break
      }

      const messages = JSON.parse(text)
      if (!Array.isArray(messages) || messages.length === 0) {
        break
      }

      recordStat('discordMessagesSynced', messages.length)

      for (const msg of messages) {
        if (ignoreBots && msg?.author?.bot) {
          continue
        }
        if (typeof msg.content !== 'string' || msg.content.trim().length < minMessage) {
          continue
        }
        const trimmed = msg.content.trim()
        if (ignorePrefixes.some((prefix) => trimmed.startsWith(prefix))) {
          continue
        }
        const timestamp = msg.timestamp ?? new Date().toISOString()
        const dateKey = new Date(timestamp).toISOString().slice(0, 10)
        const memberRoles = (msg.member?.roles ?? []) as string[]
        const isOfficial =
          memberRoles.some((role: string) => officialRoles.includes(role.toLowerCase())) ||
          officialUsers.includes((msg.author?.id ?? '').toLowerCase())
        const record = JSON.stringify({
          id: msg.id,
          author: msg?.author?.username ?? 'unknown',
          author_id: msg?.author?.id,
          content: msg.content,
          timestamp,
          channel_id: channelId,
          channel_name: channelName,
          is_bot: msg?.author?.bot ?? false,
          has_reply: Boolean(msg.referenced_message),
          message_type: msg.type ?? 0,
          is_official: isOfficial,
        })
        const targetFile = join(DISCORD_DATA_DIR, channelName, `${dateKey}.jsonl`)
        await appendText(targetFile, `${record}\n`)
      }

      const lastId = messages[messages.length - 1]?.id
      if (!lastId) {
        break
      }
      currentAfter = BigInt(lastId)
      if (messages.length < 100) {
        break
      }
    }
    state.discord[channelId] = currentAfter.toString()
  }
  await saveState(state)
}
