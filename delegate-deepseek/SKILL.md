---
name: delegate-deepseek
description: Install, start, and dispatch DeepSeek-V4-Flash or DeepSeek-V4-Pro Codex subagents through a bundled local MCP service and Responses-to-Chat backend. Use when the user asks Codex to delegate work to DeepSeek V4, run DeepSeek V4 workers in parallel, repair the local DeepSeek delegate service, or fork the current Codex context to DeepSeek.
---

# Delegate DeepSeek

## Install

When the user asks to install, repair, or start DeepSeek V4 delegation, run:

```bash
"${CODEX_HOME:-$HOME/.codex}/skills/delegate-deepseek/scripts/install.sh"
```

If `CODEX_HOME` is unset, use:

```bash
"$HOME/.codex/skills/delegate-deepseek/scripts/install.sh"
```

The installer copies the bundled scripts into `$CODEX_HOME/bin`, installs the DeepSeek Flash/Pro agent definitions, configures `model_providers.deepseek` at `http://127.0.0.1:4466/v1`, registers `mcp_servers.deepseek_subagent`, and starts the local backend. On macOS, read `DEEPSEEK_API_KEY` from the process environment or `launchctl getenv DEEPSEEK_API_KEY`; never write keys into config files, arguments, transcripts, or logs.

For Codex Desktop on macOS, prefer setting the key in the launch environment before install:

```bash
launchctl setenv DEEPSEEK_API_KEY "..."
```

## Configuration

Use Codex's native provider configuration for delegation. The installer writes
these user-level entries to `$CODEX_HOME/config.toml`:

- `[model_providers.deepseek]` with `base_url = "http://127.0.0.1:4466/v1"` and
  `wire_api = "responses"`.
- `[mcp_servers.deepseek_subagent]` for the MCP tool entry point and startup
  environment.
- `model_catalog_json` pointing at
  `$CODEX_HOME/model-catalogs/delegate-deepseek.json`, a generated merge of the
  current Codex catalog plus DeepSeek model metadata.

Do not put `model_provider`, `model_providers`, `openai_base_url`, or
credential-bearing provider settings in project-local `.codex/config.toml`.
Codex treats those as user-level provider/auth settings. Keep
`DEEPSEEK_API_KEY` in the environment or macOS launch environment and let the
local backend adapt Codex Responses calls to DeepSeek upstream calls.

If Codex prints `Unknown model deepseek-v4-flash is used`, regenerate and install
the merged catalog by rerunning the installer. `model_catalog_json` is a full
catalog override, so never replace it with a DeepSeek-only catalog unless the
user explicitly wants to hide the built-in model catalog.

## Dispatch

After Codex reloads MCP servers, use:

```text
spawn_deepseek_subagent
```

Use `agent_type=deepseek_v4_flash` for fast parallel implementation or exploration. Use `agent_type=deepseek_v4_pro` for difficult review, debugging, or architecture work. Set `fork_context=true` or `context_mode=full` when the worker needs inherited thread context; use `context_mode=light` for small independent tasks.

If the MCP tool is not loaded in the current thread, use the bundled CLI fallback:

```bash
"${CODEX_HOME:-$HOME/.codex}/bin/spawn-deepseek-subagent.sh" --agent-type deepseek_v4_flash --fork-context --task "..."
```

For work that should be monitored while it runs, call `spawn_deepseek_subagent`
with `background=true`. The tool returns a `job_id`; then use:

- `deepseek_subagent_wait` to long-poll for new output or completion.
- `deepseek_subagent_tail` to read stdout/stderr deltas with byte cursors.
- `deepseek_subagent_job_status` to read status and final reply text.
- `deepseek_subagent_cancel` to stop a verified running worker.

These MCP tools are backed by the local `codex-deepseek-service` HTTP job API
under `/v1/codex/jobs`, so the MCP process does not directly supervise the
worker process.

## Verify

After install or repair, verify the backend:

```bash
curl -fsS http://127.0.0.1:4466/health
```

Restart or reload Codex after installation so the registered MCP server is discovered.
