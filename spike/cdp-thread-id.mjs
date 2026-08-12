/**
 * Which chat is a Cursor window showing?
 *
 * The bridge addresses a thread by id. CDP cannot: typing goes into whatever
 * chat the window has open, so before Auto types anything it has to know that
 * the window in front of it is the thread it means. Guessing wrong would put a
 * message in a stranger's conversation.
 *
 * Two ways to find out, and this checks both:
 *  - a thread id sitting in the DOM, which would be the direct answer;
 *  - the ids of the messages on screen, which can be looked up in the
 *    desktop's database to say which thread they belong to.
 *
 * Read-only. Nothing is typed.
 *
 * Usage: node spike/cdp-thread-id.mjs [port]
 */
import { WebSocket } from 'ws';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.argv[2] || 9222);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const APPDATA = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
const DB = join(APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb');

async function evaluate(wsUrl, expression) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const answer = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), 10_000);
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.id !== 1) return;
      clearTimeout(timer);
      if (msg.error) reject(new Error(msg.error.message));
      else if (msg.result?.exceptionDetails) {
        reject(new Error(msg.result.exceptionDetails.exception?.description || 'failed'));
      } else resolve(msg.result?.result?.value);
    });
  });
  ws.send(
    JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true },
    }),
  );
  const value = await answer.finally(() => ws.close());
  return value;
}

/** Everything in the page that looks like a Cursor id, and where it sits. */
const LOOK = `
(() => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const ids = {};
  for (const el of document.querySelectorAll('*')) {
    for (const attr of el.attributes || []) {
      if (!attr.name.startsWith('data-')) continue;
      for (const part of String(attr.value).split(/[\\s,]+/)) {
        if (!UUID.test(part)) continue;
        (ids[attr.name] = ids[attr.name] || []).push(part);
      }
    }
  }
  const summary = {};
  for (const [name, list] of Object.entries(ids)) {
    summary[name] = { count: list.length, sample: [...new Set(list)].slice(0, 4) };
  }
  const rows = [...document.querySelectorAll('[data-message-id]')].map((el) => ({
    id: el.getAttribute('data-message-id'),
    role: el.getAttribute('data-message-role'),
    kind: el.getAttribute('data-message-kind'),
  }));
  return { summary, rows: rows.slice(-6), rowCount: rows.length };
})()
`;

/** Which thread owns these message ids, according to the desktop itself? */
function threadsOwning(ids) {
  if (!existsSync(DB)) return { error: 'no desktop database' };
  const db = new DatabaseSync(DB, { readOnly: true });
  try {
    const find = db.prepare("SELECT key FROM cursorDiskKV WHERE key LIKE ? ESCAPE '\\'");
    const owners = new Map();
    for (const id of ids) {
      for (const row of find.all(`bubbleId:%:${id}`)) {
        const threadId = String(row.key).split(':')[1];
        owners.set(threadId, (owners.get(threadId) || 0) + 1);
      }
    }
    return Object.fromEntries(owners);
  } finally {
    db.close();
  }
}

function titleOf(threadId) {
  if (!existsSync(DB)) return null;
  const db = new DatabaseSync(DB, { readOnly: true });
  try {
    const row = db
      .prepare('SELECT value FROM cursorDiskKV WHERE key = ?')
      .get(`composerData:${threadId}`);
    if (!row) return null;
    const text = Buffer.isBuffer(row.value) ? Buffer.from(row.value).toString('utf8') : String(row.value);
    return JSON.parse(text).name || null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

const targets = await fetch(`${ORIGIN}/json`, { signal: AbortSignal.timeout(4000) })
  .then((r) => r.json())
  .catch(() => null);
if (!targets) {
  console.log(`No CDP on ${ORIGIN}.`);
  process.exit(1);
}

for (const target of targets.filter((t) => t.type === 'page' && String(t.url).includes('workbench'))) {
  console.log(`\n=== ${target.title}`);
  let facts;
  try {
    facts = await evaluate(target.webSocketDebuggerUrl, LOOK);
  } catch (err) {
    console.log(`  unreadable: ${err.message}`);
    continue;
  }

  console.log(`  rows on screen   ${facts.rowCount}`);
  for (const [name, { count, sample }] of Object.entries(facts.summary)) {
    console.log(`  ${name.padEnd(26)} ×${count}  ${sample.join(' ')}`);
  }
  for (const row of facts.rows) console.log(`    ${row.role}/${row.kind} ${row.id}`);

  const owners = threadsOwning(facts.rows.map((r) => r.id));
  console.log(`  owning threads   ${JSON.stringify(owners)}`);
  for (const threadId of Object.keys(owners)) {
    console.log(`    ${threadId}  "${titleOf(threadId)}"`);
  }
}

process.exit(0);
