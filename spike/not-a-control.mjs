#!/usr/bin/env node
/**
 * What in a chat looks pressable but is not a control.
 *
 * Cursor styles parts of a message with a pointer cursor, and Auto reads
 * anything pointer-styled as something a person could press. That is how a
 * phone came to be offered "Run the test suite" as an approval three times in
 * one turn: it is not a button at all, it is the description written on a shell
 * tool call's card.
 *
 * Excluding the whole card would be wrong — a real "Run"/"Skip" approval lives
 * inside one — so the exclusion has to name the part that carries the prose.
 * This prints every pointer-styled non-button in the transcript with its own
 * classes and its ancestry, which is how to find that name.
 *
 * Read-only: nothing is clicked.
 *
 * Usage: node spike/not-a-control.mjs [threadId]
 */
import { CursorCdp } from '../src/core/cursor-cdp.mjs';

const only = process.argv[2] || null;

const PROBE = String.raw`(() => {
  const pane = document.querySelector('#workbench\.parts\.auxiliarybar') || document;
  const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const names = (el) =>
    String(el.className?.baseVal ?? el.className ?? '')
      .split(' ')
      .filter((c) => /^ui-[a-z][a-z-]{3,}/.test(c));

  const out = [];
  for (const el of pane.querySelectorAll('*')) {
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    // Real buttons are fine; it is the impostors that matter.
    if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') continue;
    if (getComputedStyle(el).cursor !== 'pointer') continue;
    if (el.querySelector('button, [role="button"]')) continue;
    const text = clean(el.textContent).slice(0, 60);
    if (!text) continue;

    const chain = [];
    let up = el;
    for (let i = 0; i < 6 && up; i += 1) {
      const own = names(up);
      chain.push(up.tagName.toLowerCase() + (own.length ? '.' + own.join('.') : ''));
      up = up.parentElement;
    }
    // The auxiliary bar holds a file tree as well as the chat, and a tree of
    // filenames is hundreds of pointer-styled rows saying nothing about this.
    // Cursor's own chat markup is the part with ui- classes on it.
    if (!chain.some((step) => step.includes('.ui-'))) continue;
    out.push({ text, own: names(el), chain });
  }
  return out;
})()`;

const cursor = new CursorCdp();
const windows = (await cursor.windows()).filter((w) => w.hasComposer);
for (const w of windows) {
  if (only && w.threadId !== only) continue;
  const found = (await cursor.readWindow(w.threadId, PROBE)) || [];
  console.log(`\n=== chat ${w.threadId} — ${found.length} pointer-styled non-buttons`);
  for (const f of found) {
    console.log(`  ${JSON.stringify(f.text)}`);
    console.log(`      own: ${f.own.join(' ') || '(no ui- classes)'}`);
    console.log(`      up : ${f.chain.join(' < ')}`);
  }
}

process.exit(0);
