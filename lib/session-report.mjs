/** Bounded, read-only inspection of exact Pi v3 JSONL. No SDK initialization. */
import {constants} from 'node:fs';
import {lstat, open} from 'node:fs/promises';
import path from 'node:path';
import {summarizeSession} from '../extensions/apex-features/accounting.mjs';
import {linkFreeRealpath} from './real-path.mjs';

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const TYPES = new Set(['message', 'thinking_level_change', 'model_change', 'usage', 'compaction', 'branch_summary',
  'custom', 'label', 'session_info', 'custom_message', 'context_edit']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const fingerprint = (value, depth = 0) => {
  if (depth > 64) throw new Error('Session data exceeds nesting depth limit.');
  if (Array.isArray(value)) return `[${value.map(item => fingerprint(item, depth + 1)).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${fingerprint(value[key], depth + 1)}`).join(',')}}`;
  return JSON.stringify(value);
};

function boundedShape(value) {
  const stack = [[value, 0]]; let nodes = 0;
  while (stack.length) {
    const [current, depth] = stack.pop();
    if (++nodes > 200000 || depth > 64) throw new Error('Session data exceeds nesting or node limit.');
    if (current !== null && typeof current === 'object') for (const child of Object.values(current)) stack.push([child, depth + 1]);
  }
}

function validMessage(message) {
  if (!object(message) || !identity(message.role)) return false;
  if (message.role === 'assistant') {
    if (!identity(message.provider) || !identity(message.model) || !Array.isArray(message.content)) return false;
    for (const part of message.content) if (part?.type === 'toolCall' &&
      (!identity(part.id) || !identity(part.name) || !object(part.arguments))) return false;
  }
  if (message.role === 'toolResult' && !identity(message.toolCallId)) return false;
  return true;
}

async function noSymlink(file) {
  const absolute = path.resolve(file); const parsed = path.parse(absolute); let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep)) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Session symlinks are not allowed.');
  }
  if (!await linkFreeRealpath(absolute)) throw new Error('Session symlink resolution is not allowed.');
  return absolute;
}

async function readBounded(file, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) throw new Error('Invalid session byte limit.');
  if (typeof file !== 'string' || !file || file.includes('\0')) throw new Error('Invalid session file.');
  const absolute = await noSymlink(file); const before = await lstat(absolute);
  if (!before.isFile()) throw new Error('Session must be a regular file.');
  if (before.size > maxBytes) throw new Error('Session exceeds byte limit.');
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('Session file changed during inspection.');
    const buffer = Buffer.alloc(maxBytes + 1); let bytes = 0;
    while (bytes < buffer.length) {
      const result = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
    }
    if (bytes > maxBytes) throw new Error('Session exceeds byte limit.');
    const after = await handle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || bytes !== after.size) throw new Error('Session file changed during inspection.');
    await noSymlink(absolute);
    let text;
    try {text = new TextDecoder('utf-8', {fatal: true}).decode(buffer.subarray(0, bytes));}
    catch {throw new Error('Session has invalid UTF-8 encoding.');}
    return {file: absolute, bytes, text};
  } finally {await handle.close();}
}

function parseNative(text) {
  const rows = []; const lines = text.split('\n'); let tornTail = false;
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) throw new Error(`Session line ${index + 1} exceeds line limit.`);
    let row;
    try {row = JSON.parse(line);} catch {
      if (index === lines.length - 1 && !text.endsWith('\n')) {tornTail = true; continue;}
      throw new Error(`Malformed session JSON at line ${index + 1}.`);
    }
    if (!object(row)) throw new Error(`Invalid session record at line ${index + 1}.`);
    boundedShape(row);
    rows.push(row);
  }
  const header = rows.shift();
  if (!header || header.type !== 'session' || header.version !== 3 || !identity(header.id) ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(header.id) ||
    typeof header.cwd !== 'string' || header.cwd.length > 4096 || !path.isAbsolute(header.cwd) || typeof header.timestamp !== 'string' || !Number.isFinite(Date.parse(header.timestamp)) ||
    Object.keys(header).some(key => !['type', 'version', 'id', 'timestamp', 'cwd', 'parentSession'].includes(key)) ||
    (header.parentSession !== undefined && (typeof header.parentSession !== 'string' || header.parentSession.length > 4096))) {
    throw new Error('Invalid native v3 session header or id.');
  }
  const byId = new Map(); let leafId = null;
  for (const row of rows) {
    if (!TYPES.has(row.type) || !identity(row.id) || !(row.parentId === null || identity(row.parentId)) ||
      typeof row.timestamp !== 'string' || !Number.isFinite(Date.parse(row.timestamp))) throw new Error('Invalid native session entry metadata.');
    if (row.type === 'message' && !validMessage(row.message)) throw new Error('Invalid native session message or tool entry.');
    if (byId.has(row.id)) {
      if (fingerprint(byId.get(row.id)) !== fingerprint(row)) throw new Error('Conflicting session entry identity.');
    } else {
      // Pi appends parents before children. This also rejects cycles and orphans.
      if (row.parentId !== null && !byId.has(row.parentId)) throw new Error('Session entry has missing or forward parent.');
      byId.set(row.id, row);
    }
    leafId = row.id;
  }
  const branch = []; let entry = byId.get(leafId);
  while (entry) {branch.push(entry); entry = byId.get(entry.parentId);}
  branch.reverse();
  return {header, rows, branch, leafId, tornTail, unterminatedTail: text.length > 0 && !text.endsWith('\n')};
}

function resumeMetadata(parsed) {
  const pending = new Map(); let model = null; let thinkingLevel = 'off';
  for (const entry of parsed.branch) {
    if (entry.type === 'model_change' && identity(entry.provider) && identity(entry.modelId)) model = {provider: entry.provider, id: entry.modelId};
    if (entry.type === 'thinking_level_change' && identity(entry.thinkingLevel)) thinkingLevel = entry.thinkingLevel;
    if (entry.type !== 'message') continue;
    const message = entry.message;
    if (message?.role === 'assistant' && identity(message.provider) && identity(message.model)) model = {provider: message.provider, id: message.model};
    if (message?.role === 'assistant' && Array.isArray(message.content)) {
      for (const call of message.content) if (call?.type === 'toolCall' && identity(call.id)) {
        pending.set(call.id, {id: call.id, name: identity(call.name) ? call.name : 'unknown', entryId: entry.id});
      }
    }
    if (message?.role === 'toolResult') pending.delete(message.toolCallId);
  }
  return {header: structuredClone(parsed.header), leafId: parsed.leafId, branchIds: parsed.branch.map(entry => entry.id),
    model, thinkingLevel, tornTail: parsed.tornTail, unterminatedTail: parsed.unterminatedTail,
    pendingTools: [...pending.values()], replaySafe: false, replayPerformed: false,
    warning: parsed.tornTail || pending.size > 0 ? 'Inspection cannot replay unresolved tool side effects.' : null};
}

export async function readSessionReport(file, {maxBytes = DEFAULT_MAX_BYTES} = {}) {
  const source = await readBounded(file, maxBytes); const parsed = parseNative(source.text);
  const summary = summarizeSession(parsed.rows);
  if (parsed.tornTail) {
    for (const scope of [summary, ...summary.tasks]) {
      scope.completeness.usage = false; scope.completeness.cost = false; scope.completeness.thinking = false;
      scope.completeness.issues.push('torn_tail');
      for (const key of Object.keys(scope.totals)) scope.totals[key] = null;
      scope.cost.nativeEstimateUsd = null; scope.cost.pricingEstimateUsd = null;
    }
  }
  return {file: source.file, bytes: source.bytes, entryCount: parsed.rows.length, ...resumeMetadata(parsed), summary};
}

export async function inspectResume(file) {
  const source = await readBounded(file, DEFAULT_MAX_BYTES);
  return {file: source.file, bytes: source.bytes, ...resumeMetadata(parseNative(source.text))};
}
