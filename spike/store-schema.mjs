#!/usr/bin/env node
/** What shape is an ACP session's store.db? */
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';

const base = join(homedir(), '.cursor', 'acp-sessions');
const id = process.argv[2] || readdirSync(base)[0];
const db = new DatabaseSync(join(base, id, 'store.db'), { readOnly: true });

console.log(`session ${id}\n`);
const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table'").all();
for (const t of tables) {
  const n = db.prepare(`SELECT COUNT(*) AS c FROM "${t.name}"`).get().c;
  console.log(`--- ${t.name} (${n} rows) ---`);
  console.log(t.sql);
}

for (const t of tables) {
  const rows = db.prepare(`SELECT * FROM "${t.name}" LIMIT 3`).all();
  if (!rows.length) continue;
  console.log(`\n=== sample ${t.name} ===`);
  for (const r of rows) {
    const shown = Object.fromEntries(
      Object.entries(r).map(([k, v]) => [
        k,
        typeof v === 'string' && v.length > 400 ? `${v.slice(0, 400)}…(${v.length})` : v,
      ]),
    );
    console.log(JSON.stringify(shown, null, 2));
  }
}
db.close();
