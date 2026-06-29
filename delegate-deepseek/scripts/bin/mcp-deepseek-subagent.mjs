#!/usr/bin/env node

const SERVICE_PORT = process.env.CODEX_DEEPSEEK_SERVICE_PORT || "4466";
const SERVICE_BASE_URL = process.env.CODEX_DEEPSEEK_SERVICE_URL || `http://127.0.0.1:${SERVICE_PORT}/v1`;

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

async function serviceJson(pathname, { method = "GET", body = undefined } = {}) {
  const response = await fetch(statusUrl(pathname), {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(310000),
  });
  const text = await response.text();
  const data = safeParseJson(text);
  if (!response.ok) {
    const message = typeof data === "object" && data?.error?.message
      ? data.error.message
      : text || `HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.body = data;
    throw error;
  }
  return data;
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

function cleanJobId(value) {
  const jobId = cleanString(value);
  if (!jobId) throw new Error("job_id is required");
  if (!/^[A-Za-z0-9_.-]+$/u.test(jobId)) {
    throw new Error("job_id may only contain letters, numbers, dots, dashes, and underscores");
  }
  return jobId;
}

function handleJobStatus(args) {
  const jobId = cleanJobId(args.job_id || args.jobId);
  const maxBytes = asInt(args.max_bytes ?? args.maxBytes, 20000, 1024, 1024 * 1024);
  const includeFinal = asBool(args.include_final ?? args.includeFinal, true);
  const search = new URLSearchParams({
    include_final: includeFinal ? "true" : "false",
    max_bytes: String(maxBytes),
  });
  return serviceJson(`/codex/jobs/${encodeURIComponent(jobId)}?${search}`).then(data => (
    toolText(JSON.stringify(data, null, 2))
  ));
}

function handleJobTail(args) {
  const jobId = cleanJobId(args.job_id || args.jobId);
  return serviceJson(`/codex/jobs/${encodeURIComponent(jobId)}/tail`, {
    method: "POST",
    body: args,
  }).then(data => toolText(JSON.stringify(data, null, 2)));
}

async function handleJobWait(args) {
  const jobId = cleanJobId(args.job_id || args.jobId);
  const data = await serviceJson(`/codex/jobs/${encodeURIComponent(jobId)}/wait`, {
    method: "POST",
    body: args,
  });
  return toolText(JSON.stringify(data, null, 2));
}

function handleJobList(args) {
  const search = new URLSearchParams({
    limit: String(asInt(args.limit, 20, 1, 200)),
  });
  return serviceJson(`/codex/jobs?${search}`).then(data => toolText(JSON.stringify(data, null, 2)));
}

function handleJobCancel(args) {
  const jobId = cleanJobId(args.job_id || args.jobId);
  return serviceJson(`/codex/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
    body: args,
  }).then(data => toolText(JSON.stringify(data, null, 2), Array.isArray(data.errors) && data.errors.length > 0));
}

async function spawnDeepseekSubagent(args) {
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
  const result = await serviceJson("/codex/subagent", {
    method: "POST",
    body: {
      ...args,
      task,
      agent_type: agentType,
      fork_context: forkContext,
      context_mode: contextMode,
      background,
    },
  });
  if (result.job_id) {
    result.monitoring = {
      status_tool: "deepseek_subagent_job_status",
      tail_tool: "deepseek_subagent_tail",
      wait_tool: "deepseek_subagent_wait",
      cancel_tool: "deepseek_subagent_cancel",
    };
  }
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
  {
    name: "deepseek_subagent_list",
    title: "List DeepSeek Subagent Jobs",
    description: "List recent DeepSeek worker jobs and their current file/process status.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          default: 20,
          description: "Maximum number of recent jobs to return.",
        },
      },
    },
  },
  {
    name: "deepseek_subagent_job_status",
    title: "DeepSeek Subagent Job Status",
    description: "Check one DeepSeek worker job by job_id, including process liveness and final reply when available.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        job_id: {
          type: "string",
          description: "Job id returned by spawn_deepseek_subagent.",
        },
        include_final: {
          type: "boolean",
          default: true,
          description: "Include the final reply text when the final artifact exists.",
        },
        max_bytes: {
          type: "integer",
          minimum: 1024,
          maximum: 1048576,
          default: 20000,
          description: "Maximum bytes to read from the final reply artifact.",
        },
      },
      required: ["job_id"],
    },
  },
  {
    name: "deepseek_subagent_tail",
    title: "Tail DeepSeek Subagent Job",
    description: "Read stdout/stderr deltas for a DeepSeek worker job using byte cursors.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        job_id: {
          type: "string",
          description: "Job id returned by spawn_deepseek_subagent.",
        },
        stdout_cursor: {
          type: "integer",
          minimum: 0,
          description: "Byte offset for stdout. Omit to read the latest tail.",
        },
        stderr_cursor: {
          type: "integer",
          minimum: 0,
          description: "Byte offset for stderr. Omit to read the latest tail.",
        },
        max_bytes: {
          type: "integer",
          minimum: 1024,
          maximum: 1048576,
          default: 20000,
          description: "Maximum bytes to read from each stream.",
        },
      },
      required: ["job_id"],
    },
  },
  {
    name: "deepseek_subagent_wait",
    title: "Wait For DeepSeek Subagent Job",
    description: "Long-poll a DeepSeek worker job until new output is available, the job completes, or timeout expires.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        job_id: {
          type: "string",
          description: "Job id returned by spawn_deepseek_subagent.",
        },
        stdout_cursor: {
          type: "integer",
          minimum: 0,
          default: 0,
          description: "Current stdout byte cursor.",
        },
        stderr_cursor: {
          type: "integer",
          minimum: 0,
          default: 0,
          description: "Current stderr byte cursor.",
        },
        timeout_ms: {
          type: "integer",
          minimum: 1000,
          maximum: 300000,
          default: 30000,
          description: "Maximum wait time in milliseconds.",
        },
        interval_ms: {
          type: "integer",
          minimum: 100,
          maximum: 10000,
          default: 500,
          description: "Polling interval in milliseconds.",
        },
        max_bytes: {
          type: "integer",
          minimum: 1024,
          maximum: 1048576,
          default: 20000,
          description: "Maximum bytes to read from each stream after waiting.",
        },
      },
      required: ["job_id"],
    },
  },
  {
    name: "deepseek_subagent_cancel",
    title: "Cancel DeepSeek Subagent Job",
    description: "Terminate a running DeepSeek worker process by job_id and mark the job canceled.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        job_id: {
          type: "string",
          description: "Job id returned by spawn_deepseek_subagent.",
        },
      },
      required: ["job_id"],
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
      return jsonRpcResult(id, await spawnDeepseekSubagent(toolArgs));
    }
    if (toolName === "deepseek_subagent_status") {
      return jsonRpcResult(id, await handleDeepseekServiceStatus());
    }
    if (toolName === "deepseek_subagent_list") {
      return jsonRpcResult(id, await handleJobList(toolArgs));
    }
    if (toolName === "deepseek_subagent_job_status") {
      return jsonRpcResult(id, await handleJobStatus(toolArgs));
    }
    if (toolName === "deepseek_subagent_tail") {
      return jsonRpcResult(id, await handleJobTail(toolArgs));
    }
    if (toolName === "deepseek_subagent_wait") {
      return jsonRpcResult(id, await handleJobWait(toolArgs));
    }
    if (toolName === "deepseek_subagent_cancel") {
      return jsonRpcResult(id, await handleJobCancel(toolArgs));
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

log(`ready; service=${SERVICE_BASE_URL}`);
