import {constants} from 'node:fs';
import {access, readFile, open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile, spawnSync} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {
  createReadToolDefinition, createEditToolDefinition, createGrepToolDefinition,
  createFindToolDefinition, createLsToolDefinition, detectSupportedImageMimeTypeFromFile, truncateHead,
} from '@earendil-works/pi-coding-agent';
import {createPatchTool} from './patch.mjs';

const runFile = promisify(execFile);
const textOf = content => content.filter(part => part.type === 'text').map(part => part.text).join('\n');
const hash = value => createHash('sha256').update(value).digest('hex');
const textResult = (text, details) => ({content: [{type: 'text', text}], structuredContent: {text}, details});
const outputSchema = {type: 'object', properties: {text: {type: 'string'}}, required: ['text']};

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

function efficientRead(cwd) {
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

async function closestCandidates(cwd, args) {
  // Failure suggestions never influence matching or write files. Bound work and text independently.
  try {
    const file = path.isAbsolute(args.path) ? args.path : path.resolve(cwd, args.path);
    const handle = await open(file, 'r');
    let bytes;
    try {
      const size = (await handle.stat()).size;
      if (size > 2 * 1024 * 1024) return '';
      bytes = Buffer.alloc(size);
      const {bytesRead} = await handle.read(bytes, 0, size, 0);
      bytes = bytes.subarray(0, bytesRead);
    } finally { await handle.close(); }
    if (bytes.includes(0)) return '';
    const lines = bytes.toString('utf8').replace(/\r\n/g, '\n').split('\n');
    const targets = args.edits.map(edit => edit.oldText.split('\n')[0].trim());
    const terms = new Set(targets.flatMap(target => target.match(/[\w$]+/g) ?? []));
    const candidates = lines.slice(0, 20000).map((line, index) => ({line, number: index + 1,
      score: (targets.includes(line.trim()) ? 1000 : 0) + (line.match(/[\w$]+/g) ?? []).filter(word => terms.has(word)).length,
    })).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.number - b.number).slice(0, 3);
    const summary = truncateHead(candidates.map(item => `${item.number}: ${item.line.slice(0, 400)}`).join('\n'), {maxLines: 6, maxBytes: 1800});
    return summary.content ? `\nClosest candidates (approximate suggestions; no edits applied):\n${summary.content}` : '\nClosest candidates: none found in bounded scan; read the relevant range.';
  } catch { return ''; }
}

function efficientEdit(cwd) {
  const native = createEditToolDefinition(cwd);
  return {
    ...native,
    description: 'Edit one file with edits:[{old_string,new_string}] or one old_string/new_string shorthand pair. Every old_string must match a unique, non-overlapping original region. Pi handles whitespace tolerance and mutation serialization. Failures return bounded approximate candidates without applying any edit.',
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
      let result;
      try { result = await native.execute(id, args, signal, update, ctx); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/Could not find|occurrences|overlap|oldText must not be empty/.test(message)) {
          throw new Error(message + await closestCandidates(ctx?.cwd || cwd, args), {cause: error});
        }
        throw error;
      }
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

function groupGrep(body) {
  const groups = new Map();
  for (const line of body.split('\n')) {
    if ((line.match(/:\d+: /g) ?? []).length !== 1) return undefined;
    const match = /^(.*):(\d+): (.*)$/.exec(line);
    if (!match) return undefined; // context rows/ambiguous native format are kept verbatim
    if (!groups.has(match[1])) groups.set(match[1], []);
    groups.get(match[1]).push(`  ${match[2]}: ${match[3]}`);
  }
  return [...groups].map(([file, rows]) => `${file}:\n${rows.join('\n')}`).join('\n');
}

function efficientSearch(cwd, name) {
  const native = ({grep: createGrepToolDefinition, find: createFindToolDefinition, ls: createLsToolDefinition})[name](cwd);
  return {
    ...native, outputSchema, defaultActive: true,
    description: `${native.description} Apex defaults to 80 returned matches/paths/entries. Overflow totals are unknown when the native search stops early; narrow the pattern/path. Grep without context is grouped by file when safely parseable.`,
    async execute(id, input, signal, update, ctx) {
      positive(input.limit, 'limit');
      if (input.context !== undefined && (!Number.isSafeInteger(input.context) || input.context < 0 || input.context > 20)) throw new Error('context must be an integer from 0 to 20');
      if (signal?.aborted) throw new Error('Operation aborted');
      if (name !== 'ls' && !locallyAvailable(name === 'grep' ? ['rg'] : ['fd', 'fdfind'])) {
        throw new Error(`${name === 'grep' ? 'rg' : 'fd/fdfind'} is not available on PATH. Apex will not install search engines; use an existing local engine.`);
      }
      const result = await native.execute(id, {...input, limit: input.limit ?? 80}, signal, update, ctx);
      const original = textOf(result.content);
      const [body] = original.split('\n\n[');
      let empty = /^(?:No matches found|No files found matching pattern|\(empty directory\))$/.test(body);
      const searchRoot = path.resolve(ctx?.cwd || cwd, input.path || '.');
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
      const grouped = name === 'grep' && !(input.context > 0) && !empty ? groupGrep(body) : undefined;
      const text = (grouped ?? body) + original.slice(body.length) + (capped ? '\n[Total unknown: native output reached a cap; refine pattern/path or raise limit.]' :
        !countKnown ? '\n[Total unknown: native text does not provide an unambiguous count.]' : '');
      return textResult(text, {...result.details, apexSearch: {returned: countKnown ? count : null, returnedCountKnown: countKnown,
        total: capped || !countKnown ? null : count, totalKnown: !capped && countKnown, grouped: grouped !== undefined}});
    },
  };
}

export function createEfficientTools({cwd, features}) {
  const tools = [];
  if (features.has('read')) tools.push(efficientRead(cwd));
  if (features.has('search')) tools.push(...['grep', 'find', 'ls'].map(name => efficientSearch(cwd, name)));
  if (features.has('edit')) tools.push(efficientEdit(cwd));
  if (features.has('patch')) tools.push({...createPatchTool({cwd}), ...(features.has('lazy') ? {exposure: 'deferred'} : {})});
  return tools;
}
