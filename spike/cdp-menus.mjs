/**
 * Where Cursor puts a menu when one opens.
 *
 * Model and mode are dropdowns, and Auto only ever looks inside the chat pane.
 * If menus are rendered somewhere else in the page — as the workbench's own are,
 * in a shared container near the document root — then choosing a model needs a
 * wider search than pressing a button does, and it is better to know that before
 * planning the work than after starting it.
 *
 * Read-only: no menu is opened.
 */
import { CursorCdp } from '../src/core/cursor-cdp.mjs';

const PROBE = `(() => {
  const aux = document.querySelector('#workbench\\\\.parts\\\\.auxiliarybar');
  const seen = [];
  const selectors = [
    '.context-view',
    '.monaco-menu',
    '[role="menu"]',
    '[role="listbox"]',
    '.monaco-dropdown',
    '[data-radix-popper-content-wrapper]',
    '[data-floating-ui-portal]',
    '.ui-popover',
  ];
  for (const sel of selectors) {
    for (const el of document.querySelectorAll(sel)) {
      const rect = el.getBoundingClientRect();
      seen.push({
        sel,
        inChatPane: aux ? aux.contains(el) : false,
        visible: rect.width > 0 && rect.height > 0,
        parent: String(el.parentElement?.className ?? '').slice(0, 50),
      });
    }
  }
  // Anything hanging directly off the body is a candidate portal root.
  const roots = [...document.body.children].map((el) => ({
    tag: el.tagName.toLowerCase(),
    cls: String(el.className ?? '').slice(0, 60),
    kids: el.children.length,
  }));
  return { seen, roots };
})()`;

const cursor = new CursorCdp();
const window = (await cursor.windows()).find((w) => w.hasComposer);
if (!window) {
  console.log('no Cursor window with a chat box');
  process.exit(1);
}

const { seen, roots } = (await cursor.readWindow(window.threadId, PROBE)) || {};
console.log(`menu containers found: ${seen?.length || 0}`);
for (const s of seen || []) {
  console.log(`  ${s.sel.padEnd(34)} inChatPane=${String(s.inChatPane).padEnd(5)} visible=${String(s.visible).padEnd(5)} parent=${s.parent}`);
}
console.log('\ndirect children of body:');
for (const r of roots || []) console.log(`  ${r.tag.padEnd(6)} ${String(r.kids).padStart(3)} kids  ${r.cls}`);

process.exit(0);
