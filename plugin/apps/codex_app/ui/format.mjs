export const normalizeText = (value) => String(value ?? '').replace(/\r\n?/g, '\n');

export const truncateText = (value, limit) => {
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

export const collapseWhitespace = (value) => normalizeText(value).replace(/\s+/g, ' ').trim();

export const stringifyValue = (value) => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

export const looksLikeMarkdown = (value) => {
  const text = normalizeText(value);
  if (!text) return false;
  if (text.includes('```')) return true;
  if (/(^|\n)\s{0,3}#{1,6}\s+\S+/.test(text)) return true;
  if (/(^|\n)\s*([-*+]|\d+\.)\s+\S+/.test(text)) return true;
  if (/(^|\n)\|.+\|/.test(text)) return true;
  return false;
};

export const ensureClosedFences = (value) => {
  const text = normalizeText(value);
  const matches = text.match(/```/g);
  if (matches && matches.length % 2 === 1) return `${text}\n\`\`\``;
  return text;
};

export const formatValueForMarkdown = (value, { limit, forceCodeBlock = false, codeLang = '' } = {}) => {
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

export const appendBoldNodes = (parent, text) => {
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

export const appendInlineNodes = (parent, text) => {
  if (!text) return;
  const parts = text.split('`');
  parts.forEach((part, idx) => {
    if (idx % 2 === 1) {
      const code = document.createElement('code');
      code.textContent = part;
      parent.appendChild(code);
      return;
    }
    appendBoldNodes(parent, part);
  });
};

export const renderMarkdown = (markdown) => {
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
    const code = document.createElement('code');
    code.textContent = codeLines.join('\n');
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
      const level = Math.min(6, headingMatch[1].length);
      const h = document.createElement(`h${level}`);
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

export const clampNumber = (value, min, max) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
};

export const formatTime = (ts) => {
  const s = String(ts || '');
  if (s.length >= 19 && s.includes('T')) return s.slice(11, 19);
  return s || new Date().toISOString().slice(11, 19);
};

export const normalizeTodoItem = (item) => {
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

export const parseTodoMarkdown = (value) => {
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

export const normalizeTodoItems = (value) => {
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
