import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { loadState, updateState, getDetections, getPostedInvestigations, getPostedDiscordResponses } from '../state'
import { recordStat } from '../metrics'
import { EligibleIssue } from '../core/filter-issues'
import { DispatchConfig, DetectionRecord, makeDetectionKey, makeDiscordDetectionKey } from './types'
import { sanitizeText, buildDetectionBody, buildDiscordDetectionBody } from './sanitize'
import type { EligibleDiscordMessage } from '../core/filter-discord'

const execFileAsync = promisify(execFile)

export interface CreateDetectionsOptions {
  eligibleIssues: EligibleIssue[]
  repoSlug: string
  fullRepo: string
  targetRepo: string
  config: DispatchConfig
  dryRun: boolean
}

export interface CreateDetectionsResult {
  created: number
  skippedExisting: number
  skippedInvestigated: number
  skippedLimit: number
}

/**
 * Create detection issues for eligible source issues that don't already
 * have a detection record in state or an existing investigation.
 */
export async function createDetections(options: CreateDetectionsOptions): Promise<CreateDetectionsResult> {
  const state = await loadState()
  const detections = getDetections(state)
  const postedInvestigations = getPostedInvestigations(state)

  const result: CreateDetectionsResult = {
    created: 0,
    skippedExisting: 0,
    skippedInvestigated: 0,
    skippedLimit: 0,
  }

  const repoShortName = options.fullRepo.split('/').pop() ?? options.fullRepo

  for (const issue of options.eligibleIssues) {
    const key = makeDetectionKey(options.fullRepo, issue.number)

    // Skip if detection already exists
    if (detections[key]) {
      result.skippedExisting++
      continue
    }

    // Skip if already investigated
    if (postedInvestigations[key]) {
      result.skippedInvestigated++
      continue
    }

    // Respect per-cycle limit
    if (result.created >= options.config.max_detections_per_cycle) {
      result.skippedLimit++
      continue
    }

    const title = `[Detection] ${options.fullRepo}#${issue.number}: ${sanitizeText(issue.title, 100)}`
    const labels = ['help-bot', 'detection', repoShortName]
    const body = buildDetectionBody({
      sourceRepo: options.fullRepo,
      sourceNumber: issue.number,
      title: issue.title,
      author: issue.author,
      labels: issue.labels,
      commentCount: issue.commentCount,
      dispatchMode: options.config.mode === 'countdown' ? 'countdown' : 'approval',
      warningsRequired: options.config.warnings_required,
      warningIntervalHours: options.config.warning_interval_hours,
      approveReactions: options.config.approve_reactions,
      cancelReactions: options.config.cancel_reactions,
    })

    if (options.dryRun) {
      console.log(`  DRY RUN: would create detection for ${key}`)
      console.log(`    Title: ${title}`)
      console.log(`    Labels: ${labels.join(', ')}`)
      recordStat('detectionsCreated')
      result.created++
      continue
    }

    try {
      const labelArgs = labels.flatMap((l) => ['--label', l])
      const { stdout } = await execFileAsync('gh', [
        'issue', 'create',
        '--repo', options.targetRepo,
        '--title', title,
        ...labelArgs,
        '--body', body,
      ])
      const createdUrl = stdout.trim()
      const createdNumber = Number(createdUrl.split('/').pop() ?? '0')
      console.log(`  Created detection: ${createdUrl}`)

      const now = new Date().toISOString()
      const record: DetectionRecord = {
        detectionIssueNumber: createdNumber,
        sourceRepo: options.fullRepo,
        sourceIssueNumber: issue.number,
        sourceType: 'github',
        status: 'pending',
        createdAt: now,
        currentStage: 0,
        stageAdvancedAt: now,
        warningsRequired: options.config.warnings_required,
        warningIntervalHours: options.config.warning_interval_hours,
      }

      detections[key] = record
      recordStat('detectionsCreated')
      result.created++
    } catch (error: any) {
      console.warn(`  Failed to create detection for ${key}: ${error.message ?? error}`)
    }

    // Rate limit
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }

  // Save updated state
  await updateState((s) => {
    s.meta ??= {}
    s.meta.detections = detections
  })

  return result
}

