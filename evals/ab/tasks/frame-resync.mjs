// @bun
// The pragma makes Bun run this file untranspiled, so functions embedded as source text keep their exact text (the
// transpiler would reprint them). Bun then reads the file as Latin-1: keep it ASCII-only (evals/ab/run.mjs checks).
import {gitRepo, hiddenTests, npm, read, unchanged, verdict, writeTree} from '../lib.mjs';

const SPEC = `# KFP: the Kestrel framing protocol

KFP carries messages for 16 channels over a byte stream, such as a serial line, that may lose, corrupt or insert bytes. \`src/frames.js\` implements both directions and exports exactly these names:

- \`crc16(bytes)\`
- \`encodeMessage(channel, seq, payload, options)\`
- \`encodeReset(channel, seq)\`
- the class \`FrameDecoder\`

## Wire format

### Bytes on the line

Four byte values are special on the line:

- FLAG \`0x7E\` delimits frames.
- ESC \`0x7D\` starts an escape pair.
- XON \`0x11\` and XOFF \`0x13\` are flow-control bytes. The line itself may insert them anywhere in the stream.

A frame travels as its *body* (below) in which every byte that is \`0x7E\`, \`0x7D\`, \`0x11\` or \`0x13\` is replaced by the two bytes ESC, (byte XOR \`0x20\`). So \`0x7E\` travels as \`7D 5E\`, \`0x7D\` as \`7D 5D\`, \`0x11\` as \`7D 31\` and \`0x13\` as \`7D 33\`. No other byte is ever escaped. The escaped form of a body is called its *stuffed* form.

### Frame body

| Field | Size | Content |
|---|---|---|
| type | 1 byte | bit 7 (\`0x80\`) is FIN; bits 4-6 (\`(type >> 4) & 7\`) are the *kind*; bits 0-3 (\`type & 15\`) are the channel, 0 to 15 |
| seq | 1 byte | sequence number, 0 to 255 |
| length | 1 or 2 bytes | the number of payload bytes, see below |
| payload | *length* bytes | |
| crc | 2 bytes | the CRC-16 of all body bytes before it (type, seq, length and payload), most significant byte first |

The length is written as unsigned LEB128 in one or two bytes: a length below 128 is the single byte *length*; a length from 128 to 16383 is the two bytes \`(length & 0x7F) | 0x80\` and \`length >> 7\`. Lengths above 16383 cannot be written.

Kinds: 0 is a data frame, 1 is a reset frame. Kinds 2 to 7 are reserved. A reset frame always has FIN set and an empty payload.

### CRC-16

The checksum is CRC-16/CCITT-FALSE: polynomial \`0x1021\`, initial value \`0xFFFF\`, input and output not reflected, no final XOR. The CRC-16 of the nine ASCII bytes \`123456789\` is \`0x29B1\`; of no bytes at all it is \`0xFFFF\`.

## Encoding

\`crc16(bytes)\` returns the CRC-16 of the bytes of a \`Uint8Array\` as a number.

\`encodeMessage(channel, seq, payload, {maxPayload = 64} = {})\` returns a \`Uint8Array\` that carries one message:

- The payload is cut into fragments of \`maxPayload\` bytes each, in order; the last fragment may be shorter. An empty payload is sent as one fragment with an empty payload. A payload whose length is a multiple of \`maxPayload\` has no empty fragment at the end.
- Fragment *k* (counting from 0) becomes a data frame on \`channel\` with seq \`(seq + k) % 256\`. Only the last fragment has FIN set.
- The result is one FLAG, followed for every fragment by its stuffed body and one FLAG. Nothing else: no XON/XOFF, no extra FLAGs.

\`encodeReset(channel, seq)\` returns one FLAG, the stuffed body of the reset frame for that channel and seq, and one FLAG.

Arguments are checked in parameter order (\`channel\`, \`seq\`, \`payload\`, then \`maxPayload\`); the first problem throws, with \`<value>\` being \`String(value)\` of the offending value:

- \`channel\` must be a number for which \`Number.isInteger\` is true, from 0 to 15, else \`RangeError\` \`invalid channel: <value>\`.
- \`seq\` must be such a number from 0 to 255, else \`RangeError\` \`invalid seq: <value>\`.
- \`payload\` must be a \`Uint8Array\` (a \`Buffer\` is one), else \`TypeError\` \`payload must be a Uint8Array\`.
- \`maxPayload\` must be such a number from 1 to 16383, else \`RangeError\` \`invalid maxPayload: <value>\`. When the options object or its \`maxPayload\` is \`undefined\`, \`maxPayload\` is 64.

## Decoding

\`\`\`js
import {FrameDecoder} from './src/frames.js';
const decoder = new FrameDecoder({maxFrame: 256});
const events = [...decoder.push(chunk1), ...decoder.push(chunk2), ...decoder.end()];
\`\`\`

- \`new FrameDecoder({maxFrame = 256} = {})\`: \`maxFrame\` is the largest accepted body size in bytes (unstuffed). It is a safe integer of at least 5 and is not validated.
- \`push(chunk)\` takes a \`Uint8Array\` of any length, including 0, and returns an array of the events that became available.
- \`end()\` declares that the input is complete and returns an array of the remaining events. \`push()\` and \`end()\` are not called after \`end()\`.
- **Chunk boundaries carry no meaning.** The concatenation of everything returned by \`push()\` and \`end()\` is the same however the input is split into chunks, including between ESC and the byte after it.
- **Events are returned as early as possible.** Every event is returned by the \`push()\` call that delivers the byte that decides it: for \`garbage\` the garbage byte; for \`aborted\`, \`bad escape\` and an escaped byte that is \`too long\`, the byte after the ESC; for an unescaped byte that is \`too long\`, that byte; for messages and for every error found when a frame is closed (see Closing a frame and Channels), the FLAG that closes the frame. Events of \`end()\` are returned by \`end()\`. Events are always returned in input order.
- **Work is proportional to input.** A \`push()\` call does work proportional to the size of its chunk plus the size of the events it returns (amortized), never to the amount of input received earlier. Feeding 4 MiB (4,194,304 bytes) one byte per \`push()\` call must take under 3 seconds in total, with any \`maxFrame\` up to 65536.
- The decoder never modifies a payload after returning it.

### Events

Every event is a plain object with exactly these properties:

- \`{type: 'message', channel, offset, payload}\`: a complete message. \`payload\` is a \`Uint8Array\` (a \`Buffer\` is fine) holding the payloads of its fragments in order; \`offset\` is the start offset (below) of its first fragment's frame.
- \`{type: 'error', offset, message}\`: \`message\` is one of the messages in this document, character for character.

Offsets count the bytes of the whole input stream from 0. Every byte counts, including FLAG, ESC, XON, XOFF and discarded bytes.

### Framing

**XON and XOFF bytes are dropped wherever they appear**: before the first FLAG, inside frames, between ESC and the byte after it, and while hunting. A dropped byte has no effect at all except that it counts for offsets. Everything below ignores them.

The decoder is either *hunting* or *in a frame*, and it starts out hunting.

While hunting, a FLAG ends the hunt and opens a frame; every other byte is discarded. At the start of the input, if the first byte is not a FLAG, the error \`garbage\` is reported at its offset (once; the following bytes are discarded silently up to the first FLAG). Hunting that starts after an error reports nothing more.

In a frame, the bytes after the opening FLAG are read one by one:

- A FLAG closes the frame (see Closing a frame). The same FLAG opens the next frame.
- ESC starts an escape pair, completed by the next byte:
  - \`0x5E\`, \`0x5D\`, \`0x31\` or \`0x33\` gives the body byte (that byte XOR \`0x20\`).
  - A FLAG aborts the frame: the error \`aborted\` is reported at the offset of the ESC, the frame is discarded, and this FLAG opens the next frame.
  - Any other byte, including ESC, is the error \`bad escape\` at the offset of the ESC. The frame is discarded and the decoder hunts; the byte after the ESC is the first discarded byte.
- Any other byte is a body byte as it is.
- When a body byte arrives while the body already holds \`maxFrame\` bytes, the error \`too long\` is reported at the offset of that body byte's first byte on the line (the ESC, if it was escaped). The frame is discarded and the decoder hunts; that body byte is the first discarded byte.

The *start offset* of a frame is the offset of the first byte after its opening FLAG that is not XON or XOFF (it may be an ESC). A frame that is closed before any such byte arrived is *empty*: it is ignored without any event, so FLAGs may follow each other freely.

### Closing a frame

When a FLAG closes a frame that is not empty, its body is checked in this order. The first failed check reports an error at the frame's start offset and discards the frame:

1. A body of fewer than 5 bytes: \`too short\`.
2. The last two bytes are not the CRC-16 of the bytes before them, most significant byte first: \`bad checksum\`.
3. The length field starts at the third body byte. If that byte is below \`0x80\`, it is the length. Otherwise the length field has a second byte, which must lie before the two CRC bytes and must be from \`0x01\` to \`0x7F\` (a second byte \`0x00\` would be an overlong encoding); the length is then \`(first & 0x7F) | (second << 7)\`. A missing or invalid second byte, or a length that differs from the number of bytes between the length field and the CRC, is \`bad length\`.
4. A reserved kind, or a reset frame without FIN or with a non-empty payload: \`bad type\`.

A frame that passes all four checks is *valid* and goes to its channel.

### Channels

Every channel has its own state: the expected seq *E* (initially 0), whether it has accepted a frame yet (initially not), a partial message (initially none), and whether it is skipping (initially not). A valid frame with seq *S* on channel *C* is handled by the first rule that applies:

1. **Duplicate.** If *C* has accepted a frame before and *S* is \`(E + 255) % 256\` (the seq accepted last), the frame is a retransmission and is ignored entirely: no event, no change of state.
2. **Reset.** A reset frame discards the partial message of *C* without any event, stops skipping and sets *E* to \`(S + 1) % 256\`. It never reports a sequence gap.
3. **In sequence.** A data frame with *S* equal to *E* sets *E* to \`(S + 1) % 256\`. If *C* is skipping, the frame is dropped, and if it has FIN, skipping ends. Otherwise its payload is appended to the partial message (a new partial message starts at this frame's start offset), and if it has FIN, the message is complete: it is returned as a message event and the partial message is cleared.
4. **Gap.** A data frame with *S* different from *E* is the error \`sequence gap: channel C expected E got S\` (decimal numbers, for example \`sequence gap: channel 2 expected 1 got 3\`) at the frame's start offset. The partial message of *C* is discarded, *E* becomes \`(S + 1) % 256\`, and the frame is dropped. If the frame does not have FIN, *C* starts skipping: the rest of the interrupted message is dropped up to and including its FIN frame.

After rules 2, 3 and 4, *C* has accepted a frame.

### End of input

\`end()\` returns, in this order:

1. If the decoder is in a frame that is not empty (this includes a frame that ends in a lone ESC), the error \`truncated\` at that frame's start offset. A decoder that is hunting reports nothing here.
2. For every channel that holds a partial message, in ascending channel order, the error \`incomplete message: channel C\` at the offset of that partial message. A channel that is skipping has no partial message.

## Example

\`encodeMessage(1, 0, Buffer.from('hi'))\` is \`7E 81 00 02 68 69 88 E1 7E\`. Decoding the bytes \`41 7E 7E 81 00 02 68 69 88 E1 7E 82 05\` gives:

\`\`\`js
{type: 'error', offset: 0, message: 'garbage'}
{type: 'message', channel: 1, offset: 3, payload: Uint8Array [0x68, 0x69]}  // returned by the push that delivers byte 10
{type: 'error', offset: 11, message: 'truncated'}                           // returned by end()
\`\`\`
`;

