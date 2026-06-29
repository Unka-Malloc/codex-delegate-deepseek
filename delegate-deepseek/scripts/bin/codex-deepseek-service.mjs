#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const HOME = os.homedir();
const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, ".codex");
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4466;
const DEFAULT_UPSTREAM = "https://api.deepseek.com/v1";
const DEFAULT_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro"];

function usage(exitCode = 0) {
  const text = `
Usage:
  codex-deepseek-service [options]

Options:
  --host <host>           Listen host. Default: 127.0.0.1.
  --port <port>           Listen port. Default: 4466.
  --upstream <url>        DeepSeek Chat Completions base URL. Default: https://api.deepseek.com/v1.
  --models <csv>          Local model catalog. Default: deepseek-v4-flash,deepseek-v4-pro.
  --session-dir <path>    Disk session directory. Default: CODEX_HOME/state/delegate-deepseek/sessions.
  --worker-state-dir <path>
                          Worker job state directory. Default: CODEX_HOME/state/delegate-deepseek/workers.
  --fork-script <path>    Worker scheduler script. Default: CODEX_HOME/bin/delegate-deepseek-worker.mjs.
  --log <path>            JSONL service log. Default: CODEX_HOME/state/delegate-deepseek/backend.jsonl.
  --no-upstream-models    Do not merge upstream /models into the local model catalog.
  --help                  Show this help.

Environment:
  DEEPSEEK_API_KEY or CODEX_DEEPSEEK_API_KEY is required for upstream calls.
  CODEX_DEEPSEEK_SERVICE_PORT, CODEX_DEEPSEEK_SERVICE_UPSTREAM, and
  CODEX_DEEPSEEK_SERVICE_MODELS can override the defaults.

Scheduler endpoint:
  POST /v1/codex/fork accepts task/message, agent_type, model, fork_context,
  context_mode, thread_id, transcript, cwd, max_chars, tail_events, background,
  and ephemeral. This endpoint intentionally supports agent_type with
  fork_context=true by using the local transcript-based DeepSeek fork path
  instead of Codex's native full-history subagent fork.
`;
  process.stdout.write(text.trimStart());
  process.exit(exitCode);
}

function parseArgs(argv) {
  const opts = {
    host: process.env.CODEX_DEEPSEEK_SERVICE_HOST || DEFAULT_HOST,
    port: Number(process.env.CODEX_DEEPSEEK_SERVICE_PORT || DEFAULT_PORT),
    upstream: process.env.CODEX_DEEPSEEK_SERVICE_UPSTREAM || DEFAULT_UPSTREAM,
    models: (process.env.CODEX_DEEPSEEK_SERVICE_MODELS || DEFAULT_MODELS.join(","))
      .split(",")
      .map(s => s.trim())
      .filter(Boolean),
    sessionDir: process.env.CODEX_DEEPSEEK_SERVICE_SESSION_DIR || path.join(CODEX_HOME, "state", "delegate-deepseek", "sessions"),
    workerStateDir: process.env.CODEX_DEEPSEEK_WORKER_STATE_DIR || path.join(CODEX_HOME, "state", "delegate-deepseek", "workers"),
    forkScript: process.env.CODEX_DEEPSEEK_FORK_SCRIPT || path.join(CODEX_HOME, "bin", "delegate-deepseek-worker.mjs"),
    logPath: process.env.CODEX_DEEPSEEK_SERVICE_LOG || path.join(CODEX_HOME, "state", "delegate-deepseek", "backend.jsonl"),
    upstreamModels: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[++i];
    };
    switch (arg) {
      case "--host":
        opts.host = next();
        break;
      case "--port":
        opts.port = Number(next());
        break;
      case "--upstream":
        opts.upstream = next();
        break;
      case "--models":
        opts.models = next().split(",").map(s => s.trim()).filter(Boolean);
        break;
      case "--session-dir":
        opts.sessionDir = path.resolve(next());
        break;
      case "--worker-state-dir":
        opts.workerStateDir = path.resolve(next());
        break;
      case "--fork-script":
        opts.forkScript = path.resolve(next());
        break;
      case "--log":
        opts.logPath = path.resolve(next());
        break;
      case "--no-upstream-models":
        opts.upstreamModels = false;
        break;
      case "--help":
      case "-h":
        usage(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(opts.port) || opts.port < 1 || opts.port > 65535) {
    throw new Error("--port must be between 1 and 65535");
  }
  if (opts.models.length === 0) {
    throw new Error("--models must include at least one model id");
  }
  opts.upstream = opts.upstream.replace(/\/+$/u, "");
  return opts;
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function sanitizeFileName(value) {
  return String(value || "").replace(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 160);
}

function asInt(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function redact(text) {
  return String(text || "")
    .replace(/(Authorization\s*:\s*Bearer\s+)([A-Za-z0-9._~+/=-]{12,})/giu, "$1[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/giu, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9._-]{12,}\b/gu, "sk-[REDACTED]");
}

function makeLogger(logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  return (event, fields = {}) => {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...fields,
    });
    fs.appendFile(logPath, `${redact(line)}\n`, () => {});
  };
}

class SessionStore {
  constructor(root, maxSessions = 256) {
    this.root = root;
    this.maxSessions = maxSessions;
    this.reasoning = new Map();
    fs.mkdirSync(root, { recursive: true });
  }

  sessionPath(responseId) {
    return path.join(this.root, `${sanitizeFileName(responseId)}.json`);
  }

  reasoningPath(callId) {
    return path.join(this.root, `reasoning-${sanitizeFileName(callId)}.json`);
  }

  getHistory(responseId) {
    if (!responseId) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.sessionPath(responseId), "utf8"));
      return Array.isArray(parsed.messages) ? parsed.messages : [];
    } catch {
      return [];
    }
  }

  save(responseId, messages) {
    fs.writeFileSync(this.sessionPath(responseId), JSON.stringify({
      schema: "codex-deepseek-service.session.v1",
      response_id: responseId,
      updated_at: new Date().toISOString(),
      messages,
    }), "utf8");
    this.prune();
  }

  storeReasoning(callId, reasoning) {
    if (!callId || !reasoning) return;
    this.reasoning.set(callId, reasoning);
    fs.writeFileSync(this.reasoningPath(callId), JSON.stringify({
      schema: "codex-deepseek-service.reasoning.v1",
      call_id: callId,
      updated_at: new Date().toISOString(),
      reasoning,
    }), "utf8");
  }

  getReasoning(callId) {
    if (!callId) return null;
    if (this.reasoning.has(callId)) return this.reasoning.get(callId);
    try {
      const parsed = JSON.parse(fs.readFileSync(this.reasoningPath(callId), "utf8"));
      if (typeof parsed.reasoning === "string") {
        this.reasoning.set(callId, parsed.reasoning);
        return parsed.reasoning;
      }
    } catch {}
    return null;
  }

  prune() {
    const files = fs.readdirSync(this.root)
      .filter(name => /^resp_.*\.json$/u.test(name))
      .map(name => {
        const full = path.join(this.root, name);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const stale of files.slice(this.maxSessions)) {
      try {
        fs.unlinkSync(stale.full);
      } catch {}
    }
  }
}

function asTextContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(part => {
    if (!part || typeof part !== "object") return "";
    return part.text || part.output_text || part.input_text || "";
  }).join("");
}

function mapContentPart(part) {
  if (!part || typeof part !== "object") return part;
  const kind = part.type;
  if (kind === "input_text" || kind === "output_text" || kind === "text") {
    return { type: "text", text: part.text || "" };
  }
  if (kind === "input_image") {
    const url = part.image_url || part.image || part.url || "";
    return { type: "image_url", image_url: typeof url === "string" ? { url } : url };
  }
  if (kind === "image_url") {
    const imageUrl = part.image_url;
    return { type: "image_url", image_url: typeof imageUrl === "string" ? { url: imageUrl } : imageUrl };
  }
  return part;
}

function valueToChatContent(value) {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const hasNonText = value.some(part => {
      const kind = part && typeof part === "object" ? part.type : "";
      return !["input_text", "output_text", "text"].includes(kind);
    });
    if (!hasNonText) return asTextContent(value);
    return value.map(mapContentPart);
  }
  return JSON.stringify(value);
}

function safeToolName(name) {
  const cleaned = String(name || "tool").replace(/[^A-Za-z0-9_-]/gu, "_");
  return cleaned.slice(0, 64) || "tool";
}

function chatFunctionNameForNamespace(namespace, name) {
  return safeToolName(`${namespace}-${name}`);
}

function namespaceToolMap(tools = []) {
  const map = new Map();
  for (const tool of tools) {
    if (tool?.type !== "namespace") continue;
    const namespace = tool.name || "";
    for (const sub of Array.isArray(tool.tools) ? tool.tools : []) {
      if (sub?.type !== "function" || !sub.name) continue;
      const chatName = chatFunctionNameForNamespace(namespace, sub.name);
      map.set(chatName, { namespace, name: sub.name });
    }
  }
  return map;
}

function convertToolWithName(tool, overrideName = null) {
  if (!tool || typeof tool !== "object") return tool;
  if (tool.type !== "function" && tool.type !== "namespace" && !tool.function) return null;
  if (tool.function && typeof tool.function === "object") {
    const out = JSON.parse(JSON.stringify(tool));
    if (overrideName) out.function.name = overrideName;
    return out;
  }
  if (tool.type !== "function") return null;
  const func = {
    name: safeToolName(overrideName || tool.name),
  };
  if (tool.description) func.description = tool.description;
  if (tool.parameters) func.parameters = tool.parameters;
  if (tool.input_schema) func.parameters = tool.input_schema;
  if (Object.prototype.hasOwnProperty.call(tool, "strict")) func.strict = tool.strict;
  return { type: "function", function: func };
}

function deniedToolNames() {
  return new Set((process.env.CODEX_DEEPSEEK_TOOL_DENYLIST || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean));
}

function convertTools(tools = []) {
  const denied = deniedToolNames();
  const out = [];
  for (const tool of tools) {
    if (tool?.type === "function") {
      const name = safeToolName(tool.name || tool.function?.name || "");
      if (!denied.has(name)) out.push(convertToolWithName(tool, name));
    } else if (tool?.type === "namespace") {
      const namespace = tool.name || "";
      for (const sub of Array.isArray(tool.tools) ? tool.tools : []) {
        if (sub?.type !== "function") continue;
        const name = chatFunctionNameForNamespace(namespace, sub.name || "");
        if (!denied.has(name)) out.push(convertToolWithName(sub, name));
      }
    }
  }
  return out.filter(Boolean);
}

