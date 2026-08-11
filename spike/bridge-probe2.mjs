#!/usr/bin/env node
/** Are the IDE's local blobs the same DAG an ACP session reads? */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const db = new DatabaseSync(
  join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
    'Cursor', 'User', 'globalStorage', 'state.vscdb'),
  { readOnly: true },
);

const get = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?');
const asText = (v) => (Buffer.isBuffer(v) ? v : Buffer.from(v)).toString('utf8');

console.log('blob rows: ' +
  db.prepare("SELECT COUNT(*) c FROM cursorDiskKV WHERE key LIKE 'agentKv:blob:%'").get().c);

console.log('\n=== what a local IDE blob looks like ===');
for (const r of db
  .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'agentKv:blob:%' AND length(value) BETWEEN 200 AND 4000 LIMIT 3")
  .all()) {
  const buf = Buffer.isBuffer(r.value) ? r.value : Buffer.from(r.value);
  const claimed = r.key.split(':').pop();
  const sha = createHash('sha256').update(buf).digest('hex');
  console.log(`\n${r.key.slice(0, 30)}… ${buf.length}b  sha256(value)==key? ${sha === claimed}`);
  console.log(asText(buf).slice(0, 220).replace(/\n/g, '\\n'));
}

const digestsOf = (state) => {
  const buf = Buffer.from(String(state || '').replace(/^~/, ''), 'base64');
  const out = [];
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
    if (len === 32) out.push(buf.subarray(off, off + len).toString('hex'));
    off += len;
  }
  return out;
};

// Check several chats, newest first: are their roots present locally?
const chats = db
  .prepare("SELECT key FROM cursorDiskKV WHERE key LIKE 'composerData:%' LIMIT 700")
  .all()
  .map((r) => r.key.slice('composerData:'.length));

console.log(`\n=== checking ${chats.length} chats for locally present blobs ===`);
let checked = 0;
for (const id of chats) {
  const row = get.get(`composerData:${id}`);
  if (!row) continue;
  let data;
  try {
    data = JSON.parse(asText(row.value));
  } catch {
    continue;
  }
  if (!data.conversationState) continue;
  const digests = digestsOf(data.conversationState);
  if (!digests.length) continue;
  let hits = 0;
  for (const d of digests) if (get.get(`agentKv:blob:${d}`)) hits += 1;
  checked += 1;
  if (hits || checked <= 5) {
    console.log(
      `${id.slice(0, 8)}  ${String(data.name || '').slice(0, 30).padEnd(30)} ` +
        `${hits}/${digests.length} blobs local  backend=${data.agentBackend}`,
    );
  }
  if (checked > 40) break;
}
db.close();
