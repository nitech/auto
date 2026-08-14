/**
 * What Cursor stores for a create_plan tool bubble.
 *
 * Read-only. Usage: node spike/create-plan-probe.mjs [howMany]
 */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { describeToolBinary } from '../src/core/tool-binary.mjs';

const howMany = Number(process.argv[2] || 2);
const db = new DatabaseSync(
  join(process.env.APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
  { readOnly: true },
);
const get = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?');
const keys = db.prepare("SELECT key FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'").all();
const textOf = (row) =>
  Buffer.isBuffer(row?.value) ? row.value.toString('utf8') : String(row?.value ?? '');

let found = 0;
for (const { key } of keys) {
  const row = get.get(key);
  if (!row) continue;
  const raw = textOf(row);
  if (!/create_plan/.test(raw)) continue;
  found += 1;
  if (found > howMany) continue;

  let bubble;
  try {
    bubble = JSON.parse(raw);
  } catch {
    console.log(key, 'unparseable');
    continue;
  }
  const tool = bubble.toolFormerData || {};
  console.log('\n===', key);
  console.log('  bubble keys', Object.keys(bubble).join(', '));
  console.log('  name', tool.name || tool.tool, 'status', tool.status);
  console.log('  tool keys', Object.keys(tool).join(', '));
  for (const field of ['params', 'rawArgs', 'result', 'additionalData']) {
    if (tool[field] == null) continue;
    const text = typeof tool[field] === 'string' ? tool[field] : JSON.stringify(tool[field], null, 2);
    console.log(`  ${field} (${text.length} chars):\n${text.slice(0, 2500)}`);
  }
  if (tool.toolCallBinary) {
    console.log('  toolCallBinary', tool.toolCallBinary.length, 'chars');
    for (const line of describeToolBinary(tool.toolCallBinary).slice(0, 40)) {
      const value = String(line.value).replace(/\s+/g, ' ').slice(0, 160);
      console.log(`    ${line.path}: ${value}`);
    }
  }
  for (const [k, v] of Object.entries(bubble)) {
    if (k === 'toolFormerData' || k === 'thinking') continue;
    if (v && typeof v === 'object') {
      console.log(`  bubble.${k}`, JSON.stringify(v).slice(0, 400));
    } else if (typeof v === 'string' && v.length > 40) {
      console.log(`  bubble.${k}`, v.slice(0, 200));
    }
  }
}
console.log('\nfound', found);
db.close();
