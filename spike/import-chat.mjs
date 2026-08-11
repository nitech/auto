#!/usr/bin/env node
/**
 * The moment of truth: can a desktop IDE chat be handed to the agent as a
 * session it will continue?
 *
 * The IDE and the CLI use the same machinery — a content-addressed blob DAG
 * plus a per-conversation key. The IDE keeps its blobs in state.vscdb under
 * `agentKv:blob:<sha256>`, and names the conversation's blobs in
 * `composerData.conversationState`. An ACP session is the same DAG in its own
 * SQLite file. So: copy the blobs across, point a fresh session's root at the
 * chat's head, and ask the agent what we were talking about.
 *
 *   node spike/import-chat.mjs <ideChatId> [cwd]
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AcpClient } from '../src/acp/client.mjs';

const chatId = process.argv[2] || '4e9abaeb-7716-4f4d-a976-18ec10061759';
const cwd = process.argv[3] || 'D:\\Sevenfold\\auto';

const ide = new DatabaseSync(
  join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
    'Cursor', 'User', 'globalStorage', 'state.vscdb'),
  { readOnly: true },
);

const getRow = ide.prepare('SELECT value, typeof(value) t FROM cursorDiskKV WHERE key = ?');

/** Blob rows are stored as raw bytes in some records and hex text in others. */
function bytesOf(row) {
  if (!row) return null;
  if (row.t === 'blob') return Buffer.from(row.value);
  return Buffer.from(String(row.value), 'hex');
}

/** Records like composerData are plain JSON text. */
function jsonOf(row) {
  const text = row.t === 'blob' ? Buffer.from(row.value).toString('utf8') : String(row.value);
  return JSON.parse(text);
}

const chat = jsonOf(getRow.get(`composerData:${chatId}`));
console.log(`chat: ${chat.name}  (backend ${chat.agentBackend})`);

const rootBytes = Buffer.from(String(chat.conversationState).replace(/^~/, ''), 'base64');

/** The 32-byte length-delimited entries in a manifest. */
function refs(buf) {
  const out = [];
  let off = 0;
  while (off < buf.length) {
    const tag = buf[off++];
    if ((tag & 0x07) !== 2) break;
    let len = 0;
    let shift = 0;
    while (off < buf.length) {
      const b = buf[off++];
      len |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    if (len === 32) out.push(buf.subarray(off, off + len).toString('hex'));
    off += len;
  }
  return out;
}

// Walk the DAG: manifest entries may themselves reference more blobs.
const wanted = new Set(refs(rootBytes));
const collected = new Map();
const queue = [...wanted];
let verified = 0;
while (queue.length) {
  const digest = queue.pop();
  if (collected.has(digest)) continue;
  const buf = bytesOf(getRow.get(`agentKv:blob:${digest}`));
  if (!buf) continue;
  if (createHash('sha256').update(buf).digest('hex') === digest) verified += 1;
  collected.set(digest, buf);
  for (const child of refs(buf)) if (!collected.has(child)) queue.push(child);
}
console.log(`blobs: ${collected.size} collected, ${verified} hash-verified`);
ide.close();

// Build the session the agent will load.
const sessionId = randomUUID();
const dir = join(homedir(), '.cursor', 'acp-sessions', sessionId);
mkdirSync(dir, { recursive: true });
writeFileSync(
  join(dir, 'meta.json'),
  JSON.stringify({ schemaVersion: 1, cwd, title: chat.name || 'Imported chat' }),
);

const db = new DatabaseSync(join(dir, 'store.db'));
db.exec('PRAGMA journal_mode=WAL');
db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)');
db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');

const insert = db.prepare('INSERT OR REPLACE INTO blobs (id, data) VALUES (?, ?)');
for (const [digest, buf] of collected) insert.run(digest, buf);

const rootId = createHash('sha256').update(rootBytes).digest('hex');
insert.run(rootId, rootBytes);

const meta = {
  agentId: sessionId,
  latestRootBlobId: rootId,
  name: chat.name || 'Imported chat',
  mode: 'default',
  isRunEverything: false,
  createdAt: Date.now(),
  blobEncryptionKey: Buffer.from(chat.blobEncryptionKey, 'base64').toString('hex'),
};
db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
  '0',
  Buffer.from(JSON.stringify(meta)).toString('hex'),
);
db.close();

console.log(`wrote session ${sessionId}\n  root ${rootId.slice(0, 16)}…\n  ${dir}`);

// Ask the agent to prove it has the history.
const client = new AcpClient({ cwd });
client.on('log', (m) => console.log(`[acp] ${m}`));
await client.start();

let loaded;
try {
  loaded = await client.loadSession({ sessionId, cwd });
  console.log('session/load OK');
} catch (err) {
  console.log(`session/load FAILED: ${err.message}`);
  await client.stop();
  process.exit(1);
}

let answer = '';
client.on('update', (u) => {
  const text = u?.update?.content?.text;
  if (u?.update?.sessionUpdate === 'agent_message_chunk' && text) answer += text;
});

const res = await client.prompt({
  sessionId,
  prompt: [
    {
      type: 'text',
      text: 'Without using any tools: in one sentence, what was this conversation about so far? Name a specific detail from earlier that only someone who saw it would know.',
    },
  ],
});

console.log(`\nstopReason: ${res?.stopReason}`);
console.log(`answer: ${answer.trim()}`);
await client.stop();
process.exit(0);
