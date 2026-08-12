/**
 * Does the decoder read real tool calls correctly?
 *
 * Checked against calls whose outcome is known from this very session: a `git`
 * that succeeded, an `rg` that found nothing and exited 1. If the exit code and
 * the tail of the output match what actually happened, the field map is right.
 *
 * Read-only.
 *
 * Usage: node spike/tool-binary-check.mjs <threadId> [howMany]
 */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { decodeToolBinary } from '../src/core/tool-binary.mjs';

const [, , threadId, howMany = '8'] = process.argv;
if (!threadId) throw new Error('need a thread id');

const db = new DatabaseSync(
  join(process.env.APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
  { readOnly: true },
);
const get = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?');
const textOf = (row) => (Buffer.isBuffer(row?.value) ? row.value.toString('utf8') : String(row?.value ?? ''));

const data = JSON.parse(textOf(get.get(`composerData:${threadId}`)));
const calls = [];
for (const header of data.fullConversationHeadersOnly || []) {
  const row = get.get(`bubbleId:${threadId}:${header.bubbleId}`);
  if (!row) continue;
  const tool = JSON.parse(textOf(row)).toolFormerData;
  if (tool?.toolCallBinary) calls.push({ id: header.bubbleId, tool });
}

console.log(`${calls.length} tool calls carry a blob; reading the last ${howMany}\n`);
let unread = 0;
for (const { id, tool } of calls.slice(-Number(howMany))) {
  const got = decodeToolBinary(tool.toolCallBinary);
  const name = tool.name || tool.tool;
  const tail = (got.output || '').replace(/\s+/g, ' ').trim().slice(-90);
  console.log(`${name} — ${tool.status}${tool.additionalData ? ` / ${JSON.stringify(tool.additionalData.status)}` : ''}`);
  console.log(`  command    ${JSON.stringify((got.command || '').slice(0, 100))}`);
  console.log(`  cwd        ${JSON.stringify(got.cwd)}`);
  console.log(`  exit       ${got.exitCode}   took ${got.durationMs}ms`);
  console.log(`  output     ${got.output ? `${got.output.length} chars, ends: ${JSON.stringify(tail)}` : 'none'}`);
  if (name === 'run_terminal_command_v2' && tool.status === 'completed' && !got.output) {
    unread += 1;
    console.log(`  !! a finished command with no output read (bubble ${id})`);
  }
  console.log('');
}
console.log(unread ? `${unread} finished command(s) could not be read` : 'every finished command was readable');

db.close();
