import {gitRepo, hiddenTests, read, verdict, writeTree} from '../lib.mjs';

// A 3,000+ line generated module with one buggy function in the middle.
const helper = i => `/** Rotate-and-mask codec #${i}. */
export function codec${i}(bytes) {
  const out = new Uint8Array(bytes.length);
  for (let k = 0; k < bytes.length; k++) {
    const value = bytes[k] ^ ${(i * 37) % 256};
    out[k] = ((value << ${i % 7 + 1}) | (value >>> ${7 - (i % 7)})) & 0xff;
  }
  return out;
}

/** Inverse of codec${i}. */
export function decode${i}(bytes) {
  const out = new Uint8Array(bytes.length);
  for (let k = 0; k < bytes.length; k++) {
    const value = bytes[k];
    out[k] = (((value >>> ${i % 7 + 1}) | (value << ${7 - (i % 7)})) & 0xff) ^ ${(i * 37) % 256};
  }
  return out;
}
`;
const BUGGY = `/**
 * CRC-8/SMBUS checksum of a byte array: polynomial 0x07, initial value 0x00,
 * no input/output reflection, final XOR 0x00. The check value for the ASCII
 * bytes of "123456789" is 0xF4.
 */
export function crc8(bytes) {
  let crc = 0xff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x01 ? (crc >>> 1) ^ 0x07 : crc >>> 1;
    }
  }
  return crc & 0xff;
}
`;
const FIXED = BUGGY.replace('let crc = 0xff;', 'let crc = 0x00;')
  .replace('crc = crc & 0x01 ? (crc >>> 1) ^ 0x07 : crc >>> 1;', 'crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;');
const before = Array.from({length: 80}, (_, i) => helper(i)).join('\n');
const after = Array.from({length: 70}, (_, i) => helper(i + 80)).join('\n');
const source = body => `// Generated codec table. Do not reformat.\n\n${before}\n${body}\n${after}`;

export default {
  id: 'big-file',
  category: 'surgical edit in a large file',
  prompt: 'lib/codecs.js exports crc8(bytes), documented in its comment as CRC-8/SMBUS. It returns wrong results. Fix crc8 so it matches its documentation. Do not change anything else in that file.',
  setup: root => gitRepo(root, [['Codec table', {'lib/codecs.js': source(BUGGY), 'package.json': '{"type":"module"}\n'}]]),
  solve: root => writeTree(root, {'lib/codecs.js': source(FIXED)}),
  verify(root) {
    const text = read(root, 'lib/codecs.js').replace(/\r\n/g, '\n');
    const start = text.indexOf('/**\n * CRC-8/SMBUS'), end = text.indexOf('\n}\n', text.indexOf('export function crc8(')) + 3;
    const outside = start > 0 && end > start && text.slice(0, start) === source('').slice(0, start) &&
      text.slice(end) === source(BUGGY).slice(source(BUGGY).indexOf('\n}\n', source(BUGGY).indexOf('export function crc8(')) + 3);
    const hidden = hiddenTests(root, `import test from 'node:test';
import assert from 'node:assert/strict';
const codecs = await import('@ROOT@lib/codecs.js');
const reference = bytes => { let c = 0; for (const b of bytes) { c ^= b; for (let i = 0; i < 8; i++) c = c & 0x80 ? ((c << 1) ^ 7) & 0xff : (c << 1) & 0xff; } return c; };
test('check value', () => assert.equal(codecs.crc8(new TextEncoder().encode('123456789')), 0xf4));
test('random inputs', () => {
  let seed = 7;
  for (let n = 0; n < 200; n++) {
    const bytes = Array.from({length: n % 40}, () => (seed = (seed * 1103515245 + 12345) % 2147483648) & 0xff);
    assert.equal(codecs.crc8(Uint8Array.from(bytes)), reference(bytes));
  }
});
test('other codecs still round-trip', () => {
  const data = Uint8Array.from([0, 1, 2, 250, 255, 128]);
  for (let i = 0; i < 150; i++) assert.deepEqual(codecs['decode' + i](codecs['codec' + i](data)), data);
});`);
    return verdict({rest_of_file_unchanged: outside, crc8_correct: hidden.pass}, {hidden: hidden.output});
  },
};
