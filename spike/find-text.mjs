/**
 * Where did a message end up?
 *
 * A word that Auto believed it had sent went missing from Cursor's queue, so this
 * looks for it across everything Cursor has stored: which record holds it, and
 * which chat that record belongs to.
 *
 * Usage: node spike/find-text.mjs <word>
 */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const word = process.argv[2];
if (!word) {
  console.log('say which word to look for');
  process.exit(1);
}

const db = new DatabaseSync(
  join(process.env.APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
  { readOnly: true },
);

const rows = db
  .prepare('select key, value from cursorDiskKV where value like ? limit 20')
  .all(`%${word}%`);

for (const row of rows) {
  const said = String(row.value);
  const at = said.indexOf(word);
  console.log(`${row.key}\n  …${said.slice(Math.max(0, at - 120), at + 60).replace(/\s+/g, ' ')}…\n`);
}
console.log(`${rows.length} record(s) hold "${word}"`);
