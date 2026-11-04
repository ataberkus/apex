// @bun
// The pragma makes Bun run this file untranspiled, so functions embedded as source text keep their exact text (the
// transpiler would reprint them). Bun then reads the file as Latin-1: keep it ASCII-only (evals/ab/run.mjs checks).
import {gitRepo, hiddenTests, npm, read, unchanged, verdict, writeTree} from '../lib.mjs';

const SPEC = `# lkv: an append-only key/value store

\`lkv\` keeps string keys and string values in a directory of append-only *segment* files. \`src/index.js\` exports \`openStore\` and \`CorruptionError\`. This document is the complete contract of the store, including every byte it writes.

## Directory layout

A segment file is named \`data-NNNNNN.log\`, where \`NNNNNN\` is the segment number written as exactly six decimal digits with leading zeros, from \`000001\` to \`999999\`. Every other name in the directory, including \`data-000000.log\`, \`data-1.log\` and \`data-0000001.log\`, is not a segment and is never read, written or deleted, with one exception: \`compact.tmp\` (see Compaction and Recovery).

The segment with the highest number is the *last* segment; every other segment is *sealed*. New records are always appended to the last segment, which is also called the *active* segment.

## Segment format

All integers are unsigned and little-endian.

A segment starts with an 8-byte header: the four ASCII bytes \`LKV1\`, then the segment number as a 32-bit integer. The header of \`data-000012.log\` must say 12.

The header is followed by zero or more records. A record is a 19-byte record header followed by the key and the value:

| Offset | Size | Field |
|---|---|---|
| 0 | 4 | checksum: the CRC-32 of all bytes of the record after this field (bytes 4 to the end of the value), as computed by \`zlib.crc32\` |
| 4 | 1 | flags: the operation in the low 7 bits (1 = set, 2 = delete), plus \`0x80\` (MORE) when another record of the same batch follows |
| 5 | 2 | key length in bytes |
| 7 | 4 | value length in bytes |
| 11 | 8 | expiry time in milliseconds (the same clock as \`now\`, see below), 0 for none |
| 19 | key length | the key, UTF-8 |
| 19 + key length | value length | the value, UTF-8 |

A delete record has an empty value and expiry 0.

A record is *valid* when all of these hold: the whole record lies inside the file, the checksum matches, the flags byte is one of \`0x01\`, \`0x02\`, \`0x81\` and \`0x82\`, the key length is from 1 to 1024, and, for a delete record, the value length and the expiry are 0. A record that extends past the end of the file, including a remainder shorter than 19 bytes, is *incomplete*; incomplete records are never valid.

### Batches

Records are grouped into batches: a batch is a run of consecutive records in which every record except the last has MORE set, and the last does not. A batch never spans two segments. A batch is applied all or nothing: when a store is opened, a batch whose last record is missing or not valid is not applied at all.

## API

\`openStore(dir, {maxSegmentBytes = 4194304, now = Date.now} = {})\` opens the store in \`dir\` (see Recovery) and returns a store object. \`dir\` and missing parent directories are created if needed. \`now\` is a function returning the current time in milliseconds; the store never reads the time in any other way. \`maxSegmentBytes\` (see Rollover) is a positive safe integer. Options are not validated.

The store object has these methods:

- \`get(key)\` returns the value of \`key\` if \`key\` is *live*, else \`undefined\`.
- \`set(key, value, {ttl} = {})\` stores \`value\` under \`key\`. Without \`ttl\` (that is, \`ttl\` is \`undefined\`) the entry never expires, even if the key had an expiry before. With \`ttl\`, its expiry time is \`now() + ttl\`.
- \`delete(key)\` removes \`key\` and returns \`true\` if \`key\` was live just before the call, else \`false\`.
- \`batch(ops)\` applies an array of operations as one batch, in array order. Each operation is an object, either \`{type: 'set', key, value, ttl}\` (\`ttl\` optional, as for \`set()\`) or \`{type: 'delete', key}\`. It returns the number of records written.
- \`keys()\` returns an array of all live keys, sorted by comparing their UTF-8 encodings byte by byte (a key that is a prefix of another comes first). This is not JavaScript's default string order: \`'\\uFF61'\` sorts before \`'\u{1F600}'\` here.
- \`compact()\` compacts the store (see Compaction).
- \`segments()\` returns the names of the segment files of the store, in ascending order of their numbers.
- \`close()\` closes the store. After \`close()\`, every method except \`close()\` throws an \`Error\` with the message \`store is closed\`, before looking at its arguments. Calling \`close()\` again does nothing.
- The property \`recovery\` describes what opening the store repaired (see Recovery).

### Entries and expiry

The store maps each key to an *entry*: a value and an expiry time (0 for none). A key that has an entry is live at time *t* when its expiry is 0 or *t* is less than its expiry; a key whose entry has expired is not live, but it still has its entry until the entry is deleted, overwritten, or dropped by compaction. Every method that needs the time calls \`now()\` itself; a batch uses one time for all its operations.

### Writing records

- \`set()\` writes one set record. \`delete()\` writes one delete record if the key has an entry (live or expired), and nothing otherwise.
- \`batch()\` writes the records of its operations as one batch: a set record for every set operation, and a delete record for every delete operation whose key has an entry at that point of the batch, taking the earlier operations of the same batch into account. Only the last record written has MORE clear. If no record is to be written (no operations, or only deletes of keys without an entry), nothing is written and \`batch()\` returns 0.
- Before \`set()\`, \`delete()\` or \`batch()\` returns, all of its records are in the file. Records are only ever appended: earlier bytes of a segment are never rewritten, except that recovery may cut off a damaged tail.

### Rollover

Before a batch of *B* bytes (all of its records together; a single \`set()\` or \`delete()\` is a batch of one record) is appended, the store checks the active segment's current size *S* in bytes, header included. If the active segment holds at least one record (*S* > 8) and *S* + *B* > \`maxSegmentBytes\`, the store first creates the next segment, numbered one higher than the active one and holding just its header, and that segment becomes the active segment. The batch is then appended to the active segment, even if it is larger than \`maxSegmentBytes\` on its own.

### Argument errors

Arguments are checked before anything is written; the first problem throws:

- A key that is not a string: \`TypeError\` \`key must be a string\`. A key whose UTF-8 encoding is not 1 to 1024 bytes long: \`RangeError\` \`key must be 1 to 1024 bytes\`. These apply to every method that takes a key.
- A value that is not a string: \`TypeError\` \`value must be a string\`.
- A \`ttl\` that is not \`undefined\` and not a positive safe integer: \`RangeError\` \`ttl must be a positive safe integer\`.
- \`batch()\` with something other than an array: \`TypeError\` \`ops must be an array\`. An operation whose \`type\` is not \`'set'\` or \`'delete'\`: \`TypeError\` \`unknown batch operation: <type>\`, where \`<type>\` is \`String(type)\`.

\`set()\` checks key, value, then ttl. \`batch()\` checks its argument, then every operation in array order (type, then key, value and ttl as for \`set()\`), all before writing anything: a batch with an invalid operation writes nothing and changes nothing.

## Compaction

\`compact()\` rewrites the live entries into one new segment and deletes all older segments:

1. It reads the time once. The entries to keep are those whose key is live at that time.
2. It writes \`compact.tmp\` in the store directory: the header of segment *M*, where *M* is the number of the active segment plus one, followed by one set record (MORE clear) per kept entry, with the entry's value and its original expiry time, in the order of \`keys()\`. \`maxSegmentBytes\` does not apply: the new segment holds all kept entries, however large.
3. It renames \`compact.tmp\` to the name of segment *M*, then deletes every older segment of the store in ascending order. Segment *M* becomes the active segment.

Expired entries are thereby dropped from the store. \`compact()\` returns \`{segment, live, removed}\`: the name of segment *M*, the number of entries kept, and the names of the deleted segments in ascending order.

## Recovery

\`openStore()\` recovers the directory in this order:

1. A file named \`compact.tmp\` is left over from an interrupted compaction and is to be removed. If the last segment is shorter than 8 bytes (it was being created when the process stopped), it is to be removed as well, and the segment before it, if any, becomes the last segment.
2. Every remaining segment is read and checked, in ascending order of numbers:
   - A segment whose first 8 bytes are not a correct header for its own number (including a sealed segment shorter than 8 bytes) is the error \`bad header in <name>\`.
   - In a sealed segment, every record must be valid and the segment must not end inside a batch. The first record that is not valid is the error \`corrupt record in <name> at offset <offset>\`, where \`<offset>\` is the record's byte offset in the file; a segment whose records are all valid but whose last record has MORE set is the error \`unterminated batch in <name> at offset <offset>\`, where \`<offset>\` is the offset of that unfinished batch's first record.
   - In the last segment, the first record that is not valid and everything after it is the *damaged tail*, even when valid records follow. The tail is cut at the start of the batch that the first invalid record belongs to: at the first record of the unfinished batch before it, if the record before it has MORE set, or else at the invalid record itself. If all records are valid but the last one has MORE set, the tail is cut at the first record of that unfinished batch.
3. All of this is checked before anything is changed. The first problem found throws a \`CorruptionError\` (a subclass of \`Error\` whose \`name\` is \`'CorruptionError'\`) with the message shown above, and then no file has been created, removed or modified.
4. Otherwise the files from step 1 are removed, and the last segment is truncated at the cut, if there is one.
5. If no segment remains (the directory had none, or only one that was removed in step 1), the store creates \`data-000001.log\` holding just its header.
6. All batches are replayed in order to rebuild the entries. Expired entries are kept as they are (they are only hidden by \`get()\` and \`keys()\`).

\`store.recovery\` is \`{removed, truncated}\`: \`removed\` is the array of names removed in step 1 (\`compact.tmp\` first, if present), and \`truncated\` is \`null\` or \`{segment, offset, bytes}\`: the name of the truncated segment, the offset of the cut, and the number of bytes cut off.

## Performance

- \`openStore()\` takes time proportional to the total size of the segments. Opening segments that hold 200,000 short records takes under 2 seconds.
- \`set()\`, \`delete()\` and \`batch()\` take time proportional to the size of what they write, never to the size of the store or of its segments. 20,000 \`set()\` calls with short keys and values on a new store take under 3 seconds.
`;

