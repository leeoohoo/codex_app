import path from 'node:path';

import { GLOBAL_BACKEND_STORE, REQUESTS_FILE_NAME, STATE_FILE_NAME } from './constants.mjs';
import { ensureDir } from './files.mjs';
import { resolveDataDir, resolveStateDir } from './paths.mjs';

export const getGlobalBackendRoot = () => {
  const existing = globalThis?.[GLOBAL_BACKEND_STORE];
  if (existing && typeof existing === 'object' && existing.stores instanceof Map) return existing;
  const root = { stores: new Map() };
  try {
    Object.defineProperty(globalThis, GLOBAL_BACKEND_STORE, {
      value: root,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  } catch {
    // Fallback if defineProperty fails (should be rare).
    globalThis[GLOBAL_BACKEND_STORE] = root;
  }
  return root;
};

export const getOrCreateBackendStore = (ctx) => {
  const dataDir = resolveDataDir(ctx);
  const stateDir = resolveStateDir(ctx);
  ensureDir(dataDir);
  if (stateDir) ensureDir(stateDir);

  const stateFile = dataDir ? path.join(dataDir, STATE_FILE_NAME) : '';
  const requestsFile = dataDir ? path.join(dataDir, REQUESTS_FILE_NAME) : '';
  const key = stateFile || requestsFile || `cwd:${process.cwd()}`;

  const root = getGlobalBackendRoot();
  let store = root.stores.get(key);
  if (!store) {
    store = {
      key,
      refCount: 0,
      dataDir,
      stateDir,
      stateFile,
      requestsFile,
      windows: new Map(),
      runs: new Map(),
      windowLogs: new Map(),
      windowInputs: new Map(),
      mcpTasks: new Map(),
      stateWriteTimer: null,
      restored: false,
    };
    root.stores.set(key, store);
  } else {
    // Best-effort fill when a reload provides a more complete ctx.
    if (!store.dataDir && dataDir) store.dataDir = dataDir;
    if (stateDir && stateDir !== store.stateDir) store.stateDir = stateDir;
    if (!store.stateFile && stateFile) store.stateFile = stateFile;
    if (!store.requestsFile && requestsFile) store.requestsFile = requestsFile;
  }

  return store;
};
