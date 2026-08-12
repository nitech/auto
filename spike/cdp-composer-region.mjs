/**
 * What is actually in the composer's footer, and does Cursor expose commands?
 *
 * A running turn shows no `button` for stopping, so either the control is a
 * plain element with a handler, or stopping is not a button at all. Two things
 * worth knowing before writing any clicking code:
 *
 *  - every element around the chat box, whatever its tag, with the styling that
 *    marks it as pressable;
 *  - what the window's own `vscode` global offers. If commands can be run by
 *    name, Auto should ask for a command rather than hunt for a widget, which
 *    would survive a redesign that selectors could not.
 *
 * Read-only.
 */
import { CursorCdp, CursorWindow } from '../src/core/cursor-cdp.mjs';

const REGION = `(() => {
  const pane = document.querySelector('#workbench\\\\.parts\\\\.auxiliarybar') || document;
  const box = pane.querySelector("div.aislash-editor-input[contenteditable='true']");
  if (!box) return { error: 'no chat box' };
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim().slice(0, 60);

  // The footer is everything sharing the chat box's container.
  let root = box;
  for (let up = 0; up < 6 && root.parentElement; up += 1) root = root.parentElement;

  const items = [];
  for (const el of root.querySelectorAll('*')) {
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const style = getComputedStyle(el);
    const pressable = style.cursor === 'pointer' || el.tagName === 'BUTTON' || el.getAttribute('role') === 'button';
    if (!pressable) continue;
    if (el.querySelector('[style*="cursor: pointer"], button')) continue;
    items.push({
      tag: el.tagName.toLowerCase(),
      text: clean(el.textContent),
      label: clean(el.getAttribute('aria-label') || el.getAttribute('title')),
      cls: clean(el.className),
      icon: clean(el.getAttribute('data-icon-name')),
      role: el.getAttribute('role'),
    });
  }
  return { items };
})()`;

const GLOBALS = `(() => {
  const out = {};
  const surface = (name, value) => {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return;
    try {
      out[name] = Object.keys(value).slice(0, 40);
    } catch {
      out[name] = ['unreadable'];
    }
  };
  for (const name of ['vscode', 'cursor', 'aiserver', 'monaco']) {
    surface(name, globalThis[name]);
  }
  // Anything on the window that smells like a command runner.
  out.commandish = Object.keys(globalThis).filter((k) => /command|composer|cursor|agent/i.test(k)).slice(0, 40);
  try {
    out.vscodeContext = Object.keys(vscode.context || {}).slice(0, 40);
  } catch (err) {
    out.vscodeContext = [String(err.message)];
  }
  return out;
})()`;

const cursor = new CursorCdp();
for (const target of (await cursor.listTargets()).filter(
  (t) => t.type === 'page' && /workbench/i.test(String(t.url || '')),
)) {
  const window = await CursorWindow.open(target);
  try {
    const facts = await window.facts();
    if (!facts.hasComposer) continue;
    console.log(`\n=== ${facts.title}`);

    const region = await window.evaluate(REGION);
    console.log(`  pressable things around the chat box (${region.items?.length || 0}):`);
    for (const i of region.items || []) {
      console.log(
        `    ${i.tag.padEnd(6)} ${JSON.stringify(i.label || i.text || i.icon).padEnd(28)} ${i.cls}`,
      );
    }

    const globals = await window.evaluate(GLOBALS);
    console.log('\n  window globals:');
    for (const [name, keys] of Object.entries(globals)) {
      console.log(`    ${name}: ${Array.isArray(keys) ? keys.join(', ') : keys}`);
    }
  } catch (err) {
    console.log(`  failed: ${err.message}`);
  } finally {
    window.close();
  }
}

process.exit(0);
