#!/usr/bin/env node
/**
 * How does a desktop thread reach the database while the agent is working?
 *
 * Sends a prompt that takes a while to answer, then watches the thread's rows
 * to learn two things Auto needs: whether assistant text grows as it streams
 * or appears whole, and what marks the end of a turn.
 */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { sendMessage } from '../src/core/desktop-bridge.mjs';

const threadId = process.argv[2];
const DB = join(process.env.APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb');

const text = (row) =>
  row?.value_t === 'blob' ? Buffer.from(row.value).toString('utf8') : String(row?.value ?? '');

function snapshot() {
  const db = new DatabaseSync(DB, { readOnly: true });
  try {
    const get = db.prepare('SELECT value, typeof(value) value_t FROM cursorDiskKV WHERE key = ?');
    const data = JSON.parse(text(get.get(`composerData:${threadId}`)));
    const order = data.fullConversationHeadersOnly || [];
    const last = order.at(-1);
    let lastLen = 0;
    if (last) {
      const row = get.get(`bubbleId:${threadId}:${last.bubbleId}`);
      if (row) {
        try {
          lastLen = String(JSON.parse(text(row)).text || '').length;
        } catch {
          /* mid-write */
        }
      }
    }
    return {
      bubbles: order.length,
      lastLen,
      status: data.status,
      generating: data.isGenerating ?? data.generating,
      unread: data.hasUnreadMessages,
      fields: Object.keys(data).filter((k) => /status|generat|running|complete|abort/i.test(k)),
    };
  } finally {
    db.close();
  }
}

console.log('before:', JSON.stringify(snapshot()));

const sent = await sendMessage({
  threadId,
  text: 'Without using any tools, write a numbered list from 1 to 15 where each line is a different colour and one short sentence about it.',
});
console.log('sent:', JSON.stringify(sent));

let previous = '';
for (let i = 0; i < 60; i += 1) {
  await new Promise((r) => setTimeout(r, 500));
  const s = snapshot();
  const line = JSON.stringify(s);
  if (line !== previous) {
    console.log(`+${((i + 1) * 0.5).toFixed(1)}s ${line}`);
    previous = line;
  }
}
