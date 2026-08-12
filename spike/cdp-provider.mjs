/**
 * Two ways to stop a turn, weighed up.
 *
 * The window has no command API, but it does carry a composer provider on the
 * global object. If that exposes something like "abort", stopping a turn could
 * be asked for directly instead of by finding a widget and pressing it — worth
 * knowing before choosing. What it must not become is a dependency on private
 * state we cannot see the shape of, so this only looks.
 *
 * Also re-lists the pressable things around the chat box, without the filter
 * that hid all of them last time.
 *
 * Read-only.
 */
import { CursorCdp, CursorWindow } from '../src/core/cursor-cdp.mjs';

const PROVIDER = `(() => {
  const seen = [];
  const describe = (value, depth = 0, path = '') => {
    if (depth > 2 || seen.length > 120) return;
    if (!value || typeof value !== 'object') return;
    for (const key of Object.keys(value)) {
      let child;
      try {
        child = value[key];
      } catch {
        continue;
      }
      const type = typeof child;
      if (type === 'function') seen.push({ path: path + '.' + key, type: 'fn' });
      else if (type === 'object' && child) {
        seen.push({ path: path + '.' + key, type: Array.isArray(child) ? 'array' : 'object' });
        describe(child, depth + 1, path + '.' + key);
      } else if (/^(bool|number|string)/.test(type)) {
        seen.push({ path: path + '.' + key, type, value: String(child).slice(0, 40) });
      }
    }
  };

  const provider = globalThis.__SSG_COMPOSER_PROVIDER__;
  if (!provider) return { present: false };
  describe(provider, 0, '');
  return {
    present: true,
    kind: typeof provider,
    interesting: seen.filter((s) => /abort|stop|cancel|send|submit|generat|model|mode|approve|accept|reject/i.test(s.path)),
    count: seen.length,
    top: Object.keys(provider).slice(0, 30),
  };
})()`;

const REGION = `(() => {
  const pane = document.querySelector('#workbench\\\\.parts\\\\.auxiliarybar') || document;
  const box = pane.querySelector("div.aislash-editor-input[contenteditable='true']");
  if (!box) return { error: 'no chat box' };
  // Not every className is a string: SVG elements hand back an object.
  const clean = (s) => String(s ?? '').replace(/\\s+/g, ' ').trim().slice(0, 50);

  // Walk up until the container is clearly more than the box itself.
  let root = box;
  while (root.parentElement && root.getBoundingClientRect().height < 140) root = root.parentElement;

  const items = [];
  for (const el of root.querySelectorAll('*')) {
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const style = getComputedStyle(el);
    if (!(style.cursor === 'pointer' || el.tagName === 'BUTTON' || el.getAttribute('role') === 'button')) continue;
    items.push({
      tag: el.tagName.toLowerCase(),
      text: clean(el.textContent),
      label: clean(el.getAttribute('aria-label') || el.getAttribute('title')),
      icon: clean(el.getAttribute('data-icon-name')),
      cls: clean(el.className.baseVal ?? el.className),
    });
  }
  return { items, rootHeight: Math.round(root.getBoundingClientRect().height) };
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

    const provider = await window.evaluate(PROVIDER);
    console.log(`  composer provider: ${JSON.stringify(provider.present ? provider.kind : false)}`);
    if (provider.present) {
      console.log(`    keys: ${provider.top?.join(', ')}`);
      console.log(`    walked ${provider.count} paths, of interest:`);
      for (const i of provider.interesting || []) {
        console.log(`      ${i.type.padEnd(6)} ${i.path}${i.value ? ` = ${i.value}` : ''}`);
      }
    }

    const region = await window.evaluate(REGION);
    console.log(`\n  around the chat box (container ${region.rootHeight}px):`);
    for (const i of region.items || []) {
      console.log(
        `    ${i.tag.padEnd(6)} ${JSON.stringify(i.label || i.text || i.icon).padEnd(26)} ${i.cls}`,
      );
    }
  } catch (err) {
    console.log(`  failed: ${err.message}`);
  } finally {
    window.close();
  }
}

process.exit(0);
