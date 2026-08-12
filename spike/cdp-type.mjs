/**
 * Can we put text into Cursor's composer over CDP, and does the editor accept
 * it as if it were typed?
 *
 * This is the question the whole approach rests on. Cursor's chat box is a rich
 * text editor with its own model of the document, so writing to the DOM is not
 * enough — it has to arrive through the input pipeline the editor listens to.
 *
 * Deliberately harmless: it focuses the box, inserts a marker, reads back what
 * the editor thinks it now holds, and clears it again. Enter is never pressed,
 * so nothing is sent to any agent, and the box is emptied even if a step fails.
 *
 * Usage: node spike/cdp-type.mjs [port]
 */
import { WebSocket } from 'ws';

const PORT = Number(process.argv[2] || 9222);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const MARKER = `auto-cdp-check-${Date.now()}`;

/** The composer, as this build of Cursor renders it. */
const BOX = "#workbench\\.parts\\.auxiliarybar div.aislash-editor-input[contenteditable='true']";

class Cdp {
  #ws;
  #id = 0;
  #pending = new Map();

  static async open(wsUrl) {
    const cdp = new Cdp();
    cdp.#ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      cdp.#ws.once('open', resolve);
      cdp.#ws.once('error', reject);
    });
    cdp.#ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      const waiting = cdp.#pending.get(msg.id);
      if (!waiting) return;
      cdp.#pending.delete(msg.id);
      if (msg.error) waiting.reject(new Error(msg.error.message));
      else waiting.resolve(msg.result || {});
    });
    return cdp;
  }

  send(method, params = {}, timeoutMs = 10_000) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || 'evaluation failed');
    }
    return res.result?.value;
  }

  key(type, key, code, keyCode, modifiers = 0) {
    return this.send('Input.dispatchKeyEvent', {
      type,
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers,
    });
  }

  async press(key, code, keyCode, modifiers = 0) {
    await this.key('keyDown', key, code, keyCode, modifiers);
    await this.key('keyUp', key, code, keyCode, modifiers);
  }

  close() {
    this.#ws?.close();
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const readBox = (cdp) =>
  cdp.eval(`(document.querySelector(${JSON.stringify(BOX)})?.textContent || '').trim()`);

const targets = await fetch(`${ORIGIN}/json`, { signal: AbortSignal.timeout(4000) })
  .then((r) => r.json())
  .catch(() => null);

if (!targets) {
  console.log(`No CDP on ${ORIGIN}. Start Cursor with --remote-debugging-port=${PORT}.`);
  process.exit(1);
}

const page = targets.find(
  (t) => t.type === 'page' && String(t.url).includes('workbench') && !/Agents/.test(t.title),
);
if (!page) {
  console.log('No Cursor workbench window found.');
  process.exit(1);
}

console.log(`window: ${page.title}`);
const cdp = await Cdp.open(page.webSocketDebuggerUrl);

try {
  const before = await readBox(cdp);
  console.log(`composer before : ${JSON.stringify(before)}`);
  if (before) {
    console.log('There is already text in the box — leaving it alone.');
    process.exit(0);
  }

  // Focus through the page, then type through the browser's own input pipeline:
  // the editor listens for real input events, not for DOM edits.
  const focused = await cdp.eval(`
    (() => {
      const el = document.querySelector(${JSON.stringify(BOX)});
      if (!el) return false;
      el.focus();
      return document.activeElement === el;
    })()
  `);
  console.log(`focused         : ${focused}`);

  await cdp.send('Input.insertText', { text: MARKER });
  await wait(150);

  const after = await readBox(cdp);
  const ok = after.includes(MARKER);
  console.log(`composer after  : ${JSON.stringify(after)}`);
  console.log(`editor took it  : ${ok}`);

  // Whatever happened, do not leave anything behind: select all, delete.
  await cdp.press('a', 'KeyA', 65, 2);
  await cdp.press('Backspace', 'Backspace', 8);
  await wait(150);
  const cleared = await readBox(cdp);
  console.log(`composer cleared: ${JSON.stringify(cleared)} (${cleared === '' ? 'clean' : 'NOT CLEAN'})`);
  console.log(`\nverdict: ${ok && cleared === '' ? 'CDP can type into Cursor and tidy up after itself' : 'needs work'}`);
} finally {
  cdp.close();
}

process.exit(0);
