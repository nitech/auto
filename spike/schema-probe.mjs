#!/usr/bin/env node
/** Confirm the ItemTable schema supports an upsert on key. */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const db = new DatabaseSync(
  join(process.env.APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
  { readOnly: true },
);
console.log(db.prepare("select sql from sqlite_master where name = 'ItemTable'").get().sql);

// Rehearse the exact statement the enable step will run, against a copy in
// memory, so a typo cannot surface while Cursor is closed.
const scratch = new DatabaseSync(':memory:');
scratch.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
const upsert = (k, v) =>
  scratch
    .prepare(
      'INSERT INTO ItemTable (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(k, v);
upsert('a', 'one');
upsert('a', 'two');
console.log('upsert result:', scratch.prepare('select value from ItemTable where key = ?').get('a'));