const FILES = {
  'src/index.js': `export {openStore} from './store.js';
export {CorruptionError} from './errors.js';
`,
  'src/errors.js': `/** Thrown by openStore() when a segment is damaged beyond repair; see docs/STORE.md. */
export class CorruptionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CorruptionError';
  }
}
`,
};

const NAIVE_RECORD = String.raw`import {crc32} from 'node:zlib';

export const SET = 1;
export const DELETE = 2;
export const RECORD_HEADER = 19;

/** One record; see docs/STORE.md, "Segment format". */
export function encodeRecord(op, key, value) {
  const k = Buffer.from(key);
  const v = Buffer.from(value);
  const out = Buffer.alloc(RECORD_HEADER + k.length + v.length);
  out[4] = op;
  out.writeUInt16LE(k.length, 5);
  out.writeUInt32LE(v.length, 7);
  k.copy(out, RECORD_HEADER);
  v.copy(out, RECORD_HEADER + k.length);
  out.writeUInt32LE(crc32(out.subarray(4)), 0);
  return out;
}

export function* decodeRecords(buffer, offset) {
  while (offset < buffer.length) {
    const keyLength = buffer.readUInt16LE(offset + 5);
    const valueLength = buffer.readUInt32LE(offset + 7);
    const end = offset + RECORD_HEADER + keyLength + valueLength;
    if (buffer.readUInt32LE(offset) !== crc32(buffer.subarray(offset + 4, end))) throw new Error('bad record at ' + offset);
    const keyEnd = offset + RECORD_HEADER + keyLength;
    yield {op: buffer[offset + 4], key: buffer.toString('utf8', offset + RECORD_HEADER, keyEnd), value: buffer.toString('utf8', keyEnd, end)};
    offset = end;
  }
}
`;

const NAIVE_SEGMENTS = String.raw`export const HEADER = 8;

export const segmentName = number => 'data-' + String(number).padStart(6, '0') + '.log';

export function header(number) {
  const out = Buffer.alloc(HEADER);
  out.write('LKV1', 0, 'latin1');
  out.writeUInt32LE(number, 4);
  return out;
}
`;

const NAIVE_STORE = String.raw`import fs from 'node:fs';
import path from 'node:path';
import {DELETE, SET, decodeRecords, encodeRecord} from './record.js';
import {HEADER, header, segmentName} from './segments.js';

/** First version: one segment, no expiry, batches, rollover, compaction or recovery yet. See docs/STORE.md. */
export function openStore(dir) {
  return new Store(dir);
}

class Store {
  #file;
  #index = new Map();
  recovery = {removed: [], truncated: null};

  constructor(dir) {
    fs.mkdirSync(dir, {recursive: true});
    this.#file = path.join(dir, segmentName(1));
    if (!fs.existsSync(this.#file)) fs.writeFileSync(this.#file, header(1));
    for (const record of decodeRecords(fs.readFileSync(this.#file), HEADER)) {
      if (record.op === SET) this.#index.set(record.key, record.value);
      else this.#index.delete(record.key);
    }
  }

  get(key) {
    return this.#index.get(key);
  }

  set(key, value) {
    fs.appendFileSync(this.#file, encodeRecord(SET, key, value));
    this.#index.set(key, value);
  }

  delete(key) {
    fs.appendFileSync(this.#file, encodeRecord(DELETE, key, ''));
    return this.#index.delete(key);
  }

  keys() {
    return [...this.#index.keys()].sort();
  }

  segments() {
    return [path.basename(this.#file)];
  }

  close() {}
}
`;

const VISIBLE = String.raw`import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openStore} from '../src/index.js';

const dirs = [];
after(() => { for (const dir of dirs) try { fs.rmSync(dir, {recursive: true, force: true}); } catch {} });
const tmp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lkv-visible-')); dirs.push(dir); return dir; };

test('set, get and delete', () => {
  const db = openStore(tmp());
  db.set('a', '1');
  db.set('b', '2');
  db.set('a', '3');
  assert.equal(db.get('a'), '3');
  assert.equal(db.delete('b'), true);
  assert.equal(db.get('b'), undefined);
  db.close();
});

test('values survive reopening', () => {
  const dir = tmp();
  let db = openStore(dir);
  db.set('fruit', 'apple');
  db.set('veg', 'leek');
  db.delete('veg');
  db.close();
  db = openStore(dir);
  assert.equal(db.get('fruit'), 'apple');
  assert.equal(db.get('veg'), undefined);
  assert.deepEqual(db.recovery, {removed: [], truncated: null});
  db.close();
});

test('the first record is written after the header', () => {
  const dir = tmp();
  const db = openStore(dir);
  db.set('k', 'v');
  assert.equal(fs.readFileSync(path.join(dir, 'data-000001.log')).toString('hex'),
    '4c4b5631010000007c2c41420101000100000000000000000000006b76');
  db.close();
});

test('keys are sorted', () => {
  const db = openStore(tmp());
  for (const key of ['pear', 'apple', 'fig']) db.set(key, 'x');
  assert.deepEqual(db.keys(), ['apple', 'fig', 'pear']);
  assert.deepEqual(db.segments(), ['data-000001.log']);
  db.close();
});
`;

