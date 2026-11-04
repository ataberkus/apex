import {constants} from 'node:fs';
import {chmod, link, lstat, mkdir, open, realpath, unlink} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {join, resolve} from 'node:path';
import {stripVTControlCharacters} from 'node:util';
import {runWindowsPrivateHelper} from '../../lib/windows-private-storage.mjs';
import {truncateHead, truncateTail, withFileMutationQueue} from '@earendil-works/pi-coding-agent';

const bytes = text => Buffer.byteLength(text, 'utf8');
const lineCount = text => text ? text.split('\n').length - Number(text.endsWith('\n')) : 0;
const shellFields = new Set(['output', 'truncated', 'full_output_path', 'exit_code', 'wall_time_seconds']);

function nativeShellSchema(event) {
  const value = event.structuredContent;
  return (event.toolName === 'bash' || event.toolName === 'powershell') && value &&
    typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(key => shellFields.has(key)) &&
    typeof value.output === 'string' && typeof value.truncated === 'boolean' &&
    Number.isFinite(value.exit_code) && Number.isFinite(value.wall_time_seconds) &&
    (value.full_output_path === undefined || typeof value.full_output_path === 'string');
}

const diagnostic = /\b(?:error|fail(?:ed|ure)?|assertionerror|exception|fatal|traceback)\b|^E\s|^not ok\b|^npm (?:ERR!|error\b)|:\d+(?::\d+)?[: ]/i;
const progress = line => !diagnostic.test(line) && /\b\d{1,3}%|\[[=#> .-]{5,}\]/.test(line);

function cleanText(raw) {
  const stripped = stripVTControlCharacters(raw).replace(/\r\n/g, '\n');
  const lines = [];
  for (const line of stripped.split('\n')) {
    const updates = line.split('\r');
    // Only discard carriage-return frames identifiable as progress. Other overwritten
    // text may contain failures, so retain it as individual lines.
    if (updates.length > 1 && updates.filter(Boolean).every(progress)) {
      lines.push(updates.filter(Boolean).at(-1) ?? '');
    } else {
      lines.push(...updates);
    }
  }
  const trailingNewline = stripped.endsWith('\n');
  if (trailingNewline) lines.pop();
  const frames = [];
  let previousProgressKey;
  for (const line of lines) {
    const hasBar = progress(line) && /\[[=#> .-]{5,}\]/.test(line);
    const normalized = hasBar ? line.replace(/\[[=#> .-]{5,}\]/g, '').replace(/ {2,}/g, ' ').trimEnd() : line;
    const key = hasBar ? normalized.replace(/\b\d{1,3}%/g, '%') : undefined;
    if (key !== undefined && key === previousProgressKey) frames[frames.length - 1] = normalized;
    else frames.push(normalized);
    previousProgressKey = key;
  }
  const collapsed = [];
  for (let index = 0; index < frames.length;) {
    let next = index + 1;
    while (next < frames.length && frames[next] === frames[index]) next++;
    const count = next - index;
    collapsed.push(count > 1 ? `${frames[index] || '[blank line]'} [×${count}]` : frames[index]);
    index = next;
  }
  return collapsed.join('\n') + (trailingNewline ? '\n' : '');
}

// Pi's tail helper cuts at UTF-8 boundaries; reversing code points gives the same
// guarantee at the head without introducing a second byte-truncation algorithm.
function byteHead(text, budget) {
  if (budget <= 0) return '';
  return Array.from(truncateTail(Array.from(text).reverse().join(''), {maxBytes:budget,maxLines:1}).content)
    .reverse().join('');
}

function boundedLine(line, budget) {
  if (bytes(line) <= budget) return line;
  const marker = ' … ';
  if (budget <= bytes(marker)) return byteHead(line, budget);
  const available = budget - bytes(marker);
  const headBudget = Math.ceil(available / 2);
  return byteHead(line, headBudget) + marker +
    truncateTail(line, {maxBytes:available - headBudget,maxLines:1}).content;
}

function commandMode(event) {
  const command = String(event.input?.command ?? '');
  if (/\bgit\s+(?:diff|show|log)\b/.test(command)) return 'diff';
  if (/\b(?:pytest|vitest|jest|mocha|unittest)\b|\b(?:npm|pnpm|yarn|bun|cargo|go)\s+(?:run\s+)?test\b|--test\b/.test(command)) return 'test';
  if (/\b(?:npm|pnpm|yarn|bun|pip|pip3|uv|apt|apt-get)\s+(?:install|ci|add|sync)\b/.test(command)) return 'package';
  if (/\b(?:tsc|gcc|g\+\+|clang|rustc|eslint|ruff|pyright|mypy)\b/.test(command)) return 'diagnostic';
  return 'generic';
}

function selectText(clean, pointer, event, maxBytes, maxLines) {
  const fits = text => !truncateHead(text, {maxBytes,maxLines}).truncated;
  const complete = `${clean.replace(/\n$/, '')}\n${pointer}`;
  if (fits(complete)) return complete;
  const lines = clean.split('\n');
  if (clean.endsWith('\n')) lines.pop();
  const selected = new Map();
  function render() {
    const output = [];
    let next = 0;
    for (const [index, line] of [...selected].sort(([a], [b]) => a - b)) {
      if (index > next) output.push(`[… ${index - next} lines omitted …]`);
      output.push(line);
      next = index + 1;
    }
    if (next < lines.length) output.push(`[… ${lines.length - next} lines omitted …]`);
    output.push(pointer);
    return output.join('\n');
  }
  // render() emits newline-free elements ending in the non-empty pointer, so fits(render()) holds
  // exactly when elements <= maxLines and their joined bytes <= maxBytes. add() tracks both
  // incrementally: re-rendering for every candidate line took seconds on megabyte outputs.
  const omittedBytes = bytes('[…  lines omitted …]') + 1; // gap marker without its ASCII digits, plus newline
  const markerBytes = gap => gap > 0 ? omittedBytes + String(gap).length : 0;
  let order, total, count;
  function account() {
    order = [...selected.keys()].sort((a, b) => a - b);
    total = bytes(pointer); count = 1;
    let previous = -1;
    for (const index of [...order, lines.length]) {
      total += markerBytes(index - previous - 1); count += Number(index - previous - 1 > 0);
      if (index < lines.length) { total += bytes(selected.get(index)) + 1; count++; }
      previous = index;
    }
  }
  function add(index, candidate = lines[index]) {
    if (index < 0 || index >= lines.length || selected.has(index)) return false;
    let low = 0, high = order.length;
    while (low < high) { const middle = (low + high) >> 1; if (order[middle] < index) low = middle + 1; else high = middle; }
    const before = low > 0 ? order[low - 1] : -1, after = low < order.length ? order[low] : lines.length;
    const nextTotal = total - markerBytes(after - before - 1) + markerBytes(index - before - 1) + markerBytes(after - index - 1) + bytes(candidate) + 1;
    const nextCount = count - Number(after - before - 1 > 0) + Number(index - before - 1 > 0) + Number(after - index - 1 > 0) + 1;
    if (nextCount > maxLines || nextTotal > maxBytes) return false;
    selected.set(index, candidate);
    order.splice(low, 0, index);
    total = nextTotal; count = nextCount;
    return true;
  }

  // Reserve both boundaries before diagnostic selection. Oversized individual lines
  // retain their own beginning and end; markers and newlines count against the cap.
  if (lines.length) {
    selected.set(0, lines[0]);
    selected.set(lines.length - 1, lines.at(-1));
    if (!fits(render())) {
      const fixedBytes = bytes(pointer) + 80;
      let quota = Math.max(1, Math.floor((maxBytes - fixedBytes) / (lines.length === 1 ? 1 : 2)));
      while (quota > 0) {
        selected.set(0, boundedLine(lines[0], quota));
        selected.set(lines.length - 1, boundedLine(lines.at(-1), quota));
        if (fits(render())) break;
        quota = Math.floor(quota / 2);
      }
      if (!fits(render())) selected.clear();
    }
  }
  // From here on `selected` changes only through add().
  account();

  // Prioritize distinct failures and diff lines, then their context. These are
  // heuristic observations, never an authoritative declaration of test success.
  const mode = commandMode(event);
  const hot = [];
  const seen = new Set();
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if ((diagnostic.test(line) || /^@@|^[+-](?![+-])/.test(line)) && !seen.has(line)) {
      seen.add(line);
      hot.push(index);
    }
  }
  const hotBudget = Math.max(1, Math.floor(maxBytes / 4));
  for (const index of hot) {
    // boundedLine returns a line within budget unchanged, so retrying it cannot succeed.
    if (!add(index) && !selected.has(index) && bytes(lines[index]) > hotBudget) {
      add(index, boundedLine(lines[index], hotBudget));
    }
  }
  const radius = mode === 'test' || mode === 'diff' ? 2 : 1;
  for (const index of hot) {
    for (let distance = 1; distance <= radius; distance++) {
      add(index - distance);
      add(index + distance);
    }
  }
  for (let offset = 1; offset < lines.length; offset++) {
    add(offset);
    add(lines.length - offset - 1);
  }
  const result = render();
  if (fits(result)) return result;
  if (fits(pointer)) return pointer;
  // Extremely small caps cannot contain a log pathname. The recoverable path still
  // appears in apexShape metadata; use a bounded ASCII marker for model content.
  return byteHead('[elided]', maxBytes);
}

async function ownedDirectory(path) {
  let created = false;
  try { await mkdir(path, {mode:0o700}); created = true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const before = await lstat(path);
  if (!before.isDirectory() || before.isSymbolicLink() ||
    (typeof process.getuid === 'function' && before.uid !== process.getuid())) {
    throw new Error('Apex output directory must be an owned directory, never a symlink');
  }
  if (created) {
    // Umask can remove even owner permissions from a newly created directory.
    // Validate identity before/after restoring only this fresh owned directory.
    const current = await lstat(path);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino || current.uid !== before.uid) {
      throw new Error('Apex output directory changed');
    }
    await chmod(path, 0o700);
    const restored = await lstat(path);
    if (!restored.isDirectory() || restored.isSymbolicLink() || restored.dev !== before.dev || restored.ino !== before.ino || restored.uid !== before.uid) {
      throw new Error('Apex output directory changed');
    }
  } else if ((before.mode & 0o777) !== 0o700) {
    throw new Error('Existing Apex output directory must already have private owner permissions');
  }
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const actual = await directory.stat();
    if (actual.dev !== before.dev || actual.ino !== before.ino) throw new Error('Apex output directory changed');
    return directory;
  } catch (error) { await directory.close(); throw error; }
}

async function directoryAnchor(directory, expected) {
  const current = await lstat(expected);
  const pinned = await directory.stat();
  if (!current.isDirectory() || current.isSymbolicLink() ||
    current.dev !== pinned.dev || current.ino !== pinned.ino || await realpath(expected) !== expected) {
    throw new Error('Apex output directory changed');
  }
  // Prefer descriptor-relative paths. Minimal containers may expose neither fd
  // filesystem; their fallback retains explicit directory/inode checks and the
  // native mutation queue, but cannot exclude unrelated hostile ancestor renames.
  const anchor = `${process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd'}/${directory.fd}`;
  try {
    if (await realpath(anchor) !== expected) throw new Error('Apex output directory changed');
    return anchor;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return expected;
  }
}

async function windowsSpill(root, name, raw) {
  await runWindowsPrivateHelper(root, {name, raw});
  return {logPath:join(root, '.apex', 'out', name), relativePath:`.apex/out/${name}`};
}

async function spillText(cwd, callId, raw) {
  const root = await realpath(resolve(cwd));
  const apexPath = join(root, '.apex');
  return withFileMutationQueue(apexPath, async () => {
    const safeId = String(callId ?? 'call').replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 16) || 'call';
    const name = `${safeId}-${randomBytes(16).toString('hex')}.log`;
    if (process.platform === 'win32') return windowsSpill(root, name, raw);
    let apex;
    let out;
    let temporary;
    let final;
    let outputAnchor;
    let published = false;
    try {
      apex = await ownedDirectory(apexPath);
      const apexAnchor = await directoryAnchor(apex, apexPath);
      const outPath = join(apexPath, 'out');
      out = await ownedDirectory(join(apexAnchor, 'out'));
      outputAnchor = await directoryAnchor(out, outPath);
      temporary = join(outputAnchor, `.${name}.tmp`);
      final = join(outputAnchor, name);
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await directoryAnchor(apex, apexPath);
        await directoryAnchor(out, outPath);
        const ownedFile = await file.stat();
        if (!ownedFile.isFile() || ownedFile.nlink !== 1 ||
          (typeof process.getuid === 'function' && ownedFile.uid !== process.getuid())) {
          throw new Error('Apex log must be a fresh owned regular file');
        }
        await file.chmod(0o600);
        await file.writeFile(raw, 'utf8');
        await file.sync();
      }
      finally { await file.close(); }
      await directoryAnchor(apex, apexPath);
      await directoryAnchor(out, outPath);
      // A hard link publishes the complete synced file atomically and refuses to
      // overwrite any existing destination, including a symlink.
      await link(temporary, final);
      published = true;
      await unlink(temporary);
      temporary = undefined;
      await out.sync();
      await directoryAnchor(apex, apexPath);
      await directoryAnchor(out, outPath);
      return {logPath:join(outPath, name),relativePath:`.apex/out/${name}`};
    } catch (error) {
      if (published && final) await unlink(final).catch(() => {});
      throw error;
    } finally {
      if (temporary) await unlink(temporary).catch(() => {});
      if (out) await out.close();
      if (apex) await apex.close();
    }
  });
}

/** Shape only schemas whose native semantics are known; all other results remain intact. */
export async function shapeToolResult(event, {cwd, maxBytes = 8192, maxLines = 120} = {}) {
  // Nested results are program inputs (for example codemode JSON), not direct
  // model observations. Let the parent consume them intact and shape its output.
  if (event?.parentToolCallId !== undefined) return undefined;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !Number.isSafeInteger(maxLines) || maxLines <= 0) {
    throw new RangeError('Apex shaping caps must be a positive integer');
  }
  if (!Array.isArray(event?.content)) return undefined;
  const nativeStructured = nativeShellSchema(event);
  if (event.structuredContent !== undefined && !nativeStructured) return undefined;
  const textBlocks = event.content.filter(block => block.type === 'text');
  if (!textBlocks.length || textBlocks.some(block => typeof block.text !== 'string')) return undefined;
  // Interleaved captions can depend on image order; do not merge such text blocks.
  if (textBlocks.length > 1 && textBlocks.length !== event.content.length) return undefined;
  const raw = textBlocks.map(block => block.text).join('\n');
  const clean = cleanText(raw);
  if (clean === raw && !truncateHead(raw, {maxBytes,maxLines}).truncated) return undefined;
  let spill;
  try { spill = await spillText(cwd, event.toolCallId, raw); }
  catch (error) {
    // Pi reports thrown tool-result hook errors while preserving the original
    // result. Windows ACL/native-policy failures must not look like successful
    // shaping; POSIX keeps its existing fail-closed return contract.
    if (process.platform === 'win32') throw new Error(
      `Apex retained raw output: secure Windows spill unavailable (requires Windows PowerShell/.NET Framework, native directory handles and protected owner-only ACLs): ${error.message}`,
      {cause:error});
    return undefined;
  }
  const pointer = `[Apex shaped; hook log ${spill.relativePath}]`;
  const shaped = selectText(clean, pointer, event, maxBytes, maxLines);
  let firstText = true;
  const content = event.content.flatMap(block => {
    if (block.type !== 'text') return [block];
    if (!firstText) return [];
    firstText = false;
    return [{...block, text:shaped}];
  });
  const nativeFullOutputPath = [event.details?.fullOutputPath, event.structuredContent?.full_output_path]
    .find(path => typeof path === 'string' && path.length > 0);
  const structuredContent = nativeStructured ? {
    ...event.structuredContent,
    output:shaped,
    truncated:true,
    full_output_path:nativeFullOutputPath ?? spill.logPath,
  } : undefined;
  return {
    content,
    structuredContent,
    details:{
      ...event.details,
      apexShape:{
        originalBytes:bytes(raw), returnedBytes:bytes(shaped),
        originalLines:lineCount(raw), returnedLines:lineCount(shaped),
        ...(nativeStructured ? {structuredOriginalBytes:bytes(event.structuredContent.output)} : {}),
        logPath:spill.logPath, logScope:'hook-visible-result', logFormat:'text-content',
        ...(nativeFullOutputPath ? {nativeFullOutputPath} : {}),
        sourceTruncated:Boolean(event.details?.truncation?.truncated || event.structuredContent?.truncated),
      },
    },
  };
}
