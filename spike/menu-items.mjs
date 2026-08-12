/**
 * What Cursor's model and mode menus are made of.
 *
 * Reading a chat's model and mode is a database question, but changing them is a
 * menu, and a menu cannot be pressed blind. So this opens one, writes down what
 * appeared and where, and closes it again.
 *
 * Reversible by construction: it presses the picker and then closes the menu,
 * never an item, and it reports the picker's own text before and after so a
 * mistake would show up rather than pass unnoticed.
 *
 * Usage: node spike/menu-items.mjs [model|mode] [threadId]
 */
import { CursorCdp } from '../src/core/cursor-cdp.mjs';

const which = process.argv[2] === 'mode' ? 'mode' : 'model';

const cursor = new CursorCdp();
const window = (await cursor.windows()).find((w) => w.hasComposer);
if (!window) {
  console.log('no Cursor window with a chat box');
  process.exit(1);
}
const threadId = process.argv[3] || window.threadId;

const PANE = "document.querySelector('#workbench\\\\.parts\\\\.auxiliarybar') || document";

const PICKER = (kind) =>
  kind === 'mode'
    ? `pane.querySelector('[data-mode]')`
    : `pane.querySelector('.ui-model-picker__trigger-text')?.closest('button')
       || [...pane.querySelectorAll('button[aria-haspopup="menu"]')].pop()`;

/** Everything that looks like an open menu, and what it offers. */
const MENUS = `(() => {
  const groups = [];
  const selectors = [
    '[role="menu"]', '[role="listbox"]', '[role="dialog"]',
    '.context-view', '.monaco-menu', '.quick-input-widget',
    '[data-radix-popper-content-wrapper]', '[data-floating-ui-portal]',
  ];
  const kept = [];
  for (const sel of selectors) {
    for (const el of document.querySelectorAll(sel)) {
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      if (kept.some((k) => k.contains(el) || el.contains(k))) continue;
      kept.push(el);
      const items = [...el.querySelectorAll('[role="menuitem"],[role="menuitemradio"],[role="option"],button,li,a')]
        .map((it) => ({
          tag: it.tagName.toLowerCase(),
          role: it.getAttribute('role') || null,
          text: (it.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 50),
          state: it.getAttribute('aria-checked') ?? it.getAttribute('aria-selected') ?? it.getAttribute('data-state') ?? null,
          attrs: it.getAttributeNames().filter((a) => a !== 'class' && a !== 'style').join(','),
          kids: it.children.length,
        }))
        .filter((it) => it.text);
      groups.push({
        sel,
        cls: String(el.className?.baseVal ?? el.className ?? '').slice(0, 60),
        inPane: Boolean((${PANE})?.contains?.(el)),
        items: items.slice(0, 45),
      });
    }
  }
  return groups;
})()`;

/** The two pickers, by the handles they carry rather than by their words. */
const TRIGGERS = `(() => {
  const pane = ${PANE};
  const say = (el) => el && ({
    text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
    dataMode: el.getAttribute?.('data-mode') ?? null,
    expanded: el.getAttribute?.('aria-expanded') ?? null,
  });
  return { mode: say(pane.querySelector('[data-mode]')), model: say(${PICKER('model')}) };
})()`;

const OPEN = (kind) => `(() => {
  const pane = ${PANE};
  const el = ${PICKER(kind)};
  if (!el) return { pressed: false, reason: 'no such picker' };
  const rect = el.getBoundingClientRect();
  const at = { bubbles: true, cancelable: true, view: window, button: 0, buttons: 1,
    clientX: Math.round(rect.left + rect.width / 2), clientY: Math.round(rect.top + rect.height / 2) };
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    const Ctor = type.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
    el.dispatchEvent(new Ctor(type, type.endsWith('up') ? { ...at, buttons: 0 } : at));
  }
  return { pressed: true, on: (el.textContent || '').trim().slice(0, 30) };
})()`;

const CLOSE = `(() => {
  for (const target of [document.activeElement || document.body, document.body, document]) {
    for (const type of ['keydown', 'keyup']) {
      target.dispatchEvent(new KeyboardEvent(type, { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
    }
  }
  return true;
})()`;

const look = async () => (await cursor.readWindow(threadId, MENUS)) || [];
const show = (groups, when) => {
  console.log(`${when}: ${groups.length} menu container(s)`);
  for (const g of groups) {
    console.log(`  ${g.sel} inPane=${g.inPane} cls=${JSON.stringify(g.cls)} — ${g.items.length} items`);
    for (const it of g.items) {
      console.log(
        `      <${it.tag}${it.role ? ` role=${it.role}` : ''}>${it.state ? ` [${it.state}]` : ''} ${JSON.stringify(it.text)}` +
          `${it.attrs ? `  attrs=[${it.attrs}]` : ''}`,
      );
    }
  }
};

const before = await cursor.readWindow(threadId, TRIGGERS);
console.log(`pickers before: ${JSON.stringify(before)}\n`);
show(await look(), 'before opening');

console.log(`\nopening the ${which} picker: ${JSON.stringify(await cursor.readWindow(threadId, OPEN(which)))}`);
let opened = [];
for (let tries = 0; tries < 8; tries += 1) {
  await new Promise((r) => setTimeout(r, 250));
  opened = await look();
  if (opened.some((g) => g.items.length)) break;
}
console.log('');
show(opened, 'with the menu open');

await cursor.readWindow(threadId, CLOSE);
await new Promise((r) => setTimeout(r, 400));
let after = await look();
if (after.some((g) => g.items.length)) {
  console.log('\nEscape did not close it; pressing the picker again');
  await cursor.readWindow(threadId, OPEN(which));
  await new Promise((r) => setTimeout(r, 400));
  after = await look();
}
console.log('');
show(after, 'after closing');
console.log(`\npickers after: ${JSON.stringify(await cursor.readWindow(threadId, TRIGGERS))}`);

process.exit(0);
