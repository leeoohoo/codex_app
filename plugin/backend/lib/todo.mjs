import { normalizeString } from './utils.mjs';

export const normalizeTodoItem = (item) => {
  if (!item) return null;
  if (typeof item === 'string') {
    const text = item.trim();
    return text ? { text, completed: false } : null;
  }
  if (typeof item !== 'object') return null;
  const text = normalizeString(item.text || item.content || item.title || item.name || item.task || item.label || item.value);
  if (!text) return null;
  const completed = Boolean(item.completed ?? item.done ?? item.checked ?? item.finished ?? item.isDone ?? item.is_done);
  return { text, completed };
};

export const parseTodoMarkdown = (value) => {
  const text = String(value ?? '').replace(/\r\n?/g, '\n').trim();
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
