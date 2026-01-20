import fs from 'node:fs';
import path from 'node:path';

import { pickAssistantMessage } from './codex.mjs';
import { normalizeString } from './utils.mjs';

const PLAN_FILENAME = 'codex_plan.md';

const normalizeMultilineText = (value) => {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\r\n?/g, '\n');
};

const pickFirstText = (...values) => {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    if (!value.trim()) continue;
    return normalizeMultilineText(value);
  }
  return '';
};

const pickFirstPath = (...values) => {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '';
};

const normalizePathForMatch = (value) => String(value || '').replace(/\\/g, '/').replace(/^[ab]\//, '');

const resolvePlanPath = (workingDirectory) => {
  if (!workingDirectory) return '';
  try {
    return path.resolve(workingDirectory, PLAN_FILENAME);
  } catch {
    return '';
  }
};

const isPlanMarkdownPath = (value, workingDirectory) => {
  const raw = String(value || '').trim();
  if (!raw) return false;
  const normalized = normalizePathForMatch(raw);
  const lower = normalized.toLowerCase();
  if (lower !== PLAN_FILENAME && !lower.endsWith(`/${PLAN_FILENAME}`)) return false;
  if (!workingDirectory) return true;
  const expected = resolvePlanPath(workingDirectory);
  if (!expected) return true;
  const resolved = path.isAbsolute(normalized)
    ? path.resolve(normalized)
    : path.resolve(workingDirectory, normalized);
  return resolved.toLowerCase() === expected.toLowerCase();
};

const extractMarkdownFromPatch = (patch, workingDirectory) => {
  const text = normalizeMultilineText(patch);
  if (!text) return '';
  const lines = text.split('\n');
  let collecting = false;
  let matched = false;
  let collected = [];

  for (const line of lines) {
    if (line.startsWith('+++ ')) {
      const filePath = normalizePathForMatch(line.slice(4).trim());
      collecting = Boolean(filePath) && isPlanMarkdownPath(filePath, workingDirectory);
      if (collecting) {
        matched = true;
        collected = [];
      }
      continue;
    }
    if (!collecting) continue;
    if (line.startsWith('@@') || line.startsWith('\\')) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      collected.push(line.slice(1));
      continue;
    }
    if (line.startsWith(' ') || line === '') {
      collected.push(line.startsWith(' ') ? line.slice(1) : line);
    }
  }

  const result = collected.join('\n').trimEnd();
  return matched && result ? result : '';
};

const extractMarkdownContentFromItem = (item, workingDirectory) => {
  if (!item || typeof item !== 'object') return { content: '', path: '' };
  const directPath = pickFirstPath(item.path, item.file, item.file_path, item.filepath);
  if (directPath && isPlanMarkdownPath(directPath, workingDirectory)) {
    const content = pickFirstText(item.content, item.after, item.text, item.output_text, item.outputText);
    if (content) return { content, path: directPath };
    const patch = pickFirstText(item.patch, item.diff);
    const extracted = extractMarkdownFromPatch(patch, workingDirectory);
    if (extracted) return { content: extracted, path: directPath };
  }

  if (Array.isArray(item.changes)) {
    for (const change of item.changes) {
      const changePath = pickFirstPath(change?.path, change?.file, change?.file_path, change?.filepath);
      if (!changePath || !isPlanMarkdownPath(changePath, workingDirectory)) continue;
      const content = pickFirstText(change?.content, change?.after, change?.text, change?.output_text, change?.outputText);
      if (content) return { content, path: changePath };
      const patch = pickFirstText(change?.patch, change?.diff);
      const extracted = extractMarkdownFromPatch(patch, workingDirectory);
      if (extracted) return { content: extracted, path: changePath };
    }
  }

  const patch = pickFirstText(item.patch, item.diff);
  const extracted = extractMarkdownFromPatch(patch, workingDirectory);
  if (extracted) return { content: extracted, path: '' };
  return { content: '', path: '' };
};

export const extractMarkdownContentFromEvent = (evt, workingDirectory) => {
  if (!evt || typeof evt !== 'object') return { content: '', path: '' };
  const type = normalizeString(evt.type).toLowerCase();
  if (type !== 'item.completed' && type !== 'item.updated') return { content: '', path: '' };
  return extractMarkdownContentFromItem(evt.item, workingDirectory);
};

export const readPlanMarkdownFromDisk = (workingDirectory, { deleteAfterRead = false } = {}) => {
  const planPath = resolvePlanPath(workingDirectory);
  if (!planPath) return { content: '', path: '', existed: false };
  let existed = false;
  try {
    existed = fs.existsSync(planPath);
  } catch {
    existed = false;
  }
  if (!existed) return { content: '', path: planPath, existed: false };
  let content = '';
  try {
    content = normalizeMultilineText(fs.readFileSync(planPath, 'utf8'));
  } catch {
    content = '';
  }
  if (deleteAfterRead) {
    try {
      fs.unlinkSync(planPath);
    } catch {
      // ignore
    }
  }
  return { content, path: planPath, existed: true };
};

export const storePlanMarkdown = (run, content, path) => {
  if (!run || !content) return;
  if (path) {
    const normalizedPath = normalizePathForMatch(path);
    const existingPath = normalizePathForMatch(run.planMarkdownPath);
    if (!existingPath || existingPath === normalizedPath) {
      run.planMarkdownPath = path;
      run.planMarkdown = content;
    }
    return;
  }
  if (!run.planMarkdownPath && !run.planMarkdown) {
    run.planMarkdown = content;
  }
};

export const buildResultTextWithPlan = (run) => {
  const planText = normalizeMultilineText(run?.planMarkdown).trim();
  const outputText = normalizeMultilineText(pickAssistantMessage(run)).trim();
  if (!planText) return outputText;
  const parts = ['😊', planText];
  if (outputText) parts.push(outputText);
  return parts.join('\n\n');
};
