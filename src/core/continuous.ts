import { runCycle, CycleOptions } from './cycle'
import { getConfig, getValue } from '../config'

export interface ContinuousOptions extends CycleOptions {
  intervalMinutes?: number
}

export async function runContinuous(options: ContinuousOptions = {}): Promise<void> {
  const config = await getConfig()
  const defaultInterval = Number(getValue(config, ['bot', 'cycle_interval_minutes'], 30))
  const interval = options.intervalMinutes ?? defaultInterval
  let running = true

  const shutdown = () => {
    console.log('\nGraceful shutdown requested, finishing current cycle...')
    running = false
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  while (running) {
    await runCycle(options)
    if (!running) break
    console.log(`Waiting ${interval} minute(s) for next cycle...`)
    await new Promise((resolve) => setTimeout(resolve, interval * 60 * 1000))
  }
}
