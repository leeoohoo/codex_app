import path from 'node:path';

import { normalizeString } from './utils.mjs';

export const parseWindowTime = (win) => {
  const updated = Date.parse(win?.updatedAt || '') || 0;
  if (updated) return updated;
  return Date.parse(win?.createdAt || '') || 0;
};

export const sortWindowsByRecent = (windows) =>
  Array.isArray(windows) ? windows.slice().sort((a, b) => parseWindowTime(b) - parseWindowTime(a)) : [];

export const isRunningStatus = (value) => {
  const status = normalizeString(value).toLowerCase();
  return status === 'running' || status === 'aborting';
};

export const normalizePath = (value) => {
  const raw = normalizeString(value);
  if (!raw) return '';
  try {
    return path.resolve(raw);
  } catch {
    return raw;
  }
};

export const getWindowWorkingDirectory = (win) =>
  normalizePath(win?.lastRunOptions?.workingDirectory || win?.defaultRunOptions?.workingDirectory || '');

export const findWindowByWorkingDirectory = (windows, workingDirectory, { includeRunning = false } = {}) => {
  const needle = normalizePath(workingDirectory);
  if (!needle) return null;
  return Array.isArray(windows)
    ? windows.find((win) => {
        if (!includeRunning && isRunningStatus(win?.status)) return false;
        const workdir = getWindowWorkingDirectory(win);
        return workdir && workdir === needle;
      })
    : null;
};
