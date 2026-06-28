#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const HOME = os.homedir();
const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, ".codex");
const SERVICE_PORT = process.env.CODEX_DEEPSEEK_SERVICE_PORT || "4466";
const SERVICE_BASE_URL = process.env.CODEX_DEEPSEEK_SERVICE_URL || `http://127.0.0.1:${SERVICE_PORT}/v1`;
const FORK_SCRIPT = process.env.CODEX_DEEPSEEK_FORK_SCRIPT || path.join(CODEX_HOME, "bin", "delegate-deepseek-worker.mjs");
const MODEL_PROVIDER = process.env.CODEX_DEEPSEEK_MODEL_PROVIDER || "deepseek";
const BACKEND_START_SCRIPT = process.env.CODEX_DEEPSEEK_SERVICE_START_SCRIPT || path.join(
  CODEX_HOME,
  "bin",
  process.platform === "win32" ? "start-deepseek-subagent-mcp-backend.ps1" : "start-deepseek-subagent-mcp-backend.sh",
);

const SERVER_INFO = {
  name: "local-deepseek-subagent",
  version: "1.0.0",
};

function log(message) {
  process.stderr.write(`[${SERVER_INFO.name}] ${message}\n`);
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message, data = undefined) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  };
}

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function toolText(text, isError = false) {
  return {
    content: [{ type: "text", text: String(text ?? "") }],
    ...(isError ? { isError: true } : {}),
  };
}

function asBool(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/^(true|1|yes|y)$/iu.test(value)) return true;
    if (/^(false|0|no|n)$/iu.test(value)) return false;
  }
  return Boolean(value);
}

