/**
 * Where a chat's model and mode are written, and what can be pressed to change
 * them.
 *
 * Two questions, because reading and setting want different sources. What a chat
 * is set to is a fact and belongs in the database with the rest of the thread;
 * changing it is a menu in the window. Both are looked at here before either is
 * built on.
 *
 * Read-only: no menu is opened and nothing is clicked.
 *
 * Usage: node spike/model-mode.mjs [threadId]
 */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { CursorCdp } from '../src/core/cursor-cdp.mjs';

const cursor = new CursorCdp();
const window = (await cursor.windows()).find((w) => w.hasComposer);
const threadId = process.argv[2] || window?.threadId;
if (!threadId) {
  console.log('no chat to look at');
  process.exit(1);
}

console.log(`=== the database, for ${threadId}\n`);
const db = new DatabaseSync(
  join(process.env.APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
  { readOnly: true },
);
const textOf = (row) => (Buffer.isBuffer(row?.value) ? row.value.toString('utf8') : String(row?.value ?? ''));
const get = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?');
const data = JSON.parse(textOf(get.get(`composerData:${threadId}`)));

const interesting = /model|mode|agent|thinking|effort|max|auto/i;
for (const [key, value] of Object.entries(data)) {
  if (!interesting.test(key)) continue;
  const shown = typeof value === 'object' ? JSON.stringify(value) : String(value);
  console.log(`  ${key} = ${shown.slice(0, 300)}`);
}

// The picker lists are global, not per chat: look for them in the settings rows.
console.log('\n=== keys that might hold the lists\n');
const rows = db
  .prepare("SELECT key, length(value) len FROM ItemTable WHERE key LIKE '%cursor%' OR key LIKE '%ai%'")
  .all();
for (const r of rows) console.log(`  ItemTable ${r.key} (${r.len} bytes)`);
db.close();

console.log('\n=== the window: what sits by the chat box\n');
const PROBE = `(() => {
  const pane = document.querySelector('#workbench\\\\.parts\\\\.auxiliarybar') || document;
  const box = pane.querySelector("div.aislash-editor-input[contenteditable='true']");
  const boxRect = box ? box.getBoundingClientRect() : null;
  const out = [];
  for (const el of pane.querySelectorAll('*')) {
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    // Only the strip below the chat box, where the pickers live.
    if (!boxRect || rect.top < boxRect.top) continue;
    const isButton = el.tagName === 'BUTTON' || el.getAttribute('role') === 'button';
    if (!isButton && getComputedStyle(el).cursor !== 'pointer') continue;
    if (!isButton && el.querySelector("button, [role='button']")) continue;
    const text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (!text && !el.getAttribute('aria-label')) continue;
    out.push({
      tag: el.tagName.toLowerCase(),
      cls: String(el.className?.baseVal ?? el.className ?? '').slice(0, 60),
      label: el.getAttribute('aria-label') || null,
      title: el.getAttribute('title') || null,
      attrs: el.getAttributeNames().filter((a) => a !== 'class' && a !== 'style').join(','),
      text: text.slice(0, 60),
      hasPopup: el.getAttribute('aria-haspopup') || null,
      expanded: el.getAttribute('aria-expanded') || null,
    });
  }
  return out;
})()`;

const controls = (await cursor.readWindow(threadId, PROBE)) || [];
console.log(`${controls.length} pressable things below the chat box:`);
for (const c of controls) {
  console.log(
    `  <${c.tag}> ${JSON.stringify(c.text)}` +
      `${c.label ? ` label=${JSON.stringify(c.label)}` : ''}` +
      `${c.hasPopup ? ` haspopup=${c.hasPopup}` : ''}${c.expanded ? ` expanded=${c.expanded}` : ''}` +
      `\n      cls=${JSON.stringify(c.cls)} attrs=[${c.attrs}]`,
  );
}

process.exit(0);
