#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
script="$script_dir/delegate-deepseek-worker.mjs"
if [[ ! -f "$script" ]]; then
  echo "spawn-deepseek-subagent.sh: missing DeepSeek subagent scheduler script: $script" >&2
  exit 1
fi

node_bin="${CODEX_DEEPSEEK_NODE_PATH:-node}"
exec "$node_bin" "$script" "$@"
