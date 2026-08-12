/**
 * The rows inside Cursor's model and mode menus.
 *
 * Both menus open to a real mouse press. This reads what is in them — the rows,
 * what marks the current one, and where each row is — so that choosing one can
 * be built on what is there rather than on a guess. The model menu is the
 * awkward one: a row carries the model's name and its variants together.
 *
 * Reversible: opens the menu, reads it, presses Escape.
 *
 * Usage: node spike/menu-contents.mjs [model|mode]
 */
import { CursorWindow } from '../src/core/cursor-cdp.mjs';

const which = process.argv[2] === 'mode' ? 'mode' : 'model';

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const pages = targets.filter((t) => t.type === 'page' && /workbench/i.test(String(t.url || '')));

const PANE = "document.querySelector('#workbench\\\\.parts\\\\.auxiliarybar') || document";

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
  return { text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40), x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`;

/** Whatever menu is open, described as a shallow tree of rows. */
const CONTENTS = `(() => {
  const menus = [...document.querySelectorAll('[role="menu"], .typeahead-popover')]
    .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  const say = (el, depth) => ({
    depth,
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute('role') || null,
    cls: String(el.className?.baseVal ?? el.className ?? '').replace(/ui-[a-z0-9]{4,} ?/g, '').slice(0, 45),
    attrs: el.getAttributeNames().filter((a) => !/^(class|style|id|aria-labelledby)$/.test(a)).slice(0, 6).join(','),
    text: (el.textContent || '').replace(/[\\u200b\\s]+/g, ' ').trim().slice(0, 50),
    state: el.getAttribute('aria-checked') ?? el.getAttribute('aria-selected') ?? el.getAttribute('data-state') ?? null,
    kids: el.children.length,
    y: Math.round(el.getBoundingClientRect().top),
    x: Math.round(el.getBoundingClientRect().left),
    w: Math.round(el.getBoundingClientRect().width),
  });
  const walk = (el, depth, out) => {
    if (depth > 8) return out;
    for (const kid of el.children) {
      const r = kid.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) out.push(say(kid, depth));
      walk(kid, depth + 1, out);
    }
    return out;
  };
  return menus.map((m) => ({ menu: say(m, 0), rows: walk(m, 1, []).slice(0, 120) }));
})()`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

for (const target of pages) {
  const window = await CursorWindow.open(target);
  try {
    const facts = await window.facts();
    if (!facts?.hasComposer) continue;

    const where = await window.evaluate(WHERE(which));
    if (!where) continue;
    await window.mouseAt(where);

    let menus = [];
    for (let look = 0; look < 10 && !menus.length; look += 1) {
      await wait(250);
      menus = (await window.evaluate(CONTENTS)) || [];
    }

    for (const { menu, rows } of menus) {
      console.log(`menu <${menu.tag} role=${menu.role}> cls=${JSON.stringify(menu.cls)} attrs=[${menu.attrs}] at ${menu.x},${menu.y} w=${menu.w}\n`);
      for (const row of rows) {
        if (!row.text && !row.role) continue;
        console.log(
          `${'  '.repeat(row.depth)}<${row.tag}${row.role ? ` role=${row.role}` : ''}>` +
            `${row.state ? ` [${row.state}]` : ''} y=${row.y} w=${row.w} kids=${row.kids} ` +
            `${JSON.stringify(row.text)}${row.attrs ? ` attrs=[${row.attrs}]` : ''}${row.cls ? ` cls=${JSON.stringify(row.cls)}` : ''}`,
        );
      }
      console.log('');
    }

    await window.pressEscape();
    await wait(400);
    console.log(`menus still open after Escape: ${((await window.evaluate(CONTENTS)) || []).length}`);
  } finally {
    window.close();
  }
}

process.exit(0);
