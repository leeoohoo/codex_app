/**
 * MCP Server 入口（stdio, 无第三方依赖）。
 *
 * 注意：ChatOS 导入插件包时会默认排除 `node_modules/`，因此这里仅使用 Node.js 内置模块。
 */

import { spawn } from 'node:child_process';
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
const JOBS_VERSION = 1;
const JOBS_FILE_NAME = 'codex_app_jobs.v1.json';
const DEFAULT_MODEL = 'gpt-5.2';
const DEFAULT_APPROVAL = 'never';
const DEFAULT_LOG_LIMIT = 200;
const MAX_LOG_LIMIT = 1000;
const JOBS_HEARTBEAT_MS = 5000;
const MAX_JOB_STDOUT = 160_000;
const MAX_JOB_STDERR = 60_000;

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

const getJobsFile = (meta) => {
  const dataDir = resolveDataDirWithMeta(meta);
  return dataDir ? path.join(dataDir, JOBS_FILE_NAME) : '';
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

const buildWindowsCommandArgs = (command, args) => {
  const comspec = String(process.env?.ComSpec || process.env?.COMSPEC || '').trim() || 'cmd.exe';
  return {
    command: comspec,
    args: ['/d', '/s', '/c', command, ...(Array.isArray(args) ? args : [])],
  };
};

const spawnProcess = ({ command, args, input = '' }) => {
  const spawnSpec =
    process.platform === 'win32' ? buildWindowsCommandArgs(command, args) : { command, args: Array.isArray(args) ? args : [] };
  const child = spawn(spawnSpec.command, spawnSpec.args, { windowsHide: true, env: process.env });
  if (child.stdin) {
    try {
      child.stdin.write(String(input || ''));
      child.stdin.end();
    } catch {
      // ignore
    }
  }
  return { child, spawn: spawnSpec };
};

const buildCodexExecArgs = ({ threadId, options }) => {
  const args = ['exec', '--json'];

  if (options?.model) args.push('--model', String(options.model));
  if (options?.sandboxMode) args.push('--sandbox', String(options.sandboxMode));
  if (options?.workingDirectory) args.push('--cd', String(options.workingDirectory));
  if (options?.skipGitRepoCheck) args.push('--skip-git-repo-check');

  if (options?.modelReasoningEffort) {
    args.push('--config', `model_reasoning_effort="${String(options.modelReasoningEffort)}"`);
  }
  if (options?.experimentalWindowsSandboxEnabled !== undefined) {
    args.push('--config', `features.experimental_windows_sandbox=${Boolean(options.experimentalWindowsSandboxEnabled)}`);
  }
  if (options?.networkAccessEnabled !== undefined) {
    args.push('--config', `sandbox_workspace_write.network_access=${Boolean(options.networkAccessEnabled)}`);
  }
  if (options?.webSearchEnabled !== undefined) {
    args.push('--config', `features.web_search_request=${Boolean(options.webSearchEnabled)}`);
  }
  if (options?.approvalPolicy) {
    args.push('--config', `approval_policy="${String(options.approvalPolicy)}"`);
  }

  if (threadId) args.push('resume', String(threadId));
  return args;
};

const jobStores = new Map();

const serializeJob = (job) => ({
  id: String(job.id || ''),
  status: String(job.status || ''),
  startedAt: String(job.startedAt || ''),
  updatedAt: String(job.updatedAt || ''),
  finishedAt: String(job.finishedAt || ''),
  exitCode: job.exitCode ?? null,
  signal: job.signal ?? '',
  error: String(job.error || ''),
  stdout: String(job.stdout || ''),
  stderr: String(job.stderr || ''),
  stdoutTruncated: Boolean(job.stdoutTruncated),
  stderrTruncated: Boolean(job.stderrTruncated),
  spawn: job.spawn && typeof job.spawn === 'object' ? job.spawn : null,
  options: job.options && typeof job.options === 'object' ? job.options : null,
  threadId: String(job.threadId || ''),
  windowId: String(job.windowId || ''),
  windowName: String(job.windowName || ''),
  ensureWindow: job.ensureWindow === undefined ? undefined : Boolean(job.ensureWindow),
  defaultsApplied: job.defaultsApplied && typeof job.defaultsApplied === 'object' ? job.defaultsApplied : null,
  lastOutputAt: String(job.lastOutputAt || ''),
  lastHeartbeatAt: String(job.lastHeartbeatAt || ''),
});

const getJobStore = (meta) => {
  const jobsFile = getJobsFile(meta);
  const key = jobsFile || `cwd:${process.cwd()}`;
  let store = jobStores.get(key);
  if (!store) {
    store = { jobsFile, jobs: new Map(), writeTimer: null, restored: false };
    jobStores.set(key, store);
  }
  if (!store.restored) {
    store.restored = true;
    const snapshot = readJsonFile(jobsFile) || {};
    const list = Array.isArray(snapshot.jobs) ? snapshot.jobs : [];
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const job = { ...entry };
      if (job.status === 'running') {
        job.status = 'orphaned';
        job.error = job.error || 'job process not available';
        job.finishedAt = job.finishedAt || nowIso();
        job.updatedAt = nowIso();
      }
      const id = String(job.id || makeId());
      job.id = id;
      store.jobs.set(id, job);
    }
  }
  return store;
};

