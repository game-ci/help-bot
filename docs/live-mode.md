# Live Mode

The `live` command connects to Discord via the Gateway WebSocket and stays online permanently. Status keeps SHA, online age, and update age fixed, then rotates the final banner between answered counters and monitored channel count. When a help request arrives, the bot investigates immediately and replies in-channel.

## Usage

```bash
# Auto mode — immediate investigation and response
gameci-help-bot live --dispatch-mode auto

# Dry run — investigate but don't post
gameci-help-bot live --dispatch-mode auto --dry-run

# With repo dir for source code search during investigation
gameci-help-bot live --dispatch-mode auto --repo-dir /path/to/unity-builder

# Override model
gameci-help-bot live --dispatch-mode auto --model claude-opus-4-20250514
```

## Options

| Flag              | Description                                                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `--dispatch-mode` | `auto` (immediate), `approval` (defer to cycle), `countdown` (defer to cycle). Default: `dispatch.discord_mode` from config. |
| `--repo-dir`      | Path to local clone of target repo for source code search during investigation.                                              |
| `--docs-dir`      | Path to local documentation clone.                                                                                           |
| `--model`         | Override LLM model.                                                                                                          |
| `--dry-run`       | Investigate but do not post responses to Discord.                                                                            |

## Message Processing Pipeline

1. **Gateway filter**: Skip DMs, unconfigured guilds, unmonitored channels, bot messages, command prefixes, too-short messages.
2. **Trigger mode check**: Channels with `trigger_mode: "all"` process all messages. Channels with `trigger_mode: "mention"` (default) require @mention or reply-to-bot.
3. **Topic relevance check**: Verify the message is about GameCI/CI/CD/Unity/Docker/build topics. Reject off-topic messages and security probes.
4. **Duplicate check**: Skip if already responded (tracked in `state.json`).
5. **Dispatch gate**:
   - `auto`: Investigate immediately via Claude and post response.
   - `triage`: Post notification to admin channel with Investigate/Ignore buttons.
   - `approval`/`countdown`: Log the detection and defer to the cycle-based approval system.
6. **Investigation**: Spawn Claude with a focused single-message prompt. Claude searches synced data, optional repo/docs directories, and writes a response file.
7. **Post response**: Reply directly to the message in Discord via Bot API.

## Terminal Output

```
GameCI Help Bot v3.0.0 — Live Mode
══════════════════════════════════════════════════
  Dispatch mode: auto
  Model: claude-sonnet-4-20250514

Connecting to Discord...
  ✓ Logged in as GameCI Help Bot#1234

Guilds:
  ⚠ game-ci — bot not in this server (invite needed)
  ✓ game-ci-develop — monitoring: #help, #help-develop, #general

Ready. Listening for messages...
──────────────────────────────────────────────────
[12:34:56] #help @user123: How do I set up IL2CPP builds?
  → Help request detected.
  → Investigating...
  → LLM running (claude-sonnet-4-20250514)...
  → Response ready (487 chars). Posting...
  ✓ Response posted to #help (reply to @user123)
```

## Requirements

- `DISCORD_BOT_TOKEN` environment variable (or stored via keytar)
- **Message Content Intent** must be enabled in the [Discord Developer Portal](https://discord.com/developers/applications) → Bot → Privileged Gateway Intents → Message Content Intent

## Protecting the bot token

Every gateway login is an IDENTIFY. Discord resets a bot's token after about 1000 of them in a day, so a supervisor restarting a crashing bot can lose the token within minutes. Three layers prevent that:

- **Contained failures**: event handlers, unhandled rejections and client `error` events are logged; they never exit the process.
- **Login backoff**: each login is recorded in `logs/gateway-logins.json`. After two logins within an hour, the next waits 30 s, doubling up to 15 min, so a crash loop stays near 100 logins a day.
- **Fatal exit code**: a rejected token, missing token or disallowed intent exits with code `78`. The NSSM service stops on `78` instead of restarting, and waits 30 s before restarting after any other exit.

After replacing the token, start the service again (`gameci-help-bot nssm start`).

## Topic Relevance & Security Filter

The live mode includes a topic relevance check (`checkTopicRelevance()` in `live-utils.ts`) that runs after help request detection:

- **Security probe rejection**: Messages asking about the bot's host, infrastructure, system prompts, or containing prompt injection patterns are rejected with "security probe detected".
- **Off-topic rejection**: Messages without any GameCI/CI/CD/Unity/Docker/build keywords are rejected with "off-topic".
- **On-topic messages**: Must contain at least one relevant keyword to proceed to investigation.

## Source Files

| File                               | Purpose                                                                     |
| ---------------------------------- | --------------------------------------------------------------------------- |
| `src/core/live.ts`                 | Main live bot — Gateway client, message handler, investigation, posting     |
| `src/core/live-utils.ts`           | Help request detection, topic relevance filter, prompt building, formatting |
| `src/core/gateway-login-ledger.ts` | Persisted gateway login history and the backoff before each login           |
| `src/core/gateway-resilience.ts`   | Guarded handlers, gateway logging, fatal exit code                          |
