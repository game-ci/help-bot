#!/usr/bin/env bash
# llm-provider.sh
#
# Abstraction layer for LLM providers. Supports:
#   - claude    : Claude Code CLI (default)
#   - lm_studio : LM Studio local server (OpenAI-compatible API)
#   - continue  : Continue CLI
#
# This script is sourced by run-help-cycle.sh to get the provider-specific
# invocation function.
#
# Environment variables:
#   LLM_PROVIDER  -- Override provider from config.json (claude, lm_studio, continue)
#
# Usage:
#   source automation/llm-provider.sh
#   run_llm_provider "$PROMPT" "$WORKING_DIR"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONFIG_FILE="${REPO_DIR}/config.json"

# Detect configured provider
detect_provider() {
  local provider="${LLM_PROVIDER:-}"

  if [[ -z "$provider" ]] && [[ -f "${CONFIG_FILE}" ]] && command -v python3 &>/dev/null; then
    provider=$(python3 -c "
import json
with open('${CONFIG_FILE}') as f:
    cfg = json.load(f)
print(cfg.get('llm', {}).get('provider', 'claude'))
" 2>/dev/null || echo "claude")
  fi

  echo "${provider:-claude}"
}

# Get LM Studio configuration from config.json
get_lm_studio_config() {
  local key="$1"
  local default="$2"

  if [[ -f "${CONFIG_FILE}" ]] && command -v python3 &>/dev/null; then
    python3 -c "
import json
with open('${CONFIG_FILE}') as f:
    cfg = json.load(f)
print(cfg.get('llm', {}).get('lm_studio', {}).get('${key}', '${default}'))
" 2>/dev/null || echo "$default"
  else
    echo "$default"
  fi
}

# Run Claude Code CLI
run_claude() {
  local prompt="$1"
  local workdir="$2"
  local model="${CLAUDE_MODEL:-}"

  if [[ -z "$model" ]] && [[ -f "${CONFIG_FILE}" ]] && command -v python3 &>/dev/null; then
    model=$(python3 -c "
import json
with open('${CONFIG_FILE}') as f:
    cfg = json.load(f)
print(cfg.get('llm', {}).get('claude', {}).get('model', 'claude-sonnet-4-20250514'))
" 2>/dev/null || echo "claude-sonnet-4-20250514")
  fi

  model="${model:-claude-sonnet-4-20250514}"

  echo "Provider: Claude Code CLI (model: ${model})"
  cd "$workdir"
  claude -p "${prompt}" --model "${model}" 2>&1
}

# Run LM Studio (OpenAI-compatible API)
run_lm_studio() {
  local prompt="$1"
  local workdir="$2"

  local base_url
  base_url=$(get_lm_studio_config "base_url" "http://localhost:1234/v1")
  local model
  model=$(get_lm_studio_config "model" "default")
  local api_key
  api_key=$(get_lm_studio_config "api_key" "lm-studio")

  echo "Provider: LM Studio (url: ${base_url}, model: ${model})"

  # Read CLAUDE.md as system prompt
  local system_prompt=""
  if [[ -f "${workdir}/CLAUDE.md" ]]; then
    system_prompt=$(cat "${workdir}/CLAUDE.md" 2>/dev/null || echo "")
  fi

  # Build file context: list available data files so the LLM knows what to read
  local file_context
  file_context=$(cd "$workdir" && find data/ -name "*.jsonl" -o -name "*.md" 2>/dev/null | sort | head -100)

  local full_prompt
  full_prompt="${prompt}

Available data files:
${file_context}

Note: You cannot read files directly. The content of each relevant file will need to be provided separately, or you can describe what responses to write and they will be created manually."

  # Call the OpenAI-compatible chat completions API
  local response
  response=$(python3 -c "
import json, sys
try:
    import urllib.request
except ImportError:
    print('ERROR: urllib not available', file=sys.stderr)
    sys.exit(1)

base_url = '${base_url}'
model = '${model}'
api_key = '${api_key}'

system = sys.stdin.read()
prompt = '''${full_prompt}'''

payload = json.dumps({
    'model': model,
    'messages': [
        {'role': 'system', 'content': system},
        {'role': 'user', 'content': prompt}
    ],
    'max_tokens': 4096,
    'temperature': 0.3
}).encode()

req = urllib.request.Request(
    f'{base_url}/chat/completions',
    data=payload,
    headers={
        'Content-Type': 'application/json',
        'Authorization': f'Bearer {api_key}'
    }
)

try:
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read())
        content = data['choices'][0]['message']['content']
        print(content)
except Exception as e:
    print(f'LM Studio API error: {e}', file=sys.stderr)
    sys.exit(1)
" <<< "$system_prompt" 2>&1)

  echo "$response"
}

# Run Continue CLI
run_continue_cli() {
  local prompt="$1"
  local workdir="$2"

  local model
  if [[ -f "${CONFIG_FILE}" ]] && command -v python3 &>/dev/null; then
    model=$(python3 -c "
import json
with open('${CONFIG_FILE}') as f:
    cfg = json.load(f)
print(cfg.get('llm', {}).get('continue_cli', {}).get('model', 'default'))
" 2>/dev/null || echo "default")
  else
    model="default"
  fi

  echo "Provider: Continue CLI (model: ${model})"
  cd "$workdir"

  if command -v continue &>/dev/null; then
    echo "$prompt" | continue --model "$model" 2>&1
  else
    echo "ERROR: Continue CLI is not installed. Install from https://continue.dev/docs/reference/cli" >&2
    return 1
  fi
}

# Main dispatcher
run_llm_provider() {
  local prompt="$1"
  local workdir="$2"
  local provider
  provider=$(detect_provider)

  case "$provider" in
    claude)
      run_claude "$prompt" "$workdir"
      ;;
    lm_studio)
      run_lm_studio "$prompt" "$workdir"
      ;;
    continue)
      run_continue_cli "$prompt" "$workdir"
      ;;
    *)
      echo "ERROR: Unknown LLM provider: ${provider}" >&2
      echo "Supported providers: claude, lm_studio, continue" >&2
      return 1
      ;;
  esac
}
