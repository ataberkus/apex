import {gitRepo, hiddenTests, npm, read, unchanged, verdict, writeTree} from '../lib.mjs';

// Fixture sources are String.raw: what you see is what lands in the file (no backticks or ${ inside).
const SPEC = String.raw`# Three-way merge

src/merge.js exports one function:

    merge3(base, ours, theirs, options)  ->  {text, conflicts}

base is the original text; ours and theirs are two edited versions of it. merge3 combines both sets of edits into
one text. text is the merged text and conflicts the number of conflict blocks written into it (see 7). The result
object has exactly these two properties. This document is the complete specification; where the current code
disagrees with it, this document wins.

## 1. Arguments and validation

All validation happens before any merging, in the order below. The first problem found throws, with exactly the
message shown; <v> stands for String(value) of the offending value.

1. base, ours and theirs, in this order, must each be a string (typeof "string"). Otherwise
   TypeError "merge3: base must be a string" (with "ours" or "theirs" in place of "base").
2. options may be undefined. Otherwise it must be an object that is neither null nor an array, else
   TypeError "merge3: options must be an object".
3. The options are then checked in exactly this order. An option that is absent or undefined takes its default.
   Properties not listed here are ignored.
   - style: "merge" or "diff3". Default "merge". Otherwise RangeError "merge3: invalid style <v>".
   - markerSize: an integer (Number.isInteger) from 3 to 32 inclusive. Default 7. Otherwise
     RangeError "merge3: invalid markerSize <v>".
   - labels: an object that is neither null nor an array. Default: an empty object. Otherwise
     TypeError "merge3: labels must be an object". Its properties ours, base and theirs are checked in this order;
     each one that is present and not undefined must be a string that contains neither "\n" nor "\r", else
     RangeError "merge3: invalid label <name>", where <name> is the property name (ours, base or theirs), not its
     value. A missing or undefined label defaults to the property name: "ours", "base", "theirs".
   - coalesce: an integer >= 0. Default 0. Otherwise RangeError "merge3: invalid coalesce <v>".
   - favor: undefined (no favor), "ours", "theirs" or "union". Otherwise RangeError "merge3: invalid favor <v>".

Values are compared exactly: "DIFF3" is not a style, "7" is not a markerSize, null is not a favor.

## 2. Lines

Every text is treated as a list of lines. A line ends just after a "\n" character; if the text does not end with
"\n", the characters after the last "\n" form a final line without terminator. The empty string has no lines.
"a\n" has the single line "a\n"; "a\nb" has the lines "a\n" and "b". "\r" is an ordinary character, so a CRLF line
is "x\r\n".

A line always includes its terminator, and two lines are equal only when they are identical strings: "b" and "b\n"
are different lines, and so are "b\n" and "b\r\n". Two lists of lines are equal when they have the same length and
equal lines at every position.

## 3. Pairwise alignment

merge3 aligns base with ours, and separately base with theirs, using the procedure below. Call the base lines
B[0..n) and the lines of the other text S[0..m). An alignment is a set of matched pairs (i, j): base line i is
matched to side line j, and B[i] === S[j]. Every line is in at most one pair, and pairs never cross (if (i, j) and
(i', j') are pairs with i < i', then j < j').

The alignment is produced by align(0, n, 0, m), where align(b0, b1, s0, s1) works on the base lines B[b0..b1) and
the side lines S[s0..s1) (half-open ranges):

1. Common prefix. While both ranges are non-empty and B[b0] === S[s0]: match (b0, s0), then increase b0 and s0
   by one.
2. Common suffix. Then, while both ranges are non-empty and B[b1-1] === S[s1-1]: match (b1-1, s1-1), then decrease
   b1 and s1 by one.
3. Candidates. If either range is now empty, stop. Otherwise a candidate is a line that occurs exactly once in
   B[b0..b1) and exactly once in S[s0..s1). Only occurrences inside the two current ranges count; occurrences
   elsewhere in the texts do not matter. Each candidate gives the pair (i, j) of its two positions. If there is no
   candidate, stop: the lines left in the two ranges stay unmatched (no other matching is tried for them).
4. Anchors. List the candidate pairs in increasing order of i and choose a longest subsequence of them whose j
   values strictly increase. When several such subsequences have that greatest length, choose the one whose list
   of i values is lexicographically smallest: the smallest first i; among those, the smallest second i; and so on.
   Match every chosen pair; they are the anchors.
5. Recursion. Run align on every region around the anchors: for anchors (i1, j1), ..., (ik, jk) in order, on
   align(b0, i1, s0, j1), on align(i1+1, i2, j1+1, j2) for each two consecutive anchors, ..., and on
   align(ik+1, b1, jk+1, s1). Regions where a range is empty match nothing (step 3 stops at once).

Example: base "P\nQ\n" against side "Q\nP\n". There is no common prefix or suffix; both lines are candidates, with
pairs (0, 1) and (1, 0). The longest increasing subsequences have length 1; [(0, 1)] has the smaller i, so base
line "P\n" is matched to side line 1 and "Q\n" stays unmatched in both texts.

## 4. Chunks

MA is the alignment of base with ours and MB the alignment of base with theirs. A base line is stable when it is
matched in both: to ours line MA[i] and to theirs line MB[i].

The three texts are walked with positions i (base), j (ours) and k (theirs), all starting at 0, until all three
have reached the end of their text:

- Let i' be the smallest index >= i of a stable base line, with j' = MA[i'] and k' = MB[i']. If there is none,
  i', j', k' are the numbers of lines of base, ours and theirs.
- If i' = i, j' = j and k' = k, base line i is a stable line of the output (it equals ours line j and theirs line
  k). Increase i, j and k by one.
- Otherwise the ranges base[i..i'), ours[j..j'), theirs[k..k') form a chunk (one or two of the ranges may be
  empty). Continue with i = i', j = j', k = k'.

Each chunk is classified by comparing its three ranges as lists of lines, by the first rule that applies:

1. If the ours range equals the base range, the chunk resolves to the theirs range (only theirs changed it).
2. Else, if the theirs range equals the base range, it resolves to the ours range.
3. Else, if the ours range equals the theirs range, it resolves to the ours range (the same change on both sides).
4. Otherwise it is a conflict chunk.

## 5. Coalescing

Next, conflict chunks are coalesced, from left to right. A conflict chunk is coalesced with the next conflict chunk
when the number of lines between them is at most the coalesce option. The lines between two conflict chunks are the
stable lines and the lines of resolved chunks that lie between them, counted as they would be output (a resolved
chunk counts the lines it resolves to).

Coalescing replaces the two conflict chunks, and everything between them, with one conflict chunk whose base, ours
and theirs ranges each run from the start of the first chunk's range to the end of the second chunk's range in
that text. The result is again a conflict chunk and is coalesced with the next conflict chunk by the same rule,
counting the lines between it and that chunk.

Two chunks are always separated by at least one stable line, so with the default coalesce 0 nothing is coalesced.

## 6. Refinement

After coalescing, each conflict chunk is refined. Let o be its ours range and t its theirs range (lists of lines).

1. The longest common prefix of o and t (the lines equal at positions 0, 1, ... in both) is removed from both and
   output before the conflict, as ordinary lines.
2. Then the longest common suffix of what remains of o and t is removed from both and output after the conflict,
   as ordinary lines.

The base range is not refined. What remains of o and t is the conflict. One of them may be empty; if both are
empty, the chunk has no conflict left and contributes only the lines removed in steps 1 and 2.

## 7. Output

The output text is, in order: the stable lines, the lines that resolved chunks resolve to, and for every conflict
chunk its removed prefix lines, its conflict, and its removed suffix lines.

Without favor, each conflict is written as a conflict block:

    <<<<<<< ours-label
    the remaining ours lines
    ||||||| base-label
    all lines of the chunk's base range
    =======
    the remaining theirs lines
    >>>>>>> theirs-label

The two lines starting with "|" and the base lines between them are written only with style "diff3"; with style
"merge" the block goes straight from the ours lines to the "=" marker line. In "diff3" style the base section holds
the whole base range of the chunk (after coalescing), which may be empty; its marker line is written even then.

A marker line consists of L copies of its marker character ("<", "|", "=" or ">"), then, for the "<", "|" and ">"
lines only, a single space and the label when the label is not the empty string, and finally "\n". The "=" line
never has a label. With an empty label the marker line is just the L characters and "\n".

L, the marker length, is the same for every marker line of one result. Let R be the greatest number of identical
characters at the start of a line, taken over all lines of base, ours and theirs that start with one of the
characters "<", "|", "=", ">" (R is 0 if there is no such line). L is markerSize when R < markerSize; otherwise
L is R + 1.

With favor, no conflict blocks are written: each conflict is replaced by the remaining ours lines ("ours"), the
remaining theirs lines ("theirs"), or the remaining ours lines followed by the remaining theirs lines ("union").
Everything else, including coalescing and refinement, works exactly as without favor.

conflicts is the number of conflict blocks in text (0 when favor is given).

Line terminators: lines are written exactly as they are, with one exception: when a line without terminator is
followed in the output by anything else (another line or a marker line), a "\n" is written right after it.
Marker lines always end with "\n", also in a text whose lines end with "\r\n".

## 8. Size

Texts can have hundreds of thousands of lines, most of them unique. A merge of three texts of 200 000 lines each,
where ours has moved most of its lines around in blocks, must take no more than a few seconds. Work that grows
quadratically with the number of lines or with the number of candidates is far too slow.
`;

