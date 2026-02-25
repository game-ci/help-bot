# GameCI Help Bot

AI-powered community support bot for [GameCI](https://game.ci), built on [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

This bot monitors GameCI's Discord server and GitHub repositories, identifies questions about Unity CI/CD, drafts helpful responses grounded in documentation, and posts them back. It uses Claude Code as its default runtime -- no custom framework, no vector store, no RAG pipeline required.

## How It Works

The bot runs a **sync-reason-respond** cycle periodically:

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
  |           LLM Provider (configurable)           |
  |                                                 |
  |  Claude Code: claude -p (default)               |
  |  LM Studio:   local OpenAI-compatible API       |
  |  Continue CLI: continue                         |
  |                                                 |
  |  Reads: CLAUDE.md, config.json, data/           |
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

**Operational model:** The bot is designed for occasional, periodic running -- not guaranteed always-on. Anyone on the team can run it: provide the Discord bot token, tell it to send replies. If someone is happy to leave it running, the workflow supports a live experience too.

## Quick Start

### Prerequisites

- [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated
- `python3` and `curl` available
- A Discord bot token with `MESSAGE_CONTENT` intent and channel read permissions
- A Discord webhook URL for the response channel

Plus one of:
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) + Anthropic API key (default)
- [LM Studio](https://lmstudio.ai/) running locally (free alternative)
- [Continue CLI](https://continue.dev/) installed (free alternative)

### 30-Second Setup

```bash
# 1. Clone the repo
git clone https://github.com/game-ci/help-bot.git
cd help-bot

# 2. Set environment variables
export DISCORD_BOT_TOKEN="your-bot-token"
export DISCORD_GUILD_ID="your-guild-id"
export DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..."
export ANTHROPIC_API_KEY="your-api-key"  # Only needed for Claude provider

# 3. Run a help cycle
bash automation/run-help-cycle.sh

# Or do a dry run first (drafts responses but does not post)
DRY_RUN=true bash automation/run-help-cycle.sh
```

That is it. The bot syncs recent questions, processes them, and sends replies.

## Running Modes

### Mode 1: Manual (Simplest)

Run a single help cycle from the command line. Best for occasional use or testing.

```bash
# Full cycle: sync, process, post
bash automation/run-help-cycle.sh

# Dry run: sync and process, but do not post
DRY_RUN=true bash automation/run-help-cycle.sh

# Skip syncing (use previously synced data)
SKIP_SYNC=true bash automation/run-help-cycle.sh

# Run individual sync scripts
bash automation/sync-discord.sh
bash automation/sync-github.sh
bash automation/sync-docs.sh
```

### Mode 2: Self-Hosted GitHub Actions Runner

Register your machine as a GitHub Actions runner. When you flip it open, GitHub Actions dispatches help cycles to your machine. When you close it, it stops.

```bash
# One-time setup (requires gh CLI with admin access)
bash automation/setup-runner.sh

# Start the runner (runs in foreground, Ctrl+C to stop)
bash automation/setup-runner.sh --start

# Remove runner registration
bash automation/setup-runner.sh --remove
```

Then trigger cycles from the GitHub Actions tab using the "Help Cycle (Self-Hosted)" workflow.

### Mode 3: Docker Container (Persistent)

Run as a long-lived container that cycles automatically. Best for contributors who want to leave it running.

```bash
# Start with docker compose (reads .env file for secrets)
docker compose up -d

# Watch logs
docker compose logs -f help-bot

# Stop
docker compose down
```

Or build and run directly:

```bash
# Build the image
docker build -t gameci-help-bot .

# Run a single cycle
docker run --rm \
  -e DISCORD_BOT_TOKEN="..." \
  -e DISCORD_GUILD_ID="..." \
  -e DISCORD_WEBHOOK_URL="..." \
  -e ANTHROPIC_API_KEY="..." \
  gameci-help-bot bash automation/run-help-cycle.sh

# Run continuously (default CMD)
docker run -d \
  --name gameci-help-bot \
  --restart unless-stopped \
  -e DISCORD_BOT_TOKEN="..." \
  -e DISCORD_GUILD_ID="..." \
  -e DISCORD_WEBHOOK_URL="..." \
  -e ANTHROPIC_API_KEY="..." \
  gameci-help-bot
```

### Mode 4: GitHub Actions (Cloud)

Runs automatically every 30 minutes on GitHub-hosted runners via `.github/workflows/help-cycle.yml`.

**Setup:**
1. Go to repository Settings > Secrets and variables > Actions
2. Add secrets: `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_WEBHOOK_URL`, `ANTHROPIC_API_KEY`
3. The workflow runs on `ubuntu-latest` and installs dependencies automatically

**Manual trigger:** Actions tab > "Help Cycle" > "Run workflow"

## LLM Provider Configuration

The bot supports three LLM providers. Change the provider in `config.json` under `llm.provider` or set the `LLM_PROVIDER` environment variable.

### Claude (Default)

Best quality. Requires a Claude subscription or Anthropic API key.

```bash
export ANTHROPIC_API_KEY="your-api-key"
export LLM_PROVIDER="claude"  # or omit (default)
bash automation/run-help-cycle.sh
```

Claude Code runs in `claude -p` (print/non-interactive) mode with the repo as its working directory. It reads `CLAUDE.md` automatically and has full access to the filesystem for reading data and writing responses.

### LM Studio (Free, Local)

Run any open-source model locally. No API key or subscription needed.

1. Download [LM Studio](https://lmstudio.ai/)
2. Load a model (recommended: Llama 3.1 8B or Mistral 7B)
3. Start the local server (default: `http://localhost:1234`)
4. Run:

```bash
export LLM_PROVIDER="lm_studio"
bash automation/run-help-cycle.sh
```

Configure the endpoint in `config.json` under `llm.lm_studio.base_url`.

Note: LM Studio cannot read/write files directly like Claude Code. It receives the prompt and file listing, then outputs response text. The quality depends on the local model.

### Continue CLI (Free)

Use the Continue development environment's CLI.

1. Install [Continue](https://continue.dev/)
2. Configure your preferred model
3. Run:

```bash
export LLM_PROVIDER="continue"
bash automation/run-help-cycle.sh
```

## Optional: Vector Search

For improved answer retrieval, you can build a vector index from the synced documentation. This is entirely optional -- the text file approach works well on its own.

```bash
# Install dependencies
pip install chromadb sentence-transformers

# Bake the vector index from synced docs
bash automation/vector-bake.sh

# Bake documentation only (skip GitHub issues)
bash automation/vector-bake.sh --docs-only

# Query the index
bash automation/vector-bake.sh --query "How do I activate a Unity license?"
```

The vector store persists to `data/vector-store/` and can be reused across cycles.

Configure in `config.json` under `vector_search`:
- `enabled`: Set to `true` to use vector search during help cycles
- `engine`: Vector database engine (default: `chromadb`)
- `embedding_model`: Sentence transformer model (default: `all-MiniLM-L6-v2`)

## Architecture: Claude Code Agent Swarm

Instead of building a traditional bot with a database, embeddings, and retrieval pipelines, this bot is simply Claude Code running in a well-structured workspace:

- **`CLAUDE.md`** defines the bot's identity, knowledge scope, response guidelines, and data layout. This is the "brain" -- edit this file to change behavior.
- **`config.json`** contains tunable settings: which channels to monitor, which repos to watch, response limits, LLM provider.
- **`.claude/agents/`** contains specialized agent definitions for Discord responses, GitHub triage, and documentation search.
- **`automation/`** contains shell scripts that sync data, run cycles, manage providers, and post responses.
- **`data/`** is the ephemeral workspace where synced data lives during a cycle.

Behavior changes are markdown edits. No code changes required.

## Repository Structure

```
CLAUDE.md                              # Bot identity, rules, knowledge scope
config.json                            # All configurable settings
Dockerfile                             # Container image for persistent deployment
docker-compose.yml                     # Docker Compose for easy container management
.claude/agents/
  discord-responder.md                 # Discord response specialist
  github-triage.md                     # GitHub issue triage specialist
  docs-searcher.md                     # Documentation search support agent
automation/
  run-help-cycle.sh                    # Main orchestrator (sync -> process -> post)
  run-continuous.sh                    # Continuous loop for persistent deployment
  llm-provider.sh                      # LLM provider abstraction (Claude/LM Studio/Continue)
  sync-discord.sh                      # Sync Discord messages to filesystem
  sync-github.sh                       # Sync GitHub issues and discussions
  sync-docs.sh                         # Download game.ci/docs pages
  post-discord.sh                      # Post response via Discord webhook
  vector-bake.sh                       # Optional: build vector search index
  setup-runner.sh                      # Self-hosted GitHub Actions runner setup
.github/workflows/
  help-cycle.yml                       # Scheduled workflow (GitHub-hosted runners)
  help-cycle-self-hosted.yml           # Manual workflow (self-hosted runners)
data/
  discord/channels/                    # Synced Discord messages (JSONL)
  github/issues/                       # Synced GitHub issues (Markdown + YAML)
  github/discussions/                  # Synced GitHub discussions
  docs/                                # Synced documentation pages (Markdown)
  responses/discord/                   # Drafted Discord responses
  responses/github/                    # Drafted GitHub responses
  vector-store/                        # Optional: ChromaDB vector index
  logs/                                # Cycle execution logs
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_BOT_TOKEN` | Yes | Discord bot token for reading messages |
| `DISCORD_GUILD_ID` | Yes | Discord server (guild) ID |
| `DISCORD_WEBHOOK_URL` | Yes | Discord webhook URL for posting responses |
| `ANTHROPIC_API_KEY` | Claude only | Anthropic API key (not needed for LM Studio/Continue) |
| `LLM_PROVIDER` | No | LLM backend: `claude`, `lm_studio`, or `continue` (default: `claude`) |
| `SYNC_HOURS` | No | Hours of Discord history to sync (default: 6) |
| `SYNC_DAYS` | No | Days of GitHub history to sync (default: 7) |
| `DRY_RUN` | No | Set to `true` to draft but not post (default: `false`) |
| `SKIP_SYNC` | No | Set to `true` to skip syncing (default: `false`) |
| `SKIP_GITHUB_POST` | No | Set to `true` to skip GitHub comment posting (default: `false`) |
| `CLAUDE_MODEL` | No | Claude model override (default: `claude-sonnet-4-20250514`) |
| `CYCLE_INTERVAL_MINUTES` | No | Minutes between cycles in continuous mode (default: 30) |

## Discord Bot Setup

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
- `bot.cycle_interval_minutes` -- Time between cycles in continuous mode (default: 30)
- `discord.sync_hours` -- How far back to look in Discord (default: 6 hours)
- `github.sync_days` -- How far back to look in GitHub (default: 7 days)
- `llm.provider` -- Which LLM backend to use

## How It Differs from Traditional Bots

| Aspect | Traditional Bot | This Bot |
|--------|----------------|----------|
| Runtime | Always-on process | Periodic cycles (or continuous via Docker) |
| Knowledge | Vector store + embeddings | Synced markdown files (+ optional vector search) |
| Behavior | Application code | CLAUDE.md + agent definitions |
| Customization | Code changes + redeploy | Edit markdown files |
| Dependencies | Database, framework, hosting | Shell scripts + LLM CLI |
| LLM Backend | Single provider | Claude, LM Studio, or Continue CLI |
| Deployment | Cloud hosting required | Run anywhere: laptop, Docker, GitHub Actions |
| Scaling | Horizontal scaling | Increase cycle frequency or add runners |
| Updates | Code releases | Edit text files, commit, push |

## Background

This is the v2 approach to the GameCI help bot. The [original PR](https://github.com/game-ci/help-bot/pull/1) scaffolded a LlamaIndex-based solution with a vector store, embeddings, and a RAG pipeline. This version replaces all of that with a simpler architecture: an LLM running periodically in a well-structured workspace.

The trade-off: simpler to maintain and extend (just edit markdown files), but benefits most from Claude Code CLI. Alternative providers (LM Studio, Continue) offer a free path with reduced capability.

## Contributing

Contributions are welcome. The most impactful contributions are improvements to:

1. **`CLAUDE.md`** -- Better response guidelines, more FAQ entries, clearer scope definitions
2. **`config.json`** -- New channels, repos, or documentation pages to monitor
3. **Agent definitions** -- Better prompts for more accurate responses
4. **Sync scripts** -- Handling more data sources or edge cases

### Development Workflow

1. Fork and clone the repository
2. Set up environment variables (see Quick Start section)
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
