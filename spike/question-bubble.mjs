/**
 * What Cursor stores when the agent asks the user a question.
 *
 * A question reached Auto as a bare "ask_question" card with no text and no
 * options, so there was nothing to answer on a phone — while the approval
 * watcher offered the wrong buttons entirely. If the question and its options
 * are in the call's blob, they can be put on a phone properly.
 *
 * Read-only.
 *
 * Usage: node spike/question-bubble.mjs <threadId> [toolName]
 */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { decodeToolBinary, describeToolBinary } from '../src/core/tool-binary.mjs';

const [, , threadId, want = 'ask_question'] = process.argv;
if (!threadId) throw new Error('need a thread id');

const db = new DatabaseSync(
  join(process.env.APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
  { readOnly: true },
);
const get = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?');
const textOf = (row) => (Buffer.isBuffer(row?.value) ? row.value.toString('utf8') : String(row?.value ?? ''));

const data = JSON.parse(textOf(get.get(`composerData:${threadId}`)));
const found = [];
for (const header of data.fullConversationHeadersOnly || []) {
  const row = get.get(`bubbleId:${threadId}:${header.bubbleId}`);
  if (!row) continue;
  const tool = JSON.parse(textOf(row)).toolFormerData;
  if ((tool?.name || tool?.tool) === want) found.push({ id: header.bubbleId, tool });
}

console.log(`${found.length} ${want} call(s)\n`);
for (const { id, tool } of found.slice(-2)) {
  console.log(`=== ${id} — status ${JSON.stringify(tool.status)} ${JSON.stringify(tool.additionalData || null)}`);
  console.log(`  keys: ${Object.keys(tool).join(', ')}`);
  console.log(`  params: ${String(tool.params || tool.rawArgs || '').slice(0, 200)}`);
  console.log(`  decoded: ${JSON.stringify(decodeToolBinary(tool.toolCallBinary))}`);
  console.log('  every string in the blob:');
  for (const f of describeToolBinary(tool.toolCallBinary)) {
    if (!f.value || /^\d+$/.test(f.value)) continue;
    console.log(`    ${f.path.padEnd(14)} ${JSON.stringify(f.value.slice(0, 120))}`);
  }
  console.log('');
}

db.close();
