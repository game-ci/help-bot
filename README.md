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

## Secure Discord token helper & cross-platform readiness

All automation scripts (`run-help-cycle.sh`, `run-continuous.sh`, the vector helpers, etc.) source `automation/discord-token-helper.sh` before talking to Discord. The helper:

- prompts once for `DISCORD_BOT_TOKEN` when it is missing, validates it against the Discord API with `curl`, and refuses to continue while the token is invalid.
- stores the token securely: on Windows it uses the built-in DPAPI-backed secret store (no plain-text secrets), and on macOS/Linux it caches it under `$XDG_CONFIG_HOME`/`$LOCALAPPDATA` so you rarely need to re-enter it.
- exposes the same helper if you need to script your own workflow, so you can `source automation/discord-token-helper.sh && ensure_discord_token` from other scripts.

Because this logic runs before each cycle, the bot warns you early if a token expires or was revoked, and the rest of the scripts continue to work unchanged on Windows (Git Bash/PowerShell), macOS, or Linux. You can also operate the workflow by invoking the CLUDE/Continue/Codex providers directly with the `automation/llm-provider.sh` wrapper (see the LLM Provider section below) to stay in sync with the instructions in `CLAUDE.md`.

## Running Modes

The bot can operate in two fully featured modes so you can choose the level of commitment and infrastructure that suits your team. All scripts listed below work unchanged on Windows (via Git Bash or PowerShell), macOS, and Linux.

### Incremental (manual/scheduled)

Use this for manual runs, scheduled cron jobs, or GitHub Actions workflows that call `automation/run-help-cycle.sh`. It syncs Discord/GitHub/docs, runs Claude/Continue/Codex (via `automation/llm-provider.sh`), then posts responses.

```bash
# Run a single cycle locally
bash automation/run-help-cycle.sh

# Dry run (draft only)
DRY_RUN=true bash automation/run-help-cycle.sh

# Skip syncing (reprocess existing data)
SKIP_SYNC=true bash automation/run-help-cycle.sh

# Run an individual sync step
bash automation/sync-discord.sh
bash automation/sync-github.sh
bash automation/sync-docs.sh
```

The helper scripts are cross-platform (Windows via Git Bash/PowerShell, macOS, Linux) and automatically source environment variables, `.env`, and the secure Discord token helper so you only get prompted for credentials when absolutely necessary. You can also run the same workflow with any supported provider by overriding `LLM_PROVIDER` (`claude`, `lm_studio`, `continue`, or `codex`) so the CLI you choose follows the shared instructions in `CLAUDE.md`.

Values such as `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_WEBHOOK_URL`, `ANTHROPIC_API_KEY`, and `LLM_PROVIDER` can be supplied via environment variables, a `.env`, or Windows secret storage through `automation/discord-token-helper.sh`.

### Live (continuous/daemon)

For near-real-time response, run `automation/run-continuous.sh` (also used inside Docker or as an NSSM service). It loops every `bot.cycle_interval_minutes` (default 30) and gracefully handles shutdown signals.

```bash
# Continuous mode (runs until stopped)
bash automation/run-continuous.sh

# Run as a Docker container (persistent)
docker compose up -d
```

On Windows you can wrap `automation/run-continuous.sh` in an NSSM service to keep it running even after reboots. Use the bundled helper so the service sees the same environment variables and `.env` entries you already use:

```powershell
bash automation/nssm-service.sh install --mode live
bash automation/nssm-service.sh start
```

Want the service to run just a single incremental cycle instead? Pass `--mode incremental` when installing. The helper records logs under `logs/service.log` by default, respects `ENV_VARS` or `.env`, and keeps the same secure Discord token helper in place.
Manage the service lifecycle with `bash automation/nssm-service.sh start|stop|status|restart|remove` whenever you need to pause or uninstall it.

### Self-hosted runner (optional)

Register your machine with GitHub Actions so workflows can target it:

```bash
bash automation/setup-runner.sh
bash automation/setup-runner.sh --start
bash automation/setup-runner.sh --remove
```

When the runner is online, the "Help Cycle (Self-Hosted)" workflow can dispatch to it.

### Docker Container (Persistent)

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

### GitHub Actions (Cloud)

