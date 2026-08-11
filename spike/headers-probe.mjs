#!/usr/bin/env node
/** Cheapest source for a chat list: headers, not the full chat records. */
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';

const db = new DatabaseSync(
  join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
    'Cursor', 'User', 'globalStorage', 'state.vscdb'),
  { readOnly: true },
);

const text = (v) => (Buffer.isBuffer(v) ? Buffer.from(v).toString('utf8') : String(v));

console.log('=== composerHeaders table columns ===');
console.log(db.prepare("SELECT sql FROM sqlite_master WHERE name='composerHeaders'").get().sql);
for (const r of db.prepare('SELECT * FROM composerHeaders LIMIT 2').all()) {
  console.log(JSON.stringify(r, (k, v) => (typeof v === 'string' && v.length > 500 ? `${v.slice(0, 500)}…` : v), 2));
}

console.log('\n=== ItemTable composer.composerHeaders ===');
const item = db.prepare("SELECT value FROM ItemTable WHERE key='composer.composerHeaders'").get();
if (item) {
  const parsed = JSON.parse(text(item.value));
  const arr = Array.isArray(parsed) ? parsed : parsed.allComposers || [];
  console.log(`entries: ${arr.length}`);
  console.log(JSON.stringify(arr.slice(0, 3), null, 2));
}
db.close();