const files = {
  'package.json': JSON.stringify({name: 'lkv', version: '0.2.0', type: 'module', scripts: {test: 'node --test test/*.test.js'}}, null, 2) + '\n',
  'docs/STORE.md': SPEC,
  ...FILES,
  'src/record.js': NAIVE_RECORD,
  'src/segments.js': NAIVE_SEGMENTS,
  'src/store.js': NAIVE_STORE,
  'test/store.test.js': VISIBLE,
};

const REF_RECORD = String.raw`import {crc32} from 'node:zlib';

export const SET = 1;
export const DELETE = 2;
export const MORE = 0x80;
export const RECORD_HEADER = 19;
export const MAX_KEY = 1024;

/** One record; see docs/STORE.md, "Segment format". */
export function encodeRecord(op, key, value, expiresAt, more) {
  const k = Buffer.from(key);
  const v = Buffer.from(value);
  const out = Buffer.alloc(RECORD_HEADER + k.length + v.length);
  out[4] = op | (more ? MORE : 0);
  out.writeUInt16LE(k.length, 5);
  out.writeUInt32LE(v.length, 7);
  out.writeBigUInt64LE(BigInt(expiresAt), 11);
  k.copy(out, RECORD_HEADER);
  v.copy(out, RECORD_HEADER + k.length);
  out.writeUInt32LE(crc32(out.subarray(4)), 0);
  return out;
}

/** The valid record at offset, as {op, more, key, value, expiresAt, next}, or null if it is incomplete or not valid. */
export function readRecord(buffer, offset) {
  if (buffer.length - offset < RECORD_HEADER) return null;
  const keyLength = buffer.readUInt16LE(offset + 5);
  const valueLength = buffer.readUInt32LE(offset + 7);
  const keyEnd = offset + RECORD_HEADER + keyLength;
  const end = keyEnd + valueLength;
  if (end > buffer.length) return null;
  if (buffer.readUInt32LE(offset) !== crc32(buffer.subarray(offset + 4, end))) return null;
  const flags = buffer[offset + 4];
  const op = flags & ~MORE;
  const expiresAt = Number(buffer.readBigUInt64LE(offset + 11));
  if (op !== SET && op !== DELETE) return null;
  if (keyLength < 1 || keyLength > MAX_KEY) return null;
  if (op === DELETE && (valueLength !== 0 || expiresAt !== 0)) return null;
  return {op, more: flags >= MORE, key: buffer.toString('utf8', offset + RECORD_HEADER, keyEnd), value: buffer.toString('utf8', keyEnd, end), expiresAt, next: end};
}
`;

const REF_SEGMENTS = String.raw`export const HEADER = 8;

export const segmentName = number => 'data-' + String(number).padStart(6, '0') + '.log';

export function header(number) {
  const out = Buffer.alloc(HEADER);
  out.write('LKV1', 0, 'latin1');
  out.writeUInt32LE(number, 4);
  return out;
}

/** Segment numbers among directory entry names, ascending. */
export function segmentNumbers(names) {
  return names.map(name => /^data-(\d{6})\.log$/.exec(name)).filter(match => match && match[1] !== '000000')
    .map(match => Number(match[1])).sort((a, b) => a - b);
}

export const validHeader = (buffer, number) => buffer.length >= HEADER && buffer.subarray(0, HEADER).equals(header(number));
`;

const REF_STORE = String.raw`import fs from 'node:fs';
import path from 'node:path';
import {CorruptionError} from './errors.js';
import {DELETE, MAX_KEY, SET, encodeRecord, readRecord} from './record.js';
import {HEADER, header, segmentName, segmentNumbers, validHeader} from './segments.js';

const TMP = 'compact.tmp';
const byteOrder = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const live = (entry, time) => entry !== undefined && (entry.expiresAt === 0 || time < entry.expiresAt);

function checkKey(key) {
  if (typeof key !== 'string') throw new TypeError('key must be a string');
  const length = Buffer.byteLength(key);
  if (length < 1 || length > MAX_KEY) throw new RangeError('key must be 1 to 1024 bytes');
}

function checkSet(key, value, ttl) {
  checkKey(key);
  if (typeof value !== 'string') throw new TypeError('value must be a string');
  if (ttl !== undefined && !(Number.isSafeInteger(ttl) && ttl > 0)) throw new RangeError('ttl must be a positive safe integer');
}

/** Checks one segment; returns its complete batches and, for the last segment, where a damaged tail starts (or null). */
function scan(name, number, buffer, last) {
  if (!validHeader(buffer, number)) throw new CorruptionError('bad header in ' + name);
  const batches = [];
  let batch = [];
  let batchStart = HEADER;
  let offset = HEADER;
  while (offset < buffer.length) {
    const record = readRecord(buffer, offset);
    if (!record) {
      if (!last) throw new CorruptionError('corrupt record in ' + name + ' at offset ' + offset);
      return {batches, cut: batch.length ? batchStart : offset};
    }
    if (!batch.length) batchStart = offset;
    batch.push(record);
    offset = record.next;
    if (!record.more) {
      batches.push(batch);
      batch = [];
    }
  }
  if (batch.length) {
    if (!last) throw new CorruptionError('unterminated batch in ' + name + ' at offset ' + batchStart);
    return {batches, cut: batchStart};
  }
  return {batches, cut: null};
}

export function openStore(dir, {maxSegmentBytes = 4194304, now = Date.now} = {}) {
  return new Store(dir, maxSegmentBytes, now);
}

class Store {
  #dir;
  #max;
  #now;
  #index = new Map();
  #numbers;
  #fd;
  #size;
  #closed = false;
  recovery;

  constructor(dir, maxSegmentBytes, now) {
    this.#dir = dir;
    this.#max = maxSegmentBytes;
    this.#now = now;
    fs.mkdirSync(dir, {recursive: true});
    const names = fs.readdirSync(dir);
    const removed = names.includes(TMP) ? [TMP] : [];
    const numbers = segmentNumbers(names);
    const buffers = numbers.map(number => fs.readFileSync(this.#path(number)));
    if (buffers.length && buffers.at(-1).length < HEADER) {
      removed.push(segmentName(numbers.pop()));
      buffers.pop();
    }
    const scans = numbers.map((number, i) => scan(segmentName(number), number, buffers[i], i === numbers.length - 1));
    for (const name of removed) fs.rmSync(path.join(dir, name), {recursive: true, force: true});
    let truncated = null;
    const tail = scans.at(-1);
    if (tail && tail.cut !== null) {
      const last = numbers.at(-1);
      fs.truncateSync(this.#path(last), tail.cut);
      truncated = {segment: segmentName(last), offset: tail.cut, bytes: buffers.at(-1).length - tail.cut};
    }
    if (!numbers.length) {
      numbers.push(1);
      fs.writeFileSync(this.#path(1), header(1));
    }
    for (const {batches} of scans) for (const batch of batches) for (const record of batch) this.#apply(record.op, record.key, record.value, record.expiresAt);
    this.#numbers = numbers;
    this.#size = tail ? (tail.cut ?? buffers.at(-1).length) : HEADER;
    this.#fd = fs.openSync(this.#path(numbers.at(-1)), 'a');
    this.recovery = {removed, truncated};
  }

  #path(number) {
    return path.join(this.#dir, segmentName(number));
  }

  #open() {
    if (this.#closed) throw new Error('store is closed');
  }

  #apply(op, key, value, expiresAt) {
    if (op === SET) this.#index.set(key, {value, expiresAt});
    else this.#index.delete(key);
  }

  get(key) {
    this.#open();
    checkKey(key);
    const entry = this.#index.get(key);
    return live(entry, this.#now()) ? entry.value : undefined;
  }

  set(key, value, {ttl} = {}) {
    this.#open();
    checkSet(key, value, ttl);
    this.#write([{type: 'set', key, value, ttl}]);
  }

  delete(key) {
    this.#open();
    checkKey(key);
    const entry = this.#index.get(key);
    const wasLive = live(entry, this.#now());
    this.#write([{type: 'delete', key}]);
    return wasLive;
  }

  batch(ops) {
    this.#open();
    if (!Array.isArray(ops)) throw new TypeError('ops must be an array');
    for (const op of ops) {
      if (op.type === 'set') checkSet(op.key, op.value, op.ttl);
      else if (op.type === 'delete') checkKey(op.key);
      else throw new TypeError('unknown batch operation: ' + String(op.type));
    }
    return this.#write(ops);
  }

  /** Writes validated operations as one batch; returns the number of records written. */
  #write(ops) {
    const time = this.#now();
    const staged = new Map();
    const has = key => staged.has(key) ? staged.get(key) : this.#index.has(key);
    const records = [];
    for (const op of ops) {
      if (op.type === 'set') {
        records.push([SET, op.key, op.value, op.ttl === undefined ? 0 : time + op.ttl]);
        staged.set(op.key, true);
      } else if (has(op.key)) {
        records.push([DELETE, op.key, '', 0]);
        staged.set(op.key, false);
      }
    }
    if (!records.length) return 0;
    const data = Buffer.concat(records.map(([op, key, value, expiresAt], i) => encodeRecord(op, key, value, expiresAt, i < records.length - 1)));
    if (this.#size > HEADER && this.#size + data.length > this.#max) this.#roll();
    fs.writeSync(this.#fd, data);
    this.#size += data.length;
    for (const [op, key, value, expiresAt] of records) this.#apply(op, key, value, expiresAt);
    return records.length;
  }

  #roll() {
    const number = this.#numbers.at(-1) + 1;
    fs.closeSync(this.#fd);
    fs.writeFileSync(this.#path(number), header(number));
    this.#numbers.push(number);
    this.#fd = fs.openSync(this.#path(number), 'a');
    this.#size = HEADER;
  }

  keys() {
    this.#open();
    const time = this.#now();
    return [...this.#index].filter(([, entry]) => live(entry, time)).map(([key]) => key).sort(byteOrder);
  }

  compact() {
    this.#open();
    const time = this.#now();
    const kept = [...this.#index].filter(([, entry]) => live(entry, time)).sort(([a], [b]) => byteOrder(a, b));
    const number = this.#numbers.at(-1) + 1;
    const data = Buffer.concat([header(number), ...kept.map(([key, entry]) => encodeRecord(SET, key, entry.value, entry.expiresAt, false))]);
    const temp = path.join(this.#dir, TMP);
    fs.writeFileSync(temp, data);
    fs.closeSync(this.#fd);
    fs.renameSync(temp, this.#path(number));
    const removed = this.#numbers.map(segmentName);
    for (const old of this.#numbers) fs.rmSync(this.#path(old));
    this.#numbers = [number];
    this.#index = new Map(kept);
    this.#fd = fs.openSync(this.#path(number), 'a');
    this.#size = data.length;
    return {segment: segmentName(number), live: kept.length, removed};
  }

  segments() {
    this.#open();
    return this.#numbers.map(segmentName);
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    fs.closeSync(this.#fd);
  }
}
`;