const scheduleJobStoreWrite = (store) => {
  if (!store?.jobsFile) return;
  if (store.writeTimer) return;
  store.writeTimer = setTimeout(() => {
    store.writeTimer = null;
    const jobs = Array.from(store.jobs.values()).map(serializeJob);
    writeJsonFileAtomic(store.jobsFile, { version: JOBS_VERSION, updatedAt: nowIso(), jobs });
  }, 200);
};

const appendJobOutput = (job, key, chunk) => {
  const isStdout = key === 'stdout';
  const maxLen = isStdout ? MAX_JOB_STDOUT : MAX_JOB_STDERR;
  const truncatedKey = isStdout ? 'stdoutTruncated' : 'stderrTruncated';
  if (job[truncatedKey]) return;
  const text = String(chunk?.toString?.('utf8') || chunk || '');
  if (!text) return;
  const next = String(job[key] || '') + text;
  if (next.length > maxLen) {
    job[key] = `${next.slice(0, maxLen)}\n…(truncated)`;
    job[truncatedKey] = true;
  } else {
    job[key] = next;
  }
  job.lastOutputAt = nowIso();
  job.updatedAt = job.lastOutputAt;
};

const buildJobSummary = (job) => ({
  id: String(job.id || ''),
  status: String(job.status || ''),
  startedAt: String(job.startedAt || ''),
  updatedAt: String(job.updatedAt || ''),
  finishedAt: String(job.finishedAt || ''),
  exitCode: job.exitCode ?? null,
  signal: job.signal ?? '',
  error: String(job.error || ''),
  threadId: String(job.threadId || ''),
  windowId: String(job.windowId || ''),
  lastOutputAt: String(job.lastOutputAt || ''),
  lastHeartbeatAt: String(job.lastHeartbeatAt || ''),
});

const buildJobResult = (job) => ({
  ...buildJobSummary(job),
  stdout: String(job.stdout || ''),
  stderr: String(job.stderr || ''),
  stdoutTruncated: Boolean(job.stdoutTruncated),
  stderrTruncated: Boolean(job.stderrTruncated),
  spawn: job.spawn && typeof job.spawn === 'object' ? job.spawn : null,
  options: job.options && typeof job.options === 'object' ? job.options : null,
  defaultsApplied: job.defaultsApplied && typeof job.defaultsApplied === 'object' ? job.defaultsApplied : null,
});

const finishJob = (job, store, { code = null, signal = null, error = '' } = {}) => {
  if (!job || (job.status !== 'running' && job.status !== 'aborting')) return;
  job.exitCode = code;
  job.signal = signal;
  job.error = error ? String(error) : '';
  job.finishedAt = nowIso();
  job.updatedAt = job.finishedAt;
  if (signal) {
    job.status = 'aborted';
  } else if (code === 0) {
    job.status = 'finished';
  } else {
    job.status = 'failed';
  }
  if (job.heartbeatTimer) {
    try {
      clearInterval(job.heartbeatTimer);
    } catch {
      // ignore
    }
  }
  job.heartbeatTimer = null;
  scheduleJobStoreWrite(store);
};

const formatCodexItem = (item) => {
  if (!item || typeof item !== 'object') return '';
  const t = item.type;
  if (t === 'command_execution') {
    const status = item.status ? ` status=${item.status}` : '';
    const code = item.exit_code !== undefined ? ` exit=${item.exit_code}` : '';
    return `command ${JSON.stringify(item.command || '')}${status}${code}`;
  }
  if (t === 'file_change') {
    const changes = Array.isArray(item.changes) ? item.changes.map((c) => `${c.kind}:${c.path}`).join(', ') : '';
    return `patch status=${item.status || ''}${changes ? ` changes=[${changes}]` : ''}`;
  }
  if (t === 'mcp_tool_call') {
    return `mcp ${String(item.server || '')}.${String(item.tool || '')} status=${String(item.status || '')}`;
  }
  if (t === 'web_search') return `web_search ${JSON.stringify(item.query || '')}`;
  if (t === 'todo_list') return `todo_list (${Array.isArray(item.items) ? item.items.length : 0} items)`;
  if (t === 'error') return `error ${JSON.stringify(item.message || '')}`;
  if (t === 'reasoning') return `reasoning ${JSON.stringify(String(item.text || '').slice(0, 120))}`;
  if (t === 'agent_message') return `assistant ${JSON.stringify(String(item.text || '').slice(0, 160))}`;
  return `${String(t || 'item')} ${JSON.stringify(item).slice(0, 200)}`;
};

