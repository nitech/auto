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
import * as clipboard from './clipboard.mjs';
import {
  ACTIONS,
  ATTACHED,
  COMPOSER_TEXT,
  FACTS,
  FOCUS_COMPOSER,
  MENU_ITEMS,
  NEW_AGENT,
  QUEUE,
  SELECTORS,
  STOP_TURN_KEY,
  clickAction,
  isApproval,
  pickerAt,
  queueAct,
  samePath,
  showThread,
} from './cursor-dom.mjs';
import { readSettings, readThread, threadOwning } from './desktop-threads.mjs';

export const DEFAULT_PORT = Number(process.env.CURSOR_CDP_PORT || 9222);

const CALL_TIMEOUT_MS = 10_000;
const DISCOVER_TIMEOUT_MS = 3000;
/** Long enough for the editor to clear after Enter, short enough to feel live. */
const SUBMIT_SETTLE_MS = 250;
const SUBMIT_LOOKS = 8;
/** How long to give a turn to actually stop before trying the other way. */
const STOP_LOOKS = 6;
/** How long a pressed tab gets to bring its chat forward. */
const SHOW_LOOKS = 8;
/** How long New Agent gets to produce a new chat id. */
const NEW_CHAT_LOOKS = 12;
/** How long a menu gets to open, and a picker to admit it changed. */
const MENU_LOOKS = 10;
/** How long a pasted image gets to appear beside the chat box. */
const PASTE_LOOKS = 12;

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

  /** Run a script in the window and bring back what it returned. */
  async evaluate(expression) {
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
    return this.evaluate(FACTS);
  }

  focusComposer() {
    return this.evaluate(FOCUS_COMPOSER);
  }

  composerText() {
    return this.evaluate(COMPOSER_TEXT);
  }

  /** How many images are already waiting in the chat box. */
  attached() {
    return this.evaluate(ATTACHED);
  }

  /**
   * Paste whatever the machine is holding into the chat box.
   *
   * There is no protocol command for attaching a file, but Blink will run a named
   * editing command on a key event — so this is Ctrl+V with the paste spelled
   * out, rather than a keystroke and a hope. What arrives is the clipboard's
   * business; see `clipboard.mjs`.
   */
  async paste() {
    await this.socket.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'v',
      code: 'KeyV',
      windowsVirtualKeyCode: 86,
      nativeVirtualKeyCode: 86,
      modifiers: 2,
      commands: ['paste'],
    });
    await this.socket.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'v',
      code: 'KeyV',
      windowsVirtualKeyCode: 86,
      nativeVirtualKeyCode: 86,
      modifiers: 2,
    });
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

  /** Shut whatever is open, the way a person gets out of a menu. */
  pressEscape() {
    return this.#key('Escape', 'Escape', 27);
  }

  /**
   * Press a point in the window with a real mouse.
   *
   * Cursor's chat answers a click dispatched onto an element, but its dropdowns
   * do not: they open on input the window believes came from a mouse, and a
   * synthetic event is not that however it is shaped. Pressing where something
   * is, rather than pressing the thing itself, is the only way in — so the
   * caller has to find out where it is first.
   */
  async mouseAt({ x, y }) {
    const at = { x: Math.round(x), y: Math.round(y) };
    // Move first: a control that only shows itself on hover is a real thing.
    await this.socket.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      ...at,
      button: 'none',
      buttons: 0,
    });
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.socket.send('Input.dispatchMouseEvent', {
        type,
        ...at,
        button: 'left',
        buttons: type === 'mousePressed' ? 1 : 0,
        clickCount: 1,
      });
    }
  }

  /** What the chat is offering to be pressed, and whether a turn is running. */
  actions() {
    return this.evaluate(ACTIONS);
  }

  /** The messages Cursor is holding until this turn ends. */
  queue() {
    return this.evaluate(QUEUE);
  }

  /** Press a queued message's own edit, send-now or delete button. */
  queueAct(text, which) {
    return this.evaluate(queueAct(text, which));
  }

  /** Press the control with this name. */
  click(name) {
    return this.evaluate(clickAction(name));
  }

  /** Ask for the turn to stop, the way the Stop button says to. */
  stopTurn() {
    const { key, code, keyCode, modifiers } = STOP_TURN_KEY;
    return this.#key(key, code, keyCode, modifiers);
  }

  /** Bring a chat to the front of this window by pressing its tab. */
  showThread(threadId) {
    return this.evaluate(showThread(threadId));
  }

  /** Press the New Agent control in the chat pane. */
  newAgent() {
    return this.evaluate(NEW_AGENT);
  }

  /**
   * The shortcut printed on that control. Used only when the control itself
   * is not on screen — Ctrl+N is New File in stock VS Code, and must not be
   * the first thing tried.
   */
  newAgentKey() {
    return this.#key('n', 'KeyN', 78, 2);
  }

  /** Where the model or mode picker is, and what it says now. */
  pickerAt(which) {
    return this.evaluate(pickerAt(which));
  }

  /** What the open menu offers, and where each item is. */
  menuItems() {
    return this.evaluate(MENU_ITEMS);
  }

  /** The same, by pressing the stop icon beside the chat box. */
  clickStopIcon() {
    return this.evaluate(`(() => {
      const pane = document.querySelector(${JSON.stringify(SELECTORS.chatPane[0])}) || document;
      for (const selector of ${JSON.stringify(SELECTORS.stopIcon)}) {
        const found = [...pane.querySelectorAll(selector)];
        const el = found[found.length - 1];
        if (!el) continue;
        // The icon is a glyph inside the button that carries the handler.
        const target = el.closest("button, [role='button'], .anysphere-icon-button") || el;
        target.click();
        return true;
      }
      return false;
    })()`);
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

/** How close two rows have to be to count as the same one. */
const SAME_ROW_PX = 12;

const plain = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Which menu item does this name mean, and what has to be pressed to get it?
 *
 * Names are matched as a person would read them: the whole label first, then a
 * label the request begins with, which is how a variant is asked for — "Opus 5
 * High" is the row "Opus 5" and the badge "High" sitting on it. A badge is only
 * accepted from that row, since every row has one saying the same word, and a
 * name matching several rows is refused outright. Choosing the wrong model is
 * not the sort of mistake that announces itself.
 *
 * @param {{ label: string, x: number, y: number }[]} items
 * @param {string} wanted
 * @returns {{ item?: object, press: object[], reason?: string }}
 */
export function pickItem(items, wanted) {
  const want = plain(wanted);
  const at = (item) => ({ x: item.x, y: item.y });

  const exact = items.filter((item) => plain(item.label) === want);
  if (exact.length === 1) return { item: exact[0], press: [at(exact[0])] };
  if (exact.length > 1) {
    return { press: [], reason: `more than one row says "${wanted}"` };
  }

  // "<row> <variant>": the longest label the request starts with is the row.
  const starts = items
    .filter((item) => want.startsWith(`${plain(item.label)} `))
    .sort((a, b) => plain(b.label).length - plain(a.label).length);
  for (const row of starts) {
    const rest = want.slice(plain(row.label).length).trim();
    const onRow = items.filter(
      (item) => plain(item.label) === rest && Math.abs(item.y - row.y) <= SAME_ROW_PX,
    );
    if (onRow.length === 1) return { item: onRow[0], press: [at(row), at(onRow[0])] };
    if (onRow.length > 1) return { press: [], reason: `"${rest}" is on that row more than once` };
  }
  if (starts.length) {
    return { press: [], reason: `"${wanted.slice(plain(starts[0].label).length).trim()}" is not on that row` };
  }

  const loose = items.filter((item) => plain(item.label).startsWith(want));
  if (loose.length === 1) return { item: loose[0], press: [at(loose[0])] };

  return { press: [], reason: `nothing in the menu is called "${wanted}"` };
}

/** Cursor's windows are the pages with a workbench in them. */
function isWindow(target) {
  return target?.type === 'page' && /workbench/i.test(String(target.url || ''));
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const flatten = (text) => String(text).replace(/\s+/g, ' ').trim();
/** The same message, allowing for how the window lays its text out. */
const same = (a, b) => flatten(a) === flatten(b);

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
   * @param {(threadId: string) => boolean} [opts.isGenerating]  whether a turn
   *   is in flight, from the desktop's own records
   * @param {(threadId: string) => object|null} [opts.readSettings]  what a chat
   *   is set to, from the desktop's own records
   * @param {number} [opts.settleMs]
   */
  constructor({
    port = DEFAULT_PORT,
    listTargets,
    openWindow,
    owner,
    isGenerating,
    readSettings: settingsOf,
    clipboard: board,
    settleMs,
  } = {}) {
    this.port = port;
    this.listTargets = listTargets || (() => defaultTargets(port));
    this.openWindow = openWindow || ((target) => CursorWindow.open(target));
    this.owner = owner || ((ids) => threadOwning(ids));
    // The window shows whether a turn is running, but the desktop's database
    // says so outright, and it was right when the window was wrong.
    this.isGenerating =
      isGenerating || ((threadId) => Boolean(readThread(threadId, { tail: 0 })?.generating));
    this.readSettings = settingsOf || ((threadId) => readSettings(threadId));
    // The machine's clipboard, borrowed to get a picture into the chat box.
    // Injectable so tests never touch the real one.
    this.clipboard = board || clipboard;
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
   * Open a new chat in the Cursor window that already has this folder.
   *
   * A chat created anywhere else would belong to the wrong repo, so a window
   * that cannot prove it is showing this folder is left alone. The new thread
   * id comes from the window once it has switched, not from us.
   *
   * @returns {Promise<{ status: 'created'|'no-cdp'|'no-window'|'error',
   *   threadId?: string, title?: string, reason?: string }>}
   */
  async newChat({ folder }) {
    if (!String(folder || '').trim()) {
      return { status: 'error', reason: 'no folder was named' };
    }

    return this.#withFolder(folder, async (window, facts) => {
      const before = this.#threadOf(facts);
      const clicked = await window.newAgent();
      if (!clicked?.pressed) await window.newAgentKey();

      for (let look = 0; look < NEW_CHAT_LOOKS; look += 1) {
        await wait(this.settleMs);
        const now = await window.facts();
        const threadId = this.#threadOf(now);
        if (threadId && threadId !== before) {
          return { status: 'created', threadId, title: now.title };
        }
      }
      return {
        status: 'error',
        reason: clicked?.pressed
          ? 'Cursor did not open a new chat'
          : clicked?.reason || 'Cursor did not open a new chat',
      };
    });
  }

  /**
   * Do something to the window showing a given folder, and nothing otherwise.
   *
   * Creating a chat has no thread id yet, so the window is identified by the
   * repo it has open — the same proof `windowFor` uses, held open for the work.
   */
  async #withFolder(folder, work) {
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
        if (!samePath(facts?.workspace, folder)) continue;
        if (!facts?.hasComposer) {
          lastReason = 'that window has no chat box';
          continue;
        }
        return await work(window, facts);
      } catch (err) {
        lastReason = err.message;
      } finally {
        window?.close();
      }
    }

    return {
      status: 'no-window',
      reason: lastReason || `no Cursor window has ${folder} open`,
    };
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
   * Do something to the window showing a given chat, and nothing otherwise.
   *
   * Every operation goes through here, because every operation has the same
   * precondition: the window in front of us must have proved it is showing the
   * chat we mean. Typing into a stranger's conversation and stopping a
   * stranger's turn are the same mistake.
   */
  async #withThread(threadId, work) {
    if (!threadId) return { status: 'error', reason: 'no chat was named' };

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
        return await work(window, facts);
      } catch (err) {
        lastReason = err.message;
      } finally {
        window?.close();
      }
    }

    return lastReason
      ? { status: 'error', reason: lastReason }
      : { status: 'unknown-thread', reason: 'no window has this chat open' };
  }

  /**
   * Put a message into a chat, as if it had been typed there.
   *
   * With `bringForward`, a chat sitting in a background tab is brought to the
   * front first. Without it, only the chat already on screen can be written to.
   * Someone part-way through typing in the window keeps it either way: their
   * unsent words are reason enough to leave the window alone.
   *
   * Images go in ahead of the words, pasted through the clipboard — the only way
   * a picture gets into that box. See `#attach`.
   *
   * @param {object} opts
   * @param {string} opts.threadId  the desktop chat this must land in
   * @param {string} opts.text
   * @param {Array<{mimeType?: string, data: string|Buffer}>} [opts.images]
   * @param {boolean} [opts.bringForward]
   * @returns {Promise<{ status: 'submitted'|'unknown-thread'|'not-sendable'|'no-cdp'|'error',
   *   reason?: string, title?: string, attached?: number, attachFailed?: string }>}
   *   `submitted` and only `submitted` means Cursor has it
   */
  async sendText({ threadId, text, images = [], bringForward = false }) {
    if (!String(text || '').trim()) return { status: 'error', reason: 'nothing to send' };

    const typed = await this.#withThread(threadId, (window, facts) =>
      this.#typeInto(window, facts, text, images),
    );
    if (!bringForward || typed.status !== 'unknown-thread') return typed;

    const shown = await this.showThread({ threadId });
    if (shown.status !== 'shown') {
      return shown.status === 'no-tab' ? typed : { status: 'not-sendable', reason: shown.reason };
    }
    return this.#withThread(threadId, (window, facts) =>
      this.#typeInto(window, facts, text, images),
    );
  }

  /**
   * What a chat is doing, and what it is offering to be pressed.
   *
   * `asking` is the interesting part: controls whose words mean Cursor is
   * waiting for a person — an approval to run something, a file edit to keep.
   * They are reported with the wording the window used, because that wording is
   * also how they are pressed.
   */
  async waitingOn({ threadId }) {
    return this.#withThread(threadId, async (window) => {
      const { generating, controls } = await window.actions();
      const named = (c) => c.label || c.text;
      // The queue comes back in the same look: it is the same window, and this
      // runs every couple of seconds for as long as a turn lasts.
      const queue = await window.queue().catch(() => null);
      return {
        status: 'ok',
        generating: generating || this.#running(threadId),
        asking: controls.filter(
          (c) => !c.disabled && isApproval(named(c)) && !/^stop\b/i.test(named(c)),
        ),
        controls,
        queue,
      };
    });
  }

  /**
   * The messages Cursor is holding for this chat until the turn ends.
   *
   * Cursor owns this queue, not Auto: a message typed into a busy chat is queued
   * by the IDE itself. Reading it is how a phone can show the same list the IDE
   * shows, and it comes from whichever window has the chat, so it is that chat's
   * queue and no other's.
   */
  async queue({ threadId, bringForward = false }) {
    const read = (window) => window.queue().then((seen) => ({ status: 'ok', ...seen }));
    const seen = await this.#withThread(threadId, read);
    // Cursor draws the queue for the chat on screen and no other, so a chat in a
    // background tab has no queue to read. A phone asking for its own chat's
    // queue means it, and gets the tab brought forward; the poll that runs
    // through a turn does not, because taking over someone's window every two
    // seconds to look at a list is worse than not showing the list.
    if (!bringForward || seen.status !== 'unknown-thread') return seen;

    const shown = await this.showThread({ threadId });
    if (shown.status !== 'shown') {
      return shown.status === 'no-tab' ? seen : { status: 'error', reason: shown.reason };
    }
    return this.#withThread(threadId, read);
  }

  /**
   * Press a queued message's edit, send-now or delete button.
   *
   * The row is named by its words, so what gets acted on is the message someone
   * chose and not whatever has since moved into its place. Cursor is then given a
   * moment to agree: for a delete or a send the message must actually leave the
   * queue, and if the dispatched click did nothing the button is pressed again
   * where it sits — the pickers taught us that some of Cursor's controls only
   * believe a real mouse.
   *
   * @param {object} opts
   * @param {string} opts.threadId
   * @param {string} opts.text  the queued message to act on
   * @param {'drop'|'now'} opts.which
   */
  async queueAct({ threadId, text, which }) {
    // Pressing a row means the row has to be on screen, so this always brings
    // the chat forward first — the same bargain as sending a message to a chat
    // in a background tab.
    const here = await this.#withThread(threadId, (window) => window.facts());
    if (here?.status === 'unknown-thread') {
      const shown = await this.showThread({ threadId });
      if (shown.status !== 'showing' && shown.status !== 'shown') {
        return { status: shown.status === 'no-tab' ? 'unknown-thread' : 'error', reason: shown.reason };
      }
    }

    return this.#withThread(threadId, async (window) => {
      const before = await window.queue();
      if (!before.items.some((item) => same(item.text, text))) {
        return { status: 'gone', reason: 'that message is no longer queued' };
      }

      const pressed = await window.queueAct(text, which);
      if (!pressed.pressed) return { status: 'error', reason: pressed.reason };

      const left = async () => {
        for (let look = 0; look < MENU_LOOKS; look += 1) {
          await wait(this.settleMs);
          const now = await window.queue();
          if (!now.items.some((item) => same(item.text, text))) return now;
        }
        return null;
      };

      let after = await left();
      if (!after && pressed.at) {
        await window.mouseAt(pressed.at);
        after = await left();
      }
      if (!after) {
        return { status: 'error', reason: 'Cursor kept the message in the queue' };
      }
      return { status: 'done', waiting: after.waiting, items: after.items };
    });
  }

  /**
   * Bring a chat to the front of whichever window has it open.
   *
   * Everything else here refuses to act on a chat no window is showing, which
   * is the right instinct but leaves Auto unable to reach a conversation that
   * is merely in a background tab. This is the way to fix that before acting:
   * ask for the chat, then send or stop as usual.
   *
   * A window with a half-written message in it is left alone, since switching
   * would hide someone's words — unless `force` says otherwise, which is what
   * putting a window back where it was needs.
   *
   * @returns {Promise<{ status: 'showing'|'shown'|'no-tab'|'no-cdp'|'error',
   *   reason?: string, title?: string }>}
   */
  async showThread({ threadId, force = false }) {
    if (!threadId) return { status: 'error', reason: 'no chat was named' };

    let targets;
    try {
      targets = (await this.listTargets()).filter(isWindow);
    } catch (err) {
      return { status: 'no-cdp', reason: err.message };
    }
    if (!targets.length) {
      return { status: 'no-cdp', reason: `no Cursor window is listening on port ${this.port}` };
    }

    let lastReason = null;
    for (const target of targets) {
      let window;
      try {
        window = await this.openWindow(target);
        const facts = await window.facts();
        if (this.#threadOf(facts) === threadId) {
          return { status: 'showing', title: facts.title };
        }
        // Switching a window away from a half-written message would hide it.
        if (facts.composerText && !force) {
          lastReason = 'there is unsent text in that window';
          continue;
        }
        if (!(await window.showThread(threadId))) continue;

        // Trust the window's own answer, not the click: pressing a tab and
        // arriving at the chat are different claims.
        for (let look = 0; look < SHOW_LOOKS; look += 1) {
          await wait(this.settleMs);
          const now = await window.facts();
          if (this.#threadOf(now) === threadId) return { status: 'shown', title: now.title };
        }
        lastReason = 'the tab was pressed but the chat did not come forward';
      } catch (err) {
        lastReason = err.message;
      } finally {
        window?.close();
      }
    }

    return lastReason
      ? { status: 'error', reason: lastReason }
      : { status: 'no-tab', reason: 'no window has a tab for this chat' };
  }

  /**
   * Ask the window showing a chat a question of Auto's own.
   *
   * For diagnostics and for the parts of the interface Auto does not model yet.
   * Anything it comes to rely on should be given a method and a place in
   * `cursor-dom.mjs` instead of living in a caller's string.
   */
  async readWindow(threadId, expression) {
    const result = await this.#withThread(threadId, async (window) => ({
      status: 'ok',
      value: await window.evaluate(expression),
    }));
    return result.status === 'ok' ? result.value : null;
  }

  /** Press the control a chat is offering, by the words on it. */
  async press({ threadId, name }) {
    return this.#withThread(threadId, async (window) => {
      const done = await window.click(name);
      return done?.clicked
        ? { status: 'pressed', name: done.name, where: done.where, of: done.of }
        : { status: 'not-pressed', reason: done?.reason || 'nothing was pressed' };
    });
  }

  /**
   * What a chat is set to.
   *
   * The desktop's own records answer this, so it costs no window and works for
   * chats nothing has open. The window is asked only for what it displays, which
   * is worth having because it is what the user is looking at: "Opus 5 High"
   * where the database says `claude-opus-5` and `effort: high` separately.
   */
  async settings({ threadId }) {
    const stored = this.readSettings(threadId);
    if (!stored) return { status: 'unknown-thread', reason: 'no such chat in the desktop' };

    const shown = await this.#withThread(threadId, async (window) => ({
      status: 'ok',
      model: (await window.pickerAt('model'))?.label || null,
      mode: (await window.pickerAt('mode'))?.label || null,
    }));

    return {
      status: 'ok',
      ...stored,
      shown: shown.status === 'ok' ? { model: shown.model, mode: shown.mode } : null,
    };
  }

  /**
   * The models or modes a chat could be switched to.
   *
   * Opens the picker, writes down what is in it and closes it again, because
   * there is nowhere else to read this from: the list depends on the account,
   * and Cursor keeps it in the window rather than in the database.
   */
  async choices({ threadId, picker }) {
    return this.#withThread(threadId, (window) => this.#inMenu(window, picker, null));
  }

  /**
   * Switch a chat's model or mode, by the name the menu gives it.
   *
   * A variant may be named after the model — "Opus 5 High" — and is pressed on
   * the model's own row, which is how the menu offers it. Anything ambiguous is
   * refused rather than guessed at: the same word appears on every row.
   *
   * @param {object} opts
   * @param {string} opts.threadId
   * @param {'model'|'mode'} opts.picker
   * @param {string} opts.wanted
   */
  async choose({ threadId, picker, wanted }) {
    if (!String(wanted || '').trim()) {
      return { status: 'error', reason: 'nothing was named to switch to' };
    }
    return this.#withThread(threadId, (window) => this.#inMenu(window, picker, String(wanted)));
  }

  /**
   * Open a picker, do one thing in it, and never leave it open.
   *
   * With nothing wanted this only reads. With something wanted it presses it and
   * then checks the desktop's own records agree, because a menu closing proves
   * nothing about what it did.
   */
  async #inMenu(window, picker, wanted) {
    const which = picker === 'mode' ? 'mode' : 'model';
    const at = await window.pickerAt(which);
    if (!at) return { status: 'no-picker', reason: `this window has no ${which} picker` };

    // Asking for what it is already on is not a mistake and not work either.
    if (wanted && flatten(at.label).toLowerCase() === flatten(wanted).toLowerCase()) {
      return { status: 'already', picker: which, was: at.label };
    }

    await window.mouseAt(at);
    const menu = await this.#menuOpened(window);
    if (!menu.items.length) {
      await this.#closeMenu(window);
      return { status: 'no-menu', reason: `the ${which} picker did not open` };
    }

    const options = [...new Set(menu.items.map((item) => item.label))];
    if (!wanted) {
      await this.#closeMenu(window);
      return { status: 'ok', picker: which, was: at.label, options };
    }

    const found = pickItem(menu.items, wanted);
    if (!found.item) {
      await this.#closeMenu(window);
      return { status: 'no-such-option', reason: found.reason, picker: which, options };
    }

    for (const step of found.press) await window.mouseAt(step);
    await this.#closeMenu(window);

    const now = await this.#settled(window, which, at.label);
    return now === at.label
      ? { status: 'unchanged', reason: `it still says ${now}`, picker: which, was: at.label }
      : { status: 'set', picker: which, was: at.label, now };
  }

  /** Wait for a menu to appear, and say what is in it. */
  async #menuOpened(window) {
    let seen = { open: 0, items: [] };
    for (let look = 0; look < MENU_LOOKS; look += 1) {
      await wait(this.settleMs);
      seen = (await window.menuItems()) || seen;
      if (seen.items.length) return seen;
    }
    return seen;
  }

  /**
   * Leave nothing open.
   *
   * A menu left up covers the chat box and swallows the next keystroke, so this
   * is not tidiness: the next message from a phone depends on it.
   */
  async #closeMenu(window) {
    for (let tries = 0; tries < 2; tries += 1) {
      const still = await window.menuItems();
      if (!still?.open) return true;
      await window.pressEscape();
      await wait(this.settleMs);
    }
    return !(await window.menuItems())?.open;
  }

  /** What the picker says once it has had a moment to catch up. */
  async #settled(window, which, was) {
    let now = was;
    for (let look = 0; look < MENU_LOOKS; look += 1) {
      await wait(this.settleMs);
      now = (await window.pickerAt(which))?.label ?? now;
      if (now !== was) return now;
    }
    return now;
  }

  /**
   * Stop the turn running in a chat.
   *
   * The keystroke Cursor prints on its own Stop button is tried first, and the
   * button itself second. Either way the answer comes from watching the window:
   * a turn is stopped when it stops offering to be stopped.
   */
  async stop({ threadId }) {
    return this.#withThread(threadId, async (window, facts) => {
      const before = await window.actions();
      if (!before.generating && !this.#running(threadId)) {
        return { status: 'not-running', title: facts.title };
      }

      if (facts.hasComposer) await window.focusComposer();
      await window.stopTurn();
      if (await this.#stopped(window, threadId)) {
        return { status: 'stopped', how: 'keyboard', title: facts.title, ...(await this.#tidyUp(window)) };
      }

      await window.clickStopIcon();
      if (await this.#stopped(window, threadId)) {
        return { status: 'stopped', how: 'button', title: facts.title, ...(await this.#tidyUp(window)) };
      }

      return { status: 'still-running', reason: 'the window would not stop', title: facts.title };
    });
  }

  /**
   * Clear the message Cursor hands back when a turn is stopped.
   *
   * Stopping puts the prompt back in the chat box, ready to be edited and sent
   * again — sensible for someone sitting there, and a trap for anyone who is
   * not. Auto refuses to type over unsent text, so left alone that returned
   * message would make the chat unreachable from a phone until somebody cleared
   * it by hand. It is safe to take out: it is already in the transcript, and
   * what was in the box is reported so it can be shown.
   */
  async #tidyUp(window) {
    const putBack = await window.composerText();
    if (!putBack) return {};
    await window.clearComposer();
    return { putBack };
  }

  /** Does the desktop's own record say a turn is in flight? */
  #running(threadId) {
    try {
      return Boolean(this.isGenerating(threadId));
    } catch {
      return false;
    }
  }

  /** Stopped means both the window and the desktop's record say so. */
  async #stopped(window, threadId) {
    for (let look = 0; look < STOP_LOOKS; look += 1) {
      await wait(this.settleMs);
      const { generating } = await window.actions();
      if (!generating && !this.#running(threadId)) return true;
    }
    return false;
  }

  /** The typing itself, once the window has proved which chat it is showing. */
  async #typeInto(window, facts, text, images = []) {
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

    const attached = images.length ? await this.#attach(window, images) : { count: 0 };

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
      if (!(await window.composerText())) {
        return {
          status: 'submitted',
          title,
          ...(images.length ? { attached: attached.count, ofImages: images.length } : {}),
          ...(attached.reason ? { attachFailed: attached.reason } : {}),
        };
      }
    }

    await window.clearComposer();
    return { status: 'not-sendable', reason: 'the chat box would not send', title };
  }

  /**
   * Put images into the chat box before the message goes in.
   *
   * One at a time, each confirmed by a pill appearing beside the box, because a
   * clipboard that holds the right picture is no guarantee the window took it.
   * Whatever text was on the clipboard is put back afterwards.
   *
   * A photo that will not attach does not stop the message: the words are worth
   * more than the picture, and the caller is told what was left behind so it can
   * say so. Silently sending "what do you make of this?" with no image attached
   * is the one outcome to avoid.
   */
  async #attach(window, images) {
    const held = await this.clipboard.takeText();
    let count = await window.attached();
    const started = count;
    let reason = null;

    try {
      for (const image of images) {
        const bytes = Buffer.isBuffer(image?.data)
          ? image.data
          : Buffer.from(String(image?.data || ''), 'base64');
        if (!bytes.length) {
          reason = 'an image arrived empty';
          continue;
        }

        try {
          await this.clipboard.putImage(bytes);
        } catch (err) {
          reason = err.message;
          continue;
        }

        await window.focusComposer();
        await window.paste();

        let landed = false;
        for (let look = 0; look < PASTE_LOOKS && !landed; look += 1) {
          await wait(this.settleMs);
          const now = await window.attached();
          if (now > count) {
            count = now;
            landed = true;
          }
        }
        if (!landed) reason = 'Cursor did not take the pasted image';
      }
    } finally {
      await this.clipboard.putText(held);
    }

    return { count: count - started, reason };
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
