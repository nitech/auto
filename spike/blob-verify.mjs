#!/usr/bin/env node
/** Why did a chat's own blobs fail to verify? */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const db = new DatabaseSync(
  join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
    'Cursor', 'User', 'globalStorage', 'state.vscdb'),
  { readOnly: true },
);
const get = db.prepare('SELECT value, typeof(value) t FROM cursorDiskKV WHERE key = ?');
const chatId = process.argv[2] || '4e9abaeb-7716-4f4d-a976-18ec10061759';
const data = JSON.parse(
  (Buffer.isBuffer(get.get(`composerData:${chatId}`).value)
    ? get.get(`composerData:${chatId}`).value
    : Buffer.from(get.get(`composerData:${chatId}`).value)
  ).toString('utf8'),
);

const buf = Buffer.from(String(data.conversationState).replace(/^~/, ''), 'base64');
const digests = [];
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
  if (len === 32) digests.push(buf.subarray(off, off + len).toString('hex'));
  off += len;
}

for (const d of digests.slice(0, 3)) {
  const row = get.get(`agentKv:blob:${d}`);
  const raw = Buffer.isBuffer(row.value) ? row.value : Buffer.from(String(row.value));
  const asUtf8 = raw.toString('utf8');
  console.log(`\ndigest ${d.slice(0, 16)}…  stored ${row.t}, ${raw.length} bytes`);
  console.log(`  head: ${JSON.stringify(asUtf8.slice(0, 40))}`);
  const bytes = Buffer.from(asUtf8, 'hex');
  console.log(`  hex→${bytes.length} bytes, sha256 ${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}…`);
  console.log(`  match: ${createHash('sha256').update(bytes).digest('hex') === d}`);
}
db.close();
