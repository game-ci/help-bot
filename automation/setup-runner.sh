#!/usr/bin/env bash
# setup-runner.sh
#
# Sets up the help-bot repository as a GitHub Actions self-hosted runner.
# This allows any contributor to run the bot on their own machine by simply
# starting the runner and letting GitHub Actions trigger the help cycle.
#
# The runner registers with the help-bot repository and uses the "help-bot"
# label so the workflow can target it specifically.
#
# Prerequisites:
#   - gh CLI authenticated with repo admin access
#   - All environment variables set (DISCORD_BOT_TOKEN, etc.)
#
# Usage:
#   bash automation/setup-runner.sh              # Interactive setup
#   bash automation/setup-runner.sh --start      # Start existing runner
#   bash automation/setup-runner.sh --remove     # Remove runner registration
#
# After setup, the runner runs in the background. The help-cycle.yml workflow
# will dispatch work to it when triggered.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONFIG_FILE="${REPO_DIR}/config.json"
RUNNER_DIR="${REPO_DIR}/_runner"

# Load runner config
if [[ -f "${CONFIG_FILE}" ]] && command -v python3 &>/dev/null; then
  RUNNER_LABELS=$(python3 -c "
import json
with open('${CONFIG_FILE}') as f:
    cfg = json.load(f)
labels = cfg.get('runner', {}).get('labels', ['help-bot'])
print(','.join(labels))
" 2>/dev/null || echo "help-bot")

  RUNNER_WORK_DIR=$(python3 -c "
import json
with open('${CONFIG_FILE}') as f:
    cfg = json.load(f)
print(cfg.get('runner', {}).get('work_directory', '_work'))
" 2>/dev/null || echo "_work")
else
  RUNNER_LABELS="help-bot"
  RUNNER_WORK_DIR="_work"
fi

# Detect platform
detect_platform() {
  local os_name
  local arch

  case "$(uname -s)" in
    Linux)  os_name="linux" ;;
    Darwin) os_name="osx" ;;
    MINGW*|MSYS*|CYGWIN*) os_name="win" ;;
    *) echo "ERROR: Unsupported OS: $(uname -s)" >&2; exit 1 ;;
  esac

  case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) echo "ERROR: Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
  esac

  echo "${os_name}-${arch}"
}

# Download and extract the GitHub Actions runner
download_runner() {
  local platform
  platform=$(detect_platform)
  local version="2.321.0"  # Update as needed

  echo "=== Downloading GitHub Actions Runner ==="
  echo "Platform: ${platform}"
  echo "Version: ${version}"
  echo ""

  mkdir -p "${RUNNER_DIR}"

  local ext="tar.gz"
  if [[ "$platform" == win-* ]]; then
    ext="zip"
  fi

  local url="https://github.com/actions/runner/releases/download/v${version}/actions-runner-${platform}-${version}.${ext}"
  echo "Downloading: ${url}"

  if [[ "$ext" == "tar.gz" ]]; then
    curl -sL "$url" | tar xz -C "${RUNNER_DIR}"
  else
    local tmpfile="${RUNNER_DIR}/runner.zip"
    curl -sL -o "$tmpfile" "$url"
    unzip -q "$tmpfile" -d "${RUNNER_DIR}"
    rm -f "$tmpfile"
  fi

  echo "Runner downloaded to: ${RUNNER_DIR}"
}

# Get a runner registration token from GitHub
get_registration_token() {
  local repo
  repo=$(git -C "${REPO_DIR}" remote get-url origin 2>/dev/null | sed 's|.*github.com[:/]||;s|\.git$||')

  if [[ -z "$repo" ]]; then
    echo "ERROR: Could not determine GitHub repository from git remote." >&2
    exit 1
  fi

  echo "Repository: ${repo}" >&2
  gh api "repos/${repo}/actions/runners/registration-token" --method POST --jq '.token' 2>/dev/null
}

# Configure the runner
configure_runner() {
  if [[ ! -f "${RUNNER_DIR}/config.sh" ]] && [[ ! -f "${RUNNER_DIR}/config.cmd" ]]; then
    download_runner
  fi

  local repo_url
  repo_url=$(git -C "${REPO_DIR}" remote get-url origin 2>/dev/null | sed 's|git@github.com:|https://github.com/|;s|\.git$||')

  local token
  token=$(get_registration_token)

  if [[ -z "$token" ]]; then
    echo "ERROR: Could not get registration token. Ensure gh CLI is authenticated with admin access." >&2
    exit 1
  fi

  local runner_name
  runner_name="help-bot-$(hostname | tr '[:upper:]' '[:lower:]')"

  echo "=== Configuring Runner ==="
  echo "Name: ${runner_name}"
  echo "Labels: ${RUNNER_LABELS}"
  echo "Work directory: ${RUNNER_WORK_DIR}"
  echo ""

  cd "${RUNNER_DIR}"

  if [[ -f "config.sh" ]]; then
    bash config.sh \
      --url "$repo_url" \
      --token "$token" \
      --name "$runner_name" \
      --labels "$RUNNER_LABELS" \
      --work "$RUNNER_WORK_DIR" \
      --replace \
      --unattended
  else
    ./config.cmd \
      --url "$repo_url" \
      --token "$token" \
      --name "$runner_name" \
      --labels "$RUNNER_LABELS" \
      --work "$RUNNER_WORK_DIR" \
      --replace \
      --unattended
  fi

  echo ""
  echo "Runner configured. Start with: bash automation/setup-runner.sh --start"
}

# Start the runner
start_runner() {
  if [[ ! -f "${RUNNER_DIR}/run.sh" ]] && [[ ! -f "${RUNNER_DIR}/run.cmd" ]]; then
    echo "ERROR: Runner not configured. Run: bash automation/setup-runner.sh" >&2
    exit 1
  fi

  echo "=== Starting Self-Hosted Runner ==="
  echo "Runner directory: ${RUNNER_DIR}"
  echo "Press Ctrl+C to stop."
  echo ""

  cd "${RUNNER_DIR}"
  if [[ -f "run.sh" ]]; then
    bash run.sh
  else
    ./run.cmd
  fi
}

# Remove the runner
remove_runner() {
  if [[ ! -d "${RUNNER_DIR}" ]]; then
    echo "No runner installation found at: ${RUNNER_DIR}"
    exit 0
  fi

  local token
  token=$(get_registration_token)

  echo "=== Removing Runner ==="
  cd "${RUNNER_DIR}"

  if [[ -f "config.sh" ]]; then
    bash config.sh remove --token "$token" 2>/dev/null || true
  fi

  rm -rf "${RUNNER_DIR}"
  echo "Runner removed."
}

# --- Main ---

case "${1:-}" in
  --start)
    start_runner
    ;;
  --remove)
    remove_runner
    ;;
  *)
    configure_runner
    ;;
esac
