#!/usr/bin/env bash
# post-discord.sh
#
# Posts a message to a Discord channel via webhook.
#
# Usage:
#   ./post-discord.sh "Your message content here"
#   ./post-discord.sh --file path/to/response.md
#   ./post-discord.sh --file path/to/response.md --username "GameCI Bot"
#
# Environment variables required:
#   DISCORD_WEBHOOK_URL  -- Discord webhook URL for the target channel
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
BOT_USERNAME="GameCI Help Bot"
BOT_AVATAR_URL=""

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
RESPONSE_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --file)
      shift
      if [[ -z "${1:-}" ]]; then
        echo "ERROR: --file requires a file path argument." >&2
        exit 1
      fi
      RESPONSE_FILE="$1"
      shift
      ;;
    --username)
      shift
      if [[ -n "${1:-}" ]]; then
        BOT_USERNAME="$1"
      fi
      shift
      ;;
    --avatar)
      shift
      if [[ -n "${1:-}" ]]; then
        BOT_AVATAR_URL="$1"
      fi
      shift
      ;;
    *)
      MESSAGE="$1"
      shift
      ;;
  esac
done

# If --file was specified, read and process the file
if [[ -n "${RESPONSE_FILE}" ]]; then
  if [[ ! -f "${RESPONSE_FILE}" ]]; then
    echo "ERROR: File not found: ${RESPONSE_FILE}" >&2
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
" "${RESPONSE_FILE}" 2>/dev/null || {
    # Fallback: read file and strip frontmatter with sed
    sed '1{/^---$/!q;};1,/^---$/d' "${RESPONSE_FILE}"
  })
fi

if [[ -z "$MESSAGE" ]]; then
  echo "Usage: $0 \"message content\"" >&2
  echo "       $0 --file path/to/response.md" >&2
  echo "       $0 --file path/to/response.md --username \"Bot Name\"" >&2
  exit 1
fi

# --- Helper Functions ---

# Post a single message chunk to the Discord webhook.
# Returns 0 on success, 1 on failure.
post_chunk() {
  local content="$1"

  # Build the JSON payload using python3 for safe escaping
  local payload
  payload=$(python3 -c "
import sys, json

content = sys.stdin.read()
payload = {
    'content': content,
    'username': '${BOT_USERNAME}',
}
avatar = '${BOT_AVATAR_URL}'
if avatar:
    payload['avatar_url'] = avatar

print(json.dumps(payload))
" <<< "$content" 2>/dev/null)

  if [[ -z "$payload" ]]; then
    echo "ERROR: Failed to build JSON payload." >&2
    return 1
  fi

  local http_code
  http_code=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST \
    -H "Content-Type: application/json" \
    -d "${payload}" \
    "${DISCORD_WEBHOOK_URL}")

  if [[ "$http_code" == "204" ]] || [[ "$http_code" == "200" ]]; then
    return 0
  elif [[ "$http_code" == "429" ]]; then
    # Rate limited -- wait and retry once
    echo "  Rate limited. Waiting 5s and retrying..." >&2
    sleep 5
    http_code=$(curl -s -o /dev/null -w "%{http_code}" \
      -X POST \
      -H "Content-Type: application/json" \
      -d "${payload}" \
      "${DISCORD_WEBHOOK_URL}")
    if [[ "$http_code" == "204" ]] || [[ "$http_code" == "200" ]]; then
      return 0
    fi
    echo "WARNING: Discord webhook returned HTTP ${http_code} after retry" >&2
    return 1
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
  local total_chunks=$(( (${#content} + MAX_MESSAGE_LENGTH - 1) / MAX_MESSAGE_LENGTH ))

  while [[ ${#content} -gt 0 ]]; do
    if [[ ${#content} -le $MAX_MESSAGE_LENGTH ]]; then
      # Fits in one message
      echo "  Posting chunk ${chunk_num}/${total_chunks} (${#content} chars)..."
      if ! post_chunk "$content"; then
        echo "  ERROR: Failed to post chunk ${chunk_num}" >&2
        return 1
      fi
      break
    fi

    # Find a good split point within the message limit
    local segment="${content:0:$MAX_MESSAGE_LENGTH}"
    local split_at=$MAX_MESSAGE_LENGTH

    # Try to split at a code block boundary (```) to avoid breaking code blocks
    local code_fence
    code_fence=$(echo "$segment" | grep -b -o '```' | tail -1 | cut -d: -f1 || echo "")
    if [[ -n "$code_fence" ]] && [[ "$code_fence" -gt $((MAX_MESSAGE_LENGTH / 3)) ]]; then
      split_at=$code_fence
    else
      # Try to split at a blank line
      local blank_line
      blank_line=$(echo "$segment" | grep -b -o $'\n\n' | tail -1 | cut -d: -f1 || echo "")
      if [[ -n "$blank_line" ]] && [[ "$blank_line" -gt $((MAX_MESSAGE_LENGTH / 3)) ]]; then
        split_at=$blank_line
      else
        # Try to split at any newline
        local last_newline
        last_newline=$(echo "$segment" | grep -b -o $'\n' | tail -1 | cut -d: -f1 || echo "")
        if [[ -n "$last_newline" ]] && [[ "$last_newline" -gt $((MAX_MESSAGE_LENGTH / 2)) ]]; then
          split_at=$last_newline
        fi
      fi
    fi

    local chunk="${content:0:$split_at}"
    echo "  Posting chunk ${chunk_num}/${total_chunks} (${#chunk} chars)..."
    if ! post_chunk "$chunk"; then
      echo "  ERROR: Failed to post chunk ${chunk_num}" >&2
      return 1
    fi

    content="${content:$split_at}"
    # Trim leading whitespace from the remainder
    content="${content#"${content%%[![:space:]]*}"}"

    chunk_num=$((chunk_num + 1))

    # Rate limit: avoid hitting Discord's webhook rate limits
    sleep 1.5
  done
}

# --- Main Logic ---

echo "=== GameCI Help Bot -- Post to Discord ==="
if [[ -n "${RESPONSE_FILE}" ]]; then
  echo "Source file: ${RESPONSE_FILE}"
fi
echo "Message length: ${#MESSAGE} characters"
echo "Username: ${BOT_USERNAME}"

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
  if split_and_post "$MESSAGE"; then
    echo "All chunks posted successfully."
  else
    echo "ERROR: Some chunks failed to post." >&2
    exit 1
  fi
fi

echo "=== Done ==="
