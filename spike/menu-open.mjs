/**
 * Find Cursor's model and mode menus by watching what appears.
 *
 * Guessing at menu selectors found nothing: Cursor's dropdowns are not the
 * workbench's own menus and carry no role anything looks for. So rather than
 * guess again, remember every element in the page, press the picker, and report
 * whatever is there that was not there before. Wherever the menu lives, this
 * finds it.
 *
 * Reversible: pickers and Escape only, never an item, and the picker's own text
 * is reported before and after.
 *
 * Usage: node spike/menu-open.mjs [model|mode] [threadId]
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

/**
 * The mode picker is the outermost thing inside the dropdown that says only the
 * mode, since the container it sits in also holds the model button.
 */
const MODE_TRIGGER = `(() => {
  const box = (${PANE}).querySelector('[data-mode]');
  if (!box) return null;
  const want = (box.getAttribute('data-mode') || '').toLowerCase();
  const said = (el) => (el.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  const hits = [...box.querySelectorAll('*')].filter((el) => said(el) === want);
  return hits.find((el) => !hits.some((o) => o !== el && o.contains(el))) || box;
})()`;

const MODEL_TRIGGER = `(() => {
  const pane = ${PANE};
  return pane.querySelector('.ui-model-picker__trigger-text')?.closest('button')
    || [...pane.querySelectorAll('button[aria-haspopup="menu"]')].pop() || null;
})()`;

const TRIGGER = which === 'mode' ? MODE_TRIGGER : MODEL_TRIGGER;

const REMEMBER = `(() => {
  window.__auto = { before: new Set(document.querySelectorAll('*')) };
  return window.__auto.before.size;
})()`;

const PRESS = `(() => {
  const el = ${TRIGGER};
  if (!el) return { pressed: false, reason: 'no picker found' };
  const rect = el.getBoundingClientRect();
  const at = { bubbles: true, cancelable: true, view: window, button: 0, buttons: 1,
    clientX: Math.round(rect.left + rect.width / 2), clientY: Math.round(rect.top + rect.height / 2) };
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    const Ctor = type.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
    el.dispatchEvent(new Ctor(type, type.endsWith('up') ? { ...at, buttons: 0 } : at));
  }
  return {
    pressed: true,
    tag: el.tagName.toLowerCase(),
    text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
    cls: String(el.className?.baseVal ?? el.className ?? '').slice(0, 60),
  };
})()`;

/** What is on screen now that was not before, described from the outside in. */
const APPEARED = `(() => {
  const before = window.__auto?.before || new Set();
  const say = (el) => ({
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute('role') || null,
    cls: String(el.className?.baseVal ?? el.className ?? '').slice(0, 70),
    attrs: el.getAttributeNames().filter((a) => a !== 'class' && a !== 'style').join(','),
    text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
    state: el.getAttribute('aria-checked') ?? el.getAttribute('aria-selected') ?? el.getAttribute('data-state') ?? null,
    kids: el.children.length,
    pointer: getComputedStyle(el).cursor === 'pointer',
    inPane: Boolean((${PANE})?.contains?.(el)),
    atBody: el.parentElement === document.body,
  });
  const fresh = [...document.querySelectorAll('*')].filter((el) => {
    if (before.has(el)) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  const roots = fresh.filter((el) => !fresh.some((o) => o !== el && o.contains(el)));
  return {
    total: fresh.length,
    roots: roots.map(say),
    // Everything inside the new roots that could plausibly be an item.
    items: roots.flatMap((root) =>
      [...root.querySelectorAll('*')]
        .filter((el) => {
          const text = (el.textContent || '').trim();
          if (!text || el.children.length > 2) return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
        .slice(0, 60)
        .map(say),
    ),
  };
})()`;

const CLOSE = `(() => {
  for (const target of [document.activeElement || document.body, document.body]) {
    for (const type of ['keydown', 'keyup']) {
      target.dispatchEvent(new KeyboardEvent(type, { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
    }
  }
  return true;
})()`;

const SAY = `(() => {
  const pane = ${PANE};
  const el = pane.querySelector('[data-mode]');
  return {
    mode: el?.getAttribute('data-mode') ?? null,
    model: (pane.querySelector('.ui-model-picker__trigger-text')?.textContent || '').trim(),
  };
})()`;

const targetsBefore = (await cursor.windows()).length;
console.log(`settings before: ${JSON.stringify(await cursor.readWindow(threadId, SAY))}`);
console.log(`elements remembered: ${await cursor.readWindow(threadId, REMEMBER)}`);
console.log(`pressing the ${which} picker: ${JSON.stringify(await cursor.readWindow(threadId, PRESS))}\n`);

let seen = { total: 0, roots: [], items: [] };
for (let tries = 0; tries < 8; tries += 1) {
  await new Promise((r) => setTimeout(r, 250));
  seen = (await cursor.readWindow(threadId, APPEARED)) || seen;
  if (seen.roots.length) break;
}

console.log(`${seen.total} new visible elements, in ${seen.roots.length} root(s):`);
for (const r of seen.roots) {
  console.log(
    `  <${r.tag}${r.role ? ` role=${r.role}` : ''}> atBody=${r.atBody} inPane=${r.inPane} kids=${r.kids}\n` +
      `    cls=${JSON.stringify(r.cls)}\n    attrs=[${r.attrs}]\n    text=${JSON.stringify(r.text)}`,
  );
}
console.log(`\nthings inside them that could be items (${seen.items.length}):`);
for (const it of seen.items) {
  if (!it.text) continue;
  console.log(
    `  <${it.tag}${it.role ? ` role=${it.role}` : ''}>${it.state ? ` [${it.state}]` : ''}${it.pointer ? ' pointer' : ''} ` +
      `${JSON.stringify(it.text)}${it.attrs ? `  attrs=[${it.attrs}]` : ''}`,
  );
}

const windowsNow = await cursor.windows();
if (windowsNow.length !== targetsBefore) {
  console.log(`\nthe menu is its own window: ${windowsNow.length} targets, was ${targetsBefore}`);
  for (const w of windowsNow) console.log(`  ${w.title}`);
}

await cursor.readWindow(threadId, CLOSE);
await new Promise((r) => setTimeout(r, 400));
const left = (await cursor.readWindow(threadId, APPEARED)) || {};
console.log(`\nafter Escape: ${left.roots?.length || 0} root(s) left`);
console.log(`settings after: ${JSON.stringify(await cursor.readWindow(threadId, SAY))}`);

process.exit(0);
