/**
 * Messages the Cursor desktop would not take yet.
 *
 * The bridge can refuse for reasons that have nothing to do with what you
 * typed: no window has the chat open, or — the common one — the window has the
 * gate shut. Cursor decides that in memory, so Auto cannot open it from here;
 * all it can do is wait for the window to come back and, in the meantime, not
 * lose your words. Dropping a message you typed on a phone, five minutes from
 * a keyboard, is the worst possible answer.
 *
 * So a refusal parks the text here in the order it was written, and every
 * queue is retried on a timer until the desktop accepts it. The timer only
 * exists while something is waiting.
 */
import { EventEmitter } from 'node:events';

/** The two answers that mean the desktop has it. */
const ACCEPTED = new Set(['submitted', 'queued']);

export class DesktopOutbox extends EventEmitter {
  #queues = new Map();
  #timer = null;
  #flushing = false;

  /**
   * @param {object} o
   * @param {(sessionId: string, text: string) => Promise<{status: string}>} o.send
   * @param {number} [o.retryMs] how often to try a waiting queue
   */
  constructor({ send, retryMs = 15_000 } = {}) {
    super();
    this.send = send;
    this.retryMs = retryMs;
  }

  queued(sessionId) {
    return this.#queues.get(sessionId)?.length || 0;
  }

  /** What is waiting, oldest first — for showing, and for saving to disk. */
  list(sessionId) {
    return (this.#queues.get(sessionId) || []).map(({ text, at }) => ({ text, at }));
  }

  /** Put back a queue read from disk, without disturbing what is already here. */
  restore(sessionId, items = []) {
    const q = this.#queues.get(sessionId) || [];
    for (const item of items) {
      if (!item?.text) continue;
      q.push({ text: item.text, at: item.at || Date.now() });
    }
    if (!q.length) return 0;
    this.#queues.set(sessionId, q);
    this.#arm();
    return q.length;
  }

  total() {
    let n = 0;
    for (const q of this.#queues.values()) n += q.length;
    return n;
  }

  /** Park a message. Returns its place in the queue. */
  hold(sessionId, text) {
    const q = this.#queues.get(sessionId) || [];
    q.push({ text, at: Date.now() });
    this.#queues.set(sessionId, q);
    this.#arm();
    return q.length;
  }

  /** Give up on a session's waiting messages. */
  drop(sessionId) {
    const n = this.queued(sessionId);
    this.#queues.delete(sessionId);
    this.#disarm();
    return n;
  }

  /**
   * Try every waiting queue once, oldest first.
   *
   * A queue stops at its first refusal: the order people wrote things in is
   * the order they meant them to arrive, so a message that will not go must
   * not let the one behind it overtake.
   *
   * @returns {Promise<number>} how many were delivered
   */
  async flush() {
    if (this.#flushing) return 0;
    this.#flushing = true;
    let sent = 0;

    try {
      for (const [sessionId, q] of [...this.#queues]) {
        while (q.length) {
          const item = q[0];
          const result = await Promise.resolve(this.send(sessionId, item.text)).catch((err) => ({
            status: 'error',
            message: err.message,
          }));
          if (!ACCEPTED.has(result?.status)) break;
          q.shift();
          sent += 1;
          this.emit('sent', {
            sessionId,
            text: item.text,
            result,
            waitedMs: Date.now() - item.at,
            remaining: q.length,
          });
        }
        if (!q.length) this.#queues.delete(sessionId);
      }
    } finally {
      this.#flushing = false;
      this.#disarm();
    }

    return sent;
  }

  #arm() {
    if (this.#timer || !this.total()) return;
    this.#timer = setInterval(() => {
      this.flush().catch(() => {});
    }, this.retryMs);
    this.#timer.unref?.();
  }

  #disarm() {
    if (!this.#timer || this.total()) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}
