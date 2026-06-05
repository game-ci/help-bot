// Export config functions from the main config module and new config-repo consumer

export {
  getConfig,
  reloadConfig,
  saveConfig,
  getValue,
} from './config'

export type { ChannelConfig, GuildConfig, LabelPromptConfig } from './config'

// Re-export config repo consumer functions
export {
  loadLocalConfig,
  loadRemoteConfig,
  mergeConfigs,
  getEffectiveConfig,
  saveMergedConfig,
  validateConfig,
} from './config-repo'

export type { ConfigRepoSettings } from './config-repo'
