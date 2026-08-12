#!/usr/bin/env node
/** What is in a bubble that has no text? */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const threadId = process.argv[2];
const db = new DatabaseSync(
  join(process.env.APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
  { readOnly: true },
);
const text = (row) =>
  row?.value_t === 'blob' ? Buffer.from(row.value).toString('utf8') : String(row?.value ?? '');
const get = db.prepare('SELECT value, typeof(value) value_t FROM cursorDiskKV WHERE key = ?');
const data = JSON.parse(text(get.get(`composerData:${threadId}`)));

for (const header of (data.fullConversationHeadersOnly || []).slice(-8)) {
  const row = get.get(`bubbleId:${threadId}:${header.bubbleId}`);
  if (!row) continue;
  const b = JSON.parse(text(row));
  const interesting = Object.entries(b)
    .filter(([k, v]) => v !== null && v !== undefined && !(Array.isArray(v) && !v.length) && !(typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length) && v !== '' && v !== false)
    .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 90)}`);
  console.log(`\n--- type ${b.type} (header.type ${header.type}) ---\n  ${interesting.join('\n  ')}`);
}
