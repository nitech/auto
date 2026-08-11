#!/usr/bin/env node
/** Check whether desktop chat messages are readable (and how fresh) from state.vscdb. */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const db = new DatabaseSync(
  join(process.env.APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
  { readOnly: true },
);

const text = (row) =>
  row?.t === 'blob' ? Buffer.from(row.value).toString('utf8') : String(row?.value ?? '');

console.log('--- tables ---');
for (const t of db.prepare("select name from sqlite_master where type='table'").all()) {
  const n = db.prepare(`select count(*) c from "${t.name}"`).get().c;
  console.log(`${t.name} (${n} rows)`);
}

const list = db
  .prepare('select * from composerHeaders')
  .all()
  .map((r) => {
    try {
      return JSON.parse(text({ t: typeof r.value === 'object' ? 'blob' : 'text', value: r.value }));
    } catch {
      return null;
    }
  })
  .filter(Boolean);
list.sort((a, b) => (b.lastUpdatedAt ?? 0) - (a.lastUpdatedAt ?? 0));

console.log('--- 5 most recent desktop chats ---');
for (const c of list.slice(0, 5)) {
  console.log(`${new Date(c.lastUpdatedAt ?? 0).toISOString()}  ${c.composerId}  ${c.name ?? ''}`);
}

const target = list[0];
console.log(`\n--- bubbles for "${target.name}" (${target.composerId}) ---`);
const bubbles = db
  .prepare("select key, typeof(value) t, value from cursorDiskKV where key like ? order by key")
  .all(`bubbleId:${target.composerId}:%`);
console.log(`${bubbles.length} bubble rows`);

let shown = 0;
for (const b of bubbles) {
  let parsed;
  try {
    parsed = JSON.parse(text(b));
  } catch {
    continue;
  }
  const body = parsed.text || parsed.richText || '';
  if (!body || shown >= 4) continue;
  shown += 1;
  const who = parsed.type === 1 ? 'user' : parsed.type === 2 ? 'assistant' : `type${parsed.type}`;
  console.log(`\n[${who}] ${String(body).replace(/\s+/g, ' ').slice(0, 240)}`);
}
