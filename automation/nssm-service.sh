#!/usr/bin/env bash
# nssm-service.sh
#
# Helper to install, manage, and remove an NSSM-backed Windows service that runs
# either the incremental or live bot workflows using the existing shell scripts.
#
# Usage:
#   bash automation/nssm-service.sh install --mode live
#   bash automation/nssm-service.sh start
#   bash automation/nssm-service.sh stop
#   bash automation/nssm-service.sh restart
#   bash automation/nssm-service.sh status
#   bash automation/nssm-service.sh remove

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

SERVICE_NAME="${SERVICE_NAME:-gameci-help-bot}"
MODE="live"
LOG_FILE="${LOG_FILE:-${REPO_DIR}/logs/service.log}"
ENV_FILE="${ENV_FILE:-${REPO_DIR}/.env}"
ENV_VARS="${ENV_VARS:-}"
ACTION="${1:-}"

usage() {
  cat <<'EOF' >&2
Usage: nssm-service.sh <action> [options]

Actions:
  install      Install the service (requires NSSM and bash in PATH)
  start        Start the service
  stop         Stop the service
  restart      Restart the service
  status       Show service status
  remove       Stop and unregister the service

Options:
  --service-name <name>   Override the NSSM service name (default: gameci-help-bot)
  --mode <live|incremental>   Which script the service runs (default: live)
  --env-file <path>       Read environment vars from this dotenv file
  --env-vars <vars>       Inline env vars for NSSM (e.g. KEY=val;KEY2=val2)
  --log-file <path>       File to capture stdout/stderr (auto created)
EOF
  exit 1
}

if [[ -z "$ACTION" ]]; then
  usage
fi

shift || true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --service-name)
      SERVICE_NAME="$2"
      shift 2
      ;;
    --mode)
      MODE="$2"
      shift 2
      ;;
    --env-file)
      ENV_FILE="$2"
      shift 2
      ;;
    --env-vars)
      ENV_VARS="$2"
      shift 2
      ;;
    --log-file)
      LOG_FILE="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      ;;
  esac
done

ensure_nssm() {
  if ! command -v nssm >/dev/null 2>&1; then
    echo "ERROR: nssm is not installed or not on PATH. Download from https://nssm.cc/download." >&2
    exit 1
  fi
}

read_service_env() {
  if [[ -n "${ENV_VARS}" ]]; then
    echo "${ENV_VARS}"
    return
  fi

  if [[ -f "${ENV_FILE}" ]]; then
    grep -vE '^\s*(#|$)' "${ENV_FILE}" | tr '\n' ';' | sed 's/;*$//'
  fi
}

install_service() {
  ensure_nssm

  if ! command -v bash >/dev/null 2>&1; then
    echo "ERROR: bash is not on PATH. Install Git for Windows or add bash to PATH." >&2
    exit 1
  fi

  run_script="automation/run-continuous.sh"
  if [[ "${MODE}" == "incremental" ]]; then
    run_script="automation/run-help-cycle.sh"
  fi

  run_command="cd \"${REPO_DIR}\" && bash ${run_script}"

  mkdir -p "$(dirname "${LOG_FILE}")"

  echo "Installing NSSM service '${SERVICE_NAME}' (mode: ${MODE})..."
  nssm install "${SERVICE_NAME}" "$(command -v bash)" "-lc" "${run_command}"
  nssm set "${SERVICE_NAME}" AppDirectory "${REPO_DIR}"
  nssm set "${SERVICE_NAME}" AppStdout "${LOG_FILE}"
  nssm set "${SERVICE_NAME}" AppStderr "${LOG_FILE}"
  nssm set "${SERVICE_NAME}" AppStdoutCreationDisposition 1
  nssm set "${SERVICE_NAME}" AppStderrCreationDisposition 1

  if env_vars=$(read_service_env); then
    if [[ -n "${env_vars}" ]]; then
      nssm set "${SERVICE_NAME}" AppEnvironmentExtra "${env_vars}"
    fi
  fi

  echo "Service '${SERVICE_NAME}' installed. Use 'nssm start ${SERVICE_NAME}' to run it."
}

start_service() {
  ensure_nssm
  nssm start "${SERVICE_NAME}"
}

stop_service() {
  ensure_nssm
  nssm stop "${SERVICE_NAME}" || true
}

restart_service() {
  ensure_nssm
  nssm restart "${SERVICE_NAME}"
}

status_service() {
  ensure_nssm
  nssm status "${SERVICE_NAME}"
}

remove_service() {
  ensure_nssm
  stop_service
  nssm remove "${SERVICE_NAME}" confirm
}

case "${ACTION}" in
  install)
    install_service
    ;;
  start)
    start_service
    ;;
  stop)
    stop_service
    ;;
  restart)
    restart_service
    ;;
  status)
    status_service
    ;;
  remove)
    remove_service
    ;;
  *)
    usage
    ;;
esac
