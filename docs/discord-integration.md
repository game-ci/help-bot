# Discord Integration

The bot monitors configured Discord channels (text, forum, announcement) and can reply directly via the Discord Bot API with chain-reply support.

## Supported Channel Types

| Type                 | Config Value                       | Behavior                                        |
| -------------------- | ---------------------------------- | ----------------------------------------------- |
| Text channel         | `"channel_type": "text"` (default) | Syncs messages, optionally reads threads        |
| Forum channel        | `"channel_type": "forum"`          | Syncs all forum post threads and their messages |
| Announcement channel | `"channel_type": "announcement"`   | Syncs messages like text channels               |

## Trigger Modes

Each channel can configure how messages enter the investigation pipeline:

| Mode              | Config Value                | Behavior                                                               |
| ----------------- | --------------------------- | ---------------------------------------------------------------------- |
| Mention (default) | `"trigger_mode": "mention"` | Only @mentions and replies to the bot trigger investigation            |
| All               | `"trigger_mode": "all"`     | All messages in the channel trigger investigation (no @mention needed) |

Use `trigger_mode: "all"` for dedicated help/support channels where every message is a potential help request. Use `trigger_mode: "mention"` (default) for general channels where the bot should only respond when explicitly asked.

All-trigger channels still respect all other filters (bot messages, command prefixes, min length, already-responded, dispatch gate).

## Reply Modes

Each channel can configure how the bot replies:

| Mode              | Config Value              | Behavior                                                                       |
| ----------------- | ------------------------- | ------------------------------------------------------------------------------ |
| Bot API (default) | `"reply_mode": "bot_api"` | Posts directly via Discord Bot API with `message_reference` for chain-replying |
| Thread            | `"reply_mode": "thread"`  | Creates a new thread for the response                                          |
| Webhook (legacy)  | `"reply_mode": "webhook"` | Posts via webhook URL (no reply chains)                                        |

## Discord Sync Enhancements

The sync module (`src/sync/discord.ts`) supports:

- **Forum channels**: Fetches active and recently archived threads from forum channels. Each forum post is a thread — all messages within are synced.
- **Thread reading**: For text channels with `"read_threads": true` (default), fetches active and archived threads and syncs their messages.
- **Reactions**: Message reactions are included in synced data as a `reactions` map (emoji name → count).
- **Reply context**: When a message is a reply, the referenced message's author, content, and ID are captured in the `referenced_message` field.
- **Thread context**: Forum post messages include the last 10 thread messages for context.

## Discord Filtering

`src/core/filter-discord.ts` filters synced Discord messages for eligible help requests:

- **Heuristic detection**: Uses keyword matching (question marks, error terms, help phrases) to identify likely help requests
- **Skip rules**: Filters out bot messages, too-short messages, messages from official users/roles, already-responded messages
- **Channel monitoring**: Only processes channels with `"monitor": true` in config

## Discord Dispatch

Discord messages go through the same dispatch approval pipeline as GitHub issues, with one critical difference: **Discord dispatch is NEVER automatic** by default. Even if the global dispatch mode is `"auto"`, Discord is forced to `"approval"` mode.

The `dispatch.discord_mode` config key controls the Discord-specific dispatch mode (default: `"approval"`). Detection issues for Discord messages are created in the help-bot repo with labels `help-bot`, `detection`, `discord`, and the channel name.

## Channel Configuration

```json
{
  "discord": {
    "guilds": [
      {
        "name": "game-ci",
        "guild_id": "710946343828455455",
        "triage_channel_id": "1488732220461158554",
        "webhook_url_env": "DISCORD_WEBHOOK_URL",
        "system_prompt": "Guild-level prompt applied to all channels.",
        "channels": [
          {
            "name": "help",
            "system_prompt": "Channel-specific prompt.",
            "channel_type": "text",
            "trigger_mode": "all",
            "reply_mode": "bot_api",
            "read_threads": true,
            "monitor": true
          },
          {
            "name": "unity-builder",
            "system_prompt": "Expert on unity-builder action.",
            "channel_type": "forum",
            "reply_mode": "bot_api",
            "monitor": true
          }
        ]
      }
    ]
  }
}
```

Channel config fields:

- `name` (required): Discord channel name
- `channel_id` (optional): Discord channel snowflake ID. When set, used for direct ID matching instead of name-based resolution.
- `system_prompt` (optional): Per-channel system prompt, appended to base + guild prompts
- `channel_type` (optional): `"text"` (default), `"forum"`, or `"announcement"`
- `trigger_mode` (optional): `"mention"` (default) or `"all"` — controls whether @mention is required
- `reply_mode` (optional): `"bot_api"` (default), `"thread"`, or `"webhook"`
- `read_threads` (optional): Whether to read threads in text channels (default: `true`)
- `monitor` (optional): Whether to monitor this channel for help requests (default: `true`)

## Per-Channel & Per-Label System Prompts

System prompts are layered from general to specific:

1. **Base prompt** (`discord.system_prompt`): Applied to all guilds and channels
2. **Guild prompt** (`guild.system_prompt`): Applied to all channels in a guild
3. **Channel prompt** (`channel.system_prompt`): Applied to a specific channel

All layers are concatenated with double newlines.

## Discord Response File Format

Discord response files go in `data/responses/discord/` with this frontmatter:

```markdown
---
response_id: discord-{guild}-{channel}-{messageId}
guild_name: game-ci
channel_name: help
channel_id: 123456789
reply_to_message_id: 987654321
thread_id: 111222333
title: 'Short description'
---

[Response body]
```

## Source Files

| File                         | Purpose                                                             |
| ---------------------------- | ------------------------------------------------------------------- |
| `src/sync/discord.ts`        | Discord sync — channels, forums, threads, reactions, reply context  |
| `src/post/discord.ts`        | Discord posting — Bot API, webhooks, thread creation, chain-replies |
| `src/core/filter-discord.ts` | Discord message filtering and manifest writing                      |
