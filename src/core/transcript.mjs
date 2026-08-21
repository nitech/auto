/**
 * Append-only per-session transcript.
 *
 * Every client is a projection of this log, so it is written in full and never
 * summarised or truncated — trimming is a rendering decision made at the edge.
 * Records carry a monotonic `seq` per session, which is the only thing a client
 * needs in order to resync after a disconnect.
 */
import { EventEmitter } from 'node:events';
import {
  appendFileSync,
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

/** Record kinds. Renderers should ignore kinds they do not know. */
export const KIND = {
  sessionStart: 'session_start',
  userMessage: 'user_message',
  agentDelta: 'agent_delta',
  agentThought: 'agent_thought',
  toolCall: 'tool_call',
  toolUpdate: 'tool_update',
  diff: 'diff',
  terminalChunk: 'terminal_chunk',
  permissionRequest: 'permission_request',
  permissionResolved: 'permission_resolved',
  /** The agent asking a person to choose, rather than to authorise. */
  question: 'question',
  questionAnswered: 'question_answered',
  plan: 'plan',
  sessionInfo: 'session_info',
  commands: 'commands',
  turnStart: 'turn_start',
  turnEnd: 'turn_end',
  error: 'error',
  // A quiet line about the session itself rather than the conversation.
  notice: 'notice',
};

/** Records kept in memory for fast replay; older ones are read back from disk. */
const MEMORY_TAIL = 4000;

/** How far into a log we will look for the opening prompt. */
const OPENING_SCAN_MAX = 80;

/** The first real user message — not an echo or a queued placeholder. */
export function isOpeningUser(rec) {
  return Boolean(
    rec &&
      rec.kind === KIND.userMessage &&
      !rec.echoed &&
      !rec.waiting,
  );
}

/**
 * From the start of a record list, keep everything through the first real
 * user message. That is the prompt the conversation exists for.
 */
export function collectOpening(records, max = OPENING_SCAN_MAX) {
  const out = [];
  for (const rec of records || []) {
    out.push(rec);
    if (isOpeningUser(rec)) return out;
    if (out.length >= max) return [];
  }
  return [];
}

/**
 * Decide what a client gets: optional pinned opening, a bounded tail, the
 * catch-up hole (`earlier`), and how many records sit between head and tail
 * (`omitted`) for the on-screen notice.
 */
export function replayWindow(opening, records, fromSeq = 0) {
  const tail = Array.isArray(records) ? records.slice() : [];
  const headIn = Array.isArray(opening) ? opening : [];
  const earlier = tail.length ? Math.max(0, tail[0].seq - 1 - fromSeq) : 0;

  if (!headIn.length) {
    return { head: [], records: tail, earlier, omitted: 0 };
  }
  const headEnd = headIn.at(-1).seq;
  // Tail already includes the opening (short chat).
  if (tail.length && tail[0].seq <= headIn[0].seq) {
    return { head: [], records: tail, earlier, omitted: 0 };
  }
  const trimmed = tail.filter((r) => r.seq > headEnd);
  const omitted = trimmed.length ? Math.max(0, trimmed[0].seq - headEnd - 1) : 0;
  return { head: headIn, records: trimmed, earlier, omitted };
}

export class Transcript extends EventEmitter {
  /**
   * @param {string} dir  directory holding `<sessionId>.jsonl`
   * @param {string} sessionId
   */
  constructor(dir, sessionId) {
    super();
    this.dir = dir;
    this.sessionId = sessionId;
    this.path = join(dir, `${sessionId}.jsonl`);
    this.seq = 0;
    this.tail = [];
    mkdirSync(dir, { recursive: true });
  }

  /** Recover `seq` from an existing file so appends stay monotonic across restarts. */
  async open() {
    if (!existsSync(this.path) || statSync(this.path).size === 0) return this;
    const rl = createInterface({
      input: createReadStream(this.path, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (typeof rec.seq === 'number' && rec.seq > this.seq) this.seq = rec.seq;
        this.tail.push(rec);
        if (this.tail.length > MEMORY_TAIL) this.tail.shift();
      } catch {
        // A torn final line from an unclean shutdown; the rest of the log stands.
      }
    }
    return this;
  }

  /**
   * Append a record.
   * @param {string} kind one of KIND
   * @param {object} [payload]
   * @returns {object} the stored record
   */
  append(kind, payload = {}) {
    const rec = { seq: ++this.seq, ts: Date.now(), kind, ...payload };
    appendFileSync(this.path, JSON.stringify(rec) + '\n');
    this.tail.push(rec);
    if (this.tail.length > MEMORY_TAIL) this.tail.shift();
    this.emit('record', rec);
    return rec;
  }

  /**
   * Records with `seq` greater than `fromSeq`, in order.
   *
   * `limit` keeps only the newest that many. A session that has been going for
   * days runs to tens of thousands of records, and handing every one of them
   * to a client that shows the end of a conversation is what stopped the web
   * UI loading at all. The log itself is still whole; this is only how much of
   * it travels at once.
   */
  readFrom(fromSeq = 0, { limit = 0 } = {}) {
    const cut = (records) =>
      limit > 0 && records.length > limit ? records.slice(-limit) : records;

    // The newest records are the ones held in memory, so a bounded read never
    // has to go to disk — which for a long log means not parsing megabytes to
    // throw nearly all of it away.
    if (limit > 0 && this.tail.length >= limit && this.tail.at(-limit).seq > fromSeq) {
      return this.tail.slice(-limit);
    }

    const oldestInMemory = this.tail.length ? this.tail[0].seq : Infinity;
    if (fromSeq + 1 >= oldestInMemory || this.tail.length === 0) {
      return cut(this.tail.filter((r) => r.seq > fromSeq));
    }
    // Requested range predates the memory tail — reread the log.
    if (!existsSync(this.path)) return [];
    const out = [];
    for (const line of readFileSync(this.path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.seq > fromSeq) out.push(rec);
      } catch {
        /* skip torn line */
      }
    }
    return cut(out);
  }

  /**
   * Records from the start of the log through the first real user message.
   * Reads only as far as needed so a multi-megabyte transcript is not loaded
   * just to find the opening prompt.
   */
  openingFromStart() {
    const oldestInMemory = this.tail.length ? this.tail[0].seq : Infinity;
    if (oldestInMemory <= 1) {
      return collectOpening(this.tail);
    }
    if (!existsSync(this.path)) return collectOpening(this.tail);

    const out = [];
    let fd;
    try {
      fd = openSync(this.path, 'r');
      let buf = '';
      const chunk = Buffer.alloc(64 * 1024);
      while (out.length < OPENING_SCAN_MAX) {
        const n = readSync(fd, chunk, 0, chunk.length, null);
        if (n === 0) break;
        buf += chunk.toString('utf8', 0, n);
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          try {
            const rec = JSON.parse(line);
            out.push(rec);
            if (isOpeningUser(rec)) return out;
            if (out.length >= OPENING_SCAN_MAX) return [];
          } catch {
            /* skip torn line */
          }
        }
      }
    } catch {
      return [];
    } finally {
      if (fd != null) closeSync(fd);
    }
    return [];
  }
}

/** Lazily-opened collection of per-session transcripts. */
export class TranscriptStore {
  constructor(dir) {
    this.dir = dir;
    this.open = new Map();
    mkdirSync(dir, { recursive: true });
  }

  async get(sessionId) {
    let t = this.open.get(sessionId);
    if (t) return t;
    t = await new Transcript(this.dir, sessionId).open();
    this.open.set(sessionId, t);
    return t;
  }
}
