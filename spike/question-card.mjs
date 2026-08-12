/**
 * What a question card looks like in Cursor's window.
 *
 * A question reached a phone as a blank card with unrelated buttons, so nothing
 * about it could be answered. Putting the real options on a phone means pressing
 * the real ones here, and the option labels are sentences — far too long for the
 * approval vocabulary to recognise. So the card has to be found by structure.
 *
 * Read-only: nothing is clicked.
 *
 * Usage: node spike/question-card.mjs "<text on the card>"
 */
import { CursorCdp } from '../src/core/cursor-cdp.mjs';

const needle = process.argv[2] || 'Start where?';

const PROBE = `((needle) => {
  const hits = [];
  // The deepest element holding the text, then walk out to the card around it.
  const holders = [...document.querySelectorAll('div,span,p,button,label,li')].filter(
    (el) => (el.textContent || '').includes(needle) && ![...el.children].some((k) => (k.textContent || '').includes(needle)),
  );
  const describe = (el) => ({
    tag: el.tagName.toLowerCase(),
    cls: String(el.className?.baseVal ?? el.className ?? '').slice(0, 90),
    role: el.getAttribute('role') || null,
    attrs: el.getAttributeNames().filter((a) => a !== 'class' && a !== 'style').slice(0, 8),
    text: (el.textContent || '').trim().slice(0, 70),
    kids: el.children.length,
    pointer: getComputedStyle(el).cursor === 'pointer',
    tabbable: el.tabIndex >= 0,
  });
  for (const holder of holders.slice(0, 2)) {
    const chain = [];
    let el = holder;
    for (let up = 0; up < 8 && el; up += 1) {
      chain.push(describe(el));
      el = el.parentElement;
    }
    // The outermost of that chain is the likeliest card: list what it contains.
    const card = holder.closest('[data-message-id]') || holder.parentElement;
    const inside = [...(card?.querySelectorAll('button,[role="button"],[role="radio"],[role="checkbox"],input,textarea,label') || [])]
      .map(describe)
      .slice(0, 30);
    hits.push({ chain, card: card ? describe(card) : null, inside });
  }
  return hits;
})(${JSON.stringify(needle)})`;

const cursor = new CursorCdp();
const window = (await cursor.windows()).find((w) => w.hasComposer);
if (!window) {
  console.log('no Cursor window with a chat box');
  process.exit(1);
}

const hits = (await cursor.readWindow(window.threadId, PROBE)) || [];
console.log(`elements holding ${JSON.stringify(needle)}: ${hits.length}\n`);
const show = (d, indent = '  ') =>
  console.log(
    `${indent}<${d.tag}${d.role ? ` role=${d.role}` : ''}> ${d.pointer ? 'pointer ' : ''}${d.tabbable ? 'tabbable ' : ''}` +
      `attrs=[${d.attrs.join(',')}] cls=${JSON.stringify(d.cls)} kids=${d.kids}\n${indent}   text=${JSON.stringify(d.text)}`,
  );

for (const hit of hits) {
  console.log('— walking out from the text:');
  hit.chain.forEach((d) => show(d));
  console.log('\n— the card:');
  if (hit.card) show(hit.card);
  console.log(`\n— controls inside it (${hit.inside.length}):`);
  hit.inside.forEach((d) => show(d, '    '));
  console.log('\n');
}

process.exit(0);