function responseFunctionNameForResponses(rawName, nsMap) {
  if (nsMap.has(rawName)) return nsMap.get(rawName);
  const mcp = /^mcp__(.+?)__(.+)$/u.exec(rawName);
  if (mcp) return { namespace: `mcp__${mcp[1]}__`, name: mcp[2] };
  return { namespace: null, name: rawName };
}

function toolCallIds(messages) {
  const ids = new Set();
  for (const msg of messages) {
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc?.id) ids.add(tc.id);
      }
    }
    if (msg.tool_call_id) ids.add(msg.tool_call_id);
  }
  return ids;
}

function toolResponseIds(messages) {
  return new Set(messages.map(msg => msg.tool_call_id).filter(Boolean));
}

function responseItemFunctionNameForChat(item) {
  const name = item.name || "";
  const namespace = item.namespace || "";
  return namespace ? chatFunctionNameForNamespace(namespace, name) : safeToolName(name);
}

function appendResponsesInput(messages, input, sessions) {
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }
  if (!Array.isArray(input)) return messages;

  const existingCalls = toolCallIds(messages);
  const existingToolResponses = toolResponseIds(messages);
  let i = 0;
  while (i < input.length) {
    const item = input[i] || {};
    const kind = item.type || "";
    if (kind === "function_call") {
      const grouped = [];
      let reasoning = null;
      while (i < input.length && input[i]?.type === "function_call") {
        const cur = input[i];
        const callId = cur.call_id || cur.id || id("call");
        if (!existingCalls.has(callId)) {
          const rawName = responseItemFunctionNameForChat(cur);
          const args = typeof cur.arguments === "string" ? cur.arguments : JSON.stringify(cur.arguments || {});
          grouped.push({
            id: callId,
            type: "function",
            function: { name: rawName, arguments: args },
          });
          reasoning ||= sessions.getReasoning(callId);
        }
        i += 1;
      }
      if (grouped.length > 0) {
        const msg = { role: "assistant", content: null, tool_calls: grouped };
        if (reasoning) msg.reasoning_content = reasoning;
        messages.push(msg);
      }
      continue;
    }

    if (kind === "function_call_output") {
      const callId = item.call_id || "";
      if (callId && !existingToolResponses.has(callId)) {
        messages.push({
          role: "tool",
          content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
          tool_call_id: callId,
        });
      }
      i += 1;
      continue;
    }

    if (kind === "reasoning") {
      i += 1;
      continue;
    }

    let role = item.role || "user";
    if (role === "developer") role = "system";
    const msg = {
      role,
      content: valueToChatContent(item.content),
    };
    if (role === "system") {
      const firstSystem = messages.findIndex(m => m.role === "system");
      if (firstSystem >= 0) messages[firstSystem] = msg;
      else messages.unshift(msg);
    } else {
      messages.push(msg);
    }
    i += 1;
  }
  return messages;
}

function requestToChat(req, history, sessions) {
  const messages = [...history];
  const systemText = req.instructions || req.system;
  if (systemText && !messages.some(m => m.role === "system")) {
    messages.unshift({ role: "system", content: systemText });
  }
  appendResponsesInput(messages, req.input, sessions);

  const chat = {
    model: req.model,
    messages,
    stream: Boolean(req.stream),
  };
  const tools = convertTools(req.tools || []);
  if (tools.length > 0) chat.tools = tools;
  if (req.tool_choice && tools.length > 0) chat.tool_choice = req.tool_choice;
  if (typeof req.temperature === "number") chat.temperature = req.temperature;
  if (Number.isFinite(req.max_output_tokens)) chat.max_tokens = req.max_output_tokens;
  if (chat.stream) chat.stream_options = { include_usage: true };
  return { chat, requestMessages: messages, namespaceMap: namespaceToolMap(req.tools || []) };
}

function usageFromChat(usage = {}) {
  const cached = usage.prompt_cache_hit_tokens
    ?? usage.prompt_tokens_details?.cached_tokens
    ?? 0;
  return {
    input_tokens: usage.prompt_tokens || 0,
    output_tokens: usage.completion_tokens || 0,
    total_tokens: usage.total_tokens || 0,
    input_tokens_details: { cached_tokens: cached },
  };
}

function messageText(message) {
  const c = message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(part => part?.text || "").join("");
  return "";
}

function chatMessageToResponsesOutput(message, nsMap) {
  const output = [];
  const text = messageText(message);
  if (text || !Array.isArray(message?.tool_calls)) {
    output.push({
      type: "message",
      id: id("msg"),
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text }],
    });
  }
  if (Array.isArray(message?.tool_calls)) {
    for (const tc of message.tool_calls) {
      const rawName = tc.function?.name || "";
      const decoded = responseFunctionNameForResponses(rawName, nsMap);
      const item = {
        type: "function_call",
        id: id("fc"),
        call_id: tc.id || id("call"),
        name: decoded.name,
        arguments: typeof tc.function?.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function?.arguments || {}),
        status: "completed",
      };
      if (decoded.namespace) item.namespace = decoded.namespace;
      output.push(item);
    }
  }
  return output;
}

