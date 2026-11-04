import {constants} from 'node:fs';
import {access, readFile, open, realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile, spawnSync} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {
  createReadToolDefinition, createEditToolDefinition, createGrepToolDefinition, createFindToolDefinition,
  createLsToolDefinition, detectSupportedImageMimeTypeFromFile, generateDiffString, truncateHead,
} from '@earendil-works/pi-coding-agent';
import {createPatchTool} from './patch.mjs';
import {createAstGrepTool} from './ast.mjs';

const runFile = promisify(execFile);
const textOf = content => content.filter(part => part.type === 'text').map(part => part.text).join('\n');
const hash = value => createHash('sha256').update(value).digest('hex');
const textResult = (text, details) => ({content: [{type: 'text', text}], structuredContent: {text}, details});
const outputSchema = {type: 'object', properties: {text: {type: 'string'}}, required: ['text']};
const canonical = file => realpath(file).catch(() => file);
const toLF = text => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
const clip = (value, chars = 400) => value.length > chars ? value.slice(0, chars) : value;
const DRY_RUN = new Error('apex edit dry run');

function countLines(buffer) {
  let count = 1;
  for (let at = buffer.indexOf(10); at >= 0; at = buffer.indexOf(10, at + 1)) count++;
  return count;
}

function newlines(text, from = 0, to = text.length) {
  let count = 0;
  for (let at = text.indexOf('\n', from); at >= 0 && at < to; at = text.indexOf('\n', at + 1)) count++;
  return count;
}

function lineRanges(lines) {
  const parts = [];
  for (let i = 0; i < lines.length; i++) {
    let j = i;
    while (j + 1 < lines.length && lines[j + 1] === lines[j] + 1) j++;
    parts.push(i === j ? `${lines[i]}` : `${lines[i]}-${lines[j]}`);
    i = j;
  }
  return parts.length > 20 ? `${parts.slice(0, 20).join(', ')}, …` : parts.join(', ');
}

async function boundedBytes(file) {
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 2 * 1024 * 1024) return undefined;
    const bytes = Buffer.alloc(info.size);
    const {bytesRead} = await handle.read(bytes, 0, info.size, 0);
    return bytes.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

// Per-session record of the 1-based lines each exact file version (sha256 of raw bytes) displayed in full; port of
// omp edit/store.ts seen lines. Only efficientRead records, so without the read feature no edit is ever guarded.
function seenLineStore() {
  const files = new Map();
  return {
    get: (file, digest) => files.get(file)?.get(digest),
    record(file, digest, first, count) {
      const versions = files.get(file) ?? new Map();
      files.delete(file);
      files.set(file, versions);
      if (files.size > 256) files.delete(files.keys().next().value);
      const seen = versions.get(digest) ?? new Set();
      versions.delete(digest);
      versions.set(digest, seen);
      if (versions.size > 8) versions.delete(versions.keys().next().value);
      for (let line = first; line < first + count; line++) seen.add(line);
    },
    forget: file => files.delete(file),
  };
}

function rawRange(buffer, offset, limit) {
  let start = 0;
  for (let line = 1; line < offset; line++) {
    const next = buffer.indexOf(10, start);
    if (next < 0) return Buffer.alloc(0);
    start = next + 1;
  }
  let end = start;
  for (let line = 0; line < limit; line++) {
    const next = buffer.indexOf(10, end);
    if (next < 0) { end = buffer.length; break; }
    end = next + 1;
  }
  return buffer.subarray(start, end);
}

function positive(value, name) {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new Error(`${name} must be a positive integer`);
}

function originalStillVisible(ctx, record) {
  const manager = ctx?.sessionManager;
  if (!manager?.buildSessionProjection) return false;
  // Native projection excludes other branches, compaction omissions and context_edit removals.
  return manager.buildSessionProjection().entries.some(entry => {
    const original = entry.sourceEntry?.message;
    return original?.role === 'toolResult' && original.toolName === 'read' && original.toolCallId === record.id && !original.isError &&
      JSON.stringify(original.content) === record.content && entry.messages.some(message =>
        message.role === 'toolResult' && message.toolCallId === record.id && message.content?.length > 0 &&
        JSON.stringify(message.content) === record.content);
  });
}

