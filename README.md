# GameCI Help Bot

AI-powered community support bot for [GameCI](https://game.ci), built on [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

This bot monitors GameCI's Discord server and GitHub repositories, drafts helpful responses to community questions about Unity CI/CD, and posts them back. It replaces the [original LlamaIndex-based scaffold](https://github.com/game-ci/help-bot/pull/1) with a simpler approach: Claude Code running in a well-defined workspace.

## How It Works

There is no custom bot framework, no vector store, and no RAG pipeline. The bot is Claude Code running periodically (`claude -p`) in a repository that defines its identity, knowledge, and data layout.

```
Architecture
============

  Discord API        GitHub API        game.ci/docs
       |                  |                  |
       v                  v                  v
  +-----------+    +-----------+    +-----------+
  | sync-     |    | sync-     |    | sync-     |
  | discord   |    | github    |    | docs      |
  +-----------+    +-----------+    +-----------+
       |                  |                  |
       v                  v                  v
  +------------------------------------------------+
  |              data/ (filesystem)                 |
  |                                                |
  |  discord/channels/{channel}/{date}.jsonl       |
  |  github/issues/{repo}/{number}.md              |
  |  docs/{page}.md                                |
  +------------------------------------------------+
                         |
                         v
  +------------------------------------------------+
  |           claude -p (Claude Code)              |
  |                                                |
  |  Reads: CLAUDE.md (identity, rules, scope)     |
  |  Reads: data/ (synced community content)       |
  |  Agents: discord-responder, github-triage,     |
  |          docs-searcher                         |
  |  Writes: data/responses/                       |
  +------------------------------------------------+
                         |
                         v
  +------------------------------------------------+
  |              Post responses                    |
  |                                                |
  |  Discord: via webhook (post-discord.sh)        |
  |  GitHub:  manual review / gh CLI (planned)     |
  +------------------------------------------------+
```

The core insight: Claude Code already knows how to read files, search for information, follow instructions, and write structured output. By syncing community data to the filesystem and defining clear rules in `CLAUDE.md`, we get a capable help bot without building any custom infrastructure.

## Repository Structure

```
CLAUDE.md                          # Bot identity, rules, knowledge scope
.claude/agents/
  discord-responder.md             # Discord response specialist
  github-triage.md                 # GitHub issue triage specialist
  docs-searcher.md                 # Documentation search (support agent)
automation/
  sync-discord.sh                  # Sync Discord messages to filesystem
  sync-github.sh                   # Sync GitHub issues/discussions
  sync-docs.sh                     # Download game.ci/docs pages
  post-discord.sh                  # Post response via Discord webhook
  run-help-cycle.sh                # Orchestrator (sync -> process -> post)
.github/workflows/
  help-cycle.yml                   # Scheduled GitHub Actions workflow
data/
  discord/                         # Synced Discord messages
  github/issues/                   # Synced GitHub issues
  github/discussions/              # Synced GitHub discussions
  docs/                            # Synced documentation pages
  responses/discord/               # Drafted Discord responses
  responses/github/                # Drafted GitHub responses
```

## Setup

### Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and available as `claude` in PATH
- [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated
- `python3` and `curl` available
- A Discord bot token with `MESSAGE_CONTENT` intent
- A Discord webhook URL for the response channel
- An Anthropic API key

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_BOT_TOKEN` | Yes | Discord bot token for reading messages |
| `DISCORD_GUILD_ID` | Yes | Discord server (guild) ID |
| `DISCORD_WEBHOOK_URL` | Yes | Discord webhook URL for posting responses |
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for Claude |
| `SYNC_HOURS` | No | Hours of Discord history to sync (default: 24) |
| `SYNC_DAYS` | No | Days of GitHub history to sync (default: 7) |
| `DRY_RUN` | No | Set to `true` to skip posting (default: false) |
| `CLAUDE_MODEL` | No | Claude model to use (default: claude-sonnet-4-20250514) |

### Running Manually

```bash
# Set environment variables
export DISCORD_BOT_TOKEN="your-bot-token"
export DISCORD_GUILD_ID="your-guild-id"
export DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..."
export ANTHROPIC_API_KEY="your-api-key"

# Run a full help cycle
bash automation/run-help-cycle.sh

# Dry run (process but don't post)
DRY_RUN=true bash automation/run-help-cycle.sh

# Sync only (no Claude processing)
bash automation/sync-discord.sh
bash automation/sync-github.sh
bash automation/sync-docs.sh
```

### Running via GitHub Actions

The help cycle runs automatically every 30 minutes via the `help-cycle.yml` workflow. Configure the required secrets in your repository settings:

1. Go to Settings > Secrets and variables > Actions
2. Add `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_WEBHOOK_URL`, and `ANTHROPIC_API_KEY`
3. The workflow uses a self-hosted runner — ensure one is configured with Claude Code installed

You can also trigger a run manually from the Actions tab with optional parameters (dry run, sync window).

## Background

This is the v2 approach to the GameCI help bot. The [original PR #1](https://github.com/game-ci/help-bot/pull/1) scaffolded a LlamaIndex-based solution with a vector store and RAG pipeline. This version takes a different approach: instead of building custom infrastructure around an LLM, it uses Claude Code directly as the bot runtime. The `CLAUDE.md` file and agent definitions provide all the structure needed.

The trade-off: this approach is simpler to maintain and extend (just edit markdown files), but requires Claude Code to be available on the runner. It also means the bot's capabilities grow automatically as Claude Code improves.

## License

[MIT](LICENSE) -- Copyright GameCI Contributors