const NAIVE = String.raw`/** KFP framing, first version: one frame per message, whole frames per push. See docs/PROTOCOL.md. */
export function crc16(bytes) {
  let crc = 0xFFFF;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc;
}

export function encodeMessage(channel, seq, payload) {
  const body = [0x80 | channel, seq, payload.length, ...payload];
  const crc = crc16(body);
  body.push(crc >> 8, crc & 0xFF);
  const out = [0x7E];
  for (const byte of body) {
    if (byte === 0x7E || byte === 0x7D) out.push(0x7D, byte ^ 0x20);
    else out.push(byte);
  }
  out.push(0x7E);
  return Uint8Array.from(out);
}

export class FrameDecoder {
  #offset = 0;

  push(chunk) {
    const events = [];
    let start = -1;
    let body = [];
    for (let i = 0; i < chunk.length; i++, this.#offset++) {
      const byte = chunk[i];
      if (byte === 0x7E) {
        if (body.length) events.push(this.#frame(body, start));
        body = [];
        start = this.#offset + 1;
      } else if (byte === 0x7D) {
        body.push(chunk[++i] ^ 0x20);
        this.#offset++;
      } else body.push(byte);
    }
    return events;
  }

  end() {
    return [];
  }

  #frame(body, offset) {
    const n = body.length;
    if (crc16(body.slice(0, n - 2)) !== (body[n - 2] << 8 | body[n - 1])) return {type: 'error', offset, message: 'bad checksum'};
    return {type: 'message', channel: body[0] & 15, offset, payload: Uint8Array.from(body.slice(3, n - 2))};
  }
}
`;