function approximateSymbols(text, file) {
  const extension = path.extname(file).toLowerCase();
  const patterns = extension === '.py' ? [/^\s*(?:async\s+)?(?:def|class)\s+([\w$]+)/] :
    ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(extension) ? [
      /^\s*(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\s+([\w$]+)/,
      /^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=.*(?:=>|function\b)/,
    ] : extension === '.go' ? [/^\s*func\s+(?:\([^)]*\)\s*)?([\w$]+)/, /^\s*type\s+([\w$]+)/] :
    extension === '.rs' ? [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|mod|type)\s+([\w$]+)/] :
    ['.c', '.cc', '.cpp', '.h', '.hpp', '.java', '.cs'].includes(extension) ? [
      /^\s*(?:(?:public|private|protected|abstract|static|final)\s+)*(?:class|struct|enum|namespace|interface)\s+([\w$]+)/,
      /^\s*(?:[\w:*<>\[\]]+\s+)+([\w$]+)\s*\([^;]*\)\s*(?:\{|$)/,
    ] : ['.sh', '.bash'].includes(extension) ? [/^\s*(?:function\s+)?([\w$]+)\s*\(\s*\)\s*\{/] : [];
  return text.split('\n').flatMap((line, index) => {
    const match = patterns.map(pattern => pattern.exec(line)).find(Boolean);
    return match ? [{line: index + 1, name: match[1]}] : [];
  });
}

async function outline(buffer, file, args, cwd, signal) {
  let symbols;
  let source = 'Approximate outline (language-pattern fallback; may omit or misidentify symbols)';
  try {
    // Invoke an existing executable only. Unsupported/missing ctags falls back; no installation.
    const {stdout} = await runFile('ctags', ['--options=NONE', '--output-format=json', '--fields=+n', '--sort=no', '-f', '-', '--', file],
      {cwd, signal, timeout: 5000, maxBuffer: 1024 * 1024});
    const tags = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(tag => tag._type === 'tag' && Number.isSafeInteger(tag.line) && typeof tag.name === 'string');
    symbols = tags.map(tag => ({line: tag.line, name: tag.name, kind: tag.kind}));
    source = 'ctags symbols';
  } catch (error) {
    if (signal?.aborted) throw new Error('Operation aborted');
    symbols = approximateSymbols(buffer.toString('utf8'), file);
  }
  const from = args.offset ?? 1;
  const selected = symbols.filter(symbol => symbol.line >= from).sort((a, b) => a.line - b.line);
  const limit = args.limit ?? 80;
  const visible = selected.slice(0, limit);
  const body = visible.map(symbol => `${symbol.line}: ${symbol.name}${symbol.kind ? ` (${symbol.kind})` : ''}`).join('\n');
  const bounded = truncateHead(body, {maxLines: 80, maxBytes: 8192});
  return `${source}\n${bounded.content || '(No symbols found; use mode=text with offset/limit.)'}${selected.length > visible.length || bounded.truncated ? '\n[Outline capped; narrow offset/limit or read the relevant range.]' : ''}`;
}

function efficientRead(cwd, seen) {
  const base = createReadToolDefinition(cwd);
  const observations = new Map(); // scoped to this factory/session; no persisted cross-task cache
  return {
    ...base,
    description: 'Read text or images. Text defaults to 80 lines with native byte caps; use offset/limit to continue. mode=outline lists ctags symbols when available, otherwise an explicitly approximate language-pattern outline. Unchanged rereads may point to an original observation only while it is unmasked on the active branch.',
    parameters: {...base.parameters, properties: {...base.parameters.properties,
      mode: {type: 'string', enum: ['text', 'outline'], description: 'Text contents or symbol outline (default: text)'},
    }},
    async execute(id, input, signal, update, ctx) {
      positive(input.offset, 'offset');
      positive(input.limit, 'limit');
      const mode = input.mode ?? 'text';
      if (!['text', 'outline'].includes(mode)) throw new Error('mode must be text or outline');
      const args = {...input, offset: input.offset ?? 1, limit: input.limit ?? 80};
      let captured;
      let mime;
      const native = createReadToolDefinition(cwd, {operations: {
        access: file => access(file, constants.R_OK),
        detectImageMimeType: async file => (mime = await detectSupportedImageMimeTypeFromFile(file)),
        readFile: async file => { const buffer = await readFile(file); captured = {file, buffer}; return buffer; },
      }});
      let result = await native.execute(id, args, signal, update, ctx);
      if (mime) return result; // native image attachments and model-specific notes are preserved verbatim
      const {file, buffer} = captured;
      let binary = buffer.includes(0);
      try { new TextDecoder('utf-8', {fatal: true}).decode(buffer); } catch { binary = true; }
      if (binary) return textResult(`Binary file (${buffer.length} bytes); no text content returned.`, {apexRead: {mode, binary: true, bytes: buffer.length}});
      if (mode === 'outline') result = textResult(await outline(buffer, file, args, ctx?.cwd || cwd, signal));
      const key = JSON.stringify([file, mode, args.offset, args.limit]);
      const fileHash = hash(buffer);
      const truncation = result.details?.truncation;
      if (mode === 'text' && !truncation?.firstLineExceedsLimit) {
        // Lines displayed in full by this exact version; a deduplicated pointer still leaves the original visible.
        const count = truncation?.truncated ? truncation.outputLines : Math.min(args.limit, countLines(buffer) - args.offset + 1);
        seen.record(await canonical(file), fileHash, args.offset, count);
      }
      const rangeHash = hash(Buffer.concat([mode === 'outline' ? buffer : rawRange(buffer, args.offset, args.limit), Buffer.from(JSON.stringify(result.content))]));
      const previous = observations.get(key);
      const details = {...result.details, apexRead: {mode, offset: args.offset, limit: args.limit, fileHash, rangeHash, deduplicated: false}};
      if (previous?.fileHash === fileHash && previous.rangeHash === rangeHash && previous.id !== id && originalStillVisible(ctx, previous)) {
        // Keep the original pointer, never create pointer chains whose base may have disappeared.
        return textResult(`[Unchanged ${mode} range offset=${args.offset} limit=${args.limit}; see unmasked read toolCallId=${JSON.stringify(previous.id)} in active context.]`,
          {...details, apexRead: {...details.apexRead, deduplicated: true, originalToolCallId: previous.id}});
      }
      observations.set(key, {id, fileHash, rangeHash, content: JSON.stringify(result.content)});
      if (observations.size > 256) observations.delete(observations.keys().next().value);
      return {...result, details};
    },
  };
}

function prepareAliases(input, native) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  // Let Pi own its JSON-string/object/legacy compatibility preparation, on a copy.
  const prepared = native.prepareArguments({...input});
  let edits = prepared.edits;
  if (typeof edits === 'string') { try { edits = JSON.parse(edits); } catch {} }
  if (edits && !Array.isArray(edits) && typeof edits === 'object') edits = [edits];
  if (Array.isArray(edits)) edits = edits.map(edit => ({old_string: edit.old_string ?? edit.oldText, new_string: edit.new_string ?? edit.newText}));
  if (typeof prepared.old_string === 'string' && typeof prepared.new_string === 'string') {
    edits = [...(Array.isArray(edits) ? edits : []), {old_string: prepared.old_string, new_string: prepared.new_string}];
  }
  return {path: prepared.path, edits};
}

