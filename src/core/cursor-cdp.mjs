/**
 * Talking to the Cursor window itself.
 *
 * The desktop bridge is the polite way in, and when it works it is the better
 * one — it addresses a chat by id and submits through Cursor's own code. But
 * whether it answers at all is decided inside the running window, from state
 * read at startup, so a window can simply refuse for the rest of its life and
 * nothing Auto writes to disk will change its mind. Messages from a phone sat
 * in a queue for the best part of an hour because of it.
 *
 * Launched with `--remote-debugging-port`, Cursor exposes the same thing every
 * Electron app does: its windows, as pages. That gives Auto a way in that no
 * feature switch governs — put the caret in the chat box, type, press Enter.
 * It is the crudest possible transport and also the most dependable, because
 * it is exactly what a person at the keyboard does.
 *
 * Two rules keep it honest:
 *
 *  - **Never type into the wrong conversation.** CDP has no notion of a thread
 *    id: text goes wherever the window is pointed. So a window is only written
 *    to once it has proved which chat it is showing, either from the id in its
 *    own markup or, failing that, by looking up the messages on screen in the
 *    desktop's database.
 *  - **Never leave a mess.** If the box will not send, whatever was typed is
 *    taken back out, and the message goes to the bridge or the outbox instead.
 *    A half-typed message left in someone's chat box is worse than a delay.
 *
 * Reading a thread is still the database's job (`desktop-threads.mjs`). The
 * window only holds the messages it has scrolled into view, so it could never
 * be a source of history.
 */
import { WebSocket } from 'ws';
import { COMPOSER_TEXT, FACTS, FOCUS_COMPOSER, samePath } from './cursor-dom.mjs';
import { threadOwning } from './desktop-threads.mjs';

export const DEFAULT_PORT = Number(process.env.CURSOR_CDP_PORT || 9222);

const CALL_TIMEOUT_MS = 10_000;
const DISCOVER_TIMEOUT_MS = 3000;
/** Long enough for the editor to clear after Enter, short enough to feel live. */
const SUBMIT_SETTLE_MS = 250;
const SUBMIT_LOOKS = 8;

/** JSON-RPC over one page's debugger socket. */
class CdpSocket {
  #ws;
  #id = 0;
  #waiting = new Map();

  static async open(wsUrl) {
    const socket = new CdpSocket();
    socket.#ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the window did not accept a connection')), CALL_TIMEOUT_MS);
      socket.#ws.once('open', () => (clearTimeout(timer), resolve()));
      socket.#ws.once('error', (err) => (clearTimeout(timer), reject(err)));
    });
    socket.#ws.on('message', (raw) => socket.#receive(raw));
    socket.#ws.on('close', () => socket.#giveUp('the window closed the connection'));
    return socket;
  }

  #receive(raw) {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    const waiting = this.#waiting.get(msg.id);
    if (!waiting) return;
    this.#waiting.delete(msg.id);
    if (msg.error) waiting.reject(new Error(msg.error.message));
    else waiting.resolve(msg.result || {});
  }

  #giveUp(why) {
    for (const waiting of this.#waiting.values()) waiting.reject(new Error(why));
    this.#waiting.clear();
  }

  send(method, params = {}) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(id);
        reject(new Error(`${method} got no answer from the window`));
      }, CALL_TIMEOUT_MS);
      this.#waiting.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      try {
        this.#ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.#waiting.delete(id);
        reject(err);
      }
    });
  }

  close() {
    try {
      this.#ws.close();
    } catch {
      /* already gone */
    }
  }
}

/**
 * One Cursor window, in the terms Auto cares about.
 *
 * Everything above this layer speaks in chats and messages; only this class
 * knows about evaluated scripts and key events. That also makes the layer
 * above testable without Cursor: anything with these methods will do.
 */
export class CursorWindow {
  constructor(socket, { title = '' } = {}) {
    this.socket = socket;
    this.title = title;
  }

  static async open(target) {
    return new CursorWindow(await CdpSocket.open(target.webSocketDebuggerUrl), {
      title: target.title,
    });
  }

  async #evaluate(expression) {
    const res = await this.socket.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(
        res.exceptionDetails.exception?.description ||
          res.exceptionDetails.text ||
          'the window could not run that',
      );
    }
    return res.result?.value;
  }

  /** Which repo, which chat, what is on screen, and is the box ready. */
  facts() {
    return this.#evaluate(FACTS);
  }

  focusComposer() {
    return this.#evaluate(FOCUS_COMPOSER);
  }

  composerText() {
    return this.#evaluate(COMPOSER_TEXT);
  }

  /**
   * Type, as far as the editor can tell. The chat box keeps its own model of
   * the document and ignores changes made to the DOM behind its back, so text
   * has to arrive as input rather than as an assignment.
   */
  insertText(text) {
    return this.socket.send('Input.insertText', { text: String(text) });
  }

  async #key(key, code, keyCode, modifiers = 0) {
    for (const type of ['keyDown', 'keyUp']) {
      await this.socket.send('Input.dispatchKeyEvent', {
        type,
        key,
        code,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode,
        modifiers,
      });
    }
  }

  pressEnter() {
    return this.#key('Enter', 'Enter', 13);
  }

  /** Take back everything in the box: select all, delete. */
  async clearComposer() {
    await this.#key('a', 'KeyA', 65, 2);
    await this.#key('Backspace', 'Backspace', 8);
  }

  close() {
    this.socket.close();
  }
}

