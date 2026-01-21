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
  STREAM_POLL_MS,
  STREAM_TEXT_CHUNK_CHARS,
  STREAM_TIMEOUT_MS,
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

const normalizeMultilineText = (value) => String(value ?? '').replace(/\r\n?/g, '\n');

const splitTextIntoChunks = (text, size) => {
  const value = normalizeMultilineText(text);
  if (!value) return [];
  const chunkSize = Number.isFinite(size) && size > 0 ? Math.floor(size) : value.length;
  if (chunkSize <= 0) return [value];
  const chunks = [];
  for (let i = 0; i < value.length; i += chunkSize) {
    chunks.push(value.slice(i, i + chunkSize));
  }
  return chunks;
};

const extractTextFromValue = (value) => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts = value
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
        return '';
      })
      .filter(Boolean);
    return parts.join('');
  }
  if (value && typeof value === 'object' && typeof value.text === 'string') return value.text;
  return '';
};

const pickAssistantTextFromItem = (item) => {
  if (!item || typeof item !== 'object') return '';
  const candidates = [item.text, item.content, item.message, item.output_text, item.outputText];
  for (const candidate of candidates) {
    const text = extractTextFromValue(candidate);
    if (text) return normalizeMultilineText(text);
  }
  return '';
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

const pickAssistantMessageFromEvents = (events) => {
  if (!Array.isArray(events) || !events.length) return '';
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const evt = events[i];
    if (evt?.source !== 'codex') continue;
    const event = evt?.event || null;
    if (!event) continue;
    if (event.type !== 'item.completed' && event.type !== 'item.updated') continue;
    const item = event.item || {};
    const type = normalizeString(item?.type).toLowerCase();
    if (!type) continue;
    if (type === 'agent_message' || type === 'assistant_message' || type === 'message') {
      const text = pickAssistantTextFromItem(item);
      if (!text) continue;
      return text;
    }
  }
  return '';
};

const extractAssistantTextFromEvent = (evt) => {
  if (!evt || typeof evt !== 'object') return '';
  if (evt.source !== 'codex') return '';
  const event = evt.event || null;
  if (!event) return '';
  if (event.type !== 'item.completed' && event.type !== 'item.updated') return '';
  const item = event.item || {};
  const type = normalizeString(item?.type).toLowerCase();
  if (!type) return '';
  if (type !== 'agent_message' && type !== 'assistant_message' && type !== 'message') return '';
  const text = pickAssistantTextFromItem(item);
  if (!text) return '';
  return text;
};

