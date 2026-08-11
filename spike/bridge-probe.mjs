#!/usr/bin/env node
/** Inspect the Cursor desktop bridge gate state and discovery files. */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const userData = join(process.env.APPDATA, 'Cursor');
const db = new DatabaseSync(join(userData, 'User', 'globalStorage', 'state.vscdb'), { readOnly: true });

console.log('--- gate keys in ItemTable ---');
const rows = db
  .prepare("select key, value from ItemTable where key like '%esktopBridge%' or key like '%esktop_bridge%'")
  .all();
for (const r of rows) console.log(`${r.key} = ${String(r.value).slice(0, 200)}`);
if (!rows.length) console.log('(none)');

console.log('\n--- candidate discovery dirs ---');
for (const dir of [
  join(homedir(), '.cursor', 'desktop-bridge'),
  join(homedir(), '.cursor', 'bridge'),
  join(homedir(), '.cursor'),
]) {
  if (!existsSync(dir)) {
    console.log(`${dir}  (missing)`);
    continue;
  }
  const entries = readdirSync(dir).filter((e) => e.includes('bridge') || e.endsWith('.json'));
  console.log(`${dir}  ->  ${entries.join(', ') || '(no json)'}`);
}

console.log('\n--- expected discovery filename ---');
console.log(`${createHash('sha256').update(userData).digest('hex').slice(0, 16)}.json  (userDataPath=${userData})`);
