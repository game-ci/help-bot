<img width="1536" height="1024" alt="GameCI Help Bot triage workflow — Discord embed with Investigate and Send buttons" src="https://github.com/user-attachments/assets/6ed2a212-06f3-4b68-99aa-f3923501e4be" />

# GameCI Help Bot

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![Discord](https://img.shields.io/badge/discord.js-v14-5865F2)](https://discord.js.org)

AI-powered community helper for [GameCI](https://game.ci). Monitors Discord channels and GitHub issues for help requests, investigates them with Claude (reading actual source code and documentation), and posts verified responses -- all under maintainer control.

## How it works

```
Discord message or GitHub issue detected
  → Hard-code filters (bots, duplicates, off-topic)
  → Triage notification posted to private admin channel
  → Maintainer clicks [Investigate]
  → Claude reads source code, docs, and related issues
  → Maintainer reviews AI response, optionally provides guidance
  → Maintainer clicks [Send Response]
  → Bot replies to the original message/issue
```

The bot never fabricates parameters or features. It verifies every suggestion against `action.yml` and source code before including it in a response. All LLM output goes to files first -- posting is a separate, gated step.

## Prerequisites

| Dependency | Purpose | Install |
|------------|---------|---------|
| **Node.js >= 18** | Runtime | [nodejs.org](https://nodejs.org) |
| **Claude Code CLI** | AI investigation engine | `npm install -g @anthropic-ai/claude-code` |
| **GitHub CLI** (`gh`) | GitHub issue sync and posting | [cli.github.com](https://cli.github.com) |
| **Discord bot application** | Bot token + gateway access | See [Discord setup](#discord-setup) below |

Environment variables:

| Variable | Required | Purpose |
|----------|----------|---------|
| `DISCORD_BOT_TOKEN` | Yes | Discord bot token (or use the built-in [keytar helper](docs/windows-secrets.md)) |
| `ANTHROPIC_API_KEY` | Yes | Claude API key for investigations |
| `GITHUB_TOKEN` | For GitHub sync | `gh auth login` sets this automatically |

## Quick start

```bash
# Clone and install
git clone https://github.com/game-ci/help-bot.git
cd help-bot
npm install

# Build the TypeScript
npm run build

# Set secrets
export DISCORD_BOT_TOKEN="your-bot-token"
export ANTHROPIC_API_KEY="your-api-key"

# Start the live bot with triage mode (recommended)
node dist/cli.js live --dispatch-mode triage

# Or install globally for the gameci-help-bot command
npm link
gameci-help-bot live --dispatch-mode triage
```

For a quick test without posting anything:

```bash
node dist/cli.js live --dispatch-mode triage --dry-run
```

## Discord setup

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and create a new application.
2. Under **Bot**, click "Add Bot" and copy the token.
3. Enable **Message Content Intent** under Bot > Privileged Gateway Intents. This is required for the bot to read message content.
4. Under **OAuth2 > URL Generator**, select scopes `bot` and `applications.commands`. For bot permissions, select: Send Messages, Read Message History, Embed Links, Use Slash Commands, Create Public Threads, Send Messages in Threads, Add Reactions.
5. Use the generated URL to invite the bot to your server.
6. Create a private channel (e.g., `#triage`) for maintainer notifications. Copy its channel ID (right-click > Copy Channel ID with Developer Mode enabled in Discord settings).

Then update `config.json` with your server details:

```json
{
  "discord": {
    "triage_user_ids": ["YOUR_DISCORD_USER_ID"],
    "guilds": [
      {
        "name": "your-server",
        "guild_id": "YOUR_GUILD_ID",
        "triage_channel_id": "YOUR_TRIAGE_CHANNEL_ID",
        "channels": [
          {
            "name": "help",
            "channel_type": "text",
            "reply_mode": "bot_api",
            "monitor": true
          }
        ]
      }
    ]
  }
}
```

To find your Discord user ID: enable Developer Mode in Discord settings (App Settings > Advanced > Developer Mode), then right-click your username and select "Copy User ID".

## Modes of operation

| Mode | Command | Description |
|------|---------|-------------|
| **Live** | `gameci-help-bot live` | Persistent Discord WebSocket. Responds in real-time. **Recommended.** |
| **Incremental** | `gameci-help-bot cycle` | One-shot: sync, investigate, post. For scheduled runs or CI. |
| **Continuous** | `gameci-help-bot continuous` | Loops every N minutes. For persistent deployments without WebSocket. |

### Live mode

Connects to Discord via the Gateway WebSocket, stays online, and processes help requests as they arrive. The bot sets its presence to "Watching N channels" so users can see it is active.

```bash
gameci-help-bot live --dispatch-mode triage    # maintainer-controlled via buttons (recommended)
gameci-help-bot live --dispatch-mode auto      # immediate response, no approval
gameci-help-bot live --dry-run                 # investigate but don't post
```

## Dispatch and triage

The dispatch system controls how help requests flow from detection to response. Four modes are available:

| Mode | Behavior |
|------|----------|
| **auto** | Investigate and respond immediately. Best for testing. |
| **approval** | Create detection issues in GitHub; wait for maintainer approval emoji. |
| **countdown** | Staged warnings, auto-dispatch after timeout (default: 72h). |
| **triage** | Interactive Discord buttons in a private admin channel. **Recommended for production.** |

### Triage mode

When a help request is detected, the bot posts a color-coded embed to your private `#triage` channel:

```
[Investigate] [Ignore]  -->  [Send Response] [View Investigation] [Re-investigate] [Discard]
```

After investigation, the full response is automatically posted to a thread on the triage embed so maintainers can review it before sending. Click **View Investigation** to see the bot's analysis and findings (source code references, verification proof, related issues). Reply in the thread with plain English guidance, then click **Re-investigate** to generate a new response incorporating your instructions.

Each re-investigation posts the updated response to the same thread, so the full history of iterations is visible.

Full details: [docs/dispatch.md](docs/dispatch.md)

## Security

The bot processes untrusted content from public Discord channels and GitHub issues. Six layers protect against prompt injection:

1. **Tool restriction** -- LLM can only Read, Glob, Grep, Bash, Write (no Edit, WebFetch, WebSearch)
2. **Pre-filtering** -- Ineligible content removed before LLM sees it
3. **Injection scanning** -- 17 regex patterns across 4 severity levels
4. **Prompt hardening** -- Explicit rules against following embedded instructions
5. **Output isolation** -- All LLM output goes to files first, posting is separate
6. **Dry run** -- `--dry-run` prevents all posting for operator review

```bash
gameci-help-bot security-test    # run 22 prompt injection test cases
gameci-help-bot security-scan    # scan synced issues for threats
```

Full details: [docs/security.md](docs/security.md)

## CLI reference

All commands can be run as `gameci-help-bot <command>` (if globally installed) or `node dist/cli.js <command>`.

| Command | Purpose |
|---------|---------|
| `live` | Persistent Discord Gateway bot. |
| `cycle` | Single sync + investigate + post run. |
| `continuous` | Loop indefinitely with configurable interval. |
| `sync-discord` | Refresh Discord data only. |
| `sync-github` | Refresh GitHub issues/PRs/discussions only. |
| `sync-docs` | Refresh documentation pages only. |
| `vector-bake` | Manage the optional LlamaIndex vector store. |
| `feedback mark-good\|mark-bad` | Tag a bot response for quality tracking. |
| `report summary` | Show cycle stats, feedback totals. |
| `security-test` | Run prompt injection test suite. |
| `security-scan <repo>` | Scan synced issues for injection patterns. |
| `review-quality` | Interactive LLM review of recent responses. |
| `review-security` | Interactive LLM security audit. |
| `nssm install\|start\|stop\|...` | Windows NSSM service management. |

### Common flags

| Flag | Description |
|------|-------------|
| `--dry-run` | Investigate but do not post responses. |
| `--repo-dir <path>` | Path to local repo clone for source verification during investigation. |
| `--docs-dir <path>` | Path to local documentation clone. |
| `--model <model>` | Override LLM model (e.g., `claude-opus-4-20250514`). |
| `--dispatch-mode <mode>` | Override dispatch mode (auto, approval, countdown, triage). |
| `--skip-sync` | Skip data sync, use existing files. |
| `--investigation-issues` | Create investigation issues in target repo. |

## Configuration

All configuration lives in `config.json`. The included config is set up for GameCI's servers -- you will need to customize it for your own Discord server and GitHub repos.

| Section | Controls |
|---------|----------|
| **bot** | Name, version, max responses per cycle, cooldown, interval. |
| **llm** | Provider selection, model, endpoint settings. |
| **discord** | Guilds, channels (type, reply mode, monitoring), system prompts, triage user IDs. |
| **github** | Repos to monitor, sync window, collaborators, per-label system prompts. |
| **dispatch** | Mode, warning intervals, approval/cancel emojis. |
| **investigations** | Investigation issue creation toggle, target repo, labels. |
| **notifications** | Discord DM notifications to maintainers. |

Key things to customize:
- `discord.guilds` -- Replace with your guild IDs, channel names, and triage channel ID
- `discord.triage_user_ids` -- Your Discord user IDs (snowflakes) for triage button access
- `github.repos` -- Your repos to monitor
- `github.collaborators` -- Your team's GitHub usernames (these users are excluded from bot responses)
- `llm.claude.model` -- The Claude model to use for investigations

System prompts are layered: base -> guild -> channel. GitHub issues also get per-label prompts (bug, macOS, docker, IL2CPP, etc.).

## LLM providers

The default provider is Claude Code, which requires the `claude` CLI to be installed globally.

| Provider | How it runs | Setup |
|----------|-------------|-------|
| **Claude Code** (default) | Spawns `claude -p --model <model>` with filesystem access. | `npm i -g @anthropic-ai/claude-code` + `ANTHROPIC_API_KEY` |
| **LM Studio** | HTTP to local server. Context injected via prompt. | Run LM Studio with a model loaded |
| **Continue CLI** | `continue --model <name>`. Interactive sessions. | Install Continue CLI |
| **Codex / OpenAI** | OpenAI API completions. | Set `LLM_PROVIDER=codex` + `OPENAI_API_KEY` |

## Deployment

### Docker

```bash
docker compose up -d
```

The Dockerfile uses `node:20-slim`, installs GitHub CLI and Claude Code, runs as non-root `botuser`, and persists `data/` via a named volume.

### Windows service (NSSM)

```bash
gameci-help-bot nssm install --mode live
gameci-help-bot nssm start
```

### GitHub Actions

The `.github/workflows/` directory includes workflows for scheduled help cycles and self-hosted runner support.

## Project structure

```
src/
  cli.ts              CLI entry point (yargs)
  config.ts           Configuration loading and system prompt building
  state.ts            State persistence (responses, triage records, detections)
  core/
    cycle.ts           Main sync -> filter -> LLM -> post pipeline
    continuous.ts      Loop with configurable interval
    live.ts            Persistent Discord Gateway client
    live-utils.ts      Help detection, topic relevance, prompt building
    filter-issues.ts   GitHub issue eligibility filtering
    filter-discord.ts  Discord message filtering
  triage/
    types.ts           TriageRecord, button ID helpers, guild shortname mapping
    notification.ts    Embed builder, button rows, post/update triage messages
    handler.ts         InteractionCreate handler, button routing, thread posting
    investigation.ts   Claude investigation wrapper, maintainer instruction fetching
    send.ts            Post approved responses to original source
  dispatch/
    orchestrator.ts    Dispatch pipeline entry point
    detection.ts       Creates detection issues
    approval.ts        Checks reactions, advances countdown stages
    lifecycle.ts       Post-dispatch cleanup
  sync/
    github.ts          GitHub API sync (issues, PRs, discussions)
    discord.ts         Discord API sync (channels, forums, threads)
    docs.ts            Documentation page sync
  post/
    github.ts          GitHub comment posting via gh CLI
    discord.ts         Discord Bot API posting, webhooks, threads
  security/
    sanitizer.ts       Prompt injection pattern scanning
    tests.ts           Security test suite
  feedback/
    sync.ts            Reaction-based feedback polling
    manual.ts          CLI mark-good/mark-bad

docs/                  Detailed documentation (see below)
automation/            Shell scripts for sync, posting, service management
.claude/agents/        Agent definitions (github-triage, discord-responder, docs-searcher)
data/                  Runtime data directory (auto-created, gitignored)
```

## Documentation

| Document | Topic |
|----------|-------|
| [docs/dispatch.md](docs/dispatch.md) | Dispatch system, triage mode, detection issues, approval workflows |
| [docs/security.md](docs/security.md) | Security layers, injection scanning, source verification |
| [docs/sync-and-state.md](docs/sync-and-state.md) | Sync coverage, cursor files, overrides, contributor filters |
| [docs/vector-knowledge.md](docs/vector-knowledge.md) | LlamaIndex bake/query/clean, vector search |
| [docs/feedback-reporting.md](docs/feedback-reporting.md) | Feedback workflow, report output fields |
| [docs/windows-secrets.md](docs/windows-secrets.md) | Secure Discord token helper (keytar, DPAPI/keychain) |
| [CLAUDE.md](CLAUDE.md) | Bot behavior rules, tone, security constraints, response quality standards |

## Contributing

Contributions are welcome. Please open an issue first to discuss what you would like to change.

1. Fork the repo and create a branch from `main`
2. Run `npm install` and `npm run build` to verify the build
3. Make your changes
4. Test with `--dry-run` to verify behavior without posting
5. Open a pull request

## License

[MIT](LICENSE)
