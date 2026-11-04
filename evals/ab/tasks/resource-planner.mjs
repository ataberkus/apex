import {gitRepo, hiddenTests, npm, read, unchanged, verdict, writeTree} from '../lib.mjs';

// Fixture sources are String.raw: what you see is what lands in the file (no backticks or ${ inside).
const SPEC = String.raw`# Resource planner

src/planner.js exports one function:

    plan(resources, requests)  ->  {bookings, unscheduled}

It books requests (jobs of a fixed duration) on resources (machines, rooms, people) one at a time, in a fixed order,
each at the earliest time it can go. This document is the complete specification; where the current code disagrees
with it, this document wins. plan never modifies its arguments.

## 1. Time

Times are integer minutes counted from 0. A booking or block occupying the minutes from a up to b is the half-open
interval [a, b). Two intervals [a, b) and [c, d) overlap when a < d and c < b; intervals that only touch (b = c)
do not overlap. A week is 10080 minutes.

## 2. Input

"Integer" below means a number for which Number.isSafeInteger is true. Optional properties that are absent or
undefined take their default. Properties not listed are ignored.

A resource is an object:

- id: a non-empty string, unique among the resources.
- changeover: an integer >= 0, default 0 (see 4).
- blocks: an array of blocks, default []. A block is an object:
  - start: an integer >= 0.
  - length: an integer >= 1.
  - every: optional; an integer greater than length that divides 10080 exactly (10080 % every === 0).
  - count: optional, allowed only together with every; an integer >= 1.

  A block without every has one occurrence, [start, start + length). A block with every has the occurrences
  [start + n * every, start + n * every + length) for n = 0, 1, 2, ...: count occurrences when count is given,
  and an unending series otherwise. Occurrences of blocks may overlap each other.

A request is an object:

- id: a non-empty string, unique among the requests (resource and request ids are separate namespaces).
- duration: an integer >= 1.
- earliest: an integer >= 0, default 0.
- deadline: optional; an integer >= 1.
- priority: an integer, default 0. Larger numbers go first. Negative numbers are allowed.
- kind: a string, default "" (see 4).
- resources: a non-empty array of resource ids: the resources the request may use, in order of preference. Each
  id must name a resource and may appear only once.
- after: an array of request ids, default []: the request's prerequisites. Each id must name a request. An id may
  appear more than once; repeats count once. A request that is (directly or indirectly) its own prerequisite is a
  dependency cycle.

## 3. Validation

plan validates everything before it books anything. Each problem is a RangeError whose message is
"<path>: <problem>", where <path> locates the offending value in JavaScript notation with 0-based indexes
(for example "requests[3].resources[1]" or "resources[0].blocks[2].every"). The first problem found is thrown.
The order of the checks is:

1. resources is an array, else "resources: must be an array".
2. requests is an array, else "requests: must be an array".
3. Every resource, in array order. For each: first the resource itself, then id, changeover, blocks; then each
   block in array order, and for each block itself, start, length, every, count.
4. Every request, in array order. For each: the request itself, then id, duration, earliest, deadline, priority,
   kind, resources (the array, then its elements in order), and whether after is an array.
5. The elements of every after array: requests in array order, elements in array order.
6. Dependency cycles.

The problems and their exact texts (<v> stands for String(value) of the offending value):

    resources[i]                     must be an object            (null and arrays are not objects here)
    resources[i].id                  must be a non-empty string
    resources[i].id                  duplicate id <v>             (the same id as an earlier resource)
    resources[i].changeover          must be an integer >= 0
    resources[i].blocks              must be an array
    resources[i].blocks[j]           must be an object
    resources[i].blocks[j].start     must be an integer >= 0
    resources[i].blocks[j].length    must be an integer >= 1
    resources[i].blocks[j].every     must be a divisor of 10080 greater than length
    resources[i].blocks[j].count     requires every               (count given, every absent)
    resources[i].blocks[j].count     must be an integer >= 1
    requests[i]                      must be an object
    requests[i].id                   must be a non-empty string
    requests[i].id                   duplicate id <v>             (the same id as an earlier request)
    requests[i].duration             must be an integer >= 1
    requests[i].earliest             must be an integer >= 0
    requests[i].deadline             must be an integer >= 1
    requests[i].priority             must be an integer
    requests[i].kind                 must be a string
    requests[i].resources            must be a non-empty array
    requests[i].resources[j]         unknown resource <v>         (not the id of any resource)
    requests[i].resources[j]         duplicate resource <v>       (already listed earlier in the same array)
    requests[i].after                must be an array
    requests[i].after[j]             unknown request <v>          (not the id of any request)
    requests[i].after                dependency cycle

For a dependency cycle, i is the smallest index of a request that can never become ready (see 5): one that is on a
cycle or has a prerequisite, direct or indirect, on a cycle.

## 4. Allowed starts

A resource holds bookings, made one at a time in section 5. Two bookings on a resource are consecutive when no
other booking of that resource starts between their starts. Blocks are not bookings: they never take part in
consecutiveness or changeover.

Booking request r on resource x at start s, as the interval [s, s + duration), is allowed when all of these hold:

1. s >= the lower bound of r: the largest of r.earliest and the end of every prerequisite's booking.
2. The interval overlaps no occurrence of any block of x.
3. The interval overlaps no booking already on x.
4. Changeover: after the new booking is added, no two consecutive bookings on x have different kinds and a gap
   smaller than x.changeover between them. The gap between consecutive bookings is the start of the later one minus
   the end of the earlier one; bookings of the same kind need no gap.

The earliest start of r on x is the smallest allowed s. There may be none at all, for example when the gaps between
the occurrences of an unending block are all shorter than the duration.

## 5. Order and booking

A request is ready when every prerequisite has been processed. Requests are processed one at a time. Each step
takes, among the ready requests that are not processed yet, the one with the highest priority; ties go to the
smaller earliest, then to the smaller deadline (a request without deadline comes after every request with one), and
then to the smaller index in the requests array. Processing request r:

1. If some prerequisite of r was not booked, r is unscheduled with reason "dependency".
2. Otherwise its earliest start is determined on each of its resources. If no resource has one, r is unscheduled
   with reason "no-slot".
3. Otherwise the resource with the smallest earliest start is chosen; when several share it, the one listed first
   in r.resources. If r has a deadline and that start + duration > deadline, r is unscheduled with reason
   "deadline" and nothing is booked.
4. Otherwise r is booked there: its booking [start, start + duration) is added to the resource. Bookings are
   final; later requests never move them.

A booking made later can lie before earlier bookings in time (a request whose lower bound is small can use an
earlier gap).

## 6. Output

- bookings: one object {id, resource, start, end} per booked request (exactly these properties: the request id,
  the resource id, and the interval), sorted by start ascending; bookings with the same start are ordered by the
  position of their resource in the resources array.
- unscheduled: one object {id, reason} per request that was not booked (exactly these properties), in the order of
  the requests array.

## 7. Size

Inputs can have 100 000 requests on a few dozen resources, with times up to 10^12 and blocks that repeat without
end. Such a plan must finish within 3 seconds on an ordinary machine. Work that grows quadratically with the number
of requests, or with the length of the time span or the number of block occurrences in it, is far too slow.
`;

