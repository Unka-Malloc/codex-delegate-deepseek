#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

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
  const script = path.join(CODEX_HOME, "bin", "delegate-deepseek-worker.mjs");
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
    child.on("close", code => resolve({ code, stdout, stderr, pid: child.pid }));
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
