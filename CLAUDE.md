## CLAUDE Code Instructions

This repository runs Claude Code (or compatible LLMs) inside the repository workspace to implement the help bot. Everything the agents need to know about GameCI, the expected workflow, response tone, and data layout lives in this file.

### Objectives
- Read synced `data/` files (Discord JSONL, GitHub Markdown, docs).
- Identify unanswered questions/issues and draft helpful responses.
- Respect `config.json` settings for channels, repos, doc pages, and response limits.
- Write responses into `data/responses/discord/*.md` and `data/responses/github/*.md` using the required frontmatter format.
- When handling GitHub data, treat issues and pull requests equally: draft comments that can be posted via `gh issue comment` or `gh pr comment` so maintainers see consistent guidance.

### Tone & Style
- Professional, friendly, concise.
- Mention flowing structures for Discord (short paragraphs, code blocks if needed) and GitHub (GitHub-Flavored Markdown).
- Reference documentation from `data/docs/` when available.

### Behavior
1. Skip bots, short/command-prefixed Discord messages, issues already handled, or out-of-scope topics.
2. Prioritize by `bot.max_responses_per_cycle` and preference order: bugs > unanswered Discord help messages > questions > feature requests.
3. Use CLAUDE.md as the source of truth for all knowledge. All other agent definitions should simply reference this file.
4. The automation scripts honor whichever LLM provider you pick (`claude`, `lm_studio`, `continue`, or `codex`) by sourcing `automation/llm-provider.sh`, so trust that the same instructions and file layout are shared across providers.

### Secure Discord token helper
- `automation/run-help-cycle.sh` and `automation/run-continuous.sh` source `automation/discord-token-helper.sh` before syncing, which prompts for `DISCORD_BOT_TOKEN`, validates it via the Discord API with `curl`, and persists it securely (DPAPI-backed storage on Windows; a config path on macOS/Linux). The helper can also be sourced manually (`source automation/discord-token-helper.sh && ensure_discord_token`) if you build custom workflows.
- When the bot runs on Windows, the helper will decrypt the stored token so the non-interactive service or CLI can reuse it. If validation fails, the helper removes the stale token and requests a new one before letting the cycle proceed.

### Modes
- **Incremental mode** (`automation/run-help-cycle.sh`): run once, schedule via cron/actions, or call from `automation/nssm-service.sh --mode incremental` to let Windows services or other orchestrators trigger the sync → process → post loop. Environment variables, `.env`, and the secure token helper are loaded before each cycle so your CLI, GitHub Actions, or manual runs behave consistently on Windows, macOS, and Linux.
- **Live mode** (`automation/run-continuous.sh`): loops indefinitely with `bot.cycle_interval_minutes`. It is safe to run inside Docker, on a persistent macOS/Linux shell, or as a Windows NSSM service (`automation/nssm-service.sh install --mode live`). Both modes share the same prompt definitions, the same `CLAUDE.md` knowledge base, and the same `automation/llm-provider.sh` wiring so you can swap providers at any time without rewriting the workflow.

### Vector search (optional)
- `vector_search.enabled` is `false` by default. Enable it to let the prompts look for answers inside the LlamaIndex store under `data/vector-store/`, which is kept in sync via `automation/vector-bake.sh`. The bake script installs its Python dependencies on demand, ingests `data/docs/` (plus GitHub docs/issues when you choose), and persists the index so Claude/other providers can prefer high-signal hits first.
- When vector search is disabled or the store is missing, the prompts continue to read the raw markdown files under `data/docs/`, `data/github/`, and `data/discord/`, so everything still works without running Python or building a vector index. Mention the vector store only when it actually exists so that fallback instructions remain accurate.

### Windows service (NSSM)
- When running on Windows, `automation/nssm-service.sh` installs the service via NSSM with the right `bash` command, logs, and environment. It reads `.env` or the `ENV_VARS` override to populate `AppEnvironmentExtra`, ensuring your tokens, webhooks, and API keys are available to the non-interactive service. Specify `--mode live` (the default) to run `run-continuous.sh` or `--mode incremental` for a single-cycle runner.
- The helper also routes stdout/stderr into `logs/service.log`, so the service shares logs with the rest of the repo, and it leaves the secure Discord token helper in place so token prompts and encryption still happen just like they do in manual runs.

### Providers
- **Claude Code CLI (default)** – expressed via `claude -p` with the repo as the working directory; it reads `CLAUDE.md` and has filesystem access to `data/`.
- **LM Studio** – configure `llm.lm_studio` in `config.json`, start your local LM Studio server, and set `LLM_PROVIDER=lm_studio`. The CLI passes along the `CLAUDE.md` text, file listings, and prompts even though the model only receives the text payloads.
- **Continue CLI** – set `LLM_PROVIDER=continue` and run the CLI; it reads `CLAUDE.md` as the system prompt and produces responses via your preferred Continue model.
- **Codex (OpenAI)** – set `LLM_PROVIDER=codex` and provide `OPENAI_API_KEY`; the same `automation/llm-provider.sh` wrapper calls OpenAI completions using the shared instructions. Tune `llm.codex` in `config.json` to adjust the model, temperature, and max tokens without editing scripts.

The main scripts respect `LLM_PROVIDER` or the `llm.provider` config, so you can keep running the workflow via shell scripts or by calling Claude/Continue/Codex directly while staying aligned with `CLAUDE.md`.

### Notes
- Do not modify `data/` manually outside of generated responses.
- For new behaviors, edit `CLAUDE.md` rather than introducing new scripts.
