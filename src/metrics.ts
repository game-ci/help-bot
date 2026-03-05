export interface CycleStats {
  discordMessagesSynced: number
  discordResponsesPosted: number
  discordResponsesSkipped: number
  githubIssuesSynced: number
  githubReleasesSynced: number
  githubTagsSynced: number
  githubResponsesPosted: number
  githubResponsesSkipped: number
}

let currentStats: CycleStats = {
  discordMessagesSynced: 0,
  discordResponsesPosted: 0,
  discordResponsesSkipped: 0,
  githubIssuesSynced: 0,
  githubReleasesSynced: 0,
  githubTagsSynced: 0,
  githubResponsesPosted: 0,
  githubResponsesSkipped: 0,
}

export function resetStats(): void {
  currentStats = {
    discordMessagesSynced: 0,
    discordResponsesPosted: 0,
    discordResponsesSkipped: 0,
    githubIssuesSynced: 0,
    githubReleasesSynced: 0,
    githubTagsSynced: 0,
    githubResponsesPosted: 0,
    githubResponsesSkipped: 0,
  }
}

export function recordStat<K extends keyof CycleStats>(key: K, amount = 1): void {
  currentStats[key] += amount
}

export function getStats(): CycleStats {
  return { ...currentStats }
}
