import { randomUUID } from 'node:crypto';

export const normalizeString = (value) => {
  if (typeof value !== 'string') return '';
  return String(value || '').trim();
};

export const nowIso = () => new Date().toISOString();

export const makeId = () => {
  try {
    return randomUUID();
  } catch {
    return `${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`;
  }
};

export const parseIsoTime = (value) => {
  const ts = Date.parse(value || '');
  return Number.isFinite(ts) ? ts : 0;
};