const formatRunEvent = (evt) => {
  const ts = evt?.ts || new Date().toISOString();
  const trunc = evt?.truncated ? ` …(truncated, originalLength=${Number(evt.originalLength) || 0})` : '';

  if (evt && typeof evt === 'object' && typeof evt.line === 'string') return evt.line;
  if (evt?.source === 'stderr') return `[${ts}] stderr ${String(evt.text || '').trimEnd()}${trunc}`;
  if (evt?.source === 'raw') return `[${ts}] raw ${String(evt.text || '').trimEnd()}${trunc}`;

  if (evt?.source === 'system') {
    if (evt.kind === 'spawn') return `[${ts}] spawn ${String(evt.command || '')} ${Array.isArray(evt.args) ? evt.args.join(' ') : ''}`;
    if (evt.kind === 'status') return `[${ts}] status ${String(evt.status || '')}`;
    if (evt.kind === 'warning') return `[${ts}] warning ${String(evt.message || evt.warning || '')}`;
    if (evt.kind === 'error') return `[${ts}] error ${String(evt?.error?.message || '')}`;
    if (evt.kind === 'gap' && evt?.gap && Number.isFinite(evt.gap?.from) && Number.isFinite(evt.gap?.to)) {
      return `[${ts}] gap dropped_events seq=[${evt.gap.from}, ${evt.gap.to})`;
    }
    return `[${ts}] system ${JSON.stringify(evt).slice(0, 320)}`;
  }

  if (evt?.source === 'codex') {
    const e = evt.event || {};
    if (e.type === 'thread.started') return `[${ts}] thread.started threadId=${String(e.thread_id || '')}`;
    if (e.type === 'turn.started') return `[${ts}] turn.started`;
    if (e.type === 'turn.completed') return `[${ts}] turn.completed usage=${JSON.stringify(e.usage || null)}`;
    if (e.type === 'turn.failed') return `[${ts}] turn.failed ${String(e?.error?.message || '')}`;
    if (e.type === 'error') return `[${ts}] error ${String(e.message || '')}`;
    if (e.type === 'item.started') return `[${ts}] item.started ${formatCodexItem(e.item)}`;
    if (e.type === 'item.updated') return `[${ts}] item.updated ${formatCodexItem(e.item)}`;
    if (e.type === 'item.completed') return `[${ts}] item.completed ${formatCodexItem(e.item)}`;
    return `[${ts}] ${String(e.type || 'event')} ${JSON.stringify(e).slice(0, 320)}`;
  }

  return `[${ts}] ${JSON.stringify(evt).slice(0, 320)}`;
};

const parseWindowTime = (win) => {
  const updated = Date.parse(win?.updatedAt || '') || 0;
  if (updated) return updated;
  return Date.parse(win?.createdAt || '') || 0;
};

const sortWindowsByRecent = (windows) =>
  Array.isArray(windows) ? windows.slice().sort((a, b) => parseWindowTime(b) - parseWindowTime(a)) : [];