Runs automatically every 30 minutes on GitHub-hosted runners via `.github/workflows/help-cycle.yml`.

**Setup:**
1. Go to repository Settings > Secrets and variables > Actions
2. Add secrets: `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_WEBHOOK_URL`, `ANTHROPIC_API_KEY`
3. The workflow runs on `ubuntu-latest` and installs dependencies automatically

**Manual trigger:** Actions tab > "Help Cycle" > "Run workflow"

## Vector Search (LlamaIndex)

Per-cycle behavior works without a vector store, but you can opt-in to the LlamaIndex-based search paths for improved retrieval:

1. Install `llama-index` (Python) locally.
2. After and between syncs, run `bash automation/vector-bake.sh` (pass `--docs-only` if you only want docs).
3. Enable vector search in `config.json` by setting `vector_search.enabled` to `true`; you can also tune `engine`, `collection_name`, and `embedding_model`.
4. The vector store persists to `data/vector-store/` and is automatically picked up by the agent prompts defined in `CLAUDE.md`.
5. If you prefer not to install LlamaIndex, leave `enabled` as `false`—the prompts still read raw markdown files and fall back gracefully.

## Windows service (NSSM)

Install [NSSM (the Non-Sucking Service Manager)](https://nssm.cc/) and use the bundled helper to register either live or incremental modes. The helper:

- installs the service with `bash` so it runs inside your existing workspace,
- reads `.env` (or the `ENV_VARS` override) and writes the same `AppEnvironmentExtra` string that keeps your tokens, webhooks, and API keys in sync,
- captures stdout/stderr in `logs/service.log`, and
- reuses `automation/discord-token-helper.sh` before each cycle so stored Discord tokens always work.

```powershell
bash automation/nssm-service.sh install --mode live
bash automation/nssm-service.sh start
```

Pass `--mode incremental` if you need the service to run a single help cycle at startup instead of looping indefinitely. Adjust the environment that the service sees by editing `.env` or by exporting `ENV_VARS="DISCORD_GUILD_ID=...;DISCORD_WEBHOOK_URL=...;LLM_PROVIDER=codex;OPENAI_API_KEY=..."` before installing. Use `bash automation/nssm-service.sh stop`, `status`, `restart`, or `remove` whenever you want to pause or uninstall the service.

## LLM Provider Configuration

The bot supports Claude, LM Studio, Continue CLI, and OpenAI Codex. `automation/run-help-cycle.sh` and `automation/run-continuous.sh` both source `automation/llm-provider.sh`, which reads `config.json`, the `LLM_PROVIDER` environment variable, and the shared instructions in `CLAUDE.md`. You can invoke any of the providers by setting `LLM_PROVIDER=<provider>` (or by editing the config) and running the scripts, or you can run the provider CLI directly inside this repo while keeping `CLAUDE.md` as your system prompt.

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

### Codex (OpenAI)

Use the OpenAI Codex completions endpoint if you prefer the Codex-style workflow instead of Claude or local models. Set your API key, pick the provider, and run a cycle:

```bash
export OPENAI_API_KEY="sk-..."
export LLM_PROVIDER="codex"
bash automation/run-help-cycle.sh
```

The provider honors `config.json` under `llm.codex` (`model`, `temperature`, `max_tokens`, `api_base`) so you can tune the completion parameters without touching the scripts. This works cross-platform because the launcher simply shells out to `python3` and the OpenAI REST API, letting you keep the same `CLAUDE.md` instructions regardless of provider.

## Optional: Vector Search

For improved answer retrieval, you can build a vector index from the synced documentation. This is entirely optional -- the text file approach works well on its own.

```bash
# Install dependencies
pip install llama-index

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
- `engine`: Vector search engine (default: `llamaindex`)
- `embedding_model`: Embedding model (default: `local:BAAI/bge-small-en-v1.5`)

Keeping `enabled` set to `false` leaves the vector store untouched and the prompts simply read the raw markdown files, so you can skip installing `llama-index` altogether until you want the extra recall. `automation/vector-bake.sh` installs its Python dependencies on demand and can run on Windows, macOS, or Linux because it's just a bash wrapper around `pip install llama-index`.

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
  vector-store/                        # Optional: LlamaIndex vector index
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
