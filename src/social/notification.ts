import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type TextChannel,
  type Message,
} from 'discord.js'
import { type ContentStatus, type SocialAction, buildSocialButtonId } from './types'

const STATUS_COLORS: Record<ContentStatus, number> = {
  topic_received: 0xffa500, // orange
  drafting: 0x3498db,       // blue
  draft_ready: 0x2ecc71,    // green
  revising: 0x3498db,       // blue
  approved: 0x9b59b6,       // purple
  committed: 0x95a5a6,      // gray
  discarded: 0x7f8c8d,      // dark gray
}

export interface ContentEmbedOptions {
  platform: string
  topic: string
  requestedBy: string
  status: ContentStatus
  draftPreview?: string
  revisionCount?: number
  approvedBy?: string
  committedFile?: string
  commitSha?: string
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.substring(0, max - 3) + '...'
}

export function buildContentEmbed(options: ContentEmbedOptions): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(STATUS_COLORS[options.status])
    .setTimestamp()

  const statusLabel = options.status.toUpperCase().replace(/_/g, ' ')
  embed.setTitle(`[${statusLabel}] ${options.platform}: ${truncate(options.topic, 200)}`)
  embed.setDescription(truncate(options.topic, 4000))

  embed.addFields(
    { name: 'Requested by', value: options.requestedBy, inline: true },
    { name: 'Platform', value: options.platform, inline: true },
  )

  if (options.revisionCount && options.revisionCount > 0) {
    embed.addFields({ name: 'Revisions', value: String(options.revisionCount), inline: true })
  }

  if ((options.status === 'draft_ready' || options.status === 'approved') && options.draftPreview) {
    embed.addFields({ name: 'Draft Preview', value: truncate(options.draftPreview, 1024) })
  }

  if (options.committedFile && options.commitSha) {
    embed.addFields({ name: 'Committed', value: `\`${options.commitSha}\` — ${options.committedFile}` })
  }

  const footerParts: string[] = []
  if (options.approvedBy) {
    footerParts.push(`Approved by ${options.approvedBy}`)
  }
  if (footerParts.length > 0) {
    embed.setFooter({ text: footerParts.join(' | ') })
  }

  return embed
}

export function buildContentButtons(
  status: ContentStatus,
  contentId: string,
): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>()

  const btn = (action: SocialAction, label: string, style: ButtonStyle, disabled = false) =>
    new ButtonBuilder()
      .setCustomId(buildSocialButtonId(action, contentId))
      .setLabel(label)
      .setStyle(style)
      .setDisabled(disabled)

  switch (status) {
    case 'topic_received':
      row.addComponents(
        btn('draft', 'Draft Content', ButtonStyle.Primary),
        btn('discard', 'Discard', ButtonStyle.Danger),
      )
      break

    case 'drafting':
      row.addComponents(
        btn('draft', 'Drafting...', ButtonStyle.Primary, true),
        btn('discard', 'Discard', ButtonStyle.Danger),
      )
      break

    case 'draft_ready':
      row.addComponents(
        btn('approve', 'Approve', ButtonStyle.Success),
        btn('revise', 'Revise', ButtonStyle.Primary),
        btn('view', 'View Full', ButtonStyle.Secondary),
        btn('discard', 'Discard', ButtonStyle.Danger),
      )
      break

    case 'revising':
      row.addComponents(
        btn('revise', 'Revising...', ButtonStyle.Primary, true),
        btn('discard', 'Discard', ButtonStyle.Danger),
      )
      break

    case 'approved':
      row.addComponents(
        btn('commit', 'Commit & Push', ButtonStyle.Success),
        btn('revise', 'Revise', ButtonStyle.Primary),
        btn('discard', 'Discard', ButtonStyle.Danger),
      )
      break

    case 'committed':
      row.addComponents(
        new ButtonBuilder()
          .setCustomId('social|noop|committed')
          .setLabel('Committed')
          .setStyle(ButtonStyle.Success)
          .setDisabled(true),
      )
      break

    case 'discarded':
      row.addComponents(
        new ButtonBuilder()
          .setCustomId('social|noop|discarded')
          .setLabel('Discarded')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
      )
      break
  }

  return [row]
}

export async function postContentNotification(
  channel: TextChannel,
  embedOptions: ContentEmbedOptions,
  contentId: string,
): Promise<Message> {
  const embed = buildContentEmbed(embedOptions)
  const components = buildContentButtons(embedOptions.status, contentId)
  return channel.send({ embeds: [embed], components })
}

export async function updateContentNotification(
  channel: TextChannel,
  messageId: string,
  embedOptions: ContentEmbedOptions,
  contentId: string,
): Promise<void> {
  try {
    const msg = await channel.messages.fetch(messageId)
    const embed = buildContentEmbed(embedOptions)
    const components = buildContentButtons(embedOptions.status, contentId)
    await msg.edit({ embeds: [embed], components })
  } catch (err: any) {
    console.warn(`  Failed to update content notification ${messageId}: ${err.message ?? err}`)
  }
}
