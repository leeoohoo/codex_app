import fs from 'node:fs';
import path from 'node:path';

import { normalizeString } from './utils.mjs';

export const resolveStateDir = (ctx) => {
  const fromCtx = normalizeString(ctx?.stateDir);
  if (fromCtx) return fromCtx;
  const direct =
    normalizeString(process.env?.CHATOS_UI_APPS_STATE_DIR) ||
    normalizeString(process.env?.CHATOS_STATE_DIR) ||
    normalizeString(process.env?.MODEL_CLI_STATE_DIR);
  if (direct) return direct;
  const hostApp = normalizeString(process.env?.MODEL_CLI_HOST_APP) || 'chatos';
  const sessionRoot = normalizeString(process.env?.MODEL_CLI_SESSION_ROOT);
  const home = normalizeString(process.env?.HOME || process.env?.USERPROFILE);
  const base = sessionRoot || home;
  if (!base) return '';
  return path.join(base, '.deepseek_cli', hostApp);
};

export const resolveTaskkillPath = () => {
  const root = normalizeString(process.env?.SystemRoot || process.env?.WINDIR);
  if (root) {
    const candidate = path.join(root, 'System32', 'taskkill.exe');
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  return 'taskkill';
};

export const findUpwardsDataDir = (startPath, pluginId) => {
  const raw = normalizeString(startPath);
  if (!raw) return '';
  let current = raw;
  try {
    current = path.resolve(raw);
  } catch {
    current = raw;
  }
  for (let i = 0; i < 50; i += 1) {
    const candidate = path.join(current, '.chatos', 'data', pluginId);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
    const parent = path.dirname(current);
    if (!parent || parent === current) break;
    current = parent;
  }
  return '';
};

export const resolveDataDir = (ctx) => {
  const fromCtx = normalizeString(ctx?.dataDir);
  if (fromCtx) return fromCtx;
  const pluginId = normalizeString(ctx?.pluginId) || 'com.leeoohoo.codex_app';
  const fromCwd = findUpwardsDataDir(process.cwd(), pluginId);
  if (fromCwd) return fromCwd;
  const fromPluginDir = normalizeString(ctx?.pluginDir);
  if (fromPluginDir) {
    const found = findUpwardsDataDir(fromPluginDir, pluginId);
    if (found) return found;
  }
  return path.join(process.cwd(), '.chatos', 'data', pluginId);
};

export const findGitRepoRoot = (startPath) => {
  const raw = normalizeString(startPath);
  if (!raw) return '';
  let current = raw;
  try {
    current = path.resolve(raw);
  } catch {
    current = raw;
  }
  for (let i = 0; i < 50; i += 1) {
    const candidate = path.join(current, '.git');
    try {
      if (fs.existsSync(candidate)) return current;
    } catch {
      // ignore
    }

    const parent = path.dirname(current);
    if (!parent || parent === current) break;
    current = parent;
  }

  return '';
};
