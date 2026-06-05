import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Configuration repo consumer module.
 * Allows the help-bot to consume configuration from a remote repository branch.
 */

export interface ConfigRepoSettings {
  /** Repository owner/repo path (e.g., 'game-ci/help-bot-config') */
  repo: string
  /** GitHub token for authentication */
  githubToken: string
  /** Branch to fetch config from */
  branch?: string
  /** Auto-merge enabled flag */
  autoMergeEnabled?: boolean
}

export interface ConfigRepoConfig {
  bot?: {
    name?: string
    version?: string
    max_responses_per_cycle?: number
    response_cooldown_minutes?: number
    dry_run?: boolean
    cycle_interval_minutes?: number
  }
  llm?: {
    provider?: string
    claude?: {
      model?: string
      investigation_model?: string
      max_turns?: number
      command?: string
    }
    lm_studio?: {
      base_url?: string
      model?: string
      api_key?: string
    }
    continue_cli?: {
      command?: string
      model?: string
    }
    codex?: {
      model?: string
      temperature?: number
      max_tokens?: number
      api_base?: string
    }
    discord?: {
      enabled?: boolean
      session_label?: string
      model?: string
      timeout_seconds?: number
      workspace_path?: string | null
    }
  }
  discord?: {
    system_prompt?: string
    guilds?: Array<{
      name: string
      guild_id?: string
      guild_id_env?: string
      triage_channel_id?: string
      webhook_url?: string
      webhook_url_env?: string
      channels: Array<{
        name: string
        channel_id?: string
        system_prompt?: string
        channel_type?: 'text' | 'forum' | 'announcement'
        reply_mode?: 'bot_api' | 'thread' | 'webhook'
        read_threads?: boolean
        monitor?: boolean
        trigger_mode?: 'mention' | 'all'
      }>
    }>
  }
  github?: {
    repos?: string[]
    sync_days?: number
    max_issues_per_repo?: number
    max_discussions_per_repo?: number
    skip_labels?: string[]
    priority_labels?: string[]
    collaborators?: string[]
    label_prompts?: Array<{
      label: string
      system_prompt: string
    }>
  }
  docs?: {
    base_url?: string
    pages?: string[]
  }
  vector_search?: {
    enabled?: boolean
    engine?: string
    collection_name?: string
    embedding_model?: string
    persist_directory?: string
  }
  social?: {
    enabled?: boolean
    post_channel_id?: string
    content_dir?: string
    platforms?: string[]
  }
}

/**
 * Load configuration from a local file.
 */
export async function loadLocalConfig(
  configPath: string = join(process.cwd(), 'config.json')
): Promise<ConfigRepoConfig> {
  try {
    const content = await readFile(configPath, 'utf-8')
    return JSON.parse(content) as ConfigRepoConfig
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error)
    if (msg.includes('ENOENT')) {
      console.warn(`Config file not found: ${configPath}. Using empty config.`)
    } else {
      throw new Error(`Failed to load local config: ${msg}`)
    }
  }
}

/**
 * Load configuration from a remote repository branch.
 */
export async function loadRemoteConfig(
  owner: string,
  repoName: string,
  token: string,
  branch: string = 'main'
): Promise<ConfigRepoConfig | null> {
  // Use GitHub REST API to fetch config.json from remote
  const apiPath = 'https://api.github.com/repos/' + owner + '/' + repoName + '/contents/config.json?ref=' + branch
  
  try {
    const response = await fetch(apiPath, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    })

    if (!response.ok) {
      throw new Error(`Failed to fetch config from remote. Status: ${response.status}`)
    }

    const data = await response.json()
    const content = Buffer.from(data.content, 'base64').toString('utf-8')
    
    try {
      return JSON.parse(content) as ConfigRepoConfig
    } catch (error: unknown) {
      throw new Error(`Invalid JSON in remote config. ${error}`)
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error)
    
    // Handle common errors gracefully
    if (msg.includes('Not Found') || msg.includes('resource_not_found')) {
      console.warn(`Config not found at remote path. Using local config.`)
      return null
    } else if (msg.includes('rate limit')) {
      throw new Error('Rate limited by GitHub API. Please wait or increase rate limit.')
    }
    
    console.warn(`Failed to load remote config: ${msg}`)
    return null
  }
}

/**
 * Merge remote config with local config (remote takes precedence).
 */
export async function mergeConfigs(
  localConfig: ConfigRepoConfig,
  remoteConfig: ConfigRepoConfig | null,
  configRepoSettings?: ConfigRepoSettings
): Promise<ConfigRepoConfig> {
  // If remote config exists and auto-merge is enabled, use it
  if (remoteConfig && configRepoSettings?.autoMergeEnabled) {
    console.log(`Using remote configuration from ${configRepoSettings.repo}:${configRepoSettings.branch}`)
    return remoteConfig
  }

  // Otherwise merge with local taking precedence where defined
  const merged = { ...localConfig }

  if (remoteConfig) {
    for (const key of Object.keys(remoteConfig)) {
      const remoteKey = key as keyof ConfigRepoConfig
      if (key === 'discord' && !merged.discord) {
        merged[key] = remoteConfig[key]
      } else if (!merged[key]) {
        merged[key] = remoteConfig[key]
      }
    }
  }

  return merged
}

/**
 * Get the effective configuration (local or remote merged).
 */
export async function getEffectiveConfig(
  configPath: string = join(process.cwd(), 'config.json'),
  configRepoSettings?: ConfigRepoSettings,
  defaultConfigPath?: string
): Promise<ConfigRepoConfig> {
  // Load local config as fallback
  const localConfig = await loadLocalConfig(configPath)

  // If no remote settings specified, return local config
  if (!configRepoSettings?.repo) {
    return localConfig
  }

  // Fetch and merge with remote config
  const remoteConfig = await loadRemoteConfig(
    configRepoSettings.repo.split('/')[0],
    configRepoSettings.repo.split('/')[1],
    configRepoSettings.githubToken,
    configRepoSettings.branch || 'main'
  )

  return mergeConfigs(localConfig, remoteConfig, configRepoSettings)
}

/**
 * Save merged configuration to file.
 */
export async function saveMergedConfig(
  config: ConfigRepoConfig,
  path: string = join(process.cwd(), 'config.json')
): Promise<void> {
  await mkdir(join(path), { recursive: true }).catch(() => {})
  await writeFile(path, JSON.stringify(config, null, 2) + '\n', 'utf-8')
}

/**
 * Validate configuration structure.
 */
export function validateConfig(config: ConfigRepoConfig): { valid: boolean; issues?: string[] } {
  const issues: string[] = []

  // Check required Discord fields
  if (!config.discord?.system_prompt) {
    issues.push('Missing discord.system_prompt')
  }

  // Check GitHub repos field
  if (!config.github?.repos || config.github.repos.length === 0) {
    issues.push('Missing or empty github.repos')
  }

  // Check for sensitive data in public-facing configs
  if (config.notifications?.discord_dm?.recipients && config.notifications.discord_dm.recipients.length > 0) {
    issues.push('Discord DM recipients should not be in public configs')
  }

  return {
    valid: issues.length === 0,
    issues,
  }
}
