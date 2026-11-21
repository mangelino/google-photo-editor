// Writes src/icons/icon{16,32,48,128}.png: a blue rounded square with a 2x2 grid of
// white tiles, one of them "selected". Uses only Node built-ins.

import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'icons');
mkdirSync(out, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5, size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

const BLUE = [26, 115, 232, 255];
const WHITE = [255, 255, 255, 255];
const LIGHT = [174, 203, 250, 255];
const CLEAR = [0, 0, 0, 0];

function pixel(x, y, s) {
  const u = x / s;
  const v = y / s;
  if (!inRoundRect(u, v, 0.02, 0.02, 0.98, 0.98, 0.2)) return CLEAR;
  const tiles = [[0.2, 0.2], [0.53, 0.2], [0.2, 0.53], [0.53, 0.53]];
  for (const [i, [tx, ty]] of tiles.entries()) {
    if (inRoundRect(u, v, tx, ty, tx + 0.27, ty + 0.27, 0.05)) return i === 3 ? LIGHT : WHITE;
  }
  return BLUE;
}

for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(out, `icon${size}.png`), png(size, pixel));
}
console.log(`Icons written to ${out}`);
