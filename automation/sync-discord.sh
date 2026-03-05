#!/usr/bin/env bash
# sync-discord.sh
#
# Syncs Discord messages to the local filesystem for processing by the help bot.
# Messages are stored as JSONL files organized by channel and date.
#
# Output structure:
#   data/discord/channels/{channel-name}/{YYYY-MM-DD}.jsonl
#
# Each line in a JSONL file is a JSON object representing one message with fields:
#   id, author, author_id, content, timestamp, channel_id, channel_name, is_bot, has_reply
#
# Environment variables required:
#   DISCORD_BOT_TOKEN  -- Bot token with MESSAGE_CONTENT intent and read access
#
# Optional environment variables:
#   DISCORD_GUILD_ID   -- Server ID to sync (falls back to config.json)
#   SYNC_HOURS         -- How many hours back to sync (default from config.json, fallback: 6)

set -euo pipefail

# --- Configuration ---

DISCORD_API="https://discord.com/api/v10"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DATA_DIR="${REPO_DIR}/data/discord/channels"
CONFIG_FILE="${REPO_DIR}/config.json"

# Load settings from config.json if available
if [[ -f "${CONFIG_FILE}" ]] && command -v python3 &>/dev/null; then
  CONFIG_SYNC_HOURS=$(python3 -c "
import json
with open('${CONFIG_FILE}') as f:
    cfg = json.load(f)
print(cfg.get('discord', {}).get('sync_hours', 6))
" 2>/dev/null || echo "6")

  CONFIG_CHANNELS=$(python3 -c "
import json
with open('${CONFIG_FILE}') as f:
    cfg = json.load(f)
channels = cfg.get('discord', {}).get('channels', [])
print(' '.join(channels))
" 2>/dev/null || echo "")

  CONFIG_IGNORE_BOTS=$(python3 -c "
import json
with open('${CONFIG_FILE}') as f:
    cfg = json.load(f)
print(str(cfg.get('discord', {}).get('ignore_bots', True)).lower())
" 2>/dev/null || echo "true")

  CONFIG_MIN_LENGTH=$(python3 -c "
import json
with open('${CONFIG_FILE}') as f:
    cfg = json.load(f)
print(cfg.get('discord', {}).get('min_message_length', 15))
" 2>/dev/null || echo "15")
else
  CONFIG_SYNC_HOURS="6"
  CONFIG_CHANNELS=""
  CONFIG_IGNORE_BOTS="true"
  CONFIG_MIN_LENGTH="15"
fi

SYNC_HOURS="${SYNC_HOURS:-${CONFIG_SYNC_HOURS}}"
IGNORE_BOTS="${CONFIG_IGNORE_BOTS}"
MIN_MESSAGE_LENGTH="${CONFIG_MIN_LENGTH}"

# Channels to monitor -- from config.json or fallback defaults
if [[ -n "$CONFIG_CHANNELS" ]]; then
  IFS=' ' read -r -a CHANNELS_TO_SYNC <<< "$CONFIG_CHANNELS"
else
  CHANNELS_TO_SYNC=(
    "help"
    "support"
    "general"
    "bugs"
    "unity-builder"
    "unity-test-runner"
    "docker"
  )
fi

# --- Validation ---

if [[ -z "${DISCORD_BOT_TOKEN:-}" ]]; then
  echo "ERROR: DISCORD_BOT_TOKEN environment variable is not set." >&2
  exit 1
fi

if [[ -z "${DISCORD_GUILD_ID:-}" ]]; then
  echo "ERROR: DISCORD_GUILD_ID environment variable is not set." >&2
  exit 1
fi

# --- Helper Functions ---

# Make an authenticated request to the Discord API.
# Usage: discord_api GET /channels/123/messages?limit=100
discord_api() {
  local method="$1"
  local endpoint="$2"
  local response
  local http_code

  # Make request and capture both body and HTTP status
  response=$(curl -s -w "\n%{http_code}" -X "$method" \
    -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
    -H "Content-Type: application/json" \
    "${DISCORD_API}${endpoint}")

  http_code=$(echo "$response" | tail -1)
  local body
  body=$(echo "$response" | sed '$d')

  # Handle rate limiting (HTTP 429)
  if [[ "$http_code" == "429" ]]; then
    local retry_after
    retry_after=$(echo "$body" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get('retry_after', 5))
except:
    print(5)
" 2>/dev/null || echo "5")
    echo "  Rate limited. Waiting ${retry_after}s..." >&2
    sleep "$retry_after"
    # Retry once
    response=$(curl -s -X "$method" \
      -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
      -H "Content-Type: application/json" \
      "${DISCORD_API}${endpoint}")
    echo "$response"
    return
  fi

  if [[ "$http_code" -ge 400 ]]; then
    echo "  API error (HTTP ${http_code}): ${body}" >&2
    echo "[]"
    return
  fi

  echo "$body"
}

# Convert a timestamp N hours ago to a Discord snowflake ID.
# Discord snowflakes encode a timestamp: (timestamp_ms - 1420070400000) << 22
hours_ago_to_snowflake() {
  local hours="$1"
  python3 -c "
import time
now_ms = int(time.time() * 1000)
offset_ms = ${hours} * 3600 * 1000
target_ms = now_ms - offset_ms
discord_epoch = 1420070400000
snowflake = (target_ms - discord_epoch) << 22
print(snowflake)
" 2>/dev/null
}

# --- Main Logic ---

echo "=== GameCI Help Bot -- Discord Sync ==="
echo "Syncing last ${SYNC_HOURS} hours of messages"
echo "Channels: ${CHANNELS_TO_SYNC[*]}"
echo "Ignore bots: ${IGNORE_BOTS}"
echo "Data directory: ${DATA_DIR}"
echo ""

# Create the output directory structure
mkdir -p "${DATA_DIR}"

# Calculate the snowflake ID for our sync window
AFTER_SNOWFLAKE=$(hours_ago_to_snowflake "${SYNC_HOURS}")
echo "Fetching messages after snowflake: ${AFTER_SNOWFLAKE}"

# Fetch the guild's channel list to resolve names to IDs
echo "Fetching channel list for guild ${DISCORD_GUILD_ID}..."
GUILD_CHANNELS=$(discord_api GET "/guilds/${DISCORD_GUILD_ID}/channels")

# Validate we got a proper response
CHANNEL_COUNT=$(echo "$GUILD_CHANNELS" | python3 -c "
import sys, json
try:
    channels = json.load(sys.stdin)
    if isinstance(channels, list):
        print(len(channels))
    else:
        print(0)
except:
    print(0)
" 2>/dev/null || echo "0")

if [[ "$CHANNEL_COUNT" -eq 0 ]]; then
  echo "ERROR: Could not fetch guild channels. Check DISCORD_BOT_TOKEN and DISCORD_GUILD_ID." >&2
  exit 1
fi

echo "Found ${CHANNEL_COUNT} channels in guild."

TOTAL_SYNCED=0

# Iterate over each channel we want to sync
for CHANNEL_NAME in "${CHANNELS_TO_SYNC[@]}"; do
  echo ""
  echo "--- Syncing #${CHANNEL_NAME} ---"

  # Find the channel ID by name (type 0 = text channel)
  CHANNEL_ID=$(echo "$GUILD_CHANNELS" | python3 -c "
import sys, json
channels = json.load(sys.stdin)
for ch in channels:
    if ch.get('name') == '${CHANNEL_NAME}' and ch.get('type') == 0:
        print(ch['id'])
        break
" 2>/dev/null || true)

  if [[ -z "$CHANNEL_ID" ]]; then
    echo "  Channel #${CHANNEL_NAME} not found in guild, skipping."
    continue
  fi

  echo "  Channel ID: ${CHANNEL_ID}"

  # Create the channel output directory
  CHANNEL_DIR="${DATA_DIR}/${CHANNEL_NAME}"
  mkdir -p "${CHANNEL_DIR}"

  # Fetch messages in batches of 100 (Discord API limit).
  # We paginate using the ?after= parameter with ascending snowflake IDs.
  CURRENT_AFTER="${AFTER_SNOWFLAKE}"
  CHANNEL_MESSAGES=0

  while true; do
    MESSAGES=$(discord_api GET "/channels/${CHANNEL_ID}/messages?limit=100&after=${CURRENT_AFTER}")

    # Check if we got an empty array or an error
    MSG_COUNT=$(echo "$MESSAGES" | python3 -c "
import sys, json
try:
    msgs = json.load(sys.stdin)
    if isinstance(msgs, list):
        print(len(msgs))
    else:
        print(0)
except:
    print(0)
" 2>/dev/null || echo "0")

    if [[ "$MSG_COUNT" -eq 0 ]]; then
      break
    fi

    # Process each message and append to the appropriate date file
    echo "$MESSAGES" | python3 -c "
import sys, json
from datetime import datetime

messages = json.load(sys.stdin)
if not isinstance(messages, list):
    sys.exit(0)

ignore_bots = '${IGNORE_BOTS}' == 'true'
min_length = int('${MIN_MESSAGE_LENGTH}')

for msg in messages:
    # Check if author is a bot
    author_obj = msg.get('author', {})
    is_bot = author_obj.get('bot', False)

    # Parse the timestamp to determine the date file
    ts = msg.get('timestamp', '')
    try:
        # Handle various ISO format variations
        clean_ts = ts.replace('+00:00', 'Z').rstrip('Z')
        dt = datetime.fromisoformat(clean_ts)
        date_str = dt.strftime('%Y-%m-%d')
    except:
        date_str = 'unknown'

    content = msg.get('content', '')

    # Check if this message has been replied to (referenced_message field)
    has_reply = msg.get('referenced_message') is not None
    # Also check if there are reactions (crude proxy for engagement)
    reaction_count = sum(r.get('count', 0) for r in msg.get('reactions', []))

    # Build a simplified message record
    record = {
        'id': msg.get('id'),
        'author': author_obj.get('username', 'unknown'),
        'author_id': author_obj.get('id'),
        'content': content,
        'timestamp': ts,
        'channel_id': '${CHANNEL_ID}',
        'channel_name': '${CHANNEL_NAME}',
        'is_bot': is_bot,
        'has_reply': has_reply,
        'reaction_count': reaction_count,
        'message_type': msg.get('type', 0),
    }

    # Print as tab-separated: date_str<TAB>json_record
    print(f'{date_str}\t{json.dumps(record)}')
" 2>/dev/null | while IFS=$'\t' read -r DATE_STR JSON_RECORD; do
      echo "$JSON_RECORD" >> "${CHANNEL_DIR}/${DATE_STR}.jsonl"
    done

    CHANNEL_MESSAGES=$((CHANNEL_MESSAGES + MSG_COUNT))

    # Get the latest message ID for pagination
    CURRENT_AFTER=$(echo "$MESSAGES" | python3 -c "
import sys, json
msgs = json.load(sys.stdin)
if isinstance(msgs, list) and len(msgs) > 0:
    print(max(m['id'] for m in msgs))
" 2>/dev/null || echo "")

    if [[ -z "$CURRENT_AFTER" ]]; then
      break
    fi

    # If we got fewer than 100 messages, we have reached the end
    if [[ "$MSG_COUNT" -lt 100 ]]; then
      break
    fi

    # Rate limit: Discord allows 5 requests per 5 seconds per route
    sleep 1.2
  done

  echo "  Synced ${CHANNEL_MESSAGES} messages from #${CHANNEL_NAME}"
  TOTAL_SYNCED=$((TOTAL_SYNCED + CHANNEL_MESSAGES))
done

echo ""
echo "=== Discord sync complete ==="
echo "Total messages synced: ${TOTAL_SYNCED}"