const pickPreferredWindow = (windows) => {
  if (!Array.isArray(windows) || !windows.length) return null;
  const running = windows.find((win) => win?.status === 'running' || win?.status === 'aborting');
  if (running) return running;
  const withThread = windows.find((win) => normalizeString(win?.threadId));
  if (withThread) return withThread;
  return windows[0] || null;
};
const isRunningStatus = (value) => {
  const status = normalizeString(value).toLowerCase();
  return status === 'running' || status === 'aborting';
};
const findWindowByThreadId = (windows, threadId) => {
  const needle = normalizeString(threadId);
  if (!needle) return null;
  return Array.isArray(windows) ? windows.find((win) => normalizeString(win?.threadId) === needle) : null;
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

const runProcess = async ({ command, args, input = '' }) => {
  const MAX_OUT = 160_000;
  const MAX_ERR = 60_000;

  const spawnSpec =
    process.platform === 'win32' ? buildWindowsCommandArgs(command, args) : { command, args: Array.isArray(args) ? args : [] };

  const child = spawn(spawnSpec.command, spawnSpec.args, { windowsHide: true, env: process.env });

  let stdout = '';
  let stderr = '';

  child.stdout?.on('data', (chunk) => {
    if (stdout.length >= MAX_OUT) return;
    stdout += String(chunk?.toString?.('utf8') || chunk);
    if (stdout.length > MAX_OUT) stdout = `${stdout.slice(0, MAX_OUT)}\n…(truncated)`;
  });
  child.stderr?.on('data', (chunk) => {
    if (stderr.length >= MAX_ERR) return;
    stderr += String(chunk?.toString?.('utf8') || chunk);
    if (stderr.length > MAX_ERR) stderr = `${stderr.slice(0, MAX_ERR)}\n…(truncated)`;
  });

  if (child.stdin) {
    try {
      child.stdin.write(String(input || ''));
      child.stdin.end();
    } catch {
      // ignore
    }
  }

  const { code, signal } = await new Promise((resolve) => {
    child.once('close', (c, s) => resolve({ code: c, signal: s }));
    child.once('exit', (c, s) => resolve({ code: c, signal: s }));
    child.once('error', () => resolve({ code: null, signal: null }));
  });

  return { code, signal, stdout, stderr, spawn: spawnSpec };
};

const parseThreadIdFromStdout = (stdout) => {
  const text = String(stdout || '');
  if (!text) return '';
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const evt = JSON.parse(trimmed);
      if (evt?.type === 'thread.started' && typeof evt.thread_id === 'string') {
        return evt.thread_id;
      }
    } catch {
      // ignore parse errors
    }
  }
  return '';
};

const toolResultText = (text) => ({
  content: [{ type: 'text', text: String(text ?? '') }],
});

const toolResultJson = (obj) => toolResultText(JSON.stringify(obj, null, 2));

const clampNumber = (value, min, max) => {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
};

const loadState = (meta) =>
  readJsonFile(getStateFile(meta)) || { version: 0, windows: [], windowLogs: {}, windowTasks: {} };

const buildDefaultsApplied = (input, meta) => {
  const workingDirectory = normalizeString(input?.workingDirectory) || resolveDefaultWorkingDirectory(meta);
  const sandboxMode = normalizeString(input?.sandboxMode) || 'workspace-write';
  return {
    workingDirectory,
    sandboxMode,
    model: normalizeString(input?.model) || DEFAULT_MODEL,
    modelReasoningEffort: normalizeString(input?.modelReasoningEffort) || null,
    approvalPolicy: normalizeString(input?.approvalPolicy) || DEFAULT_APPROVAL,
    experimentalWindowsSandboxEnabled: input?.experimentalWindowsSandboxEnabled === undefined ? false : Boolean(input.experimentalWindowsSandboxEnabled),
    networkAccessEnabled: input?.networkAccessEnabled === undefined ? null : Boolean(input.networkAccessEnabled),
    webSearchEnabled: input?.webSearchEnabled === undefined ? null : Boolean(input.webSearchEnabled),
    skipGitRepoCheck: input?.skipGitRepoCheck === undefined ? false : Boolean(input.skipGitRepoCheck),
  };
};

const appendCreateWindowRequest = (entry, meta) => {
  const requestsFile = getRequestsFile(meta);
  const requests = readJsonFile(requestsFile) || { version: STATE_VERSION, createWindows: [] };
  const list = Array.isArray(requests.createWindows) ? requests.createWindows : [];
  list.push(entry);
  writeJsonFileAtomic(requestsFile, { version: STATE_VERSION, createWindows: list });
};

