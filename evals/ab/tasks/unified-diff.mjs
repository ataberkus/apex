import {gitRepo, hiddenTests, npm, read, unchanged, verdict, writeTree} from '../lib.mjs';

// Fixture sources are String.raw: what you see is what lands in the file (no backticks or ${ inside).
const SPEC = String.raw`# udiff specification

This document is the complete specification of unifiedDiff (src/diff.js) and of the udiff command (bin/udiff.js).

## 1. API

    import {unifiedDiff} from './src/diff.js';
    unifiedDiff(oldText, newText, {context = 3, oldName = 'a', newName = 'b'} = {})

oldText and newText are strings. The options object and each of its properties are optional. context is a
non-negative integer. The function returns the diff as a string and has no side effects.

## 2. Lines

- A text is split into lines at "\n" only. Every line except possibly the last one ends with "\n"; the "\n" is not
  part of the line's content.
- "\r" is ordinary content: "a\r\nb\r\n" has two lines, with contents "a\r" and "b\r".
- A final "\n" does not start another line: "a\nb\n" has two lines, "a\nb" has two lines (the second one without
  "\n"), "\n" has one empty line and "" has no lines at all.
- Two lines are equal only when their contents are equal and either both end with "\n" or neither does. The last
  line of "x" is therefore not equal to the line of "x\n".

## 3. Edit script

A diff describes an edit script: every line of the old text is either kept or deleted, every line of the new text
is either kept or inserted, and the kept old lines are paired, in order, with equal kept new lines (the kept lines
form a common subsequence of the two texts).

- The edit script must be minimal: the number of deleted lines plus the number of inserted lines must be as small
  as possible, i.e. N + M - 2L, where N and M are the numbers of lines of the old and the new text and L is the
  length of a longest common subsequence of their lines. When several minimal edit scripts exist, any one of them
  is acceptable.
- A change is a maximal run of deleted and inserted lines with no kept line inside it. Within a change, all deleted
  lines are written first, in old-text order, followed by all inserted lines, in new-text order.

## 4. Output

If oldText === newText the result is "" (the empty string). Otherwise it is

    --- <oldName>
    +++ <newName>
    <one or more hunks>

The names are written exactly as given, with nothing added (no timestamps, no tabs). Every line of the output ends
with "\n", including the last one.

## 5. Hunks

Let C be the context option.

- Grouping. Take the changes in order. A change belongs to the same hunk as the previous change when the number of
  kept lines between the two changes is at most 2C; otherwise it starts a new hunk. (With C = 0 every change is a
  hunk of its own.)
- Contents. A hunk consists of the C kept lines just before its first change (or all kept lines before it, when
  there are fewer than C), then its changes together with all kept lines between them, then the C kept lines just
  after its last change (or all kept lines after it, when there are fewer than C).
- Hunks are written in text order. In a hunk, a kept line is written as " " followed by its content, a deleted line
  as "-" followed by its content and an inserted line as "+" followed by its content; each of these body lines is
  terminated by "\n".
- Header. Each hunk starts with the line

      @@ -<old range> +<new range> @@

  with nothing before or after it. The old range describes the hunk's old lines (kept and deleted), the new range
  its new lines (kept and inserted). A range is written "<start>,<count>", where count is the number of those lines
  and start is the 1-based line number of the first of them, with two exceptions:
  - when count is 1, only "<start>" is written ("@@ -7 +7,2 @@", never "-7,1");
  - when count is 0, start is the number of lines of that text that come before the hunk, i.e. the number of the
    line just before the empty range, and 0 at the beginning of the text ("@@ -0,0 +1,2 @@", "@@ -3,0 +4 @@").

## 6. Missing newline at end of file

When a body line shows a line that does not end with "\n" (the last line of a text that does not end with "\n"),
that body line is immediately followed by the line

    \ No newline at end of file

This applies to deleted lines (the old text's last line), inserted lines (the new text's last line) and kept lines.
A kept line without "\n" is the last line of both texts; it is followed by one such marker line.

## 7. Examples

    unifiedDiff("", "a\nb\n")

    --- a
    +++ b
    @@ -0,0 +1,2 @@
    +a
    +b

    unifiedDiff("1\n2\n3\n4\n5\n", "1\n2\nX\n3\n4\n5\n", {context: 0})

    --- a
    +++ b
    @@ -2,0 +3 @@
    +X

    unifiedDiff("x\ny", "x\nz", {oldName: "old/f.txt", newName: "new/f.txt"})

    --- old/f.txt
    +++ new/f.txt
    @@ -1,2 +1,2 @@
     x
    -y
    \ No newline at end of file
    +z
    \ No newline at end of file

    unifiedDiff("a", "a\n")

    --- a
    +++ b
    @@ -1 +1 @@
    -a
    \ No newline at end of file
    +a

## 8. Performance

For two texts of 50,000 lines each (about 2 MB each) that differ in about 20 places spread over the whole text
(about 30 deleted plus inserted lines in total), unifiedDiff must return in under 2 seconds on this machine,
measured around the call. Such texts contain many repeated lines (blank lines, lines such as "}"), and the edit
script must still be minimal. An algorithm whose running time or memory grows with N x M cannot meet this; use one
whose cost grows with (N + M) x D, where D is the number of deleted plus inserted lines, such as Myers' O(ND)
difference algorithm.

## 9. Command line

    node bin/udiff.js [-U <n>] <old-file> <new-file>

- Reads both files as UTF-8 and writes unifiedDiff(oldContent, newContent, {context: n, oldName: <old-file>,
  newName: <new-file>}) to standard output, exactly: nothing is added or removed (in particular no extra newline at
  the end). The names are the two file arguments exactly as typed.
- -U <n> sets the context (default 3). It is the only option and, when used, comes first, as two separate
  arguments; <n> must be a non-negative decimal integer (digits only).
- Exit status: 0 when the two files have identical content, 1 when they differ, 2 on a usage error (a malformed
  -U, or not exactly two file arguments) or when a file cannot be read. With status 2 nothing is written to
  standard output, and an error message is written to standard error.
`;

