import { createThemeManager } from './ui/theme.mjs';
import { createDomHelpers } from './ui/dom.mjs';
import {
  clampNumber,
  collapseWhitespace,
  ensureClosedFences,
  formatCodexItem,
  formatTime,
  formatValueForMarkdown,
  normalizeTodoItems,
  renderMarkdown,
  truncateText,
} from './ui/format.mjs';

export function mount({ container, host, slots }) {
  if (!container) throw new Error('container is required');
  if (!host || typeof host !== 'object') throw new Error('host is required');

  const headerSlot =
    slots?.header && typeof slots.header === 'object' && typeof slots.header.appendChild === 'function' ? slots.header : null;

  const ctx = typeof host?.context?.get === 'function' ? host.context.get() : { pluginId: '', appId: '', theme: 'light' };
  const bridgeEnabled = Boolean(ctx?.bridge?.enabled);

  const colors = {
    pageBg: 'var(--codex-page-bg)',
    border: 'var(--codex-border)',
    borderStrong: 'var(--codex-border-strong)',
    bg: 'var(--codex-bg)',
    bgHover: 'var(--codex-bg-hover)',
    panel: 'var(--codex-panel)',
    panelHover: 'var(--codex-panel-hover)',
    logBg: 'var(--codex-log-bg)',
    textMuted: 'var(--codex-text-muted)',
    textStrong: 'var(--codex-text-strong)',
    accent: 'var(--codex-accent)',
    accent2: 'var(--codex-accent-2)',
    accentBorder: 'var(--codex-accent-border)',
    accentGlow: 'var(--codex-accent-glow)',
    gridOpacity: 'var(--codex-grid-opacity)',
    danger: 'var(--codex-danger)',
    dangerBorder: 'var(--codex-danger-border)',
    dangerBg: 'var(--codex-danger-bg)',
    dangerBgHover: 'var(--codex-danger-bg-hover)',
    primaryText: 'var(--codex-primary-text)',
    shadow: 'var(--codex-shadow)',
    panelShadow: 'var(--codex-panel-shadow)',
    titleGlow: 'var(--codex-title-glow)',
  };
  const themeManager = createThemeManager({ host, ctx, colors });
  const { registerSelect, setRenderMeta, setRoot, subscribe } = themeManager;

  let themeUnsub = null;
  let mcpTaskTimer = null;

  const styleEl = document.createElement('style');
  styleEl.textContent = `
.codex-app-root{ position:relative; background: var(--codex-page-bg); border-radius: 18px; overflow:hidden; }
.codex-app-root::before{
  content:''; position:absolute; inset:0; pointer-events:none;
  background:
    linear-gradient(rgba(255,255,255,0.09) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,0.09) 1px, transparent 1px);
  background-size: 34px 34px;
  opacity: var(--codex-grid-opacity);
  mix-blend-mode: overlay;
}
.codex-app-root::after{
  content:''; position:absolute; inset:-2px; pointer-events:none;
  background: radial-gradient(700px 420px at var(--mx,18%) var(--my,12%), var(--codex-accent-glow, rgba(34,211,238,0.16)), transparent 60%);
  opacity: 0.9;
}
.codex-app-root *{ box-sizing: border-box; }
.codex-app-root button, .codex-app-root input, .codex-app-root select, .codex-app-root textarea{
  transition: background 140ms ease, border-color 140ms ease, transform 140ms ease, box-shadow 140ms ease;
}
.codex-app-root button:hover{ box-shadow: 0 8px 22px rgba(0,0,0,0.10); transform: translateY(-1px); }
.codex-app-root button:active{ transform: translateY(0px) scale(0.99); }
.codex-app-root input:focus, .codex-app-root select:focus, .codex-app-root textarea:focus{
  outline: none;
  box-shadow: 0 0 0 3px var(--ds-focus-ring, rgba(34,211,238,0.20));
  border-color: var(--ds-accent, rgba(34,211,238,0.55)) !important;
}
.codex-app-root details[open]{ box-shadow: var(--codex-panel-shadow, 0 14px 40px rgba(0,0,0,0.12)); }
.codex-app-root pre{ font-variant-ligatures: none; }
.codex-app-root ::-webkit-scrollbar{ height: 10px; width: 10px; }
.codex-app-root ::-webkit-scrollbar-thumb{ background: rgba(148,163,184,0.35); border-radius: 999px; border: 2px solid transparent; background-clip: padding-box; }
.codex-app-root ::-webkit-scrollbar-thumb:hover{ background: rgba(148,163,184,0.50); border: 2px solid transparent; background-clip: padding-box; }
.codex-app-root ::-webkit-scrollbar-corner{ background: transparent; }
.codex-log{ border:0; border-radius:14px; padding:12px; margin:0; overflow:auto; min-height:0; min-width:0; flex:1; background: var(--codex-log-bg); color: var(--codex-text-strong); display:flex; flex-direction:column; gap:10px; }
.codex-log-empty{ font-size:12px; color: var(--codex-text-muted); }
.codex-log-entry{ border:1px solid var(--codex-border); background: var(--codex-panel); border-radius:12px; padding:10px; display:flex; flex-direction:column; gap:8px; }
.codex-log-entry--error{ border-color: var(--codex-danger-border); background: var(--codex-danger-bg); }
.codex-log-entry--warning{ border-color: var(--codex-accent-border); }
.codex-log-meta{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-size:11px; color: var(--codex-text-muted); }
.codex-log-time{ font-variant-numeric: tabular-nums; }
.codex-log-markdown{ font-size:13px; line-height:1.55; color: var(--codex-text-strong); display:flex; flex-direction:column; gap:6px; }
.codex-log-markdown p{ margin:0; }
.codex-log-markdown h1{ font-size:16px; margin:0; font-weight:800; }
.codex-log-markdown h2{ font-size:15px; margin:0; font-weight:750; }
.codex-log-markdown h3{ font-size:14px; margin:0; font-weight:700; }
.codex-log-markdown h4, .codex-log-markdown h5, .codex-log-markdown h6{ font-size:13px; margin:0; font-weight:700; }
.codex-log-markdown ul, .codex-log-markdown ol{ margin:0 0 0 18px; padding:0; }
.codex-log-markdown pre{ margin:0; padding:8px; border-radius:10px; background: var(--codex-bg); border:1px solid var(--codex-border); overflow:auto; }
.codex-log-markdown code{ font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; background: var(--codex-bg); border:1px solid var(--codex-border); border-radius:6px; padding:1px 4px; }
.codex-log-tool summary{ list-style:none; cursor:pointer; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.codex-log-tool summary::-webkit-details-marker{ display:none; }
.codex-log-tool-body{ display:grid; gap:8px; margin-top:8px; }
.codex-log-tool-block{ display:flex; flex-direction:column; gap:6px; }
.codex-log-tool-title{ font-size:11px; color: var(--codex-text-muted); text-transform:uppercase; letter-spacing:0.4px; font-weight:700; }
.codex-log-meta-text{ font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size:12px; line-height:1.5; white-space: pre-wrap; }
`;
  try {
    (document.head || document.documentElement).appendChild(styleEl);
  } catch {
    // ignore
  }

  const { el, mkBtn, mkInput, mkSelect, mkCheckbox, mkField, mkGroup, styleCheckboxCard, mkBadge, mkTag } = createDomHelpers({
    colors,
    registerSelect,
  });

  const state = {
    env: null,
    windows: [],
    selectedWindowId: '',
    windowEvents: new Map(), // windowId -> StoredEvent[]
    windowTodos: new Map(), // windowId -> { id, items, updatedAt, eventType }
    windowInputs: new Map(), // windowId -> { ts, text }[]
    inputPages: new Map(), // windowId -> page index
    inputDrafts: new Map(), // windowId -> draft text
    mcpTasks: [],
    runCursors: new Map(), // runId -> cursor
    pollTimers: new Map(), // runId -> intervalId
    rawJson: false,
    autoScroll: true,
  };

  const MAX_WINDOW_EVENTS = 2500;
  const TRIM_WINDOW_EVENTS_TO = 2000;
  const LOG_RENDER_CHAR_BUDGET = 250000;
  const LOG_ITEM_CHAR_LIMIT = 2000;
  const LOG_TOOL_IO_CHAR_LIMIT = 2000;
  const MAX_WINDOW_INPUTS = 500;
  const INPUT_PAGE_SIZE = 6;

  const RUN_SETTINGS_STORAGE_KEY = 'codex_app.run_settings.v1';
  const RUN_SETTINGS_BY_WINDOW_STORAGE_KEY = 'codex_app.run_settings.by_window.v1';

  const loadRunSettings = () => {
    try {
      if (typeof localStorage === 'undefined') return null;
      const raw = localStorage.getItem(RUN_SETTINGS_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  };

  const saveRunSettings = (settings) => {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(RUN_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // ignore
    }
  };

  const loadRunSettingsByWindow = () => {
    try {
      if (typeof localStorage === 'undefined') return {};
      const raw = localStorage.getItem(RUN_SETTINGS_BY_WINDOW_STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  };

  const saveRunSettingsByWindow = (settingsMap) => {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(RUN_SETTINGS_BY_WINDOW_STORAGE_KEY, JSON.stringify(settingsMap));
    } catch {
      // ignore
    }
  };

  const loadWindowRunSettings = (windowId) => {
    const id = String(windowId || '');
    if (!id) return null;
    const map = loadRunSettingsByWindow();
    const entry = map[id];
    return entry && typeof entry === 'object' ? entry : null;
  };

  const saveWindowRunSettings = (windowId, settings) => {
    const id = String(windowId || '');
    if (!id) return;
    const map = loadRunSettingsByWindow();
    map[id] = settings;
    saveRunSettingsByWindow(map);
  };

  const ensureWindowRunSettings = (windowId, seedSettings) => {
    const id = String(windowId || '');
    if (!id) return null;
    const existing = loadWindowRunSettings(id);
    if (existing) return existing;
    const base = seedSettings && typeof seedSettings === 'object' ? seedSettings : getDefaultRunSettings();
    const snapshot = { ...base };
    saveWindowRunSettings(id, snapshot);
    return snapshot;
  };

  const deleteWindowRunSettings = (windowId) => {
    const id = String(windowId || '');
    if (!id) return;
    const map = loadRunSettingsByWindow();
    if (map && Object.prototype.hasOwnProperty.call(map, id)) {
      delete map[id];
      saveRunSettingsByWindow(map);
    }
  };

  const invoke = async (method, params) => {
    if (!host?.backend?.invoke) throw new Error('host.backend.invoke is not available');
    return await host.backend.invoke(method, params);
  };

  const formatStoredEvent = (evt) => {
    const ts = evt?.ts || new Date().toISOString();
    if (state.rawJson) return `[${ts}] ${JSON.stringify(evt, null, 2)}`;

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

  const getEvents = (windowId) => state.windowEvents.get(windowId) || [];

  let sideInputsSummaryEl = null;
  let sideInputsListEl = null;
  let sideInputsPagerLabel = null;
  let sideInputsPrevBtn = null;
  let sideInputsNextBtn = null;
  let sideTasksSummaryEl = null;
  let sideTasksListEl = null;

  const getWindowInputs = (windowId) => {
    const id = String(windowId || '');
    return state.windowInputs.get(id) || [];
  };

  const getInputPage = (windowId) => {
    const id = String(windowId || '');
    return state.inputPages.get(id) || 0;
  };

  const saveInputDraft = (windowId, value) => {
    const id = String(windowId || '');
    if (!id) return;
    const text = String(value ?? '');
    if (text) state.inputDrafts.set(id, text);
    else state.inputDrafts.delete(id);
  };

  const loadInputDraft = (windowId) => {
    const id = String(windowId || '');
    if (!id) return '';
    return String(state.inputDrafts.get(id) || '');
  };

  const applyInputDraft = (windowId) => {
    if (!promptInput) return;
    promptInput.value = loadInputDraft(windowId);
  };

  const captureTodoFromEvent = (windowId, evt) => {
    if (evt?.source !== 'codex' || !evt?.event) return;
    const e = evt.event;
    if (e?.type !== 'item.started' && e?.type !== 'item.updated' && e?.type !== 'item.completed') return;
    if (e?.item?.type !== 'todo_list') return;
    const hasExplicitList = Array.isArray(e?.item?.items);
    const items = normalizeTodoItems(hasExplicitList ? e?.item?.items : e?.item);
    if (items.length || hasExplicitList) {
      state.windowTodos.set(String(windowId || ''), {
        id: String(e?.item?.id || ''),
        items,
        updatedAt: evt?.ts || new Date().toISOString(),
        eventType: String(e?.type || ''),
      });
      if (state.selectedWindowId === String(windowId || '')) {
        scheduleRenderSideTasks();
      }
    }
  };

  const getWindowTodos = (windowId) => {
    const id = String(windowId || '');
    const cached = state.windowTodos.get(id);
    if (cached && Array.isArray(cached.items) && cached.items.length) return cached;
    const win = state.windows.find((w) => w.id === id) || null;
    const items = normalizeTodoItems(win?.todoList);
    if (!items.length) return null;
    return {
      id: String(win?.todoListId || ''),
      items,
      updatedAt: String(win?.todoListUpdatedAt || win?.updatedAt || ''),
      eventType: 'window.snapshot',
    };
  };

  const buildTodosMarkdown = (windowId) => {
    const todo = getWindowTodos(windowId);
    const items = normalizeTodoItems(todo?.items);
    if (!items.length) return '';
    return items.map((it) => `- [${it.completed ? 'x' : ' '}] ${it.text}`).join('\n');
  };

  const copyToClipboard = async (text) => {
    const value = String(text || '');
    if (!value) return false;

    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch {
      // ignore
    }

    try {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return Boolean(ok);
    } catch {
      return false;
    }
  };

  let logRenderScheduled = false;
  const scheduleRenderLog = () => {
    if (logRenderScheduled) return;
    logRenderScheduled = true;
    const run = () => {
      logRenderScheduled = false;
      renderLog();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 16);
  };

  const appendEvent = (windowId, evt, { render = true } = {}) => {
    const id = String(windowId || '');
    const list = getEvents(id);
    list.push(evt);
    if (list.length > MAX_WINDOW_EVENTS) {
      list.splice(0, Math.max(0, list.length - TRIM_WINDOW_EVENTS_TO));
    }
    state.windowEvents.set(id, list);
    if (render && state.selectedWindowId === id) {
      scheduleRenderLog();
    }
  };

  const isLineItem = (evt) => typeof evt === 'string' || (evt && typeof evt === 'object' && typeof evt.line === 'string');
  const getLineText = (evt) => (typeof evt === 'string' ? evt : String(evt?.line || ''));

  const TOOL_ITEM_TYPES = new Set([
    'command_execution',
    'mcp_tool_call',
    'web_search',
    'tool_call',
    'tool_result',
    'apply_patch',
    'edit_file',
    'write_file',
    'file_write',
    'file_edit',
    'file_create',
    'file_delete',
    'file_change',
    'copy_path',
    'move_path',
    'delete_path',
  ]);
  const MESSAGE_ITEM_TYPES = new Set([
    'agent_message',
    'assistant_message',
    'message',
    'output_text',
    'output',
    'text',
    'assistant_output',
    'final',
  ]);
  const isRunningStatus = (value) => {
    const status = String(value || '').toLowerCase();
    return status === 'running' || status === 'aborting';
  };

  const pickFirst = (...values) => {
    for (const value of values) {
      if (value === undefined || value === null) continue;
      if (typeof value === 'string' && value === '') continue;
      return value;
    }
    return '';
  };

  const shouldSurfaceStderr = (text) => {
    const raw = String(text || '').trim();
    if (!raw) return false;
    const lower = raw.toLowerCase();
    if (lower.includes('needs_follow_up')) return false;
    if (lower.includes('traceback') || lower.includes('exception') || lower.includes('error') || lower.includes('failed')) return true;
    return false;
  };

  const formatToolName = (item) => {
    const type = String(item?.type || '');
    if (type === 'mcp_tool_call') {
      const server = String(item?.server || '').trim();
      const tool = String(item?.tool || '').trim();
      const name = [server, tool].filter(Boolean).join('.');
      return name ? `mcp ${name}` : 'mcp';
    }
    if (type === 'command_execution') return 'command';
    if (type === 'file_change') {
      const changes = Array.isArray(item?.changes) ? item.changes : [];
      if (changes.length === 1 && changes[0]?.path) return `file_change ${changes[0].path}`;
      if (changes.length > 1) return `file_change ${changes.length} files`;
      return 'file_change';
    }
    if (type === 'web_search') return 'web_search';
    const name = pickFirst(item?.tool, item?.tool_name, item?.toolName, item?.name);
    if (name) return String(name);
    const path = pickFirst(item?.path, item?.file, item?.file_path, item?.filepath);
    if (path) return `${type || 'file'} ${path}`;
    return type || 'tool';
  };

  const extractToolIO = (item) => {
    if (!item || typeof item !== 'object') return { input: '', output: '' };
    const type = String(item?.type || '');
    const fileInput = {};
    const filePath = pickFirst(item?.path, item?.file, item?.file_path, item?.filepath);
    if (filePath) fileInput.path = filePath;
    if (item?.content) fileInput.content = item.content;
    if (item?.diff) fileInput.diff = item.diff;
    if (item?.patch) fileInput.patch = item.patch;
    if (item?.before) fileInput.before = item.before;
    if (item?.after) fileInput.after = item.after;
    if (item?.edits) fileInput.edits = item.edits;
    const filePayload = Object.keys(fileInput).length ? fileInput : '';
    if (type === 'command_execution') {
      const output = pickFirst(item.aggregated_output, item.output, item.result);
      return { input: pickFirst(item.command), output };
    }
    if (type === 'file_change') {
      const output = pickFirst(item.status, item.result, item.output, item.message);
      return {
        input: pickFirst(item.changes, item.diff, item.patch, item.content, item.files, item.file_changes, filePayload),
        output,
      };
    }
    if (type === 'web_search') {
      const output = pickFirst(item.result, item.results, item.output);
      return { input: pickFirst(item.query, item.input), output };
    }
    if (type === 'mcp_tool_call') {
      const input = pickFirst(item.input, item.arguments, item.params, item.request, item.args, item.call, item.tool_input, item.toolInput);
      const output = pickFirst(item.output, item.result, item.response, item.tool_output, item.toolOutput, item.data);
      return { input, output };
    }
    const input = pickFirst(item.input, item.arguments, item.params, item.command, item.patch, item.diff, item.content, filePayload);
    const output = pickFirst(
      item.output,
      item.result,
      item.response,
      item.aggregated_output,
      item.output_text,
      item.outputText,
      item.data,
    );
    return { input, output };
  };

  const isToolLikeItem = (item) => {
    if (!item || typeof item !== 'object') return false;
    const type = String(item.type || '');
    if (TOOL_ITEM_TYPES.has(type)) return true;
    const lower = type.toLowerCase();
    if (!lower) return false;
    if (lower.includes('tool') || lower.includes('file') || lower.includes('patch') || lower.includes('edit')) return true;
    if (item.command) return true;
    if (item.path || item.file || item.file_path || item.filepath) return true;
    return false;
  };

  const buildMessageEntry = (time, text, { kind = 'message', title = '助手' } = {}) => {
    const trimmed = truncateText(text, LOG_ITEM_CHAR_LIMIT);
    const markdown = trimmed.truncated ? ensureClosedFences(trimmed.text) : trimmed.text;
    const line = [time ? `[${time}]` : '', title, collapseWhitespace(trimmed.text)].filter(Boolean).join(' ');
    return { kind, time, title, markdown, line, cost: trimmed.text.length + 1 };
  };

  const buildMetaEntry = (time, text) => {
    const trimmed = truncateText(text, LOG_ITEM_CHAR_LIMIT);
    const line = [time ? `[${time}]` : '', trimmed.text].filter(Boolean).join(' ');
    return { kind: 'meta', time, text: trimmed.text, line, cost: trimmed.text.length + 1 };
  };

  const buildToolEntry = (time, item) => {
    const name = formatToolName(item);
    const statusParts = [];
    if (item?.status) statusParts.push(String(item.status));
    if (item?.exit_code !== undefined && item.exit_code !== null) statusParts.push(`exit=${item.exit_code}`);
    if (item?.ok === false && !statusParts.includes('failed')) statusParts.push('failed');
    const statusText = statusParts.join(' ');

    const { input, output: rawOutput } = extractToolIO(item);
    let output = rawOutput;
    if (!output) {
      output = pickFirst(item?.error?.message, item?.error, item?.error_message, item?.errorMessage);
    }
    const inputLang = item?.type === 'command_execution' ? 'bash' : typeof input === 'object' ? 'json' : 'text';
    const inputBlock = formatValueForMarkdown(input, { limit: LOG_TOOL_IO_CHAR_LIMIT, forceCodeBlock: true, codeLang: inputLang });
    const outputBlock = formatValueForMarkdown(output, { limit: LOG_TOOL_IO_CHAR_LIMIT });

    const line = [time ? `[${time}]` : '', `tool ${name}`, statusText].filter(Boolean).join(' ');
    const cost = inputBlock.preview.length + outputBlock.preview.length + line.length + 1;
    return {
      kind: 'tool',
      time,
      title: '工具',
      tool: { name, status: statusText, input: inputBlock, output: outputBlock },
      line,
      cost,
    };
  };

  const buildLogEntry = (evt) => {
    if (isLineItem(evt)) {
      const time = evt?.ts ? formatTime(evt.ts) : '';
      return buildMetaEntry(time, getLineText(evt));
    }
    if (!evt || typeof evt !== 'object') return null;
    const time = formatTime(evt?.ts || new Date().toISOString());

      if (evt?.source === 'system') {
        if (evt.kind === 'error') return buildMessageEntry(time, evt?.error?.message || evt.message || '', { kind: 'error', title: '错误' });
        if (evt.kind === 'warning') return buildMessageEntry(time, evt.message || evt.warning || '', { kind: 'warning', title: '警告' });
        if (evt.kind === 'user') return buildMessageEntry(time, evt.message || evt.text || '', { kind: 'message', title: '用户' });
        if (evt.kind === 'status') {
          const status = String(evt.status || '');
          if (status === 'failed' || status === 'aborted') {
            return buildMessageEntry(time, `status ${status}`, { kind: 'warning', title: '状态' });
          }
      }
      return null;
    }

    if (evt?.source === 'stderr') {
      if (!shouldSurfaceStderr(evt.text)) return null;
      return buildMessageEntry(time, String(evt.text || '').trimEnd(), { kind: 'error', title: 'stderr' });
    }

    if (evt?.source === 'raw') return null;

    if (evt?.source === 'codex') {
      const e = evt.event || {};
      if (e.type === 'turn.failed') return buildMessageEntry(time, e?.error?.message || '', { kind: 'error', title: '错误' });
      if (e.type === 'error') return buildMessageEntry(time, e.message || '', { kind: 'error', title: '错误' });
      if (e.type === 'item.completed') {
        const item = e.item || {};
        const itemType = String(item.type || '');
        if (itemType === 'reasoning' || itemType === 'todo_list') return null;
          if (MESSAGE_ITEM_TYPES.has(itemType)) {
            const text = pickFirst(item.text, item.message, item.output_text, item.content);
            if (!text) return null;
            return buildMessageEntry(time, text, { kind: 'message', title: '助手' });
          }
          if (itemType === 'error') {
            const text = pickFirst(item.message, item.text);
            return buildMessageEntry(time, text || '', { kind: 'error', title: '错误' });
          }
          if (isToolLikeItem(item)) return buildToolEntry(time, item);
          const fallbackText = pickFirst(item.text, item.message, item.output_text, item.content);
          if (fallbackText) return buildMessageEntry(time, fallbackText, { kind: 'message', title: '助手' });
          return buildMetaEntry(time, `item ${itemType} ${JSON.stringify(item).slice(0, 320)}`);
        }
      }

    return null;
  };

  const renderToolBlock = (title, block) => {
    const wrap = document.createElement('div');
    wrap.className = 'codex-log-tool-block';
    const label = document.createElement('div');
    label.className = 'codex-log-tool-title';
    label.textContent = title;
    wrap.appendChild(label);

    if (!block?.markdown) {
      const empty = document.createElement('div');
      empty.className = 'codex-log-meta-text';
      empty.textContent = '无';
      wrap.appendChild(empty);
      return wrap;
    }

    const body = document.createElement('div');
    body.className = 'codex-log-markdown';
    body.appendChild(renderMarkdown(block.markdown));
    wrap.appendChild(body);
    return wrap;
  };

  const renderLogEntry = (entry) => {
    const card = document.createElement('div');
    card.className = 'codex-log-entry';
    if (entry.kind === 'error') card.classList.add('codex-log-entry--error');
    if (entry.kind === 'warning') card.classList.add('codex-log-entry--warning');

    const meta = document.createElement('div');
    meta.className = 'codex-log-meta';
    if (entry.time) {
      const time = document.createElement('span');
      time.className = 'codex-log-time';
      time.textContent = entry.time;
      meta.appendChild(time);
    }
    if (entry.title) {
      const label = document.createElement('strong');
      label.textContent = entry.title;
      meta.appendChild(label);
    }
    card.appendChild(meta);

    if (entry.kind === 'tool' && entry.tool) {
      const details = document.createElement('details');
      details.className = 'codex-log-tool';
      const summary = document.createElement('summary');

      const tag = mkTag(entry.tool.name, { fg: colors.textStrong, bg: colors.bg, border: colors.accentBorder });
      summary.appendChild(tag);
      if (entry.tool.status) {
        const status = mkBadge(entry.tool.status, { fg: colors.textMuted, bg: 'transparent', border: colors.borderStrong });
        summary.appendChild(status);
      }

      details.appendChild(summary);
      const body = document.createElement('div');
      body.className = 'codex-log-tool-body';
      body.appendChild(renderToolBlock('入参', entry.tool.input));
      body.appendChild(renderToolBlock('出参', entry.tool.output));
      details.appendChild(body);
      card.appendChild(details);
      return card;
    }

    if (entry.kind === 'meta') {
      const text = document.createElement('div');
      text.className = 'codex-log-meta-text';
      text.textContent = entry.text || '';
      card.appendChild(text);
      return card;
    }

    const body = document.createElement('div');
    body.className = 'codex-log-markdown';
    body.appendChild(renderMarkdown(entry.markdown || ''));
    card.appendChild(body);
    return card;
  };

  const countRemainingVisible = (events, endIndex) => {
    let count = 0;
    for (let i = endIndex; i >= 0; i--) {
      const entry = buildLogEntry(events[i]);
      if (entry) count += 1;
    }
    return count;
  };

  const buildRawLogModel = (events) => {
    const kept = [];
    const lines = [];
    let chars = 0;
    let omitted = 0;

    for (let i = events.length - 1; i >= 0; i--) {
      const line = formatStoredEvent(events[i]);
      const cost = line.length + 1;
      if (chars + cost > LOG_RENDER_CHAR_BUDGET) {
        if (!kept.length) {
          const keep = Math.max(0, LOG_RENDER_CHAR_BUDGET - 32);
          const truncatedLine = `${line.slice(0, keep)}…(truncated)`;
          kept.push({ kind: 'meta', text: truncatedLine, line: truncatedLine, cost: truncatedLine.length + 1 });
          lines.push(truncatedLine);
        } else {
          omitted = i + 1;
        }
        break;
      }
      kept.push({ kind: 'meta', text: line, line, cost });
      lines.push(line);
      chars += cost;
    }

    kept.reverse();
    lines.reverse();
    if (omitted > 0) {
      const msg = `[…省略更早的 ${omitted} 条日志…]`;
      kept.unshift({ kind: 'meta', text: msg, line: msg, cost: msg.length + 1 });
      lines.unshift(msg);
    }
    return { items: kept, lines };
  };

  const buildLogModel = (windowId) => {
    const events = getEvents(windowId);
    if (!events.length) return { items: [], lines: [] };
    if (state.rawJson) return buildRawLogModel(events);

    const kept = [];
    const lines = [];
    let chars = 0;
    let omitted = 0;

    for (let i = events.length - 1; i >= 0; i--) {
      const entry = buildLogEntry(events[i]);
      if (!entry) continue;
      const cost = entry.cost + 1;
      if (chars + cost > LOG_RENDER_CHAR_BUDGET) {
        if (!kept.length) {
          const keep = Math.max(0, LOG_RENDER_CHAR_BUDGET - 32);
          const truncatedLine = `${entry.line.slice(0, keep)}…(truncated)`;
          kept.push({ kind: 'meta', text: truncatedLine, line: truncatedLine, cost: truncatedLine.length + 1 });
          lines.push(truncatedLine);
        } else {
          omitted = countRemainingVisible(events, i);
        }
        break;
      }
      kept.push(entry);
      lines.push(entry.line);
      chars += cost;
    }

    kept.reverse();
    lines.reverse();
    if (omitted > 0) {
      const msg = `[…省略更早的 ${omitted} 条日志…]`;
      kept.unshift({ kind: 'meta', text: msg, line: msg, cost: msg.length + 1 });
      lines.unshift(msg);
    }
    return { items: kept, lines };
  };

  const buildLogText = (windowId) => {
    const { lines } = buildLogModel(windowId);
    if (!lines.length) return '';
    return `${lines.join('\n')}\n`;
  };

  const renderLog = () => {
    const windowId = state.selectedWindowId;
    const { items, lines } = buildLogModel(windowId);

    logEl.textContent = '';

    if (state.rawJson) {
      const pre = document.createElement('pre');
      pre.style.margin = '0';
      pre.style.whiteSpace = 'pre-wrap';
      pre.style.wordBreak = 'break-word';
      pre.style.fontFamily =
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
      pre.textContent = lines.length ? `${lines.join('\n')}\n` : '暂无日志';
      logEl.appendChild(pre);
      if (lines.length && state.autoScroll) logEl.scrollTop = logEl.scrollHeight;
      return;
    }

    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'codex-log-empty';
      empty.textContent = '暂无日志';
      logEl.appendChild(empty);
      return;
    }

    for (const entry of items) {
      logEl.appendChild(renderLogEntry(entry));
    }
    if (state.autoScroll) logEl.scrollTop = logEl.scrollHeight;
  };

  const renderInputHistory = () => {
    if (!sideInputsSummaryEl || !sideInputsListEl || !sideInputsPagerLabel || !sideInputsPrevBtn || !sideInputsNextBtn) return;
    const windowId = state.selectedWindowId;
    const rawItems = getWindowInputs(windowId);
    const items = rawItems.length ? rawItems.slice().reverse() : [];
    const total = items.length;
    const totalPages = total ? Math.ceil(total / INPUT_PAGE_SIZE) : 0;
    const current = totalPages ? clampNumber(getInputPage(windowId), 0, totalPages - 1) : 0;

    sideInputsListEl.textContent = '';
    sideInputsPrevBtn.disabled = current <= 0;
    sideInputsNextBtn.disabled = totalPages === 0 || current >= totalPages - 1;
    sideInputsPagerLabel.textContent = totalPages ? `${current + 1}/${totalPages}` : '0/0';

    if (!total) {
      sideInputsSummaryEl.textContent = '暂无输入记录';
      const empty = el('div', { fontSize: '12px', color: colors.textMuted, padding: '8px 0' });
      empty.textContent = '提示：点击“运行”会记录输入内容。';
      sideInputsListEl.appendChild(empty);
      return;
    }

    if (totalPages && current !== getInputPage(windowId)) {
      state.inputPages.set(String(windowId || ''), current);
    }
    sideInputsSummaryEl.textContent = `共 ${total} 条`;

    const start = current * INPUT_PAGE_SIZE;
    const pageItems = items.slice(start, start + INPUT_PAGE_SIZE);

    for (const entry of pageItems) {
      const row = el('div', {
        border: `1px solid ${colors.border}`,
        borderRadius: '12px',
        background: colors.bg,
        padding: '10px 10px',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
      });
      const meta = el('div', { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' });
      meta.appendChild(mkBadge(formatTime(entry?.ts), { fg: colors.textMuted, border: colors.border }));
      meta.appendChild(mkBadge(`${String(entry?.text || '').length} chars`, { fg: colors.textMuted, border: colors.border }));
      const body = el('pre', {
        margin: '0',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: colors.textStrong,
        fontSize: '12px',
        lineHeight: '1.45',
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      });
      body.textContent = String(entry?.text || '');
      row.appendChild(meta);
      row.appendChild(body);
      sideInputsListEl.appendChild(row);
    }
  };

  let inputsRenderScheduled = false;
  const scheduleRenderInputs = () => {
    if (inputsRenderScheduled) return;
    inputsRenderScheduled = true;
    const run = () => {
      inputsRenderScheduled = false;
      renderInputHistory();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 16);
  };

  const recordWindowInput = async (windowId, text) => {
    const id = String(windowId || '');
    const value = String(text || '').trim();
    if (!id || !value) return;
    const entry = { ts: new Date().toISOString(), text: value };
    const list = getWindowInputs(id);
    list.push(entry);
    if (list.length > MAX_WINDOW_INPUTS) list.splice(0, Math.max(0, list.length - MAX_WINDOW_INPUTS));
    state.windowInputs.set(id, list);
    state.inputPages.set(id, 0);
    if (state.selectedWindowId === id) scheduleRenderInputs();

    try {
      const res = await invoke('codexAppendWindowInput', { windowId: id, text: value });
      const items = Array.isArray(res?.items) ? res.items : null;
      if (items) {
        state.windowInputs.set(id, items);
        state.inputPages.set(id, 0);
        if (state.selectedWindowId === id) scheduleRenderInputs();
      }
    } catch (e) {
      appendEvent(id, { ts: new Date().toISOString(), source: 'system', kind: 'error', error: { message: e?.message || String(e) } });
    }
  };

  const buildTodoRow = (it, { compact = false } = {}) => {
    const row = el('div', {
      display: 'flex',
      alignItems: 'flex-start',
      gap: '10px',
      padding: compact ? '8px' : '10px 10px',
      borderRadius: '12px',
      border: `1px solid ${colors.border}`,
      background: colors.bg,
    });
    const size = compact ? '16px' : '18px';
    const mark = el('div', {
      width: size,
      height: size,
      borderRadius: '6px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: compact ? '11px' : '12px',
      fontWeight: '850',
      background: it.completed ? '#22c55e' : 'transparent',
      color: it.completed ? '#0b1020' : colors.textMuted,
      border: it.completed ? '0' : `1px solid ${colors.borderStrong}`,
      flex: '0 0 auto',
      marginTop: '1px',
    });
    mark.textContent = it.completed ? '✓' : '';
    const text = el('div', {
      flex: '1',
      minWidth: '0',
      fontSize: compact ? '12px' : '13px',
      color: it.completed ? colors.textMuted : colors.textStrong,
      textDecoration: it.completed ? 'line-through' : 'none',
      lineHeight: '1.45',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
    });
    text.textContent = it.text;
    row.appendChild(mark);
    row.appendChild(text);
    return row;
  };

  const renderTasksTo = ({ summaryEl, listEl, windowId, compact = false, emptyHint = '' }) => {
    if (!summaryEl || !listEl) return;
    const todo = getWindowTodos(windowId);
    const items = normalizeTodoItems(todo?.items);
    const done = items.filter((it) => it.completed).length;

    listEl.textContent = '';
    if (!items.length) {
      summaryEl.textContent = '暂无任务（等待 Codex 输出 todo_list）';
      if (emptyHint) {
        const empty = el('div', { fontSize: '12px', color: colors.textMuted, padding: '10px 0' });
        empty.textContent = emptyHint;
        listEl.appendChild(empty);
      }
      return;
    }

    const metaParts = [`进度 ${done}/${items.length}`];
    if (todo?.updatedAt) metaParts.push(`更新于 ${formatTime(todo.updatedAt)}`);
    summaryEl.textContent = metaParts.join(' · ');

    for (const it of items) {
      listEl.appendChild(buildTodoRow(it, { compact }));
    }
  };

  let sideTasksRenderScheduled = false;
  const scheduleRenderSideTasks = () => {
    if (sideTasksRenderScheduled) return;
    sideTasksRenderScheduled = true;
    const run = () => {
      sideTasksRenderScheduled = false;
      renderSideTasks();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 16);
  };

  const renderSideTasks = () => {
    renderTasksTo({
      summaryEl: sideTasksSummaryEl,
      listEl: sideTasksListEl,
      windowId: state.selectedWindowId,
      compact: true,
      emptyHint: '等待 Codex 输出 todo_list。',
    });
  };

  const updateSelectedHeader = () => {
    const win = state.windows.find((w) => w.id === state.selectedWindowId) || null;
    windowNameInput.value = win ? String(win.name || '') : '';
    threadIdValue.textContent = win?.threadId ? String(win.threadId) : 'no thread';
    const status = win ? String(win.status || 'idle') : 'idle';
    statusValue.textContent = status;
    if (btnRun) {
      const running = isRunningStatus(status);
      btnRun.disabled = running;
      btnRun.title = running ? '该窗口正在运行中' : '';
    }
    if (status === 'running') {
      statusValue.style.background = 'rgba(245,158,11,0.18)';
      statusValue.style.borderColor = 'rgba(245,158,11,0.45)';
      statusValue.style.color = colors.textStrong;
    } else if (status === 'failed') {
      statusValue.style.background = 'rgba(239,68,68,0.16)';
      statusValue.style.borderColor = 'rgba(239,68,68,0.45)';
      statusValue.style.color = '#ef4444';
    } else if (status === 'aborted') {
      statusValue.style.background = 'rgba(245,158,11,0.12)';
      statusValue.style.borderColor = 'rgba(245,158,11,0.35)';
      statusValue.style.color = colors.textStrong;
    } else if (status === 'completed') {
      statusValue.style.background = 'rgba(34,197,94,0.16)';
      statusValue.style.borderColor = 'rgba(34,197,94,0.45)';
      statusValue.style.color = '#22c55e';
    } else {
      statusValue.style.background = colors.bg;
      statusValue.style.borderColor = colors.borderStrong;
      statusValue.style.color = colors.textMuted;
    }
  };

  const setSelectedWindow = (windowId) => {
    if (promptInput && state.selectedWindowId && state.windows.some((w) => w.id === state.selectedWindowId)) {
      saveInputDraft(state.selectedWindowId, promptInput.value);
    }
    state.selectedWindowId = String(windowId || '');
    renderWindowList();
    updateSelectedHeader();
    const selectedWin = state.windows.find((win) => win.id === state.selectedWindowId);
    const settings = ensureWindowRunSettings(state.selectedWindowId, buildWindowSeedSettings(selectedWin));
    applyRunSettingsToControls(settings);
    applyInputDraft(state.selectedWindowId);
    renderInputHistory();
    renderSideTasks();
    loadWindowLogs(state.selectedWindowId).catch((e) =>
      appendEvent(state.selectedWindowId, {
        ts: new Date().toISOString(),
        source: 'system',
        kind: 'error',
        error: { message: e?.message || String(e) },
      }),
    );
    loadWindowTasks(state.selectedWindowId).catch((e) =>
      appendEvent(state.selectedWindowId, {
        ts: new Date().toISOString(),
        source: 'system',
        kind: 'error',
        error: { message: e?.message || String(e) },
      }),
    );
    loadWindowInputs(state.selectedWindowId).catch((e) =>
      appendEvent(state.selectedWindowId, {
        ts: new Date().toISOString(),
        source: 'system',
        kind: 'error',
        error: { message: e?.message || String(e) },
      }),
    );
    renderLog();
  };

  const renderWindowList = () => {
    windowList.textContent = '';
    for (const win of state.windows) {
      const row = el('div', {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '10px',
        padding: '10px',
        borderRadius: '12px',
        border: `1px solid ${colors.border}`,
        background: win.id === state.selectedWindowId ? colors.bgHover : 'transparent',
        cursor: 'pointer',
      });

      const left = el('div', { display: 'grid', gap: '4px', minWidth: '0', flex: '1' });
      const name = el('div', {
        fontWeight: '700',
        color: colors.textStrong,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      });
      name.textContent = win.name || win.id;

      const status = String(win.status || 'idle');
      const meta = el('div', {
        fontSize: '12px',
        color: colors.textMuted,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      });
      const threadShort = win.threadId ? String(win.threadId).slice(0, 12) + '…' : 'no thread';
      meta.textContent = `${status} · ${threadShort}`;

      left.appendChild(name);
      left.appendChild(meta);

      const right = el('div', { display: 'flex', alignItems: 'center', gap: '8px' });
      const dotColor =
        status === 'running'
          ? '#f59e0b'
          : status === 'failed'
            ? '#ef4444'
            : status === 'aborted'
              ? '#f59e0b'
              : status === 'completed'
                ? '#22c55e'
                : '#22c55e';
      const dotOpacity = status === 'running' ? '1' : status === 'failed' ? '0.9' : '0.55';
      const dot = el('div', {
        width: '8px',
        height: '8px',
        borderRadius: '999px',
        background: dotColor,
        opacity: dotOpacity,
      });
      const closeBtn = mkBtn('×');
      closeBtn.style.padding = '4px 8px';
      closeBtn.style.borderRadius = '10px';
      closeBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          await invoke('codexCloseWindow', { windowId: win.id });
          state.windows = state.windows.filter((w) => w.id !== win.id);
          state.windowEvents.delete(win.id);
          state.windowTodos.delete(win.id);
          state.windowInputs.delete(win.id);
          state.inputPages.delete(win.id);
          state.inputDrafts.delete(win.id);
          deleteWindowRunSettings(win.id);
          if (state.selectedWindowId === win.id) {
            setSelectedWindow(state.windows[0]?.id || '');
          } else {
            renderWindowList();
          }
        } catch (err) {
          appendEvent(state.selectedWindowId || win.id, {
            ts: new Date().toISOString(),
            source: 'system',
            kind: 'error',
            error: { message: err?.message || String(err) },
          });
        }
      });

      right.appendChild(dot);
      right.appendChild(closeBtn);

      row.appendChild(left);
      row.appendChild(right);
      row.addEventListener('click', () => setSelectedWindow(win.id));
      windowList.appendChild(row);
    }
  };

  const formatTaskTime = (value) => {
    if (!value) return '';
    const ts = Date.parse(String(value));
    if (!Number.isFinite(ts)) return '';
    try {
      return new Date(ts).toLocaleString();
    } catch {
      return String(value);
    }
  };

  const getTaskStatusLabel = (task) => {
    const status = String(task?.status || '').toLowerCase();
    if (status === 'running') return '执行中';
    if (status === 'completed') return '完成';
    if (status === 'failed') return '失败';
    if (status === 'aborted') return '已中止';
    if (status === 'queued') {
      return String(task?.windowStatus || '') === 'running' ? '等待当前窗口完成' : '待执行';
    }
    return '待执行';
  };

  const renderTaskList = () => {
    taskList.textContent = '';
    const tasks = Array.isArray(state.mcpTasks) ? state.mcpTasks : [];
    if (!tasks.length) {
      const empty = el('div', { fontSize: '12px', color: colors.textMuted, padding: '6px 2px' });
      empty.textContent = '暂无 MCP 任务';
      taskList.appendChild(empty);
      return;
    }

    for (const task of tasks) {
      const row = el('div', {
        display: 'grid',
        gap: '6px',
        padding: '10px',
        borderRadius: '12px',
        border: `1px solid ${colors.border}`,
        background: colors.bg,
      });

      const title = el('div', {
        fontWeight: '700',
        color: colors.textStrong,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      });
      const input = String(task?.input || '').trim();
      title.textContent = input ? input.slice(0, 36) : task?.id || 'MCP 任务';

      const meta = el('div', {
        fontSize: '12px',
        color: colors.textMuted,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      });
      const workdir = String(task?.workingDirectory || '').trim();
      const time = formatTaskTime(task?.createdAt);
      meta.textContent = [workdir || '未指定目录', time].filter(Boolean).join(' · ');

      const statusRow = el('div', { display: 'flex', alignItems: 'center', gap: '6px' });
      const statusLabel = getTaskStatusLabel(task);
      const statusBadge = mkBadge(statusLabel, {
        fg: statusLabel === '执行中' ? '#f59e0b' : statusLabel === '完成' ? '#22c55e' : statusLabel === '失败' ? '#ef4444' : colors.textMuted,
        bg: statusLabel === '执行中' ? 'rgba(245,158,11,0.12)' : statusLabel === '完成' ? 'rgba(34,197,94,0.12)' : statusLabel === '失败' ? 'rgba(239,68,68,0.12)' : 'transparent',
        border: statusLabel === '执行中' ? 'rgba(245,158,11,0.35)' : statusLabel === '完成' ? 'rgba(34,197,94,0.35)' : statusLabel === '失败' ? 'rgba(239,68,68,0.35)' : colors.borderStrong,
      });
      statusRow.appendChild(statusBadge);

      if (task?.windowName || task?.windowId) {
        const winLabel = el('div', { fontSize: '12px', color: colors.textMuted });
        winLabel.textContent = task.windowName || task.windowId;
        statusRow.appendChild(winLabel);
      }

      row.appendChild(title);
      row.appendChild(meta);
      row.appendChild(statusRow);
      taskList.appendChild(row);
    }
  };

  const stopPolling = (runId) => {
    const id = state.pollTimers.get(runId);
    if (id) clearInterval(id);
    state.pollTimers.delete(runId);
    state.runCursors.delete(runId);
  };

  const startPolling = (runId, windowId) => {
    if (state.pollTimers.has(runId)) return;
    state.runCursors.set(runId, 0);
    loadMcpTasks();

    const tick = async () => {
      try {
        const cursor = state.runCursors.get(runId) || 0;
        const res = await invoke('codexPollRun', { runId, cursor });
        const events = Array.isArray(res?.events) ? res.events : [];
        if (typeof res?.nextCursor === 'number') state.runCursors.set(runId, res.nextCursor);
        const runStatus = res?.run?.status ? String(res.run.status) : '';

        if (res?.gap && Number.isFinite(res.gap?.from) && Number.isFinite(res.gap?.to)) {
          appendEvent(windowId, { ts: new Date().toISOString(), source: 'system', kind: 'gap', gap: res.gap });
        }

        for (const evt of events) {
          appendEvent(windowId, evt);
          captureTodoFromEvent(windowId, evt);
          if (evt?.source === 'codex' && evt?.event?.type === 'thread.started' && typeof evt.event.thread_id === 'string') {
            const win = state.windows.find((w) => w.id === windowId);
            if (win) {
              win.threadId = evt.event.thread_id;
              if (state.selectedWindowId === windowId) threadIdValue.textContent = evt.event.thread_id;
              renderWindowList();
            }
          }
        }

        if (runStatus) {
          const win = state.windows.find((w) => w.id === windowId);
          if (win && win.status !== runStatus) {
            win.status = runStatus;
            if (state.selectedWindowId === windowId) updateSelectedHeader();
            renderWindowList();
          }
        }

        if (res?.done) {
          stopPolling(runId);
          const win = state.windows.find((w) => w.id === windowId);
          if (win) {
            win.status = runStatus || 'idle';
            if (state.selectedWindowId === windowId) updateSelectedHeader();
            renderWindowList();
          }
          loadMcpTasks();
        }
      } catch (e) {
        appendEvent(windowId, { ts: new Date().toISOString(), source: 'system', kind: 'error', error: { message: e?.message || String(e) } });
        stopPolling(runId);
      }
    };

    const intervalId = setInterval(tick, 500);
    state.pollTimers.set(runId, intervalId);
    tick();
  };

  const root = el('div', {
    height: '100%',
    maxWidth: '100%',
    boxSizing: 'border-box',
    padding: '12px',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    color: colors.textStrong,
    fontFamily:
      'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"',
  });
  root.className = 'codex-app-root';
  root.style.border = `1px solid ${colors.border}`;
  root.style.background = colors.pageBg;
  root.style.boxShadow = colors.shadow;

  root.addEventListener('mousemove', (e) => {
    try {
      const r = root.getBoundingClientRect();
      const mx = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
      const my = Math.max(0, Math.min(1, (e.clientY - r.top) / Math.max(1, r.height)));
      root.style.setProperty('--mx', `${(mx * 100).toFixed(2)}%`);
      root.style.setProperty('--my', `${(my * 100).toFixed(2)}%`);
    } catch {
      // ignore
    }
  });
  root.addEventListener('mouseleave', () => {
    root.style.removeProperty('--mx');
    root.style.removeProperty('--my');
  });

  const header = el('div', { display: 'flex', flexDirection: 'column', gap: '4px' });
  const headerTop = el('div', { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' });
  const title = el('div', { fontWeight: '900', fontSize: '16px', letterSpacing: '0.2px' });
  title.textContent = 'Codex 控制台';
  title.style.background = `linear-gradient(90deg, ${colors.accent} 0%, ${colors.accent2} 55%, ${colors.accent} 100%)`;
  title.style.webkitBackgroundClip = 'text';
  title.style.backgroundClip = 'text';
  title.style.webkitTextFillColor = 'transparent';
  title.style.color = 'transparent';
  title.style.textShadow = colors.titleGlow;
  const headerActions = el('div', { display: 'flex', gap: '8px', alignItems: 'center' });

  const btnRefresh = mkBtn('刷新');
  const btnNew = mkBtn('新建窗口');
  const btnResume = mkBtn('恢复线程');

  headerActions.appendChild(btnRefresh);
  headerActions.appendChild(btnNew);
  headerActions.appendChild(btnResume);

  headerTop.appendChild(title);
  headerTop.appendChild(headerActions);

  const meta = el('div', { fontSize: '12px', color: colors.textMuted });
  const renderMeta = (theme) => {
    meta.textContent = `${ctx?.pluginId || ''}:${ctx?.appId || ''} · theme=${theme || 'light'} · bridge=${bridgeEnabled ? 'enabled' : 'disabled'}`;
  };
  setRenderMeta(renderMeta);

  header.appendChild(headerTop);
  header.appendChild(meta);

  setRoot(root);
  themeUnsub = subscribe();

  const body = el('div', {
    display: 'grid',
    gridTemplateColumns: 'minmax(220px, 300px) minmax(0, 1fr) minmax(220px, 320px)',
    gap: '12px',
    flex: '1',
    minHeight: '0',
    minWidth: '0',
  });

  const sidebar = el('div', {
    border: `1px solid ${colors.border}`,
    borderRadius: '14px',
    padding: '12px',
    background: colors.panel,
    backdropFilter: 'blur(10px)',
    WebkitBackdropFilter: 'blur(10px)',
    boxShadow: colors.panelShadow,
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    minHeight: '0',
    minWidth: '0',
  });

  const sidebarHint = el('div', { fontSize: '12px', color: colors.textMuted });
  sidebarHint.textContent = '窗口 = 一个 Codex thread（可并行运行/查看日志）';

  const windowList = el('div', {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    overflow: 'auto',
    minHeight: '0',
  });
  windowList.style.flex = '1 1 0';

  const sidebarDivider = el('div', { height: '1px', background: colors.border });

  const taskListHint = el('div', { fontSize: '12px', color: colors.textMuted });
  taskListHint.textContent = 'MCP 任务列表（同目录串行）';

  const taskList = el('div', {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    overflow: 'auto',
    minHeight: '0',
  });
  taskList.style.flex = '1 1 0';

  sidebar.appendChild(sidebarHint);
  sidebar.appendChild(windowList);
  sidebar.appendChild(sidebarDivider);
  sidebar.appendChild(taskListHint);
  sidebar.appendChild(taskList);

  const main = el('div', {
    border: `1px solid ${colors.border}`,
    borderRadius: '14px',
    padding: '12px',
    background: colors.panel,
    backdropFilter: 'blur(10px)',
    WebkitBackdropFilter: 'blur(10px)',
    boxShadow: colors.panelShadow,
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    minHeight: '0',
    minWidth: '0',
  });

  const infoRow = el('div', {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
    gap: '12px',
    alignItems: 'start',
  });
  const windowNameInput = mkInput('例如：需求排查 / 代码审查 / 修 bug');
  const threadIdValue = el('div', {
    border: `1px solid ${colors.borderStrong}`,
    borderRadius: '12px',
    background: colors.bg,
    padding: '9px 10px',
    fontSize: '12px',
    color: colors.textMuted,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
  });
  threadIdValue.textContent = 'no thread';

  const statusValue = el('div', {
    border: `1px solid ${colors.borderStrong}`,
    borderRadius: '12px',
    background: colors.bg,
    padding: '9px 10px',
    fontSize: '12px',
    fontWeight: '750',
    textAlign: 'center',
    color: colors.textMuted,
  });
  statusValue.textContent = 'idle';

  infoRow.appendChild(mkField('窗口名称', windowNameInput, { hint: '仅用于界面识别；不影响 codex' }));
  infoRow.appendChild(mkField('Thread ID', threadIdValue, { hint: '点击复制（用于 resume / 继续对话）' }));
  infoRow.appendChild(mkField('状态', statusValue, { hint: 'running 时可随时停止' }));

  const settings = document.createElement('details');
  settings.open = false;
  settings.style.border = `1px solid ${colors.border}`;
  settings.style.borderRadius = '14px';
  settings.style.padding = '12px 12px';
  settings.style.background = colors.panelHover;

  const settingsSummary = document.createElement('summary');
  settingsSummary.textContent = '运行设置（codex exec）';
  settingsSummary.style.cursor = 'pointer';
  settingsSummary.style.fontWeight = '750';
  settingsSummary.style.color = colors.textStrong;
  settingsSummary.style.padding = '2px 2px';
  settings.appendChild(settingsSummary);

  const settingsGrid = el('div', {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
    gap: '12px',
    marginTop: '10px',
    alignItems: 'start',
  });

  const codexCommandInput = mkInput('codex');
  codexCommandInput.value = 'codex';

  const workingDirInput = mkInput('可留空（等同不传 --cd）');
  workingDirInput.style.flex = '1 1 0';
  workingDirInput.style.minWidth = '0';
  const btnPickWorkingDir = mkBtn('选择…');
  btnPickWorkingDir.style.padding = '9px 10px';
  btnPickWorkingDir.style.borderRadius = '12px';
  btnPickWorkingDir.style.fontWeight = '750';
  const workingDirRow = el('div', { display: 'flex', gap: '8px', alignItems: 'center' });
  workingDirRow.appendChild(workingDirInput);
  workingDirRow.appendChild(btnPickWorkingDir);
  const workingDirStatus = el('div', { fontSize: '12px', color: colors.textMuted, lineHeight: '1.4' });
  const workingDirWrap = el('div', { display: 'grid', gap: '8px' });
  workingDirWrap.appendChild(workingDirRow);
  workingDirWrap.appendChild(workingDirStatus);

  const MODEL_CUSTOM = '__custom__';
  const modelSelect = mkSelect([
    { value: '', label: '默认（不传 --model）' },
    { value: 'gpt-5.2', label: 'gpt-5.2' },
    { value: 'gpt-5.2-codex', label: 'gpt-5.2-codex' },
    { value: MODEL_CUSTOM, label: '自定义…' },
  ]);
  const modelCustomInput = mkInput('输入自定义 model');
  modelCustomInput.style.display = 'none';

  const updateModelUi = () => {
    const mode = String(modelSelect.value || '');
    modelCustomInput.style.display = mode === MODEL_CUSTOM ? 'block' : 'none';
  };

  const getModelValue = () => {
    const mode = String(modelSelect.value || '');
    if (mode === MODEL_CUSTOM) return String(modelCustomInput.value || '').trim();
    return mode;
  };

  const reasoningSelect = mkSelect([
    { value: '', label: '思考：默认（model_reasoning_effort）' },
    { value: 'none', label: '思考：none' },
    { value: 'minimal', label: '思考：minimal' },
    { value: 'low', label: '思考：low' },
    { value: 'medium', label: '思考：medium' },
    { value: 'high', label: '思考：high' },
    { value: 'xhigh', label: '思考：xhigh' },
  ]);

  const { wrap: windowsSandboxWrap, input: windowsSandboxInput } = mkCheckbox('开启 Windows 沙箱（实验：experimental_windows_sandbox）');
  styleCheckboxCard(windowsSandboxWrap);

  const windowsSandboxHint = el('div', { fontSize: '12px', color: colors.textMuted });
  Object.assign(windowsSandboxHint.style, {
    border: `1px dashed ${colors.borderStrong}`,
    borderRadius: '12px',
    background: colors.bg,
    padding: '9px 10px',
    boxSizing: 'border-box',
    lineHeight: '1.4',
  });

  const windowsSandboxField = el('div', { display: 'flex', flexDirection: 'column', gap: '8px' });
  windowsSandboxField.style.display = 'none';
  windowsSandboxHint.style.display = 'none';
  windowsSandboxField.appendChild(windowsSandboxWrap);
  windowsSandboxField.appendChild(windowsSandboxHint);

  const sandboxSelect = mkSelect([
    { value: '', label: 'sandbox：默认' },
    { value: 'read-only', label: 'read-only' },
    { value: 'workspace-write', label: 'workspace-write' },
    { value: 'danger-full-access', label: 'danger-full-access' },
  ]);
  sandboxSelect.value = 'danger-full-access';

  const approvalSelect = mkSelect([
    { value: '', label: 'approval：默认' },
    { value: 'never', label: 'never（推荐：UI 不阻塞）' },
    { value: 'on-request', label: 'on-request（可能阻塞等待交互）' },
    { value: 'on-failure', label: 'on-failure（可能阻塞等待交互）' },
    { value: 'untrusted', label: 'untrusted（可能阻塞等待交互）' },
  ]);
  approvalSelect.value = 'never';

  const netSelect = mkSelect([
    { value: '', label: 'network：默认' },
    { value: 'true', label: 'network：允许' },
    { value: 'false', label: 'network：禁止' },
  ]);
  const webSelect = mkSelect([
    { value: '', label: 'web search：默认' },
    { value: 'true', label: 'web search：允许' },
    { value: 'false', label: 'web search：禁止' },
  ]);

  const { wrap: skipRepoWrap, input: skipRepoInput } = mkCheckbox('跳过 git repo 检查（--skip-git-repo-check）');
  styleCheckboxCard(skipRepoWrap);

  const updateWindowsSandboxUi = () => {
    const isWin = String(state.env?.platform || '') === 'win32';
    windowsSandboxField.style.display = isWin ? 'flex' : 'none';
    if (!isWin) {
      windowsSandboxHint.textContent = '';
      windowsSandboxHint.style.display = 'none';
      return;
    }

    const sandboxMode = String(sandboxSelect.value || '').trim();
    if (sandboxMode === 'workspace-write') {
      windowsSandboxHint.textContent = windowsSandboxInput.checked
        ? '提示：已启用 Windows 沙箱（实验），workspace-write 才会真正生效（仍只允许写工作目录及 --add-dir）。'
        : '提示：Windows 上 workspace-write 会被 Codex 强制降级为 read-only；需要写入请选择 danger-full-access 或勾选 Windows 沙箱（实验）。';
      windowsSandboxHint.style.display = 'block';
      return;
    }
    if (sandboxMode === 'danger-full-access') {
      windowsSandboxHint.textContent = '提示：danger-full-access 不做沙箱限制（可写任意路径）。';
      windowsSandboxHint.style.display = 'block';
      return;
    }
    windowsSandboxHint.textContent = '';
    windowsSandboxHint.style.display = 'none';
  };

  const DEFAULT_RUN_SETTINGS = {
    codexCommand: 'codex',
    workingDirectory: '',
    model: 'gpt-5.2-codex',
    modelReasoningEffort: 'xhigh',
    experimentalWindowsSandboxEnabled: false,
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'never',
    networkAccessEnabled: '',
    webSearchEnabled: '',
    skipGitRepoCheck: true,
    skipGitRepoCheckExplicit: false,
  };

  let skipRepoExplicit = false;

  const getDefaultRunSettings = () => {
    const saved = loadRunSettings() || {};
    return { ...DEFAULT_RUN_SETTINGS, ...saved };
  };

  const mergeRunSettings = (base, override) => {
    const merged = { ...(base && typeof base === 'object' ? base : {}) };
    if (!override || typeof override !== 'object') return merged;
    for (const [key, value] of Object.entries(override)) {
      if (value === undefined || value === null) continue;
      if (typeof value === 'string' && value.trim() === '') continue;
      merged[key] = value;
    }
    return merged;
  };

  const buildWindowSeedSettings = (win, baseSettings) => {
    const base = baseSettings && typeof baseSettings === 'object' ? baseSettings : getDefaultRunSettings();
    return mergeRunSettings(base, win?.defaultRunOptions);
  };

  const applyRunSettingsToControls = (settings) => {
    const base = getDefaultRunSettings();
    const next = { ...base, ...(settings || {}) };
    const explicitFlag =
      typeof next.skipGitRepoCheckExplicit === 'boolean'
        ? next.skipGitRepoCheckExplicit
        : typeof (settings || {}).skipGitRepoCheck === 'boolean'
          ? true
          : typeof (loadRunSettings() || {}).skipGitRepoCheck === 'boolean';
    skipRepoExplicit = Boolean(explicitFlag);

    codexCommandInput.value = String(next.codexCommand || 'codex').trim() || 'codex';
    workingDirInput.value = typeof next.workingDirectory === 'string' ? next.workingDirectory : '';

    const modelValue = typeof next.model === 'string' ? next.model.trim() : '';
    const knownModels = new Set(['', 'gpt-5.2', 'gpt-5.2-codex']);
    if (knownModels.has(modelValue)) {
      modelSelect.value = modelValue;
      modelCustomInput.value = '';
    } else if (modelValue) {
      modelSelect.value = MODEL_CUSTOM;
      modelCustomInput.value = modelValue;
    } else {
      modelSelect.value = base.model;
      modelCustomInput.value = '';
    }

    reasoningSelect.value = typeof next.modelReasoningEffort === 'string' ? next.modelReasoningEffort : '';
    windowsSandboxInput.checked = Boolean(next.experimentalWindowsSandboxEnabled);
    sandboxSelect.value = String(next.sandboxMode || '');
    approvalSelect.value = String(next.approvalPolicy || '');
    netSelect.value = String(next.networkAccessEnabled || '');
    webSelect.value = String(next.webSearchEnabled || '');
    skipRepoInput.checked = Boolean(next.skipGitRepoCheck);

    updateModelUi();
    updateWindowsSandboxUi();
  };

  const buildRunSettingsSnapshot = () => ({
    codexCommand: String(codexCommandInput.value || '').trim() || 'codex',
    workingDirectory: String(workingDirInput.value || '').trim(),
    model: getModelValue(),
    modelReasoningEffort: String(reasoningSelect.value || '').trim(),
    experimentalWindowsSandboxEnabled: Boolean(windowsSandboxInput.checked),
    sandboxMode: String(sandboxSelect.value || '').trim(),
    approvalPolicy: String(approvalSelect.value || '').trim(),
    networkAccessEnabled: String(netSelect.value || '').trim(),
    webSearchEnabled: String(webSelect.value || '').trim(),
    skipGitRepoCheck: Boolean(skipRepoInput.checked),
    skipGitRepoCheckExplicit: skipRepoExplicit,
  });

  const persistRunSettings = () => {
    const settings = buildRunSettingsSnapshot();
    saveRunSettings(settings);
    if (state.selectedWindowId) saveWindowRunSettings(state.selectedWindowId, settings);
  };

  applyRunSettingsToControls();

  codexCommandInput.addEventListener('input', persistRunSettings);
  workingDirInput.addEventListener('input', persistRunSettings);
  modelSelect.addEventListener('change', () => {
    updateModelUi();
    persistRunSettings();
  });
  modelCustomInput.addEventListener('input', persistRunSettings);
  reasoningSelect.addEventListener('change', persistRunSettings);
  windowsSandboxInput.addEventListener('change', () => {
    persistRunSettings();
    updateWindowsSandboxUi();
  });
  sandboxSelect.addEventListener('change', () => {
    persistRunSettings();
    updateWindowsSandboxUi();
  });
  approvalSelect.addEventListener('change', persistRunSettings);
  netSelect.addEventListener('change', persistRunSettings);
  webSelect.addEventListener('change', persistRunSettings);
  skipRepoInput.addEventListener('change', () => {
    skipRepoExplicit = true;
    persistRunSettings();
  });
  btnPickWorkingDir.addEventListener('click', async () => {
    const prevLabel = String(btnPickWorkingDir.textContent || '选择…');
    btnPickWorkingDir.disabled = true;
    btnPickWorkingDir.textContent = '选择中…';
    workingDirStatus.textContent = '正在打开目录选择器…';
    try {
      const suggested = String(workingDirInput.value || '').trim() || String(state.env?.sessionRootGitRoot || state.env?.cwdGitRoot || state.env?.sessionRoot || '').trim();
      const res = await invoke('codexPickDirectory', { title: '选择工作目录', defaultPath: suggested || undefined });
      if (res?.reason === 'unsupported') {
        workingDirStatus.textContent = '当前宿主不支持打开文件夹选择器，请手动输入路径。';
        appendEvent(state.selectedWindowId, {
          ts: new Date().toISOString(),
          source: 'system',
          kind: 'warning',
          warning: '当前宿主不支持打开文件夹选择器，请手动输入路径。',
        });
        return;
      }
      const picked = String(res?.path || '').trim();
      if (!picked) {
        workingDirStatus.textContent = '已取消。';
        return;
      }

      workingDirInput.value = picked;
      persistRunSettings();
      workingDirStatus.textContent = `已设置：${picked}`;

      // If user never explicitly set --skip-git-repo-check, auto-tune it based on the chosen folder.
      if (!skipRepoExplicit) {
        try {
          const git = await invoke('codexGetGitInfo', { cwd: picked });
          skipRepoInput.checked = !Boolean(git?.isGitRepo);
          persistRunSettings();
        } catch {
          // ignore
        }
      }
    } catch (e) {
      workingDirStatus.textContent = `打开失败：${e?.message || String(e)}`;
      appendEvent(state.selectedWindowId, {
        ts: new Date().toISOString(),
        source: 'system',
        kind: 'error',
        error: { message: e?.message || String(e) },
      });
    } finally {
      btnPickWorkingDir.disabled = false;
      btnPickWorkingDir.textContent = prevLabel;
    }
  });

  const { wrap: basicGroup, body: basicBody } = mkGroup('基础设置', { subtitle: '常用参数，一般改这几项就够了' });
  basicBody.appendChild(mkField('codex 命令', codexCommandInput, { hint: '默认：codex（可改成完整路径或别名）' }));
  const modelWrap = el('div', { display: 'grid', gap: '8px' });
  modelWrap.appendChild(modelSelect);
  modelWrap.appendChild(modelCustomInput);
  basicBody.appendChild(mkField('model', modelWrap, { hint: '常用模型可直接选；选“自定义”可手动输入' }));
  basicBody.appendChild(mkField('思考（reasoning_effort）', reasoningSelect, { hint: '影响推理强度/速度；默认由 codex 配置决定' }));
  basicBody.appendChild(mkField('工作目录（--cd）', workingDirWrap, { hint: '留空表示不传 --cd（使用默认工作目录）' }));

  const { wrap: safetyGroup, body: safetyBody } = mkGroup('权限与安全', { subtitle: '沙箱、审批、网络与 Web Search' });
  safetyBody.appendChild(mkField('sandbox', sandboxSelect, { hint: '决定写权限与隔离级别（Windows 上 workspace-write 有额外限制）' }));
  safetyBody.appendChild(windowsSandboxField);
  safetyBody.appendChild(mkField('approval', approvalSelect, { hint: '决定是否需要人工确认（UI 里推荐 never）' }));
  safetyBody.appendChild(mkField('network', netSelect, { hint: '是否允许网络访问（取决于 sandbox 配置）' }));
  safetyBody.appendChild(mkField('web search', webSelect, { hint: '是否允许 web_search 工具（如果宿主支持）' }));
  safetyBody.appendChild(skipRepoWrap);

  settingsGrid.appendChild(basicGroup);
  settingsGrid.appendChild(safetyGroup);
  settings.appendChild(settingsGrid);

  const settingsFooter = el('div', {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '10px',
    marginTop: '10px',
    flexWrap: 'wrap',
  });
  const settingsStatus = el('div', { fontSize: '12px', color: colors.textMuted, lineHeight: '1.4' });
  settingsStatus.textContent = '改动会自动保存到本地；也可以点击“保存”手动保存。';
  const btnSaveSettings = mkBtn('保存');
  let saveFlashTimer = null;
  btnSaveSettings.addEventListener('click', () => {
    persistRunSettings();
    settingsStatus.textContent = '已保存。';
    if (saveFlashTimer) clearTimeout(saveFlashTimer);
    saveFlashTimer = setTimeout(() => {
      settingsStatus.textContent = '改动会自动保存到本地；也可以点击“保存”手动保存。';
    }, 1200);
  });
  settingsFooter.appendChild(settingsStatus);
  settingsFooter.appendChild(btnSaveSettings);
  settings.appendChild(settingsFooter);

  const promptInput = document.createElement('textarea');
  promptInput.placeholder = '输入要给 Codex 的 prompt（通过 stdin 传入 codex exec）…';
  Object.assign(promptInput.style, {
    width: '100%',
    minHeight: '64px',
    boxSizing: 'border-box',
    borderRadius: '14px',
    border: `1px solid ${colors.borderStrong}`,
    background: colors.bg,
    padding: '8px 10px',
    resize: 'vertical',
    outline: 'none',
    color: colors.textStrong,
  });

  const { wrap: promptGroup, body: promptBody } = mkGroup('输入', {
    subtitle: '这里的内容会通过 stdin 传给 codex exec',
    compact: true,
  });
  promptBody.appendChild(promptInput);
  promptInput.addEventListener('input', () => {
    if (!state.selectedWindowId) return;
    saveInputDraft(state.selectedWindowId, promptInput.value);
  });

  const controls = el('div', { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' });
  const btnRun = mkBtn('运行', { variant: 'primary' });
  const btnAbort = mkBtn('停止', { variant: 'danger' });
  const btnClear = mkBtn('清空日志');

  const { wrap: rawWrap, input: rawInput } = mkCheckbox('Raw JSON');
  const { wrap: scrollWrap, input: scrollInput } = mkCheckbox('自动滚动');
  scrollInput.checked = true;

  [btnRun, btnAbort, btnClear].forEach((btn) => {
    btn.style.padding = '6px 10px';
    btn.style.borderRadius = '10px';
    btn.style.fontSize = '12px';
  });
  [rawWrap, scrollWrap].forEach((wrap) => {
    wrap.style.gap = '6px';
    wrap.style.fontSize = '12px';
  });

  controls.appendChild(btnRun);
  controls.appendChild(btnAbort);
  controls.appendChild(btnClear);
  controls.appendChild(rawWrap);
  controls.appendChild(scrollWrap);

  const { wrap: controlGroup, body: controlBody } = mkGroup('操作', {
    subtitle: '运行、停止、清理，以及显示选项',
    compact: true,
  });
  controlBody.appendChild(controls);

  const viewBar = el('div', { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '10px', flexWrap: 'wrap' });
  const btnCopyLog = mkBtn('复制日志');
  btnCopyLog.style.padding = '7px 10px';
  btnCopyLog.style.borderRadius = '999px';
  viewBar.appendChild(btnCopyLog);

  const logEl = el('div', {
    border: '0',
    borderRadius: '14px',
    padding: '12px',
    margin: '0',
    overflow: 'auto',
    minHeight: '0',
    minWidth: '0',
    flex: '1',
  });
  logEl.className = 'codex-log';

  btnCopyLog.addEventListener('click', async () => {
    const windowId = state.selectedWindowId;
    const text = buildLogText(windowId);
    if (!text) {
      appendEvent(windowId, { ts: new Date().toISOString(), source: 'system', kind: 'error', error: { message: '没有可复制的内容' } });
      return;
    }
    const ok = await copyToClipboard(text);
    if (!ok && typeof window !== 'undefined' && typeof window.prompt === 'function') {
      try {
        window.prompt('复制以下内容', text);
      } catch {
        // ignore
      }
    }
    appendEvent(windowId, {
      ts: new Date().toISOString(),
      source: 'system',
      kind: 'status',
      status: ok ? 'copied' : 'copy failed',
    });
  });

  main.appendChild(infoRow);
  main.appendChild(settings);
  main.appendChild(promptGroup);
  main.appendChild(controlGroup);
  main.appendChild(viewBar);
  main.appendChild(logEl);

  const rightPanel = el('div', {
    border: `1px solid ${colors.border}`,
    borderRadius: '14px',
    padding: '12px',
    background: colors.panel,
    backdropFilter: 'blur(10px)',
    WebkitBackdropFilter: 'blur(10px)',
    boxShadow: colors.panelShadow,
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    minHeight: '0',
    minWidth: '0',
  });

  const { wrap: inputsGroup, body: inputsBody } = mkGroup('输入记录', { subtitle: '运行按钮触发' });
  Object.assign(inputsGroup.style, { minHeight: '0', flex: '1 1 0' });
  Object.assign(inputsBody.style, { display: 'flex', flexDirection: 'column', gap: '8px', minHeight: '0' });

  sideInputsSummaryEl = el('div', { fontSize: '12px', color: colors.textMuted });
  const inputsPager = el('div', { display: 'flex', alignItems: 'center', gap: '6px' });
  sideInputsPrevBtn = mkBtn('上一页');
  sideInputsNextBtn = mkBtn('下一页');
  sideInputsPrevBtn.style.padding = '6px 8px';
  sideInputsNextBtn.style.padding = '6px 8px';
  sideInputsPrevBtn.style.borderRadius = '10px';
  sideInputsNextBtn.style.borderRadius = '10px';
  sideInputsPrevBtn.style.fontWeight = '650';
  sideInputsNextBtn.style.fontWeight = '650';
  sideInputsPagerLabel = mkBadge('0/0', { fg: colors.textMuted, border: colors.borderStrong });
  inputsPager.appendChild(sideInputsPrevBtn);
  inputsPager.appendChild(sideInputsPagerLabel);
  inputsPager.appendChild(sideInputsNextBtn);

  const inputsMetaRow = el('div', {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
    flexWrap: 'wrap',
  });
  inputsMetaRow.appendChild(sideInputsSummaryEl);
  inputsMetaRow.appendChild(inputsPager);

  sideInputsListEl = el('div', {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    overflow: 'auto',
    minHeight: '0',
  });

  inputsBody.appendChild(inputsMetaRow);
  inputsBody.appendChild(sideInputsListEl);

  const changeInputPage = (delta) => {
    const windowId = state.selectedWindowId;
    const total = getWindowInputs(windowId).length;
    if (!total) return;
    const totalPages = Math.ceil(total / INPUT_PAGE_SIZE);
    const current = clampNumber(getInputPage(windowId), 0, totalPages - 1);
    const next = clampNumber(current + delta, 0, totalPages - 1);
    if (next === current) return;
    state.inputPages.set(String(windowId || ''), next);
    renderInputHistory();
  };
  sideInputsPrevBtn.addEventListener('click', () => changeInputPage(-1));
  sideInputsNextBtn.addEventListener('click', () => changeInputPage(1));

  const { wrap: sideTasksGroup, body: sideTasksBody } = mkGroup('任务', { subtitle: 'todo_list' });
  Object.assign(sideTasksGroup.style, { minHeight: '0', flex: '1 1 0' });
  Object.assign(sideTasksBody.style, { display: 'flex', flexDirection: 'column', gap: '8px', minHeight: '0' });

  sideTasksSummaryEl = el('div', { fontSize: '12px', color: colors.textMuted });
  const btnCopySideTasks = mkBtn('复制任务');
  btnCopySideTasks.style.padding = '6px 8px';
  btnCopySideTasks.style.borderRadius = '10px';
  btnCopySideTasks.style.fontWeight = '650';

  const sideTasksMetaRow = el('div', {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
    flexWrap: 'wrap',
  });
  sideTasksMetaRow.appendChild(sideTasksSummaryEl);
  sideTasksMetaRow.appendChild(btnCopySideTasks);

  sideTasksListEl = el('div', {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    overflow: 'auto',
    minHeight: '0',
  });
  sideTasksBody.appendChild(sideTasksMetaRow);
  sideTasksBody.appendChild(sideTasksListEl);

  btnCopySideTasks.addEventListener('click', async () => {
    const windowId = state.selectedWindowId;
    const text = buildTodosMarkdown(windowId);
    if (!text) {
      appendEvent(windowId, { ts: new Date().toISOString(), source: 'system', kind: 'error', error: { message: '没有可复制的任务' } });
      return;
    }
    const ok = await copyToClipboard(text);
    if (!ok && typeof window !== 'undefined' && typeof window.prompt === 'function') {
      try {
        window.prompt('复制以下内容', text);
      } catch {
        // ignore
      }
    }
    appendEvent(windowId, { ts: new Date().toISOString(), source: 'system', kind: 'status', status: ok ? 'tasks copied' : 'tasks copy failed' });
  });

  rightPanel.appendChild(inputsGroup);
  rightPanel.appendChild(sideTasksGroup);
  renderInputHistory();
  renderSideTasks();

  body.appendChild(sidebar);
  body.appendChild(main);
  body.appendChild(rightPanel);
  root.appendChild(body);

  if (headerSlot) {
    try {
      headerSlot.textContent = '';
      headerSlot.appendChild(header);
    } catch {
      root.prepend(header);
    }
  } else {
    root.prepend(header);
  }

  try {
    container.textContent = '';
  } catch {
    // ignore
  }
  container.appendChild(root);

  const loadWindowLogs = async (windowId) => {
    const id = String(windowId || '');
    if (!id) return;
    const res = await invoke('codexGetWindowLogs', { windowId: id, limit: TRIM_WINDOW_EVENTS_TO });
    if (!res?.ok) return;
    const events = Array.isArray(res?.events) ? res.events : null;
    const lines = Array.isArray(res?.lines) ? res.lines : null;
    const items = events && events.length ? events : lines && lines.length ? lines : [];
    state.windowEvents.set(id, items);
    if (state.selectedWindowId === id) renderLog();
  };

  const loadWindowTasks = async (windowId) => {
    const id = String(windowId || '');
    if (!id) return;
    const res = await invoke('codexGetWindowTasks', { windowId: id });
    if (!res?.ok) return;
      const items = normalizeTodoItems(res?.todoList);
      state.windowTodos.set(id, {
        id: String(res?.todoListId || ''),
        items,
        updatedAt: String(res?.updatedAt || ''),
        eventType: 'window.snapshot',
      });
      const win = state.windows.find((w) => w.id === id);
      if (win) {
        win.todoList = items;
        win.todoListId = String(res?.todoListId || '');
        win.todoListUpdatedAt = String(res?.updatedAt || '');
      }
    if (state.selectedWindowId === id) {
      scheduleRenderSideTasks();
    }
  };

  const loadWindowInputs = async (windowId) => {
    const id = String(windowId || '');
    if (!id) return;
    const res = await invoke('codexGetWindowInputs', { windowId: id });
    if (!res?.ok) return;
    const items = Array.isArray(res?.items) ? res.items : [];
    state.windowInputs.set(id, items);
    if (state.selectedWindowId === id) scheduleRenderInputs();
  };

  const collectUiPromptRequestIds = async () => {
    if (!host?.uiPrompts?.read) return new Set();
    try {
      const payload = await host.uiPrompts.read();
      const entries = Array.isArray(payload?.entries) ? payload.entries : [];
      const ids = new Set();
      for (const entry of entries) {
        if (entry?.type === 'ui_prompt' && entry?.action === 'request' && entry?.requestId) {
          ids.add(String(entry.requestId));
        }
      }
      return ids;
    } catch {
      return new Set();
    }
  };

  const buildMcpResultPrompt = (task) => {
    const status = String(task?.status || '').toLowerCase();
    const statusLabel = status === 'completed' ? '完成' : status === 'failed' ? '失败' : status === 'aborted' ? '已中止' : status;
    const parts = [];
    if (task?.input) parts.push(`**任务**：${task.input}`);
    if (task?.workingDirectory) parts.push(`**目录**：\`${task.workingDirectory}\``);
    if (task?.windowId) parts.push(`**窗口**：\`${task.windowId}\``);
    if (statusLabel) parts.push(`**状态**：${statusLabel}`);
    if (task?.resultText) parts.push(`**输出**：\n\n${task.resultText}`);
    if (task?.error?.message) parts.push(`**错误**：${task.error.message}`);
    const markdown = parts.length ? parts.join('\n\n') : '😊';
    return {
      kind: 'result',
      title: '执行结果',
      message: status === 'completed' ? '任务已完成 😊' : `任务${statusLabel} 😊`,
      allowCancel: true,
      markdown,
    };
  };

  const maybeSendMcpPrompts = async (tasks) => {
    if (!host?.uiPrompts?.request) return;
    const existing = await collectUiPromptRequestIds();
    for (const task of tasks) {
      const status = String(task?.status || '').toLowerCase();
      if (status !== 'completed' && status !== 'failed' && status !== 'aborted') continue;
      const requestId = task?.promptRequestId || `mcp-task:${task.id}`;
      if (existing.has(requestId)) {
        if (!task?.promptSentAt) {
          try {
            await invoke('codexMarkMcpTaskPrompt', { taskId: task.id, requestId });
          } catch {
            // ignore
          }
        }
        continue;
      }
      try {
        const prompt = buildMcpResultPrompt(task);
        const res = await host.uiPrompts.request({ requestId, prompt });
        await invoke('codexMarkMcpTaskPrompt', { taskId: task.id, requestId: res?.requestId || requestId });
        existing.add(requestId);
      } catch {
        // ignore
      }
    }
  };

  const loadMcpTasks = async () => {
    try {
      const res = await invoke('codexListMcpTasks');
      if (!res?.ok) return;
      state.mcpTasks = Array.isArray(res?.tasks) ? res.tasks : [];
      renderTaskList();
      await maybeSendMcpPrompts(state.mcpTasks);
    } catch (e) {
      // ignore
    }
  };

  const refresh = async () => {
    if (promptInput && state.selectedWindowId) {
      saveInputDraft(state.selectedWindowId, promptInput.value);
    }
    try {
      state.env = await invoke('codexGetEnv');
    } catch {
      // ignore
    }

    const res = await invoke('codexListWindows');
    state.windows = Array.isArray(res?.windows) ? res.windows : [];
    if (state.selectedWindowId && !state.windows.some((w) => w.id === state.selectedWindowId)) {
      state.selectedWindowId = '';
    }
    if (!state.selectedWindowId && state.windows[0]?.id) state.selectedWindowId = state.windows[0].id;
    if (!state.selectedWindowId && !state.windows.length) {
      const created = await invoke('codexCreateWindow', {});
      if (created?.window) state.windows.push(created.window);
      state.selectedWindowId = state.windows[0]?.id || '';
    }

    const defaultSettings = getDefaultRunSettings();
    state.windows.forEach((win) => {
      ensureWindowRunSettings(win?.id, buildWindowSeedSettings(win, defaultSettings));
    });
    const selectedWin = state.windows.find((w) => w.id === state.selectedWindowId);
    applyRunSettingsToControls(ensureWindowRunSettings(state.selectedWindowId, buildWindowSeedSettings(selectedWin, defaultSettings)));
    const defaultCd = state.env?.sessionRootGitRoot || state.env?.cwdGitRoot || state.env?.sessionRoot || '';
    if (defaultCd && !workingDirInput.value) workingDirInput.value = String(defaultCd);
    if (!skipRepoExplicit) {
      const cd = String(workingDirInput.value || '').trim();
      if (cd) {
        try {
          const git = await invoke('codexGetGitInfo', { cwd: cd });
          skipRepoInput.checked = !Boolean(git?.isGitRepo);
          persistRunSettings();
        } catch {
          // ignore
        }
      }
    }

    for (const win of state.windows) {
      if (win?.activeRunId && (win.status === 'running' || win.status === 'aborting')) {
        startPolling(win.activeRunId, win.id);
      }
    }
    renderWindowList();
    updateSelectedHeader();
    applyInputDraft(state.selectedWindowId);
    await loadWindowLogs(state.selectedWindowId);
    await loadWindowTasks(state.selectedWindowId);
    await loadWindowInputs(state.selectedWindowId);
    await loadMcpTasks();
    renderLog();
    renderInputHistory();
    renderSideTasks();
  };

  btnRefresh.addEventListener('click', () =>
    refresh().catch((e) =>
      appendEvent(state.selectedWindowId, {
        ts: new Date().toISOString(),
        source: 'system',
        kind: 'error',
        error: { message: e?.message || String(e) },
      }),
    ),
  );

  btnNew.addEventListener('click', async () => {
    try {
      const res = await invoke('codexCreateWindow', {});
      if (res?.window) {
        saveWindowRunSettings(res.window.id, buildRunSettingsSnapshot());
        state.windows.push(res.window);
        setSelectedWindow(res.window.id);
      }
    } catch (e) {
      appendEvent(state.selectedWindowId, { ts: new Date().toISOString(), source: 'system', kind: 'error', error: { message: e?.message || String(e) } });
    }
  });

  btnResume.addEventListener('click', async () => {
    let threadId = '';
    try {
      if (host?.uiPrompts?.request) {
        const res = await host.uiPrompts.request({
          prompt: {
            kind: 'kv',
            title: '恢复 Codex 线程',
            message: '填写 threadId 后提交',
            fields: [{ key: 'threadId', label: 'threadId', placeholder: '例如 01J...', required: true }],
          },
        });
        threadId = String(res?.response?.values?.threadId || '').trim();
      } else if (typeof window !== 'undefined' && typeof window.prompt === 'function') {
        threadId = String(window.prompt('输入 Codex threadId') || '').trim();
      }
      if (!threadId) return;
      const created = await invoke('codexResumeWindow', { threadId });
      if (created?.window) {
        state.windows.push(created.window);
        setSelectedWindow(created.window.id);
      }
    } catch (e) {
      appendEvent(state.selectedWindowId, { ts: new Date().toISOString(), source: 'system', kind: 'error', error: { message: e?.message || String(e) } });
    }
  });

  windowNameInput.addEventListener('change', async () => {
    const windowId = state.selectedWindowId;
    const name = String(windowNameInput.value || '').trim();
    if (!windowId || !name) return;
    try {
      const res = await invoke('codexRenameWindow', { windowId, name });
      if (res?.window) {
        const idx = state.windows.findIndex((w) => w.id === res.window.id);
        if (idx >= 0) state.windows[idx] = res.window;
        renderWindowList();
      }
    } catch (e) {
      appendEvent(windowId, { ts: new Date().toISOString(), source: 'system', kind: 'error', error: { message: e?.message || String(e) } });
    }
  });

  threadIdValue.addEventListener('click', async () => {
    const text = String(threadIdValue.textContent || '').trim();
    if (!text || text === 'no thread') return;
    try {
      if (navigator?.clipboard?.writeText) await navigator.clipboard.writeText(text);
      appendEvent(state.selectedWindowId, { ts: new Date().toISOString(), source: 'system', kind: 'status', status: 'threadId copied' });
    } catch {
      // ignore
    }
  });

  rawInput.addEventListener('change', () => {
    state.rawJson = Boolean(rawInput.checked);
    renderLog();
  });

  scrollInput.addEventListener('change', () => {
    state.autoScroll = Boolean(scrollInput.checked);
  });

  btnClear.addEventListener('click', async () => {
    const windowId = state.selectedWindowId;
    if (!windowId) return;
    let cleared = false;
    try {
      await invoke('codexClearWindowLogs', { windowId });
      cleared = true;
    } catch (e) {
      appendEvent(windowId, { ts: new Date().toISOString(), source: 'system', kind: 'error', error: { message: e?.message || String(e) } });
    }
    if (!cleared) return;
    state.windowEvents.set(windowId, []);
    renderLog();
  });

  btnAbort.addEventListener('click', async () => {
    const windowId = state.selectedWindowId;
    if (!windowId) return;
    try {
      await invoke('codexAbort', { windowId });
      appendEvent(windowId, { ts: new Date().toISOString(), source: 'system', kind: 'status', status: 'aborting' });
    } catch (e) {
      appendEvent(windowId, { ts: new Date().toISOString(), source: 'system', kind: 'error', error: { message: e?.message || String(e) } });
    }
  });

  btnRun.addEventListener('click', async () => {
    const windowId = state.selectedWindowId;
    const input = String(promptInput.value || '').trim();
    if (!windowId || !input) return;

    const win = state.windows.find((w) => w.id === windowId);
    if (win && isRunningStatus(win.status)) {
      appendEvent(windowId, { ts: new Date().toISOString(), source: 'system', kind: 'error', error: { message: '该窗口正在运行中' } });
      return;
    }

    appendEvent(windowId, { ts: new Date().toISOString(), source: 'system', kind: 'user', message: input });
    promptInput.value = '';
    saveInputDraft(windowId, '');
    await recordWindowInput(windowId, input);

    btnRun.disabled = true;
    try {
      const net = netSelect.value === '' ? undefined : netSelect.value === 'true';
      const web = webSelect.value === '' ? undefined : webSelect.value === 'true';

      const options = {
        model: getModelValue() || undefined,
        modelReasoningEffort: String(reasoningSelect.value || '').trim() || undefined,
        experimentalWindowsSandboxEnabled: state.env?.platform === 'win32' ? Boolean(windowsSandboxInput.checked) : undefined,
        sandboxMode: String(sandboxSelect.value || '').trim() || undefined,
        workingDirectory: String(workingDirInput.value || '').trim() || undefined,
        skipGitRepoCheck: Boolean(skipRepoInput.checked),
        networkAccessEnabled: net,
        webSearchEnabled: web,
        approvalPolicy: String(approvalSelect.value || '').trim() || undefined,
      };

      const res = await invoke('codexRun', {
        windowId,
        input,
        codexCommand: String(codexCommandInput.value || '').trim() || 'codex',
        options,
      });

      if (res?.window) {
        const idx = state.windows.findIndex((w) => w.id === res.window.id);
        if (idx >= 0) state.windows[idx] = res.window;
        else state.windows.push(res.window);
        renderWindowList();
        updateSelectedHeader();
      }
      if (res?.run?.id) startPolling(res.run.id, windowId);
    } catch (e) {
      appendEvent(windowId, { ts: new Date().toISOString(), source: 'system', kind: 'error', error: { message: e?.message || String(e) } });
    } finally {
      updateSelectedHeader();
    }
  });

  refresh().catch((e) =>
    appendEvent(state.selectedWindowId, { ts: new Date().toISOString(), source: 'system', kind: 'error', error: { message: e?.message || String(e) } }, { render: false }),
  );
  mcpTaskTimer = setInterval(() => {
    loadMcpTasks();
  }, 2000);

  return () => {
    for (const id of state.pollTimers.values()) {
      try {
        clearInterval(id);
      } catch {
        // ignore
      }
    }
    state.pollTimers.clear();
    if (mcpTaskTimer) {
      try {
        clearInterval(mcpTaskTimer);
      } catch {
        // ignore
      }
      mcpTaskTimer = null;
    }
    if (themeUnsub) {
      try {
        themeUnsub();
      } catch {
        // ignore
      }
      themeUnsub = null;
    }
    try {
      container.textContent = '';
    } catch {
      // ignore
    }
  };
}
