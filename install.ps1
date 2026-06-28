param(
    [string]$CodexHome = $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }),
    [string]$NodePath = "",
    [int]$Port = 4466,
    [switch]$NoStart
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSCommandPath
$sourceSkill = Join-Path $projectRoot "delegate-deepseek"
$targetSkills = Join-Path $CodexHome "skills"
$targetSkill = Join-Path $targetSkills "delegate-deepseek"

if (-not (Test-Path -LiteralPath (Join-Path $sourceSkill "SKILL.md"))) {
    throw "Missing skill source: $sourceSkill"
}

New-Item -ItemType Directory -Force -Path $targetSkills | Out-Null

if (Test-Path -LiteralPath $targetSkill) {
    $resolvedTarget = (Resolve-Path -LiteralPath $targetSkill).Path
    $resolvedSkills = (Resolve-Path -LiteralPath $targetSkills).Path
    if (-not $resolvedTarget.StartsWith($resolvedSkills, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to replace unexpected path: $resolvedTarget"
    }
    Remove-Item -LiteralPath $targetSkill -Recurse -Force
}

Copy-Item -LiteralPath $sourceSkill -Destination $targetSkill -Recurse

$installParams = @{
    CodexHome = $CodexHome
    Port = $Port
}
if ($NodePath) {
    $installParams.NodePath = $NodePath
}
if ($NoStart) {
    $installParams.NoStart = $true
}

& (Join-Path $targetSkill "scripts\install.ps1") @installParams
