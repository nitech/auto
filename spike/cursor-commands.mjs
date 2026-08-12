/**
 * Cursor's own commands, as Cursor lists them.
 *
 * Pressing a dropdown that will not open is the wrong way round. Cursor keeps a
 * list of every command it offers its own command palette, and a command is a
 * far better handle than a menu: it is named, it is stable across a redesign,
 * and it is the same path a keyboard shortcut takes.
 *
 * Read-only.
 *
 * Usage: node spike/cursor-commands.mjs [pattern]
 */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const pattern = new RegExp(process.argv[2] || 'model|mode|thinking|effort|max', 'i');

const db = new DatabaseSync(
  join(process.env.APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
  { readOnly: true },
);
const textOf = (row) => (Buffer.isBuffer(row?.value) ? row.value.toString('utf8') : String(row?.value ?? ''));

for (const key of ['cursor.commands.globalCommands.classic', 'cursor.commands.globalCommands.glass']) {
  const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key);
  if (!row) {
    console.log(`${key}: not there\n`);
    continue;
  }
  let list;
  try {
    list = JSON.parse(textOf(row));
  } catch (err) {
    console.log(`${key}: not JSON (${err.message})\n`);
    continue;
  }
  const commands = Array.isArray(list) ? list : list.commands || Object.values(list).flat();
  const hits = commands.filter((c) => pattern.test(JSON.stringify(c)));
  console.log(`=== ${key}: ${commands.length} commands, ${hits.length} matching ${pattern}\n`);
  for (const c of hits) {
    const id = c.id || c.command || c.commandId || '?';
    const title = c.title || c.label || c.name || '';
    const keys = c.keybinding || c.keys || c.when || '';
    console.log(`  ${String(id).padEnd(52)} ${JSON.stringify(title)}${keys ? `  ${JSON.stringify(keys)}` : ''}`);
  }
  console.log('');
}

db.close();
