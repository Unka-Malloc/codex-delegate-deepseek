param(
    [string]$CodexHome = $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }),
    [string]$NodePath = "",
    [int]$Port = 4466,
    [switch]$NoStart
)

$ErrorActionPreference = "Stop"

$skillRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$sourceBin = Join-Path $skillRoot "scripts\bin"
$sourceAgents = Join-Path $skillRoot "scripts\agents"
$targetBin = Join-Path $CodexHome "bin"
$targetAgents = Join-Path $CodexHome "agents"
$configPath = Join-Path $CodexHome "config.toml"
$stateDir = Join-Path $CodexHome "state\delegate-deepseek"

function Info([string]$Message) {
    Write-Host "[delegate-deepseek] $Message"
}

function LiteralToml([string]$Value) {
    return "'" + ($Value -replace "'", "''") + "'"
}

function Get-NodePath {
    if ($NodePath) {
        return (Resolve-Path -LiteralPath $NodePath).Path
    }
    $cmd = Get-Command node -ErrorAction Stop
    return $cmd.Source
}

function Upsert-TomlSection([string]$Path, [string]$SectionName, [string]$Body) {
    $content = if (Test-Path -LiteralPath $Path) { Get-Content -LiteralPath $Path -Encoding UTF8 -Raw } else { "" }
    $escaped = [regex]::Escape($SectionName)
    $pattern = "(?ms)^\[$escaped\]\r?\n.*?(?=^\[|\z)"
    $replacement = $Body.TrimEnd() + "`r`n`r`n"
    if ([regex]::IsMatch($content, $pattern)) {
        $content = [regex]::Replace($content, $pattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $replacement })
    } else {
        if ($content.Length -gt 0 -and -not $content.EndsWith("`n")) {
            $content += "`r`n"
        }
        $content += "`r`n" + $replacement
    }
    Set-Content -LiteralPath $Path -Encoding UTF8 -Value $content
}

function Test-HttpOk([string]$Url) {
    try {
        $null = Invoke-RestMethod -Uri $Url -TimeoutSec 3
        return $true
    } catch {
        return $false
    }
}

function Start-ServiceIfNeeded([int]$ListenPort, [string]$Script, [string]$Node) {
    $url = "http://127.0.0.1:$ListenPort/health"
    if (Test-HttpOk $url) {
        Info "Service on port $ListenPort is already healthy."
        return
    }
    $out = Join-Path $stateDir "backend.out.log"
    $err = Join-Path $stateDir "backend.err.log"
    Info "Starting service on port $ListenPort..."
    $env:CODEX_HOME = $CodexHome
    $env:CODEX_DEEPSEEK_SERVICE_PORT = [string]$ListenPort
    $env:CODEX_DEEPSEEK_SERVICE_STATE_DIR = $stateDir
    $env:CODEX_DEEPSEEK_NODE_PATH = $Node
    Start-Process -FilePath powershell.exe -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $Script) -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err | Out-Null
    Start-Sleep -Seconds 2
    if (-not (Test-HttpOk $url)) {
        throw "Service on port $ListenPort did not become healthy. Logs: $out, $err"
    }
}

if (-not (Test-Path -LiteralPath $sourceBin)) {
    throw "Missing bundled scripts directory: $sourceBin"
}

New-Item -ItemType Directory -Force -Path $CodexHome, $targetBin, $targetAgents, $stateDir | Out-Null

Info "Installing bundled scripts to $targetBin"
Get-ChildItem -LiteralPath $sourceBin -Force | Copy-Item -Destination $targetBin -Recurse -Force

if (Test-Path -LiteralPath $sourceAgents) {
    Info "Installing DeepSeek agent definitions to $targetAgents"
    Get-ChildItem -LiteralPath $sourceAgents -Force | Copy-Item -Destination $targetAgents -Recurse -Force
}

$node = Get-NodePath
$mcpServer = Join-Path $targetBin "mcp-deepseek-subagent.mjs"
$mcpStart = Join-Path $targetBin "start-deepseek-subagent-mcp-backend.ps1"

Info "Updating $configPath"

Upsert-TomlSection $configPath "model_providers.deepseek" @"
[model_providers.deepseek]
name = "DeepSeek via local delegate backend"
base_url = "http://127.0.0.1:$Port/v1"
wire_api = "responses"
"@

Upsert-TomlSection $configPath "mcp_servers.deepseek_subagent" @"
[mcp_servers.deepseek_subagent]
args = [$(LiteralToml $mcpServer)]
command = $(LiteralToml $node)
startup_timeout_sec = 120
"@

Upsert-TomlSection $configPath "mcp_servers.deepseek_subagent.env" @"
[mcp_servers.deepseek_subagent.env]
CODEX_HOME = $(LiteralToml $CodexHome)
CODEX_DEEPSEEK_SERVICE_PORT = "$Port"
CODEX_DEEPSEEK_MODEL_PROVIDER = "deepseek"
CODEX_DEEPSEEK_SERVICE_START_SCRIPT = $(LiteralToml $mcpStart)
CODEX_DEEPSEEK_SERVICE_STATE_DIR = $(LiteralToml $stateDir)
CODEX_DEEPSEEK_NODE_PATH = $(LiteralToml $node)
"@

if (-not $NoStart) {
    $apiKey = $env:DEEPSEEK_API_KEY
    if (-not $apiKey) {
        $apiKey = [Environment]::GetEnvironmentVariable("DEEPSEEK_API_KEY", "User")
    }
    if (-not $apiKey) {
        throw "DEEPSEEK_API_KEY is not set. Set it in the User environment before starting services."
    }
    Start-ServiceIfNeeded $Port $mcpStart $node
}

Info "Installed. Restart or reload Codex to discover mcp_servers.deepseek_subagent."
