#!/usr/bin/env node
/**
 * Validate the theory on a session we already know the answer for: in the ACP
 * store, meta names `latestRootBlobId`. If the root is also the one blob no
 * other blob points at, the same rule can find the head of an IDE chat.
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';

/** Every 32-byte length-delimited field in a protobuf-ish blob. */
function childRefs(buf) {
  const out = [];
  let off = 0;
  while (off < buf.length) {
    const tag = buf[off];
    if ((tag & 0x07) !== 2) break;
    off += 1;
    let len = 0;
    let shift = 0;
    let ok = false;
    while (off < buf.length) {
      const b = buf[off++];
      len |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) {
        ok = true;
        break;
      }
      shift += 7;
    }
    if (!ok || off + len > buf.length) break;
    if (len === 32) out.push(buf.subarray(off, off + len).toString('hex'));
    off += len;
  }
  return out;
}

// --- 1. A known ACP session -------------------------------------------------
const base = join(homedir(), '.cursor', 'acp-sessions');
const acpId = readdirSync(base).find((d) => d.startsWith('18349d4a')) || readdirSync(base)[0];
const acp = new DatabaseSync(join(base, acpId, 'store.db'), { readOnly: true });
const meta = JSON.parse(
  Buffer.from(acp.prepare("SELECT value FROM meta WHERE key='0'").get().value, 'hex').toString(),
);
console.log(`ACP session ${acpId}`);
console.log(`  meta root: ${meta.latestRootBlobId}`);
console.log(`  key format: ${meta.blobEncryptionKey.length} chars (hex)`);

const blobs = acp.prepare('SELECT id, data FROM blobs').all();
const ids = new Set(blobs.map((b) => b.id));
const referenced = new Set();
for (const b of blobs) for (const c of childRefs(Buffer.from(b.data))) referenced.add(c);
const roots = [...ids].filter((i) => !referenced.has(i));
console.log(`  ${blobs.length} blobs, ${roots.length} unreferenced`);
console.log(`  unreferenced === meta root? ${roots.length === 1 && roots[0] === meta.latestRootBlobId}`);
acp.close();

// --- 2. The same rule against an IDE chat -----------------------------------
const ide = new DatabaseSync(
  join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
    'Cursor', 'User', 'globalStorage', 'state.vscdb'),
  { readOnly: true },
);
const get = ide.prepare('SELECT value FROM cursorDiskKV WHERE key = ?');
const text = (v) => (Buffer.isBuffer(v) ? v : Buffer.from(v)).toString('utf8');

const chatId = process.argv[2] || '4e9abaeb-7716-4f4d-a976-18ec10061759';
const data = JSON.parse(text(get.get(`composerData:${chatId}`).value));
const stateBuf = Buffer.from(String(data.conversationState).replace(/^~/, ''), 'base64');
const listed = childRefs(stateBuf);
console.log(`\nIDE chat ${chatId} — ${data.name}`);
console.log(`  conversationState lists ${listed.length} blobs`);

const store = new Map();
for (const d of listed) {
  const row = get.get(`agentKv:blob:${d}`);
  if (!row) continue;
  const hex = text(row.value);
  const buf = Buffer.from(hex, 'hex');
  const sha = createHash('sha256').update(buf).digest('hex');
  store.set(d, { buf, valid: sha === d });
}
const missing = listed.filter((d) => !store.has(d));
const bad = [...store.values()].filter((b) => !b.valid).length;
console.log(`  fetched ${store.size}, missing ${missing.length}, hash mismatches ${bad}`);

const ideRefd = new Set();
for (const { buf } of store.values()) for (const c of childRefs(buf)) ideRefd.add(c);
const ideRoots = listed.filter((d) => !ideRefd.has(d));
console.log(`  unreferenced blobs: ${ideRoots.length}`);
for (const r of ideRoots.slice(0, 5)) {
  console.log(`    ${r}  (position ${listed.indexOf(r)} of ${listed.length})`);
}
ide.close();
