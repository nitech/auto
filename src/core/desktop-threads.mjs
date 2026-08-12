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

/**
 * How many more times to look after a turn's generation id disappears, before
 * accepting that the turn really is over. Four polls is a couple of seconds in
 * practice: long enough for the desktop to finish writing its last message,
 * short enough that nobody notices the turn ending late.
 */
const SETTLE_LOOKS = 4;

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

/** Output worth reading, without the whole of a build log. */
const OUTPUT_LIMIT = 20_000;

function parse(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * What a tool call ran and what came back.
 *
 * The desktop keeps both as JSON strings hanging off the bubble: the arguments
 * under `params`, the answer under `result`. A running command is the one
 * people actually want to read, so its command line and its output are pulled
 * out by name; everything else passes through as its arguments, minus the
 * shell parse tree Cursor keeps for its own purposes.
 */
function toolDetail(tool) {
  const params = parse(tool.params) || parse(tool.rawArgs) || {};
  const result = parse(tool.result);

  let input = null;
  if (params.command) {
    input = { command: params.command, ...(params.cwd ? { cwd: params.cwd } : {}) };
  } else if (Object.keys(params).length) {
    const { parsingResult, ...rest } = params;
    input = rest;
  }

  // Only prose is worth putting on a screen. A file edit answers with content
  // hashes, which say nothing to anyone and would bury the commands that do.
  let output = null;
  for (const key of ['output', 'stdout', 'text', 'error', 'message']) {
    if (typeof result?.[key] === 'string' && result[key]) {
      output = result[key];
      break;
    }
  }
  if (output && output.length > OUTPUT_LIMIT) {
    output = `${output.slice(0, OUTPUT_LIMIT)}\n… ${output.length - OUTPUT_LIMIT} more characters`;
  }

  return { input, output };
}

/** What a bubble is worth showing, if anything. */
function messageOf(bubble) {
  if (!bubble || typeof bubble !== 'object') return null;
  const role = bubble.type === BUBBLE_USER ? 'user' : 'assistant';

  const tool = bubble.toolFormerData;
  if (tool) {
    const status = tool.status || null;
    const { input, output } = toolDetail(tool);
    return {
      role,
      kind: 'tool',
      name: tool.name || tool.tool || 'tool',
      status,
      input,
      output,
      // A call still running will be written again with what it printed, so
      // this bubble is not finished with us yet. Anything else is as final as
      // it is going to get, output or no output.
      pending: !status || status === 'loading' || status === 'running',
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
      // so leave it unvisited and look again on the next pass. A tool call
      // waiting on its output is the same case: something is there to show,
      // but it is not the whole of it.
      if (!message) continue;

      if (!message.pending) visited.push(bubbleId);
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
    /** bubbleId -> what we last said about it, for calls read more than once */
    this.echoed = new Map();
    this.running = false;
    this.title = null;
    this.timer = null;
    this.stopped = true;
    this.settleLooks = 0;
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
      let said = 0;
      for (const message of state.messages) {
        // An unfinished call is read again every pass. Say something only when
        // there is something new to say.
        if (message.pending) {
          const print = `${message.status}:${message.output?.length || 0}`;
          if (this.echoed.get(message.id) === print) continue;
          this.echoed.set(message.id, print);
        } else {
          this.echoed.delete(message.id);
        }
        said += 1;
        this.emit('message', message);
      }

      if (state.title && state.title !== this.title) {
        this.title = state.title;
        this.emit('title', state.title);
      }

      if (state.generating && !this.running) {
        this.running = true;
        this.settleLooks = SETTLE_LOOKS;
        this.emit('running', true);
      } else if (!state.generating && this.running) {
        // The desktop clears the generation id before the last message is
        // written, so calling the turn over now would put the end of it above
        // the answer. Keep looking for a moment: the reply ends the wait as
        // soon as it lands, and a turn with nothing left to say ends when the
        // looks run out. One look was not enough — a write a poll or two late
        // was announced in the wrong order.
        if (!said && this.settleLooks > 0) {
          this.settleLooks -= 1;
          this.#schedule(this.busyMs);
          return;
        }
        this.settleLooks = SETTLE_LOOKS;
        this.running = false;
        this.emit('running', false);
      } else if (state.generating) {
        this.settleLooks = SETTLE_LOOKS;
      }
    }

    this.#schedule(this.running ? this.busyMs : this.idleMs);
  }
}
