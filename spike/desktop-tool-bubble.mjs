/**
 * What the desktop stores for a command it has finished running.
 *
 * Every shell tool call reaches Auto's transcript once, marked "loading", with
 * no output and no later update — so a phone shows the command and never what
 * it printed. Either the desktop leaves the bubble unfinished, or it keeps the
 * answer somewhere Auto is not looking. This prints the bubble as it is stored.
 *
 * Read-only.
 *
 * Usage: node spike/desktop-tool-bubble.mjs <threadId> [howMany]
 */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const threadId = process.argv[2];
const howMany = Number(process.argv[3] || 3);
if (!threadId) throw new Error('need a thread id');

const dbPath = join(process.env.APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
const db = new DatabaseSync(dbPath, { readOnly: true });
const get = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?');
const textOf = (row) => (Buffer.isBuffer(row?.value) ? row.value.toString('utf8') : String(row?.value ?? ''));

const data = JSON.parse(textOf(get.get(`composerData:${threadId}`)));
const headers = data.fullConversationHeadersOnly || [];
console.log(`chat has ${headers.length} bubbles; generating=${Boolean(data.chatGenerationUUID)}`);

const tools = [];
for (const header of headers) {
  const row = get.get(`bubbleId:${threadId}:${header.bubbleId}`);
  if (!row) continue;
  const bubble = JSON.parse(textOf(row));
  if (bubble.toolFormerData) tools.push({ id: header.bubbleId, bubble });
}
console.log(`of which ${tools.length} are tool calls\n`);

for (const { id, bubble } of tools.slice(-howMany)) {
  const tool = bubble.toolFormerData;
  console.log(`=== bubble ${id}`);
  console.log(`  bubble keys        ${Object.keys(bubble).join(', ').slice(0, 300)}`);
  console.log(`  toolFormerData     ${Object.keys(tool).join(', ')}`);
  console.log(`  name / status      ${tool.name || tool.tool} / ${JSON.stringify(tool.status)}`);
  for (const key of Object.keys(tool)) {
    const value = tool[key];
    if (typeof value === 'string' && value.length > 40) {
      console.log(`  ${key.padEnd(18)} ${value.length} chars: ${JSON.stringify(value.slice(0, 160))}`);
    } else if (value && typeof value === 'object') {
      console.log(`  ${key.padEnd(18)} object: ${JSON.stringify(value).slice(0, 200)}`);
    }
  }
  // Anything on the bubble itself that smells like command output.
  for (const [key, value] of Object.entries(bubble)) {
    if (!/term|shell|command|output|result/i.test(key)) continue;
    console.log(`  bubble.${key.padEnd(11)} ${JSON.stringify(value).slice(0, 300)}`);
  }
  console.log('');
}

db.close();
