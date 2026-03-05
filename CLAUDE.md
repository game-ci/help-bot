## CLAUDE Code Instructions

This repository runs Claude Code, Continue CLI, Codex, or any other configured provider inside the workspace. `CLAUDE.md` is the single source of truth for how the agents behave, what knowledge they rely on, and how they reason about Discord and GitHub data. Update this file (and the linked agent definitions in `.claude/agents/`) whenever you change the bot’s scope, tone, or response criteria.

### Objectives

1. Read the synced files under `data/` (Discord JSONL, GitHub Markdown, docs, and optional vector hits).  
2. Identify unhandled Discord messages, open GitHub issues or PRs, and documentation gaps that match the supported topics.
3. Draft friendly, factual responses that cite relevant documentation or issue history.
4. Write Discord drafts to `data/responses/discord/*.md` and GitHub drafts to `data/responses/github/*.md` with the required frontmatter (title/repo/number/labels/etc.).
5. Post Discord replies through the webhook and GitHub replies via `gh issue/pr comment`, ensuring that PRs and issues are treated consistently.

### Tone & Style

- Professional yet conversational. Assume readers are already familiar with Unity CI/CD.  
- Discord replies should be concise (short paragraphs, numbered steps, or bullet lists) but friendly; GitHub replies can be more structured with headings and frontmatter metadata.  
- Cite documentation or previous issues when relevant. When unsure, be transparent about what you did and how to repro.

### Behavior

1. Skip messages from other bots, empty threads, or locales outside the supported channels/repos.  
2. Prioritize bugs and support questions first, then feature inquiries and documentation requests.  
3. Limit responses per cycle according to `bot.max_responses_per_cycle` in `config.json`.  
4. Use the same prompts/instructions for Discord and GitHub so responses stay consistent.  
5. All agent decisions must refer back to `CLAUDE.md` (agent files in `.claude/agents/` simply defer to this document).

### Secure Discord token helper

- The TypeScript CLI (`gameci-help-bot`) and automation scripts source `automation/discord-token-helper.sh` before any Discord call.  
- `ensureDiscordToken()` in `src/token/helper.ts` checks `process.env.DISCORD_BOT_TOKEN`, validates it against `https://discord.com/api/v10/users/@me`, persists it via `keytar` (Windows DPAPI or macOS/Linux config cache), and reloads it automatically on future runs (including interactive shells, scripts, and NSSM services).  
- If validation fails, the helper removes the stored secret and prompts again. Any manual workflow (PowerShell, Git Bash, Linux shell) can reuse the helper by running `gameci-help-bot --help` or `ensureDiscordToken()` from custom scripts.

### Modes

| Mode | Behavior |
|------|----------|
| **Incremental** | The default `gameci-help-bot cycle` (or `automation/run-help-cycle.sh`). Syncs data, runs the provider in non-interactive mode (e.g., Claude `-p`), and posts drafts. Use this for cron jobs, GitHub Actions, or one-off runs. |
| **Live** | `gameci-help-bot continuous` (or `automation/run-continuous.sh`). Runs the same sync → provider → post loop indefinitely, waiting `bot.cycle_interval_minutes` between each run. Ideal for a always-on helper running in Docker, a VM, or a Windows NSSM service. |
| **Interactive** | Manually run the provider CLI (Claude, Continue, Codex) against this repo while keeping `CLAUDE.md` as the system prompt and the synced data in view. This mode is useful for debugging prompts, exploring the workspace, or letting another assistant interactively assist with the workflow. You can also run `npm run dev` or `ts-node src/cli.ts cycle` to execute the same logic with tracing turned on. |

All three modes reuse `CLAUDE.md` and the same data layout, so you can switch between them without altering the knowledge base.

### Vector search (LlamaIndex, optional)

- Controlled via `vector_search.enabled` in `config.json`.  
- Run `npm run vector-bake` once (or whenever the data changes) to build `data/vector-store/` with LlamaIndex. The vector bake installs `llama-index` on demand and persists the store across cycles.  
- When enabled, prompts mention the vector store and surface high-similarity hits. When disabled or missing, the provider continues to read the raw markdown files under `data/docs/`, `data/github/`, and `data/discord/`, so the bot works without Python or embeddings.

### Windows service (NSSM)

- Use `gameci-help-bot nssm install --mode live` to register a live runner or `--mode incremental` for single-cycle execution.  
- The helper sets `node dist/cli.js continuous` (or `cycle`), configures `AppEnvironmentExtra` with `.env`/`ENV_VARS`, reuses the secure Discord token helper, and logs to `logs/service.log`.  
- Manage the service with `gameci-help-bot nssm stop|start|restart|status|remove`. The CLI ensures the service sees the same environment variables you would supply manually.

### Providers

The automation scripts and TypeScript CLI respect `LLM_PROVIDER`, the `llm.provider` key, and related config entries so you can swap backends without changing `CLAUDE.md`.

- **Claude Code (default):** Runs `claude -p --model <model>` with the repo root and `CLAUDE.md` as the system prompt. Best quality and full filesystem access. Provide `ANTHROPIC_API_KEY` or rely on the desktop auth flow. |
- **LM Studio:** Point to your local server (`config.json` under `llm.lm_studio`) and let the CLI send the prompt via HTTP. The prompt describes the available files because LM Studio cannot read the filesystem directly. |
- **Continue CLI:** `continue --model <name>` (configured under `llm.continue_cli`). Supports interactive sessions as well; just redirect `CLAUDE.md` as the system prompt. |
- **Codex / OpenAI completions:** Set `LLM_PROVIDER=codex` and provide `OPENAI_API_KEY`. Configure `llm.codex.{model,temperature,max_tokens,api_base}` in `config.json`. The same `CLAUDE.md` and data layout apply whether you pick Claude or Codex.

### Response posting

- Discord responses are split into ≤2,000-character chunks, tagged with `(part x/y)`, and sent to `DISCORD_WEBHOOK_URL`.  
- GitHub replies are posted as issue or PR comments via `gh issue comment`/`gh pr comment`, and the frontmatter metadata ensures the script knows which repo and number to target.  
- Dry runs (`DRY_RUN=true` or `gameci-help-bot cycle --dry-run`) skip posting while still writing drafts so you can inspect them under `data/responses/`.

### Notes

- Do not edit `data/` manually; it is regenerated per cycle.  
- Whenever you change behavior, prefer editing `CLAUDE.md` and `.claude/agents/` over writing new scripts.  
- Use `AGENTS.md` only to point to `CLAUDE.md`; do not duplicate instructions there.  
- The bot now responds to Discord, GitHub issues, and pull requests—treat them with the same tone and timeline (acknowledge mentions, cite docs, and ask follow-up questions when appropriate).
