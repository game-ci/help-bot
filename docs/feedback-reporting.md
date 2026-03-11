# Feedback and reporting

The bot tracks response quality through two mechanisms: automatic reaction polling and manual feedback marking.

## Automatic reaction feedback

Every posted response includes a footer asking users to react with thumbs up or thumbs down. Each cycle, `syncFeedback()` polls reactions on all tracked bot comments via the GitHub API and records:

- Thumbs up/down counts and user lists
- Net sentiment classification (positive/negative/neutral/unknown)

Results are written to `data/feedback/feedback-summary.md`, which the LLM reads during investigations to learn from past positive and negative feedback patterns.

## Manual feedback

```bash
gameci-help-bot feedback mark-good <responseId> [--note "..."]
gameci-help-bot feedback mark-bad <responseId> [--note "..."]
```

Manual entries are stored in `data/responses/feedback.jsonl` as one JSON line per entry with `responseId`, `verdict` (`good` or `bad`), optional `note`, and timestamp.

## Reports

```bash
gameci-help-bot report summary
```

Prints:
- Discord messages synced, responses posted/skipped
- GitHub issues/releases/tags synced, responses posted/skipped
- Feedback totals (good vs. bad) plus the timestamp of the last cycle

Use the summary to decide whether a cycle needs a rerun, whether certain threads were skipped because an official contributor replied, or whether to tweak `config.json` filters.