function nativeEdits(input, native) {
  const args = prepareAliases(input, native);
  if (typeof args?.path !== 'string' || !Array.isArray(args.edits) || !args.edits.length || args.edits.some(edit =>
    typeof edit?.old_string !== 'string' || typeof edit?.new_string !== 'string')) throw new Error('Edit input requires path and nonempty edits of old_string/new_string pairs');
  return {path: args.path, edits: args.edits.map(edit => ({oldText: edit.old_string, newText: edit.new_string}))};
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length || !b.length) return a.length || b.length;
  let previous = new Uint32Array(b.length + 1), next = new Uint32Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) previous[j] = j;
  for (let i = 1; i <= a.length; i++) {
    next[0] = i;
    const code = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const replace = previous[j - 1] + (code === b.charCodeAt(j - 1) ? 0 : 1), remove = previous[j] + 1, insert = next[j - 1] + 1;
      next[j] = replace < remove ? (replace < insert ? replace : insert) : (remove < insert ? remove : insert);
    }
    [previous, next] = [next, previous];
  }
  return previous[b.length];
}

// omp fuzzy.rs `similarity`: 1 - levenshtein/maxLen.
const similarity = (a, b) => { const longest = Math.max(a.length, b.length); return longest ? 1 - levenshtein(a, b) / longest : 1; };
const words = line => line.slice(0, 1000).match(/[\w$]+/g) ?? [];

function windowText(lines, start, size) {
  let text = lines[start];
  for (let index = start + 1; index < start + size && text.length < 2000; index++) text += `\n${lines[index]}`;
  return text.slice(0, 2000);
}

