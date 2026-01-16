export function mount({ container, host, slots }) {
  if (!container) throw new Error('container is required');
  if (!host || typeof host !== 'object') throw new Error('host is required');

  const headerSlot =
    slots?.header && typeof slots.header === 'object' && typeof slots.header.appendChild === 'function' ? slots.header : null;

  const ctx = typeof host?.context?.get === 'function' ? host.context.get() : { pluginId: '', appId: '', theme: 'light' };
  const bridgeEnabled = Boolean(ctx?.bridge?.enabled);

  const normalizeTheme = (value) => (String(value || '').toLowerCase() === 'dark' ? 'dark' : 'light');
  const getHostTheme = () => {
    try {
      if (typeof host?.theme?.get === 'function') return host.theme.get();
    } catch {
      // ignore
    }
    return ctx?.theme || document?.documentElement?.dataset?.theme || '';
  };
  let activeTheme = normalizeTheme(getHostTheme());

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

  const themeTokens = {
    dark: {
      pageBg:
        'radial-gradient(1200px 700px at 18% 12%, rgba(34,211,238,0.18), transparent 55%), radial-gradient(1000px 600px at 78% 8%, rgba(167,139,250,0.16), transparent 55%), radial-gradient(900px 600px at 30% 90%, rgba(96,165,250,0.10), transparent 55%), linear-gradient(180deg, #05070d 0%, #050913 55%, #05070d 100%)',
      border: 'var(--ds-panel-border, rgba(255,255,255,0.12))',
      borderStrong: 'var(--ds-panel-border, rgba(255,255,255,0.18))',
      bg: 'var(--ds-subtle-bg, rgba(255,255,255,0.06))',
      bgHover: 'var(--ds-selected-bg, rgba(255,255,255,0.09))',
      panel: 'var(--ds-panel-bg, rgba(255,255,255,0.04))',
      panelHover: 'var(--ds-panel-bg, rgba(255,255,255,0.06))',
      logBg: 'var(--ds-code-bg, rgba(0,0,0,0.55))',
      textMuted: 'rgba(255,255,255,0.70)',
      textStrong: 'rgba(255,255,255,0.92)',
      accent: 'var(--ds-accent, #22d3ee)',
      accent2: 'var(--ds-accent-2, #a78bfa)',
      accentBorder: 'var(--ds-accent, rgba(34,211,238,0.55))',
      accentGlow: 'rgba(34,211,238,0.16)',
      gridOpacity: '0.12',
      danger: '#ef4444',
      dangerBorder: 'rgba(239,68,68,0.55)',
      dangerBg: 'rgba(239,68,68,0.12)',
      dangerBgHover: 'rgba(239,68,68,0.16)',
      primaryText: '#071018',
      shadow: '0 22px 70px rgba(0,0,0,0.45)',
      panelShadow: 'var(--ds-panel-shadow, 0 16px 50px rgba(0,0,0,0.35))',
      titleGlow: '0 0 22px rgba(34,211,238,0.20)',
    },
    light: {
      pageBg:
        'radial-gradient(1200px 700px at 18% 12%, rgba(37,99,235,0.12), transparent 58%), radial-gradient(900px 600px at 78% 8%, rgba(6,182,212,0.10), transparent 55%), linear-gradient(180deg, #f8fafc 0%, #f1f5f9 100%)',
      border: 'var(--ds-panel-border, rgba(0,0,0,0.12))',
      borderStrong: 'var(--ds-panel-border, rgba(0,0,0,0.18))',
      bg: 'var(--ds-subtle-bg, rgba(0,0,0,0.04))',
      bgHover: 'var(--ds-selected-bg, rgba(0,0,0,0.06))',
      panel: 'var(--ds-panel-bg, rgba(0,0,0,0.02))',
      panelHover: 'var(--ds-panel-bg, rgba(0,0,0,0.04))',
      logBg: 'var(--ds-code-bg, rgba(255,255,255,0.75))',
      textMuted: 'rgba(0,0,0,0.65)',
      textStrong: 'rgba(0,0,0,0.92)',
      accent: 'var(--ds-accent, #2563eb)',
      accent2: 'var(--ds-accent-2, #06b6d4)',
      accentBorder: 'var(--ds-accent, rgba(37,99,235,0.55))',
      accentGlow: 'rgba(37,99,235,0.16)',
      gridOpacity: '0.06',
      danger: '#ef4444',
      dangerBorder: 'rgba(239,68,68,0.55)',
      dangerBg: 'rgba(239,68,68,0.10)',
      dangerBgHover: 'rgba(239,68,68,0.12)',
      primaryText: '#ffffff',
      shadow: '0 18px 55px rgba(2,6,23,0.12)',
      panelShadow: 'var(--ds-panel-shadow, 0 14px 40px rgba(2,6,23,0.10))',
      titleGlow: '0 0 18px rgba(37,99,235,0.12)',
    },
  };

  let renderMeta = null;
  let themeUnsub = null;
  const themedSelects = new Set();

  const applySelectTheme = (select) => {
    if (!select) return;
    select.style.colorScheme = activeTheme;
    select.style.background = colors.bg;
    select.style.color = colors.textStrong;
    select.style.borderColor = colors.borderStrong;
    const options = select.querySelectorAll('option');
    options.forEach((opt) => {
      opt.style.background = colors.panel;
      opt.style.color = colors.textStrong;
    });
  };

  const applyTheme = (theme) => {
    const nextTheme = normalizeTheme(theme);
    activeTheme = nextTheme;
    const palette = themeTokens[nextTheme] || themeTokens.light;
    if (root) {
      root.dataset.theme = nextTheme;
      root.style.setProperty('--codex-page-bg', palette.pageBg);
      root.style.setProperty('--codex-border', palette.border);
      root.style.setProperty('--codex-border-strong', palette.borderStrong);
      root.style.setProperty('--codex-bg', palette.bg);
      root.style.setProperty('--codex-bg-hover', palette.bgHover);
      root.style.setProperty('--codex-panel', palette.panel);
      root.style.setProperty('--codex-panel-hover', palette.panelHover);
      root.style.setProperty('--codex-log-bg', palette.logBg);
      root.style.setProperty('--codex-text-muted', palette.textMuted);
      root.style.setProperty('--codex-text-strong', palette.textStrong);
      root.style.setProperty('--codex-accent', palette.accent);
      root.style.setProperty('--codex-accent-2', palette.accent2);
      root.style.setProperty('--codex-accent-border', palette.accentBorder);
      root.style.setProperty('--codex-accent-glow', palette.accentGlow);
      root.style.setProperty('--codex-grid-opacity', palette.gridOpacity);
      root.style.setProperty('--codex-danger', palette.danger);
      root.style.setProperty('--codex-danger-border', palette.dangerBorder);
      root.style.setProperty('--codex-danger-bg', palette.dangerBg);
      root.style.setProperty('--codex-danger-bg-hover', palette.dangerBgHover);
      root.style.setProperty('--codex-primary-text', palette.primaryText);
      root.style.setProperty('--codex-shadow', palette.shadow);
      root.style.setProperty('--codex-panel-shadow', palette.panelShadow);
      root.style.setProperty('--codex-title-glow', palette.titleGlow);
    }
    if (renderMeta) renderMeta(nextTheme);
    themedSelects.forEach((select) => applySelectTheme(select));
  };

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
`;
  try {
    (document.head || document.documentElement).appendChild(styleEl);
  } catch {
    // ignore
  }

  const el = (tag, style) => {
    const node = document.createElement(tag);
    if (style && typeof style === 'object') Object.assign(node.style, style);
    return node;
  };

  const mkBtn = (label, { variant = 'default' } = {}) => {
    const isPrimary = variant === 'primary';
    const isDanger = variant === 'danger';
    const btn = el('button', {
      padding: '9px 10px',
      borderRadius: '12px',
      border: `1px solid ${isPrimary ? colors.accentBorder : isDanger ? colors.dangerBorder : colors.borderStrong}`,
      background: isPrimary
        ? `linear-gradient(135deg, ${colors.accent} 0%, ${colors.accent2} 80%)`
        : isDanger
          ? colors.dangerBg
          : colors.bg,
      cursor: 'pointer',
      fontWeight: '650',
      color: isPrimary ? colors.primaryText : isDanger ? colors.danger : colors.textStrong,
    });
    btn.type = 'button';
    btn.textContent = label;
    btn.addEventListener('mouseenter', () => {
      if (isPrimary) btn.style.filter = 'brightness(1.05)';
      else if (isDanger) btn.style.background = colors.dangerBgHover;
      else btn.style.background = colors.bgHover;
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.filter = '';
      btn.style.background = isPrimary
        ? `linear-gradient(135deg, ${colors.accent} 0%, ${colors.accent2} 80%)`
        : isDanger
          ? colors.dangerBg
          : colors.bg;
    });
    return btn;
  };

  const mkInput = (placeholder) => {
    const input = el('input', {
      width: '100%',
      boxSizing: 'border-box',
      borderRadius: '12px',
      border: `1px solid ${colors.borderStrong}`,
      background: colors.bg,
      padding: '9px 10px',
      outline: 'none',
      color: colors.textStrong,
    });
    input.type = 'text';
    input.placeholder = placeholder || '';
    return input;
  };

  const mkSelect = (options) => {
    const select = el('select', {
      width: '100%',
      boxSizing: 'border-box',
      borderRadius: '12px',
      border: `1px solid ${colors.borderStrong}`,
      background: colors.bg,
      padding: '9px 10px',
      outline: 'none',
      color: colors.textStrong,
    });
    for (const opt of options) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      select.appendChild(o);
    }
    themedSelects.add(select);
    applySelectTheme(select);
    return select;
  };

  const mkCheckbox = (label) => {
    const wrap = el('label', { display: 'flex', alignItems: 'center', gap: '8px', userSelect: 'none' });
    const input = document.createElement('input');
    input.type = 'checkbox';
    const text = el('div', { fontSize: '12px', color: colors.textMuted });
    text.textContent = label;
    wrap.appendChild(input);
    wrap.appendChild(text);
    return { wrap, input };
  };

  const mkField = (label, control, { hint = '', fullWidth = false } = {}) => {
    const wrap = el('div', { display: 'flex', flexDirection: 'column', gap: '6px' });
    const title = el('div', { fontSize: '12px', color: colors.textMuted, fontWeight: '650' });
    title.textContent = label;
    wrap.appendChild(title);
    wrap.appendChild(control);
    if (hint) {
      const hintEl = el('div', { fontSize: '12px', color: colors.textMuted, lineHeight: '1.4' });
      hintEl.textContent = hint;
      wrap.appendChild(hintEl);
    }
    if (fullWidth) wrap.style.gridColumn = '1 / -1';
    return wrap;
  };

  const mkGroup = (title, { subtitle = '' } = {}) => {
    const wrap = el('div', {
      border: `1px solid ${colors.border}`,
      borderRadius: '14px',
      background: colors.panelHover,
      padding: '12px',
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
      backdropFilter: 'blur(10px)',
      WebkitBackdropFilter: 'blur(10px)',
    });
    const head = el('div', { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' });
    const h = el('div', { fontWeight: '850', color: colors.textStrong, letterSpacing: '0.2px' });
    h.textContent = title;
    head.appendChild(h);
    if (subtitle) {
      const s = el('div', { fontSize: '12px', color: colors.textMuted });
      s.textContent = subtitle;
      head.appendChild(s);
    }
    const body = el('div', { display: 'grid', gap: '10px' });
    wrap.appendChild(head);
    wrap.appendChild(body);
    return { wrap, body };
  };

  const styleCheckboxCard = (wrap) => {
    Object.assign(wrap.style, {
      border: `1px solid ${colors.borderStrong}`,
      borderRadius: '12px',
      background: colors.bg,
      padding: '10px 10px',
      boxSizing: 'border-box',
      minHeight: '40px',
    });
  };

  const mkBadge = (text, { fg = colors.textMuted, bg = 'transparent', border = colors.borderStrong } = {}) => {
    const badge = el('div', {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '2px 8px',
      borderRadius: '999px',
      border: `1px solid ${border}`,
      color: fg,
      background: bg,
      fontSize: '11px',
      fontWeight: '750',
      lineHeight: '1.4',
      userSelect: 'none',
      whiteSpace: 'nowrap',
    });
    badge.textContent = String(text || '');
    return badge;
  };

  const state = {
    env: null,
    windows: [],
    selectedWindowId: '',
    windowEvents: new Map(), // windowId -> StoredEvent[]
    windowTodos: new Map(), // windowId -> { id, items, updatedAt, eventType }
    windowInputs: new Map(), // windowId -> { ts, text }[]
    inputPages: new Map(), // windowId -> page index
    runCursors: new Map(), // runId -> cursor
    pollTimers: new Map(), // runId -> intervalId
    rawJson: false,
    autoScroll: true,
  };

  const MAX_WINDOW_EVENTS = 2500;
  const TRIM_WINDOW_EVENTS_TO = 2000;
  const LOG_RENDER_CHAR_BUDGET = 250000;
  const MAX_WINDOW_INPUTS = 500;
  const INPUT_PAGE_SIZE = 6;

  const RUN_SETTINGS_STORAGE_KEY = 'codex_app.run_settings.v1';

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

  const invoke = async (method, params) => {
    if (!host?.backend?.invoke) throw new Error('host.backend.invoke is not available');
    return await host.backend.invoke(method, params);
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

  const formatTime = (ts) => {
    const s = String(ts || '');
    if (s.length >= 19 && s.includes('T')) return s.slice(11, 19);
    return s || new Date().toISOString().slice(11, 19);
  };

  const clampNumber = (value, min, max) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
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

  const normalizeTodoItems = (items) => {
    if (!Array.isArray(items)) return [];
    return items
      .map((it) => (it && typeof it === 'object' ? { text: String(it.text || '').trim(), completed: Boolean(it.completed) } : null))
      .filter((it) => it && it.text);
  };

  const captureTodoFromEvent = (windowId, evt) => {
    if (evt?.source !== 'codex' || !evt?.event) return;
    const e = evt.event;
    if (e?.type !== 'item.started' && e?.type !== 'item.updated' && e?.type !== 'item.completed') return;
    if (e?.item?.type !== 'todo_list') return;
    const items = normalizeTodoItems(e?.item?.items);
    state.windowTodos.set(String(windowId || ''), {
      id: String(e?.item?.id || ''),
      items,
      updatedAt: evt?.ts || new Date().toISOString(),
      eventType: String(e?.type || ''),
    });
    if (state.selectedWindowId === String(windowId || '')) {
      scheduleRenderSideTasks();
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

  const buildLogModel = (windowId) => {
    const events = getEvents(windowId);
    if (!events.length) return { items: [], lines: [] };

    const kept = [];
    const lines = [];
    let chars = 0;
    let omitted = 0;

    for (let i = events.length - 1; i >= 0; i--) {
      const evt = events[i];
      if (isLineItem(evt)) {
        const line = getLineText(evt);
        const cost = line.length + 1;
        if (chars + cost > LOG_RENDER_CHAR_BUDGET) {
          if (!kept.length) {
            const keep = Math.max(0, LOG_RENDER_CHAR_BUDGET - 32);
            const truncatedLine = `${line.slice(0, keep)}…(truncated)`;
            kept.push({ kind: 'meta', text: truncatedLine });
            lines.push(truncatedLine);
          } else {
            omitted = i + 1;
          }
          break;
        }
        kept.push({ kind: 'meta', text: line });
        lines.push(line);
        chars += cost;
        continue;
      }

      const line = formatStoredEvent(evt);
      const cost = line.length + 1;
      if (chars + cost > LOG_RENDER_CHAR_BUDGET) {
        if (!kept.length) {
          const keep = Math.max(0, LOG_RENDER_CHAR_BUDGET - 32);
          const truncatedLine = `${line.slice(0, keep)}…(truncated)`;
          kept.push({ kind: 'meta', text: truncatedLine });
          lines.push(truncatedLine);
        } else {
          omitted = i + 1;
        }
        break;
      }
      kept.push({ kind: 'event', evt });
      lines.push(line);
      chars += cost;
    }

    kept.reverse();
    lines.reverse();
    if (omitted > 0) {
      const msg = `[…省略更早的 ${omitted} 条日志…]`;
      kept.unshift({ kind: 'meta', text: msg });
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
    const { lines } = buildLogModel(windowId);
    logEl.textContent = lines.length ? `${lines.join('\n')}\n` : '';
    if (lines.length && state.autoScroll) logEl.scrollTop = logEl.scrollHeight;
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
    state.selectedWindowId = String(windowId || '');
    renderWindowList();
    updateSelectedHeader();
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

  const stopPolling = (runId) => {
    const id = state.pollTimers.get(runId);
    if (id) clearInterval(id);
    state.pollTimers.delete(runId);
    state.runCursors.delete(runId);
  };

  const startPolling = (runId, windowId) => {
    if (state.pollTimers.has(runId)) return;
    state.runCursors.set(runId, 0);

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
  renderMeta = (theme) => {
    meta.textContent = `${ctx?.pluginId || ''}:${ctx?.appId || ''} · theme=${theme || 'light'} · bridge=${bridgeEnabled ? 'enabled' : 'disabled'}`;
  };

  header.appendChild(headerTop);
  header.appendChild(meta);

  applyTheme(activeTheme);
  if (typeof host?.theme?.onChange === 'function') {
    themeUnsub = host.theme.onChange((theme) => applyTheme(theme));
  }

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

  sidebar.appendChild(sidebarHint);
  sidebar.appendChild(windowList);

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
  sandboxSelect.value = 'workspace-write';

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

  const persisted = loadRunSettings() || {};
  let hadPersistedModel = false;
  if (typeof persisted.codexCommand === 'string' && persisted.codexCommand.trim()) {
    codexCommandInput.value = persisted.codexCommand.trim();
  }
  if (typeof persisted.workingDirectory === 'string') workingDirInput.value = persisted.workingDirectory;
  if (typeof persisted.model === 'string') {
    hadPersistedModel = true;
    const saved = persisted.model.trim();
    const known = new Set(['', 'gpt-5.2', 'gpt-5.2-codex']);
    if (known.has(saved)) {
      modelSelect.value = saved;
      modelCustomInput.value = '';
    } else {
      modelSelect.value = MODEL_CUSTOM;
      modelCustomInput.value = saved;
    }
  }
  if (typeof persisted.modelReasoningEffort === 'string') reasoningSelect.value = persisted.modelReasoningEffort;
  if (typeof persisted.experimentalWindowsSandboxEnabled === 'boolean') windowsSandboxInput.checked = persisted.experimentalWindowsSandboxEnabled;
  if (typeof persisted.sandboxMode === 'string') sandboxSelect.value = persisted.sandboxMode;
  if (typeof persisted.approvalPolicy === 'string') approvalSelect.value = persisted.approvalPolicy;
  if (typeof persisted.networkAccessEnabled === 'string') netSelect.value = persisted.networkAccessEnabled;
  if (typeof persisted.webSearchEnabled === 'string') webSelect.value = persisted.webSearchEnabled;
  if (typeof persisted.skipGitRepoCheck === 'boolean') skipRepoInput.checked = persisted.skipGitRepoCheck;

  if (!hadPersistedModel && !modelSelect.value) modelSelect.value = 'gpt-5.2';
  updateModelUi();

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

  const persistRunSettings = () => {
    saveRunSettings({
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
    });
  };

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
  skipRepoInput.addEventListener('change', persistRunSettings);
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
      if (typeof persisted.skipGitRepoCheck !== 'boolean') {
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
    minHeight: '100px',
    boxSizing: 'border-box',
    borderRadius: '14px',
    border: `1px solid ${colors.borderStrong}`,
    background: colors.bg,
    padding: '10px 10px',
    resize: 'vertical',
    outline: 'none',
    color: colors.textStrong,
  });

  const { wrap: promptGroup, body: promptBody } = mkGroup('输入', { subtitle: '这里的内容会通过 stdin 传给 codex exec' });
  promptBody.appendChild(promptInput);

  const controls = el('div', { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' });
  const btnRun = mkBtn('运行', { variant: 'primary' });
  const btnAbort = mkBtn('停止', { variant: 'danger' });
  const btnClear = mkBtn('清空日志');

  const { wrap: rawWrap, input: rawInput } = mkCheckbox('Raw JSON');
  const { wrap: scrollWrap, input: scrollInput } = mkCheckbox('自动滚动');
  scrollInput.checked = true;

  controls.appendChild(btnRun);
  controls.appendChild(btnAbort);
  controls.appendChild(btnClear);
  controls.appendChild(rawWrap);
  controls.appendChild(scrollWrap);

  const { wrap: controlGroup, body: controlBody } = mkGroup('操作', { subtitle: '运行、停止、清理，以及显示选项' });
  controlBody.appendChild(controls);

  const viewBar = el('div', { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '10px', flexWrap: 'wrap' });
  const btnCopyLog = mkBtn('复制日志');
  btnCopyLog.style.padding = '7px 10px';
  btnCopyLog.style.borderRadius = '999px';
  viewBar.appendChild(btnCopyLog);

  const logEl = el('pre', {
    border: '0',
    borderRadius: '14px',
    padding: '12px',
    margin: '0',
    overflow: 'auto',
    minHeight: '0',
    minWidth: '0',
    flex: '1',
    background: colors.logBg,
    color: colors.textStrong,
    fontSize: '13px',
    lineHeight: '1.55',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  });

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
      win.todoList = Array.isArray(res?.todoList) ? res.todoList : [];
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

  const refresh = async () => {
    try {
      state.env = await invoke('codexGetEnv');
      const defaultCd = state.env?.sessionRootGitRoot || state.env?.cwdGitRoot || state.env?.sessionRoot || '';
      if (defaultCd && !workingDirInput.value) workingDirInput.value = String(defaultCd);
      if (typeof persisted.skipGitRepoCheck !== 'boolean') {
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
      updateWindowsSandboxUi();
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

    for (const win of state.windows) {
      if (win?.activeRunId && (win.status === 'running' || win.status === 'aborting')) {
        startPolling(win.activeRunId, win.id);
      }
    }
    renderWindowList();
    updateSelectedHeader();
    await loadWindowLogs(state.selectedWindowId);
    await loadWindowTasks(state.selectedWindowId);
    await loadWindowInputs(state.selectedWindowId);
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
    if (win && win.status === 'running') {
      appendEvent(windowId, { ts: new Date().toISOString(), source: 'system', kind: 'error', error: { message: '该窗口正在运行中' } });
      return;
    }

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
      btnRun.disabled = false;
    }
  });

  refresh().catch((e) =>
    appendEvent(state.selectedWindowId, { ts: new Date().toISOString(), source: 'system', kind: 'error', error: { message: e?.message || String(e) } }, { render: false }),
  );

  return () => {
    for (const id of state.pollTimers.values()) {
      try {
        clearInterval(id);
      } catch {
        // ignore
      }
    }
    state.pollTimers.clear();
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
