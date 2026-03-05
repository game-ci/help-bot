import { loadState } from './state'
import { readFeedbackEntries } from './feedback'
import { CycleStats } from './metrics'

export async function reportSummary(): Promise<void> {
  const state = await loadState()
  const stats = (state.meta?.lastCycleStats ?? undefined) as CycleStats | undefined
  const runAt = state.meta?.lastCycleAt
  console.log('=== Help Cycle Summary ===')
  if (runAt) {
    console.log(`Last cycle recorded at: ${runAt}`)
  }
  if (stats) {
    console.log(`Discord messages synced: ${stats.discordMessagesSynced}`)
    console.log(`Discord responses posted: ${stats.discordResponsesPosted}`)
    console.log(`Discord responses skipped: ${stats.discordResponsesSkipped}`)

    // Per-guild breakdown
    const guildStats = stats.discordGuildStats
    if (guildStats && Object.keys(guildStats).length > 0) {
      console.log('  Per-guild breakdown:')
      for (const [guildName, gStats] of Object.entries(guildStats)) {
        console.log(`    ${guildName}: ${gStats.messagesSynced} messages synced`)
      }
    }

    console.log(`GitHub issues synced: ${stats.githubIssuesSynced}`)
    console.log(`GitHub releases synced: ${stats.githubReleasesSynced}`)
    console.log(`GitHub tags synced: ${stats.githubTagsSynced}`)
    console.log(`GitHub responses posted: ${stats.githubResponsesPosted}`)
    console.log(`GitHub responses skipped: ${stats.githubResponsesSkipped}`)
  } else {
    console.log('No cycle stats recorded yet.')
  }
  const feedback = await readFeedbackEntries()
  if (feedback.length) {
    const good = feedback.filter((entry) => entry.verdict === 'good').length
    const bad = feedback.filter((entry) => entry.verdict === 'bad').length
    console.log(`Feedback entries: ${feedback.length} (good: ${good}, bad: ${bad})`)
  } else {
    console.log('No feedback entries recorded yet.')
  }
}