const VISIBLE = String.raw`import test from 'node:test';
import assert from 'node:assert/strict';
import {crc16, encodeMessage, FrameDecoder} from '../src/frames.js';

const decode = (...chunks) => {
  const decoder = new FrameDecoder();
  const events = chunks.flatMap(chunk => decoder.push(Uint8Array.from(chunk)));
  return [...events, ...decoder.end()].map(event => event.payload ? {...event, payload: [...event.payload]} : event);
};
const text = s => [...Buffer.from(s)];

test('crc16 check value', () => {
  assert.equal(crc16(Buffer.from('123456789')), 0x29B1);
});

test('encode a short message', () => {
  assert.deepEqual([...encodeMessage(1, 0, Buffer.from('hi'))], [0x7E, 0x81, 0x00, 0x02, 0x68, 0x69, 0x88, 0xE1, 0x7E]);
});

test('decode one frame', () => {
  assert.deepEqual(decode([0x7E, 0x81, 0x00, 0x02, 0x68, 0x69, 0x88, 0xE1, 0x7E]),
    [{type: 'message', channel: 1, offset: 1, payload: text('hi')}]);
});

test('round trip with escaped payload bytes', () => {
  const payload = [0x7E, 0x00, 0x7D, 0xFF];
  assert.deepEqual(decode([...encodeMessage(3, 0, Uint8Array.from(payload))]),
    [{type: 'message', channel: 3, offset: 1, payload}]);
});

test('two messages in one chunk', () => {
  const bytes = [...encodeMessage(0, 0, Buffer.from('a')), ...encodeMessage(0, 1, Buffer.from('b')).subarray(1)];
  assert.deepEqual(decode(bytes).map(event => event.payload), [text('a'), text('b')]);
});

test('a corrupted frame is reported', () => {
  const bytes = [...encodeMessage(2, 0, Buffer.from('hey'))];
  bytes[4] ^= 1;
  assert.deepEqual(decode(bytes), [{type: 'error', offset: 1, message: 'bad checksum'}]);
});
`;

const files = {
  'package.json': JSON.stringify({name: 'kfp-frames', version: '0.3.0', type: 'module', scripts: {test: 'node --test test/*.test.js'}}, null, 2) + '\n',
  'docs/PROTOCOL.md': SPEC,
  'src/frames.js': NAIVE,
  'test/frames.test.js': VISIBLE,
};

const REFERENCE = String.raw`/** KFP framing: encoder and incremental decoder; see docs/PROTOCOL.md. */
const FLAG = 0x7E, ESC = 0x7D, XON = 0x11, XOFF = 0x13;
const SPECIAL = new Set([FLAG, ESC, XON, XOFF]);
const ESCAPED = new Set([0x5E, 0x5D, 0x31, 0x33]);

export function crc16(bytes) {
  let crc = 0xFFFF;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc;
}

const isInt = (value, low, high) => Number.isInteger(value) && value >= low && value <= high;

function checkHeader(channel, seq) {
  if (!isInt(channel, 0, 15)) throw new RangeError('invalid channel: ' + String(channel));
  if (!isInt(seq, 0, 255)) throw new RangeError('invalid seq: ' + String(seq));
}

function writeFrame(out, type, seq, payload) {
  const length = payload.length;
  const body = [type, seq, ...(length < 128 ? [length] : [(length & 0x7F) | 0x80, length >> 7]), ...payload];
  const crc = crc16(body);
  body.push(crc >> 8, crc & 0xFF);
  for (const byte of body) {
    if (SPECIAL.has(byte)) out.push(ESC, byte ^ 0x20);
    else out.push(byte);
  }
  out.push(FLAG);
}

export function encodeMessage(channel, seq, payload, {maxPayload = 64} = {}) {
  checkHeader(channel, seq);
  if (!(payload instanceof Uint8Array)) throw new TypeError('payload must be a Uint8Array');
  if (!isInt(maxPayload, 1, 16383)) throw new RangeError('invalid maxPayload: ' + String(maxPayload));
  const out = [FLAG];
  let k = 0;
  let start = 0;
  do {
    const end = start + maxPayload;
    writeFrame(out, (end >= payload.length ? 0x80 : 0) | channel, (seq + k++) % 256, payload.subarray(start, end));
    start = end;
  } while (start < payload.length);
  return Uint8Array.from(out);
}

export function encodeReset(channel, seq) {
  checkHeader(channel, seq);
  const out = [FLAG];
  writeFrame(out, 0x90 | channel, seq, []);
  return Uint8Array.from(out);
}

export class FrameDecoder {
  #max;
  #body;
  #length = 0;
  #start = -1;
  #escape = -1;
  #offset = 0;
  #hunting = true;
  #begun = false;
  #events = [];
  #channels = Array.from({length: 16}, () => ({expected: 0, accepted: false, parts: null, offset: 0, skipping: false}));

  constructor({maxFrame = 256} = {}) {
    this.#max = maxFrame;
    this.#body = new Uint8Array(maxFrame);
  }

  push(chunk) {
    for (let i = 0; i < chunk.length; i++) this.#byte(chunk[i]);
    return this.#take();
  }

  end() {
    if (!this.#hunting && this.#start >= 0) this.#error(this.#start, 'truncated');
    for (const [channel, state] of this.#channels.entries()) {
      if (state.parts) this.#error(state.offset, 'incomplete message: channel ' + channel);
    }
    return this.#take();
  }

  #take() {
    const events = this.#events;
    this.#events = [];
    return events;
  }

  #error(offset, message) {
    this.#events.push({type: 'error', offset, message});
  }

  #open() {
    this.#hunting = false;
    this.#length = 0;
    this.#start = -1;
    this.#escape = -1;
  }

  #byte(byte) {
    const at = this.#offset++;
    if (byte === XON || byte === XOFF) return;
    if (this.#hunting) {
      if (byte === FLAG) this.#open();
      else if (!this.#begun) this.#error(at, 'garbage');
      this.#begun = true;
      return;
    }
    if (this.#escape >= 0) {
      const escape = this.#escape;
      this.#escape = -1;
      if (byte === FLAG) { this.#error(escape, 'aborted'); this.#open(); }
      else if (!ESCAPED.has(byte)) { this.#error(escape, 'bad escape'); this.#hunting = true; }
      else this.#append(byte ^ 0x20, escape);
      return;
    }
    if (byte === FLAG) { this.#close(); this.#open(); return; }
    if (this.#start < 0) this.#start = at;
    if (byte === ESC) this.#escape = at;
    else this.#append(byte, at);
  }

  #append(value, at) {
    if (this.#length === this.#max) { this.#error(at, 'too long'); this.#hunting = true; return; }
    this.#body[this.#length++] = value;
  }

  #close() {
    const start = this.#start, n = this.#length, body = this.#body;
    if (start < 0) return;
    if (n < 5) return this.#error(start, 'too short');
    if (crc16(body.subarray(0, n - 2)) !== (body[n - 2] << 8 | body[n - 1])) return this.#error(start, 'bad checksum');
    let length = body[2];
    let head = 3;
    if (length >= 0x80) {
      if (n - 2 <= 3 || body[3] === 0 || body[3] >= 0x80) return this.#error(start, 'bad length');
      length = (length & 0x7F) | body[3] << 7;
      head = 4;
    }
    if (length !== n - 2 - head) return this.#error(start, 'bad length');
    const type = body[0], seq = body[1], fin = type >= 0x80, kind = type >> 4 & 7, channel = type & 15;
    if (kind > 1 || (kind === 1 && (!fin || length !== 0))) return this.#error(start, 'bad type');
    const state = this.#channels[channel];
    if (state.accepted && seq === (state.expected + 255) % 256) return;
    state.accepted = true;
    if (kind === 1) {
      state.parts = null;
      state.skipping = false;
      state.expected = (seq + 1) % 256;
      return;
    }
    if (seq !== state.expected) {
      this.#error(start, 'sequence gap: channel ' + channel + ' expected ' + state.expected + ' got ' + seq);
      state.parts = null;
      state.expected = (seq + 1) % 256;
      state.skipping = !fin;
      return;
    }
    state.expected = (seq + 1) % 256;
    if (state.skipping) {
      if (fin) state.skipping = false;
      return;
    }
    if (!state.parts) {
      state.parts = [];
      state.offset = start;
    }
    state.parts.push(body.slice(head, n - 2));
    if (fin) {
      this.#events.push({type: 'message', channel, offset: state.offset, payload: Buffer.concat(state.parts)});
      state.parts = null;
    }
  }
}
`;

