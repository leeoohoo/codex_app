import { createRequire } from 'node:module';

import { normalizeString } from './utils.mjs';

export const pickDirectoryViaElectron = async ({ title, defaultPath } = {}) => {
  let electron = null;
  try {
    electron = await import('electron');
  } catch {
    try {
      const require = createRequire(import.meta.url);
      electron = require('electron');
    } catch {
      return null;
    }
  }
  const api = electron?.default && typeof electron.default === 'object' ? electron.default : electron;
  const dialog = api?.dialog;
  if (!dialog || typeof dialog.showOpenDialog !== 'function') return null;

  const BrowserWindow = api?.BrowserWindow;
  let win = undefined;
  try {
    win =
      (BrowserWindow && typeof BrowserWindow.getFocusedWindow === 'function' && BrowserWindow.getFocusedWindow()) ||
      (BrowserWindow && typeof BrowserWindow.getAllWindows === 'function' && BrowserWindow.getAllWindows()[0]) ||
      undefined;
  } catch {
    win = undefined;
  }

  const options = {
    title: normalizeString(title) || undefined,
    defaultPath: normalizeString(defaultPath) || undefined,
    properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
  };
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);

  const filePaths = Array.isArray(result?.filePaths) ? result.filePaths : [];
  const selected = !result?.canceled && filePaths[0] ? String(filePaths[0]) : '';
  return { canceled: Boolean(result?.canceled || !selected), path: selected };
};

export const pickDirectory = async ({ title, defaultPath } = {}) => {
  const picked = await pickDirectoryViaElectron({ title, defaultPath });
  if (picked) return { ok: true, ...picked };
  return { ok: true, canceled: true, path: '', reason: 'unsupported' };
};
