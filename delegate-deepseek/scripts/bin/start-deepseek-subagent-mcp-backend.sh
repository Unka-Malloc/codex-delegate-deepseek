#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
service="$script_dir/codex-deepseek-service.mjs"
if [[ ! -f "$service" ]]; then
  echo "start-deepseek-subagent-mcp-backend.sh: missing DeepSeek backend script: $service" >&2
  exit 1
fi

codex_home="${CODEX_HOME:-"$HOME/.codex"}"
state_dir="${CODEX_DEEPSEEK_SERVICE_STATE_DIR:-"$codex_home/state/delegate-deepseek"}"
port="${CODEX_DEEPSEEK_SERVICE_PORT:-4466}"
node_bin="${CODEX_DEEPSEEK_NODE_PATH:-}"
if [[ -z "$node_bin" ]]; then
  node_bin="$(command -v node)"
fi

api_key="${DEEPSEEK_API_KEY:-${CODEX_DEEPSEEK_API_KEY:-}}"
if [[ -z "$api_key" ]] && command -v launchctl >/dev/null 2>&1; then
  api_key="$(launchctl getenv DEEPSEEK_API_KEY 2>/dev/null || true)"
fi
if [[ -z "$api_key" ]]; then
  echo "start-deepseek-subagent-mcp-backend.sh: DEEPSEEK_API_KEY is not set. Export it or run: launchctl setenv DEEPSEEK_API_KEY <key>" >&2
  exit 1
fi

mkdir -p "$state_dir"

export DEEPSEEK_API_KEY="$api_key"
upstream="${CODEX_DEEPSEEK_SERVICE_UPSTREAM:-https://api.deepseek.com/v1}"
log_path="${CODEX_DEEPSEEK_SERVICE_LOG:-"$state_dir/backend.jsonl"}"
session_dir="${CODEX_DEEPSEEK_SERVICE_SESSION_DIR:-"$state_dir/sessions"}"

exec "$node_bin" "$service" --port "$port" --upstream "$upstream" --log "$log_path" --session-dir "$session_dir"
