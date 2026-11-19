import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  GatewayLoginLedger,
  awaitGatewayLoginSlot,
  loadGatewayLoginLedger,
} from './gateway-login-ledger'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const now = Date.UTC(2026, 10, 19, 12, 0, 0)

const ledgerOf = (...minutesAgo: number[]) =>
  minutesAgo.reduce(
    (ledger, ago) => GatewayLoginLedger.record(ledger, now - ago * MINUTE),
    GatewayLoginLedger.empty(),
  )

describe('GatewayLoginLedger.delayBeforeNextLogin', () => {
  it('allows the first login immediately', () => {
    expect(GatewayLoginLedger.delayBeforeNextLogin(GatewayLoginLedger.empty(), now)).toBe(0)
  })

  it('allows one quick restart without waiting', () => {
    expect(GatewayLoginLedger.delayBeforeNextLogin(ledgerOf(1), now)).toBe(0)
  })

  it('backs off exponentially once restarts repeat within the hour', () => {
    expect(GatewayLoginLedger.delayBeforeNextLogin(ledgerOf(2, 1), now)).toBe(30_000)
    expect(GatewayLoginLedger.delayBeforeNextLogin(ledgerOf(3, 2, 1), now)).toBe(60_000)
    expect(GatewayLoginLedger.delayBeforeNextLogin(ledgerOf(4, 3, 2, 1), now)).toBe(120_000)
  })

  it('caps the backoff at fifteen minutes', () => {
    const storm = ledgerOf(...Array.from({ length: 40 }, (_, i) => i + 1))
    expect(GatewayLoginLedger.delayBeforeNextLogin(storm, now)).toBe(15 * MINUTE)
  })

  it('forgets logins older than an hour when backing off', () => {
    expect(GatewayLoginLedger.delayBeforeNextLogin(ledgerOf(90, 80, 70, 1), now)).toBe(0)
  })

  it('keeps a crash loop far below the daily identify limit of Discord', () => {
    let ledger = GatewayLoginLedger.empty()
    let clock = now
    while (clock < now + DAY) {
      clock += GatewayLoginLedger.delayBeforeNextLogin(ledger, clock) + 2_000
      ledger = GatewayLoginLedger.record(ledger, clock)
    }
    expect(GatewayLoginLedger.loginsWithin(ledger, clock, DAY)).toBeLessThan(150)
  })
})

describe('GatewayLoginLedger.record', () => {
  it('drops attempts older than a day', () => {
    const ledger = GatewayLoginLedger.record(ledgerOf(2 * 24 * 60, 5), now)
    expect(ledger.attempts).toEqual([now - 5 * MINUTE, now])
  })
})

describe('GatewayLoginLedger.parse', () => {
  it('round-trips a serialised ledger', () => {
    const ledger = ledgerOf(3, 2, 1)
    expect(GatewayLoginLedger.parse(GatewayLoginLedger.serialise(ledger))).toEqual({
      ok: true,
      ledger,
    })
  })

  it('rejects malformed JSON', () => {
    expect(GatewayLoginLedger.parse('{nope').ok).toBe(false)
  })

  it('rejects a ledger whose attempts are not timestamps', () => {
    expect(GatewayLoginLedger.parse('{"attempts":["x"]}').ok).toBe(false)
    expect(GatewayLoginLedger.parse('{"attempts":3}').ok).toBe(false)
    expect(GatewayLoginLedger.parse('null').ok).toBe(false)
  })
})

const noSleep = async () => {}

describe('awaitGatewayLoginSlot', () => {
  const withLedgerFile = async (contents: string | null) => {
    const path = join(await mkdtemp(join(tmpdir(), 'gateway-ledger-')), 'nested', 'ledger.json')
    if (contents !== null) {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, contents)
    }
    return path
  }

  it('logs in straight away and records the attempt when no ledger exists', async () => {
    const path = await withLedgerFile(null)
    const slept: number[] = []
    await awaitGatewayLoginSlot(path, async (ms) => void slept.push(ms))
    expect(slept).toEqual([])
    expect((await loadGatewayLoginLedger(path)).attempts).toHaveLength(1)
  })

  it('waits before logging in after a burst of restarts', async () => {
    const recent = Date.now() - 1_000
    const path = await withLedgerFile(JSON.stringify({ attempts: [recent, recent, recent] }))
    const slept: number[] = []
    await awaitGatewayLoginSlot(path, async (ms) => void slept.push(ms))
    expect(slept).toEqual([60_000])
    expect((await loadGatewayLoginLedger(path)).attempts).toHaveLength(4)
  })

  it('starts afresh from a corrupt ledger instead of crashing', async () => {
    const path = await withLedgerFile('{corrupt')
    await awaitGatewayLoginSlot(path, noSleep)
    expect((await loadGatewayLoginLedger(path)).attempts).toHaveLength(1)
  })
})
