import { CursorCdp } from '../src/core/cursor-cdp.mjs';
import { readSettings } from '../src/core/desktop-threads.mjs';

const threadId = '61ce4f3d-9e30-479e-8cd8-ab89836c154d';
const cursor = new CursorCdp();

const dumped = await cursor.readWindow(
  threadId,
  `(() => {
    const pane = document.querySelector('[data-testid="chat-pane"], .composer-pane, body') || document.body;
    const triggers = [...document.querySelectorAll('.ui-model-picker__trigger-text')].map((el) => ({
      text: (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim(),
      visible: !!(el.offsetWidth && el.offsetHeight),
    }));
    const buttons = [...document.querySelectorAll('button[aria-haspopup="menu"]')].slice(-6).map((el) => ({
      text: (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
      aria: el.getAttribute('aria-label'),
    }));
    return { title: document.title, triggers, buttons };
  })()`,
);

console.log(JSON.stringify({ stored: readSettings(threadId), dumped }, null, 2));
process.exit(0);
