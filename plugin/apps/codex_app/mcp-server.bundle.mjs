// plugin/apps/codex_app/mcp-server.mjs
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
var MCP_PROTOCOL_VERSION = "2024-11-05";
var PLUGIN_ID = "com.leeoohoo.codex_app";
var STATE_VERSION = 1;
var STATE_FILE_NAME = "codex_app_state.v1.json";
var REQUESTS_FILE_NAME = "codex_app_requests.v1.json";
var DEFAULT_MODEL = "gpt-5.2";
var DEFAULT_APPROVAL = "never";
var DEFAULT_LOG_LIMIT = 200;
var MAX_LOG_LIMIT = 1e3;
var scriptDir = path.dirname(fileURLToPath(import.meta.url));
var pluginRoot = path.resolve(scriptDir, "..", "..", "..");
var normalizeString = (value) => {
  if (typeof value !== "string") return "";
  return String(value || "").trim();
};
var makeId = () => {
  try {
    return randomUUID();
  } catch {
    return `${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`;
  }
};
var ensureDir = (dir) => {
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
  }
};
var readJsonFile = (filePath) => {
  if (!filePath) return null;
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
};
var writeJsonFileAtomic = (filePath, data) => {
  if (!filePath) return;
  try {
    const dir = path.dirname(filePath);
    ensureDir(dir);
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try {
      process.stderr.write(`[mcp] write failed: ${e?.message || String(e)}
`);
    } catch {
    }
  }
};
var findUpwardsDataDir = (startPath, pluginId) => {
  const raw = normalizeString(startPath);
  if (!raw) return "";
  let current = raw;
  try {
    current = path.resolve(raw);
  } catch {
    current = raw;
  }
  for (let i = 0; i < 50; i += 1) {
    const candidate = path.join(current, ".chatos", "data", pluginId);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
    }
    const parent = path.dirname(current);
    if (!parent || parent === current) break;
    current = parent;
  }
  return "";
};
var resolveDataDirFromStateDir = (stateDir) => {
  const raw = normalizeString(stateDir);
  if (!raw) return "";
  return path.join(raw, "ui_apps", "data", PLUGIN_ID);
};
var resolveStateDirFromEnv = () => {
  const direct = normalizeString(process.env?.CHATOS_UI_APPS_STATE_DIR) || normalizeString(process.env?.CHATOS_STATE_DIR) || normalizeString(process.env?.MODEL_CLI_STATE_DIR);
  if (direct) return direct;
  const hostApp = normalizeString(process.env?.MODEL_CLI_HOST_APP) || "chatos";
  const sessionRoot = normalizeString(process.env?.MODEL_CLI_SESSION_ROOT);
  const home = normalizeString(process.env?.HOME || process.env?.USERPROFILE);
  const base = sessionRoot || home;
  if (!base) return "";
  return path.join(base, ".deepseek_cli", hostApp);
};
var resolveDataDirFromEnv = () => resolveDataDirFromStateDir(resolveStateDirFromEnv());
var resolveDataDir = () => {
  const envDir = normalizeString(process.env?.CHATOS_UI_APPS_DATA_DIR) || normalizeString(process.env?.CHATOS_UI_APP_DATA_DIR) || normalizeString(process.env?.CHATOS_DATA_DIR);
  if (envDir) return envDir;
  const fromEnv = resolveDataDirFromEnv();
  if (fromEnv) return fromEnv;
  const fromCwd = findUpwardsDataDir(process.cwd(), PLUGIN_ID);
  if (fromCwd) return fromCwd;
  const fromPlugin = findUpwardsDataDir(pluginRoot, PLUGIN_ID);
  if (fromPlugin) return fromPlugin;
  return path.join(process.cwd(), ".chatos", "data", PLUGIN_ID);
};
var resolveDataDirFromMeta = (meta) => {
  const fromUiApp = normalizeString(meta?.chatos?.uiApp?.dataDir);
  if (fromUiApp) return fromUiApp;
  const fromStateDir = resolveDataDirFromStateDir(meta?.chatos?.uiApp?.stateDir);
  if (fromStateDir) return fromStateDir;
  const fromWorkdir = normalizeString(meta?.workdir);
  if (fromWorkdir) return fromWorkdir;
  return "";
};
var resolveDataDirWithMeta = (meta) => resolveDataDirFromMeta(meta) || resolveDataDir();
var resolveDefaultWorkingDirectory = (meta) => {
  const fromProject = normalizeString(meta?.chatos?.uiApp?.projectRoot);
  if (fromProject) return fromProject;
  const fromSession = normalizeString(meta?.chatos?.uiApp?.sessionRoot);
  if (fromSession) return fromSession;
  const fromWorkdir = normalizeString(meta?.workdir);
  if (fromWorkdir) return fromWorkdir;
  return process.cwd();
};
var getStateFile = (meta) => {
  const dataDir = resolveDataDirWithMeta(meta);
  return dataDir ? path.join(dataDir, STATE_FILE_NAME) : "";
};
var getRequestsFile = (meta) => {
  const dataDir = resolveDataDirWithMeta(meta);
  return dataDir ? path.join(dataDir, REQUESTS_FILE_NAME) : "";
};
var send = (msg) => {
  try {
    process.stdout.write(`${JSON.stringify(msg)}
`);
  } catch (e) {
    try {
      process.stderr.write(`[mcp] failed to send: ${e?.message || String(e)}
`);
    } catch {
    }
  }
};
var jsonRpcError = (id, code, message, data) => ({
  jsonrpc: "2.0",
  id,
  error: {
    code,
    message,
    ...data !== void 0 ? { data } : {}
  }
});
var jsonRpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
var buildWindowsCommandArgs = (command, args) => {
  const comspec = String(process.env?.ComSpec || process.env?.COMSPEC || "").trim() || "cmd.exe";
  return {
    command: comspec,
    args: ["/d", "/s", "/c", command, ...Array.isArray(args) ? args : []]
  };
};
var buildCodexExecArgs = ({ threadId, options }) => {
  const args = ["exec", "--json"];
  if (options?.model) args.push("--model", String(options.model));
  if (options?.sandboxMode) args.push("--sandbox", String(options.sandboxMode));
  if (options?.workingDirectory) args.push("--cd", String(options.workingDirectory));
  if (options?.skipGitRepoCheck) args.push("--skip-git-repo-check");
  if (options?.modelReasoningEffort) {
    args.push("--config", `model_reasoning_effort="${String(options.modelReasoningEffort)}"`);
  }
  if (options?.experimentalWindowsSandboxEnabled !== void 0) {
    args.push("--config", `features.experimental_windows_sandbox=${Boolean(options.experimentalWindowsSandboxEnabled)}`);
  }
  if (options?.networkAccessEnabled !== void 0) {
    args.push("--config", `sandbox_workspace_write.network_access=${Boolean(options.networkAccessEnabled)}`);
  }
  if (options?.webSearchEnabled !== void 0) {
    args.push("--config", `features.web_search_request=${Boolean(options.webSearchEnabled)}`);
  }
  if (options?.approvalPolicy) {
    args.push("--config", `approval_policy="${String(options.approvalPolicy)}"`);
  }
  if (threadId) args.push("resume", String(threadId));
  return args;
};
var formatCodexItem = (item) => {
  if (!item || typeof item !== "object") return "";
  const t = item.type;
  if (t === "command_execution") {
    const status = item.status ? ` status=${item.status}` : "";
    const code = item.exit_code !== void 0 ? ` exit=${item.exit_code}` : "";
    return `command ${JSON.stringify(item.command || "")}${status}${code}`;
  }
  if (t === "file_change") {
    const changes = Array.isArray(item.changes) ? item.changes.map((c) => `${c.kind}:${c.path}`).join(", ") : "";
    return `patch status=${item.status || ""}${changes ? ` changes=[${changes}]` : ""}`;
  }
  if (t === "mcp_tool_call") {
    return `mcp ${String(item.server || "")}.${String(item.tool || "")} status=${String(item.status || "")}`;
  }
  if (t === "web_search") return `web_search ${JSON.stringify(item.query || "")}`;
  if (t === "todo_list") return `todo_list (${Array.isArray(item.items) ? item.items.length : 0} items)`;
  if (t === "error") return `error ${JSON.stringify(item.message || "")}`;
  if (t === "reasoning") return `reasoning ${JSON.stringify(String(item.text || "").slice(0, 120))}`;
  if (t === "agent_message") return `assistant ${JSON.stringify(String(item.text || "").slice(0, 160))}`;
  return `${String(t || "item")} ${JSON.stringify(item).slice(0, 200)}`;
};
var formatRunEvent = (evt) => {
  const ts = evt?.ts || (/* @__PURE__ */ new Date()).toISOString();
  const trunc = evt?.truncated ? ` \u2026(truncated, originalLength=${Number(evt.originalLength) || 0})` : "";
  if (evt && typeof evt === "object" && typeof evt.line === "string") return evt.line;
  if (evt?.source === "stderr") return `[${ts}] stderr ${String(evt.text || "").trimEnd()}${trunc}`;
  if (evt?.source === "raw") return `[${ts}] raw ${String(evt.text || "").trimEnd()}${trunc}`;
  if (evt?.source === "system") {
    if (evt.kind === "spawn") return `[${ts}] spawn ${String(evt.command || "")} ${Array.isArray(evt.args) ? evt.args.join(" ") : ""}`;
    if (evt.kind === "status") return `[${ts}] status ${String(evt.status || "")}`;
    if (evt.kind === "warning") return `[${ts}] warning ${String(evt.message || evt.warning || "")}`;
    if (evt.kind === "error") return `[${ts}] error ${String(evt?.error?.message || "")}`;
    if (evt.kind === "gap" && evt?.gap && Number.isFinite(evt.gap?.from) && Number.isFinite(evt.gap?.to)) {
      return `[${ts}] gap dropped_events seq=[${evt.gap.from}, ${evt.gap.to})`;
    }
    return `[${ts}] system ${JSON.stringify(evt).slice(0, 320)}`;
  }
  if (evt?.source === "codex") {
    const e = evt.event || {};
    if (e.type === "thread.started") return `[${ts}] thread.started threadId=${String(e.thread_id || "")}`;
    if (e.type === "turn.started") return `[${ts}] turn.started`;
    if (e.type === "turn.completed") return `[${ts}] turn.completed usage=${JSON.stringify(e.usage || null)}`;
    if (e.type === "turn.failed") return `[${ts}] turn.failed ${String(e?.error?.message || "")}`;
    if (e.type === "error") return `[${ts}] error ${String(e.message || "")}`;
    if (e.type === "item.started") return `[${ts}] item.started ${formatCodexItem(e.item)}`;
    if (e.type === "item.updated") return `[${ts}] item.updated ${formatCodexItem(e.item)}`;
    if (e.type === "item.completed") return `[${ts}] item.completed ${formatCodexItem(e.item)}`;
    return `[${ts}] ${String(e.type || "event")} ${JSON.stringify(e).slice(0, 320)}`;
  }
  return `[${ts}] ${JSON.stringify(evt).slice(0, 320)}`;
};
var parseWindowTime = (win) => {
  const updated = Date.parse(win?.updatedAt || "") || 0;
  if (updated) return updated;
  return Date.parse(win?.createdAt || "") || 0;
};
var sortWindowsByRecent = (windows) => Array.isArray(windows) ? windows.slice().sort((a, b) => parseWindowTime(b) - parseWindowTime(a)) : [];
var pickPreferredWindow = (windows) => {
  if (!Array.isArray(windows) || !windows.length) return null;
  const running = windows.find((win) => win?.status === "running" || win?.status === "aborting");
  if (running) return running;
  const withThread = windows.find((win) => normalizeString(win?.threadId));
  if (withThread) return withThread;
  return windows[0] || null;
};
var isRunningStatus = (value) => {
  const status = normalizeString(value).toLowerCase();
  return status === "running" || status === "aborting";
};
var findWindowByThreadId = (windows, threadId) => {
  const needle = normalizeString(threadId);
  if (!needle) return null;
  return Array.isArray(windows) ? windows.find((win) => normalizeString(win?.threadId) === needle) : null;
};
var runProcess = async ({ command, args, input = "" }) => {
  const MAX_OUT = 16e4;
  const MAX_ERR = 6e4;
  const spawnSpec = process.platform === "win32" ? buildWindowsCommandArgs(command, args) : { command, args: Array.isArray(args) ? args : [] };
  const child = spawn(spawnSpec.command, spawnSpec.args, { windowsHide: true, env: process.env });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    if (stdout.length >= MAX_OUT) return;
    stdout += String(chunk?.toString?.("utf8") || chunk);
    if (stdout.length > MAX_OUT) stdout = `${stdout.slice(0, MAX_OUT)}
\u2026(truncated)`;
  });
  child.stderr?.on("data", (chunk) => {
    if (stderr.length >= MAX_ERR) return;
    stderr += String(chunk?.toString?.("utf8") || chunk);
    if (stderr.length > MAX_ERR) stderr = `${stderr.slice(0, MAX_ERR)}
\u2026(truncated)`;
  });
  if (child.stdin) {
    try {
      child.stdin.write(String(input || ""));
      child.stdin.end();
    } catch {
    }
  }
  const { code, signal } = await new Promise((resolve) => {
    child.once("close", (c, s) => resolve({ code: c, signal: s }));
    child.once("exit", (c, s) => resolve({ code: c, signal: s }));
    child.once("error", () => resolve({ code: null, signal: null }));
  });
  return { code, signal, stdout, stderr, spawn: spawnSpec };
};
var parseThreadIdFromStdout = (stdout) => {
  const text = String(stdout || "");
  if (!text) return "";
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const evt = JSON.parse(trimmed);
      if (evt?.type === "thread.started" && typeof evt.thread_id === "string") {
        return evt.thread_id;
      }
    } catch {
    }
  }
  return "";
};
var toolResultText = (text) => ({
  content: [{ type: "text", text: String(text ?? "") }]
});
var toolResultJson = (obj) => toolResultText(JSON.stringify(obj, null, 2));
var clampNumber = (value, min, max) => {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
};
var loadState = (meta) => readJsonFile(getStateFile(meta)) || { version: 0, windows: [], windowLogs: {}, windowTasks: {} };
var buildDefaultsApplied = (input, meta) => {
  const workingDirectory = normalizeString(input?.workingDirectory) || resolveDefaultWorkingDirectory(meta);
  const sandboxMode = normalizeString(input?.sandboxMode) || "workspace-write";
  return {
    workingDirectory,
    sandboxMode,
    model: normalizeString(input?.model) || DEFAULT_MODEL,
    modelReasoningEffort: normalizeString(input?.modelReasoningEffort) || null,
    approvalPolicy: normalizeString(input?.approvalPolicy) || DEFAULT_APPROVAL,
    experimentalWindowsSandboxEnabled: input?.experimentalWindowsSandboxEnabled === void 0 ? false : Boolean(input.experimentalWindowsSandboxEnabled),
    networkAccessEnabled: input?.networkAccessEnabled === void 0 ? null : Boolean(input.networkAccessEnabled),
    webSearchEnabled: input?.webSearchEnabled === void 0 ? null : Boolean(input.webSearchEnabled),
    skipGitRepoCheck: input?.skipGitRepoCheck === void 0 ? false : Boolean(input.skipGitRepoCheck)
  };
};
var appendCreateWindowRequest = (entry, meta) => {
  const requestsFile = getRequestsFile(meta);
  const requests = readJsonFile(requestsFile) || { version: STATE_VERSION, createWindows: [] };
  const list = Array.isArray(requests.createWindows) ? requests.createWindows : [];
  list.push(entry);
  writeJsonFileAtomic(requestsFile, { version: STATE_VERSION, createWindows: list });
};
var TOOLS = [
  {
    name: "codex_app.ping",
    description: "Health check. Returns pong.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "codex_app.codex_version",
    description: "Run `codex --version` and return output.",
    inputSchema: { type: "object", properties: { codexCommand: { type: "string" } } }
  },
  {
    name: "codex_app.codex_exec",
    description: "Run `codex exec --json` with the given prompt via stdin.",
    inputSchema: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: { type: "string", description: "Prompt passed to codex via stdin." },
        threadId: { type: "string", description: "Optional thread id to resume." },
        windowId: { type: "string", description: "Optional. If set, use this window when creating a new UI window." },
        ensureWindow: { type: "boolean", description: "Optional. When no window exists, create one and attach this run." },
        windowName: { type: "string", description: "Optional. Name used if a new window is created." },
        codexCommand: { type: "string", description: "Executable name or path (default: codex)." },
        options: {
          type: "object",
          properties: {
            model: { type: "string" },
            modelReasoningEffort: { type: "string" },
            workingDirectory: { type: "string" },
            sandboxMode: { type: "string" },
            approvalPolicy: { type: "string" },
            experimentalWindowsSandboxEnabled: { type: "boolean" },
            networkAccessEnabled: { type: "boolean" },
            webSearchEnabled: { type: "boolean" },
            skipGitRepoCheck: { type: "boolean" }
          }
        }
      }
    }
  },
  {
    name: "codex_app.get_windows",
    description: "List windows with last/default run settings (model, reasoning, working dir, sandbox, etc).",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "codex_app.create_window",
    description: "Create a new window. workingDirectory/sandboxMode default to projectRoot/workspace-write if omitted. Returns explicit defaults applied to other fields.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Optional window name." },
        workingDirectory: { type: "string", description: "Optional. Working directory passed to --cd." },
        sandboxMode: { type: "string", description: "Optional. Sandbox mode (read-only/workspace-write/danger-full-access)." },
        model: { type: "string", description: "Optional. Defaults to gpt-5.2." },
        modelReasoningEffort: { type: "string", description: "Optional. Defaults to codex config." },
        approvalPolicy: { type: "string", description: "Optional. Defaults to never." },
        experimentalWindowsSandboxEnabled: { type: "boolean", description: "Optional. Defaults to false." },
        networkAccessEnabled: { type: "boolean", description: "Optional. Defaults to codex config." },
        webSearchEnabled: { type: "boolean", description: "Optional. Defaults to codex config." },
        skipGitRepoCheck: { type: "boolean", description: "Optional. Defaults to false." }
      }
    }
  },
  {
    name: "codex_app.get_window_logs",
    description: "Get window logs by line count. By default returns the latest lines.",
    inputSchema: {
      type: "object",
      required: ["windowId"],
      properties: {
        windowId: { type: "string" },
        limit: { type: "number", description: `Max lines to return (default ${DEFAULT_LOG_LIMIT}, max ${MAX_LOG_LIMIT}).` },
        offset: { type: "number", description: "Optional start index (0-based). If omitted, returns tail." }
      }
    }
  },
  {
    name: "codex_app.get_window_tasks",
    description: "Get the latest todo_list (tasks) for a window.",
    inputSchema: {
      type: "object",
      required: ["windowId"],
      properties: {
        windowId: { type: "string" }
      }
    }
  }
];
var initialized = false;
var client = null;
var handleRequest = async (req) => {
  const id = req?.id;
  const method = String(req?.method || "");
  const params = req?.params;
  if (!method) return;
  if (method === "initialize") {
    initialized = true;
    client = params?.clientInfo || null;
    return jsonRpcResult(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      serverInfo: { name: "com.leeoohoo.codex_app.codex_app", version: "0.1.0" },
      capabilities: { tools: {} }
    });
  }
  if (!initialized) {
    return jsonRpcError(id, -32002, "Server not initialized");
  }
  if (method === "tools/list") {
    return jsonRpcResult(id, { tools: TOOLS });
  }
  if (method === "tools/call") {
    const name = String(params?.name || "");
    const args = params?.arguments || {};
    if (name === "codex_app.ping") {
      return jsonRpcResult(id, toolResultText(`pong (client=${client?.name || "unknown"})`));
    }
    if (name === "codex_app.codex_version") {
      const codexCommand = String(args?.codexCommand || "codex").trim() || "codex";
      const res = await runProcess({ command: codexCommand, args: ["--version"] });
      const text = [
        `command: ${res.spawn.command} ${res.spawn.args.join(" ")}`,
        `exit: ${res.code ?? "null"}${res.signal ? ` signal=${res.signal}` : ""}`,
        res.stdout ? `
stdout:
${res.stdout.trimEnd()}` : "",
        res.stderr ? `
stderr:
${res.stderr.trimEnd()}` : ""
      ].filter(Boolean).join("\n");
      return jsonRpcResult(id, toolResultText(text));
    }
    if (name === "codex_app.codex_exec") {
      const prompt = typeof args?.prompt === "string" ? args.prompt : "";
      if (!String(prompt || "").trim()) return jsonRpcError(id, -32602, "prompt is required");
      const codexCommand = String(args?.codexCommand || "codex").trim() || "codex";
      const state = loadState(params?._meta);
      const windows = sortWindowsByRecent(Array.isArray(state?.windows) ? state.windows : []);
      const windowId = normalizeString(args?.windowId);
      const windowTarget = windowId ? windows.find((win) => win?.id === windowId) : null;
      let threadId = typeof args?.threadId === "string" ? args.threadId : "";
      if (!threadId && windowTarget?.threadId) threadId = String(windowTarget.threadId || "");
      const windowByThread = threadId ? findWindowByThreadId(windows, threadId) : null;
      const runningTarget = windowTarget || windowByThread;
      if (runningTarget && isRunningStatus(runningTarget?.status)) {
        return jsonRpcError(id, -32e3, "window is running; cannot start a new run in the same window", {
          windowId: runningTarget?.id || "",
          status: runningTarget?.status || ""
        });
      }
      const options = args?.options && typeof args.options === "object" ? args.options : {};
      const codexArgs = buildCodexExecArgs({ threadId: threadId || null, options });
      const res = await runProcess({ command: codexCommand, args: codexArgs, input: prompt });
      const ensureWindow = args?.ensureWindow === void 0 ? true : Boolean(args.ensureWindow);
      const shouldCreateWindow = ensureWindow && (!windows.length || windowId && !windowTarget);
      let createdWindowId = "";
      if (shouldCreateWindow) {
        const derivedId = windowId || makeId();
        const defaultsApplied = buildDefaultsApplied(options, params?._meta);
        const threadIdFromOutput = parseThreadIdFromStdout(res.stdout) || "";
        appendCreateWindowRequest(
          {
            id: derivedId,
            name: normalizeString(args?.windowName) || "",
            defaults: defaultsApplied,
            threadId: threadIdFromOutput,
            createdAt: (/* @__PURE__ */ new Date()).toISOString()
          },
          params?._meta
        );
        createdWindowId = derivedId;
      }
      const text = [
        `command: ${res.spawn.command} ${res.spawn.args.join(" ")}`,
        `exit: ${res.code ?? "null"}${res.signal ? ` signal=${res.signal}` : ""}`,
        res.stdout ? `
stdout:
${res.stdout.trimEnd()}` : "",
        res.stderr ? `
stderr:
${res.stderr.trimEnd()}` : "",
        createdWindowId ? `
window: created ${createdWindowId} (pending UI refresh)` : ""
      ].filter(Boolean).join("\n");
      return jsonRpcResult(id, toolResultText(text));
    }
    if (name === "codex_app.get_windows") {
      const state = loadState(params?._meta);
      const windows = sortWindowsByRecent(Array.isArray(state?.windows) ? state.windows : []);
      const preferred = pickPreferredWindow(windows);
      return jsonRpcResult(
        id,
        toolResultJson({
          version: state?.version || 0,
          updatedAt: state?.updatedAt || "",
          windows,
          preferredWindowId: preferred?.id || "",
          preferredThreadId: preferred?.threadId || ""
        })
      );
    }
    if (name === "codex_app.create_window") {
      const defaultsApplied = buildDefaultsApplied(args, params?._meta);
      const windowId = makeId();
      appendCreateWindowRequest(
        {
          id: windowId,
          name: normalizeString(args?.name) || "",
          defaults: defaultsApplied,
          createdAt: (/* @__PURE__ */ new Date()).toISOString()
        },
        params?._meta
      );
      return jsonRpcResult(
        id,
        toolResultJson({
          windowId,
          defaultsApplied,
          note: "\u7A97\u53E3\u5C06\u5728 UI \u5237\u65B0\u6216\u4E0B\u6B21\u62C9\u53D6\u65F6\u51FA\u73B0\uFF1B\u8BF7\u5728\u8C03\u7528\u65B9\u8BB0\u5F55 defaultsApplied\u3002"
        })
      );
    }
    if (name === "codex_app.get_window_logs") {
      const windowId = normalizeString(args?.windowId);
      if (!windowId) return jsonRpcError(id, -32602, "windowId is required");
      const limit = clampNumber(Number(args?.limit ?? DEFAULT_LOG_LIMIT), 1, MAX_LOG_LIMIT);
      const offsetRaw = Number(args?.offset);
      const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.floor(offsetRaw)) : null;
      const state = loadState(params?._meta);
      const logsEntry = state?.windowLogs?.[windowId] || { events: [], lines: [], updatedAt: "" };
      const events = Array.isArray(logsEntry.events) ? logsEntry.events : [];
      const rawLines = Array.isArray(logsEntry.lines) ? logsEntry.lines : [];
      const useEvents = events.length > 0;
      const list = useEvents ? events : rawLines;
      const total = list.length;
      const start = offset !== null ? Math.min(offset, total) : Math.max(0, total - limit);
      const slice = list.slice(start, Math.min(start + limit, total));
      const lines = useEvents ? slice.map(formatRunEvent).filter(Boolean) : slice;
      const nextOffset = start + slice.length < total ? start + slice.length : null;
      const win = Array.isArray(state?.windows) ? state.windows.find((w) => w?.id === windowId) : null;
      return jsonRpcResult(
        id,
        toolResultJson({
          windowId,
          status: win?.status || "",
          activeRunId: win?.activeRunId || "",
          totalLines: total,
          start,
          count: slice.length,
          nextOffset,
          updatedAt: logsEntry.updatedAt || state?.updatedAt || "",
          lines: slice
        })
      );
    }
    if (name === "codex_app.get_window_tasks") {
      const windowId = normalizeString(args?.windowId);
      if (!windowId) return jsonRpcError(id, -32602, "windowId is required");
      const state = loadState(params?._meta);
      const entry = state?.windowTasks?.[windowId];
      return jsonRpcResult(
        id,
        toolResultJson({
          windowId,
          todoList: Array.isArray(entry?.todoList) ? entry.todoList : [],
          todoListId: entry?.todoListId || "",
          updatedAt: entry?.updatedAt || state?.updatedAt || ""
        })
      );
    }
    return jsonRpcError(id, -32601, `Unknown tool: ${name}`);
  }
  if (method === "shutdown") {
    return jsonRpcResult(id, { ok: true });
  }
  return jsonRpcError(id, -32601, `Method not found: ${method}`);
};
var rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  const raw = String(line || "").trim();
  if (!raw) return;
  let req;
  try {
    req = JSON.parse(raw);
  } catch (e) {
    send(jsonRpcError(null, -32700, "Parse error", { message: e?.message || String(e) }));
    return;
  }
  if (!req || typeof req !== "object") return;
  if (req.jsonrpc !== "2.0") return;
  if (req.id === void 0) {
    return;
  }
  try {
    const resp = await handleRequest(req);
    if (resp) send(resp);
  } catch (e) {
    send(jsonRpcError(req.id, -32e3, e?.message || String(e)));
  }
});