// --- Discord detection creation ---

export interface CreateDiscordDetectionsOptions {
  eligibleMessages: EligibleDiscordMessage[]
  targetRepo: string
  config: DispatchConfig
  dryRun: boolean
}

/**
 * Create detection issues for eligible Discord messages.
 * Detection issues are created in the help-bot repo so maintainers
 * can review and approve via reactions.
 */
export async function createDiscordDetections(options: CreateDiscordDetectionsOptions): Promise<CreateDetectionsResult> {
  const state = await loadState()
  const detections = getDetections(state)
  const postedResponses = getPostedDiscordResponses(state)

  const result: CreateDetectionsResult = {
    created: 0,
    skippedExisting: 0,
    skippedInvestigated: 0,
    skippedLimit: 0,
  }

  for (const msg of options.eligibleMessages) {
    const key = makeDiscordDetectionKey(
      msg.discord.guildName,
      msg.discord.channelName,
      msg.messageId,
    )

    // Skip if detection already exists
    if (detections[key]) {
      result.skippedExisting++
      continue
    }

    // Skip if already responded
    const responseKey = `discord:${msg.discord.guildName}/${msg.discord.channelName}#${msg.messageId}`
    if (postedResponses[responseKey]) {
      result.skippedInvestigated++
      continue
    }

    // Respect per-cycle limit
    if (result.created >= options.config.max_detections_per_cycle) {
      result.skippedLimit++
      continue
    }

    const channelDisplay = msg.discord.threadName
      ? `${msg.discord.channelName}/${msg.discord.threadName}`
      : msg.discord.channelName
    const title = `[Detection] discord/${msg.discord.guildName}/${channelDisplay}: ${sanitizeText(msg.title, 80)}`
    const labels = ['help-bot', 'detection', 'discord', msg.discord.channelName]
    const body = buildDiscordDetectionBody({
      guildName: msg.discord.guildName,
      channelName: msg.discord.channelName,
      messageId: msg.messageId,
      author: msg.author,
      content: msg.content,
      timestamp: msg.timestamp,
      threadName: msg.discord.threadName,
      isForumPost: msg.discord.isForumPost,
      dispatchMode: options.config.mode === 'countdown' ? 'countdown' : 'approval',
      warningsRequired: options.config.warnings_required,
      warningIntervalHours: options.config.warning_interval_hours,
      approveReactions: options.config.approve_reactions,
      cancelReactions: options.config.cancel_reactions,
    })

    if (options.dryRun) {
      console.log(`  DRY RUN: would create Discord detection for ${key}`)
      console.log(`    Title: ${title}`)
      recordStat('detectionsCreated')
      result.created++
      continue
    }

    try {
      const labelArgs = labels.flatMap((l) => ['--label', l])
      const { stdout } = await execFileAsync('gh', [
        'issue', 'create',
        '--repo', options.targetRepo,
        '--title', title,
        ...labelArgs,
        '--body', body,
      ])
      const createdUrl = stdout.trim()
      const createdNumber = Number(createdUrl.split('/').pop() ?? '0')
      console.log(`  Created Discord detection: ${createdUrl}`)

      const now = new Date().toISOString()
      const record: DetectionRecord = {
        detectionIssueNumber: createdNumber,
        sourceRepo: `discord:${msg.discord.guildName}/${msg.discord.channelName}`,
        sourceIssueNumber: 0,
        sourceType: 'discord',
        sourceMessageId: msg.messageId,
        sourceDiscordPath: `${msg.discord.guildName}/${msg.discord.channelName}`,
        status: 'pending',
        createdAt: now,
        currentStage: 0,
        stageAdvancedAt: now,
        warningsRequired: options.config.warnings_required,
        warningIntervalHours: options.config.warning_interval_hours,
      }

      detections[key] = record
      recordStat('detectionsCreated')
      result.created++
    } catch (error: any) {
      console.warn(`  Failed to create Discord detection for ${key}: ${error.message ?? error}`)
    }

    // Rate limit
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }

  // Save updated state
  await updateState((s) => {
    s.meta ??= {}
    s.meta.detections = detections
  })

  return result
}
