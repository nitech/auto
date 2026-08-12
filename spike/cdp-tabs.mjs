/**
 * What the chat tabs are called, and what a scratch chat actually did.
 *
 * Two things went wrong in the stop test: a prompt that submitted but never
 * started a turn, and a tab that was pressed without the window moving. Both
 * need looking at rather than retrying.
 *
 * Usage: node spike/cdp-tabs.mjs <threadId>
 */
import { CursorCdp } from '../src/core/cursor-cdp.mjs';
import { readThread } from '../src/core/desktop-threads.mjs';

const threadId = process.argv[2];
const cursor = new CursorCdp();

const TABS = `(() => {
  const pane = document.querySelector('#workbench\\\\.parts\\\\.auxiliarybar') || document;
  const clean = (s) => String(s ?? '').replace(/\\s+/g, ' ').trim().slice(0, 60);
  const out = [];
  for (const el of pane.querySelectorAll('[data-resource-name], .tab, [role="tab"], [class*="tab"]')) {
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    out.push({
      tag: el.tagName.toLowerCase(),
      resource: clean(el.getAttribute('data-resource-name')),
      label: clean(el.getAttribute('aria-label') || el.getAttribute('title')),
      text: clean(el.textContent),
      cls: clean(el.className.baseVal ?? el.className),
      selected: el.getAttribute('aria-selected') || el.className?.toString?.().includes('active'),
      x: Math.round(rect.left),
    });
  }
  return out;
})()`;

const window = (await cursor.windows()).find((w) => w.hasComposer);
console.log(`window shows chat ${window?.threadId}`);

const tabs = await cursor.readWindow(window.threadId, TABS);
console.log(`\ntab-ish elements (${tabs?.length || 0}):`);
for (const t of tabs || []) {
  console.log(
    `  x=${String(t.x).padStart(4)} ${t.tag.padEnd(4)} selected=${String(t.selected).padEnd(5)} ` +
      `resource=${JSON.stringify(t.resource)} label=${JSON.stringify(t.label)} text=${JSON.stringify(t.text)}`,
  );
}

for (const id of [threadId, window?.threadId].filter(Boolean)) {
  const state = readThread(id, { tail: 6 });
  console.log(`\nchat ${id}`);
  console.log(`  title      ${JSON.stringify(state?.title)}`);
  console.log(`  generating ${state?.generating}`);
  console.log(`  messages   ${state?.total}`);
  for (const m of state?.messages || []) {
    console.log(`    ${m.role}/${m.kind} ${JSON.stringify(String(m.text || '').slice(0, 80))}`);
  }
}

process.exit(0);
