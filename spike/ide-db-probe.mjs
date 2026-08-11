#!/usr/bin/env node
/** What does the IDE store about its chats, and under what ids? */
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';

const db = new DatabaseSync(
  join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
    'Cursor', 'User', 'globalStorage', 'state.vscdb'),
  { readOnly: true },
);

console.log('=== tables ===');
for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
  let n = '?';
  try {
    n = db.prepare(`SELECT COUNT(*) c FROM "${t.name}"`).get().c;
  } catch {
    /* ignore */
  }
  console.log(`${t.name}: ${n} rows`);
}

console.log('\n=== ItemTable keys mentioning chat/composer/agent ===');
for (const r of db
  .prepare("SELECT key, length(value) len FROM ItemTable WHERE key LIKE '%omposer%' OR key LIKE '%chat%' OR key LIKE '%agent%' ORDER BY len DESC LIMIT 25")
  .all()) {
  console.log(`${r.len.toString().padStart(9)}  ${r.key}`);
}

console.log('\n=== cursorDiskKV key prefixes ===');
try {
  for (const r of db
    .prepare("SELECT substr(key, 1, instr(key, ':')) p, COUNT(*) c FROM cursorDiskKV GROUP BY p ORDER BY c DESC LIMIT 20")
    .all()) {
    console.log(`${String(r.c).padStart(7)}  ${r.p || '(no prefix)'}`);
  }
} catch (e) {
  console.log(`no cursorDiskKV: ${e.message}`);
}

const target = process.argv[2] || '4e9abaeb-7716-4f4d-a976-18ec10061759';
console.log(`\n=== rows whose key contains ${target} ===`);
for (const table of ['ItemTable', 'cursorDiskKV']) {
  try {
    const rows = db
      .prepare(`SELECT key, length(value) len FROM "${table}" WHERE key LIKE ? LIMIT 10`)
      .all(`%${target}%`);
    for (const r of rows) console.log(`${table}: ${r.key} (${r.len} bytes)`);
  } catch {
    /* table may not exist */
  }
}
db.close();
