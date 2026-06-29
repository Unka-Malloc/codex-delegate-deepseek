# codex-delegate-deepseek

Minimal Codex skill for delegating work to local DeepSeek-V4-Flash and DeepSeek-V4-Pro workers through a bundled MCP server.

## Install

On macOS, set `DEEPSEEK_API_KEY` in the launch environment so Codex Desktop can read it, then run:

```bash
launchctl setenv DEEPSEEK_API_KEY "..."
./install.sh
```

The installer copies the `delegate-deepseek` skill into `$CODEX_HOME/skills`, registers `mcp_servers.deepseek_subagent`, configures `model_providers.deepseek` on `http://127.0.0.1:4466/v1`, and starts the local backend.

To install without starting the backend:

```bash
./install.sh --no-start
```

## Codex configuration

This skill uses Codex's native provider configuration instead of encoding model
or credential details in the skill file. The installer writes user-level entries
to `$CODEX_HOME/config.toml`:

- `[model_providers.deepseek]` points Codex at the local delegate backend on
  `http://127.0.0.1:4466/v1`.
- `[mcp_servers.deepseek_subagent]` registers the MCP tool that starts and
  dispatches DeepSeek workers.
- `model_catalog_json` points at a generated merged catalog under
  `$CODEX_HOME/model-catalogs/delegate-deepseek.json`, so Codex knows the
  DeepSeek model metadata without losing its built-in OpenAI model entries.
- `$CODEX_HOME/agents/deepseek-v4-flash.toml` and
  `$CODEX_HOME/agents/deepseek-v4-pro.toml` select `model_provider = "deepseek"`.

Keep provider and MCP registration in the user-level Codex config. Project-local
`.codex/config.toml` files are for trusted repo overrides and are not the right
place for provider auth or `model_providers` entries. Keep `DEEPSEEK_API_KEY` in
the process environment, macOS launch environment, or another local secret
mechanism; do not write it into Codex config, agent files, transcripts, or logs.

`model_catalog_json` replaces the catalog Codex sees, so the installer generates
it by reading Codex's bundled catalog with `codex debug models --bundled` and
appending the DeepSeek entries. Do not point `model_catalog_json` at a file
containing only DeepSeek models unless you intentionally want to hide Codex's
built-in models.

Restart or reload Codex after installation.

## Monitoring DeepSeek workers

Use `spawn_deepseek_subagent` with `background=true` for long-running work. The
MCP server forwards the request to the local `codex-deepseek-service`; the MCP
process does not directly own the worker process.

The spawn result includes `job_id`, artifact paths, and the monitoring tools to
use next:

- `deepseek_subagent_wait`: long-poll until new output is available or the job
  finishes.
- `deepseek_subagent_tail`: read stdout/stderr deltas using byte cursors.
- `deepseek_subagent_job_status`: inspect status, process liveness, and final
  reply text when available.
- `deepseek_subagent_cancel`: conservatively cancel a running worker only when
  the service can verify the process still belongs to that job.

The service also exposes the same state over HTTP under `/v1/codex/jobs`. Worker
metadata is persisted in `$CODEX_HOME/state/delegate-deepseek/workers/*.job.json`
so monitoring can survive MCP process restarts.
