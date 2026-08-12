/**
 * The shape of the two pickers, and of the rows in the model menu.
 *
 * Two things to settle: which child of the mode dropdown is the part to press
 * (finding it by structure failed where finding it by its words worked), and
 * what marks a row in the model menu, since reading it as "whatever holds text"
 * pulled in every wrapper around every row.
 *
 * Read-only apart from opening the model menu, which Escape closes.
 *
 * Usage: node spike/picker-shape.mjs
 */
import { CursorWindow } from '../src/core/cursor-cdp.mjs';

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const pages = targets.filter((t) => t.type === 'page' && /workbench/i.test(String(t.url || '')));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const PANE = "document.querySelector('#workbench\\\\.parts\\\\.auxiliarybar') || document";

const MODE_BOX = `(() => {
  const pane = ${PANE};
  const box = pane.querySelector('[data-mode]');
  if (!box) return 'no [data-mode] element';
  const say = (el, depth) => {
    const r = el.getBoundingClientRect();
    return {
      depth,
      tag: el.tagName.toLowerCase(),
      cls: String(el.className?.baseVal ?? el.className ?? '').slice(0, 50),
      text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
      w: Math.round(r.width), h: Math.round(r.height),
      x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
    };
  };
  const out = [say(box, 0)];
  const walk = (el, depth) => {
    if (depth > 4) return;
    for (const kid of el.children) { out.push(say(kid, depth)); walk(kid, depth + 1); }
  };
  walk(box, 1);
  return { dataMode: box.getAttribute('data-mode'), tree: out };
})()`;

const MODEL_ROWS = `(() => {
  const menu = [...document.querySelectorAll('[role="menu"]')].find((el) => el.getBoundingClientRect().height > 0);
  if (!menu) return 'no open menu';
  const marked = [...menu.querySelectorAll('[role],[data-testid],[data-state],[aria-checked]')].map((el) => {
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role'),
      testid: el.getAttribute('data-testid'),
      state: el.getAttribute('data-state') ?? el.getAttribute('aria-checked'),
      text: (el.textContent || '').replace(/[\\u200b\\s]+/g, ' ').trim().slice(0, 45),
      h: Math.round(r.height),
      y: Math.round(r.top),
    };
  }).filter((d) => d.h > 0);
  return { items: marked.slice(0, 40) };
})()`;

const MODEL_PICKER_AT = `(() => {
  const pane = ${PANE};
  const el = pane.querySelector('.ui-model-picker__trigger-text')?.closest('button');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`;

for (const target of pages) {
  const window = await CursorWindow.open(target);
  try {
    const facts = await window.facts();
    if (!facts?.hasComposer) continue;

    console.log('=== the mode dropdown, child by child\n');
    const box = await window.evaluate(MODE_BOX);
    if (typeof box === 'string') console.log(`  ${box}`);
    else {
      console.log(`  data-mode = ${JSON.stringify(box.dataMode)}\n`);
      for (const n of box.tree) {
        console.log(
          `${'  '.repeat(n.depth + 1)}<${n.tag}> ${n.w}x${n.h} at ${n.x},${n.y} ${JSON.stringify(n.text)} cls=${JSON.stringify(n.cls)}`,
        );
      }
    }

    console.log('\n=== rows in the model menu\n');
    const at = await window.evaluate(MODEL_PICKER_AT);
    if (at) {
      await window.mouseAt(at);
      let rows = 'no open menu';
      for (let look = 0; look < 8 && typeof rows === 'string'; look += 1) {
        await wait(250);
        rows = await window.evaluate(MODEL_ROWS);
      }
      if (typeof rows === 'string') console.log(`  ${rows}`);
      else {
        for (const it of rows.items) {
          console.log(
            `  <${it.tag}${it.role ? ` role=${it.role}` : ''}${it.testid ? ` testid=${it.testid}` : ''}>` +
              `${it.state ? ` [${it.state}]` : ''} h=${it.h} y=${it.y} ${JSON.stringify(it.text)}`,
          );
        }
      }
      await window.pressEscape();
    }
  } finally {
    window.close();
  }
}

process.exit(0);