// Independent test-side builder: these functions are also copied into the hidden test source.
function kfpCrc(bytes) {
  let crc = 0xFFFF;
  for (const byte of bytes) for (let bit = 7; bit >= 0; bit--) {
    const top = ((crc >> 15) ^ (byte >> bit)) & 1;
    crc = ((crc << 1) & 0xFFFF) ^ (top ? 0x1021 : 0);
  }
  return crc;
}
function kfpBody(type, seq, payload, {length = payload.length, lengthBytes, crcXor = 0} = {}) {
  const field = lengthBytes ?? (length < 128 ? [length] : [(length & 0x7F) | 0x80, length >> 7]);
  const body = [type, seq, ...field, ...payload];
  const crc = kfpCrc(body) ^ crcXor;
  return [...body, crc >> 8, crc & 0xFF];
}
function kfpStuff(body) {
  return body.flatMap(byte => [0x7E, 0x7D, 0x11, 0x13].includes(byte) ? [0x7D, byte ^ 0x20] : [byte]);
}

const bytesOf = value => typeof value === 'string' ? [...Buffer.from(value)] : value;
const hex = value => Buffer.from(bytesOf(value)).toString('hex');
const F = [0x7E];
// Stuffed data frame: channel, seq, payload, fin.
const D = (channel, seq, payload, fin = true, options) => kfpStuff(kfpBody((fin ? 0x80 : 0) | channel, seq, bytesOf(payload), options));
const R = (channel, seq) => kfpStuff(kfpBody(0x90 | channel, seq, []));
const raw = (type, seq, payload, options) => kfpStuff(kfpBody(type, seq, bytesOf(payload), options));
const msg = (channel, offset, payload) => ({type: 'message', channel, offset, payload: hex(payload)});
const err = (offset, message) => ({type: 'error', offset, message});
const gap = (offset, channel, expected, got) => err(offset, `sequence gap: channel ${channel} expected ${expected} got ${got}`);
const withEscXon = bytes => bytes.flatMap(byte => byte === 0x7D ? [0x7D, 0x13] : [byte]);

// A payload byte whose frame has an escaped CRC byte.
const crcEscaped = (() => {
  for (let i = 0; ; i++) {
    const body = kfpBody(0x80, 0, [i & 0xFF, i >> 8]);
    if ([0x7E, 0x7D, 0x11, 0x13].includes(body.at(-1)) && [0x7E, 0x7D, 0x11, 0x13].includes(body.at(-2)) === false) return [i & 0xFF, i >> 8];
  }
})();
const two = Array.from({length: 200}, (_, i) => (i * 7) & 0xFF);

