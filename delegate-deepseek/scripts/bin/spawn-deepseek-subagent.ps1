$ErrorActionPreference = "Stop"

$script = Join-Path $PSScriptRoot "delegate-deepseek-worker.mjs"
if (-not (Test-Path -LiteralPath $script)) {
    throw "Missing DeepSeek subagent scheduler script: $script"
}

node $script @args