const TOOLS = [
  {
    name: 'codex_app.ping',
    description: 'Health check. Returns pong.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'codex_app.codex_version',
    description: 'Run `codex --version` and return output.',
    inputSchema: { type: 'object', properties: { codexCommand: { type: 'string' } } },
  },
  {
    name: 'codex_app.codex_exec',
    description: 'Run `codex exec --json` with the given prompt via stdin.',
    inputSchema: {
      type: 'object',
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', description: 'Prompt passed to codex via stdin.' },
        threadId: { type: 'string', description: 'Optional thread id to resume.' },
        windowId: { type: 'string', description: 'Optional. If set, use this window when creating a new UI window.' },
        ensureWindow: { type: 'boolean', description: 'Optional. When no window exists, create one and attach this run.' },
        windowName: { type: 'string', description: 'Optional. Name used if a new window is created.' },
        codexCommand: { type: 'string', description: 'Executable name or path (default: codex).' },
        options: {
          type: 'object',
          properties: {
            model: { type: 'string' },
            modelReasoningEffort: { type: 'string' },
            workingDirectory: { type: 'string' },
            sandboxMode: { type: 'string' },
            approvalPolicy: { type: 'string' },
            experimentalWindowsSandboxEnabled: { type: 'boolean' },
            networkAccessEnabled: { type: 'boolean' },
            webSearchEnabled: { type: 'boolean' },
            skipGitRepoCheck: { type: 'boolean' },
          },
        },
      },
    },
  },
  {
    name: 'codex_app.exec_async',
    description: 'Run `codex exec --json` asynchronously and return a jobId for polling.',
    inputSchema: {
      type: 'object',
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', description: 'Prompt passed to codex via stdin.' },
        threadId: { type: 'string', description: 'Optional thread id to resume.' },
        windowId: { type: 'string', description: 'Optional. If set, use this window when creating a new UI window.' },
        ensureWindow: { type: 'boolean', description: 'Optional. When no window exists, create one and attach this run.' },
        windowName: { type: 'string', description: 'Optional. Name used if a new window is created.' },
        codexCommand: { type: 'string', description: 'Executable name or path (default: codex).' },
        options: {
          type: 'object',
          properties: {
            model: { type: 'string' },
            modelReasoningEffort: { type: 'string' },
            workingDirectory: { type: 'string' },
            sandboxMode: { type: 'string' },
            approvalPolicy: { type: 'string' },
            experimentalWindowsSandboxEnabled: { type: 'boolean' },
            networkAccessEnabled: { type: 'boolean' },
            webSearchEnabled: { type: 'boolean' },
            skipGitRepoCheck: { type: 'boolean' },
          },
        },
      },
    },
  },
  {
    name: 'codex_app.exec_status',
    description: 'Get async exec job status.',
    inputSchema: {
      type: 'object',
      required: ['jobId'],
      properties: {
        jobId: { type: 'string' },
      },
    },
  },
  {
    name: 'codex_app.exec_result',
    description: 'Get async exec job result (stdout/stderr).',
    inputSchema: {
      type: 'object',
      required: ['jobId'],
      properties: {
        jobId: { type: 'string' },
      },
    },
  },
  {
    name: 'codex_app.exec_cancel',
    description: 'Cancel an async exec job.',
    inputSchema: {
      type: 'object',
      required: ['jobId'],
      properties: {
        jobId: { type: 'string' },
      },
    },
  },
  {
    name: 'codex_app.get_windows',
    description: 'List windows with last/default run settings (model, reasoning, working dir, sandbox, etc).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'codex_app.create_window',
    description:
      'Create a new window. workingDirectory/sandboxMode default to projectRoot/workspace-write if omitted. Returns explicit defaults applied to other fields.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Optional window name.' },
        workingDirectory: { type: 'string', description: 'Optional. Working directory passed to --cd.' },
        sandboxMode: { type: 'string', description: 'Optional. Sandbox mode (read-only/workspace-write/danger-full-access).' },
        model: { type: 'string', description: 'Optional. Defaults to gpt-5.2.' },
        modelReasoningEffort: { type: 'string', description: 'Optional. Defaults to codex config.' },
        approvalPolicy: { type: 'string', description: 'Optional. Defaults to never.' },
        experimentalWindowsSandboxEnabled: { type: 'boolean', description: 'Optional. Defaults to false.' },
        networkAccessEnabled: { type: 'boolean', description: 'Optional. Defaults to codex config.' },
        webSearchEnabled: { type: 'boolean', description: 'Optional. Defaults to codex config.' },
        skipGitRepoCheck: { type: 'boolean', description: 'Optional. Defaults to false.' },
      },
    },
  },
  {
    name: 'codex_app.get_window_logs',
    description: 'Get window logs by line count. By default returns the latest lines.',
    inputSchema: {
      type: 'object',
      required: ['windowId'],
      properties: {
        windowId: { type: 'string' },
        limit: { type: 'number', description: `Max lines to return (default ${DEFAULT_LOG_LIMIT}, max ${MAX_LOG_LIMIT}).` },
        offset: { type: 'number', description: 'Optional start index (0-based). If omitted, returns tail.' },
      },
    },
  },
  {
    name: 'codex_app.get_window_tasks',
    description: 'Get the latest todo_list (tasks) for a window.',
    inputSchema: {
      type: 'object',
      required: ['windowId'],
      properties: {
        windowId: { type: 'string' },
      },
    },
  },
];

let initialized = false;
let client = null;

