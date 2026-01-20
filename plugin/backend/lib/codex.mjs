import { MAX_MCP_RESULT_CHARS } from './constants.mjs';
import { nowIso, normalizeString, normalizeStringArray } from './utils.mjs';

export const buildWindowsCommandArgs = (command, args) => {
  const comspec = normalizeString(process.env?.ComSpec || process.env?.COMSPEC) || 'cmd.exe';
  return {
    command: comspec,
    args: ['/d', '/s', '/c', command, ...(Array.isArray(args) ? args : [])],
  };
};

export const buildCodexExecArgs = ({ threadId, options }) => {
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

export const formatCodexItem = (item) => {
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

export const pickAssistantMessage = (run) => {
  const events = Array.isArray(run?.events) ? run.events : [];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const evt = events[i];
    if (evt?.source !== 'codex') continue;
    const event = evt?.event || null;
    if (event?.type !== 'item.completed') continue;
    const item = event?.item || {};
    const type = normalizeString(item?.type).toLowerCase();
    if (!type) continue;
    if (type === 'agent_message' || type === 'assistant_message' || type === 'message') {
      const text = normalizeString(item?.text || item?.content || item?.message || item?.output_text || item?.outputText);
      if (text) return text;
    }
  }
  return '';
};

export const truncateResultText = (text) => {
  const value = normalizeString(text);
  if (!value) return '';
  if (value.length <= MAX_MCP_RESULT_CHARS) return value;
  return `${value.slice(0, MAX_MCP_RESULT_CHARS)}\n\n…(已截断)`;
};

export const formatRunEvent = (evt) => {
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
