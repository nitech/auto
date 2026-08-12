/**
 * Can Auto drive Cursor's own window over the Chrome DevTools Protocol?
 *
 * Cursor is an Electron app, so a window started with a debugging port hands
 * out a WebSocket into the renderer where its chat actually lives. That is a
 * different proposition from the desktop bridge: the bridge is a feature Cursor
 * can switch off, while the rendered UI is simply there — and it holds the
 * things the bridge never offered, notably the approval buttons and the stop
 * button.
 *
 * Two modes, because guessing at another program's markup is how you write
 * something that breaks on its next release:
 *
 *   node spike/cdp-probe.mjs            what we can read right now
 *   node spike/cdp-probe.mjs --discover the chat's actual structure
 *
 * `--discover` reports the attributes, buttons and editors Cursor currently
 * renders, so every selector Auto ends up relying on is one we have seen in
 * this build with our own eyes, and can check again after an update.
 *
 * Cursor must have been started with the port open:
 *
 *   & "$env:LOCALAPPDATA\Programs\cursor\Cursor.exe" --remote-debugging-port=9222
 *
 * Usage: node spike/cdp-probe.mjs [--discover] [port]
 */
import { WebSocket } from 'ws';

const args = process.argv.slice(2);
const DISCOVER = args.includes('--discover');
const PORT = Number(args.find((a) => /^\d+$/.test(a)) || 9222);
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
 * Which workspace is this window on?
 *
 * The window title is decorated and changes with the open editor; the
 * workbench's own configuration is not.
 */
function workspaceOf() {
  try {
    const uri = vscode.context.configuration().workspace?.uri;
    return uri?.path || null;
  } catch {
    return null;
  }
}

/**
 * Describe the chat as Cursor currently renders it.
 *
 * Nothing here assumes a class name. It works outwards from the side bar,
 * counting attributes and listing controls, so the output is a description of
 * this build rather than a guess that happens to pass.
 */
function discover() {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const sidebar =
    document.querySelector('#workbench\\.parts\\.auxiliarybar') ||
    document.querySelector('[class*="composer"]')?.closest('[id]') ||
    document.body;

  const tally = (list) => {
    const counts = {};
    for (const key of list) counts[key] = (counts[key] || 0) + 1;
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([k, n]) => `${k} ×${n}`);
  };

  // Which data-* attributes does the chat hang its structure on?
  const dataAttrs = [];
  for (const el of sidebar.querySelectorAll('*')) {
    for (const attr of el.attributes) {
      if (attr.name.startsWith('data-')) dataAttrs.push(attr.name);
    }
  }

  // Anything clickable, with enough about it to recognise later.
  const controls = [...sidebar.querySelectorAll('button, [role="button"], a[class]')]
    .map((el) => ({
      text: clean(el.textContent).slice(0, 40),
      label: clean(el.getAttribute('aria-label')).slice(0, 40),
      cls: clean(el.className.toString()).split(' ').slice(0, 3).join(' '),
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
    }))
    .filter((c) => c.text || c.label);

  const editors = [...sidebar.querySelectorAll('[contenteditable="true"], textarea, [role="textbox"]')].map(
    (el) => ({
      tag: el.tagName.toLowerCase(),
      cls: clean(el.className.toString()).split(' ').slice(0, 3).join(' '),
      empty: !clean(el.textContent) && !el.value,
    }),
  );

  // Message wrappers, however they are marked.
  const wrappers = [...sidebar.querySelectorAll('[data-flat-index], [data-message-role], [data-message-kind]')];

  return {
    sidebarId: sidebar.id || sidebar.className?.toString?.().slice(0, 60) || '(body)',
    dataAttributes: tally(dataAttrs),
    messageWrappers: wrappers.length,
    messageShapes: tally(
      wrappers.map(
        (w) =>
          `${w.getAttribute('data-message-role') || '-'}/${w.getAttribute('data-message-kind') || '-'}`,
      ),
    ),
    controls: controls.slice(0, 40),
    editors,
    classHints: tally(
      [...sidebar.querySelectorAll('[class]')]
        .flatMap((el) => el.className.toString().split(/\s+/))
        .filter((c) => /plan|terminal|tool|approv|run|skip|accept|reject|stop|loading|thinking/i.test(c)),
    ),
  };
}

/** What Auto would want to show and act on, using what discovery confirmed. */
function survey() {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const wrappers = [...document.querySelectorAll('[data-flat-index]')];
  const byShape = {};
  for (const w of wrappers) {
    const key = `${w.getAttribute('data-message-role') || '-'}/${w.getAttribute('data-message-kind') || '-'}`;
    byShape[key] = (byShape[key] || 0) + 1;
  }

  // Buttons that mean "the agent is waiting for you", found by what they say
  // rather than by class, so a renamed class does not hide an approval.
  const actionable = [...document.querySelectorAll('button, [role="button"]')]
    .map((el) => ({ el, text: clean(el.textContent), label: clean(el.getAttribute('aria-label')) }))
    .filter(({ text, label }) =>
      /^(run|skip|accept|reject|allow|deny|cancel|stop|accept all)\b/i.test(text || label),
    )
    .map(({ text, label }) => text || label);

  const lastProse = [...document.querySelectorAll('.markdown-root')].at(-1);

  return {
    workspace: workspaceOf(),
    messages: wrappers.length,
    shapes: byShape,
    lastProse: clean(lastProse?.textContent).slice(0, 160) || null,
    waitingOn: actionable,
    canType: Boolean(
      document.querySelector(
        "#workbench\\.parts\\.auxiliarybar [contenteditable='true'], .composer-bar [contenteditable='true']",
      ),
    ),
    chats: document.querySelectorAll('.agent-sidebar-cell').length,
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
    const state = await cdp.run(DISCOVER ? discover : survey);
    for (const [key, value] of Object.entries(state)) {
      if (Array.isArray(value) && value.length && typeof value[0] === 'object') {
        console.log(`  ${key}:`);
        for (const item of value) console.log(`    ${JSON.stringify(item)}`);
        continue;
      }
      const shown = typeof value === 'object' ? JSON.stringify(value) : String(value);
      console.log(`  ${key.padEnd(16)} ${shown.slice(0, 400)}`);
    }
  } catch (err) {
    console.log(`  could not read this window: ${err.message}`);
  } finally {
    cdp?.close();
  }
}

process.exit(0);
