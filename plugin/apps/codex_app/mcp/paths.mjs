import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PLUGIN_ID, REQUESTS_FILE_NAME, STATE_FILE_NAME } from './constants.mjs';
import { normalizeString } from './utils.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDir, '..', '..', '..');

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

export const findGitRepoRoot = (startPath) => {
  const raw = normalizeString(startPath);
  if (!raw) return '';
  let current = raw;
  try {
    current = path.resolve(raw);
  } catch {
    current = raw;
  }
  try {
    const stat = fs.statSync(current);
    if (stat.isFile()) current = path.dirname(current);
  } catch {
    return '';
  }
  for (let i = 0; i < 100; i += 1) {
    try {
      if (fs.existsSync(path.join(current, '.git'))) return current;
    } catch {
      // ignore
    }
    const parent = path.dirname(current);
    if (!parent || parent === current) break;
    current = parent;
  }
  return '';
};

export const resolveDataDirFromStateDir = (stateDir) => {
  const raw = normalizeString(stateDir);
  if (!raw) return '';
  return path.join(raw, 'ui_apps', 'data', PLUGIN_ID);
};

export const looksLikeDataDir = (value) => {
  const raw = normalizeString(value);
  if (!raw) return false;
  let resolved = raw;
  try {
    resolved = path.resolve(raw);
  } catch {
    resolved = raw;
  }
  const normalized = resolved.split(path.sep).join('/');
  return normalized.endsWith(`/ui_apps/data/${PLUGIN_ID}`) || normalized.endsWith(`/.chatos/data/${PLUGIN_ID}`);
};

export const resolveStateDirFromEnv = () => {
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

export const resolveDataDirFromEnv = () => resolveDataDirFromStateDir(resolveStateDirFromEnv());

export const resolveDataDir = () => {
  const envDir =
    normalizeString(process.env?.CHATOS_UI_APPS_DATA_DIR) ||
    normalizeString(process.env?.CHATOS_UI_APP_DATA_DIR) ||
    normalizeString(process.env?.CHATOS_DATA_DIR);
  if (envDir) return envDir;
  const fromEnv = resolveDataDirFromEnv();
  if (fromEnv) return fromEnv;
  const fromCwd = findUpwardsDataDir(process.cwd(), PLUGIN_ID);
  if (fromCwd) return fromCwd;
  const fromPlugin = findUpwardsDataDir(pluginRoot, PLUGIN_ID);
  if (fromPlugin) return fromPlugin;
  return path.join(process.cwd(), '.chatos', 'data', PLUGIN_ID);
};

export const resolveDataDirFromMeta = (meta) => {
  const fromUiApp = normalizeString(meta?.chatos?.uiApp?.dataDir);
  if (fromUiApp) return fromUiApp;
  const fromStateDir = resolveDataDirFromStateDir(meta?.chatos?.uiApp?.stateDir);
  if (fromStateDir) return fromStateDir;
  const fromWorkdir = normalizeString(meta?.workdir);
  if (fromWorkdir && looksLikeDataDir(fromWorkdir)) return fromWorkdir;
  return '';
};

export const resolveDataDirWithMeta = (meta) => resolveDataDirFromMeta(meta) || resolveDataDir();

export const resolveDefaultWorkingDirectory = (meta) => {
  const fromProject = normalizeString(meta?.chatos?.uiApp?.projectRoot);
  if (fromProject) return fromProject;
  const fromSession = normalizeString(meta?.chatos?.uiApp?.sessionRoot);
  if (fromSession) return fromSession;
  const fromWorkdir = normalizeString(meta?.workdir);
  if (fromWorkdir) return fromWorkdir;
  return process.cwd();
};

export const getStateFile = (meta) => {
  const dataDir = resolveDataDirWithMeta(meta);
  return dataDir ? path.join(dataDir, STATE_FILE_NAME) : '';
};

export const getRequestsFile = (meta) => {
  const dataDir = resolveDataDirWithMeta(meta);
  return dataDir ? path.join(dataDir, REQUESTS_FILE_NAME) : '';
};
