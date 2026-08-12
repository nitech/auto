/**
 * Can an image be got into Cursor's chat box from outside?
 *
 * Cursor's composer takes a pasted image — that is how a person attaches a
 * screenshot. There is no CDP command for "attach a file", but Blink will run an
 * editing command on a key event, so this puts a picture on the Windows clipboard
 * and asks the window to paste. If the box shows a thumbnail afterwards, 3e is a
 * clipboard away; if it does not, the answer is a file path in the message.
 *
 * Uses a scratch chat and sends nothing. The clipboard is Windows-wide, so this
 * does trample whatever was on it — that is the cost this spike is here to weigh.
 *
 * Usage: node spike/paste-image.mjs
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CursorCdp, CursorWindow } from '../src/core/cursor-cdp.mjs';

const NEW_CHAT = 'New Agent (Ctrl+N) [Alt] Replace Agent';

/** A 2x2 red PNG, written by hand so the spike needs nothing on disk. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8Dwn4GBgYEBAwMDAA' +
    'EEAgAB9wUmAAAAAElFTkSuQmCC',
  'base64',
);
const file = join(tmpdir(), 'auto-paste-test.png');
writeFileSync(file, PNG);

/** What the chat box is holding, attachments included. */
const BOX = `(() => {
  const pane = document.querySelector('#workbench\\\\.parts\\\\.auxiliarybar') || document;
  const box = pane.querySelector("div.aislash-editor-input[contenteditable='true']");
  const near = box?.closest('div[class*="composer"], form, section') || pane;
  return {
    text: (box?.textContent || '').trim().slice(0, 60),
    images: near.querySelectorAll('img').length,
    thumbs: [...near.querySelectorAll('[class*="image"], [class*="attach"], [class*="thumb"], [class*="pill"]')]
      .map((el) => ({
        cls: String(el.className?.baseVal ?? el.className ?? '').slice(0, 50),
        text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 30),
      }))
      .slice(0, 8),
  };
})()`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const cursor = new CursorCdp();
const say = (step, detail) => console.log(`${step.padEnd(22)} ${detail}`);

execFileSync('powershell.exe', [
  '-NoProfile',
  '-Sta',
  '-Command',
  `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; ` +
    `$img=[System.Drawing.Image]::FromFile('${file}'); ` +
    `[System.Windows.Forms.Clipboard]::SetImage($img); ` +
    `Write-Output ([System.Windows.Forms.Clipboard]::ContainsImage())`,
]);
say('clipboard', 'holds an image');

const home = (await cursor.windows()).find((w) => w.hasComposer)?.threadId;
say('window was showing', String(home));
say('new chat', JSON.stringify(await cursor.press({ threadId: home, name: NEW_CHAT })));
await wait(1500);

const targets = (await (await fetch('http://127.0.0.1:9222/json')).json()).filter(
  (t) => t.type === 'page' && /workbench/i.test(String(t.url || '')),
);
let scratch = null;
for (const target of targets) {
  const window = await CursorWindow.open(target);
  try {
    const facts = await window.facts();
    if (!facts?.hasComposer || facts.threadId === home) continue;
    scratch = facts.threadId;
    say('scratch chat', String(scratch));

    say('box before', JSON.stringify(await window.evaluate(BOX)));
    await window.focusComposer();

    // Blink runs an editing command named on a key event; there is no other way
    // to ask a page to paste.
    await window.socket.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'v',
      code: 'KeyV',
      windowsVirtualKeyCode: 86,
      modifiers: 2,
      commands: ['paste'],
    });
    await window.socket.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'v',
      code: 'KeyV',
      windowsVirtualKeyCode: 86,
      modifiers: 2,
    });

    for (let look = 0; look < 8; look += 1) {
      await wait(400);
      const seen = await window.evaluate(BOX);
      if (seen.images || seen.thumbs.length) {
        say(`box after ${look}`, JSON.stringify(seen));
        break;
      }
      if (look === 7) say('box after', JSON.stringify(seen));
    }

    await window.clearComposer();
  } finally {
    window.close();
  }
  break;
}

if (scratch) {
  say('back home', JSON.stringify(await cursor.showThread({ threadId: home, force: true })));
  say(
    'scratch tab',
    String(
      await cursor.readWindow(
        home,
        `(() => {
          const pane = document.querySelector('#workbench\\\\.parts\\\\.auxiliarybar') || document;
          const close = pane.querySelector('[data-resource-name="${scratch}"]')
            ?.querySelector('.codicon-close, [aria-label^="Close"]');
          if (!close) return 'no close button';
          close.click();
          return 'closed';
        })()`,
      ),
    ),
  );
}

process.exit(0);