const NAIVE = String.raw`/** Resource planner; see docs/PLANNER.md. Work in progress: priorities, one-off blocks and deadlines only. */
export function plan(resources, requests) {
  const busy = new Map(resources.map(x => [x.id, (x.blocks ?? []).map(b => [b.start, b.start + b.length])]));
  const order = requests.map((r, index) => ({r, index}))
    .sort((a, b) => (b.r.priority ?? 0) - (a.r.priority ?? 0) || a.index - b.index);
  const bookings = [], late = new Set();
  for (const {r} of order) {
    let best = null;
    for (const id of r.resources) {
      let start = r.earliest ?? 0;
      for (let moved = true; moved;) {
        moved = false;
        for (const [from, to] of busy.get(id)) if (from < start + r.duration && start < to) { start = to; moved = true; }
      }
      if (!best || start < best.start) best = {id: r.id, resource: id, start, end: start + r.duration};
    }
    if (r.deadline !== undefined && best.end > r.deadline) { late.add(r.id); continue; }
    busy.get(best.resource).push([best.start, best.end]);
    bookings.push(best);
  }
  bookings.sort((a, b) => a.start - b.start);
  return {bookings, unscheduled: requests.filter(r => late.has(r.id)).map(r => ({id: r.id, reason: 'deadline'}))};
}
`;

const VISIBLE = String.raw`import test from 'node:test';
import assert from 'node:assert/strict';
import {plan} from '../src/planner.js';

test('higher priority books first', () => {
  const result = plan([{id: 'press'}], [
    {id: 'a', duration: 30, resources: ['press']},
    {id: 'b', duration: 20, priority: 2, resources: ['press']},
    {id: 'c', duration: 10, priority: 1, resources: ['press']},
  ]);
  assert.deepEqual(result, {bookings: [
    {id: 'b', resource: 'press', start: 0, end: 20},
    {id: 'c', resource: 'press', start: 20, end: 30},
    {id: 'a', resource: 'press', start: 30, end: 60},
  ], unscheduled: []});
});

test('the resource with the earliest start wins', () => {
  const result = plan([{id: 'x'}, {id: 'y'}], [
    {id: 'first', duration: 50, priority: 1, resources: ['x']},
    {id: 'second', duration: 10, earliest: 5, resources: ['x', 'y']},
  ]);
  assert.deepEqual(result.bookings, [
    {id: 'first', resource: 'x', start: 0, end: 50},
    {id: 'second', resource: 'y', start: 5, end: 15},
  ]);
});

test('a one-off block pushes a booking back', () => {
  const result = plan([{id: 'room', blocks: [{start: 60, length: 30}]}], [
    {id: 'talk', duration: 45, earliest: 30, resources: ['room']},
  ]);
  assert.deepEqual(result.bookings, [{id: 'talk', resource: 'room', start: 90, end: 135}]);
});

test('a booking that would end after its deadline is unscheduled', () => {
  const result = plan([{id: 'room'}], [
    {id: 'long', duration: 100, priority: 1, resources: ['room']},
    {id: 'short', duration: 10, deadline: 105, resources: ['room']},
  ]);
  assert.deepEqual(result, {bookings: [{id: 'long', resource: 'room', start: 0, end: 100}], unscheduled: [{id: 'short', reason: 'deadline'}]});
});

test('nothing to plan', () => {
  assert.deepEqual(plan([], []), {bookings: [], unscheduled: []});
});
`;

const files = {
  'package.json': JSON.stringify({name: 'resource-planner', version: '1.0.0', type: 'module', scripts: {test: 'node --test test/*.test.js'}}, null, 2) + '\n',
  'docs/PLANNER.md': SPEC,
  'src/planner.js': NAIVE,
  'test/planner.test.js': VISIBLE,
};

