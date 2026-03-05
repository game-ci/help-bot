# Windows secret management

The CLI and automation scripts call `ensureDiscordToken()` (in `src/token/helper.ts`) before touching Discord. It:

1. Checks `DISCORD_BOT_TOKEN`; if present, validates it via `https://discord.com/api/v10/users/@me`.
2. Loads any stored token from `keytar` (DPAPI on Windows, macOS keychain, filesystem cache on Linux).
3. Prompts (secure prompt via `prompts`) when the token is missing or invalid.
4. Persists the valid token via `keytar`, so future runs (including headless NSSM services) reuse it without prompting.

If validation fails, the helper removes the stale entry and asks again. The same helper runs when you call `gameci-help-bot cycle`, `gameci-help-bot sync-discord`, or the NSSM-managed service, so Windows secrets remain up-to-date and never stored in plain-text.
