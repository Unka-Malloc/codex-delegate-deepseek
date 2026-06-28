#!/usr/bin/env bash
set -euo pipefail

codex_home="${CODEX_HOME:-"$HOME/.codex"}"
node_path=""
port="4466"
no_start=0

usage() {
  cat <<'EOF'
Usage:
  install.sh [options]

Options:
  --codex-home <path>  Codex home directory. Default: CODEX_HOME or ~/.codex.
  --node-path <path>   Explicit node executable path.
  --port <port>        Local DeepSeek delegate backend port. Default: 4466.
  --no-start           Install and configure without starting the backend.
  --help               Show this help.
EOF
}

info() {
  printf '[delegate-deepseek] %s\n' "$1"
}

toml_string() {
  local value=${1-}
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//$'\n'/\\n}
  printf '"%s"' "$value"
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

skill_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
source_bin="$skill_root/scripts/bin"
source_agents="$skill_root/scripts/agents"
target_bin="$codex_home/bin"
target_agents="$codex_home/agents"
config_path="$codex_home/config.toml"
state_dir="$codex_home/state/delegate-deepseek"
model_catalog_path="$codex_home/model-catalogs/delegate-deepseek.json"

get_node_path() {
  if [[ -n "$node_path" ]]; then
    if [[ ! -x "$node_path" ]]; then
      echo "install.sh: node path is not executable: $node_path" >&2
      exit 1
    fi
    printf '%s\n' "$node_path"
    return
  fi
  command -v node
}

upsert_toml_section() {
  local file=$1
  local section=$2
  local body=$3
  "$node" - "$file" "$section" "$body" <<'NODE'
const fs = require("node:fs");
const [file, section, body] = process.argv.slice(2);
let content = "";
try {
  content = fs.readFileSync(file, "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const normalized = content.replace(/\r\n/g, "\n");
const lines = normalized ? normalized.split("\n") : [];
const header = `[${section}]`;
const replacement = body.trimEnd().split("\n");
const start = lines.findIndex(line => line.trim() === header);
if (start >= 0) {
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  lines.splice(start, end - start, ...replacement, "");
  content = lines.join("\n").replace(/\n*$/u, "\n\n");
} else {
  content = normalized;
  if (content.length > 0 && !content.endsWith("\n")) content += "\n";
  if (content.length > 0 && !content.endsWith("\n\n")) content += "\n";
  content += `${body.trimEnd()}\n\n`;
}
fs.mkdirSync(require("node:path").dirname(file), { recursive: true });
fs.writeFileSync(file, content, "utf8");
NODE
}

upsert_toml_key() {
  local file=$1
  local key=$2
  local value=$3
  "$node" - "$file" "$key" "$value" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [file, key, value] = process.argv.slice(2);
let content = "";
try {
  content = fs.readFileSync(file, "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const normalized = content.replace(/\r\n/g, "\n");
const lines = normalized ? normalized.split("\n") : [];
const firstTable = lines.findIndex(line => /^\s*\[[^\]]+\]\s*$/.test(line));
const rootEnd = firstTable >= 0 ? firstTable : lines.length;
const keyPattern = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`);
let existing = -1;
for (let i = 0; i < rootEnd; i += 1) {
  if (keyPattern.test(lines[i])) {
    existing = i;
    break;
  }
}
const nextLine = `${key} = ${value}`;
if (existing >= 0) {
  lines[existing] = nextLine;
} else {
  let insertAt = rootEnd;
  while (insertAt > 0 && lines[insertAt - 1] === "") insertAt -= 1;
  lines.splice(insertAt, 0, nextLine);
  if (firstTable >= 0) lines.splice(insertAt + 1, 0, "");
}
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, lines.join("\n").replace(/\n*$/u, "\n"), "utf8");
NODE
}

write_model_catalog() {
  local codex_cmd
  codex_cmd="$(command -v codex || true)"
  if [[ -z "$codex_cmd" ]]; then
    info "Codex CLI was not found; skipping model catalog generation."
    return 1
  fi

  local catalog_dir tmp
  catalog_dir="$(dirname "$model_catalog_path")"
  mkdir -p "$catalog_dir"
  tmp="$(mktemp)"
  if ! "$codex_cmd" debug models --bundled >"$tmp" 2>/dev/null; then
    if ! CODEX_HOME="$codex_home" "$codex_cmd" debug models >"$tmp" 2>/dev/null; then
      rm -f "$tmp"
      info "Could not read Codex model catalog; skipping model catalog generation."
      return 1
    fi
  fi

  "$node" - "$tmp" "$model_catalog_path" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [inputPath, outputPath] = process.argv.slice(2);
const catalog = JSON.parse(fs.readFileSync(inputPath, "utf8"));
if (!Array.isArray(catalog.models)) {
  throw new Error("Codex model catalog must contain a models array");
}

const models = catalog.models.filter(model => ![
  "deepseek-v4-flash",
  "deepseek-v4-pro",
].includes(model.slug));

const base = catalog.models.find(model => model.slug === "gpt-5.5")
  || catalog.models.find(model => model.slug === "gpt-5.4")
  || catalog.models.find(model => model.base_instructions)
  || catalog.models[0];

if (!base || !base.base_instructions) {
  throw new Error("Could not find a Codex catalog model with base_instructions");
}

const reasoningLevels = base.supported_reasoning_levels || [
  { effort: "low", description: "Fast responses with lighter reasoning" },
  { effort: "medium", description: "Balanced reasoning depth" },
  { effort: "high", description: "Greater reasoning depth for coding tasks" },
];

function deepseekModel(slug, displayName, description, priority) {
  return {
    ...base,
    slug,
    display_name: displayName,
    description,
    default_reasoning_level: "high",
    supported_reasoning_levels: reasoningLevels,
    shell_type: base.shell_type || "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    context_window: 262144,
    max_context_window: 262144,
    effective_context_window_percent: 95,
    input_modalities: ["text"],
    supports_image_detail_original: false,
    use_responses_lite: false,
  };
}

models.push(
  deepseekModel(
    "deepseek-v4-flash",
    "DeepSeek V4 Flash",
    "DeepSeek V4 Flash through the local delegate backend.",
    50,
  ),
  deepseekModel(
    "deepseek-v4-pro",
    "DeepSeek V4 Pro",
    "DeepSeek V4 Pro through the local delegate backend.",
    51,
  ),
);

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify({ models }, null, 2)}\n`, "utf8");
NODE
  rm -f "$tmp"
}

test_http_ok() {
  local url=$1
  "$node" -e 'fetch(process.argv[1], { signal: AbortSignal.timeout(3000) }).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));' "$url" >/dev/null 2>&1
}

read_deepseek_api_key() {
  if [[ -n "${DEEPSEEK_API_KEY:-}" ]]; then
    printf '%s\n' "$DEEPSEEK_API_KEY"
    return
  fi
  if [[ -n "${CODEX_DEEPSEEK_API_KEY:-}" ]]; then
    printf '%s\n' "$CODEX_DEEPSEEK_API_KEY"
    return
  fi
  if command -v launchctl >/dev/null 2>&1; then
    launchctl getenv DEEPSEEK_API_KEY 2>/dev/null || true
  fi
}

start_service_if_needed() {
  local listen_port=$1
  local script=$2
  local node_bin=$3
  local url="http://127.0.0.1:$listen_port/health"
  if test_http_ok "$url"; then
    info "Service on port $listen_port is already healthy."
    return
  fi

  local out="$state_dir/backend.out.log"
  local err="$state_dir/backend.err.log"
  info "Starting service on port $listen_port..."
  (
    export CODEX_HOME="$codex_home"
    export CODEX_DEEPSEEK_SERVICE_PORT="$listen_port"
    export CODEX_DEEPSEEK_SERVICE_STATE_DIR="$state_dir"
    export CODEX_DEEPSEEK_NODE_PATH="$node_bin"
    nohup "$script" >"$out" 2>"$err" &
  )

  for _ in $(seq 1 20); do
    sleep 0.5
    if test_http_ok "$url"; then
      return
    fi
  done
  echo "install.sh: service on port $listen_port did not become healthy. Logs: $out, $err" >&2
  exit 1
}

if [[ ! -d "$source_bin" ]]; then
  echo "install.sh: missing bundled scripts directory: $source_bin" >&2
  exit 1
fi

node="$(get_node_path)"

mkdir -p "$codex_home" "$target_bin" "$target_agents" "$state_dir"

info "Installing bundled scripts to $target_bin"
cp -R "$source_bin/." "$target_bin/"
chmod +x "$target_bin"/*.mjs "$target_bin"/*.sh 2>/dev/null || true

if [[ -d "$source_agents" ]]; then
  info "Installing DeepSeek agent definitions to $target_agents"
  cp -R "$source_agents/." "$target_agents/"
fi

mcp_server="$target_bin/mcp-deepseek-subagent.mjs"
mcp_start="$target_bin/start-deepseek-subagent-mcp-backend.sh"

info "Updating $config_path"

if write_model_catalog; then
  info "Installing merged model catalog to $model_catalog_path"
  upsert_toml_key "$config_path" "model_catalog_json" "$(toml_string "$model_catalog_path")"
fi

upsert_toml_section "$config_path" "model_providers.deepseek" "$(cat <<EOF
[model_providers.deepseek]
name = "DeepSeek via local delegate backend"
base_url = "http://127.0.0.1:$port/v1"
wire_api = "responses"
EOF
)"

upsert_toml_section "$config_path" "mcp_servers.deepseek_subagent" "$(cat <<EOF
[mcp_servers.deepseek_subagent]
args = [$(toml_string "$mcp_server")]
command = $(toml_string "$node")
startup_timeout_sec = 120
EOF
)"

upsert_toml_section "$config_path" "mcp_servers.deepseek_subagent.env" "$(cat <<EOF
[mcp_servers.deepseek_subagent.env]
CODEX_HOME = $(toml_string "$codex_home")
CODEX_DEEPSEEK_SERVICE_PORT = "$port"
CODEX_DEEPSEEK_MODEL_PROVIDER = "deepseek"
CODEX_DEEPSEEK_SERVICE_START_SCRIPT = $(toml_string "$mcp_start")
CODEX_DEEPSEEK_SERVICE_STATE_DIR = $(toml_string "$state_dir")
CODEX_DEEPSEEK_NODE_PATH = $(toml_string "$node")
EOF
)"

if [[ "$no_start" -eq 0 ]]; then
  api_key="$(read_deepseek_api_key)"
  if [[ -z "$api_key" ]]; then
    echo "install.sh: DEEPSEEK_API_KEY is not set. Export it before starting services, or on macOS run: launchctl setenv DEEPSEEK_API_KEY <key>" >&2
    exit 1
  fi
  export DEEPSEEK_API_KEY="$api_key"
  start_service_if_needed "$port" "$mcp_start" "$node"
fi

info "Installed. Restart or reload Codex to discover mcp_servers.deepseek_subagent."
