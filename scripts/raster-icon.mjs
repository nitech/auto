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
export const STROKE = '#dfe3ea';
export const DOT = '#6ea8ff';
export const APEX = [256, 132];
export const FOOT_L = [140, 372];
export const FOOT_R = [372, 372];
export const STROKE_W = 68;
export const DOT_C = [256, 356];
export const DOT_R = 32;
export const SRC = 512;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'src', 'web');

const HEX = {
  bg: [0x0b, 0x0d, 0x12],
  stroke: [0xdf, 0xe3, 0xea],
  dot: [0x6e, 0xa8, 0xff],
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

/**
 * Coverage of a round-capped stroke from (x1,y1) to (x2,y2): distance to the
 * segment against half the stroke width, with the same 1px edge ramp. Two
 * capsules sharing an endpoint give the round join at the apex for free.
 */
function capsule(px, py, x1, y1, x2, y2, halfW) {
  const vx = x2 - x1;
  const vy = y2 - y1;
  let t = ((px - x1) * vx + (py - y1) * vy) / (vx * vx + vy * vy);
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const d = Math.hypot(px - (x1 + vx * t), py - (y1 + vy * t)) - halfW;
  if (d >= 0.5) return 0;
  if (d <= -0.5) return 1;
  return 0.5 - d;
}

function raster(size) {
  const px = Buffer.alloc(size * size * 4);
  const s = size / SRC;
  const halfW = (STROKE_W / 2) * s;
  const [ax, ay] = [APEX[0] * s, APEX[1] * s];
  const [lx, ly] = [FOOT_L[0] * s, FOOT_L[1] * s];
  const [rx, ry] = [FOOT_R[0] * s, FOOT_R[1] * s];
  const [dcx, dcy] = [DOT_C[0] * s, DOT_C[1] * s];
  const dotR = DOT_R * s;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      px[i] = HEX.bg[0];
      px[i + 1] = HEX.bg[1];
      px[i + 2] = HEX.bg[2];
      px[i + 3] = 255;
      const sx = x + 0.5;
      const sy = y + 0.5;
      const a = Math.max(
        capsule(sx, sy, ax, ay, lx, ly, halfW),
        capsule(sx, sy, ax, ay, rx, ry, halfW),
      );
      blend(px, i, HEX.stroke, a);
      blend(px, i, HEX.dot, disc(sx - dcx, sy - dcy, dotR));
    }
  }
  return px;
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
