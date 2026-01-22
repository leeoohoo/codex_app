import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';

import {
  MAX_EVENT_TEXT_CHARS,
  MAX_RUN_EVENTS,
  STATE_VERSION,
} from './lib/constants.mjs';
import { buildCodexExecArgs, buildWindowsCommandArgs } from './lib/codex.mjs';
import { pickDirectory } from './lib/dialog.mjs';
import { readJsonFile, writeJsonFileAtomic } from './lib/files.mjs';
import {
  MCP_TASK_QUEUE_TIMEOUT_MS,
  MCP_TASK_TIMEOUT_MS,
  createMcpTaskManager,
  normalizeMcpTaskStatus,
} from './lib/mcp-tasks.mjs';
import { findGitRepoRoot, resolveTaskkillPath } from './lib/paths.mjs';
import { extractMarkdownContentFromEvent, storePlanMarkdown } from './lib/plan-markdown.mjs';
import { normalizeRequests } from './lib/requests.mjs';
import { mergeRunOptions, normalizeRunOptions } from './lib/run-options.mjs';
import { createStateStore } from './lib/state-store.mjs';
import { getOrCreateBackendStore } from './lib/store.mjs';
import { normalizeTodoItems } from './lib/todo.mjs';
import { clampNumber, makeId, normalizeString, nowIso } from './lib/utils.mjs';

const parseWindowTime = (win) => {
  const updated = Date.parse(win?.updatedAt || '') || 0;
  if (updated) return updated;
  return Date.parse(win?.createdAt || '') || 0;
};

const sortWindowsByRecent = (windowsList) =>
  Array.isArray(windowsList) ? windowsList.slice().sort((a, b) => parseWindowTime(b) - parseWindowTime(a)) : [];

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

const findWindowByWorkingDirectory = (windowsMap, workingDirectory, { includeRunning = false } = {}) => {
  const needle = normalizePath(workingDirectory);
  if (!needle) return null;
  const list = windowsMap instanceof Map ? Array.from(windowsMap.values()) : Array.isArray(windowsMap) ? windowsMap : [];
  const sorted = sortWindowsByRecent(list);
  return (
    sorted.find((win) => {
      if (!includeRunning && isRunningStatus(win?.status)) return false;
      const workdir = getWindowWorkingDirectory(win);
      return workdir && workdir === needle;
    }) || null
  );
};

const RUN_TIMEOUT_MS = MCP_TASK_TIMEOUT_MS;
const RUN_TIMEOUT_GRACE_MS = 30 * 1000;
const MCP_TASK_MONITOR_INTERVAL_MS = 60 * 1000;
const RUN_ABORT_FORCE_MS = 5 * 1000;

const logTaskEvent = (message, details) => {
  try {
    const payload = details ? ` ${JSON.stringify(details)}` : '';
    console.error(`[codex_app][mcp-task] ${message}${payload}`);
  } catch {
    // ignore
  }
};

const logAbortEvent = (message, details) => {
  try {
    const payload = details ? ` ${JSON.stringify(details)}` : '';
    console.error(`[codex_app][abort] ${message}${payload}`);
  } catch {
    // ignore
  }
};


