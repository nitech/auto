/**
 * Reaching a chat that is not the one on screen, and tidying up after.
 *
 * The window shows one chat at a time, so a message from a phone for any other
 * conversation used to have nowhere to go. This sends to a background chat,
 * checks the message arrived in that chat and not the one that was showing,
 * puts the window back, and closes the scratch tab it borrowed.
 *
 * Usage: node spike/cdp-background-live.mjs <backgroundThreadId> [--close]
 */
import { CursorCdp } from '../src/core/cursor-cdp.mjs';
import { readThread } from '../src/core/desktop-threads.mjs';

const other = process.argv[2];
const closing = process.argv.includes('--close');
if (!other) throw new Error('need the id of a chat in a background tab');

const cursor = new CursorCdp();
const say = (step, detail) => console.log(`${step.padEnd(24)} ${detail}`);
const text = `Auto background check ${new Date().toISOString()} — no reply needed`;

const home = (await cursor.windows()).find((w) => w.hasComposer)?.threadId;
say('showing', home);
say('sending to', other);

const sent = await cursor.sendText({ threadId: other, text, bringForward: true });
say('sent', JSON.stringify(sent));

const landed = readThread(other, { tail: 3 })?.messages || [];
say('arrived in that chat', String(landed.some((m) => String(m.text || '').includes('background check'))));
const mine = readThread(home, { tail: 3 })?.messages || [];
say('leaked into this one', String(mine.some((m) => String(m.text || '').includes('background check'))));

// Forced, because putting a window back where it was found should not be
// stoppable by whatever happens to be in a chat box.
say('back home', JSON.stringify(await cursor.showThread({ threadId: home, force: true })));
say('showing now', (await cursor.windows()).find((w) => w.hasComposer)?.threadId);

if (closing) {
  // Close the borrowed chat's tab by its id, so no stray tab is left behind.
  const closed = await cursor.readWindow(
    home,
    `(() => {
      const pane = document.querySelector('#workbench\\\\.parts\\\\.auxiliarybar') || document;
      const tab = pane.querySelector('[data-resource-name="${other}"]');
      if (!tab) return 'no tab';
      const shut = tab.querySelector('.codicon-close, [aria-label^="Close"]');
      if (!shut) return 'no close button';
      const rect = shut.getBoundingClientRect();
      const at = { bubbles: true, cancelable: true, view: window, button: 0,
        clientX: Math.round(rect.left + rect.width / 2), clientY: Math.round(rect.top + rect.height / 2) };
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        shut.dispatchEvent(new MouseEvent(type, at));
      }
      return 'pressed';
    })()`,
  );
  say('closing that tab', String(closed));
  await new Promise((r) => setTimeout(r, 800));
  const left = await cursor.readWindow(
    home,
    `[...document.querySelectorAll('[data-resource-name]')].map((el) => el.getAttribute('data-resource-name'))`,
  );
  say('tabs left', JSON.stringify(left));
}

process.exit(0);
