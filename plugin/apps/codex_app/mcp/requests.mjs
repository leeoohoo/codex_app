import { STATE_VERSION } from './constants.mjs';
import { readJsonFile, writeJsonFileAtomic } from './files.mjs';
import { getRequestsFile } from './paths.mjs';

export const normalizeRequests = (raw) => {
  const data = raw && typeof raw === 'object' ? { ...raw } : {};
  if (!Array.isArray(data.createWindows)) data.createWindows = [];
  if (!Array.isArray(data.startRuns)) data.startRuns = [];
  data.version = STATE_VERSION;
  return data;
};

export const appendStartRunRequest = (entry, meta) => {
  const requestsFile = getRequestsFile(meta);
  const requests = normalizeRequests(readJsonFile(requestsFile));
  requests.startRuns.push(entry);
  writeJsonFileAtomic(requestsFile, requests);
};