/** Cursor's windows are the pages with a workbench in them. */
function isWindow(target) {
  return target?.type === 'page' && /workbench/i.test(String(target.url || ''));
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const flatten = (text) => String(text).replace(/\s+/g, ' ').trim();

/**
 * The Cursor windows on this machine, and what can be done with them.
 *
 * Connections are opened for a piece of work and closed after it. A socket
 * held open across a window reload is a socket that lies about what it can
 * do, and sends are rare enough that reconnecting costs nothing worth saving.
 */
export class CursorCdp {
  /**
   * @param {object} [opts]
   * @param {number} [opts.port]
   * @param {() => Promise<object[]>} [opts.listTargets]  for tests
   * @param {(target: object) => Promise<CursorWindow>} [opts.openWindow]  for tests
   * @param {(bubbleIds: string[]) => string|null} [opts.owner]  which thread
   *   owns these messages, when a window will not say which chat it shows
   * @param {number} [opts.settleMs]
   */
  constructor({ port = DEFAULT_PORT, listTargets, openWindow, owner, settleMs } = {}) {
    this.port = port;
    this.listTargets = listTargets || (() => defaultTargets(port));
    this.openWindow = openWindow || ((target) => CursorWindow.open(target));
    this.owner = owner || ((ids) => threadOwning(ids));
    this.settleMs = settleMs ?? SUBMIT_SETTLE_MS;
  }

  /** Is Cursor listening at all? Cheap enough to ask before every send. */
  async available() {
    try {
      return (await this.listTargets()).some(isWindow);
    } catch {
      return false;
    }
  }

  /** Every window, with the chat it is showing. Read-only. */
  async windows() {
    const targets = (await this.listTargets()).filter(isWindow);
    const found = [];
    for (const target of targets) {
      let window;
      try {
        window = await this.openWindow(target);
        const facts = await window.facts();
        found.push({ ...facts, title: facts?.title || target.title });
      } catch (err) {
        found.push({ title: target.title, error: err.message });
      } finally {
        window?.close();
      }
    }
    return found;
  }

  /** The window showing a given repo, if one is open. */
  async windowFor(folder) {
    return (await this.windows()).find((w) => samePath(w.workspace, folder)) || null;
  }

  /**
   * Which chat is this window showing?
   *
   * The window's own markup is the first answer. If a Cursor update takes that
   * away, the messages on screen are the second: their ids belong to exactly
   * one thread in the desktop's database, so they say what the markup would
   * have. Both can decline to answer, and then nothing is typed.
   */
  #threadOf(facts) {
    if (facts?.threadId) return facts.threadId;
    const ids = (facts?.rows || []).map((r) => r?.id).filter(Boolean);
    if (!ids.length) return null;
    try {
      return this.owner(ids);
    } catch {
      return null;
    }
  }

  /**
   * Put a message into a chat, as if it had been typed there.
   *
   * @param {object} opts
   * @param {string} opts.threadId  the desktop chat this must land in
   * @param {string} opts.text
   * @returns {Promise<{ status: 'submitted'|'unknown-thread'|'not-sendable'|'no-cdp'|'error',
   *   reason?: string, title?: string }>} `submitted` and only `submitted`
   *   means Cursor has it
   */
  async sendText({ threadId, text }) {
    if (!threadId) return { status: 'error', reason: 'no chat was named' };
    if (!String(text || '').trim()) return { status: 'error', reason: 'nothing to send' };

    let targets;
    try {
      targets = (await this.listTargets()).filter(isWindow);
    } catch (err) {
      return { status: 'no-cdp', reason: err.message };
    }
    if (!targets.length) {
      return {
        status: 'no-cdp',
        reason: `no Cursor window is listening on port ${this.port}`,
      };
    }

    let lastReason = null;
    for (const target of targets) {
      let window;
      try {
        window = await this.openWindow(target);
        const facts = await window.facts();
        if (this.#threadOf(facts) !== threadId) continue;
        return await this.#typeInto(window, facts, text);
      } catch (err) {
        lastReason = err.message;
      } finally {
        window?.close();
      }
    }

    return lastReason
      ? { status: 'not-sendable', reason: lastReason }
      : { status: 'unknown-thread', reason: 'no window has this chat open' };
  }

  /** The typing itself, once the window has proved which chat it is showing. */
  async #typeInto(window, facts, text) {
    const title = facts?.title;
    if (!facts?.hasComposer) {
      return { status: 'not-sendable', reason: 'that chat has no box to type in', title };
    }
    // Someone may be part-way through a message of their own. Their words win.
    if (facts.composerText) {
      return { status: 'not-sendable', reason: 'there is unsent text in the chat box', title };
    }
    if (!(await window.focusComposer())) {
      return { status: 'not-sendable', reason: 'the chat box would not take the caret', title };
    }

    await window.insertText(text);
    const typed = await window.composerText();
    if (!flatten(typed).includes(flatten(text).slice(0, 60))) {
      await window.clearComposer();
      return { status: 'not-sendable', reason: 'the chat box did not take the text', title };
    }

    // Enter submits; an empty box is the window confirming it did. Cursor
    // queues the message by itself if the agent is mid-turn, exactly as it
    // would for someone typing during a turn.
    await window.pressEnter();
    for (let look = 0; look < SUBMIT_LOOKS; look += 1) {
      await wait(this.settleMs);
      if (!(await window.composerText())) return { status: 'submitted', title };
    }

    await window.clearComposer();
    return { status: 'not-sendable', reason: 'the chat box would not send', title };
  }
}

/** Ask Cursor's debug port what it has open. */
async function defaultTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json`, {
    signal: AbortSignal.timeout(DISCOVER_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`the debug port answered HTTP ${res.status}`);
  return res.json();
}
