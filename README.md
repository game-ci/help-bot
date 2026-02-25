# GameCI Help Bot

AI-powered community support bot for [GameCI](https://game.ci), built on [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

This bot monitors GameCI's Discord server and GitHub repositories, identifies questions about Unity CI/CD, drafts helpful responses grounded in documentation, and posts them back. It uses Claude Code as its runtime -- no custom framework, no vector store, no RAG pipeline.

## How It Works

The bot runs a **sync-reason-respond** cycle every 30 minutes:

```
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
  |                                                 |
  |  discord/channels/{channel}/{date}.jsonl        |
  |  github/issues/{repo}/{number}.md               |
  |  docs/{page}.md                                 |
  +------------------------------------------------+
                         |
                         v
  +------------------------------------------------+
  |           claude -p (Claude Code)               |
  |                                                 |
  |  Reads: CLAUDE.md (identity, rules, scope)      |
  |  Reads: config.json (tunable settings)          |
  |  Reads: data/ (synced community content)        |
  |  Agents: discord-responder, github-triage,      |
  |          docs-searcher                          |
  |  Writes: data/responses/                        |
  +------------------------------------------------+
                         |
                         v
  +------------------------------------------------+
  |              Post responses                     |
  |                                                 |
  |  Discord: via webhook (post-discord.sh)         |
  |  GitHub:  via gh CLI (gh issue comment)         |
  +------------------------------------------------+
```

**The core insight:** Claude Code already knows how to read files, search for information, follow instructions, and write structured output. By syncing community data to the filesystem and defining clear rules in `CLAUDE.md`, we get a capable help bot without building any custom infrastructure.

## Architecture: Claude Code Agent Swarm

Instead of building a traditional bot with a database, embeddings, and retrieval pipelines, this bot is simply Claude Code running in a well-structured workspace:

- **`CLAUDE.md`** defines the bot's identity, knowledge scope, response guidelines, and data layout. This is the "brain" -- edit this file to change behavior.
- **`config.json`** contains tunable settings: which channels to monitor, which repos to watch, response limits.
- **`.claude/agents/`** contains specialized agent definitions for Discord responses, GitHub triage, and documentation search.
- **`automation/`** contains shell scripts that sync data and post responses.
- **`data/`** is the ephemeral workspace where synced data lives during a cycle.

Behavior changes are markdown edits. No code changes required.

## Repository Structure

```
CLAUDE.md                              # Bot identity, rules, knowledge scope
config.json                            # Configurable settings
.claude/agents/
  discord-responder.md                 # Discord response specialist
  github-triage.md                     # GitHub issue triage specialist
  docs-searcher.md                     # Documentation search support agent
automation/
  sync-discord.sh                      # Sync Discord messages to filesystem
  sync-github.sh                       # Sync GitHub issues and discussions
  sync-docs.sh                         # Download game.ci/docs pages
  post-discord.sh                      # Post response via Discord webhook
  run-help-cycle.sh                    # Orchestrator (sync -> process -> post)
.github/workflows/
  help-cycle.yml                       # Scheduled GitHub Actions workflow
data/
  discord/channels/                    # Synced Discord messages (JSONL)
  github/issues/                       # Synced GitHub issues (Markdown + YAML)
  github/discussions/                  # Synced GitHub discussions
  docs/                                # Synced documentation pages (Markdown)
  responses/discord/                   # Drafted Discord responses
  responses/github/                    # Drafted GitHub responses
  logs/                                # Cycle execution logs
```

## Setup

### Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed (`npm install -g @anthropic-ai/claude-code`)
- [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated
- `python3` and `curl` available
- A Discord bot token with `MESSAGE_CONTENT` intent and channel read permissions
- A Discord webhook URL for the response channel
- An Anthropic API key

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_BOT_TOKEN` | Yes | Discord bot token for reading messages |
| `DISCORD_GUILD_ID` | Yes | Discord server (guild) ID |
| `DISCORD_WEBHOOK_URL` | Yes | Discord webhook URL for posting responses |
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for Claude Code |
| `SYNC_HOURS` | No | Hours of Discord history to sync (default: 6) |
| `SYNC_DAYS` | No | Days of GitHub history to sync (default: 7) |
| `DRY_RUN` | No | Set to `true` to draft but not post (default: `false`) |
| `SKIP_SYNC` | No | Set to `true` to skip syncing (default: `false`) |
| `SKIP_GITHUB_POST` | No | Set to `true` to skip GitHub comment posting (default: `false`) |
| `CLAUDE_MODEL` | No | Claude model override (default: `claude-sonnet-4-20250514`) |

### Discord Bot Setup

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application and add a Bot
3. Enable the **MESSAGE CONTENT** privileged intent
4. Generate a bot token -- this is your `DISCORD_BOT_TOKEN`
5. Invite the bot to your server with `Read Messages` and `Read Message History` permissions
6. Note the server (guild) ID -- this is your `DISCORD_GUILD_ID`

For posting responses, create a webhook:
1. In Discord, go to the target channel's settings
2. Navigate to Integrations > Webhooks
3. Create a new webhook -- the URL is your `DISCORD_WEBHOOK_URL`

### Running Locally

```bash
# Set required environment variables
export DISCORD_BOT_TOKEN="your-bot-token"
export DISCORD_GUILD_ID="your-guild-id"
export DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..."
export ANTHROPIC_API_KEY="your-api-key"

# Run a full help cycle
bash automation/run-help-cycle.sh

# Dry run (draft responses but do not post them)
DRY_RUN=true bash automation/run-help-cycle.sh

# Skip syncing (use previously synced data)
SKIP_SYNC=true bash automation/run-help-cycle.sh

# Run individual sync scripts
bash automation/sync-discord.sh
bash automation/sync-github.sh
bash automation/sync-docs.sh

# Post a single message to Discord
bash automation/post-discord.sh "Hello from the help bot!"
bash automation/post-discord.sh --file data/responses/discord/some-response.md
```

### Running via GitHub Actions

The help cycle runs automatically every 30 minutes via the `.github/workflows/help-cycle.yml` workflow.

**Setup:**

1. Go to your repository's Settings > Secrets and variables > Actions
2. Add the following secrets:
   - `DISCORD_BOT_TOKEN`
   - `DISCORD_GUILD_ID`
   - `DISCORD_WEBHOOK_URL`
   - `ANTHROPIC_API_KEY`
3. The workflow runs on `ubuntu-latest` and installs Claude Code CLI automatically

**Manual trigger:** Go to the Actions tab, select "Help Cycle", and click "Run workflow". You can configure dry run mode, sync windows, and other options.

## Customizing Behavior

The bot's behavior is defined entirely in text files. No code changes needed.

### Change what the bot knows

Edit `CLAUDE.md`:
- **Knowledge Scope** -- Add or remove topics the bot should handle
- **Common Issues** -- Add FAQ entries for instant answers
- **Response Guidelines** -- Adjust tone, formatting, confidence thresholds
- **Out of Scope** -- Define what the bot should redirect away from

### Change which channels/repos to monitor

Edit `config.json`:
- `discord.channels` -- List of Discord channel names to sync
- `github.repos` -- List of GitHub repositories to watch
- `docs.pages` -- Documentation pages to crawl

### Change how the bot responds

Edit the agent definitions in `.claude/agents/`:
- `discord-responder.md` -- Discord formatting, tone by channel, response criteria
- `github-triage.md` -- Issue classification, label suggestions, duplicate detection
- `docs-searcher.md` -- Search strategy, documentation structure

### Change operational parameters

Edit `config.json`:
- `bot.max_responses_per_cycle` -- Cap on responses per run (default: 10)
- `bot.response_cooldown_minutes` -- Avoid responding to the same user too frequently
- `discord.sync_hours` -- How far back to look in Discord (default: 6 hours)
- `github.sync_days` -- How far back to look in GitHub (default: 7 days)

## How It Differs from Traditional Bots

| Aspect | Traditional Bot | This Bot |
|--------|----------------|----------|
| Runtime | Always-on process | Periodic `claude -p` invocation |
| Knowledge | Vector store + embeddings | Synced markdown files |
| Behavior | Application code | CLAUDE.md + agent definitions |
| Customization | Code changes + redeploy | Edit markdown files |
| Dependencies | Database, framework, hosting | Claude Code CLI + shell scripts |
| Scaling | Horizontal scaling | Increase cycle frequency |
| Updates | Code releases | Edit text files, commit, push |

## Background

This is the v2 approach to the GameCI help bot. The [original PR](https://github.com/game-ci/help-bot/pull/1) scaffolded a LlamaIndex-based solution with a vector store, embeddings, and a RAG pipeline. This version replaces all of that with a simpler architecture: Claude Code running periodically in a well-structured workspace.

The trade-off: simpler to maintain and extend (just edit markdown files), but requires Claude Code CLI and an Anthropic API key. The bot's capabilities improve automatically as Claude Code improves.

## Contributing

Contributions are welcome. The most impactful contributions are improvements to:

1. **`CLAUDE.md`** -- Better response guidelines, more FAQ entries, clearer scope definitions
2. **`config.json`** -- New channels, repos, or documentation pages to monitor
3. **Agent definitions** -- Better prompts for more accurate responses
4. **Sync scripts** -- Handling more data sources or edge cases

### Development Workflow

1. Fork and clone the repository
2. Set up environment variables (see Setup section)
3. Run `DRY_RUN=true bash automation/run-help-cycle.sh` to test
4. Review drafted responses in `data/responses/`
5. Submit a pull request with your changes

### Guidelines

- Keep `CLAUDE.md` focused and factual -- avoid speculative or ambiguous instructions
- Test agent prompt changes with dry runs before submitting
- Do not commit anything in `data/` (it is gitignored, except `.gitkeep` files)
- Shell scripts should work on both Linux and macOS

## License

[MIT](LICENSE) -- Copyright GameCI Contributors