// [name, pieces, maxFrame, (o) => expected]; o(i, d) is the offset of piece i plus d.
const SOURCES = [
  ['single message', [F, D(0, 0, 'hello'), F], undefined, o => [msg(0, o(1), 'hello')]],
  ['repeated flags and empty frames', [F, F, F, D(0, 0, 'a'), F, F, D(0, 1, 'b'), F, F], undefined, o => [msg(0, o(3), 'a'), msg(0, o(6), 'b')]],
  ['escaped bytes in seq and payload', [F, R(3, 0x7C), F, D(3, 0x7D, [0x7E, 0x7D, 0x11, 0x13, 0x20, 0x5E]), F], undefined,
    o => [msg(3, o(3), [0x7E, 0x7D, 0x11, 0x13, 0x20, 0x5E])]],
  ['escaped CRC byte', [F, D(0, 0, crcEscaped), F], undefined, o => [msg(0, o(1), crcEscaped)]],
  ['escaped type bytes', [F, raw(0x11, 0, ''), F, raw(0x7E, 0x13, 'x'), F, R(1, 0x7D), F, D(1, 0x7E, [0x13]), F], undefined,
    o => [err(o(1), 'bad type'), err(o(3), 'bad type'), msg(1, o(7), [0x13])]],
  ['XON and XOFF dropped everywhere', [[0x11, 0x13], F, [0x11], withEscXon(D(1, 0, [0x7E, 0x41, 0x11])), [0x13], F, [0x13], F], undefined,
    o => [msg(1, o(3), [0x7E, 0x41, 0x11])]],
  ['frame of only XON and XOFF is empty', [F, [0x11, 0x13, 0x11], F, D(0, 0, 'x'), F], undefined, o => [msg(0, o(3), 'x')]],
  ['XON between ESC and FLAG still aborts', [F, D(0, 0, 'q').slice(0, 3), [0x7D, 0x11], F, D(0, 0, 'ok'), F], undefined,
    o => [err(o(2), 'aborted'), msg(0, o(4), 'ok')]],
  ['garbage before the first flag', [[0x41, 0x42, 0x7D], F, D(0, 0, 'x'), F], undefined, o => [err(0, 'garbage'), msg(0, o(2), 'x')]],
  ['garbage after XON', [[0x11, 0x13, 0x41], F, D(0, 0, 'x'), F], undefined, o => [err(2, 'garbage'), msg(0, o(2), 'x')]],
  ['only garbage', [[1, 2, 3, 0x7D]], undefined, () => [err(0, 'garbage')]],
  ['no garbage after a leading flag', [F, F], undefined, () => []],
  ['aborted frame', [F, D(0, 0, 'abc').slice(0, 4), [0x7D], F, D(0, 0, 'ok'), F], undefined, o => [err(o(2), 'aborted'), msg(0, o(4), 'ok')]],
  ['abort right after a flag', [F, [0x7D], F, D(0, 0, 'ok'), F], undefined, o => [err(o(1), 'aborted'), msg(0, o(3), 'ok')]],
  ['bad escape hunts silently to the next flag', [F, [0x80, 0x00], [0x7D, 0x41], [0x01, 0x7D, 0x7D, 0x02], F, D(0, 0, 'ok'), F], undefined,
    o => [err(o(2), 'bad escape'), msg(0, o(5), 'ok')]],
  ['ESC ESC is a bad escape', [F, [0x7D, 0x7D, 0x5E], F, D(0, 0, 'ok'), F], undefined, o => [err(o(1), 'bad escape'), msg(0, o(3), 'ok')]],
  ['bad escape then flag right after', [F, [0x7D, 0x00], F, D(0, 0, 'ok'), F], undefined, o => [err(o(1), 'bad escape'), msg(0, o(3), 'ok')]],
  ['too long', [F, D(0, 0, 'abcd'), F, D(0, 0, 'abc'), F], 8, o => [err(o(1, 8), 'too long'), msg(0, o(3), 'abc')]],
  ['too long on an escaped byte', [F, D(0, 0, [0x61, 0x62, 0x63, 0x64, 0x65, 0x7E]), F, D(0, 0, 'abc'), F], 8,
    o => [err(o(1, 8), 'too long'), msg(0, o(3), 'abc')]],
  ['frame of exactly maxFrame bytes', [F, D(0, 0, 'abcdefghij'), F], 15, o => [msg(0, o(1), 'abcdefghij')]],
  ['too short', [F, [0x80, 0x00, 0x00, 0x12], F, [0x41], F, D(0, 0, ''), F], undefined,
    o => [err(o(1), 'too short'), err(o(3), 'too short'), msg(0, o(5), '')]],
  ['bad checksum', [F, D(0, 0, 'abc', true, {crcXor: 0x0100}), F, D(0, 0, 'ok'), F], undefined, o => [err(o(1), 'bad checksum'), msg(0, o(3), 'ok')]],
  ['bad checksum is checked before the length', [F, D(0, 0, 'abc', true, {length: 9, crcXor: 1}), F], undefined, o => [err(o(1), 'bad checksum')]],
  ['declared length differs', [F, D(0, 0, 'abc', true, {length: 2}), F, D(0, 0, 'ab', true, {length: 3}), F], undefined,
    o => [err(o(1), 'bad length'), err(o(3), 'bad length')]],
  ['two-byte length', [F, D(5, 0, two), F], undefined, o => [msg(5, o(1), two)]],
  ['overlong two-byte length', [F, D(0, 0, 'abcde', true, {lengthBytes: [0x85, 0x00]}), F], undefined, o => [err(o(1), 'bad length')]],
  ['second length byte with continuation bit', [F, D(0, 0, 'abc', true, {lengthBytes: [0x83, 0x80]}), F], undefined, o => [err(o(1), 'bad length')]],
  ['length field running into the CRC', [F, raw(0x80, 0, [], {lengthBytes: [0x81]}), F], undefined, o => [err(o(1), 'bad length')]],
  ['reserved kind', [F, raw(0xA0, 0, 'x'), F, raw(0xF3, 0, ''), F], undefined, o => [err(o(1), 'bad type'), err(o(3), 'bad type')]],
  ['bad length is checked before the type', [F, raw(0xA0, 0, 'xy', {length: 1}), F], undefined, o => [err(o(1), 'bad length')]],
  ['reset frames without FIN or with payload', [F, raw(0x10, 7, ''), F, raw(0x91, 7, 'x'), F, D(1, 0, 'ok'), F], undefined,
    o => [err(o(1), 'bad type'), err(o(3), 'bad type'), msg(1, o(5), 'ok')]],
  ['fragmented message', [F, D(1, 0, 'he', false), F, D(1, 1, 'll', false), F, D(1, 2, 'o'), F], undefined, o => [msg(1, o(1), 'hello')]],
  ['interleaved channels', [F, D(1, 0, 'ab', false), F, D(2, 0, 'xy'), F, D(1, 1, 'cd'), F, D(2, 1, 'z', false), F], undefined,
    o => [msg(2, o(3), 'xy'), msg(1, o(1), 'abcd'), err(o(7), 'incomplete message: channel 2')]],
  ['duplicates are ignored', [F, D(0, 0, 'a'), F, D(0, 0, 'a'), F, D(0, 1, 'x', false), F, D(0, 1, 'x', false), F, D(0, 2, 'y'), F, D(0, 2, 'y'), F], undefined,
    o => [msg(0, o(1), 'a'), msg(0, o(5), 'xy')]],
  ['first frame with seq 255 is a gap', [F, D(0, 255, 'a'), F, D(0, 0, 'b'), F], undefined, o => [gap(o(1), 0, 0, 255), msg(0, o(3), 'b')]],
  ['a gap discards the partial message and skips to its FIN', [F, D(2, 0, 'a', false), F, D(2, 2, 'c', false), F, D(2, 3, 'd', false), F, D(2, 4, 'e'), F, D(2, 5, 'ok'), F], undefined,
    o => [gap(o(3), 2, 1, 2), msg(2, o(9), 'ok')]],
  ['a gap on a FIN frame does not skip', [F, D(0, 0, 'a'), F, D(0, 5, 'b'), F, D(0, 6, 'c'), F], undefined,
    o => [msg(0, o(1), 'a'), gap(o(3), 0, 1, 5), msg(0, o(5), 'c')]],
  ['a corrupted frame leads to a gap', [F, D(0, 0, 'a'), F, D(0, 1, 'b', true, {crcXor: 0x40}), F, D(0, 2, 'c'), F, D(0, 3, 'd'), F], undefined,
    o => [msg(0, o(1), 'a'), err(o(3), 'bad checksum'), gap(o(5), 0, 1, 2), msg(0, o(7), 'd')]],
  ['reset discards a partial message silently', [F, D(4, 0, 'p', false), F, R(4, 9), F, D(4, 10, 'q'), F], undefined, o => [msg(4, o(5), 'q')]],
  ['reset ends skipping', [F, D(4, 3, 'p', false), F, D(4, 4, 'lost', false), F, R(4, 200), F, D(4, 201, 'q'), F], undefined,
    o => [gap(o(1), 4, 0, 3), msg(4, o(7), 'q')]],
  ['reset with seq 255 first and a duplicate reset', [F, R(6, 255), F, R(6, 255), F, D(6, 0, 'z'), F], undefined, o => [msg(6, o(5), 'z')]],
  ['sequence numbers wrap', [F, R(5, 254), F, D(5, 255, 'x', false), F, D(5, 0, 'y'), F, D(5, 1, 'w'), F], undefined,
    o => [msg(5, o(3), 'xy'), msg(5, o(7), 'w')]],
  ['truncated frame at the end', [F, D(0, 0, 'a'), F, D(0, 1, 'bc').slice(0, 3)], undefined, o => [msg(0, o(1), 'a'), err(o(3), 'truncated')]],
  ['input ending in a lone ESC', [F, [0x7D]], undefined, o => [err(o(1), 'truncated')]],
  ['input ending after a flag and XON', [F, D(0, 0, 'a'), F, [0x11]], undefined, o => [msg(0, o(1), 'a')]],
  ['hunting at the end reports nothing', [F, [0x7D, 0x00, 0x41]], undefined, o => [err(o(1), 'bad escape')]],
  ['incomplete messages in channel order', [F, D(9, 0, 'a', false), F, D(3, 0, 'b', false), F, D(7, 0, 'c', false), F, D(7, 1, 'd'), F, [0x11, 0x80, 0x00]], undefined,
    o => [msg(7, o(5), 'cd'), err(o(9, 1), 'truncated'), err(o(3), 'incomplete message: channel 3'), err(o(1), 'incomplete message: channel 9')]],
  ['a skipping channel is not incomplete', [F, D(8, 1, 'a', false), F], undefined, o => [gap(o(1), 8, 0, 1)]],
];

