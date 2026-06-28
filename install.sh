#!/usr/bin/env bash
set -euo pipefail

codex_home="${CODEX_HOME:-"$HOME/.codex"}"
node_path=""
port="4466"
no_start=0

usage() {
  cat <<'EOF'
Usage:
  ./install.sh [options]

Options:
  --codex-home <path>  Codex home directory. Default: CODEX_HOME or ~/.codex.
  --node-path <path>   Explicit node executable path.
  --port <port>        Local DeepSeek delegate backend port. Default: 4466.
  --no-start           Install and configure without starting the backend.
  --help               Show this help.
EOF
}

while (($#)); do
  case "$1" in
    --codex-home)
      codex_home="$2"
      shift 2
      ;;
    --codex-home=*)
      codex_home="${1#*=}"
      shift
      ;;
    --node-path)
      node_path="$2"
      shift 2
      ;;
    --node-path=*)
      node_path="${1#*=}"
      shift
      ;;
    --port)
      port="$2"
      shift 2
      ;;
    --port=*)
      port="${1#*=}"
      shift
      ;;
    --no-start)
      no_start=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "install.sh: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source_skill="$project_root/delegate-deepseek"
target_skills="$codex_home/skills"
target_skill="$target_skills/delegate-deepseek"

if [[ ! -f "$source_skill/SKILL.md" ]]; then
  echo "install.sh: missing skill source: $source_skill" >&2
  exit 1
fi

mkdir -p "$target_skills"

if [[ -e "$target_skill" ]]; then
  if [[ ! -d "$target_skill" ]]; then
    echo "install.sh: refusing to replace non-directory path: $target_skill" >&2
    exit 1
  fi
  resolved_target="$(cd "$target_skill" && pwd -P)"
  resolved_skills="$(cd "$target_skills" && pwd -P)"
  case "$resolved_target" in
    "$resolved_skills"/*) ;;
    *)
      echo "install.sh: refusing to replace unexpected path: $resolved_target" >&2
      exit 1
      ;;
  esac
  rm -rf "$target_skill"
fi

cp -R "$source_skill" "$target_skill"
chmod +x "$target_skill/scripts/install.sh" 2>/dev/null || true

args=(--codex-home "$codex_home" --port "$port")
if [[ -n "$node_path" ]]; then
  args+=(--node-path "$node_path")
fi
if [[ "$no_start" -eq 1 ]]; then
  args+=(--no-start)
fi

"$target_skill/scripts/install.sh" "${args[@]}"