const REFERENCE = String.raw`/** Resource planner; see docs/PLANNER.md. */
const WEEK = 10080;

const isObject = v => typeof v === 'object' && v !== null && !Array.isArray(v);
const fail = (path, problem) => { throw new RangeError(path + ': ' + problem); };
const int = (v, min) => Number.isSafeInteger(v) && (min === undefined || v >= min);
const or = (v, fallback) => v === undefined ? fallback : v;

function checkResource(x, i, ids) {
  const at = 'resources[' + i + ']';
  if (!isObject(x)) fail(at, 'must be an object');
  if (typeof x.id !== 'string' || x.id === '') fail(at + '.id', 'must be a non-empty string');
  if (ids.has(x.id)) fail(at + '.id', 'duplicate id ' + x.id);
  ids.set(x.id, i);
  const changeover = or(x.changeover, 0);
  if (!int(changeover, 0)) fail(at + '.changeover', 'must be an integer >= 0');
  const list = or(x.blocks, []);
  if (!Array.isArray(list)) fail(at + '.blocks', 'must be an array');
  const blocks = list.map((b, j) => {
    const bat = at + '.blocks[' + j + ']';
    if (!isObject(b)) fail(bat, 'must be an object');
    if (!int(b.start, 0)) fail(bat + '.start', 'must be an integer >= 0');
    if (!int(b.length, 1)) fail(bat + '.length', 'must be an integer >= 1');
    if (b.every !== undefined && !(int(b.every, b.length + 1) && WEEK % b.every === 0)) fail(bat + '.every', 'must be a divisor of 10080 greater than length');
    if (b.count !== undefined) {
      if (b.every === undefined) fail(bat + '.count', 'requires every');
      if (!int(b.count, 1)) fail(bat + '.count', 'must be an integer >= 1');
    }
    const every = b.every ?? WEEK, count = b.every === undefined ? 1 : b.count ?? Infinity;
    return {start: b.start, length: b.length, every, count};
  });
  const unending = blocks.filter(b => b.count === Infinity).sort((p, q) => p.start - q.start);
  const cutoffs = unending.map((b, k) => ({start: b.start, gap: longestGap(unending.slice(0, k + 1))}));
  return {id: x.id, changeover, blocks, cutoffs, bookings: []};
}

function checkRequest(r, i, ids, resourceIds) {
  const at = 'requests[' + i + ']';
  if (!isObject(r)) fail(at, 'must be an object');
  if (typeof r.id !== 'string' || r.id === '') fail(at + '.id', 'must be a non-empty string');
  if (ids.has(r.id)) fail(at + '.id', 'duplicate id ' + r.id);
  ids.set(r.id, i);
  if (!int(r.duration, 1)) fail(at + '.duration', 'must be an integer >= 1');
  const earliest = or(r.earliest, 0);
  if (!int(earliest, 0)) fail(at + '.earliest', 'must be an integer >= 0');
  if (r.deadline !== undefined && !int(r.deadline, 1)) fail(at + '.deadline', 'must be an integer >= 1');
  const priority = or(r.priority, 0);
  if (!int(priority)) fail(at + '.priority', 'must be an integer');
  const kind = or(r.kind, '');
  if (typeof kind !== 'string') fail(at + '.kind', 'must be a string');
  if (!Array.isArray(r.resources) || r.resources.length === 0) fail(at + '.resources', 'must be a non-empty array');
  const seen = new Set();
  const allowed = r.resources.map((id, j) => {
    if (!resourceIds.has(id)) fail(at + '.resources[' + j + ']', 'unknown resource ' + String(id));
    if (seen.has(id)) fail(at + '.resources[' + j + ']', 'duplicate resource ' + id);
    seen.add(id);
    return resourceIds.get(id);
  });
  const after = or(r.after, []);
  if (!Array.isArray(after)) fail(at + '.after', 'must be an array');
  return {index: i, id: r.id, duration: r.duration, earliest, deadline: or(r.deadline, Infinity), priority, kind, allowed, after};
}

/** Binary heap of ready requests: highest priority, then smallest earliest, deadline, input index. */
const before = (a, b) => a.priority !== b.priority ? a.priority > b.priority : a.earliest !== b.earliest ? a.earliest < b.earliest
  : a.deadline !== b.deadline ? a.deadline < b.deadline : a.index < b.index;
function push(heap, item) {
  heap.push(item);
  for (let n = heap.length - 1; n > 0;) {
    const up = (n - 1) >> 1;
    if (!before(heap[n], heap[up])) break;
    [heap[n], heap[up]] = [heap[up], heap[n]]; n = up;
  }
}
function pop(heap) {
  const top = heap[0], last = heap.pop();
  if (heap.length) {
    heap[0] = last;
    for (let n = 0; ;) {
      const l = 2 * n + 1, r = l + 1;
      let best = n;
      if (l < heap.length && before(heap[l], heap[best])) best = l;
      if (r < heap.length && before(heap[r], heap[best])) best = r;
      if (best === n) break;
      [heap[n], heap[best]] = [heap[best], heap[n]]; n = best;
    }
  }
  return top;
}

/** Index of the last booking starting at or before s, or -1. */
function lastAtOrBefore(bookings, s) {
  let lo = 0, hi = bookings.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (bookings[mid].start <= s) lo = mid + 1; else hi = mid; }
  return lo - 1;
}

/** The longest free stretch in the weekly pattern of these unending blocks; their periods divide a week. */
function longestGap(blocks) {
  const busy = [];
  for (const b of blocks) {
    for (let from = b.start % b.every; from < WEEK; from += b.every) {
      if (from + b.length <= WEEK) busy.push([from, from + b.length]);
      else busy.push([from, WEEK], [0, from + b.length - WEEK]);
    }
  }
  busy.sort((p, q) => p[0] - q[0]);
  let longest = 0, reach = busy[0][1];
  for (const [from, to] of busy) { longest = Math.max(longest, from - reach); reach = Math.max(reach, to); }
  return Math.max(longest, busy[0][0] + WEEK - reach);
}

/** Earliest allowed start of a request on a resource at or after lower, or -1 when there is none. */
function earliestStart(x, duration, kind, lower) {
  const {bookings, blocks, changeover} = x;
  const gap = b => b.kind === kind ? 0 : changeover;
  // Once the unending blocks started so far leave no weekly gap long enough, no start is ever allowed again.
  const dead = x.cutoffs.find(cutoff => cutoff.gap < duration)?.start ?? Infinity;
  for (let s = lower; ;) {
    if (s >= dead) return -1;
    const p = lastAtOrBefore(bookings, s);
    if (p >= 0 && s < bookings[p].end + gap(bookings[p])) { s = bookings[p].end + gap(bookings[p]); continue; }
    const next = bookings[p + 1];
    if (next && s + duration + gap(next) > next.start) { s = next.end + gap(next); continue; }
    let moved = s;
    for (const b of blocks) {
      const n = Math.max(0, Math.floor((s - b.start - b.length) / b.every) + 1);
      if (n >= b.count) continue;
      const from = b.start + n * b.every;
      if (from < s + duration) moved = Math.max(moved, from + b.length);
    }
    if (moved === s) return s;
    s = moved;
  }
}

export function plan(resources, requests) {
  if (!Array.isArray(resources)) fail('resources', 'must be an array');
  if (!Array.isArray(requests)) fail('requests', 'must be an array');
  const resourceIds = new Map();
  const xs = resources.map((x, i) => checkResource(x, i, resourceIds));
  const requestIds = new Map();
  const rs = requests.map((r, i) => checkRequest(r, i, requestIds, resourceIds));
  const waiting = rs.map(() => 0), dependents = rs.map(() => []);
  for (const r of rs) {
    const prerequisites = new Set();
    r.after.forEach((id, j) => {
      if (!requestIds.has(id)) fail('requests[' + r.index + '].after[' + j + ']', 'unknown request ' + String(id));
      prerequisites.add(requestIds.get(id));
    });
    r.after = [...prerequisites];
    for (const p of r.after) dependents[p].push(r.index);
    waiting[r.index] = r.after.length;
  }
  // Kahn's order decides readiness; a request that never becomes ready is on or behind a cycle.
  const left = [...waiting], queue = rs.filter(r => left[r.index] === 0).map(r => r.index);
  for (let q = 0; q < queue.length; q++) for (const d of dependents[queue[q]]) if (--left[d] === 0) queue.push(d);
  if (queue.length < rs.length) fail('requests[' + left.findIndex(n => n > 0) + '].after', 'dependency cycle');

  const end = new Array(rs.length), reason = new Array(rs.length);
  const heap = [];
  for (const r of rs) if (waiting[r.index] === 0) push(heap, r);
  while (heap.length) {
    const r = pop(heap);
    if (r.after.some(p => reason[p])) reason[r.index] = 'dependency';
    else {
      const lower = r.after.reduce((t, p) => Math.max(t, end[p]), r.earliest);
      let best = -1, at = -1;
      for (const x of r.allowed) {
        const s = earliestStart(xs[x], r.duration, r.kind, lower);
        if (s >= 0 && (best < 0 || s < at)) { best = x; at = s; }
      }
      if (best < 0) reason[r.index] = 'no-slot';
      else if (at + r.duration > r.deadline) reason[r.index] = 'deadline';
      else {
        const booking = {id: r.id, resource: best, start: at, end: at + r.duration, kind: r.kind};
        const list = xs[best].bookings;
        list.splice(lastAtOrBefore(list, at) + 1, 0, booking);
        end[r.index] = booking.end;
      }
    }
    for (const d of dependents[r.index]) if (--waiting[d] === 0) push(heap, rs[d]);
  }
  const bookings = xs.flatMap(x => x.bookings).sort((a, b) => a.start - b.start || a.resource - b.resource)
    .map(b => ({id: b.id, resource: xs[b.resource].id, start: b.start, end: b.end}));
  return {bookings, unscheduled: rs.filter(r => reason[r.index]).map(r => ({id: r.id, reason: reason[r.index]}))};
}
`;