const formatStreamEvent = (evt) => {
  if (evt === undefined || evt === null) return '';
  if (typeof evt === 'string') return evt;
  if (typeof evt !== 'object') return String(evt);

  const ts = evt.ts || nowIso();
  const trunc = evt.truncated ? ` …(truncated, originalLength=${Number(evt.originalLength) || 0})` : '';

  if (evt.source === 'stderr') return `[${ts}] stderr ${String(evt.text || '').trimEnd()}${trunc}`;
  if (evt.source === 'raw') return `[${ts}] raw ${String(evt.text || '').trimEnd()}${trunc}`;
  if (evt.line !== undefined) return `[${ts}] ${String(evt.line || '').trimEnd()}`;

  if (evt.source === 'system') {
    if (evt.kind === 'spawn') return `[${ts}] spawn ${String(evt.command || '')} ${Array.isArray(evt.args) ? evt.args.join(' ') : ''}`;
    if (evt.kind === 'status') return `[${ts}] status ${String(evt.status || '')}`;
    if (evt.kind === 'warning') return `[${ts}] warning ${String(evt.message || evt.warning || '')}`;
    if (evt.kind === 'error') return `[${ts}] error ${String(evt?.error?.message || '')}`;
    if (evt.kind === 'gap' && evt?.gap && Number.isFinite(evt.gap?.from) && Number.isFinite(evt.gap?.to)) {
      return `[${ts}] gap dropped_events seq=[${evt.gap.from}, ${evt.gap.to})`;
    }
    return `[${ts}] system ${JSON.stringify(evt).slice(0, 320)}`;
  }

  if (evt.source === 'codex') {
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

const getWindowLogEvents = (entry) => {
  if (!entry || typeof entry !== 'object') return [];
  const events = Array.isArray(entry.events) ? entry.events : [];
  if (events.length) return events;
  const lines = Array.isArray(entry.lines) ? entry.lines : [];
  return lines.map((line) => ({ source: 'raw', text: String(line ?? '') }));
};

const pendingCompletions = new Map();
const pendingStreams = new Map();

const clearCompletionWatcher = (token) => {
  if (!token) return;
  const timer = pendingCompletions.get(token);
  if (timer) clearInterval(timer);
  pendingCompletions.delete(token);
};

const clearStreamWatcher = (token) => {
  if (!token) return;
  
  // 调试日志
  try {
    console.error(`[MCP DEBUG] clearStreamWatcher: token=${token}, hasTimer=${pendingStreams.has(token)}\n`);
  } catch (e) {
    // ignore
  }
  
  const timer = pendingStreams.get(token);
  if (timer) clearInterval(timer);
  pendingStreams.delete(token);
};

const scheduleCompletionNotification = ({ requestId, windowId, requestedAt, meta, rpcId, sessionId }) => {
  if (!windowId) return '';
  const token = makeId();
  const startMs = Date.now();
  const requestedAtMs = parseIsoTime(requestedAt);
  let trackedRunId = '';
  const sessionTag = sessionId ? { sessionId } : {};

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
          ...sessionTag,
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

const scheduleStreamNotification = ({ requestId, windowId, requestedAt, meta, rpcId, sessionId }) => {
  if (!windowId) return '';
  
  // 调试日志
  try {
    console.error(`[MCP DEBUG] scheduleStreamNotification called: requestId=${requestId}, windowId=${windowId}, rpcId=${rpcId}, sessionId=${sessionId || 'none'}`);
  } catch (e) {
    // ignore
  }
  
  const token = makeId();
  const startMs = Date.now();
  const requestedAtMs = parseIsoTime(requestedAt);
  let trackedRunId = '';
  let lastIndex = null;
  let lastAssistantText = '';
  const sessionTag = sessionId ? { sessionId } : {};

  const poll = () => {
    // 调试日志
    try {
      console.error(`[MCP DEBUG][${new Date().toISOString()}] poll: windowId=${windowId}, trackedRunId=${trackedRunId || 'none'}, lastIndex=${lastIndex}`);
    } catch (e) {
      // ignore
    }
    
    const state = loadState(meta);
    const windows = Array.isArray(state?.windows) ? state.windows : [];
    const runs = Array.isArray(state?.runs) ? state.runs : [];
    const win = windows.find((w) => w?.id === windowId) || null;
    
    // 调试：状态信息
    try {
      console.error(`[MCP DEBUG] state: windows=${windows.length}, runs=${runs.length}, foundWindow=${!!win}\n`);
      if (win) {
        console.error(`[MCP DEBUG] window activeRunId: ${win.activeRunId || 'none'}\n`);
      }
    } catch (e) {
      // ignore
    }

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

    const run = trackedRunId ? runs.find((item) => String(item?.id || '') === trackedRunId) : null;
    const logEntry = state?.windowLogs && typeof state.windowLogs === 'object' ? state.windowLogs[windowId] : null;
    const events = getWindowLogEvents(logEntry);

    if (trackedRunId && lastIndex === null) {
      const startAtMs = parseIsoTime(run?.startedAt) || requestedAtMs;
      if (startAtMs) {
        const foundIndex = events.findIndex((evt) => parseIsoTime(evt?.ts) >= startAtMs);
        lastIndex = foundIndex >= 0 ? foundIndex : events.length;
      } else {
        lastIndex = 0;
      }
    }

    if (trackedRunId && Number.isFinite(lastIndex)) {
      if (events.length < lastIndex) lastIndex = 0;
      const slice = events.slice(lastIndex);
      lastIndex = events.length;
      for (const evt of slice) {
        const assistantText = extractAssistantTextFromEvent(evt);
        if (assistantText) lastAssistantText = assistantText;
        const text = formatStreamEvent(evt);
        sendNotification('codex_app.window_run.stream', {
          requestId,
          rpcId,
          ...sessionTag,
          windowId,
          runId: trackedRunId,
          event: evt,
          ...(text ? { text } : {}),
        });
      }
    }

    if (run) {
      const status = normalizeString(run?.status);
      
      // 调试：运行状态
      try {
        console.error(`[MCP DEBUG] run found: id=${trackedRunId}, status=${status}, isRunning=${isRunningStatus(status)}\n`);
      } catch (e) {
        // ignore
      }
      
      if (status && !isRunningStatus(status)) {
        // 尝试获取最终文本，优先使用assistant文本
        let finalText = lastAssistantText || pickAssistantMessageFromEvents(events);
        
        // 调试：finalText提取
        try {
          console.error(`[MCP DEBUG] finalText extraction: lastAssistantText=${lastAssistantText ? 'yes' : 'no'}, fromEvents=${!!pickAssistantMessageFromEvents(events)}\n`);
        } catch (e) {
          // ignore
        }
        
        // 如果无法提取assistant文本，生成降级文本
        if (!finalText) {
          // 基于运行状态生成描述性文本
          const statusMap = {
            'completed': '任务已完成',
            'failed': '任务执行失败',
            'aborted': '任务已中止',
            'cancelled': '任务已取消',
            'timeout': '任务执行超时'
          };
          const statusText = statusMap[status] || `任务状态: ${status}`;
          
          // 尝试从事件中提取一些有用的信息
          const eventSummary = events
            .slice(-10) // 取最后10个事件
            .map(evt => {
              if (evt.source === 'codex' && evt.event?.type === 'item.completed') {
                const item = evt.event.item || {};
                return `- ${item.type || '未知类型'}: ${item.status || '完成'}`;
              }
              return null;
            })
            .filter(Boolean)
            .join('\n');
          
          finalText = `Codex应用执行${statusText}。\n${eventSummary || '无详细事件记录。'}`;
        }
        
        // 确保finalText不为空
        finalText = finalText || `Codex应用执行完成，状态: ${status}`;
        
        // 调试：finalText内容
        try {
          console.error(`[MCP DEBUG] finalText ready: length=${finalText.length}, status=${status}\n`);
          console.error(`[MCP DEBUG] finalText preview: ${finalText.substring(0, 100)}${finalText.length > 100 ? '...' : ''}\n`);
        } catch (e) {
          // ignore
        }
        
        // 发送finalText（分块或整体）
        const chunks = splitTextIntoChunks(finalText, STREAM_TEXT_CHUNK_CHARS);
        const chunkId = makeId();
        const chunkCount = chunks.length || 0;
        
        // 调试：分块信息
        try {
          console.error(`[MCP DEBUG] sending finalText: chunkCount=${chunkCount}, rpcId=${rpcId}\n`);
        } catch (e) {
          // ignore
        }
        if (chunkCount === 0) {
          sendNotification('codex_app.window_run.stream', {
            requestId,
            rpcId,
            ...sessionTag,
            windowId,
            runId: trackedRunId,
            finalText,
            text: finalText,
            final: true,
            finalTextComplete: true,
          });
        } else {
          for (let i = 0; i < chunks.length; i += 1) {
            const chunk = chunks[i];
            sendNotification('codex_app.window_run.stream', {
              requestId,
              rpcId,
              ...sessionTag,
              windowId,
              runId: trackedRunId,
              finalText: chunk,
              text: chunk,
              final: true,
              finalTextChunk: true,
              chunkId,
              chunkIndex: i,
              chunkCount,
              finalTextComplete: chunkCount === 1 && i === 0,
            });
          }
        }
        
        // 调试：发送完成通知
        try {
          console.error(`[MCP DEBUG] sending done notification: status=${status}, runId=${trackedRunId}\n`);
        } catch (e) {
          // ignore
        }
        
        // 发送完成通知
        sendNotification('codex_app.window_run.stream', {
          requestId,
          rpcId,
          ...sessionTag,
          windowId,
          runId: trackedRunId,
          done: true,
          status,
          finishedAt: run?.finishedAt || '',
        });
        
        // 调试：清理stream watcher
        try {
          console.error(`[MCP DEBUG] clearing stream watcher: run completed, status=${status}\n`);
        } catch (e) {
          // ignore
        }
        
        clearStreamWatcher(token);
        return;
      }
    }

    if (Date.now() - startMs > STREAM_TIMEOUT_MS) {
      // 调试：超时清理
      try {
        console.error(`[MCP DEBUG] stream timeout: elapsed=${Date.now() - startMs}ms > ${STREAM_TIMEOUT_MS}ms\n`);
      } catch (e) {
        // ignore
      }
      clearStreamWatcher(token);
    }
  };

  const timer = setInterval(poll, STREAM_POLL_MS);
  pendingStreams.set(token, timer);
  poll();
  return token;
};

const WINDOW_RUN_TOOL = 'codex_app_window_run';

const TOOLS = [
  {
    name: WINDOW_RUN_TOOL,
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
    const name = normalizeString(params?.name);
    const args = params?.arguments || {};

    if (name === WINDOW_RUN_TOOL) {
      const prompt = typeof args?.prompt === 'string' ? args.prompt : '';
      if (!String(prompt || '').trim()) return jsonRpcError(id, -32602, 'prompt is required');
      const enhancedPrompt =
        `${prompt}\n\n执行任务前，先进行分析，将分析后的结果和任务创建根目录下的 codex_plan.md 文件，然后根据这个文件中任务逐一执行。完成后请保留该文件，系统会读取并删除。`;

      const meta = params?._meta;
      const taskId = normalizeString(meta?.taskId);
      if (!taskId) {
        return jsonRpcError(id, -32602, 'taskId is required in _meta');
      }
      const sessionId = normalizeString(meta?.sessionId);
      const state = loadState(meta);
      const windows = sortWindowsByRecent(Array.isArray(state?.windows) ? state.windows : []);
      const defaultsApplied = buildDefaultsApplied({}, meta);
      const workingDirectory = normalizeString(defaultsApplied.workingDirectory);
      try {
        console.error('[MCP DEBUG] findWindowByWorkingDirectory: start', {
          workingDirectory,
          windows: windows.length,
        });
      } catch {
        // ignore
      }
      const windowByWorkdir = findWindowByWorkingDirectory(windows, workingDirectory, { includeRunning: true });
      try {
        console.error('[MCP DEBUG] findWindowByWorkingDirectory: result', {
          workingDirectory,
          windowId: windowByWorkdir?.id || '',
          status: windowByWorkdir?.status || '',
        });
      } catch {
        // ignore
      }
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

      const requestId = taskId;
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
        sessionId,
      });

      return jsonRpcResult(id, toolResultText('调用成功'));
    }

    return jsonRpcError(id, -32601, `Unknown tool: ${name}`);
  }

  if (method === 'shutdown') {
    for (const token of pendingCompletions.keys()) {
      clearCompletionWatcher(token);
    }
    for (const token of pendingStreams.keys()) {
      clearStreamWatcher(token);
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
