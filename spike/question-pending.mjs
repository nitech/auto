#!/usr/bin/env node
/**
 * What a question looks like *while it is still being asked*.
 *
 * The answered one is easy: Cursor stores the whole thing — prompt, options,
 * selections — in the bubble, and `question-bubble.mjs` reads it back. But by
 * then the question is over. What Auto needs is the question a person has not
 * answered yet, and the one card seen in the wild reached the transcript as a
 * bare `ask_question` with no text at all, while the phone was offered "Skip"
 * and "Continue" and nothing to choose between.
 *
 * So this watches both places at once for as long as it is given: the bubble in
 * Cursor's database, and the card in Cursor's window. It prints only when
 * something changes, so the output is the story of a question appearing, being
 * answered, and closing.
 *
 * Read-only: nothing is clicked, nothing is written.
 *
 * Usage: node spike/question-pending.mjs <threadId> [seconds] [needle]
 */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { CursorCdp } from '../src/core/cursor-cdp.mjs';

const [, , threadId, secondsArg, needle = ''] = process.argv;
if (!threadId) throw new Error('need a thread id');
const until = Date.now() + (Number(secondsArg) || 120) * 1000;

const dbPath = join(process.env.APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
const textOf = (row) => (Buffer.isBuffer(row?.value) ? row.value.toString('utf8') : String(row?.value ?? ''));

/** The newest ask_question bubble in this thread, as Cursor currently has it. */
function fromDatabase() {
  // Reopened every pass: Cursor writes to this file constantly and a held
  // handle reads a snapshot from whenever it was opened.
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const get = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?');
    const data = JSON.parse(textOf(get.get(`composerData:${threadId}`)));
    const headers = data.fullConversationHeadersOnly || [];
    for (const header of [...headers].reverse()) {
      const row = get.get(`bubbleId:${threadId}:${header.bubbleId}`);
      if (!row) continue;
      const tool = JSON.parse(textOf(row)).toolFormerData;
      if ((tool?.name || tool?.tool) !== 'ask_question') continue;
      let questions = null;
      try {
        questions = JSON.parse(tool.params || tool.rawArgs || 'null')?.questions || null;
      } catch {
        /* not written yet, or not JSON yet */
      }
      return {
        bubble: header.bubbleId,
        status: tool.status ?? null,
        additionalData: tool.additionalData ?? null,
        userDecision: tool.userDecision ?? null,
        rawParams: String(tool.params || tool.rawArgs || '').slice(0, 60),
        prompts: questions?.map((q) => q.prompt) || null,
        options: questions?.flatMap((q) => (q.options || []).map((o) => o.label.slice(0, 40))) || null,
      };
    }
    return null;
  } finally {
    db.close();
  }
}

/** The card as it stands in the window, and what looks pressable around it. */
const DOM_PROBE = (want) => `((needle) => {
  const clean = (s) => String(s ?? '').replace(/\\s+/g, ' ').trim();
  const out = { controls: [], card: null, radios: [], textareas: [] };
  const pane = document.querySelector('.pane-body') || document.body;

  for (const el of pane.querySelectorAll('button,[role="button"],[role="radio"],[role="checkbox"],[role="option"],textarea')) {
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const entry = {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || null,
      text: clean(el.textContent).slice(0, 60),
      label: clean(el.getAttribute('aria-label')),
      checked: el.getAttribute('aria-checked'),
      cls: String(el.className?.baseVal ?? el.className ?? '').slice(0, 60),
    };
    if (el.tagName === 'TEXTAREA') out.textareas.push({ ...entry, placeholder: el.placeholder });
    else if (entry.role === 'radio' || entry.role === 'checkbox' || entry.role === 'option') out.radios.push(entry);
    else out.controls.push(entry);
  }

  if (needle) {
    const holder = [...pane.querySelectorAll('div,span,p,li,label')].filter(
      (el) => (el.textContent || '').includes(needle) &&
        ![...el.children].some((k) => (k.textContent || '').includes(needle)),
    )[0];
    if (holder) {
      // Walk out until the element is big enough to be the card rather than a line.
      let el = holder;
      for (let up = 0; up < 10 && el.parentElement; up += 1) {
        el = el.parentElement;
        if (el.getBoundingClientRect().height > 120) break;
      }
      out.card = {
        tag: el.tagName.toLowerCase(),
        cls: String(el.className?.baseVal ?? el.className ?? '').slice(0, 80),
        attrs: el.getAttributeNames().filter((a) => a !== 'class' && a !== 'style').slice(0, 8),
        messageId: el.closest('[data-message-id]')?.getAttribute('data-message-id') || null,
        text: clean(el.textContent).slice(0, 300),
      };
    }
  }
  return out;
})(${JSON.stringify(want)})`;

const cursor = new CursorCdp();
let last = '';
console.log(`watching thread ${threadId} for ${Math.round((until - Date.now()) / 1000)}s\n`);

while (Date.now() < until) {
  let db = null;
  let dom = null;
  try {
    db = fromDatabase();
  } catch (e) {
    db = { error: e.message };
  }
  try {
    dom = await cursor.readWindow(threadId, DOM_PROBE(needle));
  } catch (e) {
    dom = { error: e.message };
  }

  const shot = JSON.stringify({ db, dom });
  if (shot !== last) {
    last = shot;
    console.log(`=== ${new Date().toLocaleTimeString()}`);
    console.log(`  db : ${JSON.stringify(db)}`);
    console.log(`  dom: ${JSON.stringify(dom)}\n`);
  }
  await new Promise((r) => setTimeout(r, 2000));
}

console.log('done');
process.exit(0);