const CASES = SOURCES.map(([name, pieces, maxFrame, expect]) => {
  const starts = [];
  let total = 0;
  for (const piece of pieces) { starts.push(total); total += piece.length; }
  return [name, pieces.flat(), maxFrame ?? null, expect((i, d = 0) => starts[i] + d)];
});

const HIDDEN = String.raw`import test from 'node:test';
import assert from 'node:assert/strict';
const {crc16, encodeMessage, encodeReset, FrameDecoder} = await import('@ROOT@src/frames.js');
${kfpCrc}
${kfpBody}
${kfpStuff}

const norm = event => {
  if (event.type !== 'message') return event;
  assert.ok(event.payload instanceof Uint8Array, 'payload is a Uint8Array');
  return {...event, payload: Buffer.from(event.payload).toString('hex')};
};
const feed = (chunks, maxFrame) => {
  const decoder = new FrameDecoder(maxFrame === null ? undefined : {maxFrame});
  const out = [];
  for (const chunk of chunks) out.push(...decoder.push(chunk));
  out.push(...decoder.end());
  return out.map(norm);
};

for (const [name, bytes, maxFrame, expected] of ${JSON.stringify(CASES)}) {
  const input = Uint8Array.from(bytes);
  test(name, () => assert.deepStrictEqual(feed([input], maxFrame), expected));
  test(name + ' (any chunking)', () => {
    for (let p = 0; p <= input.length; p++) {
      assert.deepStrictEqual(feed([input.slice(0, p), new Uint8Array(0), input.slice(p)], maxFrame), expected, 'split at byte ' + p);
    }
    assert.deepStrictEqual(feed([...input].map(b => Uint8Array.of(b)), maxFrame), expected, 'one byte per push');
    if (input.length <= 40) {
      for (let p = 1; p < input.length; p++) for (let q = p + 1; q < input.length; q++) {
        assert.deepStrictEqual(feed([input.slice(0, p), input.slice(p, q), input.slice(q)], maxFrame), expected, 'split at bytes ' + p + ' and ' + q);
      }
    }
  });
}

test('events are returned by the push that delivers the deciding byte', () => {
  const d = new FrameDecoder({maxFrame: 8});
  const push = bytes => d.push(Uint8Array.from(bytes)).map(norm);
  const frame = kfpStuff(kfpBody(0x80, 0, [0x41]));
  assert.deepStrictEqual(push([0x41]), [{type: 'error', offset: 0, message: 'garbage'}]);
  assert.deepStrictEqual(push([0x42, 0x7E, ...frame]), []);
  assert.deepStrictEqual(push([0x7E, 0x7D]), [{type: 'message', channel: 0, offset: 3, payload: '41'}]);
  assert.deepStrictEqual(push([0x11]), []);
  assert.deepStrictEqual(push([0x7E]), [{type: 'error', offset: 10, message: 'aborted'}]);
  assert.deepStrictEqual(push([0x7D]), []);
  assert.deepStrictEqual(push([0x22]), [{type: 'error', offset: 13, message: 'bad escape'}]);
  assert.deepStrictEqual(push([0x7E, 1, 2, 3, 4, 5, 6, 7, 8, 0x7D]), []);
  assert.deepStrictEqual(push([0x5E]), [{type: 'error', offset: 24, message: 'too long'}]);
  assert.deepStrictEqual(push([0x7E, 1, 2, 3, 4, 5, 6, 7, 8]), []);
  assert.deepStrictEqual(push([9]), [{type: 'error', offset: 35, message: 'too long'}]);
  assert.deepStrictEqual(push([0x7E, ...kfpStuff(kfpBody(0x01, 0, [0x43]))]), []);
  assert.deepStrictEqual(push([0x7E]), []);
  assert.deepStrictEqual(push([0x55]), []);
  assert.deepStrictEqual(d.end(), [{type: 'error', offset: 44, message: 'truncated'}, {type: 'error', offset: 37, message: 'incomplete message: channel 1'}]);
});

test('payloads are not modified after they are returned', () => {
  const d = new FrameDecoder();
  const first = d.push(encodeMessage(0, 0, Buffer.from('first')))[0].payload;
  d.push(encodeMessage(0, 1, Buffer.from('later')));
  d.push(Uint8Array.from([0x7E, 9, 9, 9, 9, 9, 9, 9]));
  assert.equal(Buffer.from(first).toString(), 'first');
});

test('crc16', () => {
  assert.equal(crc16(Buffer.from('123456789')), 0x29B1);
  assert.equal(crc16(new Uint8Array(0)), 0xFFFF);
  const sample = Uint8Array.from({length: 300}, (_, i) => (i * 31 + 7) & 0xFF);
  assert.equal(crc16(sample), kfpCrc(sample));
});

const frames = (...bodies) => [0x7E, ...bodies.flatMap(body => [...kfpStuff(body), 0x7E])];
const enc = (...args) => [...encodeMessage(...args)];
const seqBytes = n => Uint8Array.from({length: n}, (_, i) => (i * 37 + 11) & 0xFF);

test('encodeMessage output', () => {
  assert.ok(encodeMessage(0, 0, new Uint8Array(0)) instanceof Uint8Array);
  assert.deepStrictEqual(enc(0, 0, new Uint8Array(0)), frames(kfpBody(0x80, 0, [])));
  assert.deepStrictEqual(enc(2, 9, Buffer.from('abcdefgh'), {maxPayload: 3}),
    frames(kfpBody(0x02, 9, [...Buffer.from('abc')]), kfpBody(0x02, 10, [...Buffer.from('def')]), kfpBody(0x82, 11, [...Buffer.from('gh')])));
  assert.deepStrictEqual(enc(2, 0, Buffer.from('abcdef'), {maxPayload: 3}),
    frames(kfpBody(0x02, 0, [...Buffer.from('abc')]), kfpBody(0x82, 1, [...Buffer.from('def')])));
  assert.deepStrictEqual(enc(15, 254, Uint8Array.of(1, 2, 3), {maxPayload: 1}),
    frames(kfpBody(0x0F, 254, [1]), kfpBody(0x0F, 255, [2]), kfpBody(0x8F, 0, [3])));
  assert.deepStrictEqual(enc(14, 0x7E, Uint8Array.of(0x7E, 0x7D, 0x11, 0x13, 0x5E)), frames(kfpBody(0x8E, 0x7E, [0x7E, 0x7D, 0x11, 0x13, 0x5E])));
  assert.deepStrictEqual(enc(1, 0x13, Uint8Array.of(0x7D)), frames(kfpBody(0x81, 0x13, [0x7D])));
  const big = seqBytes(200);
  assert.deepStrictEqual(enc(3, 0, big, {maxPayload: 16383}), frames(kfpBody(0x83, 0, [...big])));
  const mid = seqBytes(130);
  assert.deepStrictEqual(enc(4, 1, mid), frames(kfpBody(0x04, 1, [...mid.subarray(0, 64)]), kfpBody(0x04, 2, [...mid.subarray(64, 128)]), kfpBody(0x84, 3, [...mid.subarray(128)])));
  assert.deepStrictEqual(enc(4, 1, mid, {}), enc(4, 1, mid));
  assert.deepStrictEqual(enc(4, 1, mid, {maxPayload: undefined}), enc(4, 1, mid));
  assert.deepStrictEqual(enc(0, 3.0, Buffer.from('z'), {maxPayload: 16383}), frames(kfpBody(0x80, 3, [0x7A])));
});

test('escaping of every special byte in every position', () => {
  for (let i = 0; i < 2000; i++) {
    const payload = Uint8Array.of(i & 0xFF, (i * 7) & 0xFF, 0x11);
    assert.deepStrictEqual(enc(i % 16, (i * 3) % 256, payload), frames(kfpBody(0x80 | i % 16, (i * 3) % 256, [...payload])));
  }
});

test('encodeReset output', () => {
  assert.deepStrictEqual([...encodeReset(7, 0x13)], frames(kfpBody(0x97, 0x13, [])));
  assert.deepStrictEqual([...encodeReset(0, 255)], frames(kfpBody(0x90, 255, [])));
});

const throwsWith = (fn, type, message) => assert.throws(fn, error => error instanceof type && error.message === message, message);
test('argument errors and their order', () => {
  const p = Uint8Array.of(1);
  throwsWith(() => encodeMessage(16, 0, p), RangeError, 'invalid channel: 16');
  throwsWith(() => encodeMessage(-1, 999, null, {maxPayload: 0}), RangeError, 'invalid channel: -1');
  throwsWith(() => encodeMessage('1', 0, p), RangeError, 'invalid channel: 1');
  throwsWith(() => encodeMessage(1.5, 0, p), RangeError, 'invalid channel: 1.5');
  throwsWith(() => encodeMessage(undefined, 0, p), RangeError, 'invalid channel: undefined');
  throwsWith(() => encodeMessage(0, 256, p), RangeError, 'invalid seq: 256');
  throwsWith(() => encodeMessage(0, NaN, [1], {maxPayload: 0}), RangeError, 'invalid seq: NaN');
  throwsWith(() => encodeMessage(0, 0, [1, 2], {maxPayload: 0}), TypeError, 'payload must be a Uint8Array');
  throwsWith(() => encodeMessage(0, 0, 'text'), TypeError, 'payload must be a Uint8Array');
  throwsWith(() => encodeMessage(0, 0, new Uint16Array(2)), TypeError, 'payload must be a Uint8Array');
  throwsWith(() => encodeMessage(0, 0, p, {maxPayload: 0}), RangeError, 'invalid maxPayload: 0');
  throwsWith(() => encodeMessage(0, 0, p, {maxPayload: 16384}), RangeError, 'invalid maxPayload: 16384');
  throwsWith(() => encodeMessage(0, 0, p, {maxPayload: null}), RangeError, 'invalid maxPayload: null');
  throwsWith(() => encodeMessage(0, 0, p, {maxPayload: '8'}), RangeError, 'invalid maxPayload: 8');
  throwsWith(() => encodeReset(99, -5), RangeError, 'invalid channel: 99');
  throwsWith(() => encodeReset(0, -5), RangeError, 'invalid seq: -5');
});

test('round trip of many messages through arbitrary chunks', () => {
  let seed = 12345;
  const rand = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const seqs = new Array(16).fill(0);
  const parts = [];
  const expected = [];
  let offset = 0;
  for (let i = 0; i < 300; i++) {
    const channel = rand(16);
    const payload = Uint8Array.from({length: rand(300)}, () => [0x7E, 0x7D, 0x11, 0x13][rand(8)] ?? rand(256));
    const maxPayload = 1 + rand(100);
    const bytes = encodeMessage(channel, seqs[channel], payload, {maxPayload});
    seqs[channel] = (seqs[channel] + Math.max(1, Math.ceil(payload.length / maxPayload))) % 256;
    expected.push({type: 'message', channel, offset: offset + 1, payload: Buffer.from(payload).toString('hex')});
    parts.push(bytes);
    offset += bytes.length;
  }
  const all = Buffer.concat(parts);
  const chunks = [];
  for (let at = 0; at < all.length;) { const size = rand(50); chunks.push(all.subarray(at, at + size)); at += size; }
  assert.deepStrictEqual(feed(chunks, null), expected);
});

const MiB = 4194304; // the 4 MiB of the spec
const timed = (name, input, maxFrame, check) => test('4 MiB one byte per push: ' + name, () => {
  assert.ok(input.length <= MiB && input.length > MiB - 70000, 'input size ' + input.length);
  const decoder = new FrameDecoder({maxFrame});
  const events = [];
  const start = performance.now();
  for (let i = 0; i < input.length; i++) {
    for (const event of decoder.push(input.subarray(i, i + 1))) events.push(event);
    if ((i & 4095) === 0 && performance.now() - start > 3000) assert.fail('over 3 seconds after ' + i + ' of ' + input.length + ' bytes');
  }
  events.push(...decoder.end());
  assert.ok(performance.now() - start < 3000, 'took ' + Math.round(performance.now() - start) + ' ms');
  check(events);
});

// Frames until the next one would not fit in MiB - reserve bytes; starts[i] is frame i's start offset.
const build = (frame, reserve = 0) => {
  const out = [0x7E];
  const starts = [];
  for (let i = 0; ; i++) {
    const bytes = kfpStuff(frame(i));
    if (out.length + bytes.length + 1 > MiB - reserve) return {out, starts};
    starts.push(out.length);
    for (const byte of bytes) out.push(byte);
    out.push(0x7E);
  }
};
{
  const unit = Array.from({length: 20}, (_, i) => i * 13 & 0xFF);
  const {out, starts} = build(i => kfpBody(0x80 | i % 16, Math.floor(i / 16) % 256, unit));
  const count = starts.length;
  timed('many small messages', Uint8Array.from(out), 256, events => {
    assert.equal(events.length, count);
    assert.deepStrictEqual(norm(events.at(-1)), {type: 'message', channel: (count - 1) % 16, offset: starts.at(-1), payload: Buffer.from(unit).toString('hex')});
  });
}
{
  const piece = [0x20, 0x41, 0x62, 0x7F];
  const {out, starts} = build(i => kfpBody(0x01, i % 256, piece), 16);
  const count = starts.length;
  out.push(...kfpStuff(kfpBody(0x81, count % 256, [])), 0x7E);
  timed('one message of many fragments', Uint8Array.from(out), 256, events => {
    assert.equal(events.length, 1);
    assert.equal(events[0].offset, 1);
    assert.equal(events[0].payload.length, count * 4);
    assert.equal(Buffer.from(events[0].payload.subarray(-4)).toString('hex'), Buffer.from(piece).toString('hex'));
  });
}
{
  const piece = Array.from({length: 16383}, (_, i) => 0x20 + i % 90);
  const {out, starts} = build(i => kfpBody(0x82, i, piece));
  timed('large frames', Uint8Array.from(out), 65536, events => {
    assert.equal(events.length, starts.length);
    assert.ok(events.every((event, i) => event.type === 'message' && event.offset === starts[i] && event.payload.length === 16383));
  });
}
`;

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies'];

