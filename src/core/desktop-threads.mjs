/**
 * Watching a chat thread that lives in the Cursor desktop app.
 *
 * The bridge only carries messages one way — into the IDE. The way back is
 * the desktop's own database, which the app writes as a thread progresses:
 * one row per bubble, plus a header list giving their order. Polling it is
 * unglamorous but honest, and it means Auto sees a thread move whether the
 * message came from a phone or from someone typing in the IDE.
 *
 * Two things are worth knowing about the shape of that data. Assistant text
 * is written when a message finishes rather than as it streams, so a thread
 * advances a message at a time and the most Auto can say meanwhile is that
 * the agent is working. And a turn in flight is marked by a generation id on
 * the thread, which is the only reliable sign of the end of a turn — the
 * stored status lags behind it.
 */
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APPDATA = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
const IDE_DB = join(APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb');

const BUBBLE_USER = 1;

function withDb(fn) {
  if (!existsSync(IDE_DB)) return null;
  const db = new DatabaseSync(IDE_DB, { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const textOf = (row) =>
  row?.value_t === 'blob' || Buffer.isBuffer(row?.value)
    ? Buffer.from(row.value).toString('utf8')
    : String(row?.value ?? '');

/** What a bubble is worth showing, if anything. */
function messageOf(bubble) {
  if (!bubble || typeof bubble !== 'object') return null;
  const role = bubble.type === BUBBLE_USER ? 'user' : 'assistant';

  const tool = bubble.toolFormerData;
  if (tool) {
    return {
      role,
      kind: 'tool',
      name: tool.name || tool.tool || 'tool',
      status: tool.status || null,
      text: '',
    };
  }

  const text = String(bubble.text || '').trim();
  if (text) return { role, kind: 'text', text };

  const thinking = String(bubble.thinking?.text || '').trim();
  if (thinking) return { role, kind: 'thinking', text: thinking };

  return null;
}

/**
 * Read a desktop thread.
 *
 * @param {string} threadId
 * @param {object} [opts]
 * @param {Set<string>} [opts.seen]  bubbles already dealt with; only newer
 *   ones come back, though every id visited is reported so the caller can
 *   keep its own record
 * @param {number} [opts.tail]  keep only the last N messages — a thread can
 *   hold thousands, and nobody wants them all replayed onto a phone
 * @returns {{ title: string, generating: boolean, messages: object[],
 *   visited: string[], total: number } | null}
 */
export function readThread(threadId, { seen, tail } = {}) {
  return withDb((db) => {
    const get = db.prepare('SELECT value, typeof(value) value_t FROM cursorDiskKV WHERE key = ?');
    const row = get.get(`composerData:${threadId}`);
    if (!row) return null;

    let data;
    try {
      data = JSON.parse(textOf(row));
    } catch {
      return null;
    }

    const headers = data.fullConversationHeadersOnly || [];
    const messages = [];
    const visited = [];

    for (const header of headers) {
      const bubbleId = header?.bubbleId;
      if (!bubbleId || seen?.has(bubbleId)) continue;

      const bubbleRow = get.get(`bubbleId:${threadId}:${bubbleId}`);
      if (!bubbleRow) continue;

      let bubble;
      try {
        bubble = JSON.parse(textOf(bubbleRow));
      } catch {
        continue;
      }

      const message = messageOf(bubble);
      // An empty bubble is one the desktop has created but not filled in yet,
      // so leave it unvisited and look again on the next pass.
      if (!message) continue;

      visited.push(bubbleId);
      messages.push({ id: bubbleId, at: bubble.createdAt || null, ...message });
    }

    return {
      title: data.name || 'Desktop chat',
      // The stored status lags; a generation id means a turn is in flight.
      generating: Boolean(data.chatGenerationUUID) || Boolean(data.generatingBubbleIds?.length),
      messages: tail && messages.length > tail ? messages.slice(-tail) : messages,
      visited,
      total: headers.length,
    };
  });
}

/** Is this thread still in the desktop's database? */
export function threadExists(threadId) {
  return Boolean(
    withDb((db) =>
      db.prepare('SELECT 1 FROM cursorDiskKV WHERE key = ?').get(`composerData:${threadId}`),
    ),
  );
}

/**
 * Follow a thread and report what happens in it.
 *
 * Emits `message` for each new bubble, `running` when a turn starts or ends,
 * and `title` when the desktop renames the thread — which it does by itself
 * after the first exchange.
 */
export class ThreadWatcher extends EventEmitter {
  /**
   * @param {string} threadId
   * @param {object} [opts]
   * @param {number} [opts.idleMs]  how often to look while nothing is happening
   * @param {number} [opts.busyMs]  how often to look during a turn
   */
  constructor(threadId, { idleMs = 2000, busyMs = 750 } = {}) {
    super();
    this.threadId = threadId;
    this.idleMs = idleMs;
    this.busyMs = busyMs;
    this.seen = new Set();
    this.running = false;
    this.title = null;
    this.timer = null;
    this.stopped = true;
    this.settling = false;
  }

  /** Treat these bubbles as already dealt with. */
  markSeen(ids = []) {
    for (const id of ids) this.seen.add(id);
    return this;
  }

  start() {
    if (!this.stopped) return this;
    this.stopped = false;
    this.#schedule(0);
    return this;
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    return this;
  }

  #schedule(ms) {
    if (this.stopped) return;
    this.timer = setTimeout(() => this.#tick(), ms);
    this.timer.unref?.();
  }

  #tick() {
    if (this.stopped) return;
    let state = null;
    try {
      state = readThread(this.threadId, { seen: this.seen });
    } catch (err) {
      this.emit('error', err);
    }

    if (state) {
      for (const id of state.visited) this.seen.add(id);
      for (const message of state.messages) this.emit('message', message);

      if (state.title && state.title !== this.title) {
        this.title = state.title;
        this.emit('title', state.title);
      }

      if (state.generating && !this.running) {
        this.running = true;
        this.settling = false;
        this.emit('running', true);
      } else if (!state.generating && this.running) {
        // The desktop clears the generation id before the last message is
        // written, so calling the turn over now would put the end of it
        // above the answer. Look once more first.
        if (this.settling) {
          this.settling = false;
          this.running = false;
          this.emit('running', false);
        } else {
          this.settling = true;
          this.#schedule(this.busyMs);
          return;
        }
      } else if (state.generating) {
        this.settling = false;
      }
    }

    this.#schedule(this.running ? this.busyMs : this.idleMs);
  }
}
