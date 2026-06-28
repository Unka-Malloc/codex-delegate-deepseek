---
name: delegate-deepseek
description: Install, start, and dispatch DeepSeek-V4-Flash or DeepSeek-V4-Pro Codex subagents through a bundled local MCP service and Responses-to-Chat backend. Use when the user asks Codex to delegate work to DeepSeek V4, run DeepSeek V4 workers in parallel, repair the local DeepSeek delegate service, or fork the current Codex context to DeepSeek.
---

# Delegate DeepSeek

## Install

When the user asks to install, repair, or start DeepSeek V4 delegation, run:

```powershell
& "$env:CODEX_HOME\skills\delegate-deepseek\scripts\install.ps1"
```

If `CODEX_HOME` is unset, use:

```powershell
& "$env:USERPROFILE\.codex\skills\delegate-deepseek\scripts\install.ps1"
```

The installer copies the bundled scripts into `$CODEX_HOME\bin`, installs the DeepSeek Flash/Pro agent definitions, configures `model_providers.deepseek` at `http://127.0.0.1:4466/v1`, registers `mcp_servers.deepseek_subagent`, and starts the local backend. It reads `DEEPSEEK_API_KEY` from the process or user environment and never writes keys into config files, arguments, transcripts, or logs.

## Dispatch

After Codex reloads MCP servers, use:

```text
spawn_deepseek_subagent
```

Use `agent_type=deepseek_v4_flash` for fast parallel implementation or exploration. Use `agent_type=deepseek_v4_pro` for difficult review, debugging, or architecture work. Set `fork_context=true` or `context_mode=full` when the worker needs inherited thread context; use `context_mode=light` for small independent tasks.

If the MCP tool is not loaded in the current thread, use the bundled CLI fallback:

```powershell
& "$env:CODEX_HOME\bin\spawn-deepseek-subagent.ps1" --agent-type deepseek_v4_flash --fork-context --task "..."
```

## Verify

After install or repair, verify the backend:

```powershell
Invoke-RestMethod http://127.0.0.1:4466/health
```

Restart or reload Codex after installation so the registered MCP server is discovered.