const NAIVE = String.raw`/** Three-way line merge; see docs/MERGE.md. Work in progress: LCS alignment and merge-style blocks only. */
const splitLines = text => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** match[i] = the line of b matched to line i of a by a longest common subsequence, or -1. */
function lcs(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({length: n + 1}, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const match = new Array(n).fill(-1);
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i] === b[j]) match[i++] = j++;
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return match;
}

const same = (x, y) => x.length === y.length && x.every((line, n) => line === y[n]);

export function merge3(base, ours, theirs, options = {}) {
  const B = splitLines(base), O = splitLines(ours), T = splitLines(theirs);
  const MA = lcs(B, O), MB = lcs(B, T);
  const labels = {ours: 'ours', theirs: 'theirs', ...options.labels};
  let text = '', conflicts = 0;
  for (let i = 0, j = 0, k = 0; i < B.length || j < O.length || k < T.length;) {
    let i2 = i;
    while (i2 < B.length && (MA[i2] < 0 || MB[i2] < 0)) i2++;
    const j2 = i2 < B.length ? MA[i2] : O.length, k2 = i2 < B.length ? MB[i2] : T.length;
    if (i2 === i && j2 === j && k2 === k) { text += B[i]; i++; j++; k++; continue; }
    const b = B.slice(i, i2), o = O.slice(j, j2), t = T.slice(k, k2);
    if (same(o, b)) text += t.join('');
    else if (same(t, b) || same(o, t)) text += o.join('');
    else {
      conflicts++;
      text += '<<<<<<< ' + labels.ours + '\n' + o.join('') + '=======\n' + t.join('') + '>>>>>>> ' + labels.theirs + '\n';
    }
    i = i2; j = j2; k = k2;
  }
  return {text, conflicts};
}
`;

