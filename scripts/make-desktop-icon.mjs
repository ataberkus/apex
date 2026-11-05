// Writes desktop/icon.ico: a monogram "A" in the dashboard's rail colours, as PNG-in-ICO from 16 to 256 px. No dependencies.
import {writeFileSync} from 'node:fs';
import {crc32, deflateSync} from 'node:zlib';

const RAIL = [0x1b, 0x1d, 0x33], MARK = [0xb7, 0xae, 0xff];
const SIZES = [16, 24, 32, 48, 64, 128, 256];

// Distances in unit-square coordinates; coverage = how far inside the edge a pixel centre is, in pixels.
const segment = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};
const roundedSquare = (px, py, r) => Math.hypot(Math.max(Math.abs(px - 0.5) - (0.5 - r), 0), Math.max(Math.abs(py - 0.5) - (0.5 - r), 0)) - r;
const coverage = (distance, size) => Math.min(1, Math.max(0, 0.5 - distance * size));

function rows(size) {
  const stride = size * 4 + 1, data = Buffer.alloc(size * stride); // each row starts with PNG filter byte 0
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const px = (x + 0.5) / size, py = (y + 0.5) / size;
    const glyph = Math.min(segment(px, py, 0.5, 0.2, 0.27, 0.8), segment(px, py, 0.5, 0.2, 0.73, 0.8), segment(px, py, 0.36, 0.58, 0.64, 0.58)) - 0.075;
    const ink = coverage(glyph, size), at = y * stride + 1 + x * 4;
    for (let c = 0; c < 3; c++) data[at + c] = Math.round(RAIL[c] + (MARK[c] - RAIL[c]) * ink);
    data[at + 3] = Math.round(coverage(roundedSquare(px, py, 0.22), size) * 255);
  }
  return data;
}

const chunk = (type, body) => {
  const head = Buffer.alloc(8), crc = Buffer.alloc(4);
  head.writeUInt32BE(body.length); head.write(type, 4, 'ascii');
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])));
  return Buffer.concat([head, body, crc]);
};
function png(size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6; // 8-bit RGBA
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows(size))), chunk('IEND', Buffer.alloc(0))]);
}

const images = SIZES.map(png), directory = Buffer.alloc(6 + 16 * SIZES.length);
directory.writeUInt16LE(1, 2); directory.writeUInt16LE(SIZES.length, 4);
let offset = directory.length;
SIZES.forEach((size, i) => {
  const entry = 6 + 16 * i;
  directory[entry] = directory[entry + 1] = size % 256; // 0 means 256
  directory.writeUInt16LE(1, entry + 4); directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(images[i].length, entry + 8); directory.writeUInt32LE(offset, entry + 12);
  offset += images[i].length;
});
writeFileSync(new URL('../desktop/icon.ico', import.meta.url), Buffer.concat([directory, ...images]));
console.log(`desktop/icon.ico: ${SIZES.join(', ')} px`);
