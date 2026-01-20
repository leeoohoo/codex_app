import { MAX_WINDOW_INPUTS, STATE_VERSION } from './constants.mjs';
import { readJsonFile, writeJsonFileAtomic } from './files.mjs';
import { normalizeMcpTask, pruneMcpTasks } from './mcp-tasks.mjs';
import { normalizeRunOptions, serializeRunOptions } from './run-options.mjs';
import { normalizeTodoItems } from './todo.mjs';
import { normalizeString, nowIso } from './utils.mjs';

export const createStateStore = ({ store, stateFile, windows, runs, windowLogs, windowInputs, mcpTasks }) => {
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

  const restoreMcpTasksFromState = (snapshot) => {
    const list = Array.isArray(snapshot?.mcpTasks) ? snapshot.mcpTasks : [];
    for (const raw of list) {
      const task = normalizeMcpTask(raw);
      if (!task) continue;
      mcpTasks.set(task.id, task);
    }
    pruneMcpTasks(mcpTasks);
  };

  const restoreState = () => {
    const snapshot = loadStateFile();
    if (!snapshot) return;
    restoreWindowsFromState(snapshot);
    restoreWindowLogsFromState(snapshot);
    restoreWindowInputsFromState(snapshot);
    restoreMcpTasksFromState(snapshot);
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

    const mcpTaskSnapshot = Array.from(mcpTasks.values()).map((task) => ({
      id: task.id,
      source: task.source || 'mcp',
      status: task.status,
      input: task.input,
      workingDirectory: task.workingDirectory,
      windowId: task.windowId,
      runId: task.runId,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      error: task.error,
      promptRequestId: task.promptRequestId,
      promptSentAt: task.promptSentAt,
      resultText: task.resultText,
      resultStatus: task.resultStatus,
      resultAt: task.resultAt,
    }));

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
      mcpTasks: mcpTaskSnapshot,
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

  return {
    appendWindowInput,
    appendWindowLog,
    buildSharedState,
    loadStateFile,
    restoreState,
    scheduleStateWrite,
  };
};