const handleRequest = async (req) => {
  const id = req?.id;
  const method = String(req?.method || '');
  const params = req?.params;

  if (!method) return;

  if (method === 'initialize') {
    initialized = true;
    client = params?.clientInfo || null;
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

    if (name === 'codex_app.ping') {
      return jsonRpcResult(id, toolResultText(`pong (client=${client?.name || 'unknown'})`));
    }

    if (name === 'codex_app.codex_version') {
      const codexCommand = String(args?.codexCommand || 'codex').trim() || 'codex';
      const res = await runProcess({ command: codexCommand, args: ['--version'] });
      const text = [
        `command: ${res.spawn.command} ${res.spawn.args.join(' ')}`,
        `exit: ${res.code ?? 'null'}${res.signal ? ` signal=${res.signal}` : ''}`,
        res.stdout ? `\nstdout:\n${res.stdout.trimEnd()}` : '',
        res.stderr ? `\nstderr:\n${res.stderr.trimEnd()}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      return jsonRpcResult(id, toolResultText(text));
    }

    if (name === 'codex_app.codex_exec') {
      const prompt = typeof args?.prompt === 'string' ? args.prompt : '';
      if (!String(prompt || '').trim()) return jsonRpcError(id, -32602, 'prompt is required');

      const codexCommand = String(args?.codexCommand || 'codex').trim() || 'codex';
      const state = loadState(params?._meta);
      const windows = sortWindowsByRecent(Array.isArray(state?.windows) ? state.windows : []);
      const windowId = normalizeString(args?.windowId);
      const windowTarget = windowId ? windows.find((win) => win?.id === windowId) : null;
      let threadId = typeof args?.threadId === 'string' ? args.threadId : '';
      if (!threadId && windowTarget?.threadId) threadId = String(windowTarget.threadId || '');
      const windowByThread = threadId ? findWindowByThreadId(windows, threadId) : null;
      const runningTarget = windowTarget || windowByThread;
      if (runningTarget && isRunningStatus(runningTarget?.status)) {
        return jsonRpcError(id, -32000, 'window is running; cannot start a new run in the same window', {
          windowId: runningTarget?.id || '',
          status: runningTarget?.status || '',
        });
      }
      const options = args?.options && typeof args.options === 'object' ? { ...args.options } : {};
      if (!normalizeString(options.approvalPolicy)) {
        options.approvalPolicy = DEFAULT_APPROVAL;
      }
      if (options.skipGitRepoCheck === undefined) {
        const workdirForCheck = normalizeString(options.workingDirectory);
        if (workdirForCheck && !findGitRepoRoot(workdirForCheck)) {
          options.skipGitRepoCheck = true;
        }
      }
      const requestedWorkdir = normalizeString(options?.workingDirectory);
      const canMatchWorkdir = !windowId && !threadId && Boolean(requestedWorkdir);
      const windowByWorkdir = canMatchWorkdir ? findWindowByWorkingDirectory(windows, requestedWorkdir) : null;
      const codexArgs = buildCodexExecArgs({ threadId: threadId || null, options });

      const res = await runProcess({ command: codexCommand, args: codexArgs, input: prompt });
      const ensureWindow = args?.ensureWindow === undefined ? true : Boolean(args.ensureWindow);
      const shouldCreateWindow =
        ensureWindow && (!windows.length || (windowId && !windowTarget) || (canMatchWorkdir && !windowByWorkdir));
      let createdWindowId = '';
      if (shouldCreateWindow) {
        const derivedId = windowId || makeId();
        const defaultsApplied = buildDefaultsApplied(options, params?._meta);
        const threadIdFromOutput = parseThreadIdFromStdout(res.stdout) || '';
        appendCreateWindowRequest(
          {
            id: derivedId,
            name: normalizeString(args?.windowName) || '',
            defaults: defaultsApplied,
            threadId: threadIdFromOutput,
            createdAt: new Date().toISOString(),
          },
          params?._meta,
        );
        createdWindowId = derivedId;
      }
      const text = [
        `command: ${res.spawn.command} ${res.spawn.args.join(' ')}`,
        `exit: ${res.code ?? 'null'}${res.signal ? ` signal=${res.signal}` : ''}`,
        res.stdout ? `\nstdout:\n${res.stdout.trimEnd()}` : '',
        res.stderr ? `\nstderr:\n${res.stderr.trimEnd()}` : '',
        createdWindowId ? `\nwindow: created ${createdWindowId} (pending UI refresh)` : '',
      ]
        .filter(Boolean)
        .join('\n');
      return jsonRpcResult(id, toolResultText(text));
    }

    if (name === 'codex_app.exec_async') {
      const prompt = typeof args?.prompt === 'string' ? args.prompt : '';
      if (!String(prompt || '').trim()) return jsonRpcError(id, -32602, 'prompt is required');

      const codexCommand = String(args?.codexCommand || 'codex').trim() || 'codex';
      const state = loadState(params?._meta);
      const windows = sortWindowsByRecent(Array.isArray(state?.windows) ? state.windows : []);
      const windowId = normalizeString(args?.windowId);
      const windowTarget = windowId ? windows.find((win) => win?.id === windowId) : null;
      let threadId = typeof args?.threadId === 'string' ? args.threadId : '';
      if (!threadId && windowTarget?.threadId) threadId = String(windowTarget.threadId || '');
      const windowByThread = threadId ? findWindowByThreadId(windows, threadId) : null;
      const runningTarget = windowTarget || windowByThread;
      if (runningTarget && isRunningStatus(runningTarget?.status)) {
        return jsonRpcError(id, -32000, 'window is running; cannot start a new run in the same window', {
          windowId: runningTarget?.id || '',
          status: runningTarget?.status || '',
        });
      }
      const options = args?.options && typeof args.options === 'object' ? { ...args.options } : {};
      if (!normalizeString(options.approvalPolicy)) {
        options.approvalPolicy = DEFAULT_APPROVAL;
      }
      if (options.skipGitRepoCheck === undefined) {
        const workdirForCheck = normalizeString(options.workingDirectory);
        if (workdirForCheck && !findGitRepoRoot(workdirForCheck)) {
          options.skipGitRepoCheck = true;
        }
      }
      const requestedWorkdir = normalizeString(options?.workingDirectory);
      const canMatchWorkdir = !windowId && !threadId && Boolean(requestedWorkdir);
      const windowByWorkdir = canMatchWorkdir ? findWindowByWorkingDirectory(windows, requestedWorkdir) : null;
      const codexArgs = buildCodexExecArgs({ threadId: threadId || null, options });

      const ensureWindow = args?.ensureWindow === undefined ? true : Boolean(args.ensureWindow);
      const shouldCreateWindow =
        ensureWindow && (!windows.length || (windowId && !windowTarget) || (canMatchWorkdir && !windowByWorkdir));
      const windowName = normalizeString(args?.windowName) || '';
      let createdWindowId = '';
      let defaultsApplied = null;
      if (shouldCreateWindow) {
        createdWindowId = windowId || makeId();
        defaultsApplied = buildDefaultsApplied(options, params?._meta);
        appendCreateWindowRequest(
          {
            id: createdWindowId,
            name: windowName,
            defaults: defaultsApplied,
            createdAt: nowIso(),
          },
          params?._meta,
        );
      }

      const { child, spawn } = spawnProcess({ command: codexCommand, args: codexArgs, input: prompt });
      const store = getJobStore(params?._meta);
      const jobId = makeId();
      const job = {
        id: jobId,
        status: 'running',
        startedAt: nowIso(),
        updatedAt: nowIso(),
        finishedAt: '',
        exitCode: null,
        signal: null,
        error: '',
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        spawn,
        options,
        threadId: threadId || '',
        windowId: createdWindowId || windowId || windowTarget?.id || '',
        windowName,
        ensureWindow,
        defaultsApplied,
        lastOutputAt: '',
        lastHeartbeatAt: nowIso(),
        child,
        heartbeatTimer: null,
      };
      store.jobs.set(jobId, job);
      scheduleJobStoreWrite(store);

      job.heartbeatTimer = setInterval(() => {
        if (job.status !== 'running' && job.status !== 'aborting') return;
        job.lastHeartbeatAt = nowIso();
        job.updatedAt = job.lastHeartbeatAt;
        scheduleJobStoreWrite(store);
      }, JOBS_HEARTBEAT_MS);

      child.stdout?.on('data', (chunk) => {
        appendJobOutput(job, 'stdout', chunk);
        scheduleJobStoreWrite(store);
      });
      child.stderr?.on('data', (chunk) => {
        appendJobOutput(job, 'stderr', chunk);
        scheduleJobStoreWrite(store);
      });

      let finished = false;
      const finalize = (code, signal, error) => {
        if (finished) return;
        finished = true;
        const threadIdFromOutput = parseThreadIdFromStdout(job.stdout) || '';
        if (threadIdFromOutput) job.threadId = threadIdFromOutput;
        if (threadIdFromOutput && createdWindowId && defaultsApplied) {
          appendCreateWindowRequest(
            {
              id: createdWindowId,
              name: windowName,
              defaults: defaultsApplied,
              threadId: threadIdFromOutput,
              createdAt: nowIso(),
            },
            params?._meta,
          );
        }
        finishJob(job, store, { code, signal, error });
      };

      child.once('error', (err) => finalize(null, null, err?.message || String(err)));
      child.once('close', (code, signal) => finalize(code, signal, ''));

      return jsonRpcResult(
        id,
        toolResultJson({
          ok: true,
          jobId,
          status: job.status,
          startedAt: job.startedAt,
          windowId: createdWindowId || '',
          note: createdWindowId ? `window: created ${createdWindowId} (pending UI refresh)` : '',
        }),
      );
    }

    if (name === 'codex_app.exec_status') {
      const jobId = normalizeString(args?.jobId);
      if (!jobId) return jsonRpcError(id, -32602, 'jobId is required');
      const store = getJobStore(params?._meta);
      const job = store.jobs.get(jobId);
      if (!job) return jsonRpcError(id, -32602, `job not found: ${jobId}`);
      return jsonRpcResult(id, toolResultJson({ ok: true, job: buildJobSummary(job) }));
    }

    if (name === 'codex_app.exec_result') {
      const jobId = normalizeString(args?.jobId);
      if (!jobId) return jsonRpcError(id, -32602, 'jobId is required');
      const store = getJobStore(params?._meta);
      const job = store.jobs.get(jobId);
      if (!job) return jsonRpcError(id, -32602, `job not found: ${jobId}`);
      if (job.status === 'running' || job.status === 'aborting') {
        return jsonRpcError(id, -32000, 'job is still running', buildJobSummary(job));
      }
      return jsonRpcResult(id, toolResultJson({ ok: true, job: buildJobResult(job) }));
    }

    if (name === 'codex_app.exec_cancel') {
      const jobId = normalizeString(args?.jobId);
      if (!jobId) return jsonRpcError(id, -32602, 'jobId is required');
      const store = getJobStore(params?._meta);
      const job = store.jobs.get(jobId);
      if (!job) return jsonRpcError(id, -32602, `job not found: ${jobId}`);
      if (job.status !== 'running' && job.status !== 'aborting') {
        return jsonRpcResult(id, toolResultJson({ ok: true, job: buildJobSummary(job) }));
      }
      if (job.status !== 'aborting') {
        job.status = 'aborting';
        job.updatedAt = nowIso();
        job.lastHeartbeatAt = job.updatedAt;
        scheduleJobStoreWrite(store);
      }
      try {
        if (job.child?.kill) job.child.kill();
      } catch {
        // ignore
      }
      return jsonRpcResult(id, toolResultJson({ ok: true, job: buildJobSummary(job) }));
    }

    if (name === 'codex_app.get_windows') {
      const state = loadState(params?._meta);
      const windows = sortWindowsByRecent(Array.isArray(state?.windows) ? state.windows : []);
      const preferred = pickPreferredWindow(windows);
      return jsonRpcResult(
        id,
        toolResultJson({
          version: state?.version || 0,
          updatedAt: state?.updatedAt || '',
          windows,
          preferredWindowId: preferred?.id || '',
          preferredThreadId: preferred?.threadId || '',
        }),
      );
    }

    if (name === 'codex_app.create_window') {
      const defaultsApplied = buildDefaultsApplied(args, params?._meta);

      const windowId = makeId();
      appendCreateWindowRequest(
        {
          id: windowId,
          name: normalizeString(args?.name) || '',
          defaults: defaultsApplied,
          createdAt: new Date().toISOString(),
        },
        params?._meta,
      );

      return jsonRpcResult(
        id,
        toolResultJson({
          windowId,
          defaultsApplied,
          note: '窗口将在 UI 刷新或下次拉取时出现；请在调用方记录 defaultsApplied。',
        }),
      );
    }

    if (name === 'codex_app.get_window_logs') {
      const windowId = normalizeString(args?.windowId);
      if (!windowId) return jsonRpcError(id, -32602, 'windowId is required');
      const limit = clampNumber(Number(args?.limit ?? DEFAULT_LOG_LIMIT), 1, MAX_LOG_LIMIT);
      const offsetRaw = Number(args?.offset);
      const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.floor(offsetRaw)) : null;

      const state = loadState(params?._meta);
      const logsEntry = state?.windowLogs?.[windowId] || { events: [], lines: [], updatedAt: '' };
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
          status: win?.status || '',
          activeRunId: win?.activeRunId || '',
          totalLines: total,
          start,
          count: slice.length,
          nextOffset,
          updatedAt: logsEntry.updatedAt || state?.updatedAt || '',
          lines: slice,
        }),
      );
    }

    if (name === 'codex_app.get_window_tasks') {
      const windowId = normalizeString(args?.windowId);
      if (!windowId) return jsonRpcError(id, -32602, 'windowId is required');
      const state = loadState(params?._meta);
      const entry = state?.windowTasks?.[windowId];
      return jsonRpcResult(
        id,
        toolResultJson({
          windowId,
          todoList: Array.isArray(entry?.todoList) ? entry.todoList : [],
          todoListId: entry?.todoListId || '',
          updatedAt: entry?.updatedAt || state?.updatedAt || '',
        }),
      );
    }

    return jsonRpcError(id, -32601, `Unknown tool: ${name}`);
  }

  if (method === 'shutdown') {
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
