export function mount({ container, host }) {
  if (!container) throw new Error('container is required');

  const ctx = typeof host?.context?.get === 'function' ? host.context.get() : {};
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
  let themeUnsub = null;
  const invoke = async (method, params) => {
    if (!host?.backend?.invoke) throw new Error('host.backend.invoke is not available');
    return await host.backend.invoke(method, params);
  };

  const state = {
    windows: [],
    selectedWindowId: '',
    logs: [],
    tasks: [],
    inputDrafts: new Map(),
  };

  const LOG_ITEM_CHAR_LIMIT = 800;
  const LOG_TOOL_IO_CHAR_LIMIT = 1200;
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

  const formatTime = (ts) => {
    const s = String(ts || '');
    if (s.length >= 19 && s.includes('T')) return s.slice(11, 19);
    return s || new Date().toISOString().slice(11, 19);
  };

  const normalizeText = (value) => String(value ?? '').replace(/\r\n?/g, '\n');

  const truncateText = (value, limit) => {
    const text = normalizeText(value);
    if (!text) return { text: '', truncated: false, originalLength: 0 };
    const max = Number(limit);
    if (!Number.isFinite(max) || max <= 0 || text.length <= max) {
      return { text, truncated: false, originalLength: text.length };
    }
    const keep = Math.max(0, max - 32);
    const trimmed = text.slice(0, keep).trimEnd();
    return { text: `${trimmed}…(truncated, originalLength=${text.length})`, truncated: true, originalLength: text.length };
  };

  const collapseWhitespace = (value) => normalizeText(value).replace(/\s+/g, ' ').trim();

  const stringifyValue = (value) => {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  };

  const normalizeTodoItem = (item) => {
    if (!item) return null;
    if (typeof item === 'string') {
      const text = item.trim();
      return text ? { text, completed: false } : null;
    }
    if (typeof item !== 'object') return null;
    const text = String(item.text || item.content || item.title || item.name || item.task || item.label || item.value || '').trim();
    if (!text) return null;
    const completed = Boolean(item.completed ?? item.done ?? item.checked ?? item.finished ?? item.isDone ?? item.is_done);
    return { text, completed };
  };

  const parseTodoMarkdown = (value) => {
    const text = normalizeText(value).trim();
    if (!text) return [];
    const items = [];
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      let match = line.match(/^[-*]\s+\[(x|X| )\]\s+(.*)$/);
      if (match) {
        const itemText = String(match[2] || '').trim();
        if (itemText) items.push({ text: itemText, completed: String(match[1]).toLowerCase() === 'x' });
        continue;
      }
      match = line.match(/^[-*]\s+(.*)$/);
      if (match) {
        const itemText = String(match[1] || '').trim();
        if (itemText) items.push({ text: itemText, completed: false });
        continue;
      }
      match = line.match(/^\d+\.\s+(.*)$/);
      if (match) {
        const itemText = String(match[1] || '').trim();
        if (itemText) items.push({ text: itemText, completed: false });
      }
    }
    return items;
  };

  const normalizeTodoItems = (value) => {
    if (Array.isArray(value)) {
      const mapped = value.map(normalizeTodoItem).filter(Boolean);
      if (mapped.length) return mapped;
    }
    if (typeof value === 'string') return parseTodoMarkdown(value);
    if (value && typeof value === 'object') {
      if (Array.isArray(value.items)) {
        const mapped = value.items.map(normalizeTodoItem).filter(Boolean);
        return mapped;
      }
      const text = value.text || value.content || value.output_text || value.outputText || value.message;
      const parsed = parseTodoMarkdown(text);
      if (parsed.length) return parsed;
    }
    return [];
  };

  const looksLikeMarkdown = (value) => {
    const text = normalizeText(value);
    if (!text) return false;
    if (text.includes('```')) return true;
    if (/(^|\n)\s{0,3}#{1,6}\s+\S+/.test(text)) return true;
    if (/(^|\n)\s*([-*+]|\d+\.)\s+\S+/.test(text)) return true;
    if (/(^|\n)\|.+\|/.test(text)) return true;
    return false;
  };

  const ensureClosedFences = (value) => {
    const text = normalizeText(value);
    const matches = text.match(/```/g);
    if (matches && matches.length % 2 === 1) return `${text}\n\`\`\``;
    return text;
  };

  const formatValueForMarkdown = (value, { limit, forceCodeBlock = false, codeLang = '' } = {}) => {
    const raw = stringifyValue(value);
    if (!raw) return { markdown: '', preview: '', truncated: false, originalLength: 0 };
    const trimmed = truncateText(raw, limit);
    if (forceCodeBlock || typeof value === 'object' || (raw.includes('\n') && !looksLikeMarkdown(raw))) {
      const lang = codeLang || (typeof value === 'object' ? 'json' : '');
      const fence = lang ? `\`\`\`${lang}` : '```';
      return {
        markdown: `${fence}\n${trimmed.text}\n\`\`\``,
        preview: trimmed.text,
        truncated: trimmed.truncated,
        originalLength: trimmed.originalLength,
      };
    }
    const content = trimmed.truncated ? ensureClosedFences(trimmed.text) : trimmed.text;
    return { markdown: content, preview: trimmed.text, truncated: trimmed.truncated, originalLength: trimmed.originalLength };
  };

  const appendBoldNodes = (parent, text) => {
    if (!text) return;
    let pos = 0;
    while (pos < text.length) {
      const start = text.indexOf('**', pos);
      if (start === -1) {
        parent.appendChild(document.createTextNode(text.slice(pos)));
        return;
      }
      const end = text.indexOf('**', start + 2);
      if (end === -1) {
        parent.appendChild(document.createTextNode(text.slice(pos)));
        return;
      }
      if (start > pos) parent.appendChild(document.createTextNode(text.slice(pos, start)));
      const strong = document.createElement('strong');
      strong.textContent = text.slice(start + 2, end);
      parent.appendChild(strong);
      pos = end + 2;
    }
  };

  const appendInlineNodes = (parent, text) => {
    if (!text) return;
    const parts = text.split('`');
    parts.forEach((part, idx) => {
      if (idx % 2 === 1) {
        const code = document.createElement('code');
        code.textContent = part;
        code.style.fontFamily =
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
        code.style.background = 'var(--ds-code-bg, var(--codex-compact-code-bg))';
        code.style.border = '1px solid var(--ds-code-border, var(--codex-compact-code-border))';
        code.style.borderRadius = '6px';
        code.style.padding = '1px 3px';
        parent.appendChild(code);
        return;
      }
      appendBoldNodes(parent, part);
    });
  };

  const renderMarkdown = (markdown) => {
    const fragment = document.createDocumentFragment();
    const text = normalizeText(markdown);
    if (!text) return fragment;

    const lines = text.split('\n');
    let inCode = false;
    let codeLines = [];
    let listEl = null;
    let listType = '';
    let paragraph = [];

    const flushParagraph = () => {
      if (!paragraph.length) return;
      const p = document.createElement('p');
      p.style.margin = '0';
      p.style.fontSize = '11px';
      p.style.lineHeight = '1.4';
      appendInlineNodes(p, paragraph.join('\n'));
      fragment.appendChild(p);
      paragraph = [];
    };

    const flushList = () => {
      if (!listEl) return;
      fragment.appendChild(listEl);
      listEl = null;
      listType = '';
    };

    const flushCode = () => {
      if (!inCode) return;
      const pre = document.createElement('pre');
      pre.style.margin = '0';
      pre.style.padding = '6px';
      pre.style.borderRadius = '8px';
      pre.style.background = 'var(--ds-code-bg, var(--codex-compact-code-bg))';
      pre.style.border = '1px solid var(--ds-code-border, var(--codex-compact-code-border))';
      pre.style.overflow = 'auto';
      const code = document.createElement('code');
      code.textContent = codeLines.join('\n');
      code.style.fontFamily =
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
      code.style.fontSize = '10px';
      pre.appendChild(code);
      fragment.appendChild(pre);
      codeLines = [];
      inCode = false;
    };

    for (const line of lines) {
      const fenceMatch = line.match(/^```(\w+)?\s*$/);
      if (fenceMatch) {
        flushParagraph();
        flushList();
        if (inCode) flushCode();
        else {
          inCode = true;
          codeLines = [];
        }
        continue;
      }

      if (inCode) {
        codeLines.push(line);
        continue;
      }

      const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
      if (headingMatch) {
        flushParagraph();
        flushList();
        const h = document.createElement('div');
        h.style.fontWeight = '700';
        h.style.fontSize = '12px';
        appendInlineNodes(h, headingMatch[2]);
        fragment.appendChild(h);
        continue;
      }

      const orderedMatch = line.match(/^\s*(\d+)\.\s+(.*)$/);
      const unorderedMatch = line.match(/^\s*[-*+]\s+(.*)$/);
      if (orderedMatch || unorderedMatch) {
        flushParagraph();
        const nextType = orderedMatch ? 'ol' : 'ul';
        if (!listEl || listType !== nextType) {
          flushList();
          listType = nextType;
          listEl = document.createElement(nextType);
          listEl.style.margin = '0 0 0 16px';
          listEl.style.padding = '0';
          listEl.style.fontSize = '11px';
          listEl.style.lineHeight = '1.4';
        }
        const li = document.createElement('li');
        appendInlineNodes(li, orderedMatch ? orderedMatch[2] : unorderedMatch[1]);
        listEl.appendChild(li);
        continue;
      }

      if (!line.trim()) {
        flushParagraph();
        flushList();
        continue;
      }

      paragraph.push(line);
    }

    flushParagraph();
    flushList();
    flushCode();
    return fragment;
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
    return { kind, time, title, markdown, line };
  };

  const buildMetaEntry = (time, text) => {
    const trimmed = truncateText(text, LOG_ITEM_CHAR_LIMIT);
    const line = [time ? `[${time}]` : '', trimmed.text].filter(Boolean).join(' ');
    return { kind: 'meta', time, text: trimmed.text, line };
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
    return {
      kind: 'tool',
      time,
      title: '工具',
      tool: { name, status: statusText, input: inputBlock, output: outputBlock },
      line,
    };
  };

  const buildLogEntry = (evt) => {
    if (typeof evt === 'string' || evt?.line) {
      const time = evt?.ts ? formatTime(evt.ts) : '';
      return buildMetaEntry(time, typeof evt === 'string' ? evt : String(evt?.line || ''));
    }
    if (!evt || typeof evt !== 'object') return null;
    const time = formatTime(evt?.ts || new Date().toISOString());

    if (evt?.source === 'system') {
      if (evt.kind === 'error') return buildMessageEntry(time, evt?.error?.message || evt.message || '', { kind: 'error', title: '错误' });
      if (evt.kind === 'warning') return buildMessageEntry(time, evt.message || evt.warning || '', { kind: 'warning', title: '警告' });
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
        if (TOOL_ITEM_TYPES.has(itemType) || isToolLikeItem(item)) return buildToolEntry(time, item);
        const fallbackText = pickFirst(item.text, item.message, item.output_text, item.content);
        if (fallbackText) return buildMessageEntry(time, fallbackText, { kind: 'message', title: '助手' });
        return buildMetaEntry(time, `item ${itemType} ${JSON.stringify(item).slice(0, 320)}`);
      }
    }

    return null;
  };

  const mkTag = (text) => {
    const tag = document.createElement('div');
    tag.textContent = String(text || '');
    tag.style.display = 'inline-flex';
    tag.style.alignItems = 'center';
    tag.style.justifyContent = 'center';
    tag.style.padding = '2px 6px';
    tag.style.borderRadius = '999px';
    tag.style.border = '1px solid var(--ds-panel-border, var(--codex-compact-border))';
    tag.style.background = 'var(--ds-subtle-bg, var(--codex-compact-subtle))';
    tag.style.fontSize = '10px';
    tag.style.fontWeight = '700';
    tag.style.cursor = 'pointer';
    return tag;
  };

  const renderToolBlock = (title, block) => {
    const wrap = document.createElement('div');
    wrap.style.display = 'flex';
    wrap.style.flexDirection = 'column';
    wrap.style.gap = '6px';
    const label = document.createElement('div');
    label.textContent = title;
    label.style.fontSize = '10px';
    label.style.fontWeight = '700';
    label.style.color = 'var(--ds-text-secondary, var(--codex-compact-text-muted))';
    wrap.appendChild(label);

    if (!block?.markdown) {
      const empty = document.createElement('div');
      empty.textContent = '无';
      empty.style.fontSize = '11px';
      empty.style.color = 'var(--ds-text-secondary, var(--codex-compact-text-muted))';
      wrap.appendChild(empty);
      return wrap;
    }

    const body = document.createElement('div');
    body.appendChild(renderMarkdown(block.markdown));
    wrap.appendChild(body);
    return wrap;
  };

  const renderLogEntry = (entry) => {
    const card = document.createElement('div');
    card.style.border = '1px solid var(--ds-panel-border, var(--codex-compact-border))';
    card.style.borderRadius = '10px';
    card.style.background = 'var(--ds-subtle-bg, var(--codex-compact-subtle))';
    card.style.padding = '8px';
    card.style.display = 'flex';
    card.style.flexDirection = 'column';
    card.style.gap = '6px';

    if (entry.kind === 'error') {
      card.style.border = '1px solid rgba(239,68,68,0.55)';
      card.style.background = 'rgba(239,68,68,0.10)';
    }

    const meta = document.createElement('div');
    meta.style.display = 'flex';
    meta.style.flexWrap = 'wrap';
    meta.style.gap = '6px';
    meta.style.fontSize = '10px';
    meta.style.color = 'var(--ds-text-secondary, var(--codex-compact-text-muted))';
    if (entry.time) {
      const time = document.createElement('div');
      time.textContent = entry.time;
      meta.appendChild(time);
    }
    if (entry.title) {
      const label = document.createElement('div');
      label.textContent = entry.title;
      label.style.fontWeight = '700';
      meta.appendChild(label);
    }
    card.appendChild(meta);

    if (entry.kind === 'tool' && entry.tool) {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.style.display = 'flex';
      summary.style.alignItems = 'center';
      summary.style.gap = '6px';
      summary.style.cursor = 'pointer';
      summary.appendChild(mkTag(entry.tool.name));
      if (entry.tool.status) {
        const status = document.createElement('div');
        status.textContent = entry.tool.status;
        status.style.fontSize = '10px';
        status.style.color = 'var(--ds-text-secondary, var(--codex-compact-text-muted))';
        summary.appendChild(status);
      }
      details.appendChild(summary);

      const body = document.createElement('div');
      body.style.display = 'grid';
      body.style.gap = '6px';
      body.style.marginTop = '6px';
      body.appendChild(renderToolBlock('入参', entry.tool.input));
      body.appendChild(renderToolBlock('出参', entry.tool.output));
      details.appendChild(body);

      card.appendChild(details);
      return card;
    }

    if (entry.kind === 'meta') {
      const text = document.createElement('div');
      text.textContent = entry.text || '';
      text.style.fontSize = '11px';
      text.style.whiteSpace = 'pre-wrap';
      text.style.wordBreak = 'break-word';
      text.style.fontFamily =
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
      card.appendChild(text);
      return card;
    }

    const body = document.createElement('div');
    body.appendChild(renderMarkdown(entry.markdown || ''));
    card.appendChild(body);
    return card;
  };

  const root = document.createElement('div');
  root.style.height = '100%';
  root.style.boxSizing = 'border-box';
  root.style.padding = '12px';
  root.style.display = 'flex';
  root.style.flexDirection = 'column';
  root.style.gap = '10px';
  root.style.color = 'var(--ds-text-primary, var(--codex-compact-text))';
  root.style.fontFamily =
    'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"';
  root.style.background = 'var(--ds-panel-bg, var(--codex-compact-page-bg))';
  root.style.border = '1px solid var(--ds-panel-border, var(--codex-compact-border))';
  root.style.borderRadius = '14px';
  root.style.colorScheme = activeTheme;

  const compactThemeTokens = {
    dark: {
      pageBg: 'rgba(7,10,18,0.88)',
      text: 'rgba(255,255,255,0.92)',
      textMuted: 'rgba(255,255,255,0.70)',
      textDim: 'rgba(255,255,255,0.60)',
      border: 'rgba(255,255,255,0.14)',
      panel: 'rgba(255,255,255,0.05)',
      subtle: 'rgba(255,255,255,0.08)',
      codeBg: 'rgba(0,0,0,0.50)',
      codeBorder: 'rgba(255,255,255,0.16)',
    },
    light: {
      pageBg: 'rgba(248,250,252,0.95)',
      text: 'rgba(0,0,0,0.92)',
      textMuted: 'rgba(0,0,0,0.65)',
      textDim: 'rgba(0,0,0,0.55)',
      border: 'rgba(0,0,0,0.12)',
      panel: 'rgba(0,0,0,0.02)',
      subtle: 'rgba(0,0,0,0.04)',
      codeBg: 'rgba(0,0,0,0.04)',
      codeBorder: 'rgba(0,0,0,0.12)',
    },
  };

  const themedSelects = new Set();

  const applySelectTheme = (select) => {
    if (!select) return;
    select.style.colorScheme = activeTheme;
    select.style.background = 'var(--ds-subtle-bg, var(--codex-compact-subtle))';
    select.style.color = 'var(--ds-text-primary, var(--codex-compact-text))';
    select.style.borderColor = 'var(--ds-panel-border, var(--codex-compact-border))';
    const options = select.querySelectorAll('option');
    options.forEach((opt) => {
      opt.style.background = 'var(--ds-panel-bg, var(--codex-compact-panel))';
      opt.style.color = 'var(--ds-text-primary, var(--codex-compact-text))';
    });
  };

  const applyTheme = (theme) => {
    const nextTheme = normalizeTheme(theme);
    activeTheme = nextTheme;
    const palette = compactThemeTokens[nextTheme] || compactThemeTokens.light;
    root.dataset.theme = nextTheme;
    root.style.colorScheme = nextTheme;
    root.style.setProperty('--codex-compact-page-bg', palette.pageBg);
    root.style.setProperty('--codex-compact-text', palette.text);
    root.style.setProperty('--codex-compact-text-muted', palette.textMuted);
    root.style.setProperty('--codex-compact-text-dim', palette.textDim);
    root.style.setProperty('--codex-compact-border', palette.border);
    root.style.setProperty('--codex-compact-panel', palette.panel);
    root.style.setProperty('--codex-compact-subtle', palette.subtle);
    root.style.setProperty('--codex-compact-code-bg', palette.codeBg);
    root.style.setProperty('--codex-compact-code-border', palette.codeBorder);
    themedSelects.forEach((select) => applySelectTheme(select));
  };

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
  meta.style.color = 'var(--ds-text-secondary, var(--codex-compact-text-muted))';
  meta.textContent = `${ctx?.pluginId || ''}:${ctx?.appId || ''}`;

  header.appendChild(title);
  header.appendChild(meta);

  const mkBtn = (label, { variant = 'default' } = {}) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.style.padding = '6px 10px';
    btn.style.borderRadius = '10px';
    btn.style.border = '1px solid var(--ds-panel-border, var(--codex-compact-border))';
    btn.style.background = 'var(--ds-subtle-bg, var(--codex-compact-subtle))';
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
    panel.style.border = '1px solid var(--ds-panel-border, var(--codex-compact-border))';
    panel.style.borderRadius = '12px';
    panel.style.background = 'var(--ds-panel-bg, var(--codex-compact-panel))';
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
  windowSelect.style.border = '1px solid var(--ds-panel-border, var(--codex-compact-border))';
  windowSelect.style.background = 'var(--ds-subtle-bg, var(--codex-compact-subtle))';
  windowSelect.style.color = 'var(--ds-text-primary, var(--codex-compact-text))';
  themedSelects.add(windowSelect);

  const btnRefresh = mkBtn('刷新');
  const btnStop = mkBtn('停止', { variant: 'danger' });

  controls.appendChild(windowSelect);
  controls.appendChild(btnRefresh);
  controls.appendChild(btnStop);

  const inputPanel = mkPanel();
  const inputLabel = document.createElement('div');
  inputLabel.textContent = '发送消息';
  inputLabel.style.fontSize = '12px';
  inputLabel.style.color = 'var(--ds-text-secondary, var(--codex-compact-text-muted))';

  const input = document.createElement('textarea');
  input.placeholder = '输入要发送给 Codex 的内容…';
  input.style.width = '100%';
  input.style.minHeight = '64px';
  input.style.resize = 'vertical';
  input.style.borderRadius = '10px';
  input.style.border = '1px solid var(--ds-panel-border, var(--codex-compact-border))';
  input.style.background = 'var(--ds-subtle-bg, var(--codex-compact-subtle))';
  input.style.padding = '8px';
  input.style.outline = 'none';
  input.style.color = 'var(--ds-text-primary, var(--codex-compact-text))';

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

  input.addEventListener('input', () => {
    if (!state.selectedWindowId) return;
    saveInputDraft(state.selectedWindowId, input.value);
  });

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
  logTitle.style.color = 'var(--ds-text-secondary, var(--codex-compact-text-muted))';

  const logEl = document.createElement('div');
  logEl.style.margin = '0';
  logEl.style.flex = '1';
  logEl.style.minHeight = '120px';
  logEl.style.overflow = 'auto';
  logEl.style.padding = '8px';
  logEl.style.borderRadius = '10px';
  logEl.style.border = '1px solid var(--ds-code-border, var(--codex-compact-code-border))';
  logEl.style.background = 'var(--ds-code-bg, var(--codex-compact-code-bg))';
  logEl.style.display = 'flex';
  logEl.style.flexDirection = 'column';
  logEl.style.gap = '8px';
  logEl.style.color = 'var(--ds-text-primary, var(--codex-compact-text))';

  logPanel.appendChild(logTitle);
  logPanel.appendChild(logEl);

  const tasksPanel = mkPanel();
  const tasksTitle = document.createElement('div');
  tasksTitle.textContent = '任务';
  tasksTitle.style.fontSize = '12px';
  tasksTitle.style.color = 'var(--ds-text-secondary, var(--codex-compact-text-muted))';

  const tasksSummary = document.createElement('div');
  tasksSummary.style.fontSize = '12px';
  tasksSummary.style.color = 'var(--ds-text-secondary, var(--codex-compact-text-muted))';

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
    applySelectTheme(windowSelect);
    if (state.selectedWindowId) windowSelect.value = state.selectedWindowId;
    setStatusMeta();
  };

  const renderLogs = () => {
    logEl.textContent = '';
    if (!state.logs.length) {
      const empty = document.createElement('div');
      empty.textContent = '暂无日志';
      empty.style.fontSize = '11px';
      empty.style.color = 'var(--ds-text-secondary, var(--codex-compact-text-muted))';
      logEl.appendChild(empty);
      return;
    }

    const entries = state.logs.map(buildLogEntry).filter(Boolean);
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.textContent = '暂无日志';
      empty.style.fontSize = '11px';
      empty.style.color = 'var(--ds-text-secondary, var(--codex-compact-text-muted))';
      logEl.appendChild(empty);
      return;
    }

    entries.forEach((entry) => logEl.appendChild(renderLogEntry(entry)));
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
      row.style.border = '1px solid var(--ds-panel-border, var(--codex-compact-border))';
      row.style.background = 'var(--ds-subtle-bg, var(--codex-compact-subtle))';

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
      mark.style.color = it?.completed ? '#0b1020' : 'var(--ds-text-secondary, var(--codex-compact-text-dim))';
      mark.style.background = it?.completed ? '#22c55e' : 'transparent';
      mark.style.border = it?.completed ? '0' : '1px solid var(--ds-panel-border, var(--codex-compact-border))';

      const text = document.createElement('div');
      text.textContent = String(it?.text || '');
      text.style.fontSize = '12px';
      text.style.lineHeight = '1.4';
      text.style.color = it?.completed ? 'var(--ds-text-secondary, var(--codex-compact-text-dim))' : 'inherit';
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
    state.tasks = normalizeTodoItems(res?.todoList);
    renderTasks();
  };

  const refreshWindows = async () => {
    if (state.selectedWindowId) {
      saveInputDraft(state.selectedWindowId, input.value);
    }
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
    input.value = loadInputDraft(state.selectedWindowId);
  };

  const refreshAll = async () => {
    await refreshWindows();
    await loadLogs(state.selectedWindowId);
    await loadTasks(state.selectedWindowId);
  };

  windowSelect.addEventListener('change', () => {
    if (state.selectedWindowId) {
      saveInputDraft(state.selectedWindowId, input.value);
    }
    state.selectedWindowId = windowSelect.value;
    input.value = loadInputDraft(state.selectedWindowId);
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
      saveInputDraft(windowId, '');
      await refreshAll();
    } catch (e) {
      state.logs = [`[error] ${e?.message || String(e)}`];
      renderLogs();
    } finally {
      btnSend.disabled = false;
    }
  });

  applyTheme(activeTheme);
  if (typeof host?.theme?.onChange === 'function') {
    try {
      themeUnsub = host.theme.onChange((theme) => applyTheme(theme));
    } catch {
      // ignore
    }
  }

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
    if (typeof themeUnsub === 'function') {
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
