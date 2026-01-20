import { STATE_VERSION } from './constants.mjs';

export const normalizeRequests = (raw) => {
  const data = raw && typeof raw === 'object' ? { ...raw } : {};
  if (!Array.isArray(data.createWindows)) data.createWindows = [];
  if (!Array.isArray(data.startRuns)) data.startRuns = [];
  data.version = STATE_VERSION;
  return data;
};