function assistantFromChatResponse(chat) {
  return chat?.choices?.[0]?.message || { role: "assistant", content: "" };
}

function responsesFromChat(responseId, model, chat, nsMap) {
  const assistant = assistantFromChatResponse(chat);
  return {
    id: responseId,
    object: "response",
    created_at: nowUnix(),
    status: "completed",
    model,
    output: chatMessageToResponsesOutput(assistant, nsMap),
    usage: usageFromChat(chat.usage || {}),
  };
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function writeError(res, status, message, code = "error") {
  writeJson(res, status, {
    error: {
      message,
      type: "codex_deepseek_service_error",
      code,
    },
  });
}

function sseWrite(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function* parseSseStream(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = buffer.search(/\r?\n\r?\n/u)) >= 0) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(buffer[boundary] === "\r" ? boundary + 4 : boundary + 2);
      const event = { event: "message", data: "" };
      const data = [];
      for (const line of raw.split(/\r?\n/u)) {
        if (line.startsWith("event:")) event.event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      event.data = data.join("\n");
      if (event.data) yield event;
    }
  }
}

function modelObject(model) {
  return {
    id: model,
    slug: model,
    display_name: model,
    object: "model",
    created: 0,
    owned_by: "deepseek",
    context_window: 262144,
    max_output_tokens: 65536,
  };
}

async function fetchModels(opts, apiKey, log) {
  const local = new Map(opts.models.map(model => [model, modelObject(model)]));
  if (!opts.upstreamModels || !apiKey) {
    return [...local.values()];
  }
  try {
    const resp = await fetch(`${opts.upstream}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(4000),
    });
    if (!resp.ok) throw new Error(`status=${resp.status}`);
    const json = await resp.json();
    const upstreamModels = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
    for (const item of upstreamModels) {
      const model = item.id || item.slug;
      if (!model) continue;
      local.set(model, { ...modelObject(model), ...item, id: model, slug: item.slug || model });
    }
  } catch (error) {
    log("models.upstream_failed", { message: error.message });
  }
  return [...local.values()];
}

function cleanJobId(value) {
  const jobId = String(value || "").trim();
  if (!jobId) throw new Error("job_id is required");
  if (!/^[A-Za-z0-9_.-]+$/u.test(jobId)) {
    throw new Error("job_id may only contain letters, numbers, dots, dashes, and underscores");
  }
  return jobId;
}

function jobMetaPath(opts, jobId) {
  return path.join(opts.workerStateDir, `${cleanJobId(jobId)}.job.json`);
}

function safeReadJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readJobMeta(opts, jobId) {
  const metaPath = jobMetaPath(opts, jobId);
  const meta = safeReadJsonFile(metaPath);
  if (!meta) {
    const error = new Error(`DeepSeek worker job not found: ${jobId}`);
    error.status = 404;
    throw error;
  }
  return {
    ...meta,
    job_id: meta.job_id || cleanJobId(jobId),
    paths: {
      ...(meta.paths || {}),
      meta: meta.paths?.meta || metaPath,
    },
  };
}

function writeJobMeta(meta) {
  fs.writeFileSync(meta.paths.meta, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

function fileInfo(file) {
  if (!file) return { path: null, exists: false, size: 0, mtime: null };
  try {
    const stat = fs.statSync(file);
    return {
      path: file,
      exists: true,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
    };
  } catch {
    return { path: file, exists: false, size: 0, mtime: null };
  }
}

function readProcessCommandLine(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return "";
  if (process.platform === "win32") {
    const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${n}" -ErrorAction SilentlyContinue; if ($p) { $p.CommandLine }`;
    const child = spawnSync("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3000,
    });
    return (child.stdout || "").trim();
  }
  try {
    return fs.readFileSync(`/proc/${n}/cmdline`, "utf8").replace(/\0/gu, " ").trim();
  } catch {
    return "";
  }
}

function pidMatchesJob(pid, meta) {
  const commandLine = readProcessCommandLine(pid);
  if (!commandLine) return false;
  const needles = [
    meta.paths?.final,
    meta.paths?.stdout,
    meta.paths?.stderr,
    meta.job_id,
    "delegate-deepseek-worker.mjs",
    meta.model,
  ].filter(Boolean).map(String);
  return needles.some(needle => commandLine.includes(needle));
}

function isPidRunning(pid, meta = null) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
  } catch (error) {
    if (error?.code !== "EPERM") return false;
  }
  return meta ? pidMatchesJob(n, meta) : true;
}

function readFileWindow(file, cursor, maxBytes) {
  const info = fileInfo(file);
  if (!info.exists || info.size <= 0) {
    return {
      path: file || null,
      text: "",
      cursor: 0,
      next_cursor: 0,
      size: info.size,
      truncated_head: false,
      skipped_before_cursor: false,
    };
  }

  const explicitCursor = cursor !== undefined && cursor !== null && cursor !== "";
  const start = explicitCursor
    ? asInt(cursor, 0, 0, info.size)
    : Math.max(0, info.size - maxBytes);
  const length = Math.min(maxBytes, info.size - start);
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, "r");
  let bytesRead = 0;
  try {
    bytesRead = fs.readSync(fd, buffer, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }
  return {
    path: file,
    text: buffer.subarray(0, bytesRead).toString("utf8"),
    cursor: start,
    next_cursor: start + bytesRead,
    size: info.size,
    truncated_head: !explicitCursor && start > 0,
    skipped_before_cursor: explicitCursor && start > 0,
  };
}

