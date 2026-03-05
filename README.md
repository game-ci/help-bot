<img width="1536" height="1024" alt="image" src="https://github.com/user-attachments/assets/6ed2a212-06f3-4b68-99aa-f3923501e4be" />

# GameCI Help Bot

TypeScript-first orchestrator for the GameCI Help Bot. It syncs Discord, GitHub, and docs, feeds the workspace into Claude/Continue/Codex (or your chosen provider), drafts replies, and posts them back to Discord and GitHub. The CLI follows the unity-builder style (`yarn`/`npm` scripts, clean command surface, secure token handling) so you can run it on Windows PowerShell, macOS, or Linux with the same experience.

## Quick start

1. **Install dependencies**
   ```powershell
   cd help-bot
   yarn install
   ```
2. **Set secrets**
   ```powershell
   $env:DISCORD_BOT_TOKEN="..."
   $env:DISCORD_GUILD_ID="..."
   $env:DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..."
   $env:ANTHROPIC_API_KEY="..."  # Claude only
   ```
3. **Run a help cycle**
   ```powershell
   npm run cycle
   ```
   Dry run: `npm run cycle -- --dry-run`

## Core commands

| Command | Purpose |
|---------|---------|
| `yarn cycle` / `npm run cycle` | Sync data → run the provider → post replies (incremental). |
| `yarn continuous` / `npm run continuous` | Live mode: loops with `bot.cycle_interval_minutes` between passes. |
| `gameci-help-bot sync-discord|sync-github|sync-docs` | Refresh each data source individually when troubleshooting. |
| `gameci-help-bot vector-bake [-- --docs-only|--query ...|--clean]` | Manage the optional LlamaIndex store (bake/query/clean). |
| `gameci-help-bot feedback mark-good|mark-bad` | Tag a bot response as helpful or needing improvement. |
| `gameci-help-bot report summary` | Show the last cycle stats, release/tag coverage, and feedback totals. |
| `gameci-help-bot nssm ...` | Install/manage the Windows NSSM service (live or incremental mode). |

## Modes at a glance

- **Incremental** (`cycle`, `automation/run-help-cycle.sh`): One-shot sync → LLM → post. Ideal for scheduled runs or CI jobs.  
- **Live** (`continuous`, NSSM service, Docker): Loop indefinitely, waiting `bot.cycle_interval_minutes` between passes for near-real-time coverage.  
- **Interactive**: Run any provider CLI (Claude/Continue/Codex) directly in the repo with `CLAUDE.md` as the system prompt and the synced `data/` directory exposed for manual inspection.

## Sync, vector storage, and overrides

The helpers now track per-source cursors, release/tag metadata, official contributor filters, and “seen-you” notifications triggered when someone else already replied. Vector search is optional but easy to manage (bake/query/clean). See `docs/sync-and-state.md` for the cursor/override rules and `docs/vector-knowledge.md` for LlamaIndex lifecycle details.

## Feedback & reporting

Responses log metadata in `data/responses/feedback.jsonl`; use `gameci-help-bot feedback mark-good|mark-bad` to tag outcomes and `gameci-help-bot report summary` for a cycle dashboard. Details (command usage, report fields) live in `docs/feedback-reporting.md`.

## Additional resources

- `docs/sync-and-state.md` – GitHub/Discord sync coverage, cursor files, overrides/private roles, release/tag storage, and contributor filters.  
- `docs/vector-knowledge.md` – LlamaIndex bake/query/clean commands, enabling/disabling opt-in vector search, and how to keep the store in sync with docs.  
- `docs/feedback-reporting.md` – Feedback workflow, report output fields, and how the metrics/logging map back to responses.  
- `docs/windows-secrets.md` – Secure Discord token helper behavior (keytar, DPAPI/keychain, prompts) and how CLI/automation reuse stored secrets.  
- `.github/workflows/ci.yml` – Runs `npm run build` and `npm run lint` for every push/PR on `main`.  
- `.claude/agents/` – Agent prompts (link to `CLAUDE.md` for behavior).  
