# Social Content & Community Announcements

The social content module enables maintainers to create, iterate on, and publish social media posts and community announcements through Discord. It runs as a second module alongside the help case investigation system.

## Overview

The module provides a complete content creation pipeline:
1. **Request** — A maintainer triggers content creation via `@bot social <topic>` in Discord
2. **Draft** — The bot spawns an LLM investigation to generate a content plan
3. **Review** — The draft is posted in a review thread for feedback and iteration
4. **Revise** — Maintainers provide feedback in the thread; the bot revises the draft incorporating feedback
5. **Approve** — A maintainer approves the final version
6. **Commit** — The approved content is committed and pushed to the repository for permanent history

## Triggering Content Creation

In any monitored Discord channel (or the triage channel), mention the bot with the `social` keyword:

```
@GameCI Help Bot social Announcing the new Unity 6 support in game-ci/docker
```

The bot will:
- Confirm the request in-channel
- Post a notification card with action buttons to the triage channel
- Save a `ContentRecord` to `state.json`

Only maintainers (listed in `config.json` `github.collaborators` or `discord.triage_user_ids`) can create content.

## Content Lifecycle

Each piece of content goes through these statuses:

| Status | Description | Available Actions |
|--------|-------------|-------------------|
| `topic_received` | Request logged, waiting for drafting | Draft, Discard |
| `drafting` | LLM is generating a draft | (in progress) |
| `draft_ready` | Draft generated, ready for review | Approve, Revise, View Full, Discard |
| `revising` | LLM is revising based on feedback | (in progress) |
| `approved` | Content approved by a maintainer | Commit & Push, Revise, Discard |
| `committed` | Content committed to the repository | (terminal) |
| `discarded` | Content was discarded | (terminal) |

## Discord Button Interactions

The triage channel notification includes action buttons that change based on status:

- **Draft Content** — Start LLM drafting (from `topic_received`)
- **Approve** — Mark the draft as approved (from `draft_ready`)
- **Revise** — Re-run LLM with thread feedback incorporated (from `draft_ready` or `approved`)
- **View Full** — Post the full draft text to the review thread
- **Commit & Push** — Commit the approved draft to git and push (from `approved`)
- **Discard** — Cancel the content request (from any non-terminal status)

## Review Thread

When a draft is generated, the bot creates (or reuses) a thread attached to the triage notification message:

- The thread is named `Content: <topic>` (truncated to 88 chars)
- Each draft or revision is posted to the thread with a header: `**Draft:**` or `**Revision #N:**`
- Maintainers post feedback in the thread
- When "Revise" is clicked, all non-bot messages in the thread are collected and passed to the LLM as feedback

This enables iterative refinement: draft → feedback → revise → feedback → revise → approve.

## Permanent File History

All content is stored permanently in the repository:

### Draft Files
- **Location**: `data/responses/social/`
- **Naming**: `social-{platform}-{contentId}[-revN].md`
- **Format**: YAML frontmatter + Markdown body

```yaml
---
type: social-content
platform: linkedin
topic: "Announcing Unity 6 support"
requested_by: "maintainer#1234"
status: draft
revision: 0
created_at: "2026-05-06T12:00:00.000Z"
---

## Post Content

(The social media post text)

## Image Concepts

(Image descriptions with dimensions and alt text)

## Hashtags

(Hashtag suggestions with rationale)

## Posting Notes

(Timing and audience notes)
```

### Committed Files
When content is approved and committed, it is saved to the `content/` directory and pushed to git, creating a permanent audit trail of all published content.

## Configuration

In `config.json`:

```json
{
  "social": {
    "enabled": true,
    "content_dir": "content",
    "platforms": ["linkedin"],
    "linkedin": {
      "max_length": 3000,
      "default_hashtags": ["#GameCI", "#Unity", "#CICD", "#GameDev"],
      "tone": "professional, technically credible, community-focused"
    }
  }
}
```

### Platform-Specific Settings

| Setting | Description |
|---------|-------------|
| `max_length` | Maximum character count for the platform |
| `default_hashtags` | Always-included hashtags |
| `tone` | Tone/voice guidance for the LLM |

## Content Guidelines (LinkedIn)

The LLM generates content following these guidelines:
- **Tone**: Professional, technically credible, community-focused
- **Length**: 1300–2500 characters (LinkedIn optimal range)
- **Structure**: Hook → Context → Core content → Call to action → Hashtags
- **Voice**: First-person plural ("we") is appropriate for official project communications
- **No emoji in body text** — hashtags only at the end
- **Technical credibility**: Specific technical details, not vague marketing

## Source Files

| File | Purpose |
|------|---------|
| `src/social/handler.ts` | Content request handling, button interaction routing, draft/revise/approve/commit/discard actions |
| `src/social/drafting.ts` | LLM prompt construction and Claude invocation for draft generation |
| `src/social/notification.ts` | Discord embed and button component builders |
| `src/social/commit.ts` | Git commit and push of approved content |
| `src/social/types.ts` | `ContentRecord`, `ContentStatus`, button ID helpers |
| `src/social/index.ts` | Barrel exports |
