import { ensureDir } from '../utils/fs'
import { RESPONSES_DIR, LOGS_DIR, REPO_ROOT } from '../utils/paths'
import { syncDiscord } from '../sync/discord'
import { syncGitHub } from '../sync/github'
import { syncDocs } from '../sync/docs'
import { runProvider, ProviderOptions } from '../provider/llm'
import { postDiscordResponses } from '../post/discord'
import { postGitHubResponses } from '../post/github'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getConfig, getValue } from '../config'
import { resetStats, getStats } from '../metrics'
import { updateState } from '../state'

export interface CycleOptions extends ProviderOptions {
  dryRun?: boolean
  skipSync?: boolean
  skipGithubPost?: boolean
  allowOfficial?: boolean
  forceReplyId?: string
  seenYouMessage?: string
  seenYouEmoji?: string
}

export async function runCycle(options: CycleOptions = {}): Promise<void> {
  await ensureDir(RESPONSES_DIR)
  await ensureDir(join(RESPONSES_DIR, 'discord'))
  await ensureDir(join(RESPONSES_DIR, 'github'))
  await ensureDir(LOGS_DIR)

  resetStats()

  const config = await getConfig()
  const dryRun = options.dryRun ?? Boolean(getValue(config, ['bot', 'dry_run'], false))
  const skipSync = options.skipSync ?? process.env.SKIP_SYNC === 'true'
  const skipGithubPost = options.skipGithubPost ?? process.env.SKIP_GITHUB_POST === 'true'

  if (!skipSync) {
    console.log('Syncing Discord...')
    await syncDiscord()
    console.log('Syncing GitHub...')
    await syncGitHub()
    console.log('Syncing docs...')
    await syncDocs()
  } else {
    console.log('Skipping sync steps (skipSync=true)')
  }

  const claudeInstructions = await readFile(join(REPO_ROOT, 'CLAUDE.md'), 'utf-8').catch(() => '')
  const prompt = `${claudeInstructions}

You are running a help cycle for the GameCI Community Help Bot.
Process the synced data under data/ and write structured responses into data/responses/discord and data/responses/github.
`

  console.log('Running LLM provider...')
  await runProvider(prompt, { provider: options.provider })

  console.log('Posting Discord responses (dry run: ' + dryRun + ')...')
  const seenYouMessage = options.seenYouMessage ?? (getValue(config, ['discord', 'seen_you_message'], '') as string)
  const seenYouEmoji = options.seenYouEmoji ?? (getValue(config, ['discord', 'seen_you_emoji'], '') as string)
  await postDiscordResponses({
    dryRun,
    allowOfficial: options.allowOfficial,
    forceReplyId: options.forceReplyId,
    seenYouMessage: seenYouMessage || undefined,
    seenYouEmoji: seenYouEmoji || undefined,
  })
  if (skipGithubPost) {
    console.log('Skipping GitHub posting (skipGithubPost=true)')
  } else {
    console.log('Posting GitHub responses (dry run: ' + dryRun + ')...')
    await postGitHubResponses({
      dryRun,
      allowOfficial: options.allowOfficial,
      forceReplyId: options.forceReplyId,
    })
  }

  const stats = getStats()
  await updateState((state) => {
    state.meta ??= {}
    state.meta.lastCycleStats = stats
    state.meta.lastCycleAt = new Date().toISOString()
  })
}
