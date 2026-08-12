#!/usr/bin/env node
/** Read one desktop thread's messages, in order, as the IDE renders them. */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const threadId = process.argv[2];
const tail = Number(process.argv[3] ?? 6);

const db = new DatabaseSync(
  join(process.env.APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
  { readOnly: true },
);

const text = (row) =>
  row?.value_t === 'blob' ? Buffer.from(row.value).toString('utf8') : String(row?.value ?? '');
const get = db.prepare('SELECT value, typeof(value) value_t FROM cursorDiskKV WHERE key = ?');

const data = JSON.parse(text(get.get(`composerData:${threadId}`)));
const order = data.fullConversationHeadersOnly || [];
console.log(`thread "${data.name}" — ${order.length} bubbles in order, status keys:`, {
  hasState: Boolean(data.conversationState),
});

for (const header of order.slice(-tail)) {
  const row = get.get(`bubbleId:${threadId}:${header.bubbleId}`);
  if (!row) continue;
  let bubble;
  try {
    bubble = JSON.parse(text(row));
  } catch {
    continue;
  }
  const who = bubble.type === 1 ? 'user' : bubble.type === 2 ? 'assistant' : `type${bubble.type}`;
  const body = String(bubble.text || '').replace(/\s+/g, ' ').trim();
  console.log(`\n[${who}] ${body.slice(0, 300) || '(no text — tool call or thinking)'}`);
}