export async function createUiAppsBackend(ctx) {
  const store = getOrCreateBackendStore(ctx);
  store.refCount = Number.isFinite(store.refCount) ? store.refCount + 1 : 1;

  if (!(store.windows instanceof Map)) store.windows = new Map();
  if (!(store.runs instanceof Map)) store.runs = new Map();
  if (!(store.windowLogs instanceof Map)) store.windowLogs = new Map();
  if (!(store.windowInputs instanceof Map)) store.windowInputs = new Map();
  if (!(store.mcpTasks instanceof Map)) store.mcpTasks = new Map();

  const windows = store.windows; // windowId -> { id, name, threadId, status, createdAt, updatedAt, activeRunId }
  const runs = store.runs; // runId -> { id, windowId, status, startedAt, finishedAt, events: [], error, abortController }
  const windowLogs = store.windowLogs; // windowId -> { events: object[], lines: string[], updatedAt }
  const windowInputs = store.windowInputs; // windowId -> { items: { ts, text }[], updatedAt }
  const mcpTasks = store.mcpTasks; // requestId -> task

  const stateDir = store.stateDir || '';
  const stateFile = store.stateFile || '';
  const requestsFile = store.requestsFile || '';

  const { appendWindowInput, appendWindowLog, buildSharedState, restoreState, scheduleStateWrite } =
    createStateStore({
      store,
      stateFile,
      windows,
      runs,
      windowLogs,
      windowInputs,
      mcpTasks,
    });

  const {
    registerMcpTask,
    markMcpTaskRunning,
    markMcpTaskFinished,
    applyMcpTaskResult,
    writeMcpTaskResultPrompt,
    checkTaskTimeouts: checkTaskTimeoutsWithState,
  } = createMcpTaskManager({
    ctx,
    mcpTasks,
    stateDir,
    stateFile,
    scheduleStateWrite,
  });

  const primeMcpTasksFromRequests = (requests) => {
    const startRuns = Array.isArray(requests?.startRuns) ? requests.startRuns : [];
    for (const req of startRuns) {
      const id = normalizeString(req?.id);
      if (!id) continue;
      registerMcpTask(req);
    }
  };

  const cleanupStartRunsForTasks = (startRuns) => {
    const list = Array.isArray(startRuns) ? startRuns : [];
    return list.filter((entry) => {
      const id = normalizeString(entry?.id);
      if (!id) return true;
      const task = mcpTasks.get(id);
      if (!task) return true;
      const status = normalizeMcpTaskStatus(task.status);
      return status === 'queued';
    });
  };

  const reconcileRunningTasks = () => {
    let updated = false;
    for (const task of mcpTasks.values()) {
      const status = normalizeMcpTaskStatus(task.status);
      if (status !== 'running') continue;
      const runId = normalizeString(task.runId);
      const run = runId ? runs.get(runId) : null;
      if (run) {
        const runStatus = normalizeString(run.status);
        if (!isRunningStatus(runStatus)) {
          const updatedTask = markMcpTaskFinished(task.id, runStatus, run.error);
          if (updatedTask) {
            applyMcpTaskResult(updatedTask, run);
            writeMcpTaskResultPrompt(updatedTask, run);
          }
          updated = true;
        }
        continue;
      }
      const message = 'task failed: run missing';
      task.status = 'failed';
      task.finishedAt = nowIso();
      task.error = { message };
      task.resultStatus = 'failed';
      task.resultText = task.resultText || message;
      task.resultAt = task.resultAt || nowIso();
      updated = true;
      logTaskEvent('running task missing run', { taskId: task.id, runId });
    }
    return updated;
  };

  const monitorMcpTasksAndRuns = async ({ source = 'sync', requests, applyRequestCleanup = false, primeTasks = false } = {}) => {
    if (requests && primeTasks) {
      primeMcpTasksFromRequests(requests);
    }

    const nowMs = Date.now();
    const { timedOut } = checkTaskTimeoutsWithState({
      nowMs,
      runningTimeoutMs: MCP_TASK_TIMEOUT_MS,
      queuedTimeoutMs: MCP_TASK_QUEUE_TIMEOUT_MS,
    });

    if (timedOut.length) {
      for (const entry of timedOut) {
        const runId = normalizeString(entry.runId);
        if (!runId) continue;
        const run = runs.get(runId);
        if (!run || !isRunningStatus(run.status)) continue;
        logTaskEvent('task timeout: aborting run', { source, taskId: entry.id, runId });
        abortRun(run).catch(() => {
          // ignore
        });
      }
    }

    let updated = timedOut.length > 0;
    if (reconcileRunningTasks()) updated = true;

    if (RUN_TIMEOUT_MS) {
      for (const run of runs.values()) {
        if (!isRunningStatus(run.status)) continue;
        const startedAtMs = Date.parse(run.startedAt || '') || 0;
        if (!startedAtMs) continue;
        if (nowMs - startedAtMs <= RUN_TIMEOUT_MS) continue;
        logTaskEvent('run timeout: aborting', { source, runId: run.id, windowId: run.windowId });
        abortRun(run).catch(() => {
          // ignore
        });
      }
    }

    if (updated) scheduleStateWrite();

    if (applyRequestCleanup && requestsFile) {
      const normalized = requests ? normalizeRequests(requests) : normalizeRequests(readJsonFile(requestsFile));
      const cleanedStartRuns = cleanupStartRunsForTasks(normalized.startRuns);
      if (cleanedStartRuns.length !== normalized.startRuns.length) {
        writeJsonFileAtomic(requestsFile, {
          ...normalized,
          version: STATE_VERSION,
          createWindows: Array.isArray(normalized.createWindows) ? normalized.createWindows : [],
          startRuns: cleanedStartRuns,
        });
      }
      return { cleanedStartRuns };
    }

    if (requests) {
      return { cleanedStartRuns: cleanupStartRunsForTasks(requests.startRuns) };
    }

    return { cleanedStartRuns: [] };
  };

  const syncRequests = async (runtimeCtx) => {
    if (!requestsFile) return;
    const requests = normalizeRequests(readJsonFile(requestsFile));
    await monitorMcpTasksAndRuns({ source: 'syncRequests', requests });
    const createWindows = requests.createWindows;
    const startRuns = cleanupStartRunsForTasks(requests.startRuns);
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
      const resolvedDefaults = { ...defaults };
      if (!resolvedDefaults.workingDirectory && options.workingDirectory) {
        resolvedDefaults.workingDirectory = options.workingDirectory;
      }
      if (!resolvedDefaults.sandboxMode && options.sandboxMode) {
        resolvedDefaults.sandboxMode = options.sandboxMode;
      }
      const lookupWorkingDirectory = resolvedDefaults.workingDirectory || options.workingDirectory;
      const threadId = normalizeString(req?.threadId);
      const codexCommand = normalizeString(req?.codexCommand) || 'codex';

      let window = windowId ? windows.get(windowId) : null;
      if (!window && lookupWorkingDirectory) {
        window = findWindowByWorkingDirectory(windows, lookupWorkingDirectory, { includeRunning: true });
        if (window && task) {
          task.windowId = window.id;
          scheduleStateWrite();
        }
      }
      if (!window && ensureWindow) {
        if (!resolvedDefaults.workingDirectory || !resolvedDefaults.sandboxMode) {
          pendingRuns.push(req);
          continue;
        }
        window = createWindow({
          id: windowId || makeId(),
          name: windowName,
          threadId,
          defaults: resolvedDefaults,
          source: 'mcp',
        });
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

  const parseRunTime = (run) => {
    const started = Date.parse(run?.startedAt || '') || 0;
    if (started) return started;
    return Date.parse(run?.finishedAt || '') || 0;
  };

  const getRunningRunsForWindow = (windowId) => {
    const id = normalizeString(windowId);
    if (!id) return [];
    const list = [];
    for (const run of runs.values()) {
      if (run.windowId !== id) continue;
      if (!isRunningStatus(run.status)) continue;
      list.push(run);
    }
    list.sort((a, b) => parseRunTime(b) - parseRunTime(a));
    return list;
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
    if (!run || (run.status !== 'running' && run.status !== 'aborting')) return { ok: true, aborted: false };
    if (run.status !== 'aborting') run.status = 'aborting';
    logAbortEvent('abort requested', { runId: run.id, windowId: run.windowId, status: run.status });
    try {
      run.abortController?.abort();
    } catch {
      // ignore
    }
    const childPid = Number.isFinite(run.childPid) && run.childPid > 0 ? run.childPid : run.child?.pid || 0;
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
    if (childPid) {
      if (process.platform === 'win32') {
        try {
          const killer = spawn(resolveTaskkillPath(), ['/pid', String(childPid), '/t', '/f'], {
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
          process.kill(childPid, 'SIGTERM');
        } catch {
          // ignore
        }
        setTimeout(() => {
          try {
            process.kill(childPid, 'SIGKILL');
          } catch {
            // ignore
          }
        }, 1500);
      }
    }
    if (!run.abortForceTimer) {
      run.abortForceTimer = setTimeout(() => {
        if (run.finishedAt) return;
        logAbortEvent('abort force kill', { runId: run.id, windowId: run.windowId, pid: childPid });
        if (process.platform === 'win32' && childPid) {
          try {
            const killer = spawn(resolveTaskkillPath(), ['/pid', String(childPid), '/t', '/f'], {
              windowsHide: true,
              env: process.env,
            });
            killer.once('error', () => {
              // ignore
            });
          } catch {
            // ignore
          }
        }
        try {
          if (run.child?.kill) run.child.kill('SIGKILL');
        } catch {
          // ignore
        }
        if (childPid && process.platform !== 'win32') {
          try {
            process.kill(childPid, 'SIGKILL');
          } catch {
            // ignore
          }
        }
      }, RUN_ABORT_FORCE_MS);
    }
    pushRunEvent(run, { source: 'system', kind: 'status', status: 'aborting' });
    return { ok: true, aborted: true };
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
    const startedAtMs = Date.now();
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
        planMarkdown: '',
        planMarkdownPath: '',
        child: null,
      };
      runs.set(runId, run);

    if (RUN_TIMEOUT_MS) {
      run.timeoutTimer = setTimeout(() => {
        if (run.finishedAt) return;
        const elapsedMs = Date.now() - startedAtMs;
        const elapsedMinutes = Math.max(1, Math.round(elapsedMs / 60000));
        const message = `codex run timed out after ${elapsedMinutes}m`;
        pushRunEvent(run, { source: 'system', kind: 'error', error: { message } });
        abortRun(run).catch(() => {
          // ignore
        });
        run.timeoutFinalizeTimer = setTimeout(() => {
          if (run.finishedAt) return;
          finish('failed', new Error(message));
        }, RUN_TIMEOUT_GRACE_MS);
      }, RUN_TIMEOUT_MS);
    }

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
      if (run.timeoutTimer) {
        clearTimeout(run.timeoutTimer);
        run.timeoutTimer = null;
      }
      if (run.timeoutFinalizeTimer) {
        clearTimeout(run.timeoutFinalizeTimer);
        run.timeoutFinalizeTimer = null;
      }
      if (run.abortForceTimer) {
        clearTimeout(run.abortForceTimer);
        run.abortForceTimer = null;
      }
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
        if (task) {
          applyMcpTaskResult(task, run);
          writeMcpTaskResultPrompt(task, run);
        }
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
            const planCapture = extractMarkdownContentFromEvent(evt, run?.options?.workingDirectory);
            if (planCapture.content) {
              storePlanMarkdown(run, planCapture.content, planCapture.path);
            }
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
      if (store.mcpMonitorTimer) {
        clearInterval(store.mcpMonitorTimer);
        store.mcpMonitorTimer = null;
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
  if (!store.mcpMonitorTimer) {
    store.mcpMonitorTimer = setInterval(() => {
      monitorMcpTasksAndRuns({ source: 'interval', applyRequestCleanup: true, primeTasks: true }).catch(() => {
        // ignore
      });
    }, MCP_TASK_MONITOR_INTERVAL_MS);
  }
  monitorMcpTasksAndRuns({ source: 'startup', applyRequestCleanup: true, primeTasks: true }).catch(() => {
    // ignore
  });

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

      async codexDeleteMcpTask(params) {
        const id = normalizeString(params?.taskId);
        if (!id) throw new Error('taskId is required');
        const task = mcpTasks.get(id);
        if (!task) return { ok: true, taskId: id, removed: false };
        const force = params?.force === true || params?.force === 'true';
        const status = normalizeMcpTaskStatus(task.status);
        if (status === 'running') {
          const runId = normalizeString(task.runId);
          const run = runId ? runs.get(runId) : null;
          logTaskEvent('delete running task: aborting run', { taskId: id, runId, force });
          if (run) {
            try {
              await abortRun(run);
            } catch {
              // ignore
            }
          } else {
            logTaskEvent('delete running task: run not found', { taskId: id, runId, force });
          }
          if (!force) {
            return { ok: true, taskId: id, removed: false, running: true };
          }
        }
        logTaskEvent('delete task', { taskId: id, status, force });
        mcpTasks.delete(id);

        if (requestsFile) {
          const requests = normalizeRequests(readJsonFile(requestsFile));
          const startRuns = Array.isArray(requests.startRuns) ? requests.startRuns : [];
          const filtered = startRuns.filter((entry) => normalizeString(entry?.id) !== id);
          writeJsonFileAtomic(requestsFile, {
            ...requests,
            version: STATE_VERSION,
            createWindows: Array.isArray(requests.createWindows) ? requests.createWindows : [],
            startRuns: filtered,
          });
        }

        scheduleStateWrite();
        return { ok: true, taskId: id, removed: true };
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
          const run = runs.get(runId);
          if (run) {
            const res = await abortRun(run);
            return { ok: true, runId: run.id, windowId: run.windowId, aborted: Boolean(res?.aborted) };
          }
          logAbortEvent('abort requested but run not found', { runId, windowId });
          if (!windowId) throw new Error(`run not found: ${runId}`);
        }
        if (windowId) {
          const window = getWindow(windowId);
          const activeRun = window.activeRunId ? runs.get(window.activeRunId) : null;
          const activeIsRunning = activeRun && isRunningStatus(activeRun.status);
          const candidates = activeIsRunning ? [activeRun] : getRunningRunsForWindow(windowId);
          if (!candidates.length) {
            logAbortEvent('abort requested but no running run', { windowId });
            return { ok: true, windowId, aborted: false };
          }
          for (const run of candidates) {
            await abortRun(run);
          }
          return {
            ok: true,
            windowId,
            runId: candidates[0]?.id || '',
            aborted: true,
            count: candidates.length,
          };
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

