#!/usr/bin/env bash
# Helper to manage the Discord bot token with optional secure storage on Windows.

set -euo pipefail

DISCORD_TOKEN_STORE_DIR_NAME="${DISCORD_TOKEN_STORE_DIR_NAME:-GameCI}"
DISCORD_TOKEN_STORE_FILE="${DISCORD_TOKEN_STORE_FILE:-discord-bot-token.sec}"

is_windows_platform() {
  case "$(uname -s 2>/dev/null || true)" in
    MINGW*|MSYS*|CYGWIN*|Windows_NT*) return 0 ;;
    *) return 1 ;;
  esac
}

choose_powershell() {
  if command -v pwsh >/dev/null 2>&1; then
    echo pwsh
    return 0
  fi
  if command -v powershell >/dev/null 2>&1; then
    echo powershell
    return 0
  fi
  return 1
}

run_powershell_script() {
  local script="$1"
  shift
  local shell_cmd
  if ! shell_cmd=$(choose_powershell); then
    return 1
  fi

  local tmpfile
  tmpfile=$(mktemp -t discord-token-XXXXXX.ps1 2>/dev/null || mktemp "/tmp/discord-token-XXXXXX.ps1")
  printf "%s\n" "$script" > "$tmpfile"
  "$shell_cmd" -NoProfile -ExecutionPolicy Bypass -File "$tmpfile" "$@"
  local rc=$?
  rm -f "$tmpfile"
  return $rc
}

discord_token_storage_path() {
  local dir
  if [[ -n "${DISCORD_TOKEN_STORAGE_DIR:-}" ]]; then
    dir="${DISCORD_TOKEN_STORAGE_DIR}"
  elif [[ -n "${LOCALAPPDATA:-}" ]]; then
    dir="${LOCALAPPDATA}/${DISCORD_TOKEN_STORE_DIR_NAME}"
  elif [[ -n "${XDG_CONFIG_HOME:-}" ]]; then
    dir="${XDG_CONFIG_HOME}/${DISCORD_TOKEN_STORE_DIR_NAME}"
  else
    dir="${HOME}/.${DISCORD_TOKEN_STORE_DIR_NAME}"
  fi
  mkdir -p "$dir"
  printf "%s/%s" "$dir" "$DISCORD_TOKEN_STORE_FILE"
}

persist_discord_token() {
  local token="$1"
  if ! is_windows_platform; then
    printf "%s" "$token" > "$(discord_token_storage_path)"
    return 0
  fi

  local script='param($path,$value)
$secure = ConvertTo-SecureString $value -AsPlainText -Force
$secure | ConvertFrom-SecureString | Set-Content -Encoding UTF8 -NoNewline -Force $path'
  if run_powershell_script "$script" "$(discord_token_storage_path)" "$token"; then
    return 0
  fi

  # Fallback to plaintext if PowerShell is not available
  printf "%s" "$token" > "$(discord_token_storage_path)"
  return 0
}

load_discord_token_from_store() {
  local storage
  storage=$(discord_token_storage_path)
  if [[ ! -f "$storage" ]]; then
    return 1
  fi

  if ! is_windows_platform; then
    DISCORD_BOT_TOKEN=$(cat "$storage")
    export DISCORD_BOT_TOKEN
    return 0
  fi

  local script='param($path)
$encrypted = Get-Content -Raw -Encoding UTF8 $path
if (-not $encrypted) { exit 1 }
$secure = ConvertTo-SecureString $encrypted
$ptr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($ptr) }
finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }'

  if token=$(run_powershell_script "$script" "$storage"); then
    DISCORD_BOT_TOKEN=$(printf "%s" "$token" | tr -d $'\r')
    export DISCORD_BOT_TOKEN
    return 0
  fi

  return 1
}

validate_discord_token() {
  if [[ -z "${DISCORD_BOT_TOKEN:-}" ]]; then
    return 1
  fi
  if ! command -v curl >/dev/null 2>&1; then
    return 0
  fi
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" https://discord.com/api/v10/users/@me || echo "000")
  if [[ "$status" != "200" ]]; then
    echo "WARNING: Discord API responded with ${status}. Please verify the bot token." >&2
    return 1
  fi
  return 0
}

prompt_for_discord_token() {
  if [[ ! -t 0 ]]; then
    echo "ERROR: DISCORD_BOT_TOKEN is not set and interactive input is unavailable." >&2
    return 1
  fi
  printf "Discord bot token: "
  read -r -s token
  echo ""
  if [[ -z "$token" ]]; then
    echo "No token provided." >&2
    return 1
  fi
  DISCORD_BOT_TOKEN="$token"
  export DISCORD_BOT_TOKEN
  if is_windows_platform; then
    printf "Store token securely for this user? (Y/n): "
    read -r choice
    if [[ -z "$choice" ]] || [[ "$choice" =~ ^[Yy] ]]; then
      persist_discord_token "$token" && echo "Discord token stored securely."
    fi
  fi
  return 0
}

ensure_discord_token() {
  if [[ -n "${DISCORD_BOT_TOKEN:-}" ]]; then
    validate_discord_token && return 0
    echo "Existing DISCORD_BOT_TOKEN is invalid." >&2
  fi
  if load_discord_token_from_store; then
    echo "Loaded Discord token from secure storage."
    validate_discord_token && return 0
    echo "Stored token validation failed; removing the stored copy." >&2
    rm -f "$(discord_token_storage_path)"
  fi
  prompt_for_discord_token && validate_discord_token
}
