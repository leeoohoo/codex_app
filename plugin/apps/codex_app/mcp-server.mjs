/**
 * MCP Server 入口（stdio, 无第三方依赖）。
 *
 * 注意：ChatOS 导入插件包时会默认排除 `node_modules/`，因此这里仅使用 Node.js 内置模块。
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const MCP_PROTOCOL_VERSION = '2024-11-05';
const PLUGIN_ID = 'com.leeoohoo.codex_app';
const STATE_VERSION = 1;
const STATE_FILE_NAME = 'codex_app_state.v1.json';
const REQUESTS_FILE_NAME = 'codex_app_requests.v1.json';
const DEFAULT_MODEL = 'gpt-5.2-codex';
const DEFAULT_APPROVAL = 'never';
const COMPLETION_POLL_MS = 1000;
const COMPLETION_TIMEOUT_MS = 30 * 60 * 1000;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDir, '..', '..', '..');

const normalizeString = (value) => {
  if (typeof value !== 'string') return '';
  return String(value || '').trim();
};
const nowIso = () => new Date().toISOString();

const makeId = () => {
  try {
    return randomUUID();
  } catch {
    return `${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`;
  }
};

const ensureDir = (dir) => {
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // ignore
  }
};

const readJsonFile = (filePath) => {
  if (!filePath) return null;
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

const writeJsonFileAtomic = (filePath, data) => {
  if (!filePath) return;
  try {
    const dir = path.dirname(filePath);
    ensureDir(dir);
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try {
      process.stderr.write(`[mcp] write failed: ${e?.message || String(e)}\n`);
    } catch {
      // ignore
    }
  }
};

const findUpwardsDataDir = (startPath, pluginId) => {
  const raw = normalizeString(startPath);
  if (!raw) return '';
  let current = raw;
  try {
    current = path.resolve(raw);
  } catch {
    current = raw;
  }
  for (let i = 0; i < 50; i += 1) {
    const candidate = path.join(current, '.chatos', 'data', pluginId);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
    const parent = path.dirname(current);
    if (!parent || parent === current) break;
    current = parent;
  }
  return '';
};

const findGitRepoRoot = (startPath) => {
  const raw = normalizeString(startPath);
  if (!raw) return '';
  let current = raw;
  try {
    current = path.resolve(raw);
  } catch {
    current = raw;
  }
  try {
    const stat = fs.statSync(current);
    if (stat.isFile()) current = path.dirname(current);
  } catch {
    return '';
  }
  for (let i = 0; i < 100; i += 1) {
    try {
      if (fs.existsSync(path.join(current, '.git'))) return current;
    } catch {
      // ignore
    }
    const parent = path.dirname(current);
    if (!parent || parent === current) break;
    current = parent;
  }
  return '';
};

const resolveDataDirFromStateDir = (stateDir) => {
  const raw = normalizeString(stateDir);
  if (!raw) return '';
  return path.join(raw, 'ui_apps', 'data', PLUGIN_ID);
};

const looksLikeDataDir = (value) => {
  const raw = normalizeString(value);
  if (!raw) return false;
  let resolved = raw;
  try {
    resolved = path.resolve(raw);
  } catch {
    resolved = raw;
  }
  const normalized = resolved.split(path.sep).join('/');
  return (
    normalized.endsWith(`/ui_apps/data/${PLUGIN_ID}`) ||
    normalized.endsWith(`/.chatos/data/${PLUGIN_ID}`)
  );
};

const resolveStateDirFromEnv = () => {
  const direct =
    normalizeString(process.env?.CHATOS_UI_APPS_STATE_DIR) ||
    normalizeString(process.env?.CHATOS_STATE_DIR) ||
    normalizeString(process.env?.MODEL_CLI_STATE_DIR);
  if (direct) return direct;
  const hostApp = normalizeString(process.env?.MODEL_CLI_HOST_APP) || 'chatos';
  const sessionRoot = normalizeString(process.env?.MODEL_CLI_SESSION_ROOT);
  const home = normalizeString(process.env?.HOME || process.env?.USERPROFILE);
  const base = sessionRoot || home;
  if (!base) return '';
  return path.join(base, '.deepseek_cli', hostApp);
};

const resolveDataDirFromEnv = () => resolveDataDirFromStateDir(resolveStateDirFromEnv());

const resolveDataDir = () => {
  const envDir =
    normalizeString(process.env?.CHATOS_UI_APPS_DATA_DIR) ||
    normalizeString(process.env?.CHATOS_UI_APP_DATA_DIR) ||
    normalizeString(process.env?.CHATOS_DATA_DIR);
  if (envDir) return envDir;
  const fromEnv = resolveDataDirFromEnv();
  if (fromEnv) return fromEnv;
  const fromCwd = findUpwardsDataDir(process.cwd(), PLUGIN_ID);
  if (fromCwd) return fromCwd;
  const fromPlugin = findUpwardsDataDir(pluginRoot, PLUGIN_ID);
  if (fromPlugin) return fromPlugin;
  return path.join(process.cwd(), '.chatos', 'data', PLUGIN_ID);
};

const resolveDataDirFromMeta = (meta) => {
  const fromUiApp = normalizeString(meta?.chatos?.uiApp?.dataDir);
  if (fromUiApp) return fromUiApp;
  const fromStateDir = resolveDataDirFromStateDir(meta?.chatos?.uiApp?.stateDir);
  if (fromStateDir) return fromStateDir;
  const fromWorkdir = normalizeString(meta?.workdir);
  if (fromWorkdir && looksLikeDataDir(fromWorkdir)) return fromWorkdir;
  return '';
};

const resolveDataDirWithMeta = (meta) => resolveDataDirFromMeta(meta) || resolveDataDir();

const resolveDefaultWorkingDirectory = (meta) => {
  const fromProject = normalizeString(meta?.chatos?.uiApp?.projectRoot);
  if (fromProject) return fromProject;
  const fromSession = normalizeString(meta?.chatos?.uiApp?.sessionRoot);
  if (fromSession) return fromSession;
  const fromWorkdir = normalizeString(meta?.workdir);
  if (fromWorkdir) return fromWorkdir;
  return process.cwd();
};

const getStateFile = (meta) => {
  const dataDir = resolveDataDirWithMeta(meta);
  return dataDir ? path.join(dataDir, STATE_FILE_NAME) : '';
};

const getRequestsFile = (meta) => {
  const dataDir = resolveDataDirWithMeta(meta);
  return dataDir ? path.join(dataDir, REQUESTS_FILE_NAME) : '';
};

const send = (msg) => {
  try {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  } catch (e) {
    try {
      process.stderr.write(`[mcp] failed to send: ${e?.message || String(e)}\n`);
    } catch {
      // ignore
    }
  }
};

const sendNotification = (method, params) => {
  if (!method) return;
  send({ jsonrpc: '2.0', method, params });
};

const jsonRpcError = (id, code, message, data) => ({
  jsonrpc: '2.0',
  id,
  error: {
    code,
    message,
    ...(data !== undefined ? { data } : {}),
  },
});

const jsonRpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

const parseIsoTime = (value) => {
  const ts = Date.parse(value || '');
  return Number.isFinite(ts) ? ts : 0;
};

const parseWindowTime = (win) => {
  const updated = Date.parse(win?.updatedAt || '') || 0;
  if (updated) return updated;
  return Date.parse(win?.createdAt || '') || 0;
};

const sortWindowsByRecent = (windows) =>
  Array.isArray(windows) ? windows.slice().sort((a, b) => parseWindowTime(b) - parseWindowTime(a)) : [];
const isRunningStatus = (value) => {
  const status = normalizeString(value).toLowerCase();
  return status === 'running' || status === 'aborting';
};
const normalizePath = (value) => {
  const raw = normalizeString(value);
  if (!raw) return '';
  try {
    return path.resolve(raw);
  } catch {
    return raw;
  }
};
const getWindowWorkingDirectory = (win) =>
  normalizePath(win?.lastRunOptions?.workingDirectory || win?.defaultRunOptions?.workingDirectory || '');
const findWindowByWorkingDirectory = (windows, workingDirectory, { includeRunning = false } = {}) => {
  const needle = normalizePath(workingDirectory);
  if (!needle) return null;
  return Array.isArray(windows)
    ? windows.find((win) => {
        if (!includeRunning && isRunningStatus(win?.status)) return false;
        const workdir = getWindowWorkingDirectory(win);
        return workdir && workdir === needle;
      })
    : null;
};

const toolResultText = (text) => ({
  content: [{ type: 'text', text: String(text ?? '') }],
});

const loadState = (meta) =>
  readJsonFile(getStateFile(meta)) || { version: 0, windows: [], windowLogs: {}, windowTasks: {} };

const buildDefaultsApplied = (input, meta) => {
  const workingDirectory = normalizeString(input?.workingDirectory) || resolveDefaultWorkingDirectory(meta);
  const sandboxMode = normalizeString(input?.sandboxMode) || 'danger-full-access';
  return {
    workingDirectory,
    sandboxMode,
    model: normalizeString(input?.model) || DEFAULT_MODEL,
    modelReasoningEffort: normalizeString(input?.modelReasoningEffort) || 'xhigh',
    approvalPolicy: normalizeString(input?.approvalPolicy) || DEFAULT_APPROVAL,
    experimentalWindowsSandboxEnabled: input?.experimentalWindowsSandboxEnabled === undefined ? false : Boolean(input.experimentalWindowsSandboxEnabled),
    networkAccessEnabled: input?.networkAccessEnabled === undefined ? null : Boolean(input.networkAccessEnabled),
    webSearchEnabled: input?.webSearchEnabled === undefined ? null : Boolean(input.webSearchEnabled),
    skipGitRepoCheck: input?.skipGitRepoCheck === undefined ? true : Boolean(input.skipGitRepoCheck),
  };
};

const mergeRunOptionsForRequest = (base, override) => {
  const merged = base && typeof base === 'object' ? { ...base } : {};
  if (!override || typeof override !== 'object') return merged;
  for (const [key, value] of Object.entries(override)) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) continue;
      merged[key] = trimmed;
      continue;
    }
    if (value !== undefined && value !== null) {
      merged[key] = value;
    }
  }
  return merged;
};

const normalizeRequests = (raw) => {
  const data = raw && typeof raw === 'object' ? { ...raw } : {};
  if (!Array.isArray(data.createWindows)) data.createWindows = [];
  if (!Array.isArray(data.startRuns)) data.startRuns = [];
  data.version = STATE_VERSION;
  return data;
};

const appendStartRunRequest = (entry, meta) => {
  const requestsFile = getRequestsFile(meta);
  const requests = normalizeRequests(readJsonFile(requestsFile));
  requests.startRuns.push(entry);
  writeJsonFileAtomic(requestsFile, requests);
};

const pendingCompletions = new Map();

const clearCompletionWatcher = (token) => {
  if (!token) return;
  const timer = pendingCompletions.get(token);
  if (timer) clearInterval(timer);
  pendingCompletions.delete(token);
};

const scheduleCompletionNotification = ({ requestId, windowId, requestedAt, meta, rpcId }) => {
  if (!windowId) return '';
  const token = makeId();
  const startMs = Date.now();
  const requestedAtMs = parseIsoTime(requestedAt);
  let trackedRunId = '';

  const poll = () => {
    const state = loadState(meta);
    const windows = Array.isArray(state?.windows) ? state.windows : [];
    const runs = Array.isArray(state?.runs) ? state.runs : [];
    const win = windows.find((w) => w?.id === windowId) || null;

    if (!trackedRunId) {
      const activeRunId = normalizeString(win?.activeRunId);
      if (activeRunId) {
        const candidate = runs.find((run) => String(run?.id || '') === activeRunId);
        const startedAtMs = parseIsoTime(candidate?.startedAt);
        if (candidate && (!requestedAtMs || startedAtMs >= requestedAtMs)) {
          trackedRunId = String(candidate.id || '');
        }
      }
    }

    if (!trackedRunId) {
      const candidates = runs.filter((run) => {
        if (String(run?.windowId || '') !== windowId) return false;
        const startedAtMs = parseIsoTime(run?.startedAt);
        return !requestedAtMs || startedAtMs >= requestedAtMs;
      });
      candidates.sort((a, b) => parseIsoTime(a?.startedAt) - parseIsoTime(b?.startedAt));
      if (candidates.length) trackedRunId = String(candidates[0]?.id || '');
    }

    if (trackedRunId) {
      const run = runs.find((item) => String(item?.id || '') === trackedRunId);
      const status = normalizeString(run?.status);
      if (run && status && !isRunningStatus(status)) {
        sendNotification('codex_app.window_run.completed', {
          requestId,
          rpcId,
          windowId,
          runId: trackedRunId,
          status,
          finishedAt: run?.finishedAt || '',
          result: '😊',
        });
        clearCompletionWatcher(token);
        return;
      }
    }

    if (Date.now() - startMs > COMPLETION_TIMEOUT_MS) {
      clearCompletionWatcher(token);
    }
  };

  const timer = setInterval(poll, COMPLETION_POLL_MS);
  pendingCompletions.set(token, timer);
  poll();
  return token;
};

const TOOLS = [
  {
    name: 'codex_app.window_run',
    description: 'Queue a run in a UI window (async). Returns immediate ack; emits a smiley on completion.',
    inputSchema: {
      type: 'object',
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', description: 'Prompt passed to the window run.' },
      },
    },
  },
];

let initialized = false;

const handleRequest = async (req) => {
  const id = req?.id;
  const method = String(req?.method || '');
  const params = req?.params;

  if (!method) return;

  if (method === 'initialize') {
    initialized = true;
    return jsonRpcResult(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      serverInfo: { name: 'com.leeoohoo.codex_app.codex_app', version: '0.1.0' },
      capabilities: { tools: {} },
    });
  }

  if (!initialized) {
    return jsonRpcError(id, -32002, 'Server not initialized');
  }

  if (method === 'tools/list') {
    return jsonRpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const name = String(params?.name || '');
    const args = params?.arguments || {};

    if (name === 'codex_app.window_run') {
      const prompt = typeof args?.prompt === 'string' ? args.prompt : '';
      if (!String(prompt || '').trim()) return jsonRpcError(id, -32602, 'prompt is required');

      const meta = params?._meta;
      const state = loadState(meta);
      const windows = sortWindowsByRecent(Array.isArray(state?.windows) ? state.windows : []);
      const defaultsApplied = buildDefaultsApplied({}, meta);
      const workingDirectory = normalizeString(defaultsApplied.workingDirectory);
      const windowByWorkdir = findWindowByWorkingDirectory(windows, workingDirectory);
      const baseOptions = windowByWorkdir?.defaultRunOptions || windowByWorkdir?.lastRunOptions || {};
      const runOptions = mergeRunOptionsForRequest(defaultsApplied, baseOptions);
      if (workingDirectory) runOptions.workingDirectory = workingDirectory;
      if (runOptions.skipGitRepoCheck === undefined) {
        if (workingDirectory && !findGitRepoRoot(workingDirectory)) {
          runOptions.skipGitRepoCheck = true;
        }
      }
      const createdWindowId = windowByWorkdir?.id ? '' : makeId();
      const targetWindowId = windowByWorkdir?.id || createdWindowId;

      const requestId = makeId();
      const requestCreatedAt = nowIso();
      appendStartRunRequest(
        {
          id: requestId,
          windowId: targetWindowId,
          windowName: '',
          ensureWindow: true,
          input: prompt,
          threadId: '',
          codexCommand: 'codex',
          options: runOptions,
          defaults: createdWindowId ? defaultsApplied : null,
          createdAt: requestCreatedAt,
        },
        meta,
      );

      scheduleCompletionNotification({
        requestId,
        windowId: targetWindowId,
        requestedAt: requestCreatedAt,
        meta,
        rpcId: id,
      });

      return jsonRpcResult(id, toolResultText('调用成功'));
    }

    return jsonRpcError(id, -32601, `Unknown tool: ${name}`);
  }

  if (method === 'shutdown') {
    for (const token of pendingCompletions.keys()) {
      clearCompletionWatcher(token);
    }
    return jsonRpcResult(id, { ok: true });
  }

  return jsonRpcError(id, -32601, `Method not found: ${method}`);
};

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  const raw = String(line || '').trim();
  if (!raw) return;

  let req;
  try {
    req = JSON.parse(raw);
  } catch (e) {
    send(jsonRpcError(null, -32700, 'Parse error', { message: e?.message || String(e) }));
    return;
  }

  if (!req || typeof req !== 'object') return;
  if (req.jsonrpc !== '2.0') return;
  if (req.id === undefined) {
    // Notification; ignore.
    return;
  }

  try {
    const resp = await handleRequest(req);
    if (resp) send(resp);
  } catch (e) {
    send(jsonRpcError(req.id, -32000, e?.message || String(e)));
  }
});
