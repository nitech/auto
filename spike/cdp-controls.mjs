/**
 * Every control Cursor's chat is offering, and where it sits.
 *
 * Phase 2 is about pressing things rather than typing: stopping a turn,
 * answering an approval. Both are buttons that exist only while the chat is in
 * a particular state, so they have to be caught in the act — hence the watch
 * mode, which reports what appears and disappears while something is running.
 *
 * Read-only: nothing is clicked.
 *
 *   node spike/cdp-controls.mjs            once
 *   node spike/cdp-controls.mjs --watch 20 for twenty seconds
 */
import { CursorCdp, CursorWindow } from '../src/core/cursor-cdp.mjs';

const seconds = Number(process.argv[process.argv.indexOf('--watch') + 1]) || 0;
const watching = process.argv.includes('--watch');

/**
 * Anything a person could press, described by what they would see.
 *
 * The chat is split into the transcript and the box you type in; a control's
 * side of that line says a lot about what it does, so it is reported.
 */
const CONTROLS = `(() => {
  const pane = document.querySelector('#workbench\\\\.parts\\\\.auxiliarybar') || document;
  const box = pane.querySelector("div.aislash-editor-input[contenteditable='true']");
  const boxTop = box ? box.getBoundingClientRect().top : Infinity;
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim().slice(0, 70);

  const found = [];
  for (const el of pane.querySelectorAll("button, [role='button'], a[href='#']")) {
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    found.push({
      text: clean(el.textContent),
      label: clean(el.getAttribute('aria-label') || el.getAttribute('title')),
      cls: clean(el.className),
      where: rect.top >= boxTop ? 'composer' : 'transcript',
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      expanded: el.getAttribute('aria-expanded'),
      kbd: clean(el.getAttribute('data-keybinding') || ''),
    });
  }

  // Anything that looks like it is waiting for an answer, by the words on it.
  const WAITING = /^(run|run command|run anyway|accept|accept all|reject|reject all|skip|allow|allow once|always allow|deny|approve|continue|resume|stop|cancel|keep|undo|apply|move on|yes|no)\\b/i;
  return {
    turn: {
      // What the send button has become is the clearest sign of a live turn.
      generating: Boolean(pane.querySelector("[class*='stop'], [aria-label*='Stop'], [aria-label*='stop']")),
    },
    waiting: found.filter((c) => !c.disabled && (WAITING.test(c.text) || WAITING.test(c.label))),
    all: found,
  };
})()`;

const cursor = new CursorCdp();
const targets = (await cursor.listTargets()).filter(
  (t) => t.type === 'page' && /workbench/i.test(String(t.url || '')),
);

const show = (c) =>
  `${c.where.padEnd(10)} ${JSON.stringify(c.label || c.text).padEnd(34)} ` +
  `${c.disabled ? 'disabled ' : ''}${c.expanded ? `expanded=${c.expanded} ` : ''}${c.cls}`;

for (const target of targets) {
  const window = await CursorWindow.open(target);
  try {
    const facts = await window.facts();
    if (!facts.hasComposer) continue;
    console.log(`\n=== ${facts.title} — chat ${facts.threadId}`);

    const first = await window.evaluate(CONTROLS);
    console.log(`  a turn is running: ${first.turn.generating}`);
    console.log(`  waiting on an answer: ${first.waiting.length}`);
    for (const c of first.waiting) console.log(`    ${show(c)}`);
    console.log(`  all controls (${first.all.length}):`);
    for (const c of first.all) console.log(`    ${show(c)}`);

    if (!watching) continue;

    // Watch for controls coming and going: approvals and stops are transient.
    console.log(`\n  watching for ${seconds}s…`);
    let previous = new Set(first.all.map((c) => `${c.where}|${c.label}|${c.text}`));
    const until = Date.now() + seconds * 1000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 1000));
      const now = await window.evaluate(CONTROLS);
      const keys = new Set(now.all.map((c) => `${c.where}|${c.label}|${c.text}`));
      for (const c of now.all) {
        const key = `${c.where}|${c.label}|${c.text}`;
        if (!previous.has(key)) console.log(`  + ${show(c)}`);
      }
      for (const key of previous) {
        if (!keys.has(key)) console.log(`  - ${key}`);
      }
      previous = keys;
    }
  } catch (err) {
    console.log(`  failed: ${err.message}`);
  } finally {
    window.close();
  }
}

process.exit(0);
