/**
 * Can Auto drive Cursor's own window over the Chrome DevTools Protocol?
 *
 * Cursor is an Electron app, so a window launched with a debugging port hands
 * out a WebSocket into the renderer where its chat actually lives. That is a
 * different proposition from the desktop bridge: the bridge is a feature Cursor
 * can switch off, while the DOM is simply there — and it holds the things the
 * bridge never offered us, notably the approval buttons and the stop button.
 *
 * This only looks. It connects, names the workspace, and reports what it can
 * see: how many messages, which mode and model, whether anything is waiting to
 * be approved. Nothing is clicked and nothing is typed.
 *
 * Cursor must have been started with the port open:
 *
 *   & "$env:LOCALAPPDATA\Programs\cursor\Cursor.exe" --remote-debugging-port=9222
 *
 * Selectors come from reading Cursor's rendered DOM; the same ones are used by
 * len5ky/CursorRemote, which is where the approach was found.
 *
 * Usage: node spike/cdp-probe.mjs [port]
 */
import { WebSocket } from 'ws';

const PORT = Number(process.argv[2] || 9222);
const ORIGIN = `http://127.0.0.1:${PORT}`;

/** The smallest CDP client that can ask a page a question. */
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
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Run a function in the page and get its value back. */
  async run(fn, ...args) {
    const call = `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(', ')})`;
    const res = await this.send('Runtime.evaluate', {
      expression: call,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || 'evaluation failed');
    }
    return res.result?.value;
  }

  close() {
    this.#ws?.close();
  }
}

/**
 * Everything worth knowing about the chat, read in one pass inside the page.
 * Kept as one function because each round trip costs a message.
 */
function survey() {
  const text = (el) => (el?.textContent || '').trim();
  const wrappers = [...document.querySelectorAll('[data-flat-index]')];

  const roles = {};
  for (const w of wrappers) {
    const key = `${w.getAttribute('data-message-role') || '-'}/${w.getAttribute('data-message-kind') || '-'}`;
    roles[key] = (roles[key] || 0) + 1;
  }

  const last = wrappers.at(-1);
  const composer = document.querySelector('.composer-unified-dropdown');

  const waiting = [...document.querySelectorAll('.composer-run-button, .composer-skip-button')].map(
    (b) => ({
      label: text(b) || b.getAttribute('aria-label') || '?',
      kind: b.className.includes('skip') ? 'skip' : 'run',
    }),
  );

  const commands = [...document.querySelectorAll('.composer-terminal-command-expanded-text')].map(
    (el) => text(el).slice(0, 120),
  );

  return {
    workspace: (() => {
      try {
        const uri = vscode.context.configuration().workspace?.uri;
        return uri ? uri.path : null;
      } catch {
        return null;
      }
    })(),
    messages: wrappers.length,
    roles,
    lastMessage: text(last?.querySelector('.markdown-root')).slice(0, 160) || null,
    mode: composer?.getAttribute('data-mode') || null,
    model: text(document.querySelector('.composer-unified-dropdown-model, .ui-model-picker__trigger')) || null,
    thinking: Boolean(document.querySelector('.loading-indicator-v3')),
    activity: text(document.querySelector('span.auxiliary-bar-chat-title')) || null,
    canType: Boolean(
      document.querySelector(
        "#workbench\\.parts\\.auxiliarybar [contenteditable='true'], .composer-bar [contenteditable='true']",
      ),
    ),
    waiting,
    commands,
    chats: [...document.querySelectorAll('.agent-sidebar-cell')].length,
  };
}

const targets = await fetch(`${ORIGIN}/json`, { signal: AbortSignal.timeout(4000) })
  .then((r) => r.json())
  .catch((err) => {
    console.log(`No CDP on ${ORIGIN} (${err.message}).\n`);
    console.log('Cursor has to be started with the port open — quit it, then:\n');
    console.log('  & "$env:LOCALAPPDATA\\Programs\\cursor\\Cursor.exe" --remote-debugging-port=9222\n');
    return null;
  });

if (!targets) process.exit(1);

const pages = targets.filter((t) => t.type === 'page' && String(t.url).includes('workbench'));
console.log(`${pages.length} Cursor window(s) of ${targets.length} target(s)`);

for (const page of pages) {
  console.log(`\n=== ${page.title}`);
  let cdp;
  try {
    cdp = await Cdp.open(page.webSocketDebuggerUrl);
    const state = await cdp.run(survey);
    for (const [key, value] of Object.entries(state)) {
      const shown = typeof value === 'object' ? JSON.stringify(value) : String(value);
      console.log(`  ${key.padEnd(12)} ${shown.slice(0, 300)}`);
    }
  } catch (err) {
    console.log(`  could not read this window: ${err.message}`);
  } finally {
    cdp?.close();
  }
}

process.exit(0);
