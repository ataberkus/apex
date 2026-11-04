import {randomUUID} from 'node:crypto';
import {readFile, realpath, rename, rm, stat, open} from 'node:fs/promises';
import path from 'node:path';
import {generateDiffString, truncateHead, withFileMutationQueue} from '@earendil-works/pi-coding-agent';

const fail = message => { throw new Error(`Unsupported or invalid unified patch: ${message}`); };
const throwIfAborted = signal => { if (signal?.aborted) throw new Error('Operation aborted'); };

function headerPath(line, prefix) {
  if (!line?.startsWith(prefix)) fail('expected ---/+++ file headers');
  const name = line.slice(prefix.length);
  if (!name || name !== name.trim() || /[\t\0\\]/.test(name)) fail('plain, unquoted relative paths required');
  if (name === '/dev/null') fail('creates and deletes are not supported; target one existing file');
  return name;
}

/** Parse the deliberately narrow, single-file unified format before any file mutation. */
export function parseUnifiedPatch(patch) {
  if (typeof patch !== 'string' || Buffer.byteLength(patch) > 1024 * 1024) fail('patch must be a string of at most 1 MiB');
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  let oldPath = headerPath(lines[0], '--- ');
  let newPath = headerPath(lines[1], '+++ ');
  if (oldPath.startsWith('a/') && newPath.startsWith('b/')) {
    oldPath = oldPath.slice(2);
    newPath = newPath.slice(2);
  }
  if (oldPath !== newPath) fail('renames and multiple files are not supported');
  if (path.isAbsolute(oldPath) || oldPath.split('/').some(part => !part || part === '.' || part === '..') || /^[A-Za-z]:/.test(oldPath)) {
    fail('target must be a relative path without traversal');
  }
  const hunks = [];
  let index = 2;
  while (index < lines.length) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(lines[index++]);
    if (!header) fail('expected a hunk header; multi-file, git metadata and apply_patch envelopes are unsupported');
    const [oldStart, oldCount, newStart, newCount] = [Number(header[1]), Number(header[2] ?? 1), Number(header[3]), Number(header[4] ?? 1)];
    if (![oldStart, oldCount, newStart, newCount].every(Number.isSafeInteger) || (oldCount > 0 && oldStart === 0) || (newCount > 0 && newStart === 0)) {
      fail('invalid hunk positions or counts');
    }
    const records = [];
    while (index < lines.length && !lines[index].startsWith('@@ ')) {
      const line = lines[index++];
      if (line === '\\ No newline at end of file') {
        const previous = records.at(-1);
        if (!previous || previous.marked) fail('misplaced no-newline marker');
        previous.marked = true;
        if (previous.kind !== '+') previous.oldNoNewline = true;
        if (previous.kind !== '-') previous.newNoNewline = true;
      } else {
        const kind = line[0];
        if (![' ', '+', '-'].includes(kind)) {
          fail('invalid hunk line');
        }
        records.push({kind, value: line.slice(1), oldNoNewline: false, newNoNewline: false});
      }
    }
    if (records.filter(record => record.kind !== '+').length !== oldCount || records.filter(record => record.kind !== '-').length !== newCount) {
      fail('hunk line counts do not match header');
    }
    if (!records.some(record => record.kind !== ' ')) fail('hunk has no changes');
    hunks.push({oldStart, oldCount, newStart, newCount, records});
  }
  if (!hunks.length) fail('no hunks');
  return {path: oldPath, hunks};
}

function splitFile(text) {
  return (text.match(/[^\n]*\n|[^\n]+/g) ?? []).map(line => {
    const ending = line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : '';
    return {value: ending ? line.slice(0, -ending.length) : line, ending};
  });
}

