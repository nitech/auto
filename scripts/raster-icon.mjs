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
export const DOT = '#e5a95a';
export const APEX = [256, 132];
export const FOOT_L = [140, 372];
export const FOOT_R = [372, 372];
export const STROKE_W = 56;
/** Radius of the circular fillet that rounds the inner apex of the A.
 *  Matched to the outer join (half the stroke) so both ends of the chevron read round. */
export const FILLET_R = 28;
/** Dot on the baseline between the feet. */
export const DOT_C = [256, 372];
export const DOT_R = 32;
/** How far the fillet pad overlaps the capsules, to hide the AA seam on the old V. */
export const FILLET_OVERLAP = 2;
export const SRC = 512;
/**
 * Scale the A around the tile centre. 1.0 keeps the old ~80% maskable inset;
 * a bit over 1 fills more of the home-screen / share preview without leaving
 * the maskable safe zone (still clear of the outer 10%).
 */
export const MARK_SCALE = 1.28;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'src', 'web');

const HEX = {
  bg: [0x0b, 0x0d, 0x12],
  stroke: [0xdf, 0xe3, 0xea],
  dot: [0xe5, 0xa9, 0x5a],
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
 * segment against half the stroke width, with the same 1px edge ramp.
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

/** Signed distance to a half-plane: positive on the normal side. */
function halfPlane(px, py, ox, oy, nx, ny) {
  return (px - ox) * nx + (py - oy) * ny;
}

/**
 * Coverage of the circular fillet that rounds the sharp inner apex left by
 * two overlapping capsules. Fills the tip outside the fillet circle. The
 * triangle is expanded by `overlap` into the capsules so AA on the old sharp
 * V does not leave a dark seam.
 */
function fillet(px, py, ax, ay, lx, ly, rx, ry, halfW, filletR, overlap) {
  const vLx = lx - ax;
  const vLy = ly - ay;
  const vRx = rx - ax;
  const vRy = ry - ay;
  const lenL = Math.hypot(vLx, vLy);
  const lenR = Math.hypot(vRx, vRy);
  const uLx = vLx / lenL;
  const uLy = vLy / lenL;
  const uRx = vRx / lenR;
  const uRy = vRy / lenR;
  // Inward normals (into the V / hole).
  const nLx = uLy;
  const nLy = -uLx;
  const nRx = -uRy;
  const nRy = uRx;
  const sinHalf = Math.abs(uLx); // bisector is (0,1); |uL × bisector|
  if (sinHalf < 1e-6) return 0;
  const dC = (halfW + filletR) / sinHalf;
  // Bisector of the two legs, pointing into the angle (down for this A).
  const bx = uLx + uRx;
  const by = uLy + uRy;
  const bLen = Math.hypot(bx, by);
  const cx = ax + (bx / bLen) * dC;
  const cy = ay + (by / bLen) * dC;
  const tipDist = halfW / sinHalf;
  const tipX = ax + (bx / bLen) * tipDist;
  const tipY = ay + (by / bLen) * tipDist;
  const tlX = cx - nLx * filletR;
  const tlY = cy - nLy * filletR;
  const trX = cx - nRx * filletR;
  const trY = cy - nRy * filletR;

  // Inside the sharp-tip triangle (tip, TL, TR): on the tip side of TL→TR,
  // on the right of tip→TL, on the left of tip→TR.
  const e0x = trX - tlX;
  const e0y = trY - tlY;
  const e0len = Math.hypot(e0x, e0y) || 1;
  // Normal of TL→TR pointing toward tip.
  let n0x = -e0y / e0len;
  let n0y = e0x / e0len;
  if (halfPlane(tipX, tipY, tlX, tlY, n0x, n0y) < 0) {
    n0x = -n0x;
    n0y = -n0y;
  }
  const e1x = tlX - tipX;
  const e1y = tlY - tipY;
  const e1len = Math.hypot(e1x, e1y) || 1;
  let n1x = -e1y / e1len;
  let n1y = e1x / e1len;
  if (halfPlane(trX, trY, tipX, tipY, n1x, n1y) < 0) {
    n1x = -n1x;
    n1y = -n1y;
  }
  const e2x = tipX - trX;
  const e2y = tipY - trY;
  const e2len = Math.hypot(e2x, e2y) || 1;
  let n2x = -e2y / e2len;
  let n2y = e2x / e2len;
  if (halfPlane(tlX, tlY, trX, trY, n2x, n2y) < 0) {
    n2x = -n2x;
    n2y = -n2y;
  }

  // Positive on the inside of each edge → depth inside the triangle.
  // Expand by `overlap` so the pad overlaps the capsules and hides the seam.
  const depthTri = Math.min(
    halfPlane(px, py, tlX, tlY, n0x, n0y),
    halfPlane(px, py, tipX, tipY, n1x, n1y),
    halfPlane(px, py, trX, trY, n2x, n2y),
  ) + overlap;
  // Positive outside the fillet circle.
  const outsideCirc = Math.hypot(px - cx, py - cy) - filletR;
  // SDF of (triangle ∩ outside-circle): negative inside the add region.
  const sd = Math.max(-depthTri, -outsideCirc);
  if (sd <= -0.5) return 1;
  if (sd >= 0.5) return 0;
  return 0.5 - sd;
}

function raster(size) {
  const px = Buffer.alloc(size * size * 4);
  const s = (size / SRC) * MARK_SCALE;
  const mid = size / 2;
  const srcMid = SRC / 2;
  const map = (v) => mid + (v - srcMid) * s;
  const halfW = (STROKE_W / 2) * s;
  const filletR = FILLET_R * s;
  const overlap = FILLET_OVERLAP * s;
  const [ax, ay] = [map(APEX[0]), map(APEX[1])];
  const [lx, ly] = [map(FOOT_L[0]), map(FOOT_L[1])];
  const [rx, ry] = [map(FOOT_R[0]), map(FOOT_R[1])];
  const [dcx, dcy] = [map(DOT_C[0]), map(DOT_C[1])];
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
        fillet(sx, sy, ax, ay, lx, ly, rx, ry, halfW, filletR, overlap),
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

/** ICO wrapping a single PNG — every current browser reads that, Safari included. */
function encodeIco(png, size) {
  const dir = Buffer.alloc(22);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(1, 4);
  dir[6] = size >= 256 ? 0 : size;
  dir[7] = size >= 256 ? 0 : size;
  dir.writeUInt16LE(1, 10);
  dir.writeUInt16LE(32, 12);
  dir.writeUInt32LE(png.length, 14);
  dir.writeUInt32LE(dir.length, 18);
  return Buffer.concat([dir, png]);
}

/** 180 for iOS, 192/512 for the Android manifest, 32 inside favicon.ico. */
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

const ico = encodeIco(encodePng(32, 32, raster(32)), 32);
writeFileSync(join(WEB, 'favicon.ico'), ico);
console.log(`wrote src/web/favicon.ico (32×32, ${ico.length} bytes)`);
