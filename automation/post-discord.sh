#!/usr/bin/env bash
# post-discord.sh
#
# Posts a message to a Discord channel via webhook.
#
# Usage:
#   ./post-discord.sh "Your message content here"
#   ./post-discord.sh --file path/to/response.md
#
# Environment variables required:
#   DISCORD_WEBHOOK_URL  — Discord webhook URL for the target channel
#
# The script reads the message content from:
#   1. The first argument (for short messages)
#   2. A file specified with --file (for longer/formatted messages)
#
# Discord webhook messages have a 2000-character limit. If the content
# exceeds this, the script will split it into multiple messages.

set -euo pipefail

# --- Configuration ---

MAX_MESSAGE_LENGTH=2000

# --- Validation ---

if [[ -z "${DISCORD_WEBHOOK_URL:-}" ]]; then
  echo "ERROR: DISCORD_WEBHOOK_URL environment variable is not set." >&2
  echo "" >&2
  echo "To create a webhook:" >&2
  echo "  1. Go to your Discord server settings" >&2
  echo "  2. Navigate to Integrations > Webhooks" >&2
  echo "  3. Create a new webhook for the target channel" >&2
  echo "  4. Copy the webhook URL" >&2
  exit 1
fi

# --- Parse Arguments ---

MESSAGE=""

if [[ "${1:-}" == "--file" ]]; then
  if [[ -z "${2:-}" ]]; then
    echo "ERROR: --file requires a file path argument." >&2
    exit 1
  fi
  if [[ ! -f "$2" ]]; then
    echo "ERROR: File not found: $2" >&2
    exit 1
  fi

  # Read the file, stripping YAML frontmatter if present
  MESSAGE=$(python3 -c "
import sys

content = open(sys.argv[1], 'r', encoding='utf-8').read()

# Strip YAML frontmatter (--- ... ---)
if content.startswith('---'):
    end = content.find('---', 3)
    if end != -1:
        content = content[end + 3:].strip()

print(content)
" "$2" 2>/dev/null || cat "$2")

elif [[ -n "${1:-}" ]]; then
  MESSAGE="$1"
else
  echo "Usage: $0 \"message content\"" >&2
  echo "       $0 --file path/to/response.md" >&2
  exit 1
fi

if [[ -z "$MESSAGE" ]]; then
  echo "ERROR: Message content is empty." >&2
  exit 1
fi

# --- Helper Functions ---

# Post a single message chunk to the Discord webhook.
# Returns 0 on success, 1 on failure.
post_chunk() {
  local content="$1"

  # Escape the content for JSON
  local json_content
  json_content=$(python3 -c "
import sys, json
print(json.dumps(sys.stdin.read()))
" <<< "$content" 2>/dev/null)

  local payload="{\"content\": ${json_content}}"

  local response
  local http_code
  http_code=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST \
    -H "Content-Type: application/json" \
    -d "${payload}" \
    "${DISCORD_WEBHOOK_URL}")

  if [[ "$http_code" == "204" ]] || [[ "$http_code" == "200" ]]; then
    return 0
  else
    echo "WARNING: Discord webhook returned HTTP ${http_code}" >&2
    return 1
  fi
}

# Split a message into chunks that fit within Discord's character limit.
# Tries to split on newlines for cleaner breaks.
split_and_post() {
  local content="$1"
  local chunk_num=1

  while [[ ${#content} -gt 0 ]]; do
    if [[ ${#content} -le $MAX_MESSAGE_LENGTH ]]; then
      # Fits in one message
      echo "  Posting chunk ${chunk_num} (${#content} chars)..."
      post_chunk "$content"
      break
    fi

    # Find a good split point (prefer newline, then space)
    local split_at=$MAX_MESSAGE_LENGTH
    local segment="${content:0:$MAX_MESSAGE_LENGTH}"

    # Try to split at a newline
    local last_newline
    last_newline=$(echo "$segment" | grep -b -o $'\n' | tail -1 | cut -d: -f1 || echo "")
    if [[ -n "$last_newline" ]] && [[ "$last_newline" -gt $((MAX_MESSAGE_LENGTH / 2)) ]]; then
      split_at=$last_newline
    fi

    local chunk="${content:0:$split_at}"
    echo "  Posting chunk ${chunk_num} (${#chunk} chars)..."
    post_chunk "$chunk"

    content="${content:$split_at}"
    # Trim leading whitespace from the remainder
    content="${content#"${content%%[![:space:]]*}"}"

    chunk_num=$((chunk_num + 1))

    # Rate limit: avoid hitting Discord's webhook rate limits
    sleep 1
  done
}

# --- Main Logic ---

echo "=== GameCI Help Bot — Post to Discord ==="
echo "Message length: ${#MESSAGE} characters"

if [[ ${#MESSAGE} -le $MAX_MESSAGE_LENGTH ]]; then
  echo "Posting single message..."
  if post_chunk "$MESSAGE"; then
    echo "Message posted successfully."
  else
    echo "ERROR: Failed to post message." >&2
    exit 1
  fi
else
  echo "Message exceeds ${MAX_MESSAGE_LENGTH} chars, splitting..."
  split_and_post "$MESSAGE"
  echo "All chunks posted."
fi

echo "=== Done ==="