function applyExactPatch(raw, parsed) {
  const bom = raw.startsWith('\ufeff') ? '\ufeff' : '';
  const original = splitFile(raw.slice(bom.length));
  const ending = original.find(line => line.ending)?.ending ?? '\n';
  const output = [];
  let consumed = 0;
  let previousPosition = -1;
  for (const hunk of parsed.hunks) {
    const position = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
    const newPosition = hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1;
    if (position < consumed || position <= previousPosition || position > original.length) fail('overlapping, unordered or out-of-range hunks');
    output.push(...original.slice(consumed, position));
    if (newPosition !== output.length) fail('new hunk position does not match accumulated line counts');
    consumed = position;
    previousPosition = position;
    for (const record of hunk.records) {
      if (record.kind !== '+') {
        const actual = original[consumed];
        if (!actual || actual.value !== record.value || (actual.ending === '') !== record.oldNoNewline) {
          fail(`exact context mismatch at old line ${consumed + 1}`);
        }
        consumed++;
        if (record.kind === ' ') output.push(actual);
      } else {
        output.push({value: record.value, ending: record.newNoNewline ? '' : ending});
      }
    }
  }
  output.push(...original.slice(consumed));
  if (output.slice(0, -1).some(line => !line.ending)) fail('no-newline marker is only valid at end of file');
  const result = bom + output.map(line => line.value + line.ending).join('');
  if (result === raw) fail('patch produces no change');
  return result;
}

/** A single existing-file patch. The native queue also serializes native edit/write siblings. */
export function createPatchTool({cwd}) {
  return {
    name: 'apply_patch', label: 'apply_patch',
    description: 'Apply a plain unified patch to one existing file, with exact context and strict hunk counts. Use ---/+++ headers and @@ hunks. Creates, deletes, renames, multiple files, git metadata and *** Begin Patch envelopes are unsupported.',
    promptSnippet: 'Apply an exact unified patch to one existing file',
    parameters: {type: 'object', properties: {patch: {type: 'string', description: 'Single existing-file unified patch with relative path headers'}}, required: ['patch']},
    outputSchema: {type: 'object', properties: {text: {type: 'string'}}, required: ['text']},
    constrainedSampling: {type: 'json_schema', strict: 'prefer'},
    async execute(_id, {patch}, signal, _update, ctx) {
      throwIfAborted(signal);
      const parsed = parseUnifiedPatch(patch);
      const effectiveCwd = path.resolve(ctx?.cwd || cwd);
      const absolute = path.resolve(effectiveCwd, parsed.path);
      return withFileMutationQueue(absolute, async () => {
        throwIfAborted(signal);
        const target = await realpath(absolute);
        const root = await realpath(effectiveCwd);
        const relative = path.relative(root, target);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail('target resolves outside cwd');
        const info = await stat(target);
        if (!info.isFile()) fail('target must be an existing regular file');
        const bytes = await readFile(target);
        throwIfAborted(signal);
        if (bytes.includes(0)) fail('binary files are unsupported');
        let raw;
        try { raw = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes); }
        catch { fail('target must contain valid UTF-8 text'); }
        const replacement = applyExactPatch(raw, parsed);
        throwIfAborted(signal);
        const temporary = path.join(path.dirname(target), `.apex-patch-${randomUUID()}.tmp`);
        let handle;
        try {
          handle = await open(temporary, 'wx', info.mode & 0o777);
          await handle.writeFile(replacement, 'utf8');
          await handle.chmod(info.mode & 0o777);
          await handle.close();
          handle = undefined;
          throwIfAborted(signal);
          await rename(temporary, target);
        } finally {
          await handle?.close();
          await rm(temporary, {force: true});
        }
        const diff = generateDiffString(raw, replacement);
        const compact = truncateHead(diff.diff, {maxLines: 80, maxBytes: 8192});
        const text = `Patched ${parsed.path} (${parsed.hunks.length} hunk(s)).\n${compact.content}${compact.truncated ? '\n[Diff truncated; use read to inspect changed ranges.]' : ''}`;
        return {content: [{type: 'text', text}], structuredContent: {text}, details: {
          diff: compact.content, firstChangedLine: diff.firstChangedLine,
          apexPatch: {path: parsed.path, hunks: parsed.hunks.length, diffTruncated: compact.truncated, atomicRename: true},
        }};
      });
    },
  };
}
