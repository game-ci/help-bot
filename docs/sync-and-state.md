# Sync coverage & cursor state

This document explains how the bot keeps `data/` in sync, tracks its place in each source, and honors official contributors/overrides.

## GitHub coverage

- **Repositories:** All repos listed under `github.repos` are pulled via the Octokit REST API (issues, pull requests, comments, review comments, reactions, releases, tags).  
- **Cursor state:** Each run records ISO timestamps per repo (`data/state.json`). The next sync requests data `since` those markers so repeated runs only fetch deltas. Delete `data/state.json` or clear a repo entry to re-sync from scratch.  
- **Official collaborators:** If a tracked collaborator (config `github.collaborators`) has already contributed to an issue or PR (comment/review), the bot skips posting unless you pass `--allow-official` or use `--force-reply-id <responseId>`.

## Discord coverage

- **Channels:** Every channel listed under `discord.guilds[].channels[]` is synced, including threads and forum posts.
- **Cursor state:** The latest message snowflake per channel is stored in `data/state.json`. Each run resumes from that snowflake, so the bot only reads the newest messages. You can reset a channel’s cursor by editing `data/state.json` or deleting the entire file.  
- **Official roles/users:** Set `discord.official_roles` and/or `discord.official_users` to skip replies when members from those groups already responded. The bot can still post if you pass `--allow-official`, `--force-reply-id`, or react with the configured emoji to re-trigger a reply.

## Seen-you notifications

When the bot chooses not to reply because an official response exists, it can post a short “seen-you” stub (prefix emoji configurable via `discord.seen_you_emoji`). Provide `--seen-you-message`/`--seen-you-emoji` to customize per-cycle notifications when the skip occurs.

## Releases & tags

- **Stored metadata:** Releases and tags for every repo are written to `data/github/releases/<repo>.json` and `data/github/tags/<repo>.json`. This ensures the agents can reference version context even if those data points aren’t part of a cycle’s immediate triggers.

## Overrides

- `--skip-sync`/`SKIP_SYNC=true`: reuse the existing `data/` snapshot without fetching new Discord or GitHub data.  
- `--force-reply-id <id>`: post the companion draft even if it would otherwise be suppressed (official response exists).  
- `--allow-official`: allow posting even when an official contributor replied. Useful for testing or approvals.