// Independent test-side builders, copied into the hidden test source.
function lkvRecord(flags, key, value = '', expiresAt = 0, {keyLength, valueLength} = {}) {
  const k = Buffer.from(key);
  const v = Buffer.from(value);
  const out = Buffer.alloc(19 + k.length + v.length);
  out[4] = flags;
  out.writeUInt16LE(keyLength ?? k.length, 5);
  out.writeUInt32LE(valueLength ?? v.length, 7);
  out.writeBigUInt64LE(BigInt(expiresAt), 11);
  k.copy(out, 19);
  v.copy(out, 19 + k.length);
  out.writeUInt32LE(zlib.crc32(out.subarray(4)), 0);
  return out;
}
function lkvHeader(number, magic = 'LKV1') {
  const out = Buffer.alloc(8);
  out.write(magic, 0, 'latin1');
  out.writeUInt32LE(number, 4);
  return out;
}

const HIDDEN = String.raw`import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
const {openStore, CorruptionError} = await import('@ROOT@src/index.js');
${lkvRecord}
${lkvHeader}

const dirs = [];
after(() => { for (const dir of dirs) try { fs.rmSync(dir, {recursive: true, force: true}); } catch {} });
const tmp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lkv-hidden-')); dirs.push(dir); return dir; };
const name = number => 'data-' + String(number).padStart(6, '0') + '.log';
const bytes = (dir, file) => fs.readFileSync(path.join(dir, file)).toString('hex');
const hex = parts => Buffer.concat(parts).toString('hex');
const listing = dir => fs.readdirSync(dir).sort();
const put = (dir, files) => { for (const [file, parts] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), Buffer.concat(parts.map(p => Buffer.from(p)))); };
const snapshotDir = dir => Object.fromEntries(listing(dir).map(file => [file, bytes(dir, file)]));
const H = number => lkvHeader(number);
const S = (key, value, expiresAt = 0, more = false) => lkvRecord(more ? 0x81 : 0x01, key, value, expiresAt);
const D = (key, more = false) => lkvRecord(more ? 0x82 : 0x02, key);
const clock = (start = 1000) => { const c = () => c.t; c.t = start; return c; };
const throwsWith = (fn, type, message) => assert.throws(fn, error => error instanceof type && error.message === message, message);
const len = (...parts) => Buffer.concat(parts).length;

test('a new store has one empty segment', () => {
  const dir = tmp();
  const db = openStore(dir);
  assert.deepStrictEqual(db.recovery, {removed: [], truncated: null});
  assert.deepStrictEqual(db.segments(), ['data-000001.log']);
  assert.equal(bytes(dir, name(1)), hex([H(1)]));
  db.close();
});

test('missing directories are created', () => {
  const dir = path.join(tmp(), 'deep', 'er');
  const db = openStore(dir);
  db.set('a', 'b');
  db.close();
  assert.deepStrictEqual(listing(dir), ['data-000001.log']);
});

test('records are written exactly and immediately', () => {
  const dir = tmp();
  const c = clock();
  const db = openStore(dir, {now: c});
  db.set('a', '1');
  assert.equal(bytes(dir, name(1)), hex([H(1), S('a', '1')]));
  c.t = 5000;
  db.set('k\u00e9', '\u{1F600}', {ttl: 1000});
  assert.equal(bytes(dir, name(1)), hex([H(1), S('a', '1'), S('k\u00e9', '\u{1F600}', 6000)]));
  assert.equal(db.delete('a'), true);
  assert.equal(db.delete('zz'), false);
  assert.equal(bytes(dir, name(1)), hex([H(1), S('a', '1'), S('k\u00e9', '\u{1F600}', 6000), D('a')]));
  db.set('long', 'x'.repeat(70000));
  assert.equal(bytes(dir, name(1)), hex([H(1), S('a', '1'), S('k\u00e9', '\u{1F600}', 6000), D('a'), S('long', 'x'.repeat(70000))]));
  db.close();
});

test('batch records', () => {
  const dir = tmp();
  const c = clock(10);
  const db = openStore(dir, {now: c});
  const expect = [H(1)];
  const check = () => assert.equal(bytes(dir, name(1)), hex(expect));
  assert.equal(db.batch([{type: 'set', key: 'x', value: '1'}, {type: 'set', key: 'y', value: '2', ttl: 5}, {type: 'delete', key: 'x'}]), 3);
  expect.push(S('x', '1', 0, true), S('y', '2', 15, true), D('x'));
  check();
  assert.equal(db.batch([{type: 'set', key: 'z', value: ''}, {type: 'delete', key: 'nope'}]), 1);
  expect.push(S('z', ''));
  check();
  assert.equal(db.batch([{type: 'delete', key: 'nope'}]), 0);
  assert.equal(db.batch([]), 0);
  check();
  c.t = 100;
  assert.equal(db.batch([{type: 'delete', key: 'y'}, {type: 'delete', key: 'y'}, {type: 'delete', key: 'x'}]), 1);
  expect.push(D('y'));
  check();
  assert.equal(db.batch([{type: 'set', key: 'n', value: '1', ttl: undefined}, {type: 'delete', key: 'n'}, {type: 'delete', key: 'z'}, {type: 'set', key: 'z', value: '2', ttl: 1}]), 4);
  expect.push(S('n', '1', 0, true), D('n', true), D('z', true), S('z', '2', 101));
  check();
  assert.equal(db.get('n'), undefined);
  assert.equal(db.get('z'), '2');
  db.close();
});

test('a batch with an invalid operation writes and changes nothing', () => {
  const dir = tmp();
  const db = openStore(dir);
  db.set('a', '1');
  const before = bytes(dir, name(1));
  throwsWith(() => db.batch([{type: 'set', key: 'b', value: 'v'}, {type: 'set', key: 'c', value: 7}]), TypeError, 'value must be a string');
  throwsWith(() => db.batch([{type: 'delete', key: 'a'}, {type: 'merge', key: 'a'}]), TypeError, 'unknown batch operation: merge');
  throwsWith(() => db.batch([{type: 'delete', key: 'a'}, {key: 'a', value: 'v'}]), TypeError, 'unknown batch operation: undefined');
  throwsWith(() => db.batch([{type: 'set', key: 'b', value: 'v'}, {type: 'set', key: 'c', value: 'v', ttl: 0}]), RangeError, 'ttl must be a positive safe integer');
  throwsWith(() => db.batch([{type: 'delete', key: ''}]), RangeError, 'key must be 1 to 1024 bytes');
  assert.equal(bytes(dir, name(1)), before);
  assert.equal(db.get('a'), '1');
  assert.equal(db.get('b'), undefined);
  db.close();
});

test('expiry follows the injected clock', () => {
  const dir = tmp();
  const c = clock(1000);
  const db = openStore(dir, {now: c});
  db.set('k', 'v', {ttl: 100});
  c.t = 1099;
  assert.equal(db.get('k'), 'v');
  assert.deepStrictEqual(db.keys(), ['k']);
  c.t = 1100;
  assert.equal(db.get('k'), undefined);
  assert.deepStrictEqual(db.keys(), []);
  const size = fs.statSync(path.join(dir, name(1))).size;
  assert.equal(db.delete('k'), false);
  assert.equal(fs.statSync(path.join(dir, name(1))).size, size + len(D('k')));
  assert.equal(db.delete('k'), false);
  assert.equal(fs.statSync(path.join(dir, name(1))).size, size + len(D('k')));
  c.t = 2000;
  db.set('k', 'w', {ttl: 10});
  db.set('k', 'x');
  c.t = 1e12;
  assert.equal(db.get('k'), 'x');
  db.set('t', 'y', {ttl: 1});
  assert.equal(db.delete('t'), true);
  db.close();
});

test('keys are live and in UTF-8 byte order', () => {
  const db = openStore(tmp());
  for (const key of ['b', 'a', '\uFF61', '\u{1F600}', '\u00e9', 'Z', 'ab', '\uE000', '\u{10000}']) db.set(key, '1');
  db.delete('b');
  assert.deepStrictEqual(db.keys(), ['Z', 'a', 'ab', '\u00e9', '\uE000', '\uFF61', '\u{10000}', '\u{1F600}']);
  db.close();
});

test('reopening restores values, deletions and expiry times', () => {
  const dir = tmp();
  const c = clock(1000);
  let db = openStore(dir, {now: c});
  db.set('a', '1');
  db.set('b', '2', {ttl: 500});
  db.batch([{type: 'set', key: 'c', value: '3'}, {type: 'delete', key: 'a'}]);
  db.close();
  db = openStore(dir, {now: c});
  assert.deepStrictEqual(db.recovery, {removed: [], truncated: null});
  assert.deepStrictEqual(db.keys(), ['b', 'c']);
  c.t = 1500;
  assert.deepStrictEqual(db.keys(), ['c']);
  assert.equal(db.delete('b'), false);
  db.set('d', '4');
  db.close();
  assert.equal(bytes(dir, name(1)), hex([H(1), S('a', '1'), S('b', '2', 1500), S('c', '3', 0, true), D('a'), D('b'), S('d', '4')]));
});

test('argument errors', () => {
  const db = openStore(tmp());
  throwsWith(() => db.set(1, 'x'), TypeError, 'key must be a string');
  throwsWith(() => db.set(5, 5, {ttl: 0}), TypeError, 'key must be a string');
  throwsWith(() => db.set('', 'x'), RangeError, 'key must be 1 to 1024 bytes');
  throwsWith(() => db.set('k'.repeat(1025), 'x'), RangeError, 'key must be 1 to 1024 bytes');
  throwsWith(() => db.set('\u00e9'.repeat(513), 'x'), RangeError, 'key must be 1 to 1024 bytes');
  throwsWith(() => db.set('', 5), RangeError, 'key must be 1 to 1024 bytes');
  db.set('\u00e9'.repeat(512), 'x');
  throwsWith(() => db.set('k', 5), TypeError, 'value must be a string');
  throwsWith(() => db.set('k', null, {ttl: -1}), TypeError, 'value must be a string');
  for (const ttl of [0, -1, 1.5, '5', NaN, 2 ** 53, null, Infinity]) throwsWith(() => db.set('k', 'v', {ttl}), RangeError, 'ttl must be a positive safe integer');
  throwsWith(() => db.get(5), TypeError, 'key must be a string');
  throwsWith(() => db.get(''), RangeError, 'key must be 1 to 1024 bytes');
  throwsWith(() => db.delete(undefined), TypeError, 'key must be a string');
  throwsWith(() => db.delete('x'.repeat(2000)), RangeError, 'key must be 1 to 1024 bytes');
  throwsWith(() => db.batch('x'), TypeError, 'ops must be an array');
  throwsWith(() => db.batch({length: 0}), TypeError, 'ops must be an array');
  throwsWith(() => db.batch([{type: 'SET', key: 'a', value: 'b'}]), TypeError, 'unknown batch operation: SET');
  assert.deepStrictEqual(db.keys(), ['\u00e9'.repeat(512)]);
  db.close();
});

test('a closed store refuses every method but close', () => {
  const db = openStore(tmp());
  db.close();
  for (const call of [() => db.get('a'), () => db.get(5), () => db.set('a', 'b'), () => db.set(1, 2), () => db.delete('a'), () => db.batch([]),
    () => db.batch('x'), () => db.keys(), () => db.compact(), () => db.segments()]) {
    throwsWith(call, Error, 'store is closed');
  }
  db.close();
});

test('segment rollover', () => {
  const dir = tmp();
  let db = openStore(dir, {maxSegmentBytes: 92});
  for (const key of ['a', 'b', 'c', 'd']) db.set(key, '1');
  assert.deepStrictEqual(db.segments(), [name(1)]);
  assert.equal(bytes(dir, name(1)), hex([H(1), S('a', '1'), S('b', '1'), S('c', '1'), S('d', '1')]));
  db.set('e', '1');
  assert.deepStrictEqual(db.segments(), [name(1), name(2)]);
  assert.equal(bytes(dir, name(2)), hex([H(2), S('e', '1')]));
  assert.equal(db.batch([{type: 'set', key: 'f', value: '1'}, {type: 'set', key: 'g', value: '1'}, {type: 'set', key: 'h', value: '1'}]), 3);
  assert.equal(bytes(dir, name(2)), hex([H(2), S('e', '1'), S('f', '1', 0, true), S('g', '1', 0, true), S('h', '1')]));
  db.delete('a');
  assert.deepStrictEqual(db.segments(), [name(1), name(2), name(3)]);
  assert.equal(bytes(dir, name(3)), hex([H(3), D('a')]));
  db.set('big', 'v'.repeat(200));
  assert.equal(bytes(dir, name(3)), hex([H(3), D('a')]));
  assert.equal(bytes(dir, name(4)), hex([H(4), S('big', 'v'.repeat(200))]));
  db.set('i', '1');
  assert.deepStrictEqual(db.segments(), [name(1), name(2), name(3), name(4), name(5)]);
  db.close();
  db = openStore(dir, {maxSegmentBytes: 92});
  assert.deepStrictEqual(db.segments(), [name(1), name(2), name(3), name(4), name(5)]);
  db.set('j', '1');
  assert.equal(bytes(dir, name(5)), hex([H(5), S('i', '1'), S('j', '1')]));
  assert.deepStrictEqual(db.keys(), ['b', 'big', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);
  db.close();
});

test('an oversized first write stays in the empty segment', () => {
  const dir = tmp();
  const db = openStore(dir, {maxSegmentBytes: 30});
  db.batch([{type: 'set', key: 'a', value: '1'}, {type: 'set', key: 'b', value: '2'}]);
  db.set('c', '3');
  assert.deepStrictEqual(listing(dir), [name(1), name(2)]);
  assert.equal(bytes(dir, name(1)), hex([H(1), S('a', '1', 0, true), S('b', '2')]));
  assert.equal(bytes(dir, name(2)), hex([H(2), S('c', '3')]));
  db.close();
});

const recover = (files, options) => {
  const dir = tmp();
  put(dir, files);
  return {dir, db: openStore(dir, options)};
};

test('a torn record at the end is cut off', () => {
  const tail = S('b', '2'.repeat(30)).subarray(0, 25);
  const {dir, db} = recover({[name(1)]: [H(1), S('a', '1'), tail]});
  assert.deepStrictEqual(db.recovery, {removed: [], truncated: {segment: name(1), offset: 29, bytes: 25}});
  assert.equal(bytes(dir, name(1)), hex([H(1), S('a', '1')]));
  assert.equal(db.get('a'), '1');
  assert.equal(db.get('b'), undefined);
  db.set('c', '3');
  assert.equal(bytes(dir, name(1)), hex([H(1), S('a', '1'), S('c', '3')]));
  db.close();
});

test('a tail shorter than a record header is cut off', () => {
  const {dir, db} = recover({[name(1)]: [H(1), S('a', '1'), S('b', '2').subarray(0, 5)]});
  assert.deepStrictEqual(db.recovery.truncated, {segment: name(1), offset: 29, bytes: 5});
  assert.equal(bytes(dir, name(1)), hex([H(1), S('a', '1')]));
  db.close();
});

test('a bad record cuts off the rest of the last segment', () => {
  const bad = S('b', '2');
  bad[20] ^= 1;
  const {dir, db} = recover({[name(1)]: [H(1), S('a', '1'), bad, S('c', '3'), S('d', '4')]});
  assert.deepStrictEqual(db.recovery.truncated, {segment: name(1), offset: 29, bytes: len(bad, S('c', '3'), S('d', '4'))});
  assert.deepStrictEqual(db.keys(), ['a']);
  assert.equal(bytes(dir, name(1)), hex([H(1), S('a', '1')]));
  db.close();
});

test('records with a correct checksum can still be invalid', () => {
  const invalid = [
    lkvRecord(0x03, 'b', '2'), lkvRecord(0x00, 'b', '2'), lkvRecord(0x41, 'b', '2'), lkvRecord(0x83, 'b', '2'),
    lkvRecord(0x02, 'b', 'v'), lkvRecord(0x02, 'b', '', 5), lkvRecord(0x01, '', 'v'), lkvRecord(0x01, 'k'.repeat(1025), 'v'),
    lkvRecord(0x01, 'b', '2', 0, {valueLength: 1000}), lkvRecord(0x01, 'b', '2', 0, {keyLength: 0xFFFF}),
  ];
  for (const [i, record] of invalid.entries()) {
    const {dir, db} = recover({[name(1)]: [H(1), S('a', '1'), record, S('c', '3')]});
    assert.deepStrictEqual(db.recovery.truncated, {segment: name(1), offset: 29, bytes: len(record, S('c', '3'))}, 'record ' + i);
    assert.deepStrictEqual(db.keys(), ['a']);
    db.close();
  }
  const {db} = recover({[name(1)]: [H(1), lkvRecord(0x01, 'k'.repeat(1024), '\u00e9'), lkvRecord(0x81, 'b', '', 7), lkvRecord(0x02, 'b')]}, {now: clock(0)});
  assert.equal(db.recovery.truncated, null);
  assert.deepStrictEqual(db.keys(), ['k'.repeat(1024)]);
  db.close();
});

test('a torn batch is cut at its first record', () => {
  const {dir, db} = recover({[name(1)]: [H(1), S('a', '1'), S('b', '2', 0, true), S('c', '3', 0, true), S('d', '4').subarray(0, 10)]});
  assert.deepStrictEqual(db.recovery.truncated, {segment: name(1), offset: 29, bytes: len(S('b', '2'), S('c', '3')) + 10});
  assert.deepStrictEqual(db.keys(), ['a']);
  assert.equal(bytes(dir, name(1)), hex([H(1), S('a', '1')]));
  db.close();
});

test('a batch without its last record is cut at its first record', () => {
  const {dir, db} = recover({[name(1)]: [H(1), S('a', '1'), S('b', '2', 0, true), D('a', true)]});
  assert.deepStrictEqual(db.recovery.truncated, {segment: name(1), offset: 29, bytes: len(S('b', '2'), D('a'))});
  assert.deepStrictEqual(db.keys(), ['a']);
  db.set('e', '5');
  db.close();
  assert.equal(bytes(dir, name(1)), hex([H(1), S('a', '1'), S('e', '5')]));
});

test('a bad record right after a finished batch', () => {
  const {db} = recover({[name(1)]: [H(1), S('a', '1', 0, true), S('b', '2'), Buffer.from('garbage that is long enough to be a header')]});
  assert.deepStrictEqual(db.recovery.truncated, {segment: name(1), offset: 8 + len(S('a', '1'), S('b', '2')), bytes: 42});
  assert.deepStrictEqual(db.keys(), ['a', 'b']);
  db.close();
});

test('damage in a sealed segment is an error and changes nothing', () => {
  const bad = S('b', '2');
  bad[0] ^= 0xFF;
  const dir = tmp();
  put(dir, {[name(1)]: [H(1), S('a', '1'), bad], [name(2)]: [H(2), S('c', '3'), S('d', '4').subarray(0, 7)], 'compact.tmp': [H(3)]});
  const before = snapshotDir(dir);
  assert.throws(() => openStore(dir), error => error instanceof CorruptionError && error instanceof Error && error.name === 'CorruptionError' &&
    error.message === 'corrupt record in data-000001.log at offset 29');
  assert.deepStrictEqual(snapshotDir(dir), before);
});

test('sealed segment errors', () => {
  const cases = [
    [{[name(1)]: [H(1), S('a', '1'), S('b', '2', 0, true)], [name(2)]: [H(2)]}, 'unterminated batch in data-000001.log at offset 29'],
    [{[name(1)]: [H(1), S('a', '1', 0, true), S('b', '2', 0, true)], [name(2)]: [H(2)]}, 'unterminated batch in data-000001.log at offset 8'],
    [{[name(1)]: [H(1), S('a', '1'), S('b', '2').subarray(0, 20)], [name(2)]: [H(2)]}, 'corrupt record in data-000001.log at offset 29'],
    [{[name(1)]: [H(1), S('a', '1', 0, true), lkvRecord(0x05, 'b', '2')], [name(2)]: [H(2)]}, 'corrupt record in data-000001.log at offset 29'],
    [{[name(3)]: [H(3)], [name(7)]: [H(7), S('a', '1'), S('b', '2'), Buffer.from([1])], [name(9)]: [H(9)]}, 'corrupt record in data-000007.log at offset 50'],
    [{[name(1)]: [lkvHeader(1, 'LKV2')], [name(2)]: [H(3)]}, 'bad header in data-000001.log'],
    [{[name(1)]: [H(1)], [name(2)]: [H(3)]}, 'bad header in data-000002.log'],
    [{[name(1)]: [H(1).subarray(0, 5)], [name(2)]: [H(2)]}, 'bad header in data-000001.log'],
    [{[name(1)]: [H(1)], [name(2)]: [H(2).subarray(0, 4)], [name(3)]: [H(3)]}, 'bad header in data-000002.log'],
    [{[name(1)]: [H(1), S('a', '1')], [name(2)]: [H(2), S('b', '2', 0, true)], [name(3)]: [lkvHeader(3, 'lkv1')]}, 'unterminated batch in data-000002.log at offset 8'],
  ];
  for (const [files, message] of cases) {
    const dir = tmp();
    put(dir, {...files, 'compact.tmp': ['x']});
    const before = snapshotDir(dir);
    assert.throws(() => openStore(dir), error => error instanceof CorruptionError && error.message === message, message);
    assert.deepStrictEqual(snapshotDir(dir), before, message);
  }
});

test('a short last segment and compact.tmp are removed', () => {
  const tail = S('b', '2'.repeat(30)).subarray(0, 30);
  const {dir, db} = recover({[name(1)]: [H(1), S('a', '1'), tail], [name(2)]: ['LKV'], 'compact.tmp': [H(3), S('a', '1')], 'notes.txt': ['keep']});
  assert.deepStrictEqual(db.recovery, {removed: ['compact.tmp', name(2)], truncated: {segment: name(1), offset: 29, bytes: 30}});
  assert.deepStrictEqual(db.segments(), [name(1)]);
  db.set('c', '3');
  db.close();
  assert.deepStrictEqual(listing(dir), [name(1), 'notes.txt']);
  assert.equal(bytes(dir, name(1)), hex([H(1), S('a', '1'), S('c', '3')]));
});

test('an empty only segment is removed and replaced', () => {
  const {dir, db} = recover({[name(4)]: [], 'compact.tmp': []});
  assert.deepStrictEqual(db.recovery, {removed: ['compact.tmp', name(4)], truncated: null});
  assert.deepStrictEqual(db.segments(), [name(1)]);
  db.close();
  assert.deepStrictEqual(listing(dir), [name(1)]);
  assert.equal(bytes(dir, name(1)), hex([H(1)]));
});

test('files that are not segments are left alone', () => {
  const others = {'notes.txt': ['n'], 'data-1.log': [H(1), S('x', '1')], 'data-0000001.log': [H(1), S('x', '1')], 'data-000000.log': [H(0), S('x', '1')],
    'data-000002.log.bak': ['b'], 'data-00000a.log': ['a'], 'data-000003.txt': ['t']};
  const {dir, db} = recover(others);
  assert.deepStrictEqual(db.recovery, {removed: [], truncated: null});
  assert.deepStrictEqual(db.segments(), [name(1)]);
  assert.deepStrictEqual(db.keys(), []);
  db.set('y', '2');
  db.compact();
  db.close();
  assert.deepStrictEqual(listing(dir), [...Object.keys(others), name(2)].sort());
  for (const [file, parts] of Object.entries(others)) assert.equal(bytes(dir, file), hex(parts.map(p => Buffer.from(p))));
});

test('segments are replayed in number order, with gaps', () => {
  const {dir, db} = recover({[name(5)]: [H(5), S('a', '2'), D('b')], [name(2)]: [H(2), S('a', '1'), S('b', '1'), S('c', '1')], [name(10)]: [H(10), S('d', '1')]},
    {maxSegmentBytes: 40});
  assert.deepStrictEqual(db.segments(), [name(2), name(5), name(10)]);
  assert.equal(db.get('a'), '2');
  assert.deepStrictEqual(db.keys(), ['a', 'c', 'd']);
  db.set('e', '1');
  assert.deepStrictEqual(db.segments(), [name(2), name(5), name(10), name(11)]);
  db.close();
  assert.equal(bytes(dir, name(11)), hex([H(11), S('e', '1')]));
});

test('an interrupted compaction recovers the same state', () => {
  const {db} = recover({
    [name(1)]: [H(1), S('a', '1'), S('gone', 'x'), S('old', 'e', 500)],
    [name(2)]: [H(2), S('a', '2'), D('gone')],
    [name(3)]: [H(3), S('a', '2')],
  }, {now: clock(1000)});
  assert.deepStrictEqual(db.keys(), ['a']);
  assert.equal(db.get('a'), '2');
  assert.equal(db.delete('old'), false);
  db.close();
});

test('compaction rewrites live entries into one new segment', () => {
  const dir = tmp();
  put(dir, {'notes.txt': ['keep']});
  const c = clock(100);
  let db = openStore(dir, {now: c, maxSegmentBytes: 120});
  db.set('b', '2');
  db.set('\u{1F600}', 'smile');
  db.set('a', '1', {ttl: 50});
  db.set('\uFF61', 'half');
  db.set('tmp', 'x', {ttl: 10});
  db.set('gone', 'g');
  db.delete('gone');
  db.set('\u00e9', 'e', {ttl: 1000});
  db.batch([{type: 'set', key: 'b', value: '22'}, {type: 'set', key: 'zz', value: 'z'}, {type: 'delete', key: 'zz'}]);
  const old = db.segments();
  assert.ok(old.length >= 3, 'rolled over: ' + old);
  const last = Number(old.at(-1).slice(5, 11));
  c.t = 120;
  assert.deepStrictEqual(db.compact(), {segment: name(last + 1), live: 5, removed: old});
  assert.deepStrictEqual(listing(dir), [name(last + 1), 'notes.txt']);
  assert.deepStrictEqual(db.segments(), [name(last + 1)]);
  assert.equal(bytes(dir, name(last + 1)), hex([H(last + 1), S('a', '1', 150), S('b', '22'), S('\u00e9', 'e', 1100), S('\uFF61', 'half'), S('\u{1F600}', 'smile')]));
  assert.equal(db.delete('tmp'), false);
  assert.equal(db.batch([{type: 'delete', key: 'tmp'}]), 0);
  assert.deepStrictEqual(db.segments(), [name(last + 1)]);
  assert.equal(bytes(dir, name(last + 1)), hex([H(last + 1), S('a', '1', 150), S('b', '22'), S('\u00e9', 'e', 1100), S('\uFF61', 'half'), S('\u{1F600}', 'smile')]));
  db.set('c', '3');
  assert.deepStrictEqual(db.segments(), [name(last + 1), name(last + 2)]);
  db.close();
  db = openStore(dir, {now: c, maxSegmentBytes: 120});
  assert.deepStrictEqual(db.recovery, {removed: [], truncated: null});
  assert.deepStrictEqual(db.keys(), ['a', 'b', 'c', '\u00e9', '\uFF61', '\u{1F600}']);
  c.t = 150;
  assert.deepStrictEqual(db.keys(), ['b', 'c', '\u00e9', '\uFF61', '\u{1F600}']);
  db.close();
});

test('compaction of an empty store', () => {
  const dir = tmp();
  const db = openStore(dir);
  db.set('a', '1');
  db.delete('a');
  assert.deepStrictEqual(db.compact(), {segment: name(2), live: 0, removed: [name(1)]});
  assert.deepStrictEqual(db.compact(), {segment: name(3), live: 0, removed: [name(2)]});
  assert.deepStrictEqual(listing(dir), [name(3)]);
  assert.equal(bytes(dir, name(3)), hex([H(3)]));
  db.set('b', '2');
  db.close();
  assert.equal(bytes(dir, name(3)), hex([H(3), S('b', '2')]));
});

test('20,000 writes take under 3 seconds', () => {
  const dir = tmp();
  const db = openStore(dir);
  const start = performance.now();
  for (let i = 0; i < 20000; i++) {
    db.set('key' + i, 'value' + i);
    if ((i & 1023) === 0 && performance.now() - start > 3000) assert.fail('over 3 seconds after ' + i + ' writes');
  }
  assert.ok(performance.now() - start < 3000, 'took ' + Math.round(performance.now() - start) + ' ms');
  assert.equal(db.get('key19999'), 'value19999');
  db.close();
  let size = 8;
  for (let i = 0; i < 20000; i++) size += 19 + ('key' + i).length + ('value' + i).length;
  assert.equal(fs.statSync(path.join(dir, name(1))).size, size);
});

// Write time must not grow with the store (Performance): twice the writes take at most twice the 3-second budget.
// Under Bun a store rewriting its segment on every write stays just under 3 seconds at 20,000 writes.
test('40,000 writes take under 6 seconds', () => {
  const db = openStore(tmp());
  const start = performance.now();
  for (let i = 0; i < 40000; i++) {
    db.set('key' + i, 'value' + i);
    if ((i & 1023) === 0 && performance.now() - start > 6000) assert.fail('over 6 seconds after ' + i + ' writes');
  }
  assert.ok(performance.now() - start < 6000, 'took ' + Math.round(performance.now() - start) + ' ms');
  assert.equal(db.get('key39999'), 'value39999');
  db.close();
});

test('opening 200,000 records takes under 2 seconds', () => {
  const dir = tmp();
  const first = [H(1)];
  for (let i = 0; i < 150000; i++) first.push(S('k' + (i % 50000), 'v' + i));
  const second = [H(2)];
  for (let i = 0; i < 50000; i++) second.push(i % 2 ? D('k' + i) : S('n' + i, 'w' + i, 0, i % 4 === 0));
  second.push(S('torn', 'x').subarray(0, 12));
  put(dir, {[name(1)]: first, [name(2)]: second});
  const start = performance.now();
  const db = openStore(dir, {now: clock(0)});
  const took = performance.now() - start;
  assert.ok(took < 2000, 'took ' + Math.round(took) + ' ms');
  assert.deepStrictEqual(db.recovery.truncated, {segment: name(2), offset: len(...second) - 12, bytes: 12});
  assert.equal(db.get('k49998'), 'v149998');
  assert.equal(db.get('k49999'), undefined);
  assert.equal(db.get('k1'), undefined);
  assert.equal(db.get('k2'), 'v100002');
  assert.equal(db.get('n49998'), 'w49998');
  assert.equal(db.keys().length, 50000 / 2 + 25000);
  db.close();
});
`;

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies'];
const store = (from, to) => root => {
  if (!REF_STORE.includes(from)) throw new Error('mutation target missing: ' + from);
  writeTree(root, {'src/store.js': REF_STORE.replace(from, to)});
};