/** Best same-height window by similarity, prefiltered by token overlap (port of omp fuzzy.rs format_match_error). */
function closestMatch(lines, old) {
  const wanted = old.split('\n');
  if (wanted.length > 1 && wanted.at(-1) === '') wanted.pop();
  const size = Math.min(wanted.length, lines.length);
  const anchor = wanted.findIndex(line => line.trim());
  if (anchor < 0 || anchor >= size) return undefined;
  const key = wanted[anchor].trim(), terms = new Set(words(key));
  const scored = [];
  for (let start = 0; start + size <= lines.length; start++) {
    const line = lines[start + anchor];
    const score = (line.trim() === key ? 1000 : 0) + words(line).filter(word => terms.has(word)).length;
    if (score) scored.push({start, score});
  }
  scored.sort((a, b) => b.score - a.score || a.start - b.start);
  const target = windowText(wanted, 0, wanted.length);
  let best, budget = 16e6; // Levenshtein cells per edit
  for (const {start} of scored.slice(0, 64)) {
    const candidate = windowText(lines, start, size);
    if (best && (budget -= target.length * candidate.length) < 0) break;
    const score = similarity(target, candidate);
    if (!best || score > best.score) best = {start, score};
  }
  if (!best) return undefined;
  const actual = lines.slice(best.start, best.start + size);
  let index = wanted.findIndex((line, i) => line !== actual[i]);
  if (index < 0) index = 0;
  return `Closest match (${Math.round(best.score * 100)}% similar) at line ${best.start + 1}:\n  - ${clip(wanted[index])}\n  + ${clip(actual[index] ?? '')}`;
}

function occurrences(content, old) {
  const lines = [];
  let count = 0;
  for (let at = content.indexOf(old); at >= 0 && count < 1000; at = content.indexOf(old, at + old.length)) {
    if (count++ < 10) lines.push(newlines(content, 0, at) + 1);
  }
  return {count, lines};
}

async function closestCandidates(cwd, args, message) {
  // Failure suggestions never influence matching or write files. Bound work and text independently.
  try {
    const bytes = await boundedBytes(path.isAbsolute(args.path) ? args.path : path.resolve(cwd, args.path));
    if (!bytes || bytes.includes(0)) return '';
    const content = toLF(bytes.toString('utf8').replace(/^\ufeff/, ''));
    const lines = content.split('\n', 20000);
    const named = Number(/edits\[(\d+)\]/.exec(message)?.[1] ?? 0);
    const order = args.edits.map((_, index) => index).sort((a, b) => (b === named) - (a === named) || a - b);
    const notes = [];
    for (const index of order) {
      if (notes.length === 3) break;
      const old = toLF(args.edits[index].oldText);
      if (!old) continue;
      const found = occurrences(content, old);
      if (found.count === 1) continue;
      const label = args.edits.length > 1 ? `edits[${index}]: ` : '';
      notes.push(label + (found.count > 1 ? `occurs at lines ${found.lines.join(', ')}${found.count > found.lines.length ? ', …' : ''}; add surrounding lines to make it unique.` :
        closestMatch(lines, old) ?? 'Closest match: none found in bounded scan; read the relevant range.'));
    }
    if (!notes.length) return '';
    return `\n${truncateHead(notes.join('\n'), {maxLines: 16, maxBytes: 3000}).content}\n(Suggestions only; no edits applied.)`;
  } catch { return ''; }
}

/** Lines each edit replaces in LF content: the unique exact span, else removed rows of a write-free native dry run. */
async function anchorLines(cwd, args, bytes, content, id, signal, ctx) {
  const anchors = new Set();
  let unresolved = false;
  for (const edit of args.edits) {
    const old = toLF(edit.oldText);
    const at = old ? content.indexOf(old) : -1;
    if (at < 0 || content.indexOf(old, at + 1) >= 0) { unresolved = true; continue; }
    const first = newlines(content, 0, at) + 1, last = first + newlines(old, 0, old.endsWith('\n') ? old.length - 1 : old.length);
    for (let line = first; line <= last; line++) anchors.add(line);
  }
  if (!unresolved) return anchors;
  let written;
  const dry = createEditToolDefinition(cwd, {operations: {access: async () => {}, readFile: async () => bytes,
    writeFile: async (_file, text) => { written = text; throw DRY_RUN; }}});
  try { await dry.execute(id, args, signal, undefined, ctx); } catch (error) { if (error !== DRY_RUN) return undefined; }
  if (written === undefined) return undefined; // match errors: native execute reports them
  for (const row of generateDiffString(content, toLF(written.replace(/^\ufeff/, ''))).diff.split('\n')) {
    const removed = /^-\s*(\d+) /.exec(row);
    if (removed) anchors.add(Number(removed[1]));
  }
  return anchors;
}

