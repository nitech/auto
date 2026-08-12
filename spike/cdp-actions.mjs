/**
 * Does Auto see what the chat is offering, and does pressing it work?
 *
 * Approvals cannot be conjured on demand — Cursor only asks when its own
 * settings say to, and here they say run everything. So the press itself is
 * proved on the most harmless control in the chat: a "Thought for 3s" header,
 * which does nothing but fold and unfold. If a click reaches Cursor's handlers
 * there, it will reach an approval's.
 *
 * The header is put back the way it was found.
 *
 * Usage: node spike/cdp-actions.mjs [--press]
 */
import { CursorCdp } from '../src/core/cursor-cdp.mjs';

const pressing = process.argv.includes('--press');
const cursor = new CursorCdp();

/** Collapsible headers and whether each is open, straight from the window. */
const HEADERS = `[...document.querySelectorAll('.ui-collapsible-header')].map((el) => ({
  text: (el.textContent || '').replace(/\\s+/g, ' ').trim().replace(/(.{3,}?)\\1$/, '$1').slice(0, 40),
  expanded: el.getAttribute('aria-expanded'),
}))`;

for (const window of await cursor.windows()) {
  if (!window.hasComposer) continue;
  console.log(`\n=== ${window.title} — chat ${window.threadId}`);

  const state = await cursor.waitingOn({ threadId: window.threadId });
  console.log(`  a turn is running : ${state.generating}`);
  console.log(`  waiting on a person: ${state.asking?.length ? '' : 'nothing'}`);
  for (const c of state.asking || []) console.log(`    ${JSON.stringify(c.label || c.text)} (${c.where})`);
  console.log(`  controls it offers (${state.controls?.length || 0}):`);
  for (const c of state.controls || []) {
    console.log(`    ${c.where.padEnd(10)} ${JSON.stringify(c.label || c.text)}${c.disabled ? ' — disabled' : ''}`);
  }

  if (!pressing) continue;

  // Fold and unfold a thinking block: visible, reversible, harmless.
  const before = await cursor.press({ threadId: window.threadId, name: 'x-not-a-control' });
  console.log(`\n  pressing something that does not exist: ${before.status} (${before.reason || ''})`);

  const headers = await cursor.readWindow(window.threadId, HEADERS);
  if (!headers?.length) {
    console.log('  no thinking block on screen to press');
    continue;
  }
  const target = headers[headers.length - 1];
  console.log(`  thinking block    : ${JSON.stringify(target.text)} expanded=${target.expanded}`);

  const pressed = await cursor.press({ threadId: window.threadId, name: target.text });
  console.log(`  pressed           : ${JSON.stringify(pressed)}`);

  const after = (await cursor.readWindow(window.threadId, HEADERS))?.at(-1);
  console.log(`  now               : expanded=${after?.expanded}`);
  console.log(`  the click landed  : ${after?.expanded !== target.expanded}`);

  // Put it back.
  await cursor.press({ threadId: window.threadId, name: target.text });
  const restored = (await cursor.readWindow(window.threadId, HEADERS))?.at(-1);
  console.log(`  restored          : expanded=${restored?.expanded}`);
}

process.exit(0);
