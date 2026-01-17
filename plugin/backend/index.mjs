import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import readline from 'node:readline';

const nowIso = () => new Date().toISOString();

const MAX_RUN_EVENTS = 5000;
const MAX_EVENT_TEXT_CHARS = 50000;
const MAX_WINDOW_INPUTS = 500;
const STATE_VERSION = 1;
const STATE_FILE_NAME = 'codex_app_state.v1.json';
const REQUESTS_FILE_NAME = 'codex_app_requests.v1.json';

// Keep in-memory runs/windows across backend hot reloads in dev sandbox (and any other dynamic import reloads).
// The dev server resets backendInstance on file changes, which would otherwise make `codexPollRun` return "run not found".
const GLOBAL_BACKEND_STORE = Symbol.for('chatos_ui_apps.codex_app.backend_store.v1');

const makeId = () => {
  try {
    return randomUUID();
  } catch {
    return `${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`;
  }
};

const normalizeString = (value) => {
  if (typeof value !== 'string') return '';
  return String(value || '').trim();
};

const normalizeStringArray = (value) => {
  if (!Array.isArray(value)) return [];
  return value.map((v) => normalizeString(v)).filter(Boolean);
};

const normalizeBoolean = (value) => {
  if (value === undefined || value === null) return undefined;
  return Boolean(value);
};

const resolveTaskkillPath = () => {
  const root = normalizeString(process.env?.SystemRoot || process.env?.WINDIR);
  if (root) {
    const candidate = path.join(root, 'System32', 'taskkill.exe');
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  return 'taskkill';
};

const normalizeTodoItem = (item) => {
  if (!item) return null;
  if (typeof item === 'string') {
    const text = item.trim();
    return text ? { text, completed: false } : null;
  }
  if (typeof item !== 'object') return null;
  const text = normalizeString(item.text || item.content || item.title || item.name || item.task || item.label || item.value);
  if (!text) return null;
  const completed = Boolean(item.completed ?? item.done ?? item.checked ?? item.finished ?? item.isDone ?? item.is_done);
  return { text, completed };
};

const parseTodoMarkdown = (value) => {
  const text = String(value ?? '').replace(/\r\n?/g, '\n').trim();
  if (!text) return [];
  const items = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let match = line.match(/^[-*]\s+\[(x|X| )\]\s+(.*)$/);
    if (match) {
      const itemText = String(match[2] || '').trim();
      if (itemText) items.push({ text: itemText, completed: String(match[1]).toLowerCase() === 'x' });
      continue;
    }
    match = line.match(/^[-*]\s+(.*)$/);
    if (match) {
      const itemText = String(match[1] || '').trim();
      if (itemText) items.push({ text: itemText, completed: false });
      continue;
    }
    match = line.match(/^\d+\.\s+(.*)$/);
    if (match) {
      const itemText = String(match[1] || '').trim();
      if (itemText) items.push({ text: itemText, completed: false });
    }
  }
  return items;
};

const normalizeTodoItems = (value) => {
  if (Array.isArray(value)) {
    const mapped = value.map(normalizeTodoItem).filter(Boolean);
    if (mapped.length) return mapped;
  }
  if (typeof value === 'string') return parseTodoMarkdown(value);
  if (value && typeof value === 'object') {
    if (Array.isArray(value.items)) {
      const mapped = value.items.map(normalizeTodoItem).filter(Boolean);
      return mapped;
    }
    const text = value.text || value.content || value.output_text || value.outputText || value.message;
    const parsed = parseTodoMarkdown(text);
    if (parsed.length) return parsed;
  }
  return [];
};

const pickDirectoryViaElectron = async ({ title, defaultPath } = {}) => {
  let electron = null;
  try {
    electron = await import('electron');
  } catch {
    try {
      const require = createRequire(import.meta.url);
      electron = require('electron');
    } catch {
      return null;
    }
  }
  const api = electron?.default && typeof electron.default === 'object' ? electron.default : electron;
  const dialog = api?.dialog;
  if (!dialog || typeof dialog.showOpenDialog !== 'function') return null;

  const BrowserWindow = api?.BrowserWindow;
  let win = undefined;
  try {
    win =
      (BrowserWindow && typeof BrowserWindow.getFocusedWindow === 'function' && BrowserWindow.getFocusedWindow()) ||
      (BrowserWindow && typeof BrowserWindow.getAllWindows === 'function' && BrowserWindow.getAllWindows()[0]) ||
      undefined;
  } catch {
    win = undefined;
  }

  const options = {
    title: normalizeString(title) || undefined,
    defaultPath: normalizeString(defaultPath) || undefined,
    properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
  };
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);

  const filePaths = Array.isArray(result?.filePaths) ? result.filePaths : [];
  const selected = !result?.canceled && filePaths[0] ? String(filePaths[0]) : '';
  return { canceled: Boolean(result?.canceled || !selected), path: selected };
};