function asInt(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function statusUrl(pathname) {
  return `${SERVICE_BASE_URL.replace(/\/+$/u, "")}${pathname}`;
}

async function serviceStatus() {
  try {
    const response = await fetch(statusUrl("/health"), {
      signal: AbortSignal.timeout(2500),
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      body: text,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      body: error.message,
    };
  }
}

async function handleDeepseekServiceStatus() {
  const status = await serviceStatus();
  return toolText(JSON.stringify({
    service: "codex-deepseek-service",
    url: statusUrl("/health"),
    ok: status.ok,
    status: status.status,
    body: safeParseJson(status.body),
  }, null, 2));
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function validateAgentType(agentType) {
  const normalized = cleanString(agentType || "deepseek_v4_flash").replaceAll("-", "_");
  if (!["deepseek_v4_flash", "deepseek_v4_pro"].includes(normalized)) {
    throw new Error(`Unsupported agent_type: ${agentType}. Use deepseek_v4_flash or deepseek_v4_pro.`);
  }
  return normalized;
}

function spawnDeepseekSubagent(args) {
  if (!fs.existsSync(FORK_SCRIPT)) {
    throw new Error(`Fork scheduler script not found: ${FORK_SCRIPT}`);
  }

  const task = cleanString(args.task || args.message);
  if (!task) {
    throw new Error("task is required");
  }

  const agentType = validateAgentType(args.agent_type || args.agentType);
  const forkContext = asBool(args.fork_context ?? args.forkContext, true);
  const contextMode = cleanString(args.context_mode || args.contextMode) || (forkContext ? "full" : "light");
  if (!["full", "light"].includes(contextMode)) {
    throw new Error("context_mode must be full or light");
  }

  const background = asBool(args.background, false);
  const ephemeral = asBool(args.ephemeral, true);
  const timeoutMs = asInt(args.timeout_ms ?? args.timeoutMs, background ? 30_000 : 300_000, 10_000, 3_600_000);

  const argv = [
    FORK_SCRIPT,
    "--model-provider", MODEL_PROVIDER,
    "--agent-type", agentType,
    "--context-mode", contextMode,
    "--task", task,
  ];

  if (args.model) argv.push("--model", String(args.model));
  if (args.thread_id || args.threadId) argv.push("--thread-id", String(args.thread_id || args.threadId));
  if (args.transcript) argv.push("--transcript", String(args.transcript));
  if (args.cwd) argv.push("--cwd", String(args.cwd));
  if (args.max_chars || args.maxChars) argv.push("--max-chars", String(asInt(args.max_chars ?? args.maxChars, 60000, 10000)));
  if (args.tail_events || args.tailEvents) argv.push("--tail-events", String(asInt(args.tail_events ?? args.tailEvents, 80, 10)));
  if (ephemeral) argv.push("--ephemeral");
  if (background) argv.push("--background");

  const child = spawnSync(process.execPath, argv, {
    cwd: cleanString(args.cwd) || process.cwd(),
    env: {
      ...process.env,
      CODEX_DEEPSEEK_SERVICE_PORT: String(SERVICE_PORT),
      CODEX_DEEPSEEK_SERVICE_URL: SERVICE_BASE_URL,
      CODEX_DEEPSEEK_SERVICE_MODELS_URL: `${SERVICE_BASE_URL.replace(/\/+$/u, "")}/models`,
      CODEX_DEEPSEEK_SERVICE_START_SCRIPT: BACKEND_START_SCRIPT,
      CODEX_DEEPSEEK_MODEL_PROVIDER: MODEL_PROVIDER,
    },
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 64,
    windowsHide: true,
  });

  const result = {
    ok: child.status === 0 && !child.error,
    code: child.status,
    signal: child.signal,
    error: child.error ? child.error.message : null,
    agent_type: agentType,
    fork_context: forkContext,
    context_mode: contextMode,
    background,
    stdout: child.stdout || "",
    stderr: child.stderr || "",
  };

  return toolText(JSON.stringify(result, null, 2), !result.ok);
}

const tools = [
  {
    name: "spawn_deepseek_subagent",
    title: "Spawn DeepSeek Subagent",
    description: [
      "Spawn a local DeepSeek V4 Codex subagent through the transcript-based fork scheduler.",
      "Use this instead of native spawn_agent when agent_type and full-history fork are both needed.",
      "Supports deepseek_v4_flash and deepseek_v4_pro, full or light context, foreground or background execution.",
    ].join(" "),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        task: {
          type: "string",
          description: "Continuation task for the DeepSeek subagent.",
        },
        agent_type: {
          type: "string",
          enum: ["deepseek_v4_flash", "deepseek_v4_pro"],
          default: "deepseek_v4_flash",
          description: "DeepSeek subagent type.",
        },
        fork_context: {
          type: "boolean",
          default: true,
          description: "True uses full transcript context; false uses lightweight task context.",
        },
        context_mode: {
          type: "string",
          enum: ["full", "light"],
          description: "Explicit context mode. Overrides fork_context-derived mode.",
        },
        thread_id: {
          type: "string",
          description: "Source Codex thread id. Defaults to CODEX_THREAD_ID if available.",
        },
        transcript: {
          type: "string",
          description: "Explicit Codex JSONL transcript path.",
        },
        cwd: {
          type: "string",
          description: "Working directory for the child Codex worker.",
        },
        max_chars: {
          type: "integer",
          minimum: 10000,
          default: 60000,
          description: "Maximum inherited transcript characters for full context.",
        },
        tail_events: {
          type: "integer",
          minimum: 10,
          default: 80,
          description: "Number of recent transcript events to consider.",
        },
        background: {
          type: "boolean",
          default: false,
          description: "If true, starts the worker detached and returns artifact paths quickly.",
        },
        ephemeral: {
          type: "boolean",
          default: true,
          description: "Pass --ephemeral to codex exec.",
        },
        timeout_ms: {
          type: "integer",
          minimum: 10000,
          maximum: 3600000,
          default: 300000,
          description: "Foreground scheduler timeout in milliseconds.",
        },
      },
      required: ["task"],
    },
  },
  {
    name: "deepseek_subagent_status",
    title: "DeepSeek Subagent Status",
    description: "Check the local codex-deepseek-service status used by DeepSeek subagents.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
];

async function handleRequest(message) {
  const { id, method, params = {} } = message;

  if (method === "initialize") {
    return jsonRpcResult(id, {
      protocolVersion: params.protocolVersion || "2025-06-18",
      capabilities: {
        tools: {},
      },
      serverInfo: SERVER_INFO,
    });
  }

  if (method === "ping") {
    return jsonRpcResult(id, {});
  }

  if (method === "tools/list") {
    return jsonRpcResult(id, { tools });
  }

  if (method === "tools/call") {
    const toolName = params.name;
    const toolArgs = params.arguments || {};
    if (toolName === "spawn_deepseek_subagent") {
      return jsonRpcResult(id, spawnDeepseekSubagent(toolArgs));
    }
    if (toolName === "deepseek_subagent_status") {
      return jsonRpcResult(id, await handleDeepseekServiceStatus());
    }
    return jsonRpcError(id, -32601, `Unknown tool: ${toolName}`);
  }

  return jsonRpcError(id, -32601, `Unknown method: ${method}`);
}

function isNotification(message) {
  return !Object.prototype.hasOwnProperty.call(message, "id");
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/u);
  buffer = lines.pop() || "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch (error) {
      log(`invalid JSON-RPC line ignored: ${error.message}`);
      continue;
    }
    Promise.resolve()
      .then(() => {
        if (isNotification(message)) return null;
        return handleRequest(message);
      })
      .then(response => {
        if (response) writeMessage(response);
      })
      .catch(error => {
        const id = Object.prototype.hasOwnProperty.call(message, "id") ? message.id : null;
        writeMessage(jsonRpcError(id, -32603, error.message));
      });
  }
});

log(`ready; service=${SERVICE_BASE_URL}; model_provider=${MODEL_PROVIDER}; fork_script=${FORK_SCRIPT}`);
