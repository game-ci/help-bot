import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import {
  FATAL_CONFIGURATION_EXIT_CODE,
  guardHandler,
  isFatalLoginError,
  observeGateway,
} from './gateway-resilience'

describe('guardHandler', () => {
  it('passes arguments through to the handler', async () => {
    const handler = vi.fn(async (_a: number, _b: string) => {})
    await guardHandler('messageCreate', handler)(1, 'two')
    expect(handler).toHaveBeenCalledWith(1, 'two')
  })

  it('logs a rejected handler instead of letting it crash the process', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(
      guardHandler('messageCreate', async () => {
        throw new Error('boom')
      })(),
    ).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('messageCreate handler failed'))
    error.mockRestore()
  })

  it('logs a synchronous throw as well', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(
      guardHandler('messageReactionAdd', () => {
        throw 'plain string'
      })(),
    ).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('plain string'))
    error.mockRestore()
  })
})

describe('isFatalLoginError', () => {
  it('treats a rejected token or a disallowed intent as fatal', () => {
    expect(isFatalLoginError({ code: 'TokenInvalid' })).toBe(true)
    expect(isFatalLoginError({ code: 'TokenMissing' })).toBe(true)
    expect(isFatalLoginError({ code: 'DisallowedIntents' })).toBe(true)
  })

  it('treats network trouble as retryable', () => {
    expect(isFatalLoginError({ code: 'ECONNRESET' })).toBe(false)
    expect(isFatalLoginError(new Error('socket hang up'))).toBe(false)
    expect(isFatalLoginError(null)).toBe(false)
  })
})

describe('observeGateway', () => {
  const quietly = () => {
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
    ]
    return () => spies.forEach((spy) => spy.mockRestore())
  }

  it('handles client errors so they never become uncaught', () => {
    const restore = quietly()
    const client = new EventEmitter()
    observeGateway(client, vi.fn())
    expect(() => client.emit('error', new Error('gateway hiccup'))).not.toThrow()
    restore()
  })

  it('stops with the fatal configuration code when a shard will never reconnect', () => {
    const restore = quietly()
    const client = new EventEmitter()
    const stop = vi.fn()
    observeGateway(client, stop)
    client.emit('shardDisconnect', { code: 4004 }, 0)
    expect(stop).toHaveBeenCalledWith(
      FATAL_CONFIGURATION_EXIT_CODE,
      expect.stringContaining('4004'),
    )
    restore()
  })

  it('stops with a retryable code when the session is invalidated', () => {
    const restore = quietly()
    const client = new EventEmitter()
    const stop = vi.fn()
    observeGateway(client, stop)
    client.emit('invalidated')
    expect(stop).toHaveBeenCalledWith(1, expect.stringContaining('invalidated'))
    restore()
  })

  it('keeps running through ordinary reconnects', () => {
    const restore = quietly()
    const client = new EventEmitter()
    const stop = vi.fn()
    observeGateway(client, stop)
    client.emit('shardReconnecting', 0)
    client.emit('shardResume', 0, 3)
    client.emit('shardError', new Error('reset'), 0)
    client.emit('warn', 'slow')
    expect(stop).not.toHaveBeenCalled()
    restore()
  })
})
