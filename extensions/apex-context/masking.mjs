import { resolve } from 'node:path';

function textContent(message) {
  if (!Array.isArray(message.content) || message.content.length === 0) return undefined;
  if (!message.content.every(block => block?.type === 'text' && typeof block.text === 'string')) return undefined;
  return message.content.map(block => block.text).join('\n');
}

function recoveryLog(message) {
  const native = message.details?.fullOutputPath ?? message.details?.apexShape?.nativeFullOutputPath;
  if (typeof native === 'string' && native.length > 0) return { path: native, scope: 'full log' };
  const shape = message.details?.apexShape;
  if (typeof shape?.logPath === 'string' && shape.logPath.length > 0 && shape.logScope === 'hook-visible-result') {
    return { path: shape.logPath, scope: 'observed hook-visible log' };
  }
  return undefined;
}

function oneLine(value, maxCharacters = 180) {
  const text = String(value).replace(/[\r\n\u2028\u2029]/g, ' ');
  return text.length > maxCharacters ? `${text.slice(0, maxCharacters - 1)}…` : text;
}

// Pi's user-limit continuation notice; truncation notices also set details.truncation.
const MORE_LINES = /\[\d+ more lines in file\. Use offset=/;

/** Supersede identity of a read call, mirroring the arguments the read tool keys on. */
function readKey(path, args) {
  return JSON.stringify([path, args.offset ?? 1, args.limit ?? 'default', args.mode ?? 'text']);
}

/** A read shows its whole file only with positive proof: first page, no cap or continuation notice. */
function completeRead(message, args, text) {
  const read = message.details?.apexRead;
  if ((args.offset ?? 1) !== 1 || message.details?.truncation || MORE_LINES.test(text)) return false;
  return (args.mode ?? read?.mode ?? 'text') === 'text' && read?.binary !== true && read?.deduplicated !== true;
}

/**
 * Plan append-only observation edits at a native turn boundary. The threshold is
 * a UTF-8 bytes/4 proxy, not a provider token or billed-cache measurement.
 */
export function planMasking(event, ctx, { keepTurns = 4, thresholdTokens = 4000 } = {}) {
  if (!Number.isInteger(keepTurns) || keepTurns < 1 || !Number.isFinite(thresholdTokens) || thresholdTokens < 0) return undefined;
  const projected = event?.context?.contextEntries ?? ctx?.sessionManager?.buildSessionProjection?.().entries;
  if (!Array.isArray(projected)) return undefined;
  const priorDrafts = Array.isArray(event?.entries) ? event.entries : [];
  const editedTargets = new Set(priorDrafts.filter(entry => entry.type === 'context_edit').map(entry => entry.targetId));
  for (const entry of projected) {
    if (entry.sourceEntry?.type === 'context_edit') editedTargets.add(entry.sourceEntry.targetId);
  }

  let turn = 0;
  const calls = new Map();
  const observations = [];
  const latestReads = new Map();
  for (const entry of projected) {
    for (const message of entry.messages ?? []) {
      if (message.role === 'assistant') {
        turn += 1;
        for (const block of Array.isArray(message.content) ? message.content : []) {
          if (block.type === 'toolCall' && typeof block.id === 'string') calls.set(block.id, { ...block, turn });
        }
      } else if (message.role === 'toolResult' && entry.sourceEntry?.type === 'message') {
        const call = calls.get(message.toolCallId);
        const observation = { entry, message, call };
        observations.push(observation);
        const visibleText = textContent(message);
        if (message.toolName === 'read' && message.isError === false && visibleText !== undefined
          && !editedTargets.has(entry.sourceEntry.id) && !/^\[elided:/.test(visibleText)
          && typeof call?.arguments?.path === 'string') {
          observation.readPath = resolve(ctx?.cwd ?? process.cwd(), call.arguments.path);
          latestReads.set(observation.readPath, entry.sourceEntry.id);
        }
      }
    }
  }

  // Newest → oldest (omp pruning): only a NEWER successful read of the same key,
  // or a newer complete read of the path, supersedes. Dedup pointers supersede
  // nothing and pin the original observation they point to.
  const supersededBy = new Map();
  const pinned = new Set();
  const newerByKey = new Map();
  const newerComplete = new Map();
  for (let index = observations.length - 1; index >= 0; index -= 1) {
    const { entry, message, call, readPath } = observations[index];
    const read = message.toolName === 'read' ? message.details?.apexRead : undefined;
    if (read?.deduplicated === true) {
      if (typeof read.originalToolCallId === 'string') pinned.add(read.originalToolCallId);
      continue;
    }
    if (!readPath) continue;
    const key = readKey(readPath, call.arguments);
    const newer = newerByKey.get(key) ?? newerComplete.get(readPath);
    if (newer) supersededBy.set(entry.sourceEntry.id, newer);
    if (!newerByKey.has(key)) newerByKey.set(key, message.toolCallId);
    if (!newerComplete.has(readPath) && completeRead(message, call.arguments, textContent(message))) newerComplete.set(readPath, message.toolCallId);
  }

  const drafts = [];
  let eligibleBytes = 0;
  for (const { entry, message, call, readPath } of observations) {
    const targetId = entry.sourceEntry.id;
    if (!call || call.name !== message.toolName || turn - call.turn < keepTurns || editedTargets.has(targetId)) continue;
    if (message.isError !== false || message.structuredContent !== undefined) continue;
    // Parent success does not imply nested success: codemode can catch failures
    // or receive structured nonzero Bash results. Preserve every nested parent
    // until masking also tracks nested latest-read ownership and status fully.
    if (Object.hasOwn(message, 'nestedCalls') || Object.hasOwn(message.details ?? {}, 'calls')) continue;
    if (readPath && latestReads.get(readPath) === targetId) continue;
    if (message.toolName === 'read' && pinned.has(message.toolCallId)) continue;
    const text = textContent(message);
    const log = recoveryLog(message);
    const newer = log ? undefined : supersededBy.get(targetId);
    if (text === undefined || (!log && !newer) || /^\[elided:/.test(text)) continue;
    const bytes = Buffer.byteLength(text, 'utf8');
    const argument = call.arguments?.command ?? call.arguments?.path ?? call.arguments?.pattern ?? '';
    const status = message.toolName === 'bash' || message.toolName === 'powershell' ? 'exit 0' : 'ok';
    const observed = `${text.split('\n').length} observed lines, ${bytes} observed bytes`;
    const stub = newer
      ? `[elided: read ${JSON.stringify(oneLine(call.arguments.path))} superseded by newer read toolCallId=${JSON.stringify(oneLine(newer, 80))}; ok, ${observed}]`
      : `[elided: ${oneLine(message.toolName)} ${JSON.stringify(oneLine(argument))} → ${status}, ${observed}; ${log.scope} ${JSON.stringify(log.path)}]`;
    // A replacement that is larger than its original observation saves no context.
    if (Buffer.byteLength(stub, 'utf8') >= bytes) continue;
    eligibleBytes += bytes;
    drafts.push({ type: 'context_edit', targetId, replacement: { content: [{ type: 'text', text: stub }] } });
  }
  if (drafts.length === 0 || Math.ceil(eligibleBytes / 4) < thresholdTokens) return undefined;
  return { entries: [...priorDrafts, ...drafts] };
}