const NAIVE = String.raw`/** Unified diff of two texts. The output format is specified in docs/SPEC.md. */
export function unifiedDiff(oldText, newText, {context = 3, oldName = 'a', newName = 'b'} = {}) {
  if (oldText === newText) return '';
  const ops = editScript(splitLines(oldText), splitLines(newText));
  let out = '--- ' + oldName + '\n+++ ' + newName + '\n';
  for (const hunk of hunks(ops, context)) {
    out += '@@ -' + hunk.oldStart + ',' + hunk.oldCount + ' +' + hunk.newStart + ',' + hunk.newCount + ' @@\n';
    for (const op of hunk.ops) {
      out += op.type + op.line.text + '\n';
      if (!op.line.eol) out += '\\ No newline at end of file\n';
    }
  }
  return out;
}

/** Lines of a text; eol is false for a last line without a line break. */
function splitLines(text) {
  if (text === '') return [];
  const parts = text.split(/\r?\n/);
  const eol = parts[parts.length - 1] === '';
  if (eol) parts.pop();
  return parts.map((text, i) => ({text, eol: eol || i < parts.length - 1}));
}

/** Walk both texts; on a mismatch, resynchronise on whichever line reappears soonest. */
function editScript(a, b) {
  const ops = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i].text === b[j].text) {
      ops.push({type: ' ', line: a[i], oldIndex: i++, newIndex: j++});
      continue;
    }
    const inNew = i < a.length ? b.findIndex((line, k) => k >= j && line.text === a[i].text) : -1;
    const inOld = j < b.length ? a.findIndex((line, k) => k >= i && line.text === b[j].text) : -1;
    if (inNew === -1 && inOld === -1) {
      if (i < a.length) ops.push({type: '-', line: a[i], oldIndex: i++, newIndex: j});
      if (j < b.length) ops.push({type: '+', line: b[j], oldIndex: i, newIndex: j++});
    } else if (inOld === -1 || (inNew !== -1 && inNew - j <= inOld - i)) {
      while (j < inNew) ops.push({type: '+', line: b[j], oldIndex: i, newIndex: j++});
    } else {
      while (i < inOld) ops.push({type: '-', line: a[i], oldIndex: i++, newIndex: j});
    }
  }
  return ops;
}

/** Group changes that are close together; each hunk gets context unchanged lines around it. */
function hunks(ops, context) {
  const groups = [];
  let current = null, lastChange = -Infinity;
  ops.forEach((op, index) => {
    if (op.type === ' ') return;
    if (current && index - lastChange - 1 < 2 * context) current.end = index;
    else groups.push(current = {start: index, end: index});
    lastChange = index;
  });
  return groups.map(({start, end}) => {
    const from = Math.max(0, start - context), to = Math.min(ops.length, end + context + 1);
    const slice = ops.slice(from, to);
    return {ops: slice, oldStart: ops[from].oldIndex + 1, newStart: ops[from].newIndex + 1,
      oldCount: slice.filter(op => op.type !== '+').length, newCount: slice.filter(op => op.type !== '-').length};
  });
}
`;

const NAIVE_CLI = String.raw`#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {unifiedDiff} from '../src/diff.js';

const args = process.argv.slice(2);
let context = 3;
if (args[0] === '-U') {
  context = Number(args[1]);
  args.splice(0, 2);
}
const [oldFile, newFile] = args;
console.log(unifiedDiff(readFileSync(oldFile, 'utf8'), readFileSync(newFile, 'utf8'), {context, oldName: oldFile, newName: newFile}));
`;