const VISIBLE = String.raw`import test from 'node:test';
import assert from 'node:assert/strict';
import {merge3} from '../src/merge.js';

const base = 'alpha\nbeta\ngamma\ndelta\nepsilon\n';

test('edits in different places merge cleanly', () => {
  assert.deepEqual(merge3(base, 'alpha\nBETA\ngamma\ndelta\nepsilon\n', 'alpha\nbeta\ngamma\nDELTA\nepsilon\n'),
    {text: 'alpha\nBETA\ngamma\nDELTA\nepsilon\n', conflicts: 0});
});

test('the same edit on both sides is not a conflict', () => {
  assert.deepEqual(merge3(base, 'alpha\nbeta\nGAMMA\ndelta\nepsilon\n', 'alpha\nbeta\nGAMMA\ndelta\nepsilon\n'),
    {text: 'alpha\nbeta\nGAMMA\ndelta\nepsilon\n', conflicts: 0});
});

test('a deletion on one side and an insertion on the other', () => {
  assert.deepEqual(merge3(base, 'alpha\ngamma\ndelta\nepsilon\n', 'alpha\nbeta\ngamma\ndelta\nzeta\nepsilon\n'),
    {text: 'alpha\ngamma\ndelta\nzeta\nepsilon\n', conflicts: 0});
});

test('different edits of the same line conflict', () => {
  assert.deepEqual(merge3(base, 'alpha\nbeta\ngamma one\ndelta\nepsilon\n', 'alpha\nbeta\ngamma two\ndelta\nepsilon\n'),
    {text: 'alpha\nbeta\n<<<<<<< ours\ngamma one\n=======\ngamma two\n>>>>>>> theirs\ndelta\nepsilon\n', conflicts: 1});
});

test('labels', () => {
  const result = merge3('x\n', 'y\n', 'z\n', {labels: {ours: 'HEAD', theirs: 'topic'}});
  assert.deepEqual(result, {text: '<<<<<<< HEAD\ny\n=======\nz\n>>>>>>> topic\n', conflicts: 1});
});
`;

const files = {
  'package.json': JSON.stringify({name: 'merge3', version: '1.0.0', type: 'module', scripts: {test: 'node --test test/*.test.js'}}, null, 2) + '\n',
  'docs/MERGE.md': SPEC,
  'src/merge.js': NAIVE,
  'test/merge.test.js': VISIBLE,
};