/** Port of omp hashline patcher `assert_seen_lines`: refuse edits anchored on lines no read displayed for this version. */
async function assertSeenLines(seen, cwd, args, id, signal, ctx) {
  const file = await canonical(path.resolve(ctx?.cwd || cwd, args.path));
  const bytes = await boundedBytes(file).catch(() => undefined);
  if (!bytes || bytes.includes(0)) return file;
  const shown = seen.get(file, hash(bytes));
  if (!shown) return file; // no snapshot of this exact version: unrestricted, as in omp
  const text = bytes.toString('utf8').replace(/^\ufeff/, '');
  if (/\r(?!\n)/.test(text)) return file; // lone CR: edit line numbers would not match read's
  const content = text.replace(/\r\n/g, '\n');
  const anchors = await anchorLines(cwd, args, bytes, content, id, signal, ctx);
  const unseen = [...anchors ?? []].filter(line => !shown.has(line)).sort((a, b) => a - b);
  if (!unseen.length) return file;
  const source = content.split('\n');
  const where = `${args.path}: ${lineRanges(unseen)}`;
  if (unseen.length > 40 || unseen.some(line => (source[line - 1] ?? '').length > 400)) {
    throw new Error(`Edit anchors on lines never shown in full for this version of ${where}. Read them with offset/limit, then retry.`);
  }
  for (const line of unseen) shown.add(line);
  throw new Error(`Edit anchors on lines never shown in full for this version of ${where}. Shown now:\n${unseen.map(line => `${line}: ${source[line - 1] ?? ''}`).join('\n')}\nRetry the edit if it still applies.`);
}

function efficientEdit(cwd, seen) {
  const native = createEditToolDefinition(cwd);
  return {
    ...native,
    description: 'Edit one file with edits:[{old_string,new_string}] or one old_string/new_string shorthand pair. Every old_string must match a unique, non-overlapping original region. Pi handles whitespace tolerance and mutation serialization. Failures report the closest match without applying any edit. Edits on lines a read never showed for this file version are refused once, revealing those lines.',
    promptGuidelines: native.promptGuidelines.map(line => line.replaceAll('oldText', 'old_string').replaceAll('newText', 'new_string')),
    parameters: {type: 'object', properties: {path: {type: 'string'}, edits: {type: 'array', minItems: 1,
      items: {type: 'object', properties: {old_string: {type: 'string'}, new_string: {type: 'string'}}, required: ['old_string', 'new_string']}},
      old_string: {type: 'string'}, new_string: {type: 'string'}}, required: ['path'], additionalProperties: false},
    prepareArguments: input => prepareAliases(input, native),
    renderCall: (args, theme, context) => {
      let converted;
      try { converted = nativeEdits(args, native); } catch { converted = args; }
      return native.renderCall?.(converted, theme, context);
    },
    outputSchema,
    async execute(id, input, signal, update, ctx) {
      const args = nativeEdits(input, native);
      const file = await assertSeenLines(seen, ctx?.cwd || cwd, args, id, signal, ctx);
      let result;
      try { result = await native.execute(id, args, signal, update, ctx); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/Could not find|occurrences|overlap|oldText must not be empty/.test(message)) {
          throw new Error(message + await closestCandidates(ctx?.cwd || cwd, args, message), {cause: error});
        }
        throw error;
      }
      seen.forget(file); // the written version is unrestricted, like omp's write tag
      const compact = truncateHead(result.details.diff, {maxLines: 80, maxBytes: 8192});
      const text = `${textOf(result.content)}\n${compact.content}${compact.truncated ? '\n[Diff truncated; read changed ranges.]' : ''}`;
      return {...result, content: [{type: 'text', text}], structuredContent: {text}, details: {...result.details, diff: compact.content,
        apexEdit: {diffTruncated: compact.truncated, edits: args.edits.length}}};
    },
  };
}

function locallyAvailable(names) {
  return names.some(name => {
    const result = spawnSync(name, ['--version'], {stdio: 'pipe', timeout: 2000});
    return !result.error && result.status === 0;
  });
}