const VISIBLE_TESTS = String.raw`import test from 'node:test';
import assert from 'node:assert/strict';
import {unifiedDiff} from '../src/diff.js';

const numbers = n => Array.from({length: n}, (_, i) => String(i + 1) + '\n').join('');

test('identical texts give an empty diff', () => {
  assert.equal(unifiedDiff('same\n', 'same\n'), '');
});

test('one changed line in the middle', () => {
  assert.equal(unifiedDiff(numbers(10), numbers(10).replace('5\n', 'five\n'), {oldName: 'old/list.txt', newName: 'new/list.txt'}),
    '--- old/list.txt\n+++ new/list.txt\n@@ -2,7 +2,7 @@\n 2\n 3\n 4\n-5\n+five\n 6\n 7\n 8\n');
});

test('appending a line', () => {
  assert.equal(unifiedDiff('1\n2\n3\n', '1\n2\n3\n4\n'), '--- a\n+++ b\n@@ -1,3 +1,4 @@\n 1\n 2\n 3\n+4\n');
});
`;

const FILES = {
  'package.json': JSON.stringify({name: 'udiff', version: '1.0.0', type: 'module', bin: {udiff: 'bin/udiff.js'},
    scripts: {test: 'node --test test/*.test.js'}}, null, 2) + '\n',
  'README.md': '# udiff\n\nA small unified diff library and CLI. The format is specified in docs/SPEC.md.\n',
  'docs/SPEC.md': SPEC,
  'src/diff.js': NAIVE,
  'bin/udiff.js': NAIVE_CLI,
  'test/diff.test.js': VISIBLE_TESTS,
};

// ---- Reference pieces. Real functions, stringified into the reference solution and into the hidden verifier. ----
// Lines are kept raw (with their "\n", if any), so equality includes the terminator as SPEC section 2 requires.

function splitLines(text) {
  const lines = text.split('\n').map(line => line + '\n');
  const last = lines.pop();
  if (last !== '\n') lines.push(last.slice(0, -1));
  return lines;
}

/** Myers' greedy O((N+M)D) shortest edit script; ops are {t: ' ' | '-' | '+', line}. */
function myers(a, b) {
  const n = a.length, m = b.length, off = n + m + 1;
  const v = new Int32Array(2 * off + 1), trace = [];
  search: for (let d = 0; ; d++) {
    trace.push(v.slice(off - d, off + d + 1)); // furthest x per diagonal after round d - 1, index k + d
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) break search;
    }
  }
  const ops = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const t = trace[d], k = x - y;
    const down = k === -d || (k !== d && t[k - 1 + d] < t[k + 1 + d]);
    const pk = down ? k + 1 : k - 1, px = t[pk + d];
    while (x > (down ? px : px + 1)) { ops.push({t: ' ', line: a[--x]}); y--; }
    if (down) ops.push({t: '+', line: b[--y]}); else ops.push({t: '-', line: a[--x]});
    y = x - pk;
  }
  while (x > 0) ops.push({t: ' ', line: a[--x]});
  return ops.reverse();
}

/** Within each run of changed lines, deletions first, then insertions. */
function canonical(ops) {
  const out = [];
  for (let i = 0; i < ops.length;) {
    if (ops[i].t === ' ') { out.push(ops[i++]); continue; }
    let j = i;
    while (j < ops.length && ops[j].t !== ' ') j++;
    const run = ops.slice(i, j);
    out.push(...run.filter(op => op.t === '-'), ...run.filter(op => op.t === '+'));
    i = j;
  }
  return out;
}

/** The unique output SPEC sections 4-6 prescribe for a (canonical) edit script. */
function render(ops, context, oldName, newName) {
  const changes = [];
  ops.forEach((op, i) => { if (op.t !== ' ') changes.push(i); });
  if (!changes.length) return '';
  const pos = [[0, 0]];
  for (const op of ops) { const [o, n] = pos[pos.length - 1]; pos.push([o + (op.t !== '+'), n + (op.t !== '-')]); }
  const range = (start, count) => count === 1 ? String(start + 1) : (count ? start + 1 : start) + ',' + count;
  const marker = '\\ No newline at end of file\n';
  let out = '--- ' + oldName + '\n+++ ' + newName + '\n';
  for (let c = 0; c < changes.length;) {
    let last = c;
    while (last + 1 < changes.length && changes[last + 1] - changes[last] - 1 <= 2 * context) last++;
    const lo = Math.max(0, changes[c] - context), hi = Math.min(ops.length, changes[last] + context + 1);
    out += '@@ -' + range(pos[lo][0], pos[hi][0] - pos[lo][0]) + ' +' + range(pos[lo][1], pos[hi][1] - pos[lo][1]) + ' @@\n';
    for (let i = lo; i < hi; i++) {
      const line = ops[i].line;
      out += ops[i].t + line + (line.endsWith('\n') ? '' : '\n' + marker);
    }
    c = last + 1;
  }
  return out;
}

const REFERENCE = `/** Unified diff of two texts. The output format is specified in docs/SPEC.md. */
export function unifiedDiff(oldText, newText, {context = 3, oldName = 'a', newName = 'b'} = {}) {
  if (oldText === newText) return '';
  return render(canonical(myers(splitLines(oldText), splitLines(newText))), context, oldName, newName);
}

${splitLines}

${myers}

${canonical}

${render}
`;

