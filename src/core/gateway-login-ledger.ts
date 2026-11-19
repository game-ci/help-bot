import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Every gateway login is an IDENTIFY, and Discord resets a bot's token after
 * about 1000 of them in a day. A process supervisor restarting a crashing bot
 * spends that budget in minutes, so logins are recorded across restarts and
 * the next one waits longer the more often the bot has just logged in.
 */
export type GatewayLoginLedger = {
  readonly attempts: ReadonlyArray<number>
}

export type ParsedLedger =
  | { readonly ok: true; readonly ledger: GatewayLoginLedger }
  | { readonly ok: false; readonly reason: string }

const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const BACKOFF_WINDOW = HOUR
const LOGINS_WITHOUT_DELAY = 2
const FIRST_DELAY = 30 * SECOND
const LONGEST_DELAY = 15 * MINUTE
const RETENTION = DAY

const isTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

export const GatewayLoginLedger = {
  empty: (): GatewayLoginLedger => ({ attempts: [] }),

  record: (ledger: GatewayLoginLedger, at: number): GatewayLoginLedger => ({
    attempts: [...ledger.attempts.filter((attempt) => at - attempt < RETENTION), at],
  }),

  loginsWithin: (ledger: GatewayLoginLedger, now: number, window: number): number =>
    ledger.attempts.filter((attempt) => now - attempt < window).length,

  delayBeforeNextLogin: (ledger: GatewayLoginLedger, now: number): number => {
    const recentLogins = GatewayLoginLedger.loginsWithin(ledger, now, BACKOFF_WINDOW)
    if (recentLogins < LOGINS_WITHOUT_DELAY) return 0
    const doublings = recentLogins - LOGINS_WITHOUT_DELAY
    return Math.min(FIRST_DELAY * 2 ** doublings, LONGEST_DELAY)
  },

  serialise: (ledger: GatewayLoginLedger): string => JSON.stringify(ledger),

  parse: (text: string): ParsedLedger => {
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch (error) {
      return { ok: false, reason: `invalid JSON: ${(error as Error).message}` }
    }
    const attempts = (value as { attempts?: unknown } | null)?.attempts
    if (!Array.isArray(attempts) || !attempts.every(isTimestamp)) {
      return { ok: false, reason: 'attempts must be an array of timestamps' }
    }
    return { ok: true, ledger: { attempts } }
  },
} as const

/** Reads the ledger, starting afresh when it is missing or unreadable. */
export async function loadGatewayLoginLedger(path: string): Promise<GatewayLoginLedger> {
  let text: string
  try {
    text = await readFile(path, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return GatewayLoginLedger.empty()
    console.warn(`  ⚠ Could not read gateway login ledger ${path}: ${(error as Error).message}`)
    return GatewayLoginLedger.empty()
  }
  const parsed = GatewayLoginLedger.parse(text)
  if (parsed.ok) return parsed.ledger
  console.warn(`  ⚠ Ignoring corrupt gateway login ledger ${path}: ${parsed.reason}`)
  return GatewayLoginLedger.empty()
}

export async function saveGatewayLoginLedger(
  path: string,
  ledger: GatewayLoginLedger,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, GatewayLoginLedger.serialise(ledger), 'utf-8')
}

/**
 * Waits until the ledger allows another gateway login, then records it.
 * Call this immediately before `client.login()`.
 */
export async function awaitGatewayLoginSlot(
  path: string,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  const ledger = await loadGatewayLoginLedger(path)
  const delay = GatewayLoginLedger.delayBeforeNextLogin(ledger, Date.now())
  const lastHour = GatewayLoginLedger.loginsWithin(ledger, Date.now(), HOUR)
  const lastDay = GatewayLoginLedger.loginsWithin(ledger, Date.now(), DAY)
  if (delay > 0) {
    console.warn(
      `  ⚠ ${lastHour} gateway login(s) in the last hour, ${lastDay} in the last day; ` +
        `waiting ${Math.round(delay / SECOND)}s before logging in to protect the bot token.`,
    )
    await sleep(delay)
  } else {
    console.log(`  Gateway logins: ${lastHour} in the last hour, ${lastDay} in the last day.`)
  }
  await saveGatewayLoginLedger(path, GatewayLoginLedger.record(ledger, Date.now()))
}
