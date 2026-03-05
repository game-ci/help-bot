# Feedback & reporting

Responses include metadata (reactions, heuristic flags) in `data/responses/feedback.jsonl`. That file stores a JSON line per feedback entry with `responseId`, `verdict` (`good` or `bad`), optional `note`, and timestamp.

### Commands

- `gameci-help-bot feedback mark-good <responseId> [--note "..."]`: Tag the reply as helpful.  
- `gameci-help-bot feedback mark-bad <responseId> [--note "..."]`: Mark it for follow-up.

### Reports

- `gameci-help-bot report summary` prints:
  - Discord messages synced, responses posted/skipped.  
  - GitHub issues/releases/tags synced, responses posted/skipped.  
  - Feedback totals (good vs. bad) plus the timestamp of the last cycle.  
- Use the summary to decide whether a cycle needs a rerun, whether certain threads were skipped because an official contributor replied, or whether to tweak `config.json` filters.