const REFERENCE_CLI = String.raw`#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {unifiedDiff} from '../src/diff.js';

const fail = message => { process.stderr.write('udiff: ' + message + '\n'); process.exit(2); };
const args = process.argv.slice(2);
let context = 3;
if (args[0] === '-U') {
  if (!/^\d+$/.test(args[1] ?? '')) fail('-U needs a non-negative integer');
  context = Number(args[1]);
  args.splice(0, 2);
}
if (args.length !== 2) fail('usage: udiff [-U <n>] <old-file> <new-file>');
let texts;
try { texts = args.map(file => readFileSync(file, 'utf8')); } catch (error) { fail(error.message); }
const diff = unifiedDiff(texts[0], texts[1], {context, oldName: args[0], newName: args[1]});
process.stdout.write(diff);
process.exitCode = diff ? 1 : 0;
`;

// ---- Hidden verifier pieces. ----

/** Strict patch application: no fuzz, header positions and counts must be exact. Returns the new lines and the edit script. */
function applyPatch(a, out) {
  const rows = out.split('\n');
  if (rows.pop() !== '') throw new Error('the output does not end with a newline');
  if (!rows[0]?.startsWith('--- ') || !rows[1]?.startsWith('+++ ')) throw new Error('missing ---/+++ header lines');
  const result = [], ops = [];
  let i = 0, r = 2;
  while (r < rows.length) {
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/.exec(rows[r++]);
    if (!h) throw new Error('bad hunk header ' + JSON.stringify(rows[r - 1]));
    const oc = h[2] === undefined ? 1 : +h[2], nc = h[4] === undefined ? 1 : +h[4];
    const os = oc ? +h[1] - 1 : +h[1], ns = nc ? +h[3] - 1 : +h[3];
    if (os < i || os > a.length) throw new Error('hunk ' + rows[r - 1] + ' is out of order or out of range');
    while (i < os) { result.push(a[i]); ops.push({t: ' ', line: a[i++]}); }
    if (ns !== result.length) throw new Error('hunk ' + rows[r - 1] + ': new start does not match its position');
    let seenOld = 0, seenNew = 0;
    while (r < rows.length && !rows[r].startsWith('@@')) {
      const row = rows[r++], t = row[0];
      const noEol = rows[r] === '\\ No newline at end of file';
      if (noEol) r++;
      const line = row.slice(1) + (noEol ? '' : '\n');
      if (t === ' ' || t === '-') {
        if (a[i] !== line) throw new Error('old line ' + (i + 1) + ' is ' + JSON.stringify(a[i]) + ', the patch has ' + JSON.stringify(line));
        i++; seenOld++;
      } else if (t !== '+') throw new Error('bad body line ' + JSON.stringify(row));
      if (t !== '-') { result.push(line); seenNew++; }
      ops.push({t, line});
    }
    if (seenOld !== oc || seenNew !== nc) throw new Error('hunk ' + h[0] + ' has ' + seenOld + ' old and ' + seenNew + ' new lines');
  }
  while (i < a.length) { result.push(a[i]); ops.push({t: ' ', line: a[i++]}); }
  return {result, ops};
}

function lcs(a, b) {
  let prev = new Array(b.length + 1).fill(0);
  for (const x of a) {
    const cur = [0];
    for (let j = 0; j < b.length; j++) cur.push(x === b[j] ? prev[j] + 1 : Math.max(prev[j + 1], cur[j]));
    prev = cur;
  }
  return prev[b.length];
}

/** Applies the agent's output strictly, checks minimality and that the layout is the one SPEC prescribes for its edit script. */
function checkPatch(oldText, newText, options, expectedEdits, out = unifiedDiff(oldText, newText, options)) {
  const label = '\n' + JSON.stringify({oldText: oldText.slice(0, 300), newText: newText.slice(0, 300), options}) + '\ngot:\n' + String(out).slice(0, 1500);
  assert.equal(typeof out, 'string', label);
  if (oldText === newText) return assert.equal(out, '', 'identical texts must give ""' + label);
  const a = splitLines(oldText), b = splitLines(newText);
  let applied;
  try { applied = applyPatch(a, out); } catch (error) { assert.fail('the patch does not apply: ' + error.message + label); }
  assert.ok(applied.result.length === b.length && applied.result.every((line, i) => line === b[i]), 'the patch does not produce the new text' + label);
  const edits = applied.ops.filter(op => op.t !== ' ').length;
  assert.equal(edits, expectedEdits ?? a.length + b.length - 2 * lcs(a, b), 'not a minimal diff' + label);
  const {context = 3, oldName = 'a', newName = 'b'} = options ?? {};
  assert.equal(out, render(canonical(applied.ops), context, oldName, newName), 'hunk layout does not follow docs/SPEC.md' + label);
}

