/**
 * Review state and titles of create_plan bubbles, plus the Match IDE one.
 *
 * Read-only. Usage: node spike/create-plan-status.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const db = new DatabaseSync(
  join(process.env.APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
  { readOnly: true },
);
const get = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?');
const keys = db.prepare("SELECT key FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'").all();
const textOf = (row) =>
  Buffer.isBuffer(row?.value) ? row.value.toString('utf8') : String(row?.value ?? '');

const statuses = new Map();
let match = null;
let latest = null;
let latestAt = 0;

for (const { key } of keys) {
  const row = get.get(key);
  if (!row) continue;
  const raw = textOf(row);
  if (!raw.includes('"name":"create_plan"') && !raw.includes('"name": "create_plan"')) continue;

  let bubble;
  try {
    bubble = JSON.parse(raw);
  } catch {
    continue;
  }
  const tool = bubble.toolFormerData || {};
  if ((tool.name || tool.tool) !== 'create_plan') continue;

  const extra = tool.additionalData || {};
  const review = extra.reviewData?.status || '(none)';
  const option = extra.reviewData?.selectedOption || '';
  const mark = `${review}|${option}|opened=${Boolean(extra.hasOpenedEditor)}`;
  statuses.set(mark, (statuses.get(mark) || 0) + 1);

  const params = (() => {
    try {
      return JSON.parse(tool.params || '{}');
    } catch {
      return {};
    }
  })();
  const paramKeys = Object.keys(params).join(',');
  const createdAt = bubble.createdAt || 0;
  if (createdAt > latestAt) {
    latestAt = createdAt;
    latest = { key, extra, paramKeys, paramsSnippet: JSON.stringify(params).slice(0, 400), createdAt };
  }
  if (String(extra.planId || '').includes('match_ide') || String(extra.planUri || '').includes('match_ide')) {
    match = { key, extra, paramKeys, params, review: extra.reviewData };
  }
}

console.log('reviewData combinations:');
for (const [k, n] of [...statuses].sort((a, b) => b[1] - a[1])) console.log(`  ${n}\t${k}`);

console.log('\nlatest', latest);
console.log('\nmatch_ide', match && {
  key: match.key,
  extra: match.extra,
  paramKeys: match.paramKeys,
  name: match.params?.name,
  overview: match.params?.overview,
  todos: match.params?.todos,
  planHead: String(match.params?.plan || '').slice(0, 300),
});
db.close();
