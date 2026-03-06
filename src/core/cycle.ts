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
import { getConfig, getValue, resolveGuilds, getSystemPrompt } from '../config'
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
  githubOnly?: boolean
  repos?: string[]
  repoDir?: string
  docsDir?: string
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

  const githubOnly = options.githubOnly ?? false
  const discordConfig = getValue(config, ['discord'], {} as Record<string, unknown>)
  const guilds = githubOnly ? [] : resolveGuilds(discordConfig)
  const hasGuilds = guilds.length > 0

  const hasLocalRepos = Boolean(options.repoDir || options.docsDir)

  if (!skipSync) {
    if (hasGuilds) {
      console.log('Syncing Discord...')
      await syncDiscord()
    } else {
      console.log(githubOnly ? 'GitHub-only mode. Skipping Discord sync.' : 'No Discord guilds configured. Skipping Discord sync.')
    }
    console.log('Syncing GitHub issues...')
    await syncGitHub({ repos: options.repos })
    if (options.docsDir) {
      console.log(`Using local docs clone: ${options.docsDir}. Skipping HTTP docs sync.`)
    } else {
      console.log('Syncing docs...')
      await syncDocs()
    }
  } else {
    console.log('Skipping sync steps (skipSync=true)')
  }

  // Build the layered system prompt from the first guild (base prompt applies to all)
  // For a more granular per-channel approach, individual LLM calls per channel would be needed.
  const systemPrompt = hasGuilds
    ? getSystemPrompt(discordConfig, guilds[0], guilds[0]?.channels?.[0])
    : getValue(discordConfig, ['system_prompt'], '') as string

  const claudeInstructions = await readFile(join(REPO_ROOT, 'CLAUDE.md'), 'utf-8').catch(() => '')

  // Build local repo context for the prompt
  const localContext: string[] = []
  if (options.repoDir) {
    localContext.push(`The source code of the target repository is cloned locally at: ${options.repoDir}`)
    localContext.push(`You MUST read action.yml and search the source code before suggesting any parameters, env vars, or features.`)
    localContext.push(`Key files: action.yml (all input params), src/model/ (input parsing), dist/platforms/ (platform logic), Dockerfile`)
  }
  if (options.docsDir) {
    localContext.push(`The GameCI documentation site is cloned locally at: ${options.docsDir}`)
    localContext.push(`Read the docs there (look under docs/ for markdown content) to find answers and reference material.`)
  }
  const localContextBlock = localContext.length
    ? `\n\nLocal repositories available:\n${localContext.join('\n')}\n`
    : ''

  const repoContext = options.repos?.length ? ` Focus on: ${options.repos.join(', ')}.` : ''
  const prompt = githubOnly
    ? `${claudeInstructions}

You are running a GitHub-only help cycle for the GameCI Community Help Bot.
Process the synced GitHub issues under data/github/issues/ and write structured responses into data/responses/github/.${repoContext}
${localContextBlock}
For each issue worth responding to, follow this workflow:
1. Read the issue markdown file fully — understand the exact problem, error, platform, Unity version.
2. Search the repo source code (action.yml, src/, Dockerfile) to verify any parameters or features you plan to suggest.
3. Search documentation for relevant pages.
4. Search data/github/issues/ for related or duplicate issues.
5. Write an investigation file to data/responses/github/{repo-slug}-{number}-investigation.md documenting what you found, what you verified, and your response strategy.
6. Write the response file to data/responses/github/{repo-slug}-{number}.md with only verified, accurate information.

Do NOT skip the investigation step. Do NOT suggest parameters or features without verifying them in the source code first.
`
    : `${claudeInstructions}

You are running a help cycle for the GameCI Community Help Bot.
Process the synced data under data/ and write structured responses into data/responses/discord and data/responses/github.
`

  console.log('Running LLM provider...')
  await runProvider(prompt, { provider: options.provider, systemPrompt })

  if (hasGuilds) {
    console.log('Posting Discord responses (dry run: ' + dryRun + ')...')
    const seenYouMessage =
      options.seenYouMessage ?? (getValue(config, ['discord', 'seen_you_message'], '') as string)
    const seenYouEmoji = options.seenYouEmoji ?? (getValue(config, ['discord', 'seen_you_emoji'], '') as string)
    await postDiscordResponses({
      dryRun,
      allowOfficial: options.allowOfficial,
      forceReplyId: options.forceReplyId,
      seenYouMessage: seenYouMessage || undefined,
      seenYouEmoji: seenYouEmoji || undefined,
    })
  } else {
    console.log(githubOnly ? 'GitHub-only mode. Skipping Discord posting.' : 'No Discord guilds configured. Skipping Discord posting.')
  }

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