function exampleTests() {
  const numbers = n => Array.from({length: n}, (_, i) => String(i + 1) + '\n').join('');
  const exact = [
    ['', '', {}, ''],
    ['a', 'a', {}, ''],
    ['', 'a\nb\n', {}, '--- a\n+++ b\n@@ -0,0 +1,2 @@\n+a\n+b\n'],
    ['a\n', '', {}, '--- a\n+++ b\n@@ -1 +0,0 @@\n-a\n'],
    ['\n', '', {}, '--- a\n+++ b\n@@ -1 +0,0 @@\n-\n'],
    ['a', 'a\n', {}, '--- a\n+++ b\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+a\n'],
    ['x\ny', 'x\nz', {oldName: 'old dir/f.txt', newName: 'new dir/f.txt'},
      '--- old dir/f.txt\n+++ new dir/f.txt\n@@ -1,2 +1,2 @@\n x\n-y\n\\ No newline at end of file\n+z\n\\ No newline at end of file\n'],
    ['1\n2\n3', '0\n2\n3', {}, '--- a\n+++ b\n@@ -1,3 +1,3 @@\n-1\n+0\n 2\n 3\n\\ No newline at end of file\n'],
    ['1\n2\n3\n', '1\n2\n3', {context: 1}, '--- a\n+++ b\n@@ -2,2 +2,2 @@\n 2\n-3\n+3\n\\ No newline at end of file\n'],
    ['1\n2\n3\n4\n5\n', '1\n2\nX\n3\n4\n5\n', {context: 0}, '--- a\n+++ b\n@@ -2,0 +3 @@\n+X\n'],
    ['1\n2\n3\n4\n5\n', '1\n2\n4\n5\n', {context: 0}, '--- a\n+++ b\n@@ -3 +2,0 @@\n-3\n'],
    ['a\r\nb\r\nc\r\n', 'a\r\nB\r\nc\r\n', {}, '--- a\n+++ b\n@@ -1,3 +1,3 @@\n a\r\n-b\r\n+B\r\n c\r\n'],
    ['a\r\nb\n', 'a\nb\n', {}, '--- a\n+++ b\n@@ -1,2 +1,2 @@\n-a\r\n+a\n b\n'],
    [numbers(20), numbers(20).replace('\n5\n', '\nfive\n').replace('\n12\n', '\ntwelve\n'), {},
      '--- a\n+++ b\n@@ -2,14 +2,14 @@\n 2\n 3\n 4\n-5\n+five\n 6\n 7\n 8\n 9\n 10\n 11\n-12\n+twelve\n 13\n 14\n 15\n'],
    [numbers(20), numbers(20).replace('\n5\n', '\nfive\n').replace('\n13\n', '\nthirteen\n'), {},
      '--- a\n+++ b\n@@ -2,7 +2,7 @@\n 2\n 3\n 4\n-5\n+five\n 6\n 7\n 8\n@@ -10,7 +10,7 @@\n 10\n 11\n 12\n-13\n+thirteen\n 14\n 15\n 16\n'],
    [numbers(12), numbers(12).replace('\n5\n', '\nfive\n').replace('\n8\n', '\neight\n'), {context: 1},
      '--- a\n+++ b\n@@ -4,6 +4,6 @@\n 4\n-5\n+five\n 6\n 7\n-8\n+eight\n 9\n'],
    [numbers(12), numbers(12).replace('\n5\n', '\nfive\n').replace('\n9\n', '\nnine\n'), {context: 1},
      '--- a\n+++ b\n@@ -4,3 +4,3 @@\n 4\n-5\n+five\n 6\n@@ -8,3 +8,3 @@\n 8\n-9\n+nine\n 10\n'],
    [numbers(20), numbers(20).replace('\n10\n', '\nten\n'), {context: 5},
      '--- a\n+++ b\n@@ -5,11 +5,11 @@\n 5\n 6\n 7\n 8\n 9\n-10\n+ten\n 11\n 12\n 13\n 14\n 15\n'],
    [numbers(10), numbers(10).replace('\n2\n', '\ntwo\n'), {}, '--- a\n+++ b\n@@ -1,5 +1,5 @@\n 1\n-2\n+two\n 3\n 4\n 5\n'],
    [numbers(10), numbers(8), {}, '--- a\n+++ b\n@@ -6,5 +6,3 @@\n 6\n 7\n 8\n-9\n-10\n'],
    [numbers(10), 'X\n' + numbers(10), {}, '--- a\n+++ b\n@@ -1,3 +1,4 @@\n+X\n 1\n 2\n 3\n'],
    [numbers(10), 'X\n' + numbers(10), {context: 0}, '--- a\n+++ b\n@@ -0,0 +1 @@\n+X\n'],
    ['a\nb\nc\n', 'x\ny\n', {}, '--- a\n+++ b\n@@ -1,3 +1,2 @@\n-a\n-b\n-c\n+x\n+y\n'],
  ];
  test('spec examples and edge cases', () => {
    for (const [oldText, newText, options, want] of exact) {
      assert.equal(unifiedDiff(oldText, newText, options), want, JSON.stringify({oldText, newText, options}));
      checkPatch(oldText, newText, options);
    }
  });
  test('options default individually and the options object may be omitted', () => {
    assert.equal(unifiedDiff('a\n', 'b\n'), '--- a\n+++ b\n@@ -1 +1 @@\n-a\n+b\n');
    assert.equal(unifiedDiff('a\n', 'b\n', {oldName: 'x'}), '--- x\n+++ b\n@@ -1 +1 @@\n-a\n+b\n');
  });
}

