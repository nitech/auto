/**
 * Reading the blob Cursor now keeps a tool call in.
 *
 * The bubble used to carry `params` and `result` as JSON. In this build there is
 * no result at all, the status never leaves "loading", and everything real is
 * base64 in `toolCallBinary` — which is why a phone shows a command and never
 * what it printed.
 *
 * Protocol buffers can be walked without knowing the schema: every field says
 * its number and how long it is. So this walks the tree and prints what it
 * finds, which is enough to learn where the command, the output and the exit
 * status live before any of it is relied on.
 *
 * Read-only.
 *
 * Usage: node spike/decode-tool-binary.mjs <threadId> [toolName] [howMany]
 */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const [, , threadId, want = 'run_terminal_command_v2', howMany = '2'] = process.argv;
if (!threadId) throw new Error('need a thread id');

const db = new DatabaseSync(
  join(process.env.APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
  { readOnly: true },
);
const get = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?');
const textOf = (row) => (Buffer.isBuffer(row?.value) ? row.value.toString('utf8') : String(row?.value ?? ''));

/** One varint, and where it ended. */
function varint(buf, at) {
  let value = 0n;
  let shift = 0n;
  let i = at;
  while (i < buf.length) {
    const byte = buf[i];
    i += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [value, i];
    shift += 7n;
    if (shift > 63n) break;
  }
  return [null, buf.length + 1];
}

/** Every field in a message, or null if these bytes are not one. */
function fields(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const [tag, next] = varint(buf, i);
    if (tag === null) return null;
    i = next;
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (!field) return null;
    if (wire === 0) {
      const [value, after] = varint(buf, i);
      if (value === null) return null;
      i = after;
      out.push({ field, wire, value });
    } else if (wire === 2) {
      const [len, after] = varint(buf, i);
      if (len === null || after + Number(len) > buf.length) return null;
      i = after + Number(len);
      out.push({ field, wire, bytes: buf.subarray(after, i) });
    } else if (wire === 5) {
      if (i + 4 > buf.length) return null;
      i += 4;
      out.push({ field, wire, value: 'f32' });
    } else if (wire === 1) {
      if (i + 8 > buf.length) return null;
      i += 8;
      out.push({ field, wire, value: 'f64' });
    } else {
      return null;
    }
  }
  return out;
}

const printable = (buf) => {
  const text = buf.toString('utf8');
  if (text.includes('\uFFFD')) return null;
  const odd = [...text].filter((c) => c.charCodeAt(0) < 9 || (c.charCodeAt(0) > 13 && c.charCodeAt(0) < 32));
  return odd.length ? null : text;
};

function walk(buf, path = '', depth = 0) {
  const parsed = depth > 8 ? null : fields(buf);
  const text = printable(buf);
  // A short leaf that reads as words is a string; anything that parses cleanly
  // and holds sensible field numbers is a message.
  const looksMessage = parsed?.length && parsed.every((f) => f.field < 200);
  if (!looksMessage) {
    console.log(`  ${path.padEnd(16)} ${text === null ? `<${buf.length} bytes>` : JSON.stringify(text.slice(0, 300))}`);
    return;
  }
  for (const f of parsed) {
    const here = path ? `${path}.${f.field}` : String(f.field);
    if (f.wire === 2) walk(f.bytes, here, depth + 1);
    else console.log(`  ${here.padEnd(16)} ${f.value}`);
  }
}

const data = JSON.parse(textOf(get.get(`composerData:${threadId}`)));
const found = [];
for (const header of data.fullConversationHeadersOnly || []) {
  const row = get.get(`bubbleId:${threadId}:${header.bubbleId}`);
  if (!row) continue;
  const bubble = JSON.parse(textOf(row));
  const tool = bubble.toolFormerData;
  if (!tool?.toolCallBinary) continue;
  if (want !== 'any' && (tool.name || tool.tool) !== want) continue;
  found.push({ id: header.bubbleId, tool });
}

console.log(`${found.length} ${want} calls with a blob; showing the last ${howMany}\n`);
for (const { id, tool } of found.slice(-Number(howMany))) {
  const buf = Buffer.from(tool.toolCallBinary, 'base64');
  console.log(`=== ${id} — status ${JSON.stringify(tool.status)}, ${buf.length} bytes` +
    `${tool.additionalData ? `, additionalData ${JSON.stringify(tool.additionalData)}` : ''}`);
  walk(buf);
  console.log('');
}

db.close();
