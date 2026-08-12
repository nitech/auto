/**
 * Why a brand-new chat has no mode picker.
 *
 * Switching the mode worked in a chat with a conversation in it and found nothing
 * in an empty one, where the window reported no mode at all. Either the chip is
 * not there yet or it is written differently, and the difference decides whether
 * the mode can be set before the first message.
 *
 * Read-only in the new chat; it opens one and closes it again.
 *
 * Usage: node spike/mode-picker-fresh.mjs
 */
import { CursorCdp } from '../src/core/cursor-cdp.mjs';

const NEW_CHAT = 'New Agent (Ctrl+N) [Alt] Replace Agent';

const FOOTER = `(() => {
  const pane = document.querySelector('#workbench\\\\.parts\\\\.auxiliarybar') || document;
  const box = pane.querySelector("div.aislash-editor-input[contenteditable='true']");
  const top = box ? box.getBoundingClientRect().top : 0;
  const say = (el) => ({
    tag: el.tagName.toLowerCase(),
    cls: String(el.className?.baseVal ?? el.className ?? '').slice(0, 55),
    attrs: el.getAttributeNames().filter((a) => a !== 'class' && a !== 'style').join(','),
    text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
  });
  const modeish = [...pane.querySelectorAll('*')].filter((el) => {
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('');
    return /^\\s*(agent|plan|ask|debug|multitask)\\s*$/i.test(own);
  });
  return {
    dataMode: [...pane.querySelectorAll('[data-mode]')].map(say),
    modeWords: modeish.map(say),
    below: [...pane.querySelectorAll('button, [role="button"]')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.height > 0 && r.top >= top;
      })
      .map(say),
  };
})()`;

const cursor = new CursorCdp();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const home = (await cursor.windows()).find((w) => w.hasComposer)?.threadId;
console.log(`window was showing ${home}`);

console.log(`new chat: ${JSON.stringify(await cursor.press({ threadId: home, name: NEW_CHAT }))}`);
await wait(1500);
const scratch = (await cursor.windows()).find((w) => w.hasComposer)?.threadId;
console.log(`scratch chat ${scratch}\n`);
if (!scratch || scratch === home) process.exit(1);

const seen = await cursor.readWindow(scratch, FOOTER);
for (const [name, rows] of Object.entries(seen || {})) {
  console.log(`${name}: ${rows.length}`);
  for (const r of rows) {
    console.log(`  <${r.tag}> ${JSON.stringify(r.text)}\n      cls=${JSON.stringify(r.cls)} attrs=[${r.attrs}]`);
  }
  console.log('');
}

console.log(`back home: ${JSON.stringify(await cursor.showThread({ threadId: home, force: true }))}`);
const shut = await cursor.readWindow(
  home,
  `(() => {
    const pane = document.querySelector('#workbench\\\\.parts\\\\.auxiliarybar') || document;
    const tab = pane.querySelector('[data-resource-name="${scratch}"]');
    const close = tab?.querySelector('.codicon-close, [aria-label^="Close"]');
    if (!close) return 'no close button';
    close.click();
    return 'closed';
  })()`,
);
console.log(`scratch tab: ${shut}`);
process.exit(0);
