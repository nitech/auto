#!/usr/bin/env node
/** Does composerHeaders.workspaceId match a workspaceStorage folder? */
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fromFileUri } from '../src/core/projects.mjs';

const APPDATA = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
const ws = join(APPDATA, 'Cursor', 'User', 'workspaceStorage');

const byPath = new Map();
for (const d of readdirSync(ws, { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  try {
    const meta = JSON.parse(readFileSync(join(ws, d.name, 'workspace.json'), 'utf8'));
    const p = fromFileUri(meta.folder);
    if (p) byPath.set(p.toLowerCase(), d.name);
  } catch {
    /* skip */
  }
}
const target = 'd:\\sevenfold\\auto';
console.log(`workspaceStorage id for ${target}: ${byPath.get(target)}`);

const db = new DatabaseSync(join(APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb'), {
  readOnly: true,
});
const id = byPath.get(target);
const rows = db
  .prepare('SELECT composerId, lastUpdatedAt, isArchived, isSubagent, value FROM composerHeaders WHERE workspaceId = ? ORDER BY lastUpdatedAt DESC LIMIT 10')
  .all(id);
console.log(`\nchats for that workspace: ${rows.length}`);
for (const r of rows) {
  const v = JSON.parse(r.value);
  console.log(
    `${r.composerId.slice(0, 8)}  ${new Date(r.lastUpdatedAt).toISOString().slice(0, 16)}  ` +
      `arch=${r.isArchived} sub=${r.isSubagent}  ${v.name}`,
  );
}

console.log('\ndistinct workspaces in composerHeaders:');
for (const r of db
  .prepare('SELECT workspaceId, COUNT(*) c FROM composerHeaders GROUP BY workspaceId ORDER BY c DESC LIMIT 8')
  .all()) {
  const path = [...byPath.entries()].find(([, v]) => v === r.workspaceId)?.[0];
  console.log(`  ${r.workspaceId}  ${String(r.c).padStart(4)} chats  ${path || '(unknown folder)'}`);
}
db.close();
