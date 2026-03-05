#!/usr/bin/env bash
# run-help-cycle.sh
#
# Main orchestrator for the GameCI Help Bot. This is the entry point that
# runs a complete help cycle:
#
#   1. Sync data from all sources (Discord, GitHub, docs)
#   2. Run Claude Code to process new messages and draft responses
#   3. Post drafted responses to Discord and GitHub
#   4. Log what was processed
#
# This script is designed to be run periodically (e.g., every 30 minutes
# via GitHub Actions) or manually for testing.
#
# Environment variables required:
#   DISCORD_BOT_TOKEN    -- Discord bot token for reading messages
#   DISCORD_GUILD_ID     -- Discord server (guild) ID
#   DISCORD_WEBHOOK_URL  -- Discord webhook URL for posting responses
#   ANTHROPIC_API_KEY    -- API key for Claude
#
# Optional environment variables:
#   SYNC_HOURS           -- Hours of Discord history to sync (default from config.json)
#   SYNC_DAYS            -- Days of GitHub history to sync (default from config.json)
#   DRY_RUN              -- Set to "true" to skip posting responses (default: false)
#   CLAUDE_MODEL         -- Claude model to use (default from config.json)
#   SKIP_SYNC            -- Set to "true" to skip data syncing (use existing data)
#   SKIP_GITHUB_POST     -- Set to "true" to skip posting GitHub comments

set -euo pipefail

# --- Configuration ---

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
RESPONSES_DIR="${REPO_DIR}/data/responses"
LOG_DIR="${REPO_DIR}/data/logs"
CONFIG_FILE="${REPO_DIR}/config.json"
DRY_RUN="${DRY_RUN:-false}"
SKIP_SYNC="${SKIP_SYNC:-false}"
SKIP_GITHUB_POST="${SKIP_GITHUB_POST:-false}"

TOKEN_HELPER="${SCRIPT_DIR}/discord-token-helper.sh"
if [[ -f "${TOKEN_HELPER}" ]]; then
  source "${TOKEN_HELPER}"
  if ! ensure_discord_token; then
    echo "ERROR: Unable to obtain a valid Discord bot token." >&2
    exit 1
  fi
fi

# Source LLM provider abstraction
source "${SCRIPT_DIR}/llm-provider.sh"