export default {
  id: 'frame-resync',
  category: 'binary framing with escapes, checksums and resynchronization',
  prompt: 'src/frames.js only handles whole, well-formed KFP frames delivered in one chunk. Make it implement the KFP protocol specified in docs/PROTOCOL.md completely and exactly: the encoder, and the decoder for any way the input is split into chunks. Use only Node built-ins and add no dependencies. Do not modify, delete or rename any existing file under test/ (you may add new test files); `npm test` must pass.',
  setup: root => gitRepo(root, [['KFP frames: first version', files]]),
  solve: root => writeTree(root, {'src/frames.js': REFERENCE}),
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
    // XON/XOFF dropped except right after an ESC.
    root => writeTree(root, {'src/frames.js': REFERENCE.replace('if (byte === XON || byte === XOFF) return;', 'if ((byte === XON || byte === XOFF) && this.#escape < 0) return;')}),
    // CRC bytes appended after stuffing, so they are never escaped.
    root => writeTree(root, {'src/frames.js': REFERENCE.replace('body.push(crc >> 8, crc & 0xFF);\n  for (const byte of body) {\n    if (SPECIAL.has(byte)) out.push(ESC, byte ^ 0x20);\n    else out.push(byte);\n  }',
      'for (const byte of body) {\n    if (SPECIAL.has(byte)) out.push(ESC, byte ^ 0x20);\n    else out.push(byte);\n  }\n  out.push(crc >> 8, crc & 0xFF);')}),
    // A multiple of maxPayload gets an empty FIN fragment at the end.
    root => writeTree(root, {'src/frames.js': REFERENCE.replace('(end >= payload.length ? 0x80 : 0)', '(end > payload.length ? 0x80 : 0)').replace('} while (start < payload.length);', '} while (start <= payload.length);')}),
    // Duplicate detection without the "accepted a frame" condition.
    root => writeTree(root, {'src/frames.js': REFERENCE.replace('if (state.accepted && seq ===', 'if (seq ===')}),
    // A gap does not skip the rest of the interrupted message.
    root => writeTree(root, {'src/frames.js': REFERENCE.replace('state.skipping = !fin;', 'state.skipping = false;')}),
    // An abort makes the decoder hunt instead of opening the next frame.
    root => writeTree(root, {'src/frames.js': REFERENCE.replace("this.#error(escape, 'aborted'); this.#open();", "this.#error(escape, 'aborted'); this.#hunting = true;")}),
    // Fragments re-concatenated on every frame: quadratic.
    root => writeTree(root, {'src/frames.js': REFERENCE.replace('state.parts.push(body.slice(head, n - 2));', 'state.parts = [Buffer.concat([...state.parts, body.slice(head, n - 2)])];')}),
    // Incomplete messages not reported after a truncated frame.
    root => writeTree(root, {'src/frames.js': REFERENCE.replace("if (!this.#hunting && this.#start >= 0) this.#error(this.#start, 'truncated');", "if (!this.#hunting && this.#start >= 0) return [...this.#take(), {type: 'error', offset: this.#start, message: 'truncated'}];")}),
    // A visible test edited.
    root => writeTree(root, {'test/frames.test.js': VISIBLE.replace("test('a corrupted frame is reported'", "test.skip('a corrupted frame is reported'")}),
  ],
};
