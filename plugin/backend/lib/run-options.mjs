import { normalizeBoolean, normalizeString } from './utils.mjs';

export const normalizeRunOptions = (options) => {
  if (!options || typeof options !== 'object') return {};
  return {
    model: normalizeString(options.model),
    modelReasoningEffort: normalizeString(options.modelReasoningEffort),
    workingDirectory: normalizeString(options.workingDirectory),
    sandboxMode: normalizeString(options.sandboxMode),
    approvalPolicy: normalizeString(options.approvalPolicy),
    experimentalWindowsSandboxEnabled: normalizeBoolean(options.experimentalWindowsSandboxEnabled),
    networkAccessEnabled: normalizeBoolean(options.networkAccessEnabled),
    webSearchEnabled: normalizeBoolean(options.webSearchEnabled),
    skipGitRepoCheck: normalizeBoolean(options.skipGitRepoCheck),
  };
};

export const mergeRunOptions = (baseOptions, overrideOptions) => {
  const base = normalizeRunOptions(baseOptions);
  const over = normalizeRunOptions(overrideOptions);
  const merged = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
};

export const serializeRunOptions = (options) => {
  if (!options || typeof options !== 'object') return null;
  const normalized = normalizeRunOptions(options);
  const out = {};
  for (const [key, value] of Object.entries(normalized)) {
    out[key] = value === undefined || value === '' ? null : value;
  }
  return out;
};