const REFERENCE = String.raw`/** Three-way line merge; see docs/MERGE.md. */
const MARKS = '<|=>';

function splitLines(text) {
  const lines = [];
  let start = 0;
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', start)) { lines.push(text.slice(start, at + 1)); start = at + 1; }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

/** Indexes of the longest strictly increasing subsequence of js; among the longest, the lexicographically smallest by index. */
function chooseAnchors(js) {
  const n = js.length, lenFrom = new Array(n), tails = [];
  // tails[l]: the largest value that starts an increasing run of length l + 1 to the right; strictly decreasing in l.
  for (let k = n - 1; k >= 0; k--) {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] > js[k]) lo = mid + 1; else hi = mid; }
    lenFrom[k] = lo + 1;
    tails[lo] = js[k];
  }
  const chosen = [];
  for (let k = 0, need = tails.length, last = -1; k < n && need > 0; k++) {
    if (lenFrom[k] === need && js[k] > last) { chosen.push(k); need--; last = js[k]; }
  }
  return chosen;
}

/** match[i] = the side line matched to base line i, or -1. */
function align(B, S) {
  const match = new Array(B.length).fill(-1);
  const stack = [[0, B.length, 0, S.length]];
  while (stack.length) {
    let [b0, b1, s0, s1] = stack.pop();
    while (b0 < b1 && s0 < s1 && B[b0] === S[s0]) match[b0++] = s0++;
    while (b0 < b1 && s0 < s1 && B[b1 - 1] === S[s1 - 1]) match[--b1] = --s1;
    if (b0 === b1 || s0 === s1) continue;
    const seen = new Map(); // line -> [count in base range, count in side range, side position]
    for (let i = b0; i < b1; i++) { const e = seen.get(B[i]); if (e) e[0]++; else seen.set(B[i], [1, 0, -1]); }
    for (let j = s0; j < s1; j++) { const e = seen.get(S[j]); if (e) { e[1]++; e[2] = j; } }
    const is = [], js = [];
    for (let i = b0; i < b1; i++) { const e = seen.get(B[i]); if (e[0] === 1 && e[1] === 1) { is.push(i); js.push(e[2]); } }
    if (!is.length) continue;
    let pb = b0, ps = s0;
    for (const k of chooseAnchors(js)) {
      stack.push([pb, is[k], ps, js[k]]);
      match[is[k]] = js[k];
      pb = is[k] + 1; ps = js[k] + 1;
    }
    stack.push([pb, b1, ps, s1]);
  }
  return match;
}

const same = (x, y) => x.length === y.length && x.every((line, n) => line === y[n]);
const isPlainObject = v => typeof v === 'object' && v !== null && !Array.isArray(v);

function settings(options) {
  if (options === undefined) options = {};
  if (!isPlainObject(options)) throw new TypeError('merge3: options must be an object');
  const {style = 'merge', markerSize = 7, labels = {}, coalesce = 0, favor} = options;
  if (style !== 'merge' && style !== 'diff3') throw new RangeError('merge3: invalid style ' + String(style));
  if (!Number.isInteger(markerSize) || markerSize < 3 || markerSize > 32) throw new RangeError('merge3: invalid markerSize ' + String(markerSize));
  if (!isPlainObject(labels)) throw new TypeError('merge3: labels must be an object');
  const names = {ours: 'ours', base: 'base', theirs: 'theirs'};
  for (const name of ['ours', 'base', 'theirs']) {
    const label = labels[name];
    if (label === undefined) continue;
    if (typeof label !== 'string' || /[\r\n]/.test(label)) throw new RangeError('merge3: invalid label ' + name);
    names[name] = label;
  }
  if (!Number.isInteger(coalesce) || coalesce < 0) throw new RangeError('merge3: invalid coalesce ' + String(coalesce));
  if (favor !== undefined && favor !== 'ours' && favor !== 'theirs' && favor !== 'union') throw new RangeError('merge3: invalid favor ' + String(favor));
  return {style, markerSize, names, coalesce, favor};
}

export function merge3(base, ours, theirs, options) {
  for (const [name, value] of [['base', base], ['ours', ours], ['theirs', theirs]]) {
    if (typeof value !== 'string') throw new TypeError('merge3: ' + name + ' must be a string');
  }
  const {style, markerSize, names, coalesce, favor} = settings(options);
  const B = splitLines(base), O = splitLines(ours), T = splitLines(theirs);
  const MA = align(B, O), MB = align(B, T);

  // Segments: {lines} written as they are, or {conflict: [b0, b1, o0, o1, t0, t1]}.
  const segments = [];
  let lastConflict = null, between = 0;
  const emit = lines => { if (lines.length) { segments.push({lines}); between += lines.length; } };
  for (let i = 0, j = 0, k = 0; i < B.length || j < O.length || k < T.length;) {
    let i2 = i;
    while (i2 < B.length && (MA[i2] < 0 || MB[i2] < 0)) i2++;
    const j2 = i2 < B.length ? MA[i2] : O.length, k2 = i2 < B.length ? MB[i2] : T.length;
    if (i2 === i && j2 === j && k2 === k) { emit([B[i]]); i++; j++; k++; continue; }
    const b = B.slice(i, i2), o = O.slice(j, j2), t = T.slice(k, k2);
    if (same(o, b)) emit(t);
    else if (same(t, b) || same(o, t)) emit(o);
    else if (lastConflict && between <= coalesce) {
      // Coalesce: drop the lines in between and extend the previous conflict over them.
      while (segments[segments.length - 1] !== lastConflict) segments.pop();
      lastConflict.conflict = [lastConflict.conflict[0], i2, lastConflict.conflict[2], j2, lastConflict.conflict[4], k2];
      between = 0;
    } else {
      lastConflict = {conflict: [i, i2, j, j2, k, k2]};
      segments.push(lastConflict);
      between = 0;
    }
    i = i2; j = j2; k = k2;
  }

  let run = 0;
  for (const line of [...B, ...O, ...T]) {
    if (!MARKS.includes(line[0])) continue;
    let n = 1;
    while (line[n] === line[0]) n++;
    run = Math.max(run, n);
  }
  const size = run >= markerSize ? run + 1 : markerSize;
  const marker = (char, label) => char.repeat(size) + (label ? ' ' + label : '') + '\n';

  const pieces = [];
  let conflicts = 0;
  for (const segment of segments) {
    if (segment.lines) { pieces.push(...segment.lines); continue; }
    const [b0, b1, o0, o1, t0, t1] = segment.conflict;
    let o = O.slice(o0, o1), t = T.slice(t0, t1), p = 0, s = 0;
    while (p < o.length && p < t.length && o[p] === t[p]) p++;
    while (s < o.length - p && s < t.length - p && o[o.length - 1 - s] === t[t.length - 1 - s]) s++;
    pieces.push(...o.slice(0, p));
    const suffix = o.slice(o.length - s);
    o = o.slice(p, o.length - s); t = t.slice(p, t.length - s);
    if (o.length || t.length) {
      if (favor === 'ours') pieces.push(...o);
      else if (favor === 'theirs') pieces.push(...t);
      else if (favor === 'union') pieces.push(...o, ...t);
      else {
        conflicts++;
        pieces.push(marker('<', names.ours), ...o);
        if (style === 'diff3') pieces.push(marker('|', names.base), ...B.slice(b0, b1));
        pieces.push(marker('=', ''), ...t, marker('>', names.theirs));
      }
    }
    pieces.push(...suffix);
  }
  const last = pieces.length - 1;
  return {text: pieces.map((piece, n) => n < last && !piece.endsWith('\n') ? piece + '\n' : piece).join(''), conflicts};
}
`;

