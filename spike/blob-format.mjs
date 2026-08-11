#!/usr/bin/env node
/** Exactly how is a blob stored, and what does a root blob look like? */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';

const ide = new DatabaseSync(
  join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
    'Cursor', 'User', 'globalStorage', 'state.vscdb'),
  { readOnly: true },
);

const row = ide
  .prepare("SELECT key, value, typeof(value) t FROM cursorDiskKV WHERE key LIKE 'agentKv:blob:%' AND length(value) BETWEEN 300 AND 2000 LIMIT 1")
  .get();
const digest = row.key.split(':').pop();
const raw = Buffer.isBuffer(row.value) ? row.value : Buffer.from(row.value);
console.log(`key digest: ${digest}`);
console.log(`stored type: ${row.t}, ${raw.length} bytes`);
console.log(`first bytes: ${JSON.stringify(raw.subarray(0, 16).toString('utf8'))}`);
console.log(`last bytes:  ${JSON.stringify(raw.subarray(-8).toString('utf8'))}`);

const candidates = {
  'sha256(raw)': createHash('sha256').update(raw).digest('hex'),
  'sha256(hex→bytes of raw)': createHash('sha256')
    .update(Buffer.from(raw.toString('utf8'), 'hex'))
    .digest('hex'),
  'sha256(unquoted hex→bytes)': createHash('sha256')
    .update(Buffer.from(raw.toString('utf8').replace(/^"|"$/g, ''), 'hex'))
    .digest('hex'),
  'sha256(base64→bytes)': createHash('sha256')
    .update(Buffer.from(raw.toString('utf8').replace(/^"|"$/g, ''), 'base64'))
    .digest('hex'),
};
for (const [how, sha] of Object.entries(candidates)) {
  console.log(`${sha === digest ? 'MATCH' : '     '} ${how}: ${sha.slice(0, 24)}…`);
}
ide.close();

console.log('\n=== the known ACP root blob ===');
const base = join(homedir(), '.cursor', 'acp-sessions');
const acpId = readdirSync(base).find((d) => d.startsWith('18349d4a'));
const acp = new DatabaseSync(join(base, acpId, 'store.db'), { readOnly: true });
const meta = JSON.parse(
  Buffer.from(acp.prepare("SELECT value FROM meta WHERE key='0'").get().value, 'hex').toString(),
);
const root = acp.prepare('SELECT data FROM blobs WHERE id = ?').get(meta.latestRootBlobId);
const buf = Buffer.from(root.data);
console.log(`root blob ${buf.length} bytes`);
console.log(buf.subarray(0, 400).toString('hex').replace(/(.{64})/g, '$1\n'));
console.log('\nas text:');
console.log(buf.subarray(0, 300).toString('utf8').replace(/[^\x20-\x7e]/g, '·'));
acp.close();
