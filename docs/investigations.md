# Investigations

When `--investigation-issues` is passed (or `investigations.enabled` is true in config.json), the bot creates GitHub issues in a target repo (default: `game-ci/help-bot`) for each completed investigation.

## Purpose

- **Audit trail**: Every investigation is recorded as a GitHub issue with full analysis
- **Interaction surface**: Maintainers and contributors can comment on investigation issues to provide feedback, corrections, or additional context
- **Cross-linking**: Investigation issues reference the source issue and all related issues discovered during analysis

## Configuration

```json
{
  "investigations": {
    "enabled": false,
    "target_repo": "game-ci/help-bot",
    "labels": ["help-bot", "investigation"]
  }
}
```

CLI: `--investigation-issues` enables it, `--investigation-repo <repo>` overrides the target. Both obey `--dry-run`.

## Investigation File Format

Investigation files use extended frontmatter:

```yaml
---
type: investigation
issue_number: 700
repo: game-ci/unity-builder
title: "Build failed on self-hosted macOS"
classification: bug
related_issues: [615, 649, 690, 715]
---
```

Fields:
- `type`: Always `investigation`
- `issue_number`: Source issue number
- `repo`: Source repo in `owner/repo` format
- `title`: Source issue title (used for investigation issue title)
- `classification`: One of `bug`, `user-error`, `limitation`, `feature-request`
- `related_issues`: Array of related issue numbers from the same repo

## Cross-Issue Analysis

During each investigation, the bot MUST:

1. **Search for related issues** by error message, platform, labels, and symptoms
2. **Identify patterns** — when multiple issues report the same root cause, note this explicitly
3. **Cross-reference** — mention related issues in both the investigation file and the user-facing response
4. **Detect duplicates** — if an issue is a duplicate of a better-described issue, say so and link to it

## Bug Detection & Reporting

When investigating an issue, the bot assesses whether it represents:

- **User error / misconfiguration**: Provide guidance on correct usage
- **Known limitation**: Document clearly and suggest workarounds
- **Potential bug**: Document with evidence from the source code

When a bug is identified:

1. The investigation file includes a `## Bug Discovery` section with:
   - Exact file path and line numbers in the source code
   - Description of the buggy behavior vs expected behavior
   - Impact assessment
   - Suggested fix direction
2. The `classification` frontmatter field is set to `bug`
3. The user-facing response explains the root cause factually without promising fixes
4. Related issues that share the same bug are noted

The bot NEVER creates issues in the target project's repo on behalf of maintainers. It only creates investigation issues in its own tracking repo.