// Every expectation below was derived by hand from docs/MERGE.md.
const HIDDEN = String.raw`import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const {merge3} = await import('@ROOT@src/merge.js');

// [name, base, ours, theirs, options, text, conflicts]
const CASES = [
  ['equal lists of anchors: the lexicographically smallest base positions win', 'P\nQ\n', 'Q\nP\n', 'P\nQ\nR\n', undefined,
    'Q\nP\n<<<<<<< ours\n=======\nQ\nR\n>>>>>>> theirs\n', 1],
  ['no candidates: nothing is matched, there is no fallback', 'x\ny\nx\ny\n', 'y\nx\ny\nx\n', 'x\ny\nx\ny\nz\n', undefined,
    '<<<<<<< ours\ny\nx\ny\nx\n=======\nx\ny\nx\ny\nz\n>>>>>>> theirs\n', 1],
  ['candidates are counted inside the current ranges only', 'A\nk\nP\nB\nk\nC\n', 'X\nA\nQ\nk\nR\nB\nC\nW\n', 'A\nk\nP2\nB\nk\nC\n', undefined,
    'X\nA\nQ\nk\n<<<<<<< ours\nR\n=======\nP2\n>>>>>>> theirs\nB\nC\nW\n', 1],
  ['insertions at the same place conflict; diff3 shows an empty base', 'a\nb\n', 'a\nX\nb\n', 'a\nY\nb\n', {style: 'diff3'},
    'a\n<<<<<<< ours\nX\n||||||| base\n=======\nY\n>>>>>>> theirs\nb\n', 1],
  ['refinement moves common lines out; the diff3 base is not refined', 'h\nm1\nm2\nt\n', 'h\np\nx\nq\nt\n', 'h\np\ny\nq\nt\n', {style: 'diff3'},
    'h\np\n<<<<<<< ours\nx\n||||||| base\nm1\nm2\n=======\ny\n>>>>>>> theirs\nq\nt\n', 1],
  ['refinement can leave one side empty', 'h\nm\nt\n', 'h\np\nq\nt\n', 'h\np\nt\n', undefined,
    'h\np\n<<<<<<< ours\nq\n=======\n>>>>>>> theirs\nt\n', 1],
  ['the common suffix is taken from what the prefix left', 'h\nm\nt\n', 'h\nA\nt\n', 'h\nA\nA\nt\n', undefined,
    'h\nA\n<<<<<<< ours\n=======\nA\n>>>>>>> theirs\nt\n', 1],
  ['one line between conflicts, coalesce 0', 'a\nb\nc\nd\ne\n', 'a\nB1\nc\nD1\ne\n', 'a\nB2\nc\nD2\ne\n', undefined,
    'a\n<<<<<<< ours\nB1\n=======\nB2\n>>>>>>> theirs\nc\n<<<<<<< ours\nD1\n=======\nD2\n>>>>>>> theirs\ne\n', 2],
  ['one line between conflicts, coalesce 1, diff3', 'a\nb\nc\nd\ne\n', 'a\nB1\nc\nD1\ne\n', 'a\nB2\nc\nD2\ne\n', {style: 'diff3', coalesce: 1},
    'a\n<<<<<<< ours\nB1\nc\nD1\n||||||| base\nb\nc\nd\n=======\nB2\nc\nD2\n>>>>>>> theirs\ne\n', 1],
  ['coalescing chains', 'a\nb\nc\nd\ne\nf\ng\n', 'a\nB1\nc\nD1\ne\nF1\ng\n', 'a\nB2\nc\nD2\ne\nF2\ng\n', {coalesce: 1},
    'a\n<<<<<<< ours\nB1\nc\nD1\ne\nF1\n=======\nB2\nc\nD2\ne\nF2\n>>>>>>> theirs\ng\n', 1],
  ['resolved chunks count as their output lines: 4 lines apart, coalesce 3', 'a\nb\nc\nd\ne\nf\ng\n', 'a\nS\nB1\nc\nd\ne\nF1\ng\n', 'a\nS\nB2\nc\nD2a\nD2b\ne\nF2\ng\n', {coalesce: 3},
    'a\nS\n<<<<<<< ours\nB1\n=======\nB2\n>>>>>>> theirs\nc\nD2a\nD2b\ne\n<<<<<<< ours\nF1\n=======\nF2\n>>>>>>> theirs\ng\n', 2],
  ['4 lines apart, coalesce 4: coalesced, then refined', 'a\nb\nc\nd\ne\nf\ng\n', 'a\nS\nB1\nc\nd\ne\nF1\ng\n', 'a\nS\nB2\nc\nD2a\nD2b\ne\nF2\ng\n', {coalesce: 4},
    'a\nS\n<<<<<<< ours\nB1\nc\nd\ne\nF1\n=======\nB2\nc\nD2a\nD2b\ne\nF2\n>>>>>>> theirs\ng\n', 1],
  ['favor union after coalescing', 'a\nb\nc\nd\ne\nf\ng\n', 'a\nS\nB1\nc\nd\ne\nF1\ng\n', 'a\nS\nB2\nc\nD2a\nD2b\ne\nF2\ng\n', {coalesce: 4, favor: 'union'},
    'a\nS\nB1\nc\nd\ne\nF1\nB2\nc\nD2a\nD2b\ne\nF2\ng\n', 0],
  ['favor ours', 'a\nb\nc\nd\ne\nf\ng\n', 'a\nS\nB1\nc\nd\ne\nF1\ng\n', 'a\nS\nB2\nc\nD2a\nD2b\ne\nF2\ng\n', {favor: 'ours'},
    'a\nS\nB1\nc\nD2a\nD2b\ne\nF1\ng\n', 0],
  ['favor theirs', 'a\nb\nc\nd\ne\nf\ng\n', 'a\nS\nB1\nc\nd\ne\nF1\ng\n', 'a\nS\nB2\nc\nD2a\nD2b\ne\nF2\ng\n', {favor: 'theirs'},
    'a\nS\nB2\nc\nD2a\nD2b\ne\nF2\ng\n', 0],
  ['a last line without terminator in a conflict', 'a\nb', 'a\nc', 'a\nd', undefined,
    'a\n<<<<<<< ours\nc\n=======\nd\n>>>>>>> theirs\n', 1],
  ['"b" and "b\\n" are different lines', 'a\nb', 'a\nb\n', 'a\nb\nc\n', undefined,
    'a\nb\n<<<<<<< ours\n=======\nc\n>>>>>>> theirs\n', 1],
  ['union of two unterminated lines', 'a\nb\n', 'a\nx', 'a\ny', {favor: 'union'}, 'a\nx\ny', 0],
  ['unterminated base line in a diff3 block', 'a\nb', 'a\nc\n', 'a\nd\n', {style: 'diff3'},
    'a\n<<<<<<< ours\nc\n||||||| base\nb\n=======\nd\n>>>>>>> theirs\n', 1],
  ['an unterminated last line stays unterminated', 'a\nb', 'A\nb', 'a\nb', undefined, 'A\nb', 0],
  ['CRLF lines; marker lines end with LF', 'a\r\nb\r\nc\r\n', 'a\r\nB\r\nc\r\n', 'a\r\nb\nc\r\n', undefined,
    'a\r\n<<<<<<< ours\nB\r\n=======\nb\n>>>>>>> theirs\nc\r\n', 1],
  ['a marker-like line anywhere lengthens every marker', '=======\na\n', '=======\nb\n', '=======\nc\n', undefined,
    '=======\n<<<<<<<< ours\nb\n========\nc\n>>>>>>>> theirs\n', 1],
  ['the longest run counts, also in base-only lines', 'a\n|||||||||\nm\n<<<<<<<<\n', 'a\nO\n<<<<<<<<\n', 'a\nT\n<<<<<<<<\n', {style: 'diff3'},
    'a\n<<<<<<<<<< ours\nO\n|||||||||| base\n|||||||||\nm\n==========\nT\n>>>>>>>>>> theirs\n<<<<<<<<\n', 1],
  ['runs shorter than markerSize do not count', 'x\n<<<<<< six\n', 'y\n<<<<<< six\n', 'z\n<<<<<< six\n', undefined,
    '<<<<<<< ours\ny\n=======\nz\n>>>>>>> theirs\n<<<<<< six\n', 1],
  ['markerSize 3 and a run of 3', 'x\n>>> quoted\n', 'y\n>>> quoted\n', 'z\n>>> quoted\n', {markerSize: 3},
    '<<<< ours\ny\n====\nz\n>>>> theirs\n>>> quoted\n', 1],
  ['markerSize 12', 'x\n', 'y\n', 'z\n', {markerSize: 12},
    '<<<<<<<<<<<< ours\ny\n============\nz\n>>>>>>>>>>>> theirs\n', 1],
  ['labels; an empty label leaves the bare marker', 'x\n', 'y\n', 'z\n', {style: 'diff3', labels: {ours: 'HEAD', base: '', theirs: 'feature/x'}},
    '<<<<<<< HEAD\ny\n|||||||\nx\n=======\nz\n>>>>>>> feature/x\n', 1],
  ['undefined options and labels take defaults; unknown options are ignored', 'x\n', 'y\n', 'z\n',
    {style: undefined, labels: {ours: undefined}, favor: undefined, color: true},
    '<<<<<<< ours\ny\n=======\nz\n>>>>>>> theirs\n', 1],
  ['empty texts', '', '', '', undefined, '', 0],
  ['both add to an empty base', '', 'a\n', 'b\n', undefined, '<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs\n', 1],
  ['both add the same to an empty base', '', 'a\n', 'a\n', undefined, 'a\n', 0],
  ['one side deletes everything', 'a\nb\n', '', 'a\nb\n', undefined, '', 0],
  ['deletion against an edit conflicts', 'a\nb\nc\n', 'a\nc\n', 'a\nB\nc\n', undefined,
    'a\n<<<<<<< ours\n=======\nB\n>>>>>>> theirs\nc\n', 1],
];
for (const [name, base, ours, theirs, options, text, conflicts] of CASES) {
  test(name, () => assert.deepStrictEqual(merge3(base, ours, theirs, options), {text, conflicts}));
}

// [arguments, error class, message]
const ERRORS = [
  [[1, 'a', 'b'], TypeError, 'merge3: base must be a string'],
  [['a', null, 5], TypeError, 'merge3: ours must be a string'],
  [['a', 'b', undefined], TypeError, 'merge3: theirs must be a string'],
  [['a', 'b', ['c'], 'diff3'], TypeError, 'merge3: theirs must be a string'],
  [['a', 'b', 'c', 'diff3'], TypeError, 'merge3: options must be an object'],
  [['a', 'b', 'c', null], TypeError, 'merge3: options must be an object'],
  [['a', 'b', 'c', []], TypeError, 'merge3: options must be an object'],
  [['a', 'b', 'c', {style: 'DIFF3'}], RangeError, 'merge3: invalid style DIFF3'],
  [['a', 'b', 'c', {favor: 'x', coalesce: -1, labels: 5, markerSize: 1, style: 'zdiff3'}], RangeError, 'merge3: invalid style zdiff3'],
  [['a', 'b', 'c', {markerSize: 2}], RangeError, 'merge3: invalid markerSize 2'],
  [['a', 'b', 'c', {markerSize: 33}], RangeError, 'merge3: invalid markerSize 33'],
  [['a', 'b', 'c', {markerSize: 7.5}], RangeError, 'merge3: invalid markerSize 7.5'],
  [['a', 'b', 'c', {markerSize: '7', labels: 5}], RangeError, 'merge3: invalid markerSize 7'],
  [['a', 'b', 'c', {labels: 'mine', coalesce: -1}], TypeError, 'merge3: labels must be an object'],
  [['a', 'b', 'c', {labels: null}], TypeError, 'merge3: labels must be an object'],
  [['a', 'b', 'c', {labels: ['x']}], TypeError, 'merge3: labels must be an object'],
  [['a', 'b', 'c', {labels: {ours: 'a\nb'}}], RangeError, 'merge3: invalid label ours'],
  [['a', 'b', 'c', {labels: {theirs: 'x\r', base: 5, ours: 'ok'}}], RangeError, 'merge3: invalid label base'],
  [['a', 'b', 'c', {labels: {theirs: 'x\r'}, coalesce: -1}], RangeError, 'merge3: invalid label theirs'],
  [['a', 'b', 'c', {coalesce: -1}], RangeError, 'merge3: invalid coalesce -1'],
  [['a', 'b', 'c', {coalesce: 1.5, favor: 'mine'}], RangeError, 'merge3: invalid coalesce 1.5'],
  [['a', 'b', 'c', {favor: 'mine'}], RangeError, 'merge3: invalid favor mine'],
  [['a', 'b', 'c', {favor: null}], RangeError, 'merge3: invalid favor null'],
];
for (const [args, type, message] of ERRORS) {
  test('error: ' + message, () => assert.throws(() => merge3(...args), error => error.constructor === type && error.message === message));
}

test('performance: 200 000 lines, shuffled blocks', () => {
  let seed = 4242;
  const rnd = n => { seed = seed * 16807 % 2147483647; return Math.floor(seed / 2147483647 * n); };
  const N = 200000;
  const base = Array.from({length: N}, (_, i) => 'line ' + i + '\n');
  const blocks = [];
  for (let b = 40000; b < 160000; b += 100) blocks.push(base.slice(b, b + 100));
  for (let k = blocks.length - 1; k > 0; k--) { const r = rnd(k + 1); [blocks[k], blocks[r]] = [blocks[r], blocks[k]]; }
  const ours = [...base.slice(0, 40000), ...blocks.flat(), ...base.slice(160000)];
  for (let k = 0; k < 300; k++) ours[rnd(N)] = 'ours edit ' + k + '\n';
  const theirs = [];
  base.forEach((line, i) => { if (i % 1499 === 7) return; theirs.push(i % 977 === 3 ? 'theirs edit ' + i + '\n' : line); if (i % 2003 === 11) theirs.push('}\n'); });
  const start = performance.now();
  const result = merge3(base.join(''), ours.join(''), theirs.join(''), {style: 'diff3', coalesce: 2});
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 5000, 'took ' + Math.round(elapsed) + ' ms');
  assert.strictEqual(result.conflicts, 57);
  assert.strictEqual(createHash('sha256').update(result.text).digest('hex'), '6bfca1d525d13f9379d7f1d40459cb2e9757c483bb938486004b6bbfbc0ce521');
});
`;

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies'];

