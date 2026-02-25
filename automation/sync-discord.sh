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
#   id, author, content, timestamp, channel_id, channel_name
#
# Environment variables required:
#   DISCORD_BOT_TOKEN  — Bot token with MESSAGE_CONTENT intent and read access
#
# Optional environment variables:
#   DISCORD_GUILD_ID   — Server ID to sync (required)
#   SYNC_HOURS         — How many hours back to sync (default: 24)

set -euo pipefail

# --- Configuration ---

DISCORD_API="https://discord.com/api/v10"
SYNC_HOURS="${SYNC_HOURS:-24}"
DATA_DIR="$(cd "$(dirname "$0")/.." && pwd)/data/discord/channels"

# Channels to monitor for help requests.
# Add or remove channel names as the Discord server evolves.
# The script resolves names to IDs dynamically from the guild channel list.
CHANNELS_TO_SYNC=(
  "help"
  "support"
  "general"
  "bugs"
  "unity-builder"
  "unity-test-runner"
  "docker"
)

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
  curl -s -X "$method" \
    -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
    -H "Content-Type: application/json" \
    "${DISCORD_API}${endpoint}"
}

# Convert a timestamp N hours ago to a Discord snowflake ID.
# Discord snowflakes encode a timestamp: (timestamp_ms - 1420070400000) << 22
# This lets us fetch messages after a certain time using the ?after= parameter.
hours_ago_to_snowflake() {
  local hours="$1"
  local now_ms
  now_ms=$(date +%s)000
  local offset_ms=$((hours * 3600 * 1000))
  local target_ms=$((now_ms - offset_ms))
  # Discord epoch: 2015-01-01T00:00:00.000Z = 1420070400000
  local discord_epoch=1420070400000
  local snowflake=$(( (target_ms - discord_epoch) << 22 ))
  echo "$snowflake"
}

# --- Main Logic ---

echo "=== GameCI Help Bot — Discord Sync ==="
echo "Syncing last ${SYNC_HOURS} hours of messages"
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

# Iterate over each channel we want to sync
for CHANNEL_NAME in "${CHANNELS_TO_SYNC[@]}"; do
  echo ""
  echo "--- Syncing #${CHANNEL_NAME} ---"

  # Find the channel ID by name (type 0 = text channel)
  CHANNEL_ID=$(echo "$GUILD_CHANNELS" | \
    python3 -c "
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
  TOTAL_MESSAGES=0

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

for msg in messages:
    # Parse the timestamp to determine the date file
    ts = msg.get('timestamp', '')
    try:
        dt = datetime.fromisoformat(ts.replace('+00:00', '+00:00').rstrip('Z'))
        date_str = dt.strftime('%Y-%m-%d')
    except:
        date_str = 'unknown'

    # Build a simplified message record
    record = {
        'id': msg.get('id'),
        'author': msg.get('author', {}).get('username', 'unknown'),
        'author_id': msg.get('author', {}).get('id'),
        'content': msg.get('content', ''),
        'timestamp': ts,
        'channel_id': '${CHANNEL_ID}',
        'channel_name': '${CHANNEL_NAME}',
    }

    # Print as tab-separated: date_str<TAB>json_record
    print(f'{date_str}\t{json.dumps(record)}')
" 2>/dev/null | while IFS=$'\t' read -r DATE_STR JSON_RECORD; do
      echo "$JSON_RECORD" >> "${CHANNEL_DIR}/${DATE_STR}.jsonl"
    done

    TOTAL_MESSAGES=$((TOTAL_MESSAGES + MSG_COUNT))

    # Get the latest message ID for pagination (messages are returned newest-first,
    # so the last element has the oldest ID in this batch when using ?after=)
    CURRENT_AFTER=$(echo "$MESSAGES" | python3 -c "
import sys, json
msgs = json.load(sys.stdin)
if isinstance(msgs, list) and len(msgs) > 0:
    # Messages returned by ?after= are in ascending order by ID
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
    sleep 1
  done

  echo "  Synced ${TOTAL_MESSAGES} messages from #${CHANNEL_NAME}"
done

echo ""
echo "=== Discord sync complete ==="
