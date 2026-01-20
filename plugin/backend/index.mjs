import { spawn } from 'node:child_process';
import readline from 'node:readline';

import {
  MAX_EVENT_TEXT_CHARS,
  MAX_RUN_EVENTS,
  STATE_VERSION,
} from './lib/constants.mjs';
import { buildCodexExecArgs, buildWindowsCommandArgs } from './lib/codex.mjs';
import { pickDirectory } from './lib/dialog.mjs';
import { readJsonFile, writeJsonFileAtomic } from './lib/files.mjs';
import { createMcpTaskManager, normalizeMcpTaskStatus } from './lib/mcp-tasks.mjs';
import { findGitRepoRoot, resolveTaskkillPath } from './lib/paths.mjs';
import { extractMarkdownContentFromEvent, storePlanMarkdown } from './lib/plan-markdown.mjs';
import { normalizeRequests } from './lib/requests.mjs';
import { mergeRunOptions, normalizeRunOptions } from './lib/run-options.mjs';
import { createStateStore } from './lib/state-store.mjs';
import { getOrCreateBackendStore } from './lib/store.mjs';
import { normalizeTodoItems } from './lib/todo.mjs';
import { clampNumber, makeId, normalizeString, nowIso } from './lib/utils.mjs';


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

  const { registerMcpTask, markMcpTaskRunning, markMcpTaskFinished, applyMcpTaskResult, writeMcpTaskResultPrompt } =
    createMcpTaskManager({
      ctx,
      mcpTasks,
      stateDir,
      stateFile,
      scheduleStateWrite,
    });

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
        planMarkdown: '',
        planMarkdownPath: '',
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

      async codexDeleteMcpTask(params) {
        const id = normalizeString(params?.taskId);
        if (!id) throw new Error('taskId is required');
        const task = mcpTasks.get(id);
        if (!task) return { ok: true, taskId: id, removed: false };
        const status = normalizeMcpTaskStatus(task.status);
        if (status === 'running') throw new Error('cannot delete running mcp task');
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

