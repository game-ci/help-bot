#!/bin/bash
# Pull private config from game-ci/help-bot-config
# Requires: gh CLI authenticated with access to game-ci/help-bot-config

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
CONFIG_REPO_DIR="$REPO_DIR/.help-bot-config"
CONFIG_FILE="$REPO_DIR/config.json"

if [ -d "$CONFIG_REPO_DIR/.git" ]; then
  echo "Updating private config..."
  git -C "$CONFIG_REPO_DIR" pull --ff-only 2>/dev/null || true
else
  echo "Cloning private config..."
  gh repo clone game-ci/help-bot-config "$CONFIG_REPO_DIR" -- --depth 1
fi

if [ -f "$CONFIG_REPO_DIR/config.json" ]; then
  cp "$CONFIG_REPO_DIR/config.json" "$CONFIG_FILE"
  echo "Config loaded from help-bot-config"
else
  echo "WARNING: No config.json in help-bot-config repo"
  if [ ! -f "$CONFIG_FILE" ]; then
    echo "Falling back to config.example.json"
    cp "$REPO_DIR/config.example.json" "$CONFIG_FILE"
  fi
fi