function minimalTests() {
  test('repeated lines still give a minimal diff', () => {
    const cases = [
      ['a\nb\nc\na\nb\nb\na\n', 'c\nb\na\nb\na\nc\n'],
      ['a\nb\nc\nd\ne\nf\n', 'd\ne\nf\na\nb\nc\n'],
      ['x\na\nb\nx\na\nb\n', 'a\nb\nx\na\nb\nx\n'],
      ['}\n}\n\n}\nreturn\n}\n', '}\n\nreturn\n}\n}\n}\n'],
      ['a\na\na\nb\n', 'b\na\na\na\n'],
      ['p\nq\np\nq\np\nq\n', 'q\np\nq\np\n'],
    ];
    for (const [oldText, newText] of cases) for (const context of [0, 1, 3]) checkPatch(oldText, newText, {context});
  });
  test('random texts: minimal, applicable and laid out as specified', () => {
    let seed = 20261004;
    const rand = n => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
    const pool = ['a\n', 'b\n', 'c\n', '\n', '}\n', 'a\r\n', ' a\n', 'line\n'];
    const text = n => {
      let lines = Array.from({length: n}, () => pool[rand(pool.length)]).join('');
      if (lines && rand(4) === 0) lines = lines.slice(0, -1);
      return lines;
    };
    for (let round = 0; round < 600; round++) {
      const oldText = text(rand(26));
      let newText;
      if (rand(3) === 0) newText = text(rand(26));
      else {
        const lines = splitLines(oldText);
        for (let edits = 1 + rand(4); edits > 0; edits--) {
          const at = rand(lines.length + 1);
          if (rand(2) && lines.length) lines.splice(at, 1);
          else lines.splice(at, 0, pool[rand(pool.length)]);
        }
        newText = lines.map((line, i) => i < lines.length - 1 && !line.endsWith('\n') ? line + '\n' : line).join('');
        if (rand(5) === 0) newText = newText.endsWith('\n') ? newText.slice(0, -1) : newText + '\n';
      }
      checkPatch(oldText, newText, {context: [0, 1, 2, 3, 5][rand(5)]});
    }
  });
}

/** 50,000 repetitive lines; deleted lines are unique to the old text and inserted lines unique to the new one, so the minimum is exactly `edits`. */
function bigCase() {
  const a = [], b = ['// generated\n'];
  let edits = 1, spots = 0;
  for (let i = 0; i < 50000; i++) {
    const line = i % 9 === 4 ? '}\n' : i % 13 === 6 ? '\n' : '  total += item' + i + ' * rate; // step ' + i + '\n';
    a.push(line);
    if (i % 2500 !== 1234 || line.length < 3) { b.push(line); continue; }
    const kind = spots++ % 3;
    if (kind === 0) edits += 1;
    else if (kind === 1) { b.push('  replaced(' + spots + ');\n'); edits += 2; }
    else { b.push('  inserted(' + spots + ');\n', '  inserted(' + spots + ', 2);\n', line); edits += 2; }
  }
  a.push('end of file\n');
  b.push('end of file');
  return {oldText: a.join(''), newText: b.join(''), edits: edits + 2};
}

function largeTests() {
  test('50,000-line texts: minimal and under 2 seconds', () => {
    const {oldText, newText, edits} = bigCase();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'udiff-large-'));
    try {
      const file = name => path.join(dir, name);
      writeFileSync(file('old.txt'), oldText);
      writeFileSync(file('new.txt'), newText);
      writeFileSync(file('time.mjs'), 'import {readFileSync, writeFileSync} from "node:fs";\n' +
        'const {unifiedDiff} = await import(' + JSON.stringify(DIFF_URL) + ');\n' +
        'const a = readFileSync(' + JSON.stringify(file('old.txt')) + ', "utf8"), b = readFileSync(' + JSON.stringify(file('new.txt')) + ', "utf8");\n' +
        'const start = performance.now();\nconst out = unifiedDiff(a, b);\nconst ms = performance.now() - start;\n' +
        'writeFileSync(' + JSON.stringify(file('result.json')) + ', JSON.stringify({ms, out}));\n');
      const child = spawnSync(process.execPath, [file('time.mjs')], {encoding: 'utf8', timeout: 10000, windowsHide: true});
      assert.equal(child.status, 0, 'diffing did not finish within 10 s: ' + (child.error?.message ?? '') + child.stderr.slice(-1500));
      const {ms, out} = JSON.parse(readFileSync(file('result.json'), 'utf8'));
      assert.ok(ms < 2000, 'unifiedDiff took ' + Math.round(ms) + ' ms');
      checkPatch(oldText, newText, {}, edits, out);
    } finally { rmSync(dir, {recursive: true, force: true}); }
  });
}

