import type { EventEmitter } from 'node:events'

/**
 * Exit code for faults a restart cannot fix: a rejected token or a disallowed
 * intent. The NSSM service is configured to stop, not restart, on this code
 * (EX_CONFIG from sysexits.h), so a reset token never turns into a login storm.
 */
export const FATAL_CONFIGURATION_EXIT_CODE = 78

export type StopProcess = (exitCode: number, reason: string) => void

const FATAL_LOGIN_ERROR_CODES = new Set(['TokenInvalid', 'TokenMissing', 'DisallowedIntents'])

const describeError = (error: unknown): string =>
  error instanceof Error ? (error.stack ?? error.message) : String(error)

export function isFatalLoginError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && FATAL_LOGIN_ERROR_CODES.has(code)
}

/**
 * Wraps a Discord event handler so one failing message or reaction is logged
 * instead of escaping as an unhandled rejection that kills the process.
 */
export function guardHandler<Args extends unknown[]>(
  eventName: string,
  handler: (...args: Args) => unknown,
): (...args: Args) => Promise<void> {
  return async (...args: Args) => {
    try {
      await handler(...args)
    } catch (error) {
      console.error(`  ✗ ${eventName} handler failed: ${describeError(error)}`)
    }
  }
}

/** Logs every gateway state change and stops the process when the session is beyond repair. */
export function observeGateway(client: EventEmitter, stop: StopProcess): void {
  client.on('error', (error: unknown) => {
    console.error(`  ✗ Discord client error: ${describeError(error)}`)
  })
  client.on('warn', (message: string) => {
    console.warn(`  ⚠ Discord client warning: ${message}`)
  })
  client.on('shardError', (error: unknown, shardId: number) => {
    console.warn(`  ⚠ Shard ${shardId} connection error: ${describeError(error)}`)
  })
  client.on('shardReconnecting', (shardId: number) => {
    console.log(`  Shard ${shardId} reconnecting to the gateway...`)
  })
  client.on('shardResume', (shardId: number, replayedEvents: number) => {
    console.log(`  ✓ Shard ${shardId} resumed (${replayedEvents} events replayed)`)
  })
  client.on('shardDisconnect', (event: { code?: number }, shardId: number) => {
    stop(
      FATAL_CONFIGURATION_EXIT_CODE,
      `shard ${shardId} closed with unrecoverable code ${event?.code}; check the token and intents`,
    )
  })
  client.on('invalidated', () => {
    stop(1, 'Discord invalidated the session')
  })
}

/**
 * Keeps a stray rejection from killing the bot, and turns a synchronous crash
 * into a logged, deliberate exit.
 */
export function installProcessSafetyNets(stop: StopProcess): void {
  process.on('unhandledRejection', (reason) => {
    console.error(`  ✗ Unhandled promise rejection: ${describeError(reason)}`)
  })
  process.on('uncaughtException', (error) => {
    stop(1, `uncaught exception: ${describeError(error)}`)
  })
}