# Load settings from config.json if available
if [[ -f "${CONFIG_FILE}" ]] && command -v python3 &>/dev/null; then
  MAX_RESPONSES=$(python3 -c "
import json
with open('${CONFIG_FILE}') as f:
    cfg = json.load(f)
print(cfg.get('bot', {}).get('max_responses_per_cycle', 10))
" 2>/dev/null || echo "10")
else
  MAX_RESPONSES="10"
fi

LLM_PROVIDER_NAME=$(detect_provider)
CYCLE_TIMESTAMP=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
CYCLE_ID=$(date -u '+%Y%m%d-%H%M%S')

# --- Logging ---

mkdir -p "${LOG_DIR}"
LOG_FILE="${LOG_DIR}/cycle-${CYCLE_ID}.log"

# Tee output to both stdout and log file
exec > >(tee -a "${LOG_FILE}") 2>&1

# --- Validation ---

echo "=== GameCI Help Bot -- Help Cycle ==="
echo "Cycle ID: ${CYCLE_ID}"
echo "Repository: ${REPO_DIR}"
echo "LLM provider: ${LLM_PROVIDER_NAME}"
echo "Max responses: ${MAX_RESPONSES}"
echo "Dry run: ${DRY_RUN}"
echo "Skip sync: ${SKIP_SYNC}"
echo "Timestamp: ${CYCLE_TIMESTAMP}"
echo ""

# Check required tools
MISSING_TOOLS=()
for cmd in curl python3; do
  if ! command -v "$cmd" &>/dev/null; then
    MISSING_TOOLS+=("$cmd")
  fi
done

# claude CLI is only required when using the Claude provider
if [[ "$LLM_PROVIDER_NAME" == "claude" ]] && ! command -v claude &>/dev/null; then
  MISSING_TOOLS+=("claude")
fi

if [[ ${#MISSING_TOOLS[@]} -gt 0 ]]; then
  echo "ERROR: Missing required tools: ${MISSING_TOOLS[*]}" >&2
  exit 1
fi

# Check required environment variables
MISSING_VARS=()
[[ -z "${DISCORD_BOT_TOKEN:-}" ]] && MISSING_VARS+=("DISCORD_BOT_TOKEN")
[[ -z "${DISCORD_GUILD_ID:-}" ]] && MISSING_VARS+=("DISCORD_GUILD_ID")
[[ -z "${DISCORD_WEBHOOK_URL:-}" ]] && MISSING_VARS+=("DISCORD_WEBHOOK_URL")
# ANTHROPIC_API_KEY is only required for the Claude provider
if [[ "$LLM_PROVIDER_NAME" == "claude" ]]; then
  [[ -z "${ANTHROPIC_API_KEY:-}" ]] && MISSING_VARS+=("ANTHROPIC_API_KEY")
fi

if [[ ${#MISSING_VARS[@]} -gt 0 ]]; then
  echo "ERROR: Missing required environment variables:" >&2
  for var in "${MISSING_VARS[@]}"; do
    echo "  - ${var}" >&2
  done
  exit 1
fi

# gh CLI is optional (needed for GitHub posting only)
GH_AVAILABLE=false
if command -v gh &>/dev/null && gh auth status &>/dev/null 2>&1; then
  GH_AVAILABLE=true
fi

# --- Step 1: Sync Data Sources ---

if [[ "$SKIP_SYNC" != "true" ]]; then
  echo "=========================================="
  echo "Step 1: Syncing data sources"
  echo "=========================================="
  echo ""

  SYNC_ERRORS=0

  echo "--- Syncing Discord ---"
  if bash "${SCRIPT_DIR}/sync-discord.sh"; then
    echo "Discord sync: SUCCESS"
  else
    echo "WARNING: Discord sync failed, continuing with available data." >&2
    SYNC_ERRORS=$((SYNC_ERRORS + 1))
  fi
  echo ""

  echo "--- Syncing GitHub ---"
  if [[ "$GH_AVAILABLE" == "true" ]]; then
    if bash "${SCRIPT_DIR}/sync-github.sh"; then
      echo "GitHub sync: SUCCESS"
    else
      echo "WARNING: GitHub sync failed, continuing with available data." >&2
      SYNC_ERRORS=$((SYNC_ERRORS + 1))
    fi
  else
    echo "WARNING: gh CLI not available or not authenticated, skipping GitHub sync." >&2
    SYNC_ERRORS=$((SYNC_ERRORS + 1))
  fi
  echo ""

  echo "--- Syncing Documentation ---"
  if bash "${SCRIPT_DIR}/sync-docs.sh"; then
    echo "Documentation sync: SUCCESS"
  else
    echo "WARNING: Documentation sync failed, continuing with available data." >&2
    SYNC_ERRORS=$((SYNC_ERRORS + 1))
  fi
  echo ""

  if [[ $SYNC_ERRORS -eq 3 ]]; then
    echo "ERROR: All sync steps failed. Nothing to process." >&2
    exit 1
  fi
else
  echo "=========================================="
  echo "Step 1: SKIPPED (SKIP_SYNC=true)"
  echo "=========================================="
  echo ""
fi

# --- Step 2: Process with Claude Code ---

echo "=========================================="
echo "Step 2: Processing with Claude Code"
echo "=========================================="
echo ""

# Clear previous responses
rm -f "${RESPONSES_DIR}/discord/"*.md 2>/dev/null || true
rm -f "${RESPONSES_DIR}/github/"*.md 2>/dev/null || true
mkdir -p "${RESPONSES_DIR}/discord" "${RESPONSES_DIR}/github"

# Count available data
DISCORD_FILES=$(find "${REPO_DIR}/data/discord/channels" -name "*.jsonl" 2>/dev/null | wc -l | tr -d ' ')
GITHUB_ISSUE_FILES=$(find "${REPO_DIR}/data/github/issues" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
DOCS_FILES=$(find "${REPO_DIR}/data/docs" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')

echo "Available data:"
echo "  Discord message files: ${DISCORD_FILES}"
echo "  GitHub issue files: ${GITHUB_ISSUE_FILES}"
echo "  Documentation pages: ${DOCS_FILES}"
echo ""

if [[ "$DISCORD_FILES" -eq 0 ]] && [[ "$GITHUB_ISSUE_FILES" -eq 0 ]]; then
  echo "No data to process. Skipping Claude Code invocation."
else
  # Build the prompt for Claude Code.
  # The CLAUDE.md in the repository root defines the bot's identity and rules.
  CLAUDE_PROMPT=$(cat <<PROMPT_EOF
You are running a help cycle for the GameCI Community Help Bot.
Cycle ID: ${CYCLE_ID}
Maximum responses this cycle: ${MAX_RESPONSES}

Read config.json for current settings before starting.

Your tasks:

1. **Discord messages** -- Check data/discord/channels/ for new messages.
   - Read JSONL files (each line is a JSON message object).
   - Identify messages that are questions or help requests about GameCI topics.
   - Skip: bot messages (is_bot: true), already-answered messages (has_reply: true),
     messages under 15 chars, messages starting with !, /, $, or . prefixes,
     casual conversation, and out-of-scope topics.
   - For each question, search data/docs/ for relevant documentation.
   - Draft a helpful response following Discord formatting guidelines in CLAUDE.md.
   - Write each response to data/responses/discord/{channel}-{message_id}.md
     with YAML frontmatter: channel, channel_id, reply_to_message_id, author_username, question_summary.

2. **GitHub issues** -- Check data/github/issues/ for issues needing responses.
   - Focus on OPEN issues with 0 comments or where the latest comment is unanswered.
   - Skip issues with labels: wontfix, invalid, duplicate.
   - Classify each as: bug, question, feature-request, documentation, duplicate, or not-gameci.
   - Search data/docs/ for relevant documentation.
   - Draft a response with GitHub-flavored markdown.
   - Write each response to data/responses/github/{repo}-{number}.md
     with YAML frontmatter: repo, issue_number, classification, suggested_labels, duplicate_of, needs_info, confidence.

3. **Prioritize** -- If there are more items than the max responses limit (${MAX_RESPONSES}),
   prioritize: bugs > unanswered help channel messages > questions > feature requests.

4. **Skip** if:
   - The message/issue is casual conversation or off-topic
   - It has already been adequately answered
   - It is from a bot
   - It is out of scope for GameCI

5. If there are no items requiring responses, write nothing to data/responses/.

Be concise and helpful. Follow all guidelines in CLAUDE.md.
Do not explain your reasoning -- just read, search, draft, and write.
PROMPT_EOF
)

  echo "Running LLM provider: ${LLM_PROVIDER_NAME}..."
  echo ""

  # Run the configured LLM provider.
  # For Claude, this runs `claude -p` with the repo as working directory.
  # For LM Studio / Continue, this calls the respective API/CLI.
  if run_llm_provider "${CLAUDE_PROMPT}" "${REPO_DIR}" 2>&1; then
    echo ""
    echo "LLM processing: SUCCESS"
  else
    echo ""
    echo "ERROR: LLM processing failed." >&2
    # Don't exit -- try to post any responses that were written before failure
  fi
fi

echo ""

# --- Step 3: Post Responses ---

echo "=========================================="
echo "Step 3: Posting responses"
echo "=========================================="
echo ""

# Count drafted responses
DISCORD_RESPONSES=$(find "${RESPONSES_DIR}/discord" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
GITHUB_RESPONSES=$(find "${RESPONSES_DIR}/github" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')

echo "Drafted responses: ${DISCORD_RESPONSES} Discord, ${GITHUB_RESPONSES} GitHub"
echo ""

POSTED_DISCORD=0
POSTED_GITHUB=0
FAILED_DISCORD=0
FAILED_GITHUB=0

# Post Discord responses
if [[ "$DISCORD_RESPONSES" -gt 0 ]]; then
  echo "--- Posting Discord responses ---"

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  DRY RUN: Would post ${DISCORD_RESPONSES} Discord responses:"
    for response_file in "${RESPONSES_DIR}/discord/"*.md; do
      [[ -f "$response_file" ]] || continue
      echo "  - $(basename "$response_file")"
    done
  else
    for response_file in "${RESPONSES_DIR}/discord/"*.md; do
      [[ -f "$response_file" ]] || continue
      echo "  Posting: $(basename "$response_file")"
      if bash "${SCRIPT_DIR}/post-discord.sh" --file "$response_file" --username "GameCI Help Bot"; then
        POSTED_DISCORD=$((POSTED_DISCORD + 1))
      else
        echo "  WARNING: Failed to post $(basename "$response_file")" >&2
        FAILED_DISCORD=$((FAILED_DISCORD + 1))
      fi
      # Rate limit between posts
      sleep 2
    done
  fi
  echo ""
fi

# Post GitHub responses
if [[ "$GITHUB_RESPONSES" -gt 0 ]]; then
  echo "--- Posting GitHub responses ---"

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  DRY RUN: Would post ${GITHUB_RESPONSES} GitHub comments:"
    for response_file in "${RESPONSES_DIR}/github/"*.md; do
      [[ -f "$response_file" ]] || continue
      echo "  - $(basename "$response_file")"
    done
  elif [[ "$SKIP_GITHUB_POST" == "true" ]]; then
    echo "  SKIP: GitHub posting disabled (SKIP_GITHUB_POST=true)."
    echo "  ${GITHUB_RESPONSES} responses drafted for manual review in: ${RESPONSES_DIR}/github/"
  elif [[ "$GH_AVAILABLE" == "true" ]]; then
    for response_file in "${RESPONSES_DIR}/github/"*.md; do
      [[ -f "$response_file" ]] || continue

      # Extract repo and issue number from frontmatter
      local_repo=$(python3 -c "
import sys
content = open(sys.argv[1], 'r').read()
for line in content.split('\n'):
    if line.startswith('repo:'):
        print(line.split(':', 1)[1].strip())
        break
" "$response_file" 2>/dev/null || echo "")

      local_number=$(python3 -c "
import sys
content = open(sys.argv[1], 'r').read()
for line in content.split('\n'):
    if line.startswith('issue_number:'):
        print(line.split(':', 1)[1].strip())
        break
" "$response_file" 2>/dev/null || echo "")

      if [[ -z "$local_repo" ]] || [[ -z "$local_number" ]]; then
        echo "  WARNING: Could not extract repo/issue from $(basename "$response_file"), skipping." >&2
        FAILED_GITHUB=$((FAILED_GITHUB + 1))
        continue
      fi

      # Extract the response body (strip frontmatter)
      local_body=$(python3 -c "
import sys
content = open(sys.argv[1], 'r').read()
if content.startswith('---'):
    end = content.find('---', 3)
    if end != -1:
        content = content[end + 3:].strip()
print(content)
" "$response_file" 2>/dev/null || echo "")

      if [[ -z "$local_body" ]]; then
        echo "  WARNING: Empty response body for $(basename "$response_file"), skipping." >&2
        FAILED_GITHUB=$((FAILED_GITHUB + 1))
        continue
      fi

      echo "  Posting comment on game-ci/${local_repo}#${local_number}..."
      if gh issue comment "${local_number}" \
        --repo "game-ci/${local_repo}" \
        --body "${local_body}" 2>/dev/null; then
        POSTED_GITHUB=$((POSTED_GITHUB + 1))
      else
        echo "  WARNING: Failed to post comment on ${local_repo}#${local_number}" >&2
        FAILED_GITHUB=$((FAILED_GITHUB + 1))
      fi

      sleep 1
    done
  else
    echo "  gh CLI not available. ${GITHUB_RESPONSES} responses drafted for manual review."
    echo "  Files are in: ${RESPONSES_DIR}/github/"
  fi
  echo ""
fi

# --- Summary ---

echo ""
echo "=========================================="
echo "Help Cycle Summary"
echo "=========================================="
echo "  Cycle ID: ${CYCLE_ID}"
echo "  Timestamp: ${CYCLE_TIMESTAMP}"
echo "  LLM provider: ${LLM_PROVIDER_NAME}"
echo "  Dry run: ${DRY_RUN}"
echo ""
echo "  Data synced:"
echo "    Discord message files: ${DISCORD_FILES:-0}"
echo "    GitHub issue files: ${GITHUB_ISSUE_FILES:-0}"
echo "    Documentation pages: ${DOCS_FILES:-0}"
echo ""
echo "  Responses:"
echo "    Discord drafted: ${DISCORD_RESPONSES}"
echo "    Discord posted: ${POSTED_DISCORD}"
echo "    Discord failed: ${FAILED_DISCORD}"
echo "    GitHub drafted: ${GITHUB_RESPONSES}"
echo "    GitHub posted: ${POSTED_GITHUB}"
echo "    GitHub failed: ${FAILED_GITHUB}"
echo ""
echo "  Log file: ${LOG_FILE}"
echo "=========================================="
echo "=== Help cycle complete ==="
