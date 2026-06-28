# codex-delegate-deepseek

Minimal Codex skill for delegating work to local DeepSeek-V4-Flash and DeepSeek-V4-Pro workers through a bundled MCP server.

## Install

Set `DEEPSEEK_API_KEY` in your environment, then run:

```powershell
.\install.ps1
```

The installer copies the `delegate-deepseek` skill into `$CODEX_HOME\skills`, registers `mcp_servers.deepseek_subagent`, configures `model_providers.deepseek` on `http://127.0.0.1:4466/v1`, and starts the local backend.

Restart or reload Codex after installation.