function parseWorkerLaunch(stdout) {
  const launch = { paths: {} };
  for (const rawLine of String(stdout || "").split(/\r?\n/u)) {
    const line = rawLine.trim();
    const match = /^(job_id|pid|stdout|stderr|final|meta)=(.*)$/u.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    if (key === "pid") {
      launch.pid = Number(value);
    } else if (key === "job_id") {
      launch.job_id = value;
    } else {
      launch.paths[key] = value;
    }
  }
  return launch.job_id || Object.keys(launch.paths).length > 0 || launch.pid ? launch : null;
}

function jobSnapshot(opts, jobId, options = {}) {
  const meta = readJobMeta(opts, jobId);
  const stdout = fileInfo(meta.paths?.stdout);
  const stderr = fileInfo(meta.paths?.stderr);
  const final = fileInfo(meta.paths?.final);
  const pidCandidates = [meta.child_pid, meta.launcher_pid, meta.pid]
    .map(pid => Number(pid))
    .filter(pid => Number.isInteger(pid) && pid > 0);
  const runningPids = pidCandidates.filter(pid => isPidRunning(pid, meta));
  let status = meta.status || "unknown";

  if (final.exists && final.size > 0) {
    status = "completed";
  } else if (runningPids.length > 0) {
    status = "running";
  } else if (status === "running") {
    status = "exited";
  }

  const snapshot = {
    ...meta,
    status,
    pid_running: runningPids.length > 0,
    running_pids: runningPids,
    files: { stdout, stderr, final, meta: fileInfo(meta.paths?.meta) },
  };

  if (options.includeFinal && final.exists && final.size > 0) {
    snapshot.final_text = readFileWindow(meta.paths.final, undefined, options.maxBytes || 20000).text.trim();
  }
  return snapshot;
}

function jobTail(opts, args) {
  const jobId = cleanJobId(args.job_id || args.jobId);
  const maxBytes = asInt(args.max_bytes ?? args.maxBytes, 20000, 1024, 1024 * 1024);
  const snapshot = jobSnapshot(opts, jobId, { includeFinal: true, maxBytes });
  return {
    job_id: jobId,
    status: snapshot.status,
    pid: snapshot.pid || null,
    pid_running: snapshot.pid_running,
    running_pids: snapshot.running_pids,
    stdout: readFileWindow(snapshot.paths?.stdout, args.stdout_cursor ?? args.stdoutCursor, maxBytes),
    stderr: readFileWindow(snapshot.paths?.stderr, args.stderr_cursor ?? args.stderrCursor, maxBytes),
    final_text: snapshot.final_text || "",
    files: snapshot.files,
  };
}