// Every hand-written expectation below was derived from docs/PLANNER.md.
const HIDDEN = String.raw`import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const {plan} = await import('@ROOT@src/planner.js');

const B = (id, resource, start, end) => ({id, resource, start, end});
const U = (id, reason) => ({id, reason});

// [name, resources, requests, bookings, unscheduled]
const CASES = [
  ['priority, then deadline, then preference among equal starts; ties in the output by resource order',
    [{id: 'A'}, {id: 'B'}],
    [{id: 'low', duration: 30, resources: ['A', 'B']},
      {id: 'high', duration: 60, priority: 5, resources: ['A', 'B']},
      {id: 'mid', duration: 10, priority: 5, deadline: 100, resources: ['B', 'A']}],
    [B('high', 'A', 0, 60), B('mid', 'B', 0, 10), B('low', 'B', 10, 40)], []],
  ['ready order: earliest, then deadline, then index',
    [{id: 'A'}],
    [{id: 'x', duration: 10, earliest: 5, resources: ['A']},
      {id: 'y', duration: 10, earliest: 6, deadline: 50, resources: ['A']},
      {id: 'z', duration: 10, earliest: 5, deadline: 40, resources: ['A']},
      {id: 'u', duration: 10, earliest: 5, deadline: 40, resources: ['A']}],
    [B('z', 'A', 5, 15), B('u', 'A', 15, 25), B('x', 'A', 25, 35), B('y', 'A', 35, 45)], []],
  ['later bookings can use earlier gaps',
    [{id: 'A'}],
    [{id: 'r1', duration: 50, earliest: 100, resources: ['A']},
      {id: 'r2', duration: 30, priority: -1, resources: ['A']},
      {id: 'r3', duration: 80, earliest: 40, priority: -2, resources: ['A']}],
    [B('r2', 'A', 0, 30), B('r1', 'A', 100, 150), B('r3', 'A', 150, 230)], []],
  ['changeover on both sides of a new booking',
    [{id: 'M', changeover: 20}],
    [{id: 'a', kind: 'red', duration: 30, earliest: 100, priority: 9, resources: ['M']},
      {id: 'b', kind: 'blue', duration: 30, priority: 8, resources: ['M']},
      {id: 'c', kind: 'blue', duration: 30, earliest: 40, priority: 7, resources: ['M']},
      {id: 'd', kind: 'red', duration: 10, earliest: 70, priority: 6, resources: ['M']},
      {id: 'e', kind: 'green', duration: 5, priority: 5, resources: ['M']},
      {id: 'f', duration: 5, earliest: 131, priority: 4, resources: ['M']},
      {id: 'g', kind: 'green', duration: 5, priority: 3, resources: ['M']}],
    [B('b', 'M', 0, 30), B('c', 'M', 40, 70), B('d', 'M', 90, 100), B('a', 'M', 100, 130), B('e', 'M', 150, 155),
      B('f', 'M', 175, 180), B('g', 'M', 200, 205)], []],
  ['daily, counted and one-off blocks; no-slot, deadline and dependency',
    [{id: 'W', blocks: [{start: 0, length: 480, every: 1440}, {start: 720, length: 60, every: 1440, count: 2}, {start: 3000, length: 100}]}],
    [{id: 'p1', duration: 300, priority: 10, resources: ['W']},
      {id: 'p2', duration: 240, priority: 9, resources: ['W']},
      {id: 'p3', duration: 600, earliest: 1000, priority: 8, resources: ['W']},
      {id: 'p4', duration: 120, earliest: 2830, priority: 7, resources: ['W']},
      {id: 'p5', duration: 1000, priority: 6, resources: ['W']},
      {id: 'p6', duration: 960, priority: 5, deadline: 5000, resources: ['W']},
      {id: 'p7', duration: 960, priority: 4, after: ['p6'], resources: ['W']},
      {id: 'p8', duration: 900, priority: 3, after: ['p4'], resources: ['W']}],
    [B('p2', 'W', 480, 720), B('p1', 'W', 780, 1080), B('p3', 'W', 2220, 2820), B('p4', 'W', 3360, 3480), B('p8', 'W', 4800, 5700)],
    [U('p5', 'no-slot'), U('p6', 'deadline'), U('p7', 'dependency')]],
  ['a weekly block leaves one 80-minute gap per week',
    [{id: 'K', blocks: [{start: 0, length: 10000, every: 10080}]}],
    [{id: 'w1', duration: 80, earliest: 100, priority: 3, resources: ['K']},
      {id: 'w2', duration: 81, priority: 2, resources: ['K']},
      {id: 'w3', duration: 40, earliest: 10001, priority: 1, resources: ['K']}],
    [B('w1', 'K', 10000, 10080), B('w3', 'K', 20080, 20120)], [U('w2', 'no-slot')]],
  ['two unending blocks together; the second starts in the third week',
    [{id: 'J', blocks: [{start: 0, length: 2000, every: 5040}, {start: 22660, length: 7000, every: 10080}]}],
    [{id: 'j1', duration: 580, priority: 7, resources: ['J']},
      {id: 'j2', duration: 581, earliest: 22000, priority: 6, resources: ['J']},
      {id: 'j3', duration: 3000, priority: 9, resources: ['J']},
      {id: 'j4', duration: 3000, earliest: 20000, priority: 8, resources: ['J']},
      {id: 'j5', duration: 580, earliest: 22000, priority: 5, resources: ['J']}],
    [B('j3', 'J', 2000, 5000), B('j1', 'J', 7040, 7620), B('j5', 'J', 29660, 30240)], [U('j2', 'no-slot'), U('j4', 'no-slot')]],
  ['a counted weekly block stops after count occurrences',
    [{id: 'C', blocks: [{start: 0, length: 9000, every: 10080, count: 3}]}],
    [{id: 'c1', duration: 5000, resources: ['C']}, {id: 'c2', duration: 1000, priority: -1, resources: ['C']}],
    [B('c2', 'C', 9000, 10000), B('c1', 'C', 29160, 34160)], []],
  ['choosing among resources; a resource without any slot; deadlines after the choice',
    [{id: 'slow'}, {id: 'fast'}, {id: 'never', blocks: [{start: 0, length: 1439, every: 1440}]}],
    [{id: 's1', duration: 100, priority: 9, resources: ['slow']},
      {id: 's2', duration: 50, priority: 8, resources: ['never', 'slow', 'fast']},
      {id: 's3', duration: 50, earliest: 100, priority: 7, resources: ['fast', 'slow']},
      {id: 's4', duration: 50, earliest: 100, priority: 6, resources: ['slow', 'fast']},
      {id: 's5', duration: 1, priority: 5, resources: ['never']},
      {id: 's6', duration: 2, priority: 4, resources: ['never']},
      {id: 's7', duration: 60, earliest: 120, deadline: 179, priority: 3, resources: ['slow', 'fast']},
      {id: 's8', duration: 60, earliest: 120, deadline: 210, priority: 2, resources: ['slow', 'fast']}],
    [B('s1', 'slow', 0, 100), B('s2', 'fast', 0, 50), B('s4', 'slow', 100, 150), B('s3', 'fast', 100, 150), B('s8', 'slow', 150, 210),
      B('s5', 'never', 1439, 1440)],
    [U('s6', 'no-slot'), U('s7', 'deadline')]],
  ['prerequisites first; failures cascade; request and resource ids are separate',
    [{id: 'A'}, {id: 'B'}],
    [{id: 'build', duration: 30, earliest: 10, priority: -5, resources: ['A']},
      {id: 'test', duration: 20, priority: 10, after: ['build', 'build'], resources: ['B']},
      {id: 'imp', duration: 5000, deadline: 100, resources: ['A']},
      {id: 'after-imp', duration: 1, priority: 50, after: ['imp'], resources: ['B']},
      {id: 'chain', duration: 1, after: ['after-imp'], resources: ['A']},
      {id: 'free', duration: 10, priority: -10, resources: ['A']},
      {id: 'B', duration: 5, priority: -20, resources: ['B']}],
    [B('free', 'A', 0, 10), B('B', 'B', 0, 5), B('build', 'A', 10, 40), B('test', 'B', 40, 60)],
    [U('imp', 'deadline'), U('after-imp', 'dependency'), U('chain', 'dependency')]],
  ['times near 10^12 with a daily block',
    [{id: 'D', blocks: [{start: 0, length: 60, every: 1440}]}],
    [{id: 'far', duration: 30, earliest: 999999999390, resources: ['D']}],
    [B('far', 'D', 999999999420, 999999999450)], []],
  ['undefined optional properties take their defaults; unknown properties are ignored',
    [{id: 'A', changeover: undefined, blocks: undefined, colour: 'red'}],
    [{id: 'q', duration: 5, earliest: undefined, deadline: undefined, priority: undefined, kind: undefined, after: undefined, note: 1, resources: ['A']}],
    [B('q', 'A', 0, 5)], []],
];
for (const [name, resources, requests, bookings, unscheduled] of CASES) {
  test(name, () => {
    const copy = structuredClone([resources, requests]);
    assert.deepStrictEqual(plan(resources, requests), {bookings, unscheduled});
    assert.deepStrictEqual([resources, requests], copy, 'plan modified its arguments');
  });
}

const R = (id, more) => ({id, duration: 1, resources: ['A'], ...more});
const OK = [{id: 'A'}];
// [resources, requests, message]
const ERRORS = [
  [{}, [], 'resources: must be an array'],
  [[], null, 'requests: must be an array'],
  [[null], 5, 'requests: must be an array'],
  [[null], [], 'resources[0]: must be an object'],
  [[{id: 'A'}, []], [], 'resources[1]: must be an object'],
  [[{id: ''}], [], 'resources[0].id: must be a non-empty string'],
  [[{id: 7}], [], 'resources[0].id: must be a non-empty string'],
  [[{id: 'A'}, {id: 'A', changeover: -1}], [], 'resources[1].id: duplicate id A'],
  [[{id: 'A', changeover: 1.5}], [], 'resources[0].changeover: must be an integer >= 0'],
  [[{id: 'A', changeover: '5'}], [], 'resources[0].changeover: must be an integer >= 0'],
  [[{id: 'A', changeover: null}], [], 'resources[0].changeover: must be an integer >= 0'],
  [[{id: 'A', blocks: {}}], [], 'resources[0].blocks: must be an array'],
  [[{id: 'A', blocks: [{start: 0, length: 1}, null]}], [], 'resources[0].blocks[1]: must be an object'],
  [[{id: 'A', blocks: [{start: -1, length: 0}]}], [], 'resources[0].blocks[0].start: must be an integer >= 0'],
  [[{id: 'A', blocks: [{start: 2 ** 53, length: 1}]}], [], 'resources[0].blocks[0].start: must be an integer >= 0'],
  [[{id: 'A', blocks: [{start: 0, length: 0, every: 7}]}], [], 'resources[0].blocks[0].length: must be an integer >= 1'],
  [[{id: 'A', blocks: [{start: 0, length: 60, every: 60}]}], [], 'resources[0].blocks[0].every: must be a divisor of 10080 greater than length'],
  [[{id: 'A', blocks: [{start: 0, length: 60, every: 1000}]}], [], 'resources[0].blocks[0].every: must be a divisor of 10080 greater than length'],
  [[{id: 'A', blocks: [{start: 0, length: 60, every: 20160}]}], [], 'resources[0].blocks[0].every: must be a divisor of 10080 greater than length'],
  [[{id: 'A', blocks: [{start: 0, length: 5, count: 2}]}], [], 'resources[0].blocks[0].count: requires every'],
  [[{id: 'A', blocks: [{start: 0, length: 5, every: 10, count: 0}]}], [], 'resources[0].blocks[0].count: must be an integer >= 1'],
  [[{id: 'A', blocks: [{start: 0, length: 5, every: 10, count: null}]}], [], 'resources[0].blocks[0].count: must be an integer >= 1'],
  [[{id: 'A', blocks: [{start: 0, length: 0}]}], [null], 'resources[0].blocks[0].length: must be an integer >= 1'],
  [OK, [null], 'requests[0]: must be an object'],
  [OK, [R('a'), R(5)], 'requests[1].id: must be a non-empty string'],
  [OK, [R('x'), R('x', {duration: 0})], 'requests[1].id: duplicate id x'],
  [OK, [R('A')], null],
  [OK, [R('a', {duration: 0, earliest: -1})], 'requests[0].duration: must be an integer >= 1'],
  [OK, [R('a', {duration: '3'})], 'requests[0].duration: must be an integer >= 1'],
  [OK, [R('a', {earliest: -1})], 'requests[0].earliest: must be an integer >= 0'],
  [OK, [R('a', {deadline: 0})], 'requests[0].deadline: must be an integer >= 1'],
  [OK, [R('a', {deadline: null})], 'requests[0].deadline: must be an integer >= 1'],
  [OK, [R('a', {priority: 1.5})], 'requests[0].priority: must be an integer'],
  [OK, [R('a', {priority: -3, kind: 5})], 'requests[0].kind: must be a string'],
  [OK, [R('a', {resources: []})], 'requests[0].resources: must be a non-empty array'],
  [OK, [R('a', {resources: 'A'})], 'requests[0].resources: must be a non-empty array'],
  [OK, [R('a', {resources: ['A', 'Z']})], 'requests[0].resources[1]: unknown resource Z'],
  [OK, [R('a', {resources: [1]})], 'requests[0].resources[0]: unknown resource 1'],
  [OK, [R('a', {resources: ['A', 'A', 'Z']})], 'requests[0].resources[1]: duplicate resource A'],
  [OK, [R('a', {after: 'b'})], 'requests[0].after: must be an array'],
  [OK, [R('a', {after: ['nope']}), R('b', {duration: 0})], 'requests[1].duration: must be an integer >= 1'],
  [OK, [R('a', {after: ['b']}), R('b', {after: ['a', 'nope']})], 'requests[1].after[1]: unknown request nope'],
  [OK, [R('a', {after: ['b', 'a']}), R('b', {after: [3]})], 'requests[1].after[0]: unknown request 3'],
  [OK, [R('a'), R('b', {after: ['c']}), R('c', {after: ['b']}), R('d', {after: ['a']})], 'requests[1].after: dependency cycle'],
  [OK, [R('w', {after: ['y']}), R('x'), R('y', {after: ['z']}), R('z', {after: ['y']})], 'requests[0].after: dependency cycle'],
  [OK, [R('s', {after: ['s']})], 'requests[0].after: dependency cycle'],
];
for (const [resources, requests, message] of ERRORS) {
  if (message === null) {
    test('valid: ' + JSON.stringify(requests), () => assert.doesNotThrow(() => plan(resources, requests)));
    continue;
  }
  test('error: ' + message, () => assert.throws(() => plan(resources, requests), error => error.constructor === RangeError && error.message === message));
}

// Small random plans, checked against a direct transcription of docs/PLANNER.md (minute by minute).
const WEEK = 10080, H = 12 * WEEK;

function oracle(resources, requests) {
  const xs = resources.map(x => {
    const busy = new Uint8Array(H);
    for (const b of x.blocks ?? []) {
      const every = b.every, count = every === undefined ? 1 : b.count ?? Infinity;
      for (let n = 0; n < count; n++) {
        const from = b.start + n * (every ?? 0);
        if (from >= H) break;
        for (let t = from; t < Math.min(H, from + b.length); t++) busy[t] = 1;
      }
    }
    const pre = new Int32Array(H + 1);
    for (let t = 0; t < H; t++) pre[t + 1] = pre[t] + busy[t];
    return {id: x.id, c: x.changeover ?? 0, pre, bookings: []};
  });
  const rs = requests.map((r, index) => ({index, ...r, earliest: r.earliest ?? 0, priority: r.priority ?? 0, kind: r.kind ?? '', after: r.after ?? []}));
  const done = new Map(); // id -> {end} | {reason}
  const remaining = new Set(rs);
  let inconclusive = false;
  while (remaining.size) {
    const ready = [...remaining].filter(r => r.after.every(id => done.has(id)));
    ready.sort((a, b) => b.priority - a.priority || a.earliest - b.earliest || (a.deadline ?? Infinity) - (b.deadline ?? Infinity) || a.index - b.index);
    const r = ready[0];
    remaining.delete(r);
    if (r.after.some(id => done.get(id).reason)) { done.set(r.id, {reason: 'dependency'}); continue; }
    const lower = Math.max(r.earliest, ...r.after.map(id => done.get(id).end));
    const options = [];
    r.resources.forEach((rid, pos) => {
      const x = xs.find(x => x.id === rid);
      for (let s = lower; s + r.duration <= H; s++) {
        if (x.pre[s + r.duration] - x.pre[s] > 0) continue;
        if (x.bookings.some(b => b.start < s + r.duration && s < b.end)) continue;
        const before = x.bookings.filter(b => b.start < s).sort((a, b) => b.start - a.start)[0];
        const after = x.bookings.filter(b => b.start > s).sort((a, b) => a.start - b.start)[0];
        if (before && before.kind !== r.kind && s < before.end + x.c) continue;
        if (after && after.kind !== r.kind && s + r.duration + x.c > after.start) continue;
        if (s + r.duration > H - 2 * WEEK) inconclusive = true;
        options.push({s, pos, x});
        return;
      }
      if (lower < H - 3 * WEEK) {} else inconclusive = true;
    });
    options.sort((a, b) => a.s - b.s || a.pos - b.pos);
    const best = options[0];
    if (!best) { done.set(r.id, {reason: 'no-slot'}); continue; }
    if (r.deadline !== undefined && best.s + r.duration > r.deadline) { done.set(r.id, {reason: 'deadline'}); continue; }
    best.x.bookings.push({id: r.id, start: best.s, end: best.s + r.duration, kind: r.kind, res: resources.findIndex(y => y.id === best.x.id)});
    done.set(r.id, {end: best.s + r.duration});
  }
  const bookings = xs.flatMap(x => x.bookings).sort((a, b) => a.start - b.start || a.res - b.res).map(b => ({id: b.id, resource: resources[b.res].id, start: b.start, end: b.end}));
  return {inconclusive, result: {bookings, unscheduled: rs.filter(r => done.get(r.id).reason).map(r => ({id: r.id, reason: done.get(r.id).reason}))}};
}

let seed = 31337;
const rnd = n => { seed = seed * 16807 % 2147483647; return Math.floor(seed / 2147483647 * n); };
const DIV = [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 15, 16, 18, 20, 21, 24, 28, 30, 35, 36, 40, 42, 45, 48, 56, 60, 63, 70, 72, 80, 84, 90, 96, 105, 112, 120];
function instance() {
  const nx = 1 + rnd(3);
  const resources = Array.from({length: nx}, (_, i) => {
    const blocks = [];
    for (let q = rnd(3); q > 0; q--) {
      const b = {start: rnd(300), length: 1 + rnd(40)};
      if (rnd(4) === 0) { b.every = [1440, 2016, 2520, 3360, 5040, 10080][rnd(6)]; b.length = 1 + rnd(b.every - 1); b.start = rnd(20000); if (rnd(3) === 0) b.count = 1 + rnd(3); }
      else if (rnd(3)) { const every = DIV.filter(d => d > b.length)[rnd(5)] ?? 120; b.every = every; if (rnd(2)) b.count = 1 + rnd(6); }
      blocks.push(b);
    }
    const x = {id: 'R' + i, blocks};
    if (rnd(2)) x.changeover = rnd(15);
    return x;
  });
  const requests = Array.from({length: 1 + rnd(8)}, (_, i) => {
    const r = {id: 'q' + i, duration: 1 + rnd(rnd(4) ? 30 : 120), resources: []};
    const perm = resources.map(x => x.id);
    for (let k = perm.length - 1; k > 0; k--) { const m = rnd(k + 1); [perm[k], perm[m]] = [perm[m], perm[k]]; }
    r.resources = perm.slice(0, 1 + rnd(perm.length));
    if (rnd(2)) r.earliest = rnd(300);
    if (rnd(3) === 0) r.deadline = 1 + rnd(400);
    if (rnd(2)) r.priority = rnd(3);
    if (rnd(2)) r.kind = 'ab'[rnd(2)];
    if (i && rnd(3) === 0) r.after = [...new Set([rnd(i), rnd(i)])].map(n => 'q' + n);
    return r;
  });
  return {resources, requests};
}

test('random small plans follow the specification', () => {
  let checked = 0;
  for (let trial = 0; trial < 1500; trial++) {
    const {resources, requests} = instance();
    const expected = oracle(resources, requests);
    if (expected.inconclusive) continue;
    checked++;
    assert.deepStrictEqual(plan(resources, requests), expected.result, JSON.stringify({resources, requests}));
  }
  assert.ok(checked > 1400);
});

test('performance: 100 000 requests on 24 resources', () => {
  let seed = 97531;
  const rnd = n => { seed = seed * 16807 % 2147483647; return Math.floor(seed / 2147483647 * n); };
  const resources = Array.from({length: 24}, (_, i) => ({
    id: 'm' + i,
    changeover: (i % 3) * 10,
    blocks: [
      {start: (i * 37) % 1440, length: 300 + i * 5, every: 1440},
      {start: 2000 + i * 100, length: 240, every: 10080},
      {start: (i * 37) % 1440 + 800, length: 60, every: 1440},
      {start: rnd(1e12), length: 1000000},
      {start: 5000, length: 30, every: 720, count: 1000 + i},
    ],
  }));
  const hot = Array.from({length: 8}, () => rnd(1e12));
  const requests = [];
  for (let i = 0; i < 100000; i++) {
    const r = {id: 'r' + i, duration: 30 + rnd(rnd(10) ? 600 : 1200), resources: []};
    const n = 1 + rnd(4);
    while (r.resources.length < n) { const id = 'm' + rnd(24); if (!r.resources.includes(id)) r.resources.push(id); }
    r.earliest = rnd(10) < 3 ? hot[rnd(8)] + rnd(200000) : rnd(1e12);
    if (rnd(5) === 0) r.deadline = r.earliest + r.duration + rnd(5000);
    r.priority = rnd(10) - 3;
    r.kind = 'abc'[rnd(3)];
    if (i > 0 && rnd(10) < 3) { r.after = []; for (let k = 1 + rnd(3); k > 0; k--) r.after.push('r' + Math.max(0, i - 1 - rnd(1000))); }
    requests.push(r);
  }
  const start = performance.now();
  const result = plan(resources, requests);
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 3000, 'took ' + Math.round(elapsed) + ' ms');
  assert.strictEqual(result.bookings.length, 73182);
  assert.strictEqual(createHash('sha256').update(JSON.stringify(result)).digest('hex'), '141f61af6c4f15d885a8b8899fc24b2d425149560ae3018f3a7492e1c426fed7');
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
  writeTree(root, {'src/planner.js': source});
};

export default {
  id: 'resource-planner',
  category: 'exact scheduling with a size budget',
  prompt: 'src/planner.js implements only part of the resource planner specified in docs/PLANNER.md. Make plan implement that specification completely and exactly. Use only Node built-ins and add no dependencies. Do not modify, delete or rename any existing file under test/ (you may add new test files); `npm test` must pass.',
  setup: root => gitRepo(root, [['Resource planner: priorities, one-off blocks, deadlines', files]]),
  solve: root => writeTree(root, {'src/planner.js': REFERENCE}),
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
    // Ready order without the deadline tie-break.
    variant('a.deadline !== b.deadline ? a.deadline < b.deadline : ', ''),
    // Changeover checked only against the booking before the new one.
    variant('s + duration + gap(next) > next.start', 's + duration > next.start'),
    // Deadline compared with the start instead of the end.
    variant('at + r.duration > r.deadline', 'at > r.deadline'),
    // One occurrence too many for counted blocks.
    variant('if (n >= b.count) continue;', 'if (n > b.count) continue;'),
    // The weekly gap that wraps around the end of the week is ignored.
    variant('return Math.max(longest, busy[0][0] + WEEK - reach);', 'return longest;'),
    // Equal earliest starts settled by the order of the resources array instead of the request's preference.
    variant('for (const x of r.allowed) {', 'for (const x of [...r.allowed].sort((p, q) => p - q)) {'),
    // A failed prerequisite only blocks its direct dependents.
    variant('r.after.some(p => reason[p])', "r.after.some(p => reason[p] && reason[p] !== 'dependency')", 'Math.max(t, end[p])', 'Math.max(t, end[p] ?? 0)'),
    // Correct order, but the next request is found by scanning every ready request.
    variant('    const r = pop(heap);', '    let pick = 0;\n    for (let q = 1; q < heap.length; q++) if (before(heap[q], heap[pick])) pick = q;\n    const r = heap[pick];\n    heap[pick] = heap[heap.length - 1];\n    heap.pop();',
      'if (--waiting[d] === 0) push(heap, rs[d]);', 'if (--waiting[d] === 0) heap.push(rs[d]);',
      'if (waiting[r.index] === 0) push(heap, r);', 'if (waiting[r.index] === 0) heap.push(r);'),
    // A visible test edited.
    root => writeTree(root, {'test/planner.test.js': VISIBLE.replace("test('nothing to plan'", "test.skip('nothing to plan'")}),
  ],
};
