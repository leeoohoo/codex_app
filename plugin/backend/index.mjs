import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';

import {
  MAX_EVENT_TEXT_CHARS,
  MAX_MCP_TASKS,
  MAX_RUN_EVENTS,
  MAX_WINDOW_INPUTS,
  STATE_VERSION,
  UI_PROMPTS_FILE_NAME,
} from './lib/constants.mjs';
import { buildCodexExecArgs, buildWindowsCommandArgs, pickAssistantMessage, truncateResultText } from './lib/codex.mjs';
import { pickDirectory } from './lib/dialog.mjs';
import { appendJsonlFile, readJsonFile, writeJsonFileAtomic } from './lib/files.mjs';
import { findGitRepoRoot, resolveTaskkillPath } from './lib/paths.mjs';
import { normalizeRequests } from './lib/requests.mjs';
import { getOrCreateBackendStore } from './lib/store.mjs';
import { normalizeTodoItems } from './lib/todo.mjs';
import { clampNumber, makeId, normalizeBoolean, normalizeString, nowIso } from './lib/utils.mjs';


export async function createUiAppsBackend(ctx) {
  const store = getOrCreateBackendStore(ctx);
  store.refCount = Number.isFinite(store.refCount) ? store.refCount + 1 : 1;

  const windows = store.windows; // windowId -> { id, name, threadId, status, createdAt, updatedAt, activeRunId }
  const runs = store.runs; // runId -> { id, windowId, status, startedAt, finishedAt, events: [], error, abortController }
  const windowLogs = store.windowLogs; // windowId -> { events: object[], lines: string[], updatedAt }
  const windowInputs = store.windowInputs; // windowId -> { items: { ts, text }[], updatedAt }
  const mcpTasks = store.mcpTasks; // requestId -> task

  const stateDir = store.stateDir || '';
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

  const normalizeMcpTaskStatus = (value) => {
    const status = normalizeString(value).toLowerCase();
    if (status === 'running' || status === 'completed' || status === 'failed' || status === 'aborted') return status;
    return 'queued';
  };

  const normalizeMcpTask = (raw) => {
    if (!raw || typeof raw !== 'object') return null;
    const id = normalizeString(raw.id);
    if (!id) return null;
    return {
      id,
      source: normalizeString(raw.source) || 'mcp',
      status: normalizeMcpTaskStatus(raw.status),
      input: normalizeString(raw.input),
      workingDirectory: normalizeString(raw.workingDirectory),
      windowId: normalizeString(raw.windowId),
      runId: normalizeString(raw.runId),
      createdAt: normalizeString(raw.createdAt),
      startedAt: normalizeString(raw.startedAt),
      finishedAt: normalizeString(raw.finishedAt),
      error: raw?.error && typeof raw.error === 'object' ? { message: normalizeString(raw.error.message) } : null,
      promptRequestId: normalizeString(raw.promptRequestId),
      promptSentAt: normalizeString(raw.promptSentAt),
      resultText: normalizeString(raw.resultText),
      resultStatus: normalizeMcpTaskStatus(raw.resultStatus),
      resultAt: normalizeString(raw.resultAt),
    };
  };

  const pruneMcpTasks = () => {
    if (mcpTasks.size <= MAX_MCP_TASKS) return;
    const list = Array.from(mcpTasks.values());
    list.sort((a, b) => {
      const aTs = Date.parse(a.createdAt || '') || 0;
      const bTs = Date.parse(b.createdAt || '') || 0;
      return aTs - bTs;
    });
    const removable = list.filter((item) => item.status === 'completed' || item.status === 'failed' || item.status === 'aborted');
    const drop = [];
    for (const item of removable) {
      if (mcpTasks.size - drop.length <= MAX_MCP_TASKS) break;
      drop.push(item.id);
    }
    for (const id of drop) mcpTasks.delete(id);
    if (mcpTasks.size <= MAX_MCP_TASKS) return;
    const still = Array.from(mcpTasks.values()).sort((a, b) => {
      const aTs = Date.parse(a.createdAt || '') || 0;
      const bTs = Date.parse(b.createdAt || '') || 0;
      return aTs - bTs;
    });
    for (const item of still) {
      if (mcpTasks.size <= MAX_MCP_TASKS) break;
      mcpTasks.delete(item.id);
    }
  };

  const registerMcpTask = (req) => {
    const source = normalizeString(req?.source);
    if (source && source !== 'mcp') return null;
    const id = normalizeString(req?.id);
    if (!id) return null;
    const existing = mcpTasks.get(id);
    if (existing) {
      if (!existing.input) existing.input = normalizeString(req?.input ?? req?.prompt);
      if (!existing.workingDirectory) {
        existing.workingDirectory = normalizeString(req?.options?.workingDirectory || req?.defaults?.workingDirectory);
      }
      if (!existing.windowId) existing.windowId = normalizeString(req?.windowId);
      if (!existing.createdAt) existing.createdAt = normalizeString(req?.createdAt) || nowIso();
      existing.source = existing.source || 'mcp';
      return existing;
    }

    const task = {
      id,
      source: 'mcp',
      status: 'queued',
      input: normalizeString(req?.input ?? req?.prompt),
      workingDirectory: normalizeString(req?.options?.workingDirectory || req?.defaults?.workingDirectory),
      windowId: normalizeString(req?.windowId),
      runId: '',
      createdAt: normalizeString(req?.createdAt) || nowIso(),
      startedAt: '',
      finishedAt: '',
      error: null,
      promptRequestId: `mcp-task:${id}`,
      promptSentAt: '',
    };
    mcpTasks.set(id, task);
    pruneMcpTasks();
    scheduleStateWrite();
    return task;
  };

  const markMcpTaskRunning = (taskId, runId, windowId) => {
    if (!taskId) return null;
    const task = mcpTasks.get(taskId);
    if (!task) return null;
    task.status = 'running';
    task.runId = normalizeString(runId);
    task.windowId = normalizeString(windowId) || task.windowId;
    if (!task.startedAt) task.startedAt = nowIso();
    task.error = null;
    scheduleStateWrite();
    return task;
  };

  const markMcpTaskFinished = (taskId, status, error) => {
    if (!taskId) return null;
    const task = mcpTasks.get(taskId);
    if (!task) return null;
    task.status = normalizeMcpTaskStatus(status);
    task.finishedAt = nowIso();
    if (error) {
      task.error = { message: normalizeString(error?.message || String(error)) };
    }
    scheduleStateWrite();
    return task;
  };

  const applyMcpTaskResult = (task, run) => {
    if (!task) return;
    task.resultStatus = normalizeMcpTaskStatus(run?.status || task.status);
    task.resultText = truncateResultText(pickAssistantMessage(run));
    task.resultAt = nowIso();
    scheduleStateWrite();
  };

  const writeMcpTaskResultPrompt = (task, run) => {
    if (!task || task.promptSentAt) return;
    const runStatus = normalizeMcpTaskStatus(run?.status || task.status);
    const statusLabel =
      runStatus === 'completed'
        ? '完成'
        : runStatus === 'failed'
          ? '失败'
          : runStatus === 'aborted'
            ? '已中止'
            : runStatus;
    const parts = [];
    if (task.input) parts.push(`**任务**：${task.input}`);
    if (task.workingDirectory) parts.push(`**目录**：\`${task.workingDirectory}\``);
    if (task.windowId) parts.push(`**窗口**：\`${task.windowId}\``);
    if (runStatus) parts.push(`**状态**：${statusLabel}`);
    const outputText = truncateResultText(pickAssistantMessage(run));
    if (outputText) parts.push(`**输出**：\n\n${outputText}`);
    const errorMessage = task.error?.message || run?.error?.message;
    if (errorMessage) parts.push(`**错误**：${errorMessage}`);
    const markdown = parts.length ? parts.join('\n\n') : '😊';

    const pluginId = normalizeString(run?.pluginId || ctx?.pluginId);
    const appId = normalizeString(run?.appId || ctx?.appId || 'codex_app');
    const source = pluginId ? (appId ? `${pluginId}:${appId}` : pluginId) : '';
    const requestId = task.promptRequestId || `mcp-task:${task.id}`;
    const entry = {
      ts: nowIso(),
      type: 'ui_prompt',
      action: 'request',
      requestId,
      runId: normalizeString(run?.id || task.runId) || undefined,
      prompt: {
        kind: 'result',
        title: '执行结果',
        message: runStatus === 'completed' ? '任务已完成 😊' : `任务${statusLabel} 😊`,
        ...(source ? { source } : {}),
        allowCancel: true,
        markdown,
      },
    };
    const promptRoot = stateDir || (stateFile ? path.dirname(stateFile) : '');
    const promptFile = promptRoot ? path.join(promptRoot, UI_PROMPTS_FILE_NAME) : '';
    appendJsonlFile(promptFile, entry);
    task.promptSentAt = nowIso();
    task.promptRequestId = requestId;
    scheduleStateWrite();
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

  const restoreMcpTasksFromState = (snapshot) => {
    const list = Array.isArray(snapshot?.mcpTasks) ? snapshot.mcpTasks : [];
    for (const raw of list) {
      const task = normalizeMcpTask(raw);
      if (!task) continue;
      mcpTasks.set(task.id, task);
    }
    pruneMcpTasks();
  };

  const restoreState = () => {
    const snapshot = loadStateFile();
    if (!snapshot) return;
    restoreWindowsFromState(snapshot);
    restoreWindowLogsFromState(snapshot);
    restoreWindowInputsFromState(snapshot);
    restoreMcpTasksFromState(snapshot);
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

  const syncRequests = async (runtimeCtx) => {
    if (!requestsFile) return;
    const requests = normalizeRequests(readJsonFile(requestsFile));
    const createWindows = requests.createWindows;
    const startRuns = requests.startRuns;
    if (!createWindows.length && !startRuns.length) return;

    const pendingWindows = [];
    for (const req of createWindows) {
      const reqId = normalizeString(req?.id);
      const id = reqId || makeId();
      const defaults = normalizeRunOptions(req?.defaults || {});
      if (!defaults.workingDirectory || !defaults.sandboxMode) {
        pendingWindows.push(req);
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

    const pendingRuns = [];
    for (const req of startRuns) {
      const input = normalizeString(req?.input ?? req?.prompt);
      if (!input) continue;

      const task = registerMcpTask(req);
      const ensureWindow = req?.ensureWindow === undefined ? true : Boolean(req.ensureWindow);
      const windowId = normalizeString(req?.windowId);
      const windowName = normalizeString(req?.windowName);
      const options = normalizeRunOptions(req?.options || {});
      const defaults = normalizeRunOptions(req?.defaults || {});
      const threadId = normalizeString(req?.threadId);
      const codexCommand = normalizeString(req?.codexCommand) || 'codex';

      let window = windowId ? windows.get(windowId) : null;
      if (!window && ensureWindow) {
        if (!defaults.workingDirectory || !defaults.sandboxMode) {
          pendingRuns.push(req);
          continue;
        }
        window = createWindow({ id: windowId || makeId(), name: windowName, threadId, defaults, source: 'mcp' });
      }

      if (!window) {
        continue;
      }
      if (window.status === 'running' || window.status === 'aborting') {
        pendingRuns.push(req);
        if (task) {
          task.status = 'queued';
          task.windowId = window.id;
          scheduleStateWrite();
        }
        continue;
      }

      appendWindowInput(window.id, input);

      const started = await startRun(
        {
          windowId: window.id,
          input,
          codexCommand,
          options,
          threadId,
          mcpTaskId: task?.id || '',
        },
        runtimeCtx,
      );
      if (task && started?.run?.id) {
        markMcpTaskRunning(task.id, started.run.id, window.id);
      }
    }

    writeJsonFileAtomic(requestsFile, {
      ...requests,
      version: STATE_VERSION,
      createWindows: pendingWindows,
      startRuns: pendingRuns,
    });
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
    const mcpTaskId = normalizeString(params?.mcpTaskId);

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
      appId: runtimeCtx?.appId || ctx?.appId || 'codex_app',
      mcpTaskId,
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
      if (run.mcpTaskId) {
        const task = markMcpTaskFinished(run.mcpTaskId, status, run.error);
        if (task) applyMcpTaskResult(task, run);
      }
      if (requestsFile) {
        setTimeout(() => {
          syncRequests(runtimeCtx).catch(() => {
            // ignore
          });
        }, 0);
      }
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

      async codexListWindows(_params, runtimeCtx) {
        await syncRequests(runtimeCtx);
        scheduleStateWrite();
        return {
          ok: true,
          windows: Array.from(windows.values()),
        };
      },

      async codexGetWindowTasks(params, runtimeCtx) {
        await syncRequests(runtimeCtx);
        const window = getWindow(params?.windowId);
        return {
          ok: true,
          windowId: window.id,
          todoList: Array.isArray(window.todoList) ? window.todoList : [],
          todoListId: window.todoListId || '',
          updatedAt: window.todoListUpdatedAt || '',
        };
      },

      async codexGetWindowInputs(params, runtimeCtx) {
        await syncRequests(runtimeCtx);
        const window = getWindow(params?.windowId);
        const entry = windowInputs.get(window.id) || { items: [], updatedAt: '' };
        return {
          ok: true,
          windowId: window.id,
          items: Array.isArray(entry.items) ? entry.items : [],
          updatedAt: entry.updatedAt || '',
        };
      },

      async codexListMcpTasks(_params, runtimeCtx) {
        await syncRequests(runtimeCtx);
        const list = Array.from(mcpTasks.values()).map((task) => {
          const win = task.windowId ? windows.get(task.windowId) : null;
          return {
            id: task.id,
            source: task.source || 'mcp',
            status: task.status,
            input: task.input,
            workingDirectory: task.workingDirectory,
            windowId: task.windowId,
            windowName: win?.name || '',
            windowStatus: win?.status || '',
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
          };
        });
        list.sort((a, b) => {
          const aTs = Date.parse(a.createdAt || '') || 0;
          const bTs = Date.parse(b.createdAt || '') || 0;
          return bTs - aTs;
        });
        return { ok: true, tasks: list };
      },

      async codexMarkMcpTaskPrompt(params) {
        const id = normalizeString(params?.taskId);
        if (!id) throw new Error('taskId is required');
        const task = mcpTasks.get(id);
        if (!task) throw new Error(`mcp task not found: ${id}`);
        const requestId = normalizeString(params?.requestId);
        if (requestId) task.promptRequestId = requestId;
        task.promptSentAt = nowIso();
        scheduleStateWrite();
        return { ok: true, taskId: id, requestId: task.promptRequestId };
      },

      async codexAppendWindowInput(params, runtimeCtx) {
        await syncRequests(runtimeCtx);
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

      async codexClearWindowInputs(params, runtimeCtx) {
        await syncRequests(runtimeCtx);
        const window = getWindow(params?.windowId);
        windowInputs.set(window.id, { items: [], updatedAt: nowIso() });
        scheduleStateWrite();
        return { ok: true, windowId: window.id };
      },

      async codexCreateWindow(params, runtimeCtx) {
        await syncRequests(runtimeCtx);
        const window = createWindow({ name: params?.name });
        return { ok: true, window };
      },

      async codexResumeWindow(params, runtimeCtx) {
        await syncRequests(runtimeCtx);
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
        await syncRequests(runtimeCtx);
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
