#!/usr/bin/env node
/**
 * The IDE chat and an ACP session look like the same machinery: a content
 * addressed blob DAG plus a per-conversation encryption key. If the IDE's
 * blobs live in this database under the ids named by conversationState, then
 * an ACP session can be pointed at an IDE chat.
 */
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';

const db = new DatabaseSync(
  join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
    'Cursor', 'User', 'globalStorage', 'state.vscdb'),
  { readOnly: true },
);

const id = process.argv[2] || '4e9abaeb-7716-4f4d-a976-18ec10061759';
const row = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(`composerData:${id}`);
const data = JSON.parse(row.value.toString ? row.value.toString() : row.value);

console.log('=== agentKv sample keys ===');
for (const r of db.prepare("SELECT key, length(value) len FROM cursorDiskKV WHERE key LIKE 'agentKv:%' LIMIT 5").all()) {
  console.log(`${r.key}  (${r.len} bytes)`);
}

const state = String(data.conversationState || '');
console.log(`\nconversationState: ${state.length} chars, starts ${state.slice(0, 8)}`);
const buf = Buffer.from(state.replace(/^~/, ''), 'base64');
console.log(`decoded ${buf.length} bytes`);

// Protobuf: repeated field 1, length-delimited. Expect 32-byte digests.
const ids = [];
let off = 0;
while (off < buf.length) {
  const tag = buf[off++];
  if ((tag & 0x07) !== 2) break;
  let len = 0;
  let shift = 0;
  while (off < buf.length) {
    const b = buf[off++];
    len |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  const val = buf.subarray(off, off + len);
  off += len;
  ids.push({ field: tag >> 3, hex: val.toString('hex'), len });
}
console.log(`\nparsed ${ids.length} entries; first 5:`);
for (const e of ids.slice(0, 5)) console.log(`  field ${e.field} len ${e.len}: ${e.hex.slice(0, 32)}…`);

const digests = ids.filter((e) => e.len === 32).map((e) => e.hex);
console.log(`\n${digests.length} look like sha256 digests`);

let hits = 0;
const check = db.prepare('SELECT length(value) len FROM cursorDiskKV WHERE key = ?');
for (const d of digests) {
  const found = check.get(`agentKv:${d}`);
  if (found) {
    hits += 1;
    if (hits <= 3) console.log(`  HIT agentKv:${d.slice(0, 16)}… (${found.len} bytes)`);
  }
}
console.log(`\n${hits}/${digests.length} digests exist as agentKv blobs in the IDE database`);
console.log(`blobEncryptionKey: ${data.blobEncryptionKey} → ${Buffer.from(data.blobEncryptionKey, 'base64').length} bytes`);
db.close();
