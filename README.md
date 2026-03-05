# GameCI Help Bot

TypeScript orchestration for the GameCI Help Bot: it syncs Discord messages, GitHub issues/PRs, and documentation, feeds them into Claude/Continue/Codex (or any configured provider), then drafts responses for Discord and GitHub. The CLI (`gameci-help-bot`) and accompanying automation scripts run on Windows, macOS, or Linux, and the repo is designed to feel familiar to the unity-builder workflow (TypeScript-first, `npm` scripts, minimal Bash/PowerShell).

## How it works

1. **Sync the workspace** – `gameci-help-bot cycle` (or `automation/run-help-cycle.sh`) syncs Discord channels, GitHub repositories, and `game.ci` docs into `data/`.
2. **Evaluate the data** – The configured LLM reads `CLAUDE.md`, the synced data, and any optional vector store to decide what to respond.
3. **Draft responses** – Structured Markdown answers are written under `data/responses/discord` and `data/responses/github`.
4. **Post results** – Discord replies go through the webhook; GitHub responses are posted as issue/PR comments via `gh issue comment` or `gh pr comment`.

Run the same cycle repeatedly via the live mode, schedule it (incremental mode), or open an interactive session (interactive mode) to explore the workspace manually while keeping CLAUDE as the system prompt.

## Quick start (TypeScript CLI)

```powershell
cd help-bot
npm install   # installs the TypeScript CLI and dependencies
```

Set the required environment variables (or expose them through `.env` and the secure token helper):

```powershell
$env:DISCORD_BOT_TOKEN="..."
$env:DISCORD_GUILD_ID="..."
$env:DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..."
$env:ANTHROPIC_API_KEY="..."  # only for the Claude provider
```

Run a help cycle and let the bot post real responses:

```powershell
npm run cycle
```

Or do a dry run (no posts, just drafts):

```powershell
npm run cycle -- --dry-run
```

Other useful commands:

| Command | Action |
|---------|--------|
| `npm run continuous` | Start live mode (runs until stopped, delays between cycles). |
| `gameci-help-bot sync-discord` | Update `data/discord/...` from Discord. |
| `gameci-help-bot sync-github` | Sync GitHub issues/PRs. |
| `gameci-help-bot sync-docs` | Fetch `game.ci/docs` pages. |
| `gameci-help-bot vector-bake` | Build (optional) LlamaIndex vector store. |
| `gameci-help-bot nssm install --mode live` | Register the Windows NSSM service (live or incremental). |

## Operational modes

| Mode | Behavior |
|------|----------|
| **Incremental** | Runs once (`gameci-help-bot cycle` / `automation/run-help-cycle.sh`). Syncs data, runs the LLM in non-interactive mode (e.g., Claude `-p`), and posts Discord/GitHub replies. Ideal for cron jobs, GitHub Actions, or scheduled tasks. |
| **Live** | Loops indefinitely (`gameci-help-bot continuous` / `automation/run-continuous.sh`). After each cycle it waits `bot.cycle_interval_minutes` (default 30) and then checks for new data to respond to, so replies keep flowing as new conversations appear. |
| **Interactive** | You or another LLM developer can run the provider CLI directly against this repo (Claude/continue/codex) while keeping `CLAUDE.md` as the system prompt and the synced data as observable state. This mode is useful when you want to inspect the workspace, debug prompts, or have a grounded conversation with the bot before automating. |

All modes rely on the same instructions in `CLAUDE.md`, the same data layout under `data/`, and the same `automation/discord-token-helper.sh` logic for secure token handling.

## Secure Discord token management

The TypeScript CLI and automation scripts call `ensureDiscordToken()` before any Discord interaction. The helper:

- prompts once for `DISCORD_BOT_TOKEN`,
- validates it with `https://discord.com/api/v10/users/@me`,
- stores it safely via `keytar` / Windows Credential Manager (DPAPI) or a macOS/Linux config path,
- reloads it automatically on subsequent runs (including NSSM services).

If the token becomes invalid, the helper clears the stored value and prompts again, so deployments do not proceed with stale secrets.

## Providers

You can swap Claude Code, LM Studio, Continue CLI, or Codex (OpenAI completions) at any time:

- **Claude Code (default):** Runs `claude -p` with `CLAUDE.md` as the system prompt. Ideal quality and direct filesystem access. Use `ANTHROPIC_API_KEY` or the Claude CLI auth flow.
- **LM Studio:** Point to your local server (`config.json` under `llm.lm_studio`). The CLI builds a prompt that lists available files and posts the messages over the HTTP API. Good for offline experimentation.
- **Continue CLI:** `continue --model <name>` runs with the repo context sniffed from `CLAUDE.md`.
- **Codex / OpenAI:** Uses the `openai` completions API (`OPENAI_API_KEY` required). You can configure `model`, `temperature`, and `max_tokens` in `config.json` under `llm.codex`.

Any provider just needs to respect the instructions in `CLAUDE.md` and write responses into `data/responses/`.

## Vector search (optional, LlamaIndex)

Set `vector_search.enabled` to `true` in `config.json` and run:

```powershell
npm run vector-bake
```

The script builds a LlamaIndex vector store (`data/vector-store/`) from docs and GitHub issues. If the store is missing or disabled, the prompts keep reading the raw Markdown files under `data/docs`, `data/github`, and `data/discord`, so everything still works without Python or embeddings. When vector search is enabled, the CLI automatically includes references to the store so the agent can cite high-signal answers.

## Windows NSSM service

Install [NSSM (Non-Sucking Service Manager)](https://nssm.cc/) and register the bot as a Windows service:

```powershell
gameci-help-bot nssm install --mode live
gameci-help-bot nssm start
```

Set `--mode incremental` for a single-cycle service, and use `stop|status|restart|remove` as needed. The helper wires `node dist/cli.js` (live or incremental) with `AppEnvironmentExtra`, reuses the secure Discord token store, and logs to `logs/service.log`.

## Automation & GitHub Actions

The `automation/` folder still provides Bash/Powershell helpers to keep parity with previous workflows (`discord-token-helper.sh`, `run-help-cycle.sh`, `llm-provider.sh`, `setup-runner.sh`, `vector-bake.sh`, `nssm-service.sh`). The TypeScript CLI mirrors those behaviors and lets you operate the bot across Windows, macOS, and Linux without manual shell hacks. GitHub Actions workflows (e.g., `.github/workflows/help-cycle.yml`) can call `npm run cycle` or `bash automation/run-help-cycle.sh` depending on the runner.

## Repository layout

Key directories:

- `src/` – TypeScript implementation of sync, post, provider, CLI, token helper, vector bake, and NSSM service helpers.
- `automation/` – Existing shell helpers remain for compatibility.
- `data/` – Synced Discord/GitHub/docs data, responses, logs, and the optional vector store.
- `.claude/` – Agent definitions; always defer to `CLAUDE.md`.

## Response handling

Responses land in `data/responses/discord/*.md` and `data/responses/github/*.md` with frontmatter (title, repo, issue number, etc.). Discord messages are posted in chunks to fit Discord’s 2,000-character limit, and GitHub comments are posted via the `gh` CLI, so make sure the runner has the required tokens and permissions.

## Next steps

1. Inspect `CLAUDE.md` to understand or modify the bot’s worldview.
2. Update `config.json` with your Discord/GitHub channels/repos and preferred provider.
3. Run `npm run cycle` for a single pass or `npm run continuous` for a live agent.
4. When ready for automation, schedule the incremental mode or register the NSSM service.