const pickDirectory = async ({ title, defaultPath } = {}) => {
  const picked = await pickDirectoryViaElectron({ title, defaultPath });
  if (picked) return { ok: true, ...picked };
  return { ok: true, canceled: true, path: '', reason: 'unsupported' };
};

const clampNumber = (value, min, max) => {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
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
  } catch {
    // ignore
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

const resolveDataDir = (ctx) => {
  const fromCtx = normalizeString(ctx?.dataDir);
  if (fromCtx) return fromCtx;
  const pluginId = normalizeString(ctx?.pluginId) || 'com.leeoohoo.codex_app';
  const fromCwd = findUpwardsDataDir(process.cwd(), pluginId);
  if (fromCwd) return fromCwd;
  const fromPluginDir = normalizeString(ctx?.pluginDir);
  if (fromPluginDir) {
    const found = findUpwardsDataDir(fromPluginDir, pluginId);
    if (found) return found;
  }
  return path.join(process.cwd(), '.chatos', 'data', pluginId);
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
    // If the path doesn't exist, don't attempt to walk up.
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

const buildWindowsCommandArgs = (command, args) => {
  const comspec = normalizeString(process.env?.ComSpec || process.env?.COMSPEC) || 'cmd.exe';
  return {
    command: comspec,
    args: ['/d', '/s', '/c', command, ...(Array.isArray(args) ? args : [])],
  };
};

const buildCodexExecArgs = ({ threadId, options }) => {
  const args = ['exec', '--json'];

  if (options?.model) args.push('--model', String(options.model));
  if (options?.sandboxMode) args.push('--sandbox', String(options.sandboxMode));
  if (options?.workingDirectory) args.push('--cd', String(options.workingDirectory));

  const addDirs = normalizeStringArray(options?.additionalDirectories);
  for (const dir of addDirs) args.push('--add-dir', dir);

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

  if (threadId) args.push('resume', threadId);

  return args;
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
  const ts = evt?.ts || nowIso();
  const trunc = evt?.truncated ? ` …(truncated, originalLength=${Number(evt.originalLength) || 0})` : '';

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

const getGlobalBackendRoot = () => {
  const existing = globalThis?.[GLOBAL_BACKEND_STORE];
  if (existing && typeof existing === 'object' && existing.stores instanceof Map) return existing;
  const root = { stores: new Map() };
  try {
    Object.defineProperty(globalThis, GLOBAL_BACKEND_STORE, {
      value: root,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  } catch {
    // Fallback if defineProperty fails (should be rare).
    globalThis[GLOBAL_BACKEND_STORE] = root;
  }
  return root;
};

const getOrCreateBackendStore = (ctx) => {
  const dataDir = resolveDataDir(ctx);
  ensureDir(dataDir);

  const stateFile = dataDir ? path.join(dataDir, STATE_FILE_NAME) : '';
  const requestsFile = dataDir ? path.join(dataDir, REQUESTS_FILE_NAME) : '';
  const key = stateFile || requestsFile || `cwd:${process.cwd()}`;

  const root = getGlobalBackendRoot();
  let store = root.stores.get(key);
  if (!store) {
    store = {
      key,
      refCount: 0,
      dataDir,
      stateFile,
      requestsFile,
      windows: new Map(),
      runs: new Map(),
      windowLogs: new Map(),
      windowInputs: new Map(),
      stateWriteTimer: null,
      restored: false,
    };
    root.stores.set(key, store);
  } else {
    // Best-effort fill when a reload provides a more complete ctx.
    if (!store.dataDir && dataDir) store.dataDir = dataDir;
    if (!store.stateFile && stateFile) store.stateFile = stateFile;
    if (!store.requestsFile && requestsFile) store.requestsFile = requestsFile;
  }

  return store;
};

export async function createUiAppsBackend(ctx) {
  const store = getOrCreateBackendStore(ctx);
  store.refCount = Number.isFinite(store.refCount) ? store.refCount + 1 : 1;

  const windows = store.windows; // windowId -> { id, name, threadId, status, createdAt, updatedAt, activeRunId }
  const runs = store.runs; // runId -> { id, windowId, status, startedAt, finishedAt, events: [], error, abortController }
  const windowLogs = store.windowLogs; // windowId -> { events: object[], lines: string[], updatedAt }
  const windowInputs = store.windowInputs; // windowId -> { items: { ts, text }[], updatedAt }

  const stateFile = store.stateFile || '';
  const requestsFile = store.requestsFile || '';

  const normalizeRunOptions = (options) => {
    if (!options || typeof options !== 'object') return {};
    return {
      model: normalizeString(options.model),
      modelReasoningEffort: normalizeString(options.modelReasoningEffort),
      workingDirectory: normalizeString(options.workingDirectory),
      sandboxMode: normalizeString(options.sandboxMode),
      approvalPolicy: normalizeString(options.approvalPolicy),
      experimentalWindowsSandboxEnabled: normalizeBoolean(options.experimentalWindowsSandboxEnabled),
      networkAccessEnabled: normalizeBoolean(options.networkAccessEnabled),
      webSearchEnabled: normalizeBoolean(options.webSearchEnabled),
      skipGitRepoCheck: normalizeBoolean(options.skipGitRepoCheck),
    };
  };

  const mergeRunOptions = (baseOptions, overrideOptions) => {
    const base = normalizeRunOptions(baseOptions);
    const over = normalizeRunOptions(overrideOptions);
    const merged = { ...base };
    for (const [key, value] of Object.entries(over)) {
      if (value !== undefined) merged[key] = value;
    }
    return merged;
  };

  const serializeRunOptions = (options) => {
    if (!options || typeof options !== 'object') return null;
    const normalized = normalizeRunOptions(options);
    const out = {};
    for (const [key, value] of Object.entries(normalized)) {
      out[key] = value === undefined || value === '' ? null : value;
    }
    return out;
  };

  const loadStateFile = () => {
    if (!stateFile) return null;
    return readJsonFile(stateFile);
  };

  const restoreWindowsFromState = (snapshot) => {
    const list = Array.isArray(snapshot?.windows) ? snapshot.windows : [];
    const tasks = snapshot?.windowTasks && typeof snapshot.windowTasks === 'object' ? snapshot.windowTasks : {};
    const runsList = Array.isArray(snapshot?.runs) ? snapshot.runs : [];
    const latestRunByWindow = new Map();
    for (const run of runsList) {
      const windowId = normalizeString(run?.windowId);
      if (!windowId) continue;
      const ts = Date.parse(run?.finishedAt || run?.startedAt || '') || 0;
      const existing = latestRunByWindow.get(windowId);
      if (!existing || ts >= existing.ts) {
        latestRunByWindow.set(windowId, { ts, status: normalizeString(run?.status) });
      }
    }
    for (const entry of list) {
      const id = normalizeString(entry?.id);
      if (!id) continue;
      const now = nowIso();
      const statusRaw = normalizeString(entry?.status) || 'idle';
      const status = statusRaw === 'running' || statusRaw === 'aborting' ? 'idle' : statusRaw;
      const window = {
        id,
        name: normalizeString(entry?.name) || `Codex ${id.slice(0, 8)}`,
        threadId: normalizeString(entry?.threadId) || '',
        status: status || 'idle',
        createdAt: normalizeString(entry?.createdAt) || now,
        updatedAt: normalizeString(entry?.updatedAt) || now,
        activeRunId: '',
        todoList: [],
        todoListId: '',
        todoListUpdatedAt: '',
        defaultRunOptions: normalizeRunOptions(entry?.defaultRunOptions),
        lastRunOptions: entry?.lastRunOptions ? normalizeRunOptions(entry.lastRunOptions) : null,
        lastRunAt: normalizeString(entry?.lastRunAt) || '',
        source: normalizeString(entry?.source) || 'ui',
      };
      const taskEntry = tasks?.[id];
      if (taskEntry && typeof taskEntry === 'object') {
        window.todoList = normalizeTodoItems(taskEntry.todoList);
        window.todoListId = normalizeString(taskEntry.todoListId) || '';
        window.todoListUpdatedAt = normalizeString(taskEntry.updatedAt) || '';
      }
      windows.set(id, window);
    }
  };

  const restoreWindowLogsFromState = (snapshot) => {
    const logSnapshot = snapshot?.windowLogs && typeof snapshot.windowLogs === 'object' ? snapshot.windowLogs : {};
    for (const [rawId, info] of Object.entries(logSnapshot)) {
      const id = normalizeString(rawId);
      if (!id || !info || typeof info !== 'object') continue;
      const events = Array.isArray(info.events) ? info.events : [];
      const lines = Array.isArray(info.lines) ? info.lines : [];
      const updatedAt = normalizeString(info.updatedAt) || '';
      if (events.length || lines.length || updatedAt) {
        const lineEvents = lines.map((line) => ({ line: String(line ?? '') }));
        const mergedEvents = lineEvents.length ? [...lineEvents, ...events] : events;
        windowLogs.set(id, { events: mergedEvents, lines: [], updatedAt });
      }
    }
  };

  const restoreWindowInputsFromState = (snapshot) => {
    const inputSnapshot = snapshot?.windowInputs && typeof snapshot.windowInputs === 'object' ? snapshot.windowInputs : {};
    for (const [rawId, info] of Object.entries(inputSnapshot)) {
      const id = normalizeString(rawId);
      if (!id || !info || typeof info !== 'object') continue;
      const items = Array.isArray(info.items) ? info.items : [];
      const updatedAt = normalizeString(info.updatedAt) || '';
      if (!items.length && !updatedAt) continue;
      const normalized = items
        .map((entry) =>
          entry && typeof entry === 'object'
            ? { ts: normalizeString(entry.ts) || nowIso(), text: normalizeString(entry.text) }
            : null,
        )
        .filter((entry) => entry && entry.text);
      if (normalized.length || updatedAt) {
        windowInputs.set(id, { items: normalized.slice(-MAX_WINDOW_INPUTS), updatedAt });
      }
    }
  };

  const restoreState = () => {
    const snapshot = loadStateFile();
    if (!snapshot) return;
    restoreWindowsFromState(snapshot);
    restoreWindowLogsFromState(snapshot);
    restoreWindowInputsFromState(snapshot);
  };

  const appendWindowLog = (windowId, evt) => {
    const id = normalizeString(windowId);
    if (!id) return;
    const existing = windowLogs.get(id) || { events: [], lines: [], updatedAt: '' };
    if (evt) existing.events.push(evt);
    existing.updatedAt = nowIso();
    windowLogs.set(id, existing);
  };

  const appendWindowInput = (windowId, text) => {
    const id = normalizeString(windowId);
    const value = normalizeString(text);
    if (!id || !value) return null;
    const existing = windowInputs.get(id) || { items: [], updatedAt: '' };
    const entry = { ts: nowIso(), text: value };
    existing.items.push(entry);
    if (existing.items.length > MAX_WINDOW_INPUTS) {
      existing.items.splice(0, Math.max(0, existing.items.length - MAX_WINDOW_INPUTS));
    }
    existing.updatedAt = nowIso();
    windowInputs.set(id, existing);
    scheduleStateWrite();
    return existing;
  };

  const buildSharedState = () => {
    const windowTasks = {};
    for (const win of windows.values()) {
      windowTasks[win.id] = {
        todoList: normalizeTodoItems(win.todoList),
        todoListId: win.todoListId || '',
        updatedAt: win.todoListUpdatedAt || '',
      };
    }

    const logSnapshot = {};
    for (const [id, info] of windowLogs.entries()) {
      logSnapshot[id] = {
        events: Array.isArray(info.events) ? info.events : [],
        lines: Array.isArray(info.lines) ? info.lines : [],
        updatedAt: info.updatedAt || '',
      };
    }

    const inputSnapshot = {};
    for (const [id, info] of windowInputs.entries()) {
      inputSnapshot[id] = {
        items: Array.isArray(info.items) ? info.items : [],
        updatedAt: info.updatedAt || '',
      };
    }

    return {
      version: STATE_VERSION,
      updatedAt: nowIso(),
      windows: Array.from(windows.values()).map((win) => ({
        id: win.id,
        name: win.name,
        threadId: win.threadId,
        status: win.status,
        createdAt: win.createdAt,
        updatedAt: win.updatedAt,
        activeRunId: win.activeRunId,
        defaultRunOptions: serializeRunOptions(win.defaultRunOptions),
        lastRunOptions: serializeRunOptions(win.lastRunOptions),
        lastRunAt: win.lastRunAt || '',
        source: win.source || 'ui',
      })),
      runs: Array.from(runs.values()).map((run) => ({
        id: run.id,
        windowId: run.windowId,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        error: run.error,
        options: serializeRunOptions(run.options),
      })),
      windowLogs: logSnapshot,
      windowTasks,
      windowInputs: inputSnapshot,
    };
  };

  const scheduleStateWrite = () => {
    if (!stateFile) return;
    if (store.stateWriteTimer) return;
    store.stateWriteTimer = setTimeout(() => {
      store.stateWriteTimer = null;
      writeJsonFileAtomic(stateFile, buildSharedState());
    }, 120);
  };

  const syncRequests = () => {
    if (!requestsFile) return;
    const requests = readJsonFile(requestsFile) || {};
    const createWindows = Array.isArray(requests.createWindows) ? requests.createWindows : [];
    if (!createWindows.length) return;

    const pending = [];
    for (const req of createWindows) {
      const reqId = normalizeString(req?.id);
      const id = reqId || makeId();
      const defaults = normalizeRunOptions(req?.defaults || {});
      if (!defaults.workingDirectory || !defaults.sandboxMode) {
        pending.push(req);
        continue;
      }
      const name = normalizeString(req?.name) || `Codex ${id.slice(0, 8)}`;
      const threadId = normalizeString(req?.threadId);
      if (windows.has(id)) {
        const win = windows.get(id);
        win.defaultRunOptions = mergeRunOptions(win.defaultRunOptions, defaults);
        if (threadId) win.threadId = threadId;
        win.updatedAt = nowIso();
      } else {
        createWindow({ id, name, threadId, defaults, source: 'mcp' });
      }
    }

    writeJsonFileAtomic(requestsFile, { version: STATE_VERSION, createWindows: pending });
    scheduleStateWrite();
  };

  const llmComplete = async (params, runtimeCtx) => {
    const api = runtimeCtx?.llm || ctx?.llm || null;
    if (!api || typeof api.complete !== 'function') {
      throw new Error('Host LLM bridge is not available (ctx.llm.complete)');
    }
    const input =
      typeof params?.input === 'string' ? params.input : typeof params?.prompt === 'string' ? params.prompt : '';
    const normalized = String(input || '').trim();
    if (!normalized) {
      throw new Error('input is required');
    }
    return await api.complete({
      input: normalized,
      modelId: typeof params?.modelId === 'string' ? params.modelId : undefined,
      modelName: typeof params?.modelName === 'string' ? params.modelName : undefined,
      systemPrompt: typeof params?.systemPrompt === 'string' ? params.systemPrompt : undefined,
      disableTools: params?.disableTools,
    });
  };

  const pushRunEvent = (run, payload) => {
    const normalizedPayload = payload && typeof payload === 'object' ? { ...payload } : { payload };
    if ((normalizedPayload.source === 'stderr' || normalizedPayload.source === 'raw') && normalizedPayload.text !== undefined) {
      const rawText = String(normalizedPayload.text ?? '');
      if (rawText.length > MAX_EVENT_TEXT_CHARS) {
        normalizedPayload.text = rawText.slice(0, MAX_EVENT_TEXT_CHARS);
        normalizedPayload.truncated = true;
        normalizedPayload.originalLength = rawText.length;
      } else {
        normalizedPayload.text = rawText;
      }
    }

    const evt = {
      seq: Number.isFinite(run.nextSeq) ? run.nextSeq : run.events.length,
      ts: nowIso(),
      ...normalizedPayload,
    };
    run.nextSeq = evt.seq + 1;
    run.events.push(evt);

    appendWindowLog(run.windowId, evt);
    scheduleStateWrite();

    if (run.events.length > MAX_RUN_EVENTS) {
      const dropCount = run.events.length - MAX_RUN_EVENTS;
      run.events.splice(0, dropCount);
      run.droppedEvents = Number.isFinite(run.droppedEvents) ? run.droppedEvents + dropCount : dropCount;
    }

    return evt;
  };

  const getWindow = (windowId) => {
    const id = normalizeString(windowId);
    if (!id) throw new Error('windowId is required');
    const window = windows.get(id);
    if (!window) throw new Error(`window not found: ${id}`);
    return window;
  };

  const getRun = (runId) => {
    const id = normalizeString(runId);
    if (!id) throw new Error('runId is required');
    const run = runs.get(id);
    if (!run) throw new Error(`run not found: ${id}`);
    return run;
  };

  function createWindow({ id: providedId, name, threadId, defaults, source } = {}) {
    const id = normalizeString(providedId) || makeId();
    const now = nowIso();
    const window = {
      id,
      name: normalizeString(name) || `Codex ${id.slice(0, 8)}`,
      threadId: normalizeString(threadId) || '',
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      activeRunId: '',
      todoList: [],
      todoListId: '',
      todoListUpdatedAt: '',
      defaultRunOptions: normalizeRunOptions(defaults),
      lastRunOptions: null,
      lastRunAt: '',
      source: normalizeString(source) || 'ui',
    };
    windows.set(id, window);
    scheduleStateWrite();
    return window;
  }

  const abortRun = async (run) => {
    if (!run || (run.status !== 'running' && run.status !== 'aborting')) return { ok: true };
    if (run.status !== 'aborting') run.status = 'aborting';
    try {
      run.abortController?.abort();
    } catch {
      // ignore
    }
    const win = windows.get(run.windowId);
    if (win && win.status !== 'aborting') {
      win.status = 'aborting';
      win.updatedAt = nowIso();
      scheduleStateWrite();
    }
    try {
      if (run.child?.kill) run.child.kill();
    } catch {
      // ignore
    }
    if (Number.isFinite(run.childPid) && run.childPid > 0) {
      if (process.platform === 'win32') {
        try {
          const killer = spawn(resolveTaskkillPath(), ['/pid', String(run.childPid), '/t', '/f'], {
            windowsHide: true,
            env: process.env,
          });
          killer.once('error', () => {
            // ignore
          });
        } catch {
          // ignore
        }
      } else {
        try {
          process.kill(run.childPid, 'SIGTERM');
        } catch {
          // ignore
        }
        setTimeout(() => {
          try {
            process.kill(run.childPid, 'SIGKILL');
          } catch {
            // ignore
          }
        }, 1500);
      }
    }
    pushRunEvent(run, { source: 'system', kind: 'status', status: 'aborting' });
    return { ok: true };
  };

  const startRun = async (params, runtimeCtx) => {
    const window = getWindow(params?.windowId);
    const input = normalizeString(params?.input ?? params?.prompt);
    if (!input) throw new Error('input is required');
    if (window.status === 'running') throw new Error('window is already running');

    const codexCommand = normalizeString(params?.codexCommand) || 'codex';
    const rawOptions = params?.options && typeof params.options === 'object' ? params.options : {};
    const options = mergeRunOptions(window.defaultRunOptions, rawOptions);
    const threadId = normalizeString(params?.threadId) || normalizeString(window.threadId);

    const runId = makeId();
    const startedAt = nowIso();
    const abortController = new AbortController();

      const run = {
        id: runId,
        windowId: window.id,
        status: 'running',
      startedAt,
      finishedAt: '',
      events: [],
      error: null,
      abortController,
      codexCommand,
      options,
      threadId,
      pluginId: runtimeCtx?.pluginId || ctx?.pluginId || '',
      childPid: 0,
      nextSeq: 0,
        droppedEvents: 0,
        todoList: [],
        todoListId: '',
        todoListUpdatedAt: '',
        child: null,
      };
      runs.set(runId, run);

    window.status = 'running';
    window.activeRunId = runId;
    window.updatedAt = startedAt;
    window.lastRunOptions = options;
    window.lastRunAt = startedAt;
    scheduleStateWrite();

    pushRunEvent(run, { source: 'system', kind: 'status', status: 'running' });

    if (
      process.platform === 'win32' &&
      String(options?.sandboxMode || '') === 'workspace-write' &&
      !Boolean(options?.experimentalWindowsSandboxEnabled)
    ) {
      pushRunEvent(run, {
        source: 'system',
        kind: 'warning',
        message:
          'Windows 上 workspace-write 会被 Codex 强制降级为 read-only（除非启用 features.experimental_windows_sandbox）。请在运行设置中勾选 “Windows 沙箱（实验）” 或改用 danger-full-access。',
      });
    }

    const codexArgs = buildCodexExecArgs({ threadId: run.threadId || null, options });
    const spawnSpec =
      process.platform === 'win32'
        ? buildWindowsCommandArgs(codexCommand, codexArgs)
        : { command: codexCommand, args: codexArgs };

      const child = spawn(spawnSpec.command, spawnSpec.args, {
        env: process.env,
        signal: abortController.signal,
        windowsHide: true,
      });

      run.child = child;
      run.childPid = child.pid || 0;

    const spawnEvt = { source: 'system', kind: 'spawn', command: codexCommand, args: codexArgs };
    if (spawnSpec.command !== codexCommand) spawnEvt.wrapper = spawnSpec;
    pushRunEvent(run, spawnEvt);

    let spawnError = null;
    child.once('error', (err) => {
      spawnError = err;
      pushRunEvent(run, { source: 'system', kind: 'error', error: { message: err?.message || String(err) } });
    });

    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        pushRunEvent(run, { source: 'stderr', text: String(chunk?.toString?.('utf8') || chunk) });
      });
    }

    const finish = (status, error) => {
      if (run.finishedAt) return;
      run.status = status;
      run.finishedAt = nowIso();
      run.error = error ? { message: error?.message || String(error) } : null;
      pushRunEvent(run, {
        source: 'system',
        kind: 'status',
        status: run.status,
        finishedAt: run.finishedAt,
        error: run.error,
      });
      const win = windows.get(run.windowId);
      if (win && win.activeRunId === run.id) {
        win.status = 'idle';
        win.activeRunId = '';
        win.updatedAt = run.finishedAt;
      }
      scheduleStateWrite();
    };

    const exitPromise = new Promise((resolve) => {
      child.once('close', (code, signal) => resolve({ code, signal }));
      child.once('exit', (code, signal) => resolve({ code, signal }));
      child.once('error', () => resolve({ code: null, signal: null }));
    });

    if (!child.stdout) {
      finish('failed', new Error('codex child process has no stdout'));
      return {
        ok: true,
        run: {
          id: runId,
          windowId: window.id,
          status: run.status,
          startedAt: run.startedAt,
          threadId: window.threadId || run.threadId || '',
        },
        window,
      };
    }

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

    (async () => {
      try {
        if (!child.stdin) throw new Error('codex child process has no stdin');
        child.stdin.write(input);
        child.stdin.end();

        for await (const line of rl) {
          const text = String(line ?? '');
          if (!text) continue;
          try {
            const evt = JSON.parse(text);
            if (evt?.type === 'thread.started' && typeof evt.thread_id === 'string') {
              window.threadId = evt.thread_id;
              window.updatedAt = nowIso();
              scheduleStateWrite();
            }
            if (
              (evt?.type === 'item.started' || evt?.type === 'item.updated' || evt?.type === 'item.completed') &&
              evt?.item?.type === 'todo_list'
            ) {
              const hasExplicitList = Array.isArray(evt?.item?.items);
              const items = normalizeTodoItems(hasExplicitList ? evt?.item?.items : evt?.item);
              if (items.length || hasExplicitList) {
                const updatedAt = nowIso();
                run.todoList = items;
                run.todoListId = typeof evt.item.id === 'string' ? evt.item.id : '';
                run.todoListUpdatedAt = updatedAt;
                window.todoList = items;
                window.todoListId = run.todoListId;
                window.todoListUpdatedAt = updatedAt;
                window.updatedAt = updatedAt;
                scheduleStateWrite();
              }
            }
            pushRunEvent(run, { source: 'codex', event: evt });
          } catch (e) {
            pushRunEvent(run, {
              source: 'raw',
              text,
              error: { message: e?.message || String(e) },
            });
          }
        }

        const { code, signal } = await exitPromise;
        if (spawnError) throw spawnError;
        if (abortController.signal.aborted) {
          finish('aborted', null);
        } else if (signal) {
          finish('failed', new Error(`codex exited with signal ${signal}`));
        } else if (code !== 0) {
          finish('failed', new Error(`codex exited with code ${code}`));
        } else {
          finish('completed', null);
        }
      } catch (e) {
        if (abortController.signal.aborted) finish('aborted', null);
        else finish('failed', e);
      } finally {
        try {
          rl.close();
        } catch {
          // ignore
        }
        try {
          child.removeAllListeners();
        } catch {
          // ignore
        }
        try {
          if (!child.killed) child.kill();
        } catch {
          // ignore
        }
      }
    })();

    return {
      ok: true,
      run: {
        id: runId,
        windowId: window.id,
        status: run.status,
        startedAt: run.startedAt,
        threadId: window.threadId || run.threadId || '',
      },
      window,
    };
  };

  const dispose = async () => {
    store.refCount = Math.max(0, Number.isFinite(store.refCount) ? store.refCount - 1 : 0);
    if (store.refCount > 0) return;

    const toAbort = [];
    for (const run of runs.values()) {
      if (run.status === 'running' || run.status === 'aborting') toAbort.push(run);
    }
    for (const run of toAbort) {
      await abortRun(run);
    }

    try {
      if (store.stateWriteTimer) {
        clearTimeout(store.stateWriteTimer);
        store.stateWriteTimer = null;
      }
    } catch {
      // ignore
    }
    try {
      if (stateFile) writeJsonFileAtomic(stateFile, buildSharedState());
    } catch {
      // ignore
    }
  };

  if (!store.restored) {
    restoreState();
    store.restored = true;
    scheduleStateWrite();
  }

  return {
    methods: {
      async ping(params, runtimeCtx) {
        return {
          ok: true,
          now: nowIso(),
          pluginId: runtimeCtx?.pluginId || ctx?.pluginId || '',
          params: params ?? null,
        };
      },

      async llmComplete(params, runtimeCtx) {
        return await llmComplete(params, runtimeCtx);
      },

      async codexGetEnv(_params, runtimeCtx) {
        const cwd = process.cwd();
        const sessionRoot = ctx?.sessionRoot || '';
        return {
          ok: true,
          now: nowIso(),
          pluginId: runtimeCtx?.pluginId || ctx?.pluginId || '',
          sessionRoot,
          sessionRootGitRoot: sessionRoot ? findGitRepoRoot(sessionRoot) : '',
          cwd,
          cwdGitRoot: cwd ? findGitRepoRoot(cwd) : '',
          dataDir: ctx?.dataDir || '',
          platform: process.platform,
          node: process.version,
        };
      },

      async codexPickDirectory(params) {
        return await pickDirectory({
          title: params?.title,
          defaultPath: params?.defaultPath,
        });
      },

      async codexGetGitInfo(params) {
        const cwd = normalizeString(params?.cwd);
        if (!cwd) throw new Error('cwd is required');
        const gitRoot = findGitRepoRoot(cwd);
        return {
          ok: true,
          cwd,
          gitRoot,
          isGitRepo: Boolean(gitRoot),
        };
      },

      async codexListWindows() {
        syncRequests();
        scheduleStateWrite();
        return {
          ok: true,
          windows: Array.from(windows.values()),
        };
      },

      async codexGetWindowTasks(params) {
        syncRequests();
        const window = getWindow(params?.windowId);
        return {
          ok: true,
          windowId: window.id,
          todoList: Array.isArray(window.todoList) ? window.todoList : [],
          todoListId: window.todoListId || '',
          updatedAt: window.todoListUpdatedAt || '',
        };
      },

      async codexGetWindowInputs(params) {
        syncRequests();
        const window = getWindow(params?.windowId);
        const entry = windowInputs.get(window.id) || { items: [], updatedAt: '' };
        return {
          ok: true,
          windowId: window.id,
          items: Array.isArray(entry.items) ? entry.items : [],
          updatedAt: entry.updatedAt || '',
        };
      },

      async codexAppendWindowInput(params) {
        syncRequests();
        const window = getWindow(params?.windowId);
        const text = normalizeString(params?.text);
        if (!text) throw new Error('text is required');
        const entry = appendWindowInput(window.id, text);
        return {
          ok: true,
          windowId: window.id,
          items: Array.isArray(entry?.items) ? entry.items : [],
          updatedAt: entry?.updatedAt || '',
        };
      },

      async codexClearWindowInputs(params) {
        syncRequests();
        const window = getWindow(params?.windowId);
        windowInputs.set(window.id, { items: [], updatedAt: nowIso() });
        scheduleStateWrite();
        return { ok: true, windowId: window.id };
      },

      async codexCreateWindow(params) {
        syncRequests();
        const window = createWindow({ name: params?.name });
        return { ok: true, window };
      },

      async codexResumeWindow(params) {
        syncRequests();
        const threadId = normalizeString(params?.threadId);
        if (!threadId) throw new Error('threadId is required');
        const window = createWindow({ name: params?.name, threadId });
        return { ok: true, window };
      },

      async codexRenameWindow(params) {
        const window = getWindow(params?.windowId);
        const name = normalizeString(params?.name);
        if (!name) throw new Error('name is required');
        window.name = name;
        window.updatedAt = nowIso();
        scheduleStateWrite();
        return { ok: true, window };
      },

      async codexCloseWindow(params) {
        const window = getWindow(params?.windowId);
        if (window.activeRunId) {
          const run = runs.get(window.activeRunId);
          if (run) await abortRun(run);
        }
        windows.delete(window.id);
        windowLogs.delete(window.id);
        windowInputs.delete(window.id);
        scheduleStateWrite();
        return { ok: true };
      },

      async codexGetWindowLogs(params) {
        const window = getWindow(params?.windowId);
        const limit = clampNumber(Number(params?.limit ?? 2000), 1, 50000);
        const offsetRaw = Number(params?.offset);
        const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.floor(offsetRaw)) : null;

        const entry = windowLogs.get(window.id) || { events: [], lines: [], updatedAt: '' };
        const events = Array.isArray(entry.events) ? entry.events : [];
        const lines = Array.isArray(entry.lines) ? entry.lines : [];
        const useEvents = events.length > 0;
        const list = useEvents ? events : lines;
        const total = list.length;
        const start = offset !== null ? Math.min(offset, total) : Math.max(0, total - limit);
        const slice = list.slice(start, Math.min(start + limit, total));
        const nextOffset = start + slice.length < total ? start + slice.length : null;

        return {
          ok: true,
          windowId: window.id,
          status: window.status,
          activeRunId: window.activeRunId,
          total,
          start,
          count: slice.length,
          nextOffset,
          updatedAt: entry.updatedAt || '',
          ...(useEvents ? { events: slice } : { lines: slice }),
        };
      },

      async codexClearWindowLogs(params) {
        const window = getWindow(params?.windowId);
        windowLogs.set(window.id, { events: [], lines: [], updatedAt: nowIso() });
        scheduleStateWrite();
        return { ok: true, windowId: window.id };
      },

      async codexRun(params, runtimeCtx) {
        syncRequests();
        return await startRun(params, runtimeCtx);
      },

      async codexAbort(params) {
        const runId = normalizeString(params?.runId);
        const windowId = normalizeString(params?.windowId);
        if (runId) {
          const run = getRun(runId);
          return await abortRun(run);
        }
        if (windowId) {
          const window = getWindow(windowId);
          if (!window.activeRunId) return { ok: true };
          const run = runs.get(window.activeRunId);
          if (!run) return { ok: true };
          return await abortRun(run);
        }
        throw new Error('runId or windowId is required');
      },

      async codexPollRun(params) {
        const run = getRun(params?.runId);
        const cursor = Number.isFinite(params?.cursor) ? Number(params.cursor) : 0;
        const normalizedCursor = cursor < 0 ? 0 : cursor;

        const earliestSeq = run.events[0]?.seq ?? run.nextSeq ?? 0;
        let startIndex = 0;
        if (normalizedCursor > earliestSeq) {
          startIndex = run.events.findIndex((evt) => Number(evt?.seq) >= normalizedCursor);
          if (startIndex < 0) startIndex = run.events.length;
        }

        const events = run.events.slice(startIndex);
        const nextCursor = events.length ? Number(events[events.length - 1]?.seq ?? normalizedCursor) + 1 : normalizedCursor;
        const done = run.status !== 'running' && run.status !== 'aborting' && nextCursor >= (run.nextSeq ?? 0);
        return {
          ok: true,
          run: {
            id: run.id,
            windowId: run.windowId,
            status: run.status,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
            error: run.error,
          },
          events,
          nextCursor,
          done,
          gap: normalizedCursor < earliestSeq ? { from: normalizedCursor, to: earliestSeq } : null,
          droppedEvents: run.droppedEvents || 0,
        };
      },
    },
    async dispose() {
      await dispose();
    },
  };
}
