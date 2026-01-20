import { randomUUID } from 'node:crypto';

export const nowIso = () => new Date().toISOString();

export const makeId = () => {
  try {
    return randomUUID();
  } catch {
    return `${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`;
  }
};

export const normalizeString = (value) => {
  if (typeof value !== 'string') return '';
  return String(value || '').trim();
};

export const normalizeStringArray = (value) => {
  if (!Array.isArray(value)) return [];
  return value.map((v) => normalizeString(v)).filter(Boolean);
};

export const normalizeBoolean = (value) => {
  if (value === undefined || value === null) return undefined;
  return Boolean(value);
};

export const clampNumber = (value, min, max) => {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
};
