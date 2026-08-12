/**
 * Where the name of an MCP tool call is kept.
 *
 * These reach the phone labelled "mcp--", which reads as nothing at all: whatever
 * Cursor puts in the title for an MCP call, the server and the tool are not in
 * it. This prints what the bubble actually holds for one, so the label can be
 * built from something a person can read.
 *
 * Read-only.
 *
 * Usage: node spike/mcp-tool-name.mjs <threadId> [howMany]
 */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { decodeToolBinary, describeToolBinary } from '../src/core/tool-binary.mjs';

const threadId = process.argv[2];
const howMany = Number(process.argv[3] || 2);
if (!threadId) throw new Error('need a thread id');

const dbPath = join(process.env.APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
const db = new DatabaseSync(dbPath, { readOnly: true });
const get = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?');
const textOf = (row) => (Buffer.isBuffer(row?.value) ? row.value.toString('utf8') : String(row?.value ?? ''));

const data = JSON.parse(textOf(get.get(`composerData:${threadId}`)));
const headers = data.fullConversationHeadersOnly || [];

const found = [];
for (const header of headers) {
  const row = get.get(`bubbleId:${threadId}:${header.bubbleId}`);
  if (!row) continue;
  const bubble = JSON.parse(textOf(row));
  const tool = bubble.toolFormerData;
  if (!tool) continue;
  const label = `${tool.name || ''}${tool.tool || ''}`;
  if (/mcp/i.test(JSON.stringify({ n: tool.name, t: tool.tool, r: tool.rawArgs?.slice?.(0, 80) })) || /^mcp/.test(label)) {
    found.push({ id: header.bubbleId, tool });
  }
}
console.log(`${headers.length} bubbles, ${found.length} of them MCP calls\n`);

for (const { id, tool } of found.slice(-howMany)) {
  console.log(`=== ${id}`);
  console.log(`  keys: ${Object.keys(tool).join(', ')}`);
  for (const key of ['name', 'tool', 'toolIndex', 'rawArgs', 'params', 'result', 'status', 'additionalData']) {
    if (tool[key] === undefined) continue;
    const value = typeof tool[key] === 'string' ? tool[key] : JSON.stringify(tool[key]);
    console.log(`  ${key}: ${String(value).slice(0, 300)}`);
  }
  const decoded = decodeToolBinary(tool.toolCallBinary);
  console.log(`  decoded: ${JSON.stringify(decoded)?.slice(0, 300)}`);
  if (tool.toolCallBinary) {
    console.log('  blob:');
    for (const line of describeToolBinary(tool.toolCallBinary).split('\n').slice(0, 40)) {
      console.log(`    ${line}`);
    }
  }
  console.log('');
}
