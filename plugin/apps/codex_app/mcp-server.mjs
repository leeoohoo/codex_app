/**
 * MCP Server 入口（stdio, 无第三方依赖）。
 *
 * 注意：ChatOS 导入插件包时会默认排除 `node_modules/`，因此这里仅使用 Node.js 内置模块。
 */

import readline from 'node:readline';
import {
  COMPLETION_POLL_MS,
  COMPLETION_TIMEOUT_MS,
  DEFAULT_APPROVAL,
  DEFAULT_MODEL,
  MCP_PROTOCOL_VERSION,
} from './mcp/constants.mjs';
import { readJsonFile } from './mcp/files.mjs';
import {
  findGitRepoRoot,
  getStateFile,
  resolveDefaultWorkingDirectory,
} from './mcp/paths.mjs';
import { appendStartRunRequest } from './mcp/requests.mjs';
import { jsonRpcError, jsonRpcResult, send, sendNotification, toolResultText } from './mcp/rpc.mjs';
import { makeId, normalizeString, nowIso, parseIsoTime } from './mcp/utils.mjs';
import { findWindowByWorkingDirectory, isRunningStatus, sortWindowsByRecent } from './mcp/windows.mjs';

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
      const enhancedPrompt =
        `${prompt}\n\n执行任务前，先进行分析，将分析后的结果和任务创建一个.md 的文件，然后根据这个文件中任务逐一执行。执行完成后，将.md文件的内容通过笑脸😊追加在输出内容前面，格式如下：

😊
[这里是.md文件的内容]

[这里是正常的任务执行结果]

注意：请确保最终输出包含笑脸😊、.md文件内容和正常执行结果，然后将.md文件删除。`;

      const meta = params?._meta;
      const state = loadState(meta);
      const windows = sortWindowsByRecent(Array.isArray(state?.windows) ? state.windows : []);
      const defaultsApplied = buildDefaultsApplied({}, meta);
      const workingDirectory = normalizeString(defaultsApplied.workingDirectory);
      const windowByWorkdir = findWindowByWorkingDirectory(windows, workingDirectory, { includeRunning: true });
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
          source: 'mcp',
          windowId: targetWindowId,
          windowName: '',
          ensureWindow: true,
          input: enhancedPrompt,
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