/** Replace exactly one occurrence, so a mustReject variant can never silently become a no-op. */
function patch(source, from, to) {
  if (source.split(from).length !== 2) throw Error('patch anchor not unique: ' + from);
  return source.replace(from, to);
}
const variant = (...pairs) => root => {
  let source = REFERENCE;
  for (let n = 0; n < pairs.length; n += 2) source = patch(source, pairs[n], pairs[n + 1]);
  writeTree(root, {'src/merge.js': source});
};

export default {
  id: 'patience-merge3',
  category: 'exact merge algorithm with a size budget',
  prompt: 'src/merge.js implements only part of the three-way merge specified in docs/MERGE.md. Make merge3 implement that specification completely and exactly. Use only Node built-ins and add no dependencies. Do not modify, delete or rename any existing file under test/ (you may add new test files); `npm test` must pass.',
  setup: root => gitRepo(root, [['Three-way merge: LCS alignment, merge-style conflict blocks', files]]),
  solve: root => writeTree(root, {'src/merge.js': REFERENCE}),
  verify(root, before) {
    const suite = npm(root, 'test');
    const hidden = hiddenTests(root, HIDDEN);
    let pkg = {};
    try { pkg = JSON.parse(read(root, 'package.json')); } catch {}
    return verdict({
      tests_unchanged: unchanged(before, root, 'test/', {allowAdded: true}),
      no_dependencies: DEPENDENCY_FIELDS.every(field => pkg[field] === undefined),
      suite_passes: suite.status === 0,
      hidden_cases: hidden.pass,
    }, {suite: (suite.stdout + suite.stderr).slice(-2000), hidden: hidden.output});
  },
  mustReject: [
    // Candidates counted over the whole texts instead of the current ranges.
    variant('for (let i = b0; i < b1; i++) { const e = seen.get(B[i]); if (e) e[0]++;', 'for (let i = 0; i < B.length; i++) { const e = seen.get(B[i]); if (e) e[0]++;',
      'for (let j = s0; j < s1; j++) { const e = seen.get(S[j]);', 'for (let j = 0; j < S.length; j++) { const e = seen.get(S[j]);',
      'if (e[0] === 1 && e[1] === 1)', 'if (e[0] === 1 && e[1] === 1 && e[2] >= s0 && e[2] < s1)'),
    // Textbook patience sorting: some longest increasing subsequence, not the lexicographically smallest one.
    variant('  const n = js.length, lenFrom = new Array(n), tails = [];',
      '  const tops = [], prev = [];\n  for (let k = 0; k < js.length; k++) {\n    let lo = 0, hi = tops.length;\n' +
      '    while (lo < hi) { const mid = (lo + hi) >> 1; if (js[tops[mid]] < js[k]) lo = mid + 1; else hi = mid; }\n' +
      '    prev[k] = lo ? tops[lo - 1] : -1; tops[lo] = k;\n  }\n  const out = [];\n' +
      '  for (let k = tops.length ? tops[tops.length - 1] : -1; k >= 0; k = prev[k]) out.unshift(k);\n  return out;\n' +
      '  const n = js.length, lenFrom = new Array(n), tails = [];'),
    // Off by one: coalescing only when fewer than coalesce lines lie between.
    variant('between <= coalesce', 'between < coalesce'),
    // Marker length from the two sides only, ignoring lines that exist only in base.
    variant('for (const line of [...B, ...O, ...T])', 'for (const line of [...O, ...T])'),
    // Unterminated lines written as they are, even when something follows them.
    variant("pieces.map((piece, n) => n < last && !piece.endsWith('\\n') ? piece + '\\n' : piece).join('')", "pieces.join('')"),
    // Common suffix measured on the whole sides, overlapping the common prefix.
    variant('while (s < o.length - p && s < t.length - p &&', 'while (s < o.length && s < t.length &&'),
    // Correct anchors, but found with a quadratic search.
    variant('    let lo = 0, hi = tails.length;\n    while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] > js[k]) lo = mid + 1; else hi = mid; }\n    lenFrom[k] = lo + 1;\n    tails[lo] = js[k];',
      '    lenFrom[k] = 1;\n    for (let m = k + 1; m < n; m++) if (js[m] > js[k] && lenFrom[m] + 1 > lenFrom[k]) lenFrom[k] = lenFrom[m] + 1;\n    tails[lenFrom[k] - 1] = js[k];'),
    // A visible test edited.
    root => writeTree(root, {'test/merge.test.js': VISIBLE.replace("test('labels'", "test.skip('labels'")}),
  ],
};
