#!/usr/bin/env node
/** Decode an ACP session store: how are messages linked together? */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';

const base = join(homedir(), '.cursor', 'acp-sessions');
const id = process.argv[2] || readdirSync(base)[0];
const db = new DatabaseSync(join(base, id, 'store.db'), { readOnly: true });

console.log('=== meta ===');
for (const row of db.prepare('SELECT key, value FROM meta').all()) {
  console.log(`${row.key} = ${String(row.value).slice(0, 1500)}`);
}

const blobs = db.prepare('SELECT id, data FROM blobs').all();
console.log(`\n=== ${blobs.length} blobs ===`);
let hashMatches = 0;
for (const b of blobs.slice(0, 12)) {
  const buf = Buffer.from(b.data);
  const sha = createHash('sha256').update(buf).digest('hex');
  if (sha === b.id) hashMatches += 1;
  const text = buf.toString('utf8');
  const printable = /^[\x09\x0a\x0d\x20-\x7e]/.test(text);
  console.log(`\n${b.id.slice(0, 12)}… ${buf.length}b ${printable ? 'text' : 'binary'}`);
  console.log(text.slice(0, 300).replace(/\n/g, '\\n'));
}
console.log(`\nsha256(data) === id for ${hashMatches}/${Math.min(12, blobs.length)} sampled blobs`);
db.close();