function cliTests() {
  test('udiff command line', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'udiff-cli-'));
    try {
      const numbers = n => Array.from({length: n}, (_, i) => String(i + 1) + '\n').join('');
      writeFileSync(path.join(dir, 'old.txt'), numbers(10));
      writeFileSync(path.join(dir, 'new.txt'), numbers(10).replace('\n5\n', '\nfive\n'));
      writeFileSync(path.join(dir, 'crlf1.txt'), 'a\r\nb\r\n');
      writeFileSync(path.join(dir, 'crlf2.txt'), 'a\r\nc\r\n');
      const udiff = (...args) => spawnSync(process.execPath, [CLI_PATH, ...args], {cwd: dir, encoding: 'utf8', timeout: 20000, windowsHide: true});
      const expect = (args, status, stdout) => {
        const got = udiff(...args);
        assert.equal(got.status, status, 'exit status of udiff ' + args.join(' ') + '\n' + got.stderr);
        if (stdout !== undefined) assert.equal(got.stdout, stdout, 'stdout of udiff ' + args.join(' '));
      };
      expect(['old.txt', 'new.txt'], 1, '--- old.txt\n+++ new.txt\n@@ -2,7 +2,7 @@\n 2\n 3\n 4\n-5\n+five\n 6\n 7\n 8\n');
      expect(['-U', '1', 'old.txt', 'new.txt'], 1, '--- old.txt\n+++ new.txt\n@@ -4,3 +4,3 @@\n 4\n-5\n+five\n 6\n');
      expect(['-U', '0', 'old.txt', 'new.txt'], 1, '--- old.txt\n+++ new.txt\n@@ -5 +5 @@\n-5\n+five\n');
      expect(['crlf1.txt', 'crlf2.txt'], 1, '--- crlf1.txt\n+++ crlf2.txt\n@@ -1,2 +1,2 @@\n a\r\n-b\r\n+c\r\n');
      expect(['old.txt', path.join(dir, 'old.txt')], 0, '');
      expect(['old.txt', 'missing.txt'], 2, '');
      expect(['old.txt'], 2, '');
      expect(['old.txt', 'new.txt', 'crlf1.txt'], 2, '');
      expect(['-U', 'x', 'old.txt', 'new.txt'], 2, '');
      expect(['-U', '-1', 'old.txt', 'new.txt'], 2, '');
    } finally { rmSync(dir, {recursive: true, force: true}); }
  });
}

const HIDDEN_HEADER = `import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const DIFF_URL = '@ROOT@src/diff.js', CLI_PATH = fileURLToPath('@ROOT@bin/udiff.js');
const {unifiedDiff} = await import(DIFF_URL);
${splitLines}
${canonical}
${render}
${applyPatch}
${lcs}
${checkPatch}
${bigCase}
`;
const hidden = (root, body, name) => hiddenTests(root, HIDDEN_HEADER + `${body}\n(${body.name})();\n`, name);

// ---- Plausible wrong solutions (applied on top of the reference). ----

function greedy(a, b) {
  const ops = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { ops.push({t: ' ', line: a[i]}); i++; j++; continue; }
    const inNew = i < a.length ? b.indexOf(a[i], j) : -1, inOld = j < b.length ? a.indexOf(b[j], i) : -1;
    if (inNew === -1 && inOld === -1) {
      if (i < a.length) ops.push({t: '-', line: a[i++]});
      if (j < b.length) ops.push({t: '+', line: b[j++]});
    } else if (inOld === -1 || (inNew !== -1 && inNew - j <= inOld - i)) while (j < inNew) ops.push({t: '+', line: b[j++]});
    else while (i < inOld) ops.push({t: '-', line: a[i++]});
  }
  return ops;
}

