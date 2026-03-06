export interface CycleStats {
  discordMessagesSynced: number
  discordResponsesPosted: number
  discordResponsesSkipped: number
  githubIssuesSynced: number
  githubReleasesSynced: number
  githubTagsSynced: number
  githubResponsesPosted: number
  githubResponsesSkipped: number
  investigationIssuesPosted: number
  investigationIssuesSkipped: number
  cycleReportsPosted: number
  /** Per-guild Discord message sync counts */
  discordGuildStats: Record<string, { messagesSynced: number }>
}

let currentStats: CycleStats = makeEmptyStats()

function makeEmptyStats(): CycleStats {
  return {
    discordMessagesSynced: 0,
    discordResponsesPosted: 0,
    discordResponsesSkipped: 0,
    githubIssuesSynced: 0,
    githubReleasesSynced: 0,
    githubTagsSynced: 0,
    githubResponsesPosted: 0,
    githubResponsesSkipped: 0,
    investigationIssuesPosted: 0,
    investigationIssuesSkipped: 0,
    cycleReportsPosted: 0,
    discordGuildStats: {},
  }
}

export function resetStats(): void {
  currentStats = makeEmptyStats()
}

/**
 * Record a stat increment. When guildName is provided and the key is a Discord-related
 * stat, per-guild tracking is also updated.
 */
export function recordStat<K extends keyof CycleStats>(key: K, amount = 1, guildName?: string): void {
  if (key === 'discordGuildStats') {
    // This key is an object, not a number -- don't increment directly
    return
  }
  ;(currentStats[key] as number) += amount

  // Per-guild tracking for Discord messages
  if (guildName && key === 'discordMessagesSynced') {
    currentStats.discordGuildStats[guildName] ??= { messagesSynced: 0 }
    currentStats.discordGuildStats[guildName].messagesSynced += amount
  }
}

export function getStats(): CycleStats {
  return {
    ...currentStats,
    discordGuildStats: { ...currentStats.discordGuildStats },
  }
}
