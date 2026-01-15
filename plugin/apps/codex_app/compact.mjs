export function mount({ container, host }) {
  if (!container) throw new Error('container is required');

  const ctx = typeof host?.context?.get === 'function' ? host.context.get() : {};
  const invoke = async (method, params) => {
    if (!host?.backend?.invoke) throw new Error('host.backend.invoke is not available');
    return await host.backend.invoke(method, params);
  };

  const state = {
    windows: [],
    selectedWindowId: '',
    logs: [],
    tasks: [],
  };

  const root = document.createElement('div');
  root.style.height = '100%';
  root.style.boxSizing = 'border-box';
  root.style.padding = '12px';
  root.style.display = 'flex';
  root.style.flexDirection = 'column';
  root.style.gap = '10px';
  root.style.color = 'var(--ds-text-primary, rgba(0,0,0,0.92))';
  root.style.fontFamily =
    'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"';

  const header = document.createElement('div');
  header.style.display = 'flex';
  header.style.flexDirection = 'column';
  header.style.gap = '4px';

  const title = document.createElement('div');
  title.textContent = 'Codex 控制台（紧凑）';
  title.style.fontWeight = '750';
  title.style.fontSize = '14px';

  const meta = document.createElement('div');
  meta.style.fontSize = '12px';
  meta.style.color = 'var(--ds-text-secondary, rgba(0,0,0,0.65))';
  meta.textContent = `${ctx?.pluginId || ''}:${ctx?.appId || ''}`;

  header.appendChild(title);
  header.appendChild(meta);

  const mkBtn = (label, { variant = 'default' } = {}) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.style.padding = '6px 10px';
    btn.style.borderRadius = '10px';
    btn.style.border = '1px solid var(--ds-panel-border, rgba(0,0,0,0.12))';
    btn.style.background = 'var(--ds-subtle-bg, rgba(0,0,0,0.04))';
    btn.style.cursor = 'pointer';
    btn.style.fontWeight = '650';
    if (variant === 'primary') {
      btn.style.border = '1px solid var(--ds-accent, rgba(37,99,235,0.55))';
      btn.style.background = 'linear-gradient(135deg, var(--ds-accent, #2563eb) 0%, var(--ds-accent-2, #06b6d4) 90%)';
      btn.style.color = '#ffffff';
    } else if (variant === 'danger') {
      btn.style.border = '1px solid rgba(239,68,68,0.55)';
      btn.style.background = 'rgba(239,68,68,0.10)';
      btn.style.color = '#ef4444';
    }
    return btn;
  };

  const mkPanel = () => {
    const panel = document.createElement('div');
    panel.style.border = '1px solid var(--ds-panel-border, rgba(0,0,0,0.12))';
    panel.style.borderRadius = '12px';
    panel.style.background = 'var(--ds-panel-bg, rgba(0,0,0,0.02))';
    panel.style.padding = '10px';
    panel.style.display = 'flex';
    panel.style.flexDirection = 'column';
    panel.style.gap = '8px';
    return panel;
  };

  const controls = document.createElement('div');
  controls.style.display = 'flex';
  controls.style.alignItems = 'center';
  controls.style.gap = '8px';

  const windowSelect = document.createElement('select');
  windowSelect.style.flex = '1';
  windowSelect.style.padding = '6px 8px';
  windowSelect.style.borderRadius = '10px';
  windowSelect.style.border = '1px solid var(--ds-panel-border, rgba(0,0,0,0.12))';
  windowSelect.style.background = 'var(--ds-subtle-bg, rgba(0,0,0,0.04))';
  windowSelect.style.color = 'inherit';

  const btnRefresh = mkBtn('刷新');
  const btnStop = mkBtn('停止', { variant: 'danger' });

  controls.appendChild(windowSelect);
  controls.appendChild(btnRefresh);
  controls.appendChild(btnStop);

  const inputPanel = mkPanel();
  const inputLabel = document.createElement('div');
  inputLabel.textContent = '发送消息';
  inputLabel.style.fontSize = '12px';
  inputLabel.style.color = 'var(--ds-text-secondary, rgba(0,0,0,0.65))';

  const input = document.createElement('textarea');
  input.placeholder = '输入要发送给 Codex 的内容…';
  input.style.width = '100%';
  input.style.minHeight = '64px';
  input.style.resize = 'vertical';
  input.style.borderRadius = '10px';
  input.style.border = '1px solid var(--ds-panel-border, rgba(0,0,0,0.14))';
  input.style.background = 'var(--ds-subtle-bg, rgba(0,0,0,0.04))';
  input.style.padding = '8px';
  input.style.outline = 'none';

  const inputActions = document.createElement('div');
  inputActions.style.display = 'flex';
  inputActions.style.justifyContent = 'flex-end';
  const btnSend = mkBtn('发送', { variant: 'primary' });
  inputActions.appendChild(btnSend);

  inputPanel.appendChild(inputLabel);
  inputPanel.appendChild(input);
  inputPanel.appendChild(inputActions);

  const content = document.createElement('div');
  content.style.display = 'flex';
  content.style.flexDirection = 'column';
  content.style.gap = '10px';
  content.style.flex = '1';
  content.style.minHeight = '0';

  const logPanel = mkPanel();
  logPanel.style.flex = '1';
  logPanel.style.minHeight = '0';

  const logTitle = document.createElement('div');
  logTitle.textContent = '日志';
  logTitle.style.fontSize = '12px';
  logTitle.style.color = 'var(--ds-text-secondary, rgba(0,0,0,0.65))';

  const logEl = document.createElement('pre');
  logEl.style.margin = '0';
  logEl.style.flex = '1';
  logEl.style.minHeight = '120px';
  logEl.style.overflow = 'auto';
  logEl.style.padding = '8px';
  logEl.style.borderRadius = '10px';
  logEl.style.border = '1px solid var(--ds-code-border, rgba(0,0,0,0.12))';
  logEl.style.background = 'var(--ds-code-bg, rgba(0,0,0,0.04))';
  logEl.style.fontSize = '11px';
  logEl.style.lineHeight = '1.4';
  logEl.style.whiteSpace = 'pre-wrap';
  logEl.style.wordBreak = 'break-word';

  logPanel.appendChild(logTitle);
  logPanel.appendChild(logEl);

  const tasksPanel = mkPanel();
  const tasksTitle = document.createElement('div');
  tasksTitle.textContent = '任务';
  tasksTitle.style.fontSize = '12px';
  tasksTitle.style.color = 'var(--ds-text-secondary, rgba(0,0,0,0.65))';

  const tasksSummary = document.createElement('div');
  tasksSummary.style.fontSize = '12px';
  tasksSummary.style.color = 'var(--ds-text-secondary, rgba(0,0,0,0.65))';

  const tasksList = document.createElement('div');
  tasksList.style.display = 'flex';
  tasksList.style.flexDirection = 'column';
  tasksList.style.gap = '6px';
  tasksList.style.maxHeight = '140px';
  tasksList.style.overflow = 'auto';

  tasksPanel.appendChild(tasksTitle);
  tasksPanel.appendChild(tasksSummary);
  tasksPanel.appendChild(tasksList);

  content.appendChild(logPanel);
  content.appendChild(tasksPanel);

  root.appendChild(header);
  root.appendChild(controls);
  root.appendChild(inputPanel);
  root.appendChild(content);

  const formatEvent = (evt) => {
    if (!evt) return '';
    if (typeof evt === 'string') return evt;
    if (evt?.line) return String(evt.line);
    if (evt?.source === 'stderr') return `[stderr] ${String(evt.text || '').trimEnd()}`;
    if (evt?.source === 'raw') return `[raw] ${String(evt.text || '').trimEnd()}`;
    if (evt?.source === 'system') {
      if (evt.kind === 'status') return `[status] ${String(evt.status || '')}`;
      if (evt.kind === 'warning') return `[warning] ${String(evt.message || '')}`;
      if (evt.kind === 'error') return `[error] ${String(evt?.error?.message || evt.message || '')}`;
    }
    if (evt?.source === 'codex' && evt?.event) {
      const type = String(evt.event.type || 'event');
      return `[codex] ${type}`;
    }
    try {
      return JSON.stringify(evt);
    } catch {
      return String(evt);
    }
  };

  const setStatusMeta = () => {
    const win = state.windows.find((w) => w.id === state.selectedWindowId) || null;
    const status = win ? String(win.status || 'idle') : 'idle';
    const name = win ? String(win.name || win.id || '') : 'no window';
    meta.textContent = `${ctx?.pluginId || ''}:${ctx?.appId || ''} · ${name} · ${status}`;
  };

  const renderWindows = () => {
    windowSelect.textContent = '';
    for (const win of state.windows) {
      const option = document.createElement('option');
      option.value = win.id;
      const status = String(win.status || 'idle');
      option.textContent = `${win.name || win.id} · ${status}`;
      windowSelect.appendChild(option);
    }
    if (state.selectedWindowId) windowSelect.value = state.selectedWindowId;
    setStatusMeta();
  };

  const renderLogs = () => {
    if (!state.logs.length) {
      logEl.textContent = '暂无日志';
      return;
    }
    const lines = state.logs.map(formatEvent).filter(Boolean);
    logEl.textContent = lines.join('\n');
    logEl.scrollTop = logEl.scrollHeight;
  };

  const renderTasks = () => {
    const items = Array.isArray(state.tasks) ? state.tasks : [];
    tasksList.textContent = '';
    if (!items.length) {
      tasksSummary.textContent = '暂无任务';
      return;
    }
    const done = items.filter((it) => it?.completed).length;
    tasksSummary.textContent = `进度 ${done}/${items.length}`;
    for (const it of items) {
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.alignItems = 'flex-start';
      row.style.gap = '8px';
      row.style.padding = '6px 8px';
      row.style.borderRadius = '10px';
      row.style.border = '1px solid var(--ds-panel-border, rgba(0,0,0,0.12))';
      row.style.background = 'var(--ds-subtle-bg, rgba(0,0,0,0.04))';

      const mark = document.createElement('div');
      mark.textContent = it?.completed ? '✓' : '';
      mark.style.width = '16px';
      mark.style.height = '16px';
      mark.style.borderRadius = '6px';
      mark.style.display = 'flex';
      mark.style.alignItems = 'center';
      mark.style.justifyContent = 'center';
      mark.style.fontSize = '11px';
      mark.style.fontWeight = '700';
      mark.style.color = it?.completed ? '#0b1020' : 'var(--ds-text-secondary, rgba(0,0,0,0.6))';
      mark.style.background = it?.completed ? '#22c55e' : 'transparent';
      mark.style.border = it?.completed ? '0' : '1px solid var(--ds-panel-border, rgba(0,0,0,0.12))';

      const text = document.createElement('div');
      text.textContent = String(it?.text || '');
      text.style.fontSize = '12px';
      text.style.lineHeight = '1.4';
      text.style.color = it?.completed ? 'var(--ds-text-secondary, rgba(0,0,0,0.6))' : 'inherit';
      text.style.textDecoration = it?.completed ? 'line-through' : 'none';

      row.appendChild(mark);
      row.appendChild(text);
      tasksList.appendChild(row);
    }
  };

  const loadLogs = async (windowId) => {
    if (!windowId) {
      state.logs = [];
      renderLogs();
      return;
    }
    const res = await invoke('codexGetWindowLogs', { windowId, limit: 200 });
    if (!res?.ok) return;
    if (Array.isArray(res?.events) && res.events.length) state.logs = res.events;
    else state.logs = Array.isArray(res?.lines) ? res.lines : [];
    renderLogs();
  };

  const loadTasks = async (windowId) => {
    if (!windowId) {
      state.tasks = [];
      renderTasks();
      return;
    }
    const res = await invoke('codexGetWindowTasks', { windowId });
    state.tasks = Array.isArray(res?.todoList) ? res.todoList : [];
    renderTasks();
  };

  const refreshWindows = async () => {
    const res = await invoke('codexListWindows');
    state.windows = Array.isArray(res?.windows) ? res.windows : [];
    if (state.selectedWindowId && !state.windows.some((w) => w.id === state.selectedWindowId)) {
      state.selectedWindowId = '';
    }
    if (!state.selectedWindowId && state.windows[0]?.id) state.selectedWindowId = state.windows[0].id;
    if (!state.selectedWindowId && !state.windows.length) {
      const created = await invoke('codexCreateWindow', {});
      if (created?.window) {
        state.windows = [created.window];
        state.selectedWindowId = created.window.id;
      }
    }
    renderWindows();
  };

  const refreshAll = async () => {
    await refreshWindows();
    await loadLogs(state.selectedWindowId);
    await loadTasks(state.selectedWindowId);
  };

  windowSelect.addEventListener('change', () => {
    state.selectedWindowId = windowSelect.value;
    setStatusMeta();
    loadLogs(state.selectedWindowId).catch(() => {});
    loadTasks(state.selectedWindowId).catch(() => {});
  });

  btnRefresh.addEventListener('click', () => {
    refreshAll().catch((e) => {
      state.logs = [`[error] ${e?.message || String(e)}`];
      renderLogs();
    });
  });

  btnStop.addEventListener('click', async () => {
    const windowId = state.selectedWindowId;
    if (!windowId) return;
    try {
      await invoke('codexAbort', { windowId });
      await refreshAll();
    } catch (e) {
      state.logs = [`[error] ${e?.message || String(e)}`];
      renderLogs();
    }
  });

  const pickRunOptions = (win) => {
    const source = win?.lastRunOptions || win?.defaultRunOptions;
    if (!source || typeof source !== 'object') return undefined;
    const out = {};
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined && value !== null && value !== '') out[key] = value;
    }
    return Object.keys(out).length ? out : undefined;
  };

  btnSend.addEventListener('click', async () => {
    const windowId = state.selectedWindowId;
    const text = String(input.value || '').trim();
    if (!windowId || !text) return;
    const win = state.windows.find((w) => w.id === windowId);
    if (win?.status === 'running') {
      state.logs = ['[error] 该窗口正在运行中'];
      renderLogs();
      return;
    }

    btnSend.disabled = true;
    try {
      const res = await invoke('codexRun', {
        windowId,
        input: text,
        codexCommand: 'codex',
        options: pickRunOptions(win),
      });
      if (res?.window) {
        const idx = state.windows.findIndex((w) => w.id === res.window.id);
        if (idx >= 0) state.windows[idx] = res.window;
      }
      input.value = '';
      await refreshAll();
    } catch (e) {
      state.logs = [`[error] ${e?.message || String(e)}`];
      renderLogs();
    } finally {
      btnSend.disabled = false;
    }
  });

  refreshAll().catch((e) => {
    state.logs = [`[error] ${e?.message || String(e)}`];
    renderLogs();
  });

  try {
    container.textContent = '';
  } catch {
    // ignore
  }
  container.appendChild(root);

  return () => {
    try {
      container.textContent = '';
    } catch {
      // ignore
    }
  };
}