/** Hirschberg's linear-space LCS: minimal and correct, but O(N x M) time. */
function hirschberg(a, b) {
  const ops = [];
  const lastRow = (x, y) => {
    let prev = new Int32Array(y.length + 1);
    for (const line of x) {
      const cur = new Int32Array(y.length + 1);
      for (let j = 0; j < y.length; j++) cur[j + 1] = line === y[j] ? prev[j] + 1 : Math.max(prev[j + 1], cur[j]);
      prev = cur;
    }
    return prev;
  };
  const solve = (a0, a1, b0, b1) => {
    if (a0 === a1) { for (let j = b0; j < b1; j++) ops.push({t: '+', line: b[j]}); return; }
    if (a1 - a0 === 1) {
      const at = b.slice(b0, b1).indexOf(a[a0]);
      if (at === -1) { ops.push({t: '-', line: a[a0]}); for (let j = b0; j < b1; j++) ops.push({t: '+', line: b[j]}); return; }
      for (let j = b0; j < b0 + at; j++) ops.push({t: '+', line: b[j]});
      ops.push({t: ' ', line: a[a0]});
      for (let j = b0 + at + 1; j < b1; j++) ops.push({t: '+', line: b[j]});
      return;
    }
    const mid = (a0 + a1) >> 1, top = lastRow(a.slice(a0, mid), b.slice(b0, b1));
    const bottom = lastRow(a.slice(mid, a1).reverse(), b.slice(b0, b1).reverse());
    let best = -1, split = b0;
    for (let j = 0; j <= b1 - b0; j++) if (top[j] + bottom[b1 - b0 - j] > best) { best = top[j] + bottom[b1 - b0 - j]; split = b0 + j; }
    solve(a0, mid, b0, split);
    solve(mid, a1, split, b1);
  };
  solve(0, a.length, 0, b.length);
  return ops;
}

const patched = (source, from, to) => {
  if (!source.includes(from)) throw new Error('mustReject patch target not found: ' + from);
  return source.replace(from, to);
};
const withDiff = source => root => writeTree(root, {'src/diff.js': source});
const MYERS_CALL = 'myers(splitLines(oldText), splitLines(newText))';

export default {
  id: 'unified-diff',
  category: 'spec with hidden edge cases',
  prompt: 'The unified diff library in this repository does not follow its specification. Make unifiedDiff in src/diff.js and the command line tool bin/udiff.js conform exactly to docs/SPEC.md: every rule in it, including the performance requirement. Use only Node built-ins (add no dependencies). Do not modify or delete the existing files in test/ (you may add new test files); `npm test` must pass.',
  setup: root => gitRepo(root, [['udiff: unified diff library and CLI', FILES]]),
  solve: root => writeTree(root, {'src/diff.js': REFERENCE, 'bin/udiff.js': REFERENCE_CLI}),
  verify(root, before) {
    let pkg = {};
    try { pkg = JSON.parse(read(root, 'package.json')); } catch {}
    const deps = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies'];
    const suite = npm(root, 'test');
    const results = {
      examples: hidden(root, exampleTests, 'examples.test.mjs'),
      minimal: hidden(root, minimalTests, 'minimal.test.mjs'),
      large: hidden(root, largeTests, 'large.test.mjs'),
      cli: hidden(root, cliTests, 'cli.test.mjs'),
    };
    return verdict({
      tests_unchanged: unchanged(before, root, 'test/', {allowAdded: true}),
      no_dependencies: deps.every(key => !pkg[key] || !Object.keys(pkg[key]).length),
      suite_passes: suite.status === 0,
      spec_examples_and_edge_cases: results.examples.pass,
      minimal_canonical_random: results.minimal.pass,
      large_input_fast_and_minimal: results.large.pass,
      cli_conforms: results.cli.pass,
    }, Object.fromEntries(Object.entries(results).filter(([, result]) => !result.pass).map(([name, result]) => [name, result.output])));
  },
  mustReject: [
    // 1. Greedy resynchronisation: valid patches, not minimal.
    withDiff(patched(REFERENCE, MYERS_CALL, MYERS_CALL.replace('myers', 'greedy')) + '\n' + greedy + '\n'),
    // 2. Off-by-one hunk merging (gap < 2C instead of <= 2C).
    withDiff(patched(REFERENCE, '<= 2 * context', '< 2 * context')),
    // 3. No "\ No newline" marker after inserted lines.
    withDiff(patched(REFERENCE, String.raw`line.endsWith('\n') ? ''`, String.raw`line.endsWith('\n') ? '' : ops[i].t === '+' ? '\n'`)),
    // 4. Minimal but O(N x M): too slow for the 50,000-line case.
    withDiff(patched(REFERENCE, MYERS_CALL, MYERS_CALL.replace('myers', 'hirschberg')) + '\n' + hirschberg + '\n'),
    // 5. Editing a visible test.
    root => writeTree(root, {'test/diff.test.js': patched(VISIBLE_TESTS, "'same\\n', 'same\\n'", "'same\\n', 'same\\n', {}")}),
    // 6. Splitting on \r?\n drops the \r content.
    withDiff(patched(REFERENCE, "text.split('\\n')", "text.split(/\\r?\\n/)")),
    // 7. Empty range written with start + 1.
    withDiff(patched(REFERENCE, '(count ? start + 1 : start)', '(start + 1)')),
    // 8. CLI appends a newline.
    root => writeTree(root, {'bin/udiff.js': patched(REFERENCE_CLI, 'process.stdout.write(diff);', 'console.log(diff);')}),
    // 9. CLI exits 0 even when the files differ.
    root => writeTree(root, {'bin/udiff.js': patched(REFERENCE_CLI, 'process.exitCode = diff ? 1 : 0;', '')}),
  ],
};
