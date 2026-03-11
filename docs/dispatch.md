# Dispatch system

The dispatch system gates which issues and messages the bot investigates. Instead of processing all eligible items immediately, maintainers can review and approve them first.

## Dispatch modes

| Mode | Behavior |
|------|----------|
| **auto** (default) | All eligible issues are processed immediately. No approval gate. |
| **approval** | Detection issues are created in the target repo. A maintainer must react with an approval emoji before the bot investigates. |
| **countdown** | Like approval, but with staged warnings. Auto-dispatches after all warning stages elapse (default: 3 stages, 24h apart = 72-hour minimum). |
| **triage** | Interactive Discord-based triage. Help requests are posted to a private admin channel with action buttons. Maintainers control the entire lifecycle from Discord. See [Triage mode](#triage-mode) below. |

Set the mode via CLI (`--dispatch-mode <mode>`) or in `config.json`:

```json
{
  "dispatch": {
    "mode": "auto",
    "discord_mode": "triage",
    "warnings_required": 3,
    "warning_interval_hours": 24,
    "approve_reactions": ["+1", "rocket"],
    "cancel_reactions": ["-1"],
    "max_detections_per_cycle": 10,
    "close_on_dispatch": true
  }
}
```

## Detection issues (approval / countdown modes)

In `approval` and `countdown` modes, detection issues are created in the target repo (default: `game-ci/help-bot`) with labels `help-bot`, `detection`, and the source repo name.

Maintainer actions on detection issues:
- React with approval emoji (thumbs up or rocket) to approve immediately
- React with cancel emoji (thumbs down) to cancel
- Post any comment to approve (bot-generated warning comments are excluded)

Only reactions/comments from collaborators listed in `config.json` `github.collaborators` are valid.

### Staged countdown safety

The countdown mode prevents bulk auto-dispatch if the bot hasn't run for a while. Only one stage can advance per cycle:

```
Cycle 1:  Create detection issue -> stage 0 (pending)
Cycle N:  24h elapsed -> post Warning 1 -> stage 1
Cycle N+: 24h elapsed -> post Warning 2 -> stage 2
Cycle N+: 24h elapsed -> post Warning 3 -> stage 3
Cycle N+: 24h elapsed -> auto-dispatch
```

A maintainer can react to approve or cancel at any point during the countdown.

## Discord dispatch

In `auto`, `approval`, and `countdown` modes, Discord dispatch is never fully automatic -- even with `dispatch.mode: "auto"`, Discord sources are forced to at least `"approval"` mode via `dispatch.discord_mode`.

For full Discord-native control, use `triage` mode instead.

## Triage mode

Triage mode moves the entire approval and review workflow into Discord. When a help request is detected (from any monitored Discord channel, thread, or forum post), the bot posts an interactive triage notification to a private admin channel. Maintainers control every step via buttons.

```bash
gameci-help-bot live --dispatch-mode triage
```

### Triage flow

```
Help request detected (Discord message, thread, forum post, or GitHub issue)
  |
  v
Bot posts triage notification to #triage channel
  (orange embed with source content, author, channel link)
  Buttons: [Investigate] [Ignore]
  Bot also posts a brief acknowledgment reply to the user
  |
  +-- Maintainer clicks [Ignore]
  |     Embed turns gray, marked as ignored
  |
  +-- Maintainer clicks [Investigate]
        |
        v
      Embed turns blue "INVESTIGATING"
      Bot status changes to DND with "Investigating #channel @author"
      Claude runs investigation (source code search, docs, cross-references)
        |
        v
      Embed turns green "READY" with response preview
      Buttons: [Send Response] [View Investigation] [Re-investigate] [Discard]
      Bot status returns to online
        |
        +-- [View Investigation]
        |     Creates a thread on the triage message (or uses existing)
        |     Posts the full response for maintainer review
        |
        +-- [Re-investigate]
        |     Reads maintainer messages from the thread as instructions
        |     Re-runs investigation with previous response marked as rejected
        |     and maintainer guidance appended to the prompt
        |
        +-- [Send Response]
        |     Posts the approved response to the original source
        |     (Discord reply to the user's message)
        |     Embed turns gray "SENT"
        |
        +-- [Discard]
              Embed turns gray, response discarded
```

### Providing instructions for re-investigation

After an investigation completes (embed is green "READY"):

1. Click **View Investigation** to see the full response in a thread
2. Reply in that thread with plain English instructions (e.g., "focus on macOS code signing" or "the user is on Unity 2022 LTS, check version-specific issues")
3. Click **Re-investigate** -- the bot reads all non-bot messages from the thread and includes them as `## Maintainer Guidance` in the prompt. The previous response is marked as rejected so Claude generates a fresh answer.

You can post multiple instruction messages and re-investigate as many times as needed. Each re-investigation produces a new response file with a `-reinvN` suffix.

### Triage configuration

Add a `triage_channel_id` to your guild config and list Discord user IDs for triage access:

```json
{
  "discord": {
    "triage_user_ids": ["YOUR_DISCORD_USER_ID"],
    "guilds": [
      {
        "name": "my-server",
        "guild_id": "...",
        "triage_channel_id": "...",
        "channels": [...]
      }
    ]
  }
}
```

| Config key | Description |
|------------|-------------|
| `discord.triage_user_ids` | Array of Discord user IDs (snowflakes) allowed to use triage buttons. Checked alongside `github.collaborators`. |
| `guild.triage_channel_id` | Discord channel ID of the private admin channel where triage notifications are posted. |
| `dispatch.discord_mode` | Set to `"triage"` to enable triage mode, or pass `--dispatch-mode triage` on the CLI. |

### Access control

Button clicks are verified against two lists:
- `github.collaborators` -- GitHub usernames (matched against Discord username)
- `discord.triage_user_ids` -- Discord user IDs (exact snowflake match)

Non-authorized users get an ephemeral "Only maintainers can use triage controls" reply.

### Supported source types

Triage mode handles messages from:
- **Text channels** -- Regular channel messages
- **Threads** -- Messages inside threads (resolved to parent channel config)
- **Forum posts** -- Forum channel posts (resolved to parent forum channel config)
- **GitHub issues/PRs** -- (via cycle-based detection, routed to the same triage UI)

## Dispatch pipeline in cycle mode

The dispatch gate runs after issue filtering and security scanning, before LLM invocation:

1. `createDetections()` -- creates detection issues for new eligible issues
2. `cleanupStaleDetections()` -- cancels detections for issues no longer eligible
3. `checkApprovals()` -- checks reactions/comments, advances countdown stages
4. If no approved issues, skip LLM entirely
5. After investigations complete, `markDispatched()` updates state and `closeDispatchedDetections()` closes detection issues with cross-links

## Source files

| File | Purpose |
|------|---------|
| `src/dispatch/types.ts` | Type definitions: `DispatchMode`, `DetectionRecord`, `DispatchConfig` |
| `src/dispatch/orchestrator.ts` | Main entry point: `runDispatch()`, `runDiscordDispatch()` |
| `src/dispatch/detection.ts` | Creates detection issues (GitHub + Discord) |
| `src/dispatch/approval.ts` | Checks reactions/comments, advances countdown stages |
| `src/dispatch/lifecycle.ts` | Post-dispatch cleanup: mark dispatched, close detections |
| `src/dispatch/sanitize.ts` | Security helpers for untrusted content |
| `src/triage/types.ts` | `TriageRecord`, button ID helpers, guild shortname mapping |
| `src/triage/notification.ts` | Embed builder, button rows, post/update triage messages |
| `src/triage/handler.ts` | InteractionCreate handler, button routing, thread posting |
| `src/triage/investigation.ts` | Claude investigation wrapper, maintainer instruction fetching |
| `src/triage/send.ts` | Post approved responses to original source |