// Port of omp tools/grep.ts paging: bounded native fetch, file windows of DEFAULT_FILE_LIMIT, per-file match caps.
const GREP_FETCH_CAP = 2000, GREP_FILES = 20, GREP_PER_FILE = 20, GREP_SINGLE_FILE = 200;

async function grepRows(body, root) {
  // Native rows are `path:line: text`; a row with several `:N: ` splits at the leftmost one only if that path exists.
  const rows = [], exists = new Map();
  for (const line of body.split('\n')) {
    const match = /^(.*?):(\d+): (.*)$/.exec(line);
    if (!match) return undefined;
    if ((line.match(/:\d+: /g) ?? []).length > 1) {
      if (!exists.has(match[1])) exists.set(match[1], await access(path.resolve(root, match[1])).then(() => true,
        () => access(path.resolve(path.dirname(root), match[1])).then(() => true, () => false)));
      if (!exists.get(match[1])) return undefined;
    }
    rows.push({file: match[1], line: match[2], text: match[3]});
  }
  return rows;
}

async function pagedGrep(native, id, input, signal, update, ctx, root) {
  const limit = input.limit ?? 80, skip = input.skip ?? 0;
  const {skip: _skip, ...args} = input;
  const result = await native.execute(id, {...args, limit: GREP_FETCH_CAP}, signal, update, ctx);
  const [body] = textOf(result.content).split('\n\n[');
  const {matchLimitReached, ...details} = result.details ?? {};
  const capped = Boolean(matchLimitReached || details.truncation?.truncated);
  if (body === 'No matches found') return textResult(body, {...details, apexSearch: {returned: 0, returnedCountKnown: true, total: 0, totalKnown: true,
    grouped: false, skip, files: 0, filesShown: 0, perFileCap: GREP_PER_FILE}});
  const rows = await grepRows(body, root);
  if (!rows) return undefined;
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.file)) groups.set(row.file, []);
    groups.get(row.file).push(row);
  }
  const perFileCap = groups.size > 1 ? GREP_PER_FILE : GREP_SINGLE_FILE;
  // rg visits files in parallel; sort paths so skip pages are stable across calls.
  const page = [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).slice(skip, skip + GREP_FILES), picked = page.map(() => 0);
  let returned = 0;
  // Round-robin so the total limit cannot be spent on one hot file.
  for (let round = 0, progressed = true; progressed && returned < limit; round++) {
    progressed = false;
    for (let index = 0; index < page.length && returned < limit; index++) {
      if (round < Math.min(perFileCap, page[index][1].length)) { picked[index]++; returned++; progressed = true; }
    }
  }
  const last = rows.at(-1).file, files = groups.size, total = `${files}${capped ? '+' : ''}`; // only the last fetched file can be cut by the cap
  const sections = [], hidden = [];
  page.forEach(([file, matches], index) => {
    if (!picked[index]) return;
    sections.push(`${file}:\n${matches.slice(0, picked[index]).map(row => `  ${row.line}: ${row.text}`).join('\n')}`);
    if (matches.length > picked[index]) hidden.push(`[${matches.length - picked[index]}${capped && file === last ? '+' : ''} more matches in ${file} not shown]`);
  });
  const filesShown = sections.length, next = skip + filesShown, notes = hidden.slice(0, 5);
  if (hidden.length > 5) notes.push(`[${hidden.length - 5} more files with unshown matches]`);
  if (next < files) notes.push(`[Files ${skip + 1}-${next} of ${total} matched; next page skip=${next}]`);
  if (capped) notes.push('[Native search reached its cap; counts are lower bounds. Narrow pattern/path.]');
  if (details.linesTruncated) notes.push('[Some lines truncated to 500 chars; use read for full lines.]');
  const limitHit = page.some(([, matches], index) => Math.min(perFileCap, matches.length) > picked[index]);
  const text = filesShown ? [sections.join('\n'), ...notes].join('\n') : `No more results (${total} files matched; skip=${skip} is past the end)`;
  return textResult(text, {...details, ...(limitHit ? {matchLimitReached: limit} : {}), apexSearch: {returned, returnedCountKnown: true,
    total: capped ? null : rows.length, totalKnown: !capped, grouped: true, skip, files, filesShown, perFileCap}});
}

