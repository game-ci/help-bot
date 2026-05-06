# Notifications

## Discord DM Notifications

Maintainers can opt in to receive direct messages from the bot on Discord when notable events occur. Disabled by default.

### Configuration

```json
{
  "notifications": {
    "discord_dm": {
      "enabled": false,
      "recipients": [
        {
          "discord_user_id": "123456789012345678",
          "github_username": "maintainer-name",
          "filters": {
            "new_detections": true,
            "approvals": true,
            "countdown_warnings": true,
            "investigations_complete": true,
            "cycle_reports": false
          }
        }
      ]
    }
  }
}
```

### Notification Types

| Filter | Triggers When |
|--------|--------------|
| `new_detections` | New detection issues are created for eligible source issues |
| `approvals` | Issues are approved for investigation (by reaction or countdown expiry) |
| `countdown_warnings` | Countdown warning stages are posted to detection issues |
| `investigations_complete` | Investigation issues are posted after LLM analysis |
| `cycle_reports` | A cycle completes with meaningful activity |

### Requirements

- `DISCORD_BOT_TOKEN` must be set
- The bot must share a server with the recipient (Discord requirement for DMs)
- Recipients provide their Discord user ID (numeric snowflake ID, not username)

### Source Files

| File | Purpose |
|------|---------|
| `src/notify/discord-dm.ts` | DM notification logic, Discord API integration |
| `src/notify/index.ts` | Barrel exports |

## Cycle Reports

After each cycle, the bot generates a cycle report summarizing investigations, filter results, dispatch pipeline status, and cross-issue patterns.

### Spam Prevention

- **Skip if idle**: No investigations, no responses, no dispatch activity — report not posted
- **Date dedup**: Only one report per calendar date
- **Dispatch stats**: Reports include detection pipeline status

Reports are posted as GitHub issues with labels `help-bot` and `cycle-report`.
