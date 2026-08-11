#!/usr/bin/env node
/** What is in an IDE chat record, and can it be replayed as a conversation? */
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';

const db = new DatabaseSync(
  join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
    'Cursor', 'User', 'globalStorage', 'state.vscdb'),
  { readOnly: true },
);

const id = process.argv[2] || '4e9abaeb-7716-4f4d-a976-18ec10061759';
const raw = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(`composerData:${id}`);
const data = JSON.parse(raw.value.toString ? raw.value.toString() : raw.value);

console.log('=== composerData keys ===');
for (const [k, v] of Object.entries(data)) {
  const kind = Array.isArray(v) ? `array(${v.length})` : typeof v;
  const peek =
    typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
      ? ` = ${String(v).slice(0, 120)}`
      : '';
  console.log(`${k}: ${kind}${peek}`);
}

const list = data.fullConversationHeadersOnly || data.conversation || [];
console.log(`\n=== conversation headers (${list.length}) ===`);
console.log(JSON.stringify(list.slice(0, 4), null, 2));

if (list.length) {
  const first = list[0];
  const bubbleKey = `bubbleId:${id}:${first.bubbleId || first.id}`;
  const b = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(bubbleKey);
  if (b) {
    const bubble = JSON.parse(b.value.toString ? b.value.toString() : b.value);
    console.log('\n=== first bubble keys ===');
    console.log(Object.keys(bubble).join(', '));
    console.log(`\ntype=${bubble.type} text=${String(bubble.text || '').slice(0, 300)}`);
  }
}

console.log('\n=== composerHeaders table ===');
for (const t of db.prepare("SELECT * FROM composerHeaders LIMIT 2").all()) {
  console.log(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(t).map(([k, v]) => [
          k,
          typeof v === 'string' && v.length > 600 ? `${v.slice(0, 600)}…` : v,
        ]),
      ),
      null,
      2,
    ),
  );
}
db.close();