function listJobs(opts, args = {}) {
  const limit = asInt(args.limit, 20, 1, 200);
  if (!fs.existsSync(opts.workerStateDir)) return { jobs: [] };
  const files = fs.readdirSync(opts.workerStateDir)
    .filter(name => name.endsWith(".job.json"))
    .map(name => path.join(opts.workerStateDir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    .slice(0, limit);
  const jobs = files
    .map(file => safeReadJsonFile(file))
    .filter(Boolean)
    .map(meta => jobSnapshot(opts, meta.job_id, { includeFinal: false }));
  return { jobs };
}

async function waitJob(opts, args) {
  const jobId = cleanJobId(args.job_id || args.jobId);
  const timeoutMs = asInt(args.timeout_ms ?? args.timeoutMs, 30000, 1000, 300000);
  const intervalMs = asInt(args.interval_ms ?? args.intervalMs, 500, 100, 10000);
  const stdoutCursor = asInt(args.stdout_cursor ?? args.stdoutCursor, 0, 0);
  const stderrCursor = asInt(args.stderr_cursor ?? args.stderrCursor, 0, 0);
  const deadline = Date.now() + timeoutMs;
  let snapshot = jobSnapshot(opts, jobId, { includeFinal: true });
  let timedOut = false;

  for (;;) {
    const stdoutSize = snapshot.files?.stdout?.size || 0;
    const stderrSize = snapshot.files?.stderr?.size || 0;
    const hasNewOutput = stdoutSize > stdoutCursor || stderrSize > stderrCursor;
    const done = !snapshot.pid_running && !["running", "unknown"].includes(snapshot.status);
    if (hasNewOutput || done) break;
    if (Date.now() >= deadline) {
      timedOut = true;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
    snapshot = jobSnapshot(opts, jobId, { includeFinal: true });
  }

  return {
    timed_out: timedOut,
    ...jobTail(opts, args),
  };
}

function cancelJob(opts, args) {
  const jobId = cleanJobId(args.job_id || args.jobId);
  const meta = readJobMeta(opts, jobId);
  const snapshot = jobSnapshot(opts, jobId, { includeFinal: false });
  const pids = [snapshot.child_pid, snapshot.launcher_pid, snapshot.pid]
    .map(pid => Number(pid))
    .filter(pid => Number.isInteger(pid) && pid > 0);
  const errors = [];
  const killed = [];
  for (const pid of [...new Set(pids)]) {
    if (!isPidRunning(pid, meta)) continue;
    try {
      process.kill(pid);
      killed.push(pid);
    } catch (error) {
      errors.push({ pid, message: error.message });
    }
  }

  if (killed.length > 0) {
    writeJobMeta({
      ...meta,
      status: "canceled",
      canceled_at: new Date().toISOString(),
    });
  }

  return {
    job_id: jobId,
    killed: killed.length > 0,
    killed_pids: killed,
    errors,
    status: killed.length > 0 ? "canceled" : snapshot.status,
  };
}

async function upstreamChat(opts, apiKey, chatReq) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const resp = await fetch(`${opts.upstream}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(chatReq),
      });
      if (!resp.ok) {
        const body = await resp.text();
        const err = new Error(`DeepSeek upstream ${resp.status}: ${body}`);
        err.status = resp.status;
        err.body = body;
        throw err;
      }
      return resp;
    } catch (error) {
      lastError = error;
      if (error.status && error.status < 500) break;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 450));
    }
  }
  throw lastError;
}

async function handleNonStreaming({ res, opts, apiKey, sessions, log, reqBody, responseId, chatReq, requestMessages, nsMap }) {
  const upstream = await upstreamChat(opts, apiKey, chatReq);
  const chat = await upstream.json();
  const response = responsesFromChat(responseId, reqBody.model, chat, nsMap);
  const assistant = assistantFromChatResponse(chat);
  if (assistant.reasoning_content && Array.isArray(assistant.tool_calls)) {
    for (const tc of assistant.tool_calls) sessions.storeReasoning(tc.id, assistant.reasoning_content);
  }
  sessions.save(responseId, [...requestMessages, assistant]);
  log("responses.completed", {
    id: responseId,
    model: reqBody.model,
    stream: false,
    output_items: response.output.length,
  });
  writeJson(res, 200, response);
}

async function handleStreaming({ res, opts, apiKey, sessions, log, reqBody, responseId, chatReq, requestMessages, nsMap }) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  sseWrite(res, "response.created", {
    type: "response.created",
    response: { id: responseId, status: "in_progress", model: reqBody.model },
  });

  let upstream;
  try {
    upstream = await upstreamChat(opts, apiKey, chatReq);
  } catch (error) {
    sseWrite(res, "response.failed", {
      type: "response.failed",
      response: {
        id: responseId,
        status: "failed",
        error: { code: String(error.status || "upstream_error"), message: error.body || error.message },
      },
    });
    res.end();
    return;
  }

  const msgId = id("msg");
  const reasoningId = id("rs");
  let nextOutputIndex = 0;
  let messageIndex = null;
  let reasoningIndex = null;
  let text = "";
  let reasoning = "";
  let usage = {};
  let streamDone = false;
  const toolCalls = new Map();

  for await (const ev of parseSseStream(upstream.body)) {
    if (ev.data.trim() === "[DONE]") {
      streamDone = true;
      break;
    }
    let chunk;
    try {
      chunk = JSON.parse(ev.data);
    } catch {
      continue;
    }
    if (chunk.usage) usage = chunk.usage;
    for (const choice of chunk.choices || []) {
      const delta = choice.delta || {};
      const reasoningDelta = delta.reasoning_content || delta.reasoning || "";
      if (reasoningDelta) {
        if (reasoningIndex == null) {
          reasoningIndex = nextOutputIndex++;
          sseWrite(res, "response.output_item.added", {
            type: "response.output_item.added",
            output_index: reasoningIndex,
            item: {
              type: "reasoning",
              id: reasoningId,
              summary: [{ type: "summary_text", text: "" }],
            },
          });
        }
        reasoning += reasoningDelta;
        sseWrite(res, "response.reasoning_summary_text.delta", {
          type: "response.reasoning_summary_text.delta",
          item_id: reasoningId,
          output_index: reasoningIndex,
          summary_index: 0,
          delta: reasoningDelta,
        });
      }

      const contentDelta = delta.content || "";
      if (contentDelta) {
        if (messageIndex == null) {
          messageIndex = nextOutputIndex++;
          sseWrite(res, "response.output_item.added", {
            type: "response.output_item.added",
            output_index: messageIndex,
            item: {
              type: "message",
              id: msgId,
              role: "assistant",
              status: "in_progress",
              content: [],
            },
          });
        }
        text += contentDelta;
        sseWrite(res, "response.output_text.delta", {
          type: "response.output_text.delta",
          item_id: msgId,
          output_index: messageIndex,
          delta: contentDelta,
        });
      }

      for (const tc of delta.tool_calls || []) {
        const index = Number.isInteger(tc.index) ? tc.index : toolCalls.size;
        const entry = toolCalls.get(index) || {
          id: "",
          name: "",
          arguments: "",
        };
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name += tc.function.name;
        if (tc.function?.arguments) entry.arguments += tc.function.arguments;
        toolCalls.set(index, entry);
      }
    }
  }

  const indexedOutput = [];
  if (reasoningIndex != null) {
    const item = {
      type: "reasoning",
      id: reasoningId,
      summary: [{ type: "summary_text", text: reasoning }],
    };
    sseWrite(res, "response.output_item.done", {
      type: "response.output_item.done",
      output_index: reasoningIndex,
      item,
    });
    indexedOutput.push([reasoningIndex, item]);
  }

  if (messageIndex != null) {
    const item = {
      type: "message",
      id: msgId,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text }],
    };
    sseWrite(res, "response.output_item.done", {
      type: "response.output_item.done",
      output_index: messageIndex,
      item,
    });
    indexedOutput.push([messageIndex, item]);
  }

  const assistantToolCalls = [];
  for (const [relIndex, tc] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
    const outputIndex = nextOutputIndex++;
    const rawName = tc.name || "tool";
    const decoded = responseFunctionNameForResponses(rawName, nsMap);
    const callId = tc.id || id("call");
    const fcId = id("fc");
    const addedItem = {
      type: "function_call",
      id: fcId,
      call_id: callId,
      name: decoded.name,
      arguments: "",
      status: "in_progress",
    };
    if (decoded.namespace) addedItem.namespace = decoded.namespace;
    const doneItem = {
      ...addedItem,
      arguments: tc.arguments || "{}",
      status: "completed",
    };
    sseWrite(res, "response.output_item.added", {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: addedItem,
    });
    if (tc.arguments) {
      sseWrite(res, "response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        item_id: fcId,
        output_index: outputIndex,
        delta: tc.arguments,
      });
    }
    sseWrite(res, "response.output_item.done", {
      type: "response.output_item.done",
      output_index: outputIndex,
      item: doneItem,
    });
    indexedOutput.push([outputIndex, doneItem]);
    assistantToolCalls.push({
      id: callId,
      type: "function",
      function: { name: rawName, arguments: tc.arguments || "{}" },
    });
    if (reasoning) sessions.storeReasoning(callId, reasoning);
    void relIndex;
  }

  if (!streamDone) {
    sseWrite(res, "response.failed", {
      type: "response.failed",
      response: {
        id: responseId,
        status: "failed",
        error: { code: "stream_incomplete", message: "DeepSeek stream ended before [DONE]" },
      },
    });
    res.end();
    return;
  }

  indexedOutput.sort((a, b) => a[0] - b[0]);
  const output = indexedOutput.map(([, item]) => item);
  const assistant = {
    role: "assistant",
    content: text || null,
  };
  if (reasoning) assistant.reasoning_content = reasoning;
  if (assistantToolCalls.length > 0) {
    assistant.tool_calls = assistantToolCalls;
    assistant.content = text || null;
  }
  sessions.save(responseId, [...requestMessages, assistant]);

  sseWrite(res, "response.completed", {
    type: "response.completed",
    response: {
      id: responseId,
      object: "response",
      created_at: nowUnix(),
      status: "completed",
      model: reqBody.model,
      output,
      usage: usageFromChat(usage),
    },
  });
  res.end();
  log("responses.completed", {
    id: responseId,
    model: reqBody.model,
    stream: true,
    output_items: output.length,
    tool_calls: assistantToolCalls.length,
  });
}

function spawnForkScheduler(body, opts) {
  const script = opts.forkScript;
  if (!fs.existsSync(script)) throw new Error(`Missing fork tool: ${script}`);
  const args = [script];
  const task = body.task || body.message;
  if (task) args.push("--task", String(task));
  const agentType = body.agent_type || body.agentType;
  if (agentType) args.push("--agent-type", String(agentType));
  if (body.model) args.push("--model", String(body.model));
  if (body.thread_id || body.threadId) args.push("--thread-id", String(body.thread_id || body.threadId));
  if (body.transcript) args.push("--transcript", String(body.transcript));
  if (body.cwd) args.push("--cwd", String(body.cwd));
  const contextMode = body.context_mode || body.contextMode;
  if (contextMode) {
    args.push("--context-mode", String(contextMode));
  } else if (body.fork_context === false || body.forkContext === false) {
    args.push("--no-fork-context");
  } else if (body.fork_context === true || body.forkContext === true) {
    args.push("--fork-context");
  }
  if (body.max_chars || body.maxChars) args.push("--max-chars", String(body.max_chars || body.maxChars));
  if (body.tail_events || body.tailEvents) args.push("--tail-events", String(body.tail_events || body.tailEvents));
  if (body.ephemeral !== false) args.push("--ephemeral");
  if (body.background !== false) args.push("--background");
  const child = spawn(process.execPath, args, {
    cwd: body.cwd || process.cwd(),
    windowsHide: true,
    env: {
      ...process.env,
      CODEX_DEEPSEEK_SERVICE_PORT: String(opts.port),
      CODEX_DEEPSEEK_SERVICE_URL: `http://${opts.host}:${opts.port}/v1`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise(resolve => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("close", code => {
      const result = { code, stdout, stderr, pid: child.pid };
      const launch = parseWorkerLaunch(stdout);
      if (launch) {
        result.job_id = launch.job_id || null;
        result.worker_pid = launch.pid || null;
        result.paths = launch.paths;
        if (launch.job_id) {
          try {
            result.job = jobSnapshot(opts, launch.job_id, { includeFinal: false });
          } catch {}
        }
      }
      resolve(result);
    });
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const apiKey = process.env.CODEX_DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY || "";
  const log = makeLogger(opts.logPath);
  const sessions = new SessionStore(opts.sessionDir);
  let cachedModels = null;
  let cachedModelsAt = 0;

  if (!apiKey) {
    log("startup.no_api_key", {});
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || `${opts.host}:${opts.port}`}`);
    try {
      if (req.method === "GET" && ["/health", "/v1/health"].includes(url.pathname)) {
        writeJson(res, 200, {
          ok: true,
          service: "codex-deepseek-service",
          pid: process.pid,
          upstream: opts.upstream,
          models: opts.models,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/models") {
        if (!cachedModels || Date.now() - cachedModelsAt > 60_000) {
          cachedModels = await fetchModels(opts, apiKey, log);
          cachedModelsAt = Date.now();
        }
        writeJson(res, 200, { object: "list", data: cachedModels, models: cachedModels });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/responses") {
        if (!apiKey) {
          writeError(res, 500, "DEEPSEEK_API_KEY is not set for codex-deepseek-service", "missing_api_key");
          return;
        }
        const reqBody = await readJson(req);
        const responseId = id("resp");
        const history = reqBody.previous_response_id ? sessions.getHistory(reqBody.previous_response_id) : [];
        const { chat, requestMessages, namespaceMap: nsMap } = requestToChat(reqBody, history, sessions);
        log("responses.request", {
          id: responseId,
          model: reqBody.model,
          stream: Boolean(reqBody.stream),
          previous_response_id: reqBody.previous_response_id || null,
          input_items: Array.isArray(reqBody.input) ? reqBody.input.length : 1,
          history_messages: history.length,
          tools: Array.isArray(chat.tools) ? chat.tools.length : 0,
        });
        if (reqBody.stream) {
          await handleStreaming({ res, opts, apiKey, sessions, log, reqBody, responseId, chatReq: chat, requestMessages, nsMap });
        } else {
          await handleNonStreaming({ res, opts, apiKey, sessions, log, reqBody, responseId, chatReq: chat, requestMessages, nsMap });
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/codex/jobs") {
        writeJson(res, 200, listJobs(opts, { limit: url.searchParams.get("limit") }));
        return;
      }

      if (url.pathname.startsWith("/v1/codex/jobs/")) {
        const parts = url.pathname.split("/").filter(Boolean);
        const jobId = decodeURIComponent(parts[3] || "");
        const action = parts[4] || "status";

        if (req.method === "GET" && action === "status") {
          writeJson(res, 200, jobSnapshot(opts, jobId, {
            includeFinal: url.searchParams.get("include_final") !== "false",
            maxBytes: asInt(url.searchParams.get("max_bytes"), 20000, 1024, 1024 * 1024),
          }));
          return;
        }

        if (req.method === "POST" && action === "tail") {
          writeJson(res, 200, jobTail(opts, {
            job_id: jobId,
            ...await readJson(req),
          }));
          return;
        }

        if (req.method === "POST" && action === "wait") {
          writeJson(res, 200, await waitJob(opts, {
            job_id: jobId,
            ...await readJson(req),
          }));
          return;
        }

        if (req.method === "POST" && action === "cancel") {
          writeJson(res, 200, cancelJob(opts, {
            job_id: jobId,
            ...await readJson(req),
          }));
          return;
        }
      }

      if (req.method === "POST" && ["/v1/codex/fork", "/v1/codex/subagent"].includes(url.pathname)) {
        const body = await readJson(req);
        const agentType = body.agent_type || body.agentType || "deepseek_v4_flash";
        const forkContext = body.fork_context ?? body.forkContext ?? true;
        log("scheduler.request", {
          path: url.pathname,
          agent_type: agentType,
          fork_context: forkContext,
          context_mode: body.context_mode || body.contextMode || (forkContext ? "full" : "light"),
          background: body.background !== false,
        });
        const result = await spawnForkScheduler(body, opts);
        log("scheduler.completed", {
          path: url.pathname,
          agent_type: agentType,
          fork_context: forkContext,
          code: result.code,
        });
        writeJson(res, result.code === 0 ? 200 : 500, {
          ok: result.code === 0,
          scheduler: "delegate-deepseek-worker",
          agent_type: agentType,
          fork_context: forkContext,
          code: result.code,
          pid: result.pid,
          worker_pid: result.worker_pid,
          job_id: result.job_id,
          paths: result.paths,
          job: result.job,
          stdout: result.stdout,
          stderr: result.stderr,
        });
        return;
      }

      writeError(res, 404, `No route for ${req.method} ${url.pathname}`, "not_found");
    } catch (error) {
      log("request.failed", {
        method: req.method,
        path: url.pathname,
        message: error.message,
      });
      if (!res.headersSent) {
        writeError(res, error.status || 500, error.body || error.message, "request_failed");
      } else {
        try {
          sseWrite(res, "response.failed", {
            type: "response.failed",
            response: {
              id: id("resp"),
              status: "failed",
              error: { code: "request_failed", message: error.message },
            },
          });
          res.end();
        } catch {}
      }
    }
  });

  server.listen(opts.port, opts.host, () => {
    log("startup", {
      host: opts.host,
      port: opts.port,
      upstream: opts.upstream,
      models: opts.models,
      session_dir: opts.sessionDir,
    });
    process.stdout.write(`codex-deepseek-service listening on http://${opts.host}:${opts.port}/v1\n`);
  });
}

main().catch(error => {
  process.stderr.write(`codex-deepseek-service: ${error.message}\n`);
  process.exit(1);
});
