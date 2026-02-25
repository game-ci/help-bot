#!/usr/bin/env bash
# run-help-cycle.sh
#
# Main orchestrator for the GameCI Help Bot. This is the entry point that
# runs a complete help cycle:
#
#   1. Sync data from all sources (Discord, GitHub, docs)
#   2. Run Claude Code to process new messages and draft responses
#   3. Post drafted responses back to Discord
#
# This script is designed to be run periodically (e.g., every 30 minutes
# via GitHub Actions) or manually for testing.
#
# Environment variables required:
#   DISCORD_BOT_TOKEN    — Discord bot token for reading messages
#   DISCORD_GUILD_ID     — Discord server (guild) ID
#   DISCORD_WEBHOOK_URL  — Discord webhook URL for posting responses
#   ANTHROPIC_API_KEY    — API key for Claude
#
# Optional environment variables:
#   SYNC_HOURS           — Hours of Discord history to sync (default: 24)
#   SYNC_DAYS            — Days of GitHub history to sync (default: 7)
#   DRY_RUN              — Set to "true" to skip posting responses (default: false)
#   CLAUDE_MODEL         — Claude model to use (default: claude-sonnet-4-20250514)

set -euo pipefail

# --- Configuration ---

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
RESPONSES_DIR="${REPO_DIR}/data/responses"
DRY_RUN="${DRY_RUN:-false}"
CLAUDE_MODEL="${CLAUDE_MODEL:-claude-sonnet-4-20250514}"

# --- Validation ---

echo "=== GameCI Help Bot — Help Cycle ==="
echo "Repository: ${REPO_DIR}"
echo "Dry run: ${DRY_RUN}"
echo "Timestamp: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo ""

# Check required tools
for cmd in curl python3 claude; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: Required command '${cmd}' not found." >&2
    exit 1
  fi
done

# Check required environment variables
MISSING_VARS=()
[[ -z "${DISCORD_BOT_TOKEN:-}" ]] && MISSING_VARS+=("DISCORD_BOT_TOKEN")
[[ -z "${DISCORD_GUILD_ID:-}" ]] && MISSING_VARS+=("DISCORD_GUILD_ID")
[[ -z "${DISCORD_WEBHOOK_URL:-}" ]] && MISSING_VARS+=("DISCORD_WEBHOOK_URL")
[[ -z "${ANTHROPIC_API_KEY:-}" ]] && MISSING_VARS+=("ANTHROPIC_API_KEY")

if [[ ${#MISSING_VARS[@]} -gt 0 ]]; then
  echo "ERROR: Missing required environment variables:" >&2
  for var in "${MISSING_VARS[@]}"; do
    echo "  - ${var}" >&2
  done
  exit 1
fi

# --- Step 1: Sync Data Sources ---

echo "=========================================="
echo "Step 1: Syncing data sources"
echo "=========================================="
echo ""

echo "--- Syncing Discord ---"
bash "${SCRIPT_DIR}/sync-discord.sh" || {
  echo "WARNING: Discord sync failed, continuing with available data." >&2
}
echo ""

echo "--- Syncing GitHub ---"
bash "${SCRIPT_DIR}/sync-github.sh" || {
  echo "WARNING: GitHub sync failed, continuing with available data." >&2
}
echo ""

echo "--- Syncing Documentation ---"
bash "${SCRIPT_DIR}/sync-docs.sh" || {
  echo "WARNING: Documentation sync failed, continuing with available data." >&2
}
echo ""

# --- Step 2: Process with Claude Code ---

echo "=========================================="
echo "Step 2: Processing with Claude Code"
echo "=========================================="
echo ""

# Clear previous responses
rm -rf "${RESPONSES_DIR}/discord/"*.md "${RESPONSES_DIR}/github/"*.md 2>/dev/null || true
mkdir -p "${RESPONSES_DIR}/discord" "${RESPONSES_DIR}/github"

# Build the prompt for Claude Code.
# The CLAUDE.md in the repository root defines the bot's identity and rules.
# We give Claude a specific task for this cycle.
CLAUDE_PROMPT="$(cat <<'PROMPT_EOF'
You are running a help cycle for the GameCI Community Help Bot.

Your task:

1. Check data/discord/channels/ for new messages from the last sync.
   - Identify messages that are questions or requests for help about GameCI.
   - For each question, search data/docs/ for relevant documentation.
   - Draft a helpful response following the Discord formatting guidelines in CLAUDE.md.
   - Write each response to data/responses/discord/{channel}-{timestamp}.md with frontmatter
     containing: channel, reply_to_message_id, author_username.

2. Check data/github/issues/ for issues that need triage or responses.
   - Focus on issues that are newly opened or have recent unanswered comments.
   - For each issue, search data/docs/ for relevant documentation.
   - Draft a helpful response following the GitHub formatting guidelines in CLAUDE.md.
   - Write each response to data/responses/github/{repo}-{number}-{timestamp}.md with frontmatter
     containing: repo, issue_number, classification, suggested_labels.

3. Skip messages/issues that:
   - Are casual conversation (greetings, thanks, off-topic chat)
   - Have already been adequately answered
   - Are from bots
   - Are out of scope (general Unity development, non-CI topics)

4. If there are no new messages or issues requiring responses, write nothing to data/responses/.

Be concise and helpful. Follow all guidelines in CLAUDE.md.
PROMPT_EOF
)"

echo "Running claude -p with model ${CLAUDE_MODEL}..."
echo ""

# Run Claude Code in print mode (non-interactive).
# The working directory is the repo root so CLAUDE.md is automatically loaded.
cd "${REPO_DIR}"
claude -p "${CLAUDE_PROMPT}" --model "${CLAUDE_MODEL}" 2>&1 || {
  echo "ERROR: Claude Code processing failed." >&2
  exit 1
}

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

# Post Discord responses
if [[ "$DISCORD_RESPONSES" -gt 0 ]]; then
  echo "--- Posting Discord responses ---"

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  DRY RUN: Would post ${DISCORD_RESPONSES} Discord responses"
    for response_file in "${RESPONSES_DIR}/discord/"*.md; do
      echo "  - $(basename "$response_file")"
    done
  else
    for response_file in "${RESPONSES_DIR}/discord/"*.md; do
      echo "  Posting: $(basename "$response_file")"
      bash "${SCRIPT_DIR}/post-discord.sh" --file "$response_file" || {
        echo "  WARNING: Failed to post $(basename "$response_file")" >&2
      }
      # Rate limit between posts
      sleep 2
    done
  fi
  echo ""
fi

# Note: GitHub responses require the gh CLI or GitHub API to post as comments.
# For now, we log them. A future enhancement can post them automatically.
if [[ "$GITHUB_RESPONSES" -gt 0 ]]; then
  echo "--- GitHub responses (manual review) ---"
  echo "  ${GITHUB_RESPONSES} GitHub responses drafted for review."
  echo "  Files are in: ${RESPONSES_DIR}/github/"
  for response_file in "${RESPONSES_DIR}/github/"*.md; do
    echo "  - $(basename "$response_file")"
  done
  echo ""
  echo "  NOTE: Automatic GitHub comment posting is not yet implemented."
  echo "  Review responses and post manually or via 'gh issue comment'."
fi

# --- Summary ---

echo ""
echo "=========================================="
echo "Help cycle complete"
echo "=========================================="
echo "  Discord responses posted: ${DISCORD_RESPONSES}"
echo "  GitHub responses drafted: ${GITHUB_RESPONSES}"
echo "  Timestamp: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "=== Done ==="
