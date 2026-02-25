#!/usr/bin/env bash
# run-continuous.sh
#
# Runs the help cycle in a continuous loop with configurable intervals.
# Designed for persistent deployment (Docker container or always-on machine).
#
# The bot runs a full help cycle, sleeps for the configured interval, then
# runs again. Graceful shutdown on SIGTERM/SIGINT.
#
# Environment variables:
#   CYCLE_INTERVAL_MINUTES  -- Minutes between cycles (default from config.json, fallback: 30)
#   All environment variables required by run-help-cycle.sh
#
# Usage:
#   bash automation/run-continuous.sh
#   CYCLE_INTERVAL_MINUTES=15 bash automation/run-continuous.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONFIG_FILE="${REPO_DIR}/config.json"

# Load interval from config.json if available
if [[ -f "${CONFIG_FILE}" ]] && command -v python3 &>/dev/null; then
  DEFAULT_INTERVAL=$(python3 -c "
import json
with open('${CONFIG_FILE}') as f:
    cfg = json.load(f)
print(cfg.get('bot', {}).get('cycle_interval_minutes', 30))
" 2>/dev/null || echo "30")
else
  DEFAULT_INTERVAL="30"
fi

CYCLE_INTERVAL_MINUTES="${CYCLE_INTERVAL_MINUTES:-${DEFAULT_INTERVAL}}"
INTERVAL_SECONDS=$((CYCLE_INTERVAL_MINUTES * 60))

# Graceful shutdown handler
RUNNING=true
shutdown_handler() {
  echo ""
  echo "=== Received shutdown signal. Finishing current cycle... ==="
  RUNNING=false
}
trap shutdown_handler SIGTERM SIGINT

echo "=== GameCI Help Bot -- Continuous Mode ==="
echo "Cycle interval: ${CYCLE_INTERVAL_MINUTES} minutes"
echo "Press Ctrl+C to stop gracefully."
echo ""

CYCLE_NUMBER=0

while $RUNNING; do
  CYCLE_NUMBER=$((CYCLE_NUMBER + 1))
  echo "=========================================="
  echo "Starting cycle #${CYCLE_NUMBER} at $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "=========================================="
  echo ""

  # Run one help cycle. Do not exit on failure -- log and continue.
  if bash "${SCRIPT_DIR}/run-help-cycle.sh"; then
    echo ""
    echo "Cycle #${CYCLE_NUMBER} completed successfully."
  else
    echo ""
    echo "WARNING: Cycle #${CYCLE_NUMBER} completed with errors."
  fi

  if ! $RUNNING; then
    break
  fi

  echo ""
  echo "Next cycle in ${CYCLE_INTERVAL_MINUTES} minutes ($(date -u -d "+${INTERVAL_SECONDS} seconds" '+%H:%M:%S UTC' 2>/dev/null || echo "calculating..."))."
  echo "Sleeping..."

  # Sleep in small increments so we can respond to shutdown signals
  ELAPSED=0
  while $RUNNING && [[ $ELAPSED -lt $INTERVAL_SECONDS ]]; do
    sleep 10
    ELAPSED=$((ELAPSED + 10))
  done
done

echo ""
echo "=== GameCI Help Bot stopped. Total cycles: ${CYCLE_NUMBER} ==="
