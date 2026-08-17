#!/usr/bin/env node
/**
 * Raster Auto's SVG mark to the PNGs a phone needs for the Home Screen.
 *
 * SVG favicons work in the tab; iOS still wants a PNG apple-touch-icon, and
 * Android's install prompt still wants 192 and 512. Geometry is copied from
 * src/web/icon.svg — keep the two in step.
 *
 *   node scripts/raster-icon.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BG = '#0b0d12';
export const RING = '#6ea8ff';
export const PIP = '#4ad07f';
export const CX = 256;
export const CY = 256;
export const RING_R = 156;
export const RING_W = 44;
export const GAP_DEG = 42;
export const CORE_R = 52;
export const PIP_R = 28;
export const PIP_CY = 100;
export const SRC = 512;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'src', 'web');

const HEX = {
  bg: [0x0b, 0x0d, 0x12],
  ring: [0x6e, 0xa8, 0xff],
  coreHi: [0xd7, 0xe7, 0xff],
  pip: [0x4a, 0xd0, 0x7f],
  pipHi: [0xd4, 0xff, 0xe4],
};

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let b = 0; b < 8; b++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(tag, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(tag, 4, 4, 'ascii');
  data.copy(out, 8);
  const crc = crc32(out.subarray(4, 8 + data.length));
  out.writeUInt32BE(crc, 8 + data.length);
  return out;
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    rgba.copy(raw, row + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Coverage of a disc: 1 inside, 0 outside, a 1px ramp on the edge. */
function disc(dx, dy, r) {
  const d = Math.hypot(dx, dy) - r;
  if (d >= 0.5) return 0;
  if (d <= -0.5) return 1;
  return 0.5 - d;
}

function ringCoverage(dx, dy, r, halfW, halfGap) {
  const dist = Math.hypot(dx, dy);
  const radial = Math.abs(dist - r) - halfW;
  let body = radial >= 0.5 ? 0 : radial <= -0.5 ? 1 : 0.5 - radial;
  if (body === 0 || dist < 1e-6) return body;
  const ang = Math.atan2(dy, dx);
  let delta = ang + Math.PI / 2;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  if (Math.abs(delta) >= halfGap) return body;
  return 0;
}

function blend(px, i, rgb, a) {
  if (a <= 0) return;
  if (a > 1) a = 1;
  const ia = 1 - a;
  px[i] = Math.round(rgb[0] * a + px[i] * ia);
  px[i + 1] = Math.round(rgb[1] * a + px[i + 1] * ia);
  px[i + 2] = Math.round(rgb[2] * a + px[i + 2] * ia);
  px[i + 3] = 255;
}

function raster(size) {
  const px = Buffer.alloc(size * size * 4);
  const s = size / SRC;
  const cx = CX * s;
  const cy = CY * s;
  const r = RING_R * s;
  const halfW = (RING_W / 2) * s;
  const halfGap = (GAP_DEG / 2) * (Math.PI / 180);
  const capR = halfW;
  const startA = -Math.PI / 2 + halfGap;
  const endA = -Math.PI / 2 - halfGap;
  const cap1x = cx + r * Math.cos(startA);
  const cap1y = cy + r * Math.sin(startA);
  const cap2x = cx + r * Math.cos(endA);
  const cap2y = cy + r * Math.sin(endA);
  const coreR = CORE_R * s;
  const pipR = PIP_R * s;
  const pipCy = PIP_CY * s;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      px[i] = HEX.bg[0];
      px[i + 1] = HEX.bg[1];
      px[i + 2] = HEX.bg[2];
      px[i + 3] = 255;
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      let a = ringCoverage(dx, dy, r, halfW, halfGap);
      a = Math.max(a, disc(x + 0.5 - cap1x, y + 0.5 - cap1y, capR));
      a = Math.max(a, disc(x + 0.5 - cap2x, y + 0.5 - cap2y, capR));
      blend(px, i, HEX.ring, a);
      blend(px, i, HEX.ring, disc(dx, dy, coreR));
      blend(px, i, HEX.coreHi, 0.35 * disc(x + 0.5 - 238 * s, y + 0.5 - 238 * s, 16 * s));
      blend(px, i, HEX.pip, disc(x + 0.5 - cx, y + 0.5 - pipCy, pipR));
      blend(px, i, HEX.pipHi, 0.45 * disc(x + 0.5 - 248 * s, y + 0.5 - 92 * s, 10 * s));
    }
  }
  return px;
}

const targets = [
  { file: 'apple-touch-icon.png', size: 180 },
  { file: 'icon-192.png', size: 192 },
  { file: 'icon-512.png', size: 512 },
];

for (const t of targets) {
  const buf = encodePng(t.size, t.size, raster(t.size));
  writeFileSync(join(WEB, t.file), buf);
  console.log(`wrote src/web/${t.file} (${t.size}×${t.size}, ${buf.length} bytes)`);
}
