import path from 'node:path';

import { MAX_MCP_TASKS, UI_PROMPTS_FILE_NAME } from './constants.mjs';
import { truncateResultText } from './codex.mjs';
import { appendJsonlFile } from './files.mjs';
import { buildResultTextWithPlan, readPlanMarkdownFromDisk } from './plan-markdown.mjs';
import { normalizeString, nowIso } from './utils.mjs';

export const MCP_TASK_TIMEOUT_MS = 30 * 60 * 1000;
export const MCP_TASK_QUEUE_TIMEOUT_MS = 30 * 60 * 1000;

export const normalizeMcpTaskStatus = (value) => {
  const status = normalizeString(value).toLowerCase();
  if (status === 'running' || status === 'completed' || status === 'failed' || status === 'aborted') return status;
  return 'queued';
};

export const normalizeMcpTask = (raw) => {
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

export const pruneMcpTasks = (mcpTasks) => {
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

export const checkTaskTimeouts = (
  mcpTasks,
  { nowMs = Date.now(), runningTimeoutMs = MCP_TASK_TIMEOUT_MS, queuedTimeoutMs = MCP_TASK_QUEUE_TIMEOUT_MS } = {},
) => {
  if (!(mcpTasks instanceof Map)) return { timedOut: [] };
  const timedOut = [];
  for (const task of mcpTasks.values()) {
    const status = normalizeMcpTaskStatus(task.status);
    if (status !== 'running' && status !== 'queued') continue;
    const createdAtMs = Date.parse(task.createdAt || '') || 0;
    const startedAtMs = Date.parse(task.startedAt || '') || 0;
    const baseMs = status === 'running' ? startedAtMs || createdAtMs : createdAtMs;
    const timeoutMs = status === 'running' ? runningTimeoutMs : queuedTimeoutMs;
    if (!baseMs || !timeoutMs) continue;
    if (nowMs - baseMs <= timeoutMs) continue;

    const elapsedMinutes = Math.max(1, Math.round((nowMs - baseMs) / 60000));
    const message =
      status === 'running'
        ? `task timed out after ${elapsedMinutes}m`
        : `task timed out while queued after ${elapsedMinutes}m`;

    task.status = 'failed';
    task.finishedAt = nowIso();
    task.error = { message };
    task.resultStatus = 'failed';
    task.resultText = task.resultText || message;
    task.resultAt = task.resultAt || nowIso();

    timedOut.push({
      id: task.id,
      runId: normalizeString(task.runId),
      status,
      reason: status === 'running' ? 'running_timeout' : 'queued_timeout',
    });
  }
  return { timedOut };
};

export const createMcpTaskManager = ({ ctx, mcpTasks, stateDir, stateFile, scheduleStateWrite }) => {
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
      if (!existing.promptRequestId) existing.promptRequestId = id;
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
      promptRequestId: id,
      promptSentAt: '',
    };
    mcpTasks.set(id, task);
    pruneMcpTasks(mcpTasks);
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
    const startedAtMs = Date.parse(task.startedAt || '') || 0;
    if (!startedAtMs) task.startedAt = nowIso();
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
    const diskPlan = readPlanMarkdownFromDisk(run?.options?.workingDirectory, { deleteAfterRead: true });
    if (diskPlan.content.trim()) {
      run.planMarkdown = diskPlan.content;
      run.planMarkdownPath = diskPlan.path || run.planMarkdownPath;
    }
    task.resultStatus = normalizeMcpTaskStatus(run?.status || task.status);
    task.resultText = truncateResultText(buildResultTextWithPlan(run));
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
    const outputText = task.resultText || truncateResultText(buildResultTextWithPlan(run));
    if (outputText) parts.push(`**输出**：\n\n${outputText}`);
    const errorMessage = task.error?.message || run?.error?.message;
    if (errorMessage) parts.push(`**错误**：${errorMessage}`);
    const markdown = parts.length ? parts.join('\n\n') : '😊';

    const pluginId = normalizeString(run?.pluginId || ctx?.pluginId);
    const appId = normalizeString(run?.appId || ctx?.appId || 'codex_app');
    const source = pluginId ? (appId ? `${pluginId}:${appId}` : pluginId) : '';
    const requestId = task.promptRequestId || task.id;
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

  return {
    registerMcpTask,
    markMcpTaskRunning,
    markMcpTaskFinished,
    applyMcpTaskResult,
    writeMcpTaskResultPrompt,
    checkTaskTimeouts: (options) => {
      const result = checkTaskTimeouts(mcpTasks, options);
      if (result.timedOut.length) scheduleStateWrite();
      return result;
    },
  };
};
