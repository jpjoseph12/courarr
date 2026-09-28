// Renders public/icon.png (the Unraid template icon) from the same geometry as logo.svg,
// using only Node built-ins so it needs no image tooling.
import fs from 'node:fs';
import zlib from 'node:zlib';

const S = 256;
const scale = S / 64;
const C = 32 * scale;
const R = 19 * scale;
const HALF_W = 3.5 * scale;
const CORNER = 14 * scale;
const BG = [0x15, 0x18, 0x21];
const ACCENT = [0xff, 0x7a, 0x93];
const MUTED = [0x8b, 0x93, 0xa7];
// Arcs as [start, end] degrees clockwise from 12 o'clock; the first is highlighted.
const ARCS = [[15, 75], [105, 165], [195, 255], [285, 345]];

const pt = (deg) => {
  const a = (deg * Math.PI) / 180;
  return [C + R * Math.sin(a), C - R * Math.cos(a)];
};

function sample(x, y) {
  // Rounded-square background mask.
  const qx = Math.max(Math.abs(x - S / 2) - (S / 2 - CORNER), 0);
  const qy = Math.max(Math.abs(y - S / 2) - (S / 2 - CORNER), 0);
  if (Math.hypot(qx, qy) > CORNER) return null;

  const d = Math.hypot(x - C, y - C);
  let ang = (Math.atan2(x - C, -(y - C)) * 180) / Math.PI;
  if (ang < 0) ang += 360;
  for (let i = 0; i < ARCS.length; i++) {
    const [a0, a1] = ARCS[i];
    const onRing = Math.abs(d - R) <= HALF_W && ang >= a0 && ang <= a1;
    const cap = [a0, a1].some((a) => {
      const [px, py] = pt(a);
      return Math.hypot(x - px, y - py) <= HALF_W;
    });
    if (onRing || cap) return i === 0 ? ACCENT : MUTED;
  }
  return BG;
}

const SS = 4;
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0; // filter: none
  for (let x = 0; x < S; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const c = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        if (!c) continue;
        r += c[0]; g += c[1]; b += c[2]; a++;
      }
    }
    const o = y * (S * 4 + 1) + 1 + x * 4;
    raw[o] = a ? Math.round(r / a) : 0;
    raw[o + 1] = a ? Math.round(g / a) : 0;
    raw[o + 2] = a ? Math.round(b / a) : 0;
    raw[o + 3] = Math.round((a / (SS * SS)) * 255);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
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

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(new URL('../public/icon.png', import.meta.url), png);
console.log(`wrote public/icon.png (${png.length} bytes)`);
