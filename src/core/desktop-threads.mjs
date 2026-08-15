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
import { decodeToolBinary } from './tool-binary.mjs';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APPDATA = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
const IDE_DB = join(APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb');

const BUBBLE_USER = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * How many more times to look after a turn's generation id disappears, before
 * accepting that the turn really is over. Four polls is a couple of seconds in
 * practice: long enough for the desktop to finish writing its last message,
 * short enough that nobody notices the turn ending late.
 */
export const SETTLE_LOOKS = 4;

/** What Auto calls a desktop thread before the IDE has named it. */
export const UNTITLED_THREAD = 'Desktop chat';

/**
 * A name the desktop actually chose, not our placeholder for an unnamed one.
 *
 * Cursor writes the real title after the first exchange. Until then the
 * field is empty, and treating the placeholder as a name locked every new
 * Auto chat as "Desktop chat" forever.
 */
export function realTitle(name) {
  const t = String(name || '').trim();
  return t && t !== UNTITLED_THREAD ? t : null;
}

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
 * There are two eras of bubble here. Older ones keep the arguments and the
 * answer as JSON strings (`params`, `result`). Current ones keep no answer at
 * all: the command, everything it printed and what it exited with are a
 * protobuf blob in `toolCallBinary`, and the JSON `result` never appears — which
 * is why commands reached phones with no output and stuck at "loading". The blob
 * is read first and the JSON is still honoured, so old threads keep working.
 */
function toolDetail(tool) {
  const params = parse(tool.params) || parse(tool.rawArgs) || {};
  const result = parse(tool.result);
  const blob = tool.toolCallBinary ? decodeToolBinary(tool.toolCallBinary) : null;

  let input = null;
  const command = blob?.command || params.command;
  if (command) {
    const cwd = blob?.cwd || params.cwd;
    input = { command, ...(cwd ? { cwd } : {}) };
  } else if (Object.keys(params).length) {
    const { parsingResult, ...rest } = params;
    input = rest;
  }

  // Only prose is worth putting on a screen. A file edit answers with content
  // hashes, which say nothing to anyone and would bury the commands that do.
  let output = blob?.output || null;
  if (!output) {
    for (const key of ['output', 'stdout', 'text', 'error', 'message']) {
      if (typeof result?.[key] === 'string' && result[key]) {
        output = result[key];
        break;
      }
    }
  }
  if (output && output.length > OUTPUT_LIMIT) {
    output = `${output.slice(0, OUTPUT_LIMIT)}\n… ${output.length - OUTPUT_LIMIT} more characters`;
  }

  return {
    input,
    output,
    exitCode: blob?.exitCode ?? null,
    durationMs: blob?.durationMs ?? null,
    failed: Boolean(blob?.failed),
    finished: Boolean(blob?.finished),
    diff: tool.additionalData?.precomputedDiff || null,
  };
}

/**
 * Cursor already computed the edit as a line list. Turn that into the same
 * `{ type: 'diff', path, oldText, newText }` block ACP attaches, so the web
 * can draw the patch instead of an OTHER card named edit_file_v2.
 */
export function diffFromPrecomputed(precomputed, path) {
  const lines = precomputed?.lines;
  if (!Array.isArray(lines) || !lines.length) return null;
  const oldLines = [];
  const newLines = [];
  for (const line of lines) {
    const text = String(line?.content ?? '');
    const kind = String(line?.type || '').toLowerCase();
    if (kind === 'added' || kind === 'add') newLines.push(text);
    else if (kind === 'deleted' || kind === 'removed' || kind === 'del') oldLines.push(text);
    else {
      oldLines.push(text);
      newLines.push(text);
    }
  }
  return { type: 'diff', path: path || '', oldText: oldLines.join('\n'), newText: newLines.join('\n') };
}

/**
 * What to call a tool call.
 *
 * Cursor names an MCP call `mcp-<server>-<tool>`, but writes the bubble the
 * moment the call starts — when both halves are still empty and the name reads
 * "mcp--". Sixteen cards in one conversation said that and nothing else. The
 * server and tool are worth separating too: "cursor-ide-browser: browser_cdp"
 * is a thing a person can read on a phone.
 */
export function toolName(tool) {
  const raw = String(tool?.name || tool?.tool || '').trim();
  if (!raw) return 'tool';
  const mcp = raw.match(/^mcp-(.*)$/);
  if (!mcp) return raw;
  const rest = mcp[1].replace(/^-+|-+$/g, '');
  if (!rest) return 'tool';
  // The tool's own name is the last part; everything before it is the server.
  const cut = rest.lastIndexOf('-');
  return cut > 0 ? `${rest.slice(0, cut)}: ${rest.slice(cut + 1)}` : rest;
}

/**
 * How a tool call went, in the words the rest of Auto uses.
 *
 * Cursor's own marks cannot answer this alone. `status` sits at "loading" while
 * a command runs and `additionalData` reads "cancelled" the whole time it is in
 * flight — trusting that literally reported running commands as stopped and
 * threw away the output that arrived afterwards. So a call is over when Cursor
 * says so or when its answer is actually there, and one that is not over is only
 * still running if the chat is: nothing can be running in an idle chat.
 *
 * `cancelled` is worth keeping apart from `failed`: one is somebody pressing
 * stop, the other is a command that broke.
 */
export function toolStatus({ said, finished, verdict, failed, generating }) {
  const done = said === 'completed' || finished;
  if (!done) return generating ? 'in_progress' : 'cancelled';
  return failed || verdict === 'error' ? 'failed' : 'completed';
}

/** Words in `additionalData.status` that mean nobody is being waited for. */
const ANSWERED = /^(submitted|skipped|cancelled|accepted|rejected|error)$/i;

/** Cursor has already built (or dismissed) this plan. */
const PLAN_SETTLED = /^(done|accepted|approved|rejected|cancelled)$/i;

/**
 * The question this call is putting to a person, if it is one.
 *
 * `ask_question` looks like any other tool call, but it is the one that stops
 * and waits, and Cursor's own marks do not say so where you would expect:
 * `status` reads "completed" as soon as the card has been *drawn*, long before
 * anybody has answered it. Whether a person still has it in front of them is in
 * `additionalData.status` — "pending" until they answer, "submitted" after.
 * Reading the outer status is why a question reached a phone as a finished tool
 * call with nothing to answer and no text on it.
 *
 * A card holds several questions, each with its own options and its own
 * free-text box, and selections are arrays because a question can allow more
 * than one answer. That shape comes from Cursor, not from us.
 *
 * An unfamiliar state counts as still waiting, and the exact word is carried
 * along: being nagged about a question that is over is recoverable, and silence
 * about one that is not is exactly the bug this exists to fix.
 */
export function questionOf(tool) {
  if ((tool?.name || tool?.tool) !== 'ask_question') return null;

  const params = parse(tool.params) || parse(tool.rawArgs) || null;
  const questions = (params?.questions || []).map((q) => ({
    id: q.id,
    prompt: String(q.prompt || ''),
    multiple: Boolean(q.allow_multiple),
    options: (q.options || []).map((o) => ({ id: o.id, label: String(o.label || '') })),
  }));

  const state = tool.additionalData?.status || null;
  // The card exists but Cursor has not written what it asks yet. Nothing can be
  // put to anyone, and saying "a question with no text" is worse than waiting.
  if (!questions.length) return { asked: false, waiting: false, state, questions: [] };

  return {
    asked: true,
    waiting: Boolean(state) && !ANSWERED.test(state),
    state,
    title: params.title ? String(params.title) : null,
    questions,
    selections: tool.additionalData?.currentSelections || null,
    texts: tool.additionalData?.freeformTexts || null,
  };
}

/**
 * The plan this call created, if it is one.
 *
 * `create_plan` looks like any other tool call, so without this it reaches a
 * phone as an empty OTHER bar named `create_plan`. Cursor itself draws a
 * "Created Plan" card: a title, a short overview, View Plan for the markdown,
 * and Build (with a model) to start implementing. The same fields live on the
 * bubble — `params.name` / `overview` / `plan` / `todos`, and whether anyone
 * has built it yet in `additionalData.reviewData.status`.
 *
 * Older bubbles only carried the markdown. The first heading is then the
 * title, and there is no overview until View Plan is opened. An unfamiliar
 * review word counts as still waiting, the way a question does: being offered
 * Build twice is recoverable, silence about a plan that is not built is not.
 */
export function planOf(tool) {
  if ((tool?.name || tool?.tool) !== 'create_plan') return null;

  const params = parse(tool.params) || parse(tool.rawArgs) || {};
  const extra = tool.additionalData || {};
  const review = extra.reviewData || {};
  const state = review.status || null;
  const markdown = typeof params.plan === 'string' ? params.plan : '';
  const heading = markdown.match(/^#\s+(.+)$/m);
  const name = params.name ? String(params.name) : heading ? heading[1].trim() : null;
  const overview = params.overview ? String(params.overview) : null;
  const todos = (params.todos || []).map((t) => ({
    id: t.id,
    content: String(t.content || ''),
    status: String(t.status || 'pending'),
  }));

  if (!name && !overview && !markdown) {
    return { asked: false, waiting: false, state, name: null, overview: null, markdown: '', todos: [] };
  }

  return {
    asked: true,
    waiting: Boolean(state) && !PLAN_SETTLED.test(state),
    state,
    name,
    overview,
    markdown,
    todos,
    planId: extra.planId ? String(extra.planId) : null,
    planUri: extra.planUri ? String(extra.planUri) : null,
    option: review.selectedOption && review.selectedOption !== 'none' ? String(review.selectedOption) : null,
  };
}

/**
 * A short print of what a bubble is saying now, to tell a re-read of the same
 * thing from a bubble that has moved on. Length is enough: text and output only
 * ever grow.
 *
 * A question is the exception: it is answered without anything about the call
 * getting longer or changing status, so the print carries the state of the
 * question too. Without it, the answer to a question is never noticed.
 */
function printOf(message) {
  if (message.kind === 'tool') {
    const asked = message.question ? `:${message.question.state || 'none'}` : '';
    const plan = message.plan
      ? `:${message.plan.state || 'none'}:${message.plan.markdown?.length || 0}`
      : '';
    const diff = message.content?.length ? `:${message.content.length}` : '';
    return `${message.status}:${message.output?.length || 0}${asked}${plan}${diff}`;
  }
  return `${message.kind}:${message.text?.length || 0}`;
}

/** What a bubble is worth showing, if anything. */
function messageOf(bubble, { generating = false, grouping = null } = {}) {
  if (!bubble || typeof bubble !== 'object') return null;
  const role = bubble.type === BUBBLE_USER ? 'user' : 'assistant';

  const tool = bubble.toolFormerData;
  if (tool) {
    const detail = toolDetail(tool);
    const question = questionOf(tool);
    const plan = planOf(tool);
    const status = toolStatus({
      said: tool.status,
      finished: detail.finished,
      verdict: tool.additionalData?.status || null,
      failed: detail.failed,
      generating,
    });
    const path =
      grouping?.toolDisplayPath ||
      detail.input?.relativeWorkspacePath ||
      detail.input?.targetFile ||
      detail.input?.path ||
      null;
    const input = detail.input ? { ...detail.input } : {};
    if (path && !input.relativeWorkspacePath && !input.targetFile && !input.path) input.path = path;
    if (grouping?.editLinesAdded != null) input.added = grouping.editLinesAdded;
    if (grouping?.editLinesRemoved != null) input.removed = grouping.editLinesRemoved;
    if (plan?.asked) {
      if (plan.name) input.name = plan.name;
      if (plan.overview) input.overview = plan.overview;
      if (plan.markdown) input.plan = plan.markdown;
      if (plan.todos?.length) input.todos = plan.todos;
      if (plan.planId) input.planId = plan.planId;
      if (plan.planUri) input.planUri = plan.planUri;
    }
    const diff = diffFromPrecomputed(detail.diff, path);
    const emptyPlan = (tool.name || tool.tool) === 'create_plan' && !plan?.asked;
    return {
      ...(question ? { question } : {}),
      ...(plan ? { plan } : {}),
      role,
      kind: 'tool',
      // An MCP call is written before Cursor knows what it is calling, and it
      // writes "mcp--" in the meantime. Say nothing rather than that; the name
      // arrives with a later write.
      name: toolName(tool),
      status,
      input: Object.keys(input).length ? input : null,
      output: detail.output,
      exitCode: detail.exitCode,
      durationMs: detail.durationMs,
      ...(diff ? { content: [diff] } : {}),
      // A call still running will be written again with what it printed, so
      // this bubble is not finished with us yet. Anything else is as final as
      // it is going to get, output or no output — except a question, which is
      // finished with nobody until it has been answered, and a plan still
      // waiting to be built.
      pending:
        status === 'in_progress' ||
        Boolean(question?.waiting) ||
        Boolean(plan?.waiting) ||
        (emptyPlan && generating),
      text: '',
    };
  }

  const text = String(bubble.text || '').trim();
  // An answer is written into its bubble as it is spoken, so what is there
  // mid-turn is a prefix, not the message. Reading it once and calling it done
  // published whatever happened to be written at that instant — a long reply
  // arrived on the phone cut off in the middle of a word. While the chat is
  // generating, a bubble of prose is unfinished business, exactly like a
  // command that has not printed yet. Someone else's message is never a
  // prefix: the desktop writes it whole before the turn starts.
  const growing = generating && role === 'assistant';
  if (text) return { role, kind: 'text', text, pending: growing };

  const thinking = String(bubble.thinking?.text || '').trim();
  if (thinking) return { role, kind: 'thinking', text: thinking, pending: growing };

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
 * @returns {{ title: string|null, generating: boolean, messages: object[],
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
    // The stored status lags; a generation id means a turn is in flight. Read
    // before the bubbles, because whether one is still running depends on it.
    const generating =
      Boolean(data.chatGenerationUUID) || Boolean(data.generatingBubbleIds?.length);

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

      const message = messageOf(bubble, { generating, grouping: header?.grouping || null });
      // An empty bubble is one the desktop has created but not filled in yet,
      // so leave it unvisited and look again on the next pass. A tool call
      // waiting on its output is the same case: something is there to show,
      // but it is not the whole of it.
      if (!message) continue;

      if (!message.pending) visited.push(bubbleId);
      messages.push({ id: bubbleId, at: bubble.createdAt || null, ...message });
    }

    return {
      title: realTitle(data.name),
      generating,
      messages: tail && messages.length > tail ? messages.slice(-tail) : messages,
      visited,
      total: headers.length,
    };
  });
}

/**
 * What a chat is set to: which mode, which model, and how hard it is thinking.
 *
 * The desktop writes all of this beside the thread itself, so what a chat will
 * do next can be answered without touching the window at all. Changing it is
 * another matter entirely — that is a menu, and menus are `cursor-cdp.mjs`.
 *
 * The knobs under a model are Cursor's own names for them: `effort` and
 * `thinking` on the models that have them, `context` for the window size, and
 * `maxMode` beside the model rather than under it.
 *
 * @param {string} threadId
 * @returns {{ mode: string|null, customMode: string|null, model: string|null,
 *   maxMode: boolean, effort: string|null, thinking: boolean|null,
 *   context: string|null } | null}
 */
export function readSettings(threadId) {
  return withDb((db) => {
    const row = db
      .prepare('SELECT value, typeof(value) value_t FROM cursorDiskKV WHERE key = ?')
      .get(`composerData:${threadId}`);
    if (!row) return null;

    let data;
    try {
      data = JSON.parse(textOf(row));
    } catch {
      return null;
    }

    const config = data.modelConfig || {};
    const chosen = config.selectedModels?.[0] || {};
    const knobs = new Map((chosen.parameters || []).map((p) => [p.id, p.value]));
    const said = (key) => (knobs.has(key) ? String(knobs.get(key)) : null);

    return {
      mode: data.unifiedMode || null,
      customMode: data.activeCustomMode || null,
      model: config.modelName || chosen.modelId || null,
      maxMode: Boolean(config.maxMode),
      effort: said('effort'),
      thinking: knobs.has('thinking') ? said('thinking') === 'true' : null,
      context: said('context'),
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
 * Which thread do these messages belong to?
 *
 * Asked when a Cursor window shows messages but will not say which chat they
 * are from — the answer decides whether Auto is allowed to type into it, so it
 * has to be unambiguous. Every bubble the desktop stores is keyed by its
 * thread, so the messages vote and a single winner takes it; a tie means no.
 *
 * @param {string[]} bubbleIds  ids read from a window, newest last
 * @returns {string|null}
 */
export function threadOwning(bubbleIds = []) {
  // A few is plenty to identify a thread, and each one costs a scan.
  const ids = bubbleIds.filter((id) => UUID.test(String(id || ''))).slice(-4);
  if (!ids.length) return null;

  return withDb((db) => {
    const find = db.prepare('SELECT key FROM cursorDiskKV WHERE key LIKE ?');
    const votes = new Map();
    for (const id of ids) {
      for (const row of find.all(`bubbleId:%:${id}`)) {
        const threadId = String(row.key).split(':')[1];
        if (threadId) votes.set(threadId, (votes.get(threadId) || 0) + 1);
      }
    }
    const ranked = [...votes].sort((a, b) => b[1] - a[1]);
    if (!ranked.length) return null;
    if (ranked[1]?.[1] === ranked[0][1]) return null;
    return ranked[0][0];
  });
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
        // Anything unfinished is read again every pass — a call waiting on its
        // output, a reply still being written. Say something only when there is
        // something new to say, including on the pass where it becomes final:
        // otherwise every message would be announced twice, once mid-flight
        // and once again the moment the turn ends.
        const print = printOf(message);
        if (this.echoed.get(message.id) === print) {
          if (!message.pending) this.echoed.delete(message.id);
          continue;
        }
        if (message.pending) this.echoed.set(message.id, print);
        else this.echoed.delete(message.id);
        said += 1;
        this.emit('message', message);
      }

      const named = realTitle(state.title);
      if (named && named !== this.title) {
        this.title = named;
        this.emit('title', named);
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