function efficientSearch(cwd, name) {
  const native = ({grep: createGrepToolDefinition, find: createFindToolDefinition, ls: createLsToolDefinition})[name](cwd);
  return {
    ...native, outputSchema, defaultActive: true,
    ...(name === 'grep' ? {parameters: {...native.parameters, properties: {...native.parameters.properties,
      skip: {type: 'number', description: 'Matched files to skip (paging; no context)'}}}} : {}),
    description: `${native.description} Apex defaults to 80 returned matches/paths/entries. Overflow totals are unknown when the native search stops early; narrow the pattern/path.${name === 'grep' ? ' Without context, grep groups by file, 20 files per page (skip=N pages), at most 20 matches per file (200 for one file).' : ''}`,
    async execute(id, input, signal, update, ctx) {
      positive(input.limit, 'limit');
      if (input.context !== undefined && (!Number.isSafeInteger(input.context) || input.context < 0 || input.context > 20)) throw new Error('context must be an integer from 0 to 20');
      if (input.skip !== undefined) {
        if (!Number.isSafeInteger(input.skip) || input.skip < 0) throw new Error('skip must be a non-negative integer');
        if (name !== 'grep' || input.context > 0) throw new Error('skip pages grep files and requires context 0');
      }
      if (signal?.aborted) throw new Error('Operation aborted');
      if (name !== 'ls' && !locallyAvailable(name === 'grep' ? ['rg'] : ['fd', 'fdfind'])) {
        throw new Error(`${name === 'grep' ? 'rg' : 'fd/fdfind'} is not available on PATH. Apex will not install search engines; use an existing local engine.`);
      }
      const searchRoot = path.resolve(ctx?.cwd || cwd, input.path || '.');
      if (name === 'grep' && !(input.context > 0)) {
        const paged = await pagedGrep(native, id, input, signal, update, ctx, searchRoot);
        if (paged) return paged;
        if (input.skip) throw new Error('skip is unavailable: native grep rows are ambiguous; narrow path/pattern');
      }
      const {skip: _skip, ...args} = input;
      const result = await native.execute(id, {...args, limit: input.limit ?? 80}, signal, update, ctx);
      const original = textOf(result.content);
      const [body] = original.split('\n\n[');
      let empty = /^(?:No matches found|No files found matching pattern|\(empty directory\))$/.test(body);
      // A literal ls/find filename can equal the native empty-output message.
      if (empty && name !== 'grep') {
        try { await access(path.resolve(searchRoot, body)); empty = false; } catch {}
      }
      const rows = empty ? [] : body.split('\n').filter(Boolean);
      const count = name === 'grep' ? rows.filter(line => /^.*:\d+: /.test(line)).length : rows.length;
      const capped = Boolean(result.details?.matchLimitReached || result.details?.resultLimitReached || result.details?.entryLimitReached || result.details?.truncation?.truncated);
      let countKnown = true;
      if (name === 'grep') {
        countKnown = rows.every(line => /^.*:\d+: /.test(line) || (input.context > 0 && /^.*-\d+- /.test(line)));
      } else if (rows.length <= 200) {
        const available = await Promise.all(rows.map(async row => {
          try { await access(path.resolve(searchRoot, row)); return true; } catch { return false; }
        }));
        countKnown = available.every(Boolean);
      } else {
        countKnown = false; // native plain-text results cannot prove unambiguous paths beyond this bounded check
      }
      const text = original + (capped ? '\n[Total unknown: native output reached a cap; refine pattern/path or raise limit.]' :
        !countKnown ? '\n[Total unknown: native text does not provide an unambiguous count.]' : '');
      return textResult(text, {...result.details, apexSearch: {returned: countKnown ? count : null, returnedCountKnown: countKnown,
        total: capped || !countKnown ? null : count, totalKnown: !capped && countKnown, grouped: false}});
    },
  };
}

export function createEfficientTools({cwd, features}) {
  const tools = [];
  // One seen-line store per session; read records it, edit consults it.
  const seen = seenLineStore();
  if (features.has('read')) tools.push(efficientRead(cwd, seen));
  if (features.has('search')) {
    tools.push(...['grep', 'find', 'ls'].map(name => efficientSearch(cwd, name)));
    tools.push({...createAstGrepTool({cwd}), ...(features.has('lazy') ? {exposure: 'deferred'} : {})});
  }
  if (features.has('edit')) tools.push(efficientEdit(cwd, seen));
  if (features.has('patch')) tools.push({...createPatchTool({cwd}), ...(features.has('lazy') ? {exposure: 'deferred'} : {})});
  return tools;
}
