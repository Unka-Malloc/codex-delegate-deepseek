$ErrorActionPreference = "Stop"

$service = Join-Path $PSScriptRoot "codex-deepseek-service.mjs"
if (-not (Test-Path -LiteralPath $service)) {
    throw "Missing DeepSeek backend script: $service"
}

$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }
$stateDir = if ($env:CODEX_DEEPSEEK_SERVICE_STATE_DIR) { $env:CODEX_DEEPSEEK_SERVICE_STATE_DIR } else { Join-Path $codexHome "state\delegate-deepseek" }
$port = if ($env:CODEX_DEEPSEEK_SERVICE_PORT) { $env:CODEX_DEEPSEEK_SERVICE_PORT } else { "4466" }
$node = if ($env:CODEX_DEEPSEEK_NODE_PATH) { $env:CODEX_DEEPSEEK_NODE_PATH } else { (Get-Command node -ErrorAction Stop).Source }

$apiKey = $env:DEEPSEEK_API_KEY
if (-not $apiKey) {
    $apiKey = [Environment]::GetEnvironmentVariable("DEEPSEEK_API_KEY", "User")
}
if (-not $apiKey) {
    throw "DEEPSEEK_API_KEY is not set. Set it in the User environment, then rerun this script."
}

New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

$env:DEEPSEEK_API_KEY = $apiKey
$upstream = if ($env:CODEX_DEEPSEEK_SERVICE_UPSTREAM) { $env:CODEX_DEEPSEEK_SERVICE_UPSTREAM } else { "https://api.deepseek.com/v1" }
$logPath = if ($env:CODEX_DEEPSEEK_SERVICE_LOG) { $env:CODEX_DEEPSEEK_SERVICE_LOG } else { Join-Path $stateDir "backend.jsonl" }
$sessionDir = if ($env:CODEX_DEEPSEEK_SERVICE_SESSION_DIR) { $env:CODEX_DEEPSEEK_SERVICE_SESSION_DIR } else { Join-Path $stateDir "sessions" }

& $node $service --port $port --upstream $upstream --log $logPath --session-dir $sessionDir
