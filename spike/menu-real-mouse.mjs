/**
 * Open Cursor's model or mode menu with a real mouse, and see what appears.
 *
 * A dispatched click did nothing: the dropdowns open on input the window trusts.
 * So this asks the page where the picker is, presses that point through the
 * debug port as a mouse would, and reports whatever became visible — wherever it
 * turns out to live.
 *
 * Reversible: the picker and Escape only, never an item. The chat's own model
 * and mode are printed before and after.
 *
 * Usage: node spike/menu-real-mouse.mjs [model|mode] [threadId]
 */
import { CursorWindow } from '../src/core/cursor-cdp.mjs';

const which = process.argv[2] === 'mode' ? 'mode' : 'model';
const wanted = process.argv[3] || null;

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const pages = targets.filter((t) => t.type === 'page' && /workbench/i.test(String(t.url || '')));

const PANE = "document.querySelector('#workbench\\\\.parts\\\\.auxiliarybar') || document";

/** Where the picker is, in page coordinates, and what it currently says. */
const WHERE = (kind) => `(() => {
  const pane = ${PANE};
  let el = null;
  if (${kind === 'mode'}) {
    const box = pane.querySelector('[data-mode]');
    if (box) {
      const want = (box.getAttribute('data-mode') || '').toLowerCase();
      const said = (e) => (e.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const hits = [...box.querySelectorAll('*')].filter((e) => said(e) === want);
      el = hits.find((e) => !hits.some((o) => o !== e && o.contains(e))) || box;
    }
  } else {
    el = pane.querySelector('.ui-model-picker__trigger-text')?.closest('button')
      || [...pane.querySelectorAll('button[aria-haspopup="menu"]')].pop() || null;
  }
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return {
    text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
    x: r.left + r.width / 2,
    y: r.top + r.height / 2,
  };
})()`;

const SETTINGS = `(() => {
  const pane = ${PANE};
  return {
    mode: pane.querySelector('[data-mode]')?.getAttribute('data-mode') ?? null,
    model: (pane.querySelector('.ui-model-picker__trigger-text')?.textContent || '').trim(),
  };
})()`;

const REMEMBER = `(() => { window.__auto = { before: new Set(document.querySelectorAll('*')) }; return window.__auto.before.size; })()`;

const APPEARED = `(() => {
  const before = window.__auto?.before || new Set();
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const say = (el) => ({
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute('role') || null,
    cls: String(el.className?.baseVal ?? el.className ?? '').slice(0, 60),
    attrs: el.getAttributeNames().filter((a) => a !== 'class' && a !== 'style').join(','),
    text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 55),
    state: el.getAttribute('aria-checked') ?? el.getAttribute('aria-selected') ?? el.getAttribute('data-state') ?? null,
    atBody: el.parentElement === document.body,
    kids: el.children.length,
  });
  const fresh = [...document.querySelectorAll('*')].filter((el) => !before.has(el) && vis(el));
  const roots = fresh.filter((el) => !fresh.some((o) => o !== el && o.contains(el)));
  return {
    total: fresh.length,
    roots: roots.map(say),
    leaves: fresh.filter((el) => el.children.length === 0 && (el.textContent || '').trim()).slice(0, 80).map(say),
  };
})()`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

for (const target of pages) {
  const window = await CursorWindow.open(target);
  try {
    const facts = await window.facts();
    if (!facts?.hasComposer) continue;
    if (wanted && facts.threadId !== wanted) continue;
    console.log(`window: ${facts.title} — chat ${facts.threadId}`);
    console.log(`settings before: ${JSON.stringify(await window.evaluate(SETTINGS))}`);

    const where = await window.evaluate(WHERE(which));
    if (!where) {
      console.log(`no ${which} picker in this window`);
      continue;
    }
    console.log(`the ${which} picker says ${JSON.stringify(where.text)} at ${Math.round(where.x)},${Math.round(where.y)}`);
    console.log(`elements remembered: ${await window.evaluate(REMEMBER)}`);

    await window.mouseAt(where);

    let seen = { total: 0, roots: [], leaves: [] };
    for (let look = 0; look < 10; look += 1) {
      await wait(250);
      seen = (await window.evaluate(APPEARED)) || seen;
      if (seen.roots.length) break;
    }

    console.log(`\n${seen.total} new visible elements in ${seen.roots.length} root(s):`);
    for (const r of seen.roots) {
      console.log(
        `  <${r.tag}${r.role ? ` role=${r.role}` : ''}> atBody=${r.atBody} kids=${r.kids}\n` +
          `    cls=${JSON.stringify(r.cls)}\n    attrs=[${r.attrs}]\n    text=${JSON.stringify(r.text)}`,
      );
    }
    console.log(`\ntext-bearing leaves (${seen.leaves.length}):`);
    for (const l of seen.leaves) {
      console.log(`  <${l.tag}${l.role ? ` role=${l.role}` : ''}>${l.state ? ` [${l.state}]` : ''} ${JSON.stringify(l.text)}${l.attrs ? `  attrs=[${l.attrs}]` : ''}`);
    }

    await window.pressEscape();
    await wait(500);
    const left = await window.evaluate(APPEARED);
    console.log(`\nafter Escape: ${left?.roots?.length || 0} root(s) left`);
    console.log(`settings after: ${JSON.stringify(await window.evaluate(SETTINGS))}`);
  } finally {
    window.close();
  }
}

process.exit(0);