export default {
  id: 'logkv-recovery',
  category: 'append-only storage with crash recovery and exact on-disk format',
  prompt: 'The lkv store in src/ only covers the basics: a single segment, no expiry, batches, rollover or compaction, and it cannot recover from a crash. Make it implement docs/STORE.md completely and exactly, including the on-disk format, recovery and compaction. Use only Node built-ins and add no dependencies. Do not modify, delete or rename any existing file under test/ (you may add new test files); `npm test` must pass.',
  setup: root => gitRepo(root, [['lkv: single-segment store', files]]),
  solve: root => writeTree(root, {'src/record.js': REF_RECORD, 'src/segments.js': REF_SEGMENTS, 'src/store.js': REF_STORE}),
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
    // Keys sorted in JavaScript's UTF-16 order.
    store('const byteOrder = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));', 'const byteOrder = (a, b) => (a < b ? -1 : a > b ? 1 : 0);'),
    // A torn batch is cut at the bad record instead of the batch's first record.
    store('return {batches, cut: batch.length ? batchStart : offset};', 'return {batches, cut: offset};'),
    // delete() of a key without an entry still writes a delete record.
    store('} else if (has(op.key)) {', '} else {'),
    // MORE decided by the position among the operations, not among the records written.
    store('i < records.length - 1)));', 'i < ops.length - 1)));'),
    // Rollover when the batch would exactly fill the segment.
    store('this.#size + data.length > this.#max', 'this.#size + data.length >= this.#max'),
    // compact.tmp and a short last segment removed before the segments are checked.
    store("const scans = numbers.map((number, i) => scan(segmentName(number), number, buffers[i], i === numbers.length - 1));\n    for (const name of removed) fs.rmSync(path.join(dir, name), {recursive: true, force: true});",
      "for (const name of removed) fs.rmSync(path.join(dir, name), {recursive: true, force: true});\n    const scans = numbers.map((number, i) => scan(segmentName(number), number, buffers[i], i === numbers.length - 1));"),
    // An entry is still live at its expiry time.
    store('time < entry.expiresAt', 'time <= entry.expiresAt'),
    // Compaction keeps expired entries in memory, so deleting one writes a record.
    store('this.#index = new Map(kept);', ''),
    // Every write rewrites the whole segment.
    store('fs.writeSync(this.#fd, data);', 'const file = this.#path(this.#numbers.at(-1));\n    fs.writeFileSync(file, Buffer.concat([fs.readFileSync(file), data]));'),
    // A visible test edited.
    root => writeTree(root, {'test/store.test.js': VISIBLE.replace("test('keys are sorted'", "test.skip('keys are sorted'")}),
  ],
};
