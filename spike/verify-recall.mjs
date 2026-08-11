#!/usr/bin/env node
/** Is the detail the agent recalled actually in the imported conversation? */
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';

const sessionId = process.argv[2];
const needle = process.argv[3] || '6WYO-V0O1';
const db = new DatabaseSync(
  join(homedir(), '.cursor', 'acp-sessions', sessionId, 'store.db'),
  { readOnly: true },
);

let hits = 0;
for (const row of db.prepare('SELECT id, data FROM blobs').all()) {
  const text = Buffer.from(row.data).toString('utf8');
  const at = text.indexOf(needle);
  if (at === -1) continue;
  hits += 1;
  if (hits <= 2) {
    console.log(`\nblob ${row.id.slice(0, 12)}…`);
    console.log(text.slice(Math.max(0, at - 220), at + 120).replace(/\s+/g, ' '));
  }
}
console.log(`\n"${needle}" appears in ${hits} imported blob(s)`);
db.close();
