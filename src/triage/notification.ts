import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type TextChannel,
  type Message,
} from 'discord.js'
import { type TriageStatus, type TriageAction, buildButtonId } from './types'

/** Status-dependent embed colors */
const STATUS_COLORS: Record<TriageStatus, number> = {
  pending: 0xffa500, // orange
  investigating: 0x3498db, // blue
  ready: 0x2ecc71, // green
  sent: 0x95a5a6, // gray
  ignored: 0x7f8c8d, // dark gray
}

export interface TriageEmbedOptions {
  /** Source type: discord or github */
  sourceType: 'd' | 'g'
  /** Short title */
  title: string
  /** Full content of the help request */
  content: string
  /** Author name/tag */
  author: string
  /** Discord-specific fields */
  guildName?: string
  guildId?: string
  channelName?: string
  channelId?: string
  messageId?: string
  /** GitHub-specific fields */
  repo?: string
  issueNumber?: number
  labels?: string[]
  /** Current triage status */
  status: TriageStatus
  /** Who investigated */
  investigatedBy?: string
  /** Preview of the generated response (shown when status=ready) */
  responsePreview?: string
  /** Reinvestigation count */
  reinvestigationCount?: number
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.substring(0, max - 3) + '...'
}

/**
 * Build a triage embed for the admin channel.
 */
export function buildTriageEmbed(options: TriageEmbedOptions): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(STATUS_COLORS[options.status])
    .setTimestamp()

  const statusLabel = options.status.toUpperCase()

  if (options.sourceType === 'd') {
    embed.setTitle(`[${statusLabel}] #${options.channelName}: ${truncate(options.title, 200)}`)
    if (options.guildId && options.channelId && options.messageId) {
      embed.setURL(`https://discord.com/channels/${options.guildId}/${options.channelId}/${options.messageId}`)
    }
  } else {
    const title = `[${statusLabel}] ${options.repo}#${options.issueNumber}: ${truncate(options.title, 150)}`
    embed.setTitle(title)
    if (options.repo && options.issueNumber) {
      embed.setURL(`https://github.com/${options.repo}/issues/${options.issueNumber}`)
    }
  }

  embed.setDescription(truncate(options.content, 4000))

  embed.addFields({ name: 'Author', value: options.author, inline: true })

  if (options.sourceType === 'd') {
    embed.addFields(
      { name: 'Channel', value: `#${options.channelName ?? 'unknown'}`, inline: true },
      { name: 'Guild', value: options.guildName ?? 'unknown', inline: true },
    )
  } else {
    embed.addFields({ name: 'Repo', value: options.repo ?? 'unknown', inline: true })
    if (options.labels && options.labels.length > 0) {
      embed.addFields({ name: 'Labels', value: options.labels.join(', '), inline: true })
    }
  }

  if (options.status === 'ready' && options.responsePreview) {
    embed.addFields({ name: 'Response Preview', value: truncate(options.responsePreview, 1024) })
  }

  const footerParts: string[] = []
  if (options.investigatedBy) {
    footerParts.push(`Investigated by ${options.investigatedBy}`)
  }
  if (options.reinvestigationCount && options.reinvestigationCount > 0) {
    footerParts.push(`Re-investigated ${options.reinvestigationCount}x`)
  }
  if (footerParts.length > 0) {
    embed.setFooter({ text: footerParts.join(' | ') })
  }

  return embed
}

/**
 * Build button action rows based on current triage status.
 */
export function buildTriageButtons(
  status: TriageStatus,
  sourceType: 'd' | 'g',
  compactId: string,
): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>()

  switch (status) {
    case 'pending':
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(buildButtonId('investigate', sourceType, compactId))
          .setLabel('Investigate')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(buildButtonId('ignore', sourceType, compactId))
          .setLabel('Ignore')
          .setStyle(ButtonStyle.Danger),
      )
      break

    case 'investigating':
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(buildButtonId('investigate', sourceType, compactId))
          .setLabel('Investigating...')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId(buildButtonId('ignore', sourceType, compactId))
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Danger),
      )
      break

    case 'ready':
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(buildButtonId('send', sourceType, compactId))
          .setLabel('Send Response')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(buildButtonId('view', sourceType, compactId))
          .setLabel('View Investigation')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(buildButtonId('reinvestigate', sourceType, compactId))
          .setLabel('Re-investigate')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(buildButtonId('ignore', sourceType, compactId))
          .setLabel('Discard')
          .setStyle(ButtonStyle.Danger),
      )
      break

    case 'sent':
      row.addComponents(
        new ButtonBuilder()
          .setCustomId('triage|noop|x|sent')
          .setLabel('Sent')
          .setStyle(ButtonStyle.Success)
          .setDisabled(true),
      )
      break

    case 'ignored':
      row.addComponents(
        new ButtonBuilder()
          .setCustomId('triage|noop|x|ignored')
          .setLabel('Ignored')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
      )
      break
  }

  return [row]
}

/**
 * Post a new triage notification to the admin channel.
 */
export async function postTriageNotification(
  channel: TextChannel,
  embedOptions: TriageEmbedOptions,
  sourceType: 'd' | 'g',
  compactId: string,
): Promise<Message> {
  const embed = buildTriageEmbed(embedOptions)
  const components = buildTriageButtons(embedOptions.status, sourceType, compactId)

  return channel.send({
    embeds: [embed],
    components,
  })
}

/**
 * Update an existing triage notification with new status/embed.
 */
export async function updateTriageNotification(
  channel: TextChannel,
  messageId: string,
  embedOptions: TriageEmbedOptions,
  sourceType: 'd' | 'g',
  compactId: string,
): Promise<void> {
  try {
    const msg = await channel.messages.fetch(messageId)
    const embed = buildTriageEmbed(embedOptions)
    const components = buildTriageButtons(embedOptions.status, sourceType, compactId)

    await msg.edit({
      embeds: [embed],
      components,
    })
  } catch (err: any) {
    console.warn(`  Failed to update triage notification ${messageId}: ${err.message ?? err}`)
  }
}
