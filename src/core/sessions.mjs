/**
 * Session manager — the heart of the host.
 *
 * One Auto session is one conversation. New ones start as a chat in the Cursor
 * desktop app when a window already has that folder open; otherwise they spawn
 * `cursor-agent acp`. Agent processes are spawned lazily and resumed via
 * `session/load`, so an idle ACP session costs nothing but its history stays
 * intact across restarts.
 *
 * Our session ids are ours, not the agent's: an ACP session can be rotated
 * underneath (after a crash, say) while the transcript and everything the user
 * sees carries on uninterrupted.
 *
 * A session can also be a thread living in the Cursor desktop app rather than
 * an agent of ours. Those behave the same from the outside — you talk to them
 * and they answer — but underneath there is no process to run: messages go to
 * the IDE through its bridge and come back by watching its database. What the
 * desktop owns, the desktop keeps: its model, its mode, its approvals.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { AcpClient } from '../acp/client.mjs';
import { TranscriptStore, KIND } from './transcript.mjs';
import { mapUpdate } from './map-updates.mjs';
import { PermissionBroker, POLICY } from './permissions.mjs';
import { TerminalRegistry } from './terminals.mjs';
import { sendMessage } from './desktop-bridge.mjs';
import { CursorCdp } from './cursor-cdp.mjs';
import { DesktopOutbox } from './desktop-outbox.mjs';
import { ThreadWatcher, readThread, realTitle, UNTITLED_THREAD, SETTLE_LOOKS, isHarnessPrompt } from './desktop-threads.mjs';
import { labelsForAnswer, indexesForAnswer } from './questions.mjs';
import { classifyTool } from './desktop-tool-ui.mjs';

/** Same words, even when Cursor stores a different apostrophe or spacing. */
export function echoKey(text) {
  return String(text || '')
    .normalize('NFC')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export const STATUS = {
  idle: 'idle',
  busy: 'busy',
  starting: 'starting',
  error: 'error',
  archived: 'archived',
};

/**
 * Upstream failures arrive as ordinary assistant prose and end the turn
 * normally, so they need catching by shape. Observed: "RetriableError:
 * [unavailable] PING timed out".
 *
 * Not all of them say anything at all; the silent kind is caught in `prompt`
 * by the turn producing no prose whatsoever.
 */
const UPSTREAM_ERROR_RE =
  /\b(RetriableError|ConnectError|\[unavailable\]|PING timed out|rate.?limit(ed)?|upstream (error|timeout))\b/i;

/**
 * A tool call can also be lost by being *printed*. The model writes one in the
 * control tokens its chat template reserves for the purpose, nothing upstream
 * parses them back into a call, and the tokens arrive here as the reply — then
 * the turn ends politely, mid-sequence, having run nothing. Seen as a session
 * that said "Let me grab the product page" and then spelled out two web
 * fetches as `<|open|>call tool="WebFetch…`, which read on a phone as the UI
 * breaking.
 *
 * It takes two tokens to count: prose discussing chat templates quotes one.
 */
const LEAKED_TOOL_CALL_RE = /<\|[a-z0-9_]+\|>[\s\S]{0,400}?<\|[a-z0-9_]+\|>/i;

/**
 * What a run of assistant prose is worth complaining about, if anything.
 *
 * Exported because both kinds of failure are recognised by their shape alone,
 * and a shape is worth pinning down in a test.
 */
export function upstreamComplaint(prose) {
  const text = String(prose || '');
  if (LEAKED_TOOL_CALL_RE.test(text)) {
    return 'The reply broke into raw tool-call markup — the model printed a tool call instead of making one, so nothing ran. Send it again.';
  }
  if (UPSTREAM_ERROR_RE.test(text)) return text.trim();
  return null;
}

/**
 * Whether a desktop thread's new name should replace what Auto is showing.
 *
 * The IDE names a chat after the first exchange. A placeholder is not a name
 * we chose, so it must not block that — even if an earlier attach locked it.
 * An explicit rename here still wins.
 */
export function adoptDesktopTitle(current, incoming) {
  const named = realTitle(incoming);
  if (!named) return null;
  if (current?.titleLocked && realTitle(current.title)) return null;
  if (current?.title === named && current.titleLocked) return null;
  return { title: named, titleLocked: true };
}

/**
 * A command's output in the shape the views already know how to draw.
 *
 * Sent as an object rather than a bare string so the exit code and how long it
 * took travel with it — a failed command is worth marking as failed on a phone,
 * and "exit 1" is the whole story more often than the output is.
 */
function desktopOutput(message) {
  if (!message.output && message.exitCode === null && !message.durationMs) return undefined;
  return {
    ...(message.output ? { text: message.output } : {}),
    ...(message.exitCode === null || message.exitCode === undefined
      ? {}
      : { exitCode: message.exitCode }),
    ...(message.durationMs ? { durationMs: message.durationMs } : {}),
  };
}

export class SessionManager extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.stateDir   directory for sessions.json and transcripts
   * @param {string} opts.defaultFolder folder for new sessions
   */
  constructor({ stateDir, defaultFolder, defaultPolicy = POLICY.auto }) {
    super();
    this.stateDir = stateDir;
    this.statePath = join(stateDir, 'sessions.json');
    this.defaultFolder = defaultFolder;
    this.defaultPolicy = Object.values(POLICY).includes(defaultPolicy)
      ? defaultPolicy
      : POLICY.auto;
    this.transcripts = new TranscriptStore(join(stateDir, 'transcripts'));
    this.permissions = new PermissionBroker();
    this.terminals = new TerminalRegistry();
    /** The Cursor windows themselves, when Cursor was started with its port. */
    this.cursor = new CursorCdp();
    /** Messages the desktop refused, waiting for it to come back. */
    this.outbox = new DesktopOutbox({
      send: (sessionId, text) => this.#deliverDesktop(sessionId, text),
    });
    /** @type {Map<string, object>} persisted session metadata */
    this.meta = new Map();
    /** @type {Map<string, object>} live runtime state, keyed by session id */
    this.live = new Map();
    this.activeId = null;
    /**
     * Modes and models are account-wide, but only arrive when a session goes
     * live. Cache them so a picker can be drawn before anything has started.
     */
    this.catalog = { models: [], modes: [] };
    mkdirSync(stateDir, { recursive: true });

    this.permissions.on('requested', (req) => {
      this.#record(req.sessionId, KIND.permissionRequest, {
        requestId: req.requestId,
        toolCall: req.toolCall,
        options: req.options,
      });
    });
    this.outbox.on('sent', ({ sessionId, waitedMs, remaining }) => {
      const mins = Math.max(1, Math.round(waitedMs / 60_000));
      this.#record(sessionId, KIND.notice, {
        text:
          `Cursor took the message that was waiting (about ${mins} minute${mins === 1 ? '' : 's'}).` +
          (remaining ? ` ${remaining} still queued.` : ''),
      });
      this.#update(sessionId, {
        status: STATUS.busy,
        outbox: this.outbox.list(sessionId),
      });
      this.#watchDesktop(sessionId);
    });

    this.permissions.on('resolved', (res) => {
      this.#record(res.sessionId, KIND.permissionResolved, {
        requestId: res.requestId,
        optionId: res.optionId,
        automatic: Boolean(res.automatic),
        cancelled: Boolean(res.cancelled),
        by: res.by || null,
      });
    });

    // Terminal output is part of the transcript, so it replays like everything
    // else rather than living only in a live socket.
    this.terminals.on('chunk', ({ sessionId, terminalId, chunk }) => {
      this.#record(sessionId, KIND.terminalChunk, { terminalId, text: chunk });
    });
    this.terminals.on('exit', ({ sessionId, terminalId, status }) => {
      this.#record(sessionId, KIND.terminalChunk, { terminalId, exitStatus: status });
    });
  }

  // ---------------------------------------------------------------- registry

  init() {
    if (existsSync(this.statePath)) {
      try {
        const raw = JSON.parse(readFileSync(this.statePath, 'utf8'));
        for (const s of raw.sessions || []) {
          // Nothing is live yet after a restart, but a session you archived
          // must stay archived — resetting every status brought them all back.
          // Sessions the user never gave an explicit policy follow the
          // configured default, so changing it in .env applies everywhere
          // rather than only to new sessions.
          this.meta.set(s.id, {
            ...s,
            status: s.status === STATUS.archived ? STATUS.archived : STATUS.idle,
            policy: s.policyLocked ? s.policy : this.defaultPolicy,
          });
        }
        this.activeId = raw.activeId || null;
        if (raw.catalog) this.catalog = raw.catalog;
      } catch (err) {
        this.emit('log', `could not read ${this.statePath}: ${err.message}`);
      }
    }
    if (this.meta.size === 0) this.create({ folder: this.defaultFolder });
    if (!this.activeId || !this.meta.has(this.activeId)) {
      this.activeId = [...this.meta.keys()][0];
    }
    return this;
  }

  #persist() {
    const payload = {
      activeId: this.activeId,
      sessions: [...this.meta.values()],
      catalog: this.catalog,
      updatedAt: new Date().toISOString(),
    };
    // Write-then-rename so a crash mid-write cannot leave a truncated registry.
    const tmp = `${this.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n');
    renameSync(tmp, this.statePath);
    this.emit('sessions', this.list());
  }

  list() {
    return [...this.meta.values()]
      .filter((s) => s.status !== STATUS.archived)
      .map((s) => ({ ...s, active: s.id === this.activeId }));
  }

  get(id) {
    return this.meta.get(id) || null;
  }

  create({ folder, title, policy = this.defaultPolicy, mode = 'agent' } = {}) {
    const dir = folder || this.defaultFolder;
    const id = randomUUID();
    const meta = {
      id,
      title: title || basename(dir.replace(/[\\/]+$/, '')) || 'session',
      folder: dir,
      mode,
      policy,
      model: null,
      modelName: null,
      acpSessionId: null,
      status: STATUS.idle,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.meta.set(id, meta);
    if (!this.activeId) this.activeId = id;
    this.#persist();
    return meta;
  }

  /**
   * Start a session the user asked for from the web or the phone.
   *
   * A new chat in Cursor is the same conversation on both ends. If no window
   * has this folder, Auto opens one; if Cursor is not running, Auto starts it
   * with the debug port. Cursor already running without that port has to be
   * restarted — Electron will not add it later. Only if none of that works
   * does this fall back to an Auto-only agent, and it says so.
   */
  async startInIde({ folder, title, policy, mode } = {}) {
    const dir = folder || this.defaultFolder;
    let opened = await this.cursor.newChat({ folder: dir }).catch((err) => ({
      status: 'error',
      reason: err.message,
    }));
    if (opened.status === 'created' && opened.threadId) {
      return this.attachDesktopThread({
        threadId: opened.threadId,
        folder: dir,
        title,
        fresh: true,
      });
    }

    let ready = null;
    if (
      typeof this.cursor.ensureWindow === 'function' &&
      (opened.status === 'no-window' || opened.status === 'no-cdp')
    ) {
      ready = await this.cursor.ensureWindow({ folder: dir }).catch((err) => ({
        status: 'error',
        reason: err.message,
      }));
      if (['showing', 'opened', 'started', 'restarted'].includes(ready.status)) {
        opened = await this.cursor.newChat({ folder: dir }).catch((err) => ({
          status: 'error',
          reason: err.message,
        }));
        if (opened.status === 'created' && opened.threadId) {
          return this.attachDesktopThread({
            threadId: opened.threadId,
            folder: dir,
            title,
            fresh: true,
          });
        }
      }
    }

    const meta = this.create({ folder: dir, title, policy, mode });
    this.setActive(meta.id);
    await this.transcripts.get(meta.id);
    this.#record(meta.id, KIND.notice, { text: this.#whyNotInIde(dir, opened, ready) });
    this.emit('log', `started Auto-only session "${meta.title}" (${opened.status})`);
    return meta;
  }

  /** Why a new session could not be a Cursor chat. */
  #whyNotInIde(folder, opened, ready) {
    if (ready?.status === 'error' || ready?.status === 'no-cdp' || ready?.status === 'no-window') {
      return (
        `This session is only in Auto — tried to open ${folder} in Cursor` +
        (ready.reason ? ` (${ready.reason})` : '.')
      );
    }
    if (opened?.status === 'no-cdp') {
      return (
        `This session is only in Auto — Cursor is not listening on its debug port, ` +
        `so a new chat could not be opened in the IDE.`
      );
    }
    if (opened?.status === 'no-window') {
      return (
        `This session is only in Auto — no Cursor window has ${folder} open.`
      );
    }
    return (
      `This session is only in Auto — Cursor would not start a new chat` +
      (opened?.reason ? ` (${opened.reason})` : '.')
    );
  }

  setActive(id) {
    if (!this.meta.has(id)) return false;
    this.activeId = id;
    this.#persist();
    return true;
  }

  #update(id, patch) {
    const meta = this.meta.get(id);
    if (!meta) return null;
    // A watcher tick can land after archive() and would otherwise set the
    // session back to idle, so it reappeared and × looked like it needed two taps.
    if (meta.status === STATUS.archived) return meta;
    Object.assign(meta, patch, { updatedAt: new Date().toISOString() });
    this.#persist();
    return meta;
  }

  // ------------------------------------------------------------- transcripts

  transcript(id) {
    return this.transcripts.get(id);
  }

  async history(id, fromSeq = 0, limit = 0) {
    const t = await this.transcripts.get(id);
    return t.readFrom(fromSeq, { limit });
  }

  /**
   * Sessions with an agent process actually running.
   *
   * `live` is a scratchpad as much as a process table: a desktop chat keeps its
   * thread watcher there, along with the echoes it is expecting and what it has
   * already published, and none of that is an agent. Counting the map had the
   * host reporting sessions as working when nothing was running at all.
   */
  liveCount() {
    let n = 0;
    for (const runtime of this.live.values()) if (runtime?.client?.running) n += 1;
    return n;
  }

  /** Desktop chats being followed in the IDE, which run no agent of ours. */
  watchingCount() {
    let n = 0;
    for (const runtime of this.live.values()) if (runtime?.watcher) n += 1;
    return n;
  }

  #record(sessionId, kind, payload) {
    const t = this.transcripts.open.get(sessionId);
    if (!t) return null;
    const rec = t.append(kind, payload);
    if (kind === KIND.toolCall && rec.toolCallId) {
      this.#noteTool(sessionId, rec.toolCallId, rec.status || 'in_progress');
    } else if (kind === KIND.toolUpdate && rec.toolCallId && rec.status) {
      this.#noteTool(sessionId, rec.toolCallId, rec.status);
    }
    this.emit('record', { sessionId, record: rec });
    return rec;
  }

  #noteTool(sessionId, toolCallId, status) {
    const runtime = this.live.get(sessionId);
    if (!runtime || !toolCallId) return;
    runtime.openTools = runtime.openTools || new Set();
    const open = status === 'in_progress' || status === 'pending';
    if (open) runtime.openTools.add(toolCallId);
    else runtime.openTools.delete(toolCallId);
  }

  #beginTurn(id) {
    const runtime = this.live.get(id) || {};
    runtime.turnStarted = Date.now();
    runtime.openTools = runtime.openTools || new Set();
    this.live.set(id, runtime);
    return this.#record(id, KIND.turnStart, {});
  }

  #endTurn(id, extra = {}) {
    const runtime = this.live.get(id);
    const durationMs = runtime?.turnStarted ? Date.now() - runtime.turnStarted : undefined;
    this.#settleOpenTools(id);
    const rec = this.#record(id, KIND.turnEnd, {
      ...extra,
      ...(durationMs != null ? { durationMs } : {}),
    });
    if (runtime) runtime.turnStarted = 0;
    return rec;
  }

  #settleOpenTools(id) {
    const runtime = this.live.get(id);
    const open = [...(runtime?.openTools || [])];
    if (runtime) runtime.openTools = new Set();
    for (const toolCallId of open) {
      this.#record(id, KIND.toolUpdate, { toolCallId, status: 'cancelled' });
    }
  }

  // ------------------------------------------------------------------- agent

  /** Spawn (or reuse) the agent process for a session and return its runtime. */
  async ensureLive(id) {
    const meta = this.meta.get(id);
    if (!meta) throw new Error(`Unknown session ${id}`);

    const existing = this.live.get(id);
    if (existing?.client?.running) return existing;

    await this.transcripts.get(id); // make sure the transcript is open for #record
    this.#update(id, { status: STATUS.starting });

    const client = new AcpClient({
      cwd: meta.folder,
      handlers: {
        requestPermission: (params) =>
          this.permissions.request({
            sessionId: id,
            params,
            policy: this.meta.get(id)?.policy || POLICY.ask,
          }),
        readTextFile: ({ path }) => ({ content: readFileSync(path, 'utf8') }),
        writeTextFile: ({ path, content }) => {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, content);
          return {};
        },
        terminalCreate: (params) =>
          this.terminals.create({ ...params, sessionId: id, cwd: params.cwd || meta.folder }),
        terminalOutput: ({ terminalId }) => this.terminals.outputOf(terminalId),
        terminalWaitForExit: ({ terminalId }) => this.terminals.waitForExit(terminalId),
        terminalKill: ({ terminalId }) => this.terminals.kill(terminalId),
        terminalRelease: ({ terminalId }) => this.terminals.release(terminalId),
      },
    });

    const runtime = { client, turn: null, streamBuffer: '', replaying: false };
    this.live.set(id, runtime);

    client.on('log', (m) => this.emit('log', `[${meta.title}] ${m}`));
    client.on('stderr', (s) => {
      const t = s.trim();
      if (t) this.emit('log', `[${meta.title}] stderr: ${t.slice(0, 400)}`);
    });
    client.on('update', ({ update }) => this.#onUpdate(id, update));
    client.on('exit', ({ code, signal }) => {
      this.live.delete(id);
      this.permissions.cancelForSession(id, 'agent exited');
      this.#record(id, KIND.error, {
        text: `Agent process exited (code ${code ?? signal}).`,
        fatal: true,
      });
      this.#update(id, { status: STATUS.error });
    });

    const info = await client.start();

    let session;
    if (meta.acpSessionId) {
      try {
        // Resuming makes the agent replay the whole conversation as updates.
        // We already have all of it on disk, so recording it again would
        // duplicate the history on every restart.
        runtime.replaying = true;
        session = await client.loadSession({ sessionId: meta.acpSessionId, cwd: meta.folder });
        session = { sessionId: meta.acpSessionId, ...(session || {}) };
      } catch (err) {
        this.emit('log', `[${meta.title}] resume failed (${err.message}); starting fresh`);
        this.#record(id, KIND.error, {
          text: `Could not resume the previous agent session, so a new one was started. History above is preserved.`,
        });
        session = null;
      }
    }
    if (!session) session = await client.newSession({ cwd: meta.folder });
    runtime.replaying = false;

    runtime.acpSessionId = session.sessionId;
    runtime.capabilities = info;
    runtime.modes = session.modes || null;
    runtime.models = session.models || null;

    if (session.models?.availableModels?.length) {
      this.catalog = {
        models: session.models.availableModels,
        modes: session.modes?.availableModes || this.catalog.modes,
      };
      this.emit('catalog', this.catalog);
    }

    // Model ids carry their options (`default[]`, `claude-opus-5[thinking=true]`),
    // so keep the id for switching and the name for showing.
    const modelId = session.models?.currentModelId || null;

    this.#update(id, {
      acpSessionId: session.sessionId,
      status: STATUS.idle,
      model: modelId,
      modelName: this.modelName(modelId),
      mode: session.modes?.currentModeId || meta.mode,
    });

    this.#record(id, KIND.sessionStart, {
      folder: meta.folder,
      protocolVersion: info?.protocolVersion,
      modes: runtime.modes,
      models: runtime.models,
    });

    return runtime;
  }

  #onUpdate(id, update) {
    // History being replayed back to us on resume: already on disk, and
    // clients replay from the transcript rather than from the agent.
    if (this.live.get(id)?.replaying) return;

    const mapped = mapUpdate(update);
    if (!mapped) return;

    // Watch assistant prose for upstream failures masquerading as answers.
    if (mapped.kind === KIND.agentDelta) {
      const rt = this.live.get(id);
      if (rt) {
        if (mapped.payload.text) rt.spoke = true;
        rt.streamBuffer = (rt.streamBuffer + (mapped.payload.text || '')).slice(-600);
        const complaint = rt.upstreamErrorFlagged ? null : upstreamComplaint(rt.streamBuffer);
        if (complaint) {
          rt.upstreamErrorFlagged = true;
          this.#record(id, KIND.error, {
            text: complaint,
            upstream: true,
            retryable: true,
          });
        }
      }
    }

    this.#record(id, mapped.kind, mapped.payload);

    if (mapped.kind === KIND.sessionInfo && mapped.payload.title) {
      const meta = this.meta.get(id);
      // Adopt the agent's generated title only while the session is unnamed.
      if (meta && !meta.titleLocked) this.#update(id, { title: mapped.payload.title });
    }
  }

  // ------------------------------------------------------------------- turns

  /**
   * Send a prompt turn.
   * @param {string} id
   * @param {object} p
   * @param {string} p.text
   * @param {Array<{mimeType:string,data:string}>} [p.images] base64 image blocks
   * @param {boolean} [p.shown]  the message is already in the transcript, as a
   *   prompt that waited for its turn is
   */
  async prompt(id, { text, images = [], shown = false } = {}) {
    const meta = this.meta.get(id);
    if (!meta) throw new Error(`Unknown session ${id}`);
    // A desktop chat mid-turn is not a reason to refuse: Cursor queues a
    // message typed while it works, exactly as it does for the chat box, and
    // if it will not, the outbox holds it. Our own agent has no such queue, so
    // Auto keeps one for it rather than turning the message away.
    if (meta.status === STATUS.busy && meta.kind !== 'desktop') {
      return this.#addToTurn(id, { text, images });
    }

    if (meta.kind === 'desktop') {
      if (!text?.trim()) return null;
      return this.#promptDesktop(id, meta, text, images);
    }

    const runtime = await this.ensureLive(id);
    const content = [];
    if (text?.trim()) content.push({ type: 'text', text });
    for (const img of images) {
      content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
    }
    if (content.length === 0) return null;

    if (!shown) this.#record(id, KIND.userMessage, { text, images: images.length });
    this.#beginTurn(id);
    this.#update(id, { status: STATUS.busy });
    runtime.streamBuffer = '';
    runtime.upstreamErrorFlagged = false;
    runtime.spoke = false;
    runtime.interrupted = false;

    try {
      const res = await runtime.client.prompt({
        sessionId: runtime.acpSessionId,
        prompt: content,
      });
      // An answer can also be lost without a word of complaint. Upstream drops
      // the response mid-sentence and the CLI reports the truncation as an
      // ordinary end_turn, so the buffer above has nothing to match on: the
      // turn simply produces no prose. Seen once as thinking that stopped
      // mid-word — "Found", then thirty-four seconds later "Let", then the end
      // of the turn — which on the web is a thinking block folding shut and no
      // reply, and on a phone is silence. Say so instead.
      const silent = res?.stopReason === 'end_turn' && !runtime.spoke && !runtime.interrupted;
      if (silent) {
        this.#record(id, KIND.error, {
          text: 'The turn ended without a reply — the answer was cut off upstream. Send it again.',
          upstream: true,
          retryable: true,
        });
      }
      this.#endTurn(id, {
        stopReason: res?.stopReason,
        upstreamError: Boolean(runtime.upstreamErrorFlagged) || silent,
      });
      this.#update(id, { status: STATUS.idle });
      this.#nextInTurn(id);
      return res;
    } catch (err) {
      this.#record(id, KIND.error, { text: err?.message || String(err) });
      this.#update(id, { status: STATUS.idle });
      this.#nextInTurn(id);
      throw err;
    }
  }

  /**
   * Add to a session that is already working.
   *
   * A second prompt used to be refused outright with "Session is already
   * working", which on a phone means keeping the thought in your head and
   * retyping it when the turn ends. A Cursor chat has never behaved that way —
   * type into it mid-turn and Cursor queues it — so our own agent now does the
   * same. The message sits in the queue, not the transcript, until the agent
   * is free: seeing it in the stream before it has gone in reads as if it
   * already had.
   *
   * The waiting list itself is held in memory only. A queued prompt is worth a
   * minute of patience, not surviving a restart, and the queue on screen is
   * where it can be seen, changed, or taken back.
   */
  #addToTurn(id, { text, images = [] }) {
    if (!text?.trim() && !images.length) return null;
    const runtime = this.live.get(id) || {};
    runtime.waiting = runtime.waiting || [];
    // Each one gets a name of its own so a phone can point at it later without
    // counting positions in a list that moves.
    runtime.waiting.push({ id: randomUUID(), text, images });
    this.live.set(id, runtime);

    this.#update(id, { waiting: runtime.waiting.length });
    this.#sayAutoQueue(id);
    return { status: 'queued', waiting: runtime.waiting.length };
  }

  /** What Auto itself is holding for this session, for anyone watching. */
  #sayAutoQueue(id) {
    const waiting = this.live.get(id)?.waiting || [];
    this.emit('queue', {
      sessionId: id,
      owner: 'auto',
      waiting: waiting.length,
      items: waiting.map((item) => ({
        id: item.id,
        text: item.text,
        images: item.images?.length || 0,
      })),
    });
  }

  /**
   * What is waiting for this turn to end, whoever is holding it.
   *
   * Two different queues wear the same face here. A chat in the Cursor window is
   * queued by Cursor itself — Auto types the message in and the IDE holds it — so
   * that list is read from the window, and the items are named by their own words
   * because that is the only handle Cursor offers. Auto's own sessions keep their
   * queue in memory, where each message has a name of its own.
   *
   * @returns {Promise<{ waiting: number, items: Array<{id: string, text: string}>,
   *   owner: 'cursor'|'auto', hidden?: number, reason?: string }>}
   */
  async queued(id) {
    const meta = this.meta.get(id);
    if (!meta) return { waiting: 0, items: [], owner: 'auto' };

    if (meta.kind === 'desktop') {
      const seen = await this.cursor
        // Somebody asked for this chat's queue, so it is worth bringing the chat
        // forward to answer — the passive watcher does not.
        .queue({ threadId: meta.desktopThreadId, bringForward: true })
        .catch((err) => ({ status: 'error', reason: err.message }));
      if (seen.status !== 'ok') {
        return { waiting: 0, items: [], owner: 'cursor', reason: seen.reason || seen.status };
      }
      return {
        owner: 'cursor',
        waiting: seen.waiting,
        hidden: seen.hidden || 0,
        items: (seen.items || []).map((item) => ({ id: item.text, text: item.text })),
      };
    }

    const waiting = this.live.get(id)?.waiting || [];
    return {
      owner: 'auto',
      waiting: waiting.length,
      items: waiting.map((item) => ({
        id: item.id,
        text: item.text,
        images: item.images?.length || 0,
      })),
    };
  }

  /**
   * Take a queued message out again.
   *
   * Deleting is the one action here that destroys something, so it acts on the
   * message that was chosen or on nothing at all: the queue moves by itself as
   * turns end, and "the second one" a moment ago may be someone else's words now.
   */
  async dropQueued(id, itemId) {
    const meta = this.meta.get(id);
    if (meta?.kind === 'desktop') return this.#queueActInCursor(id, meta, itemId, 'drop');

    const runtime = this.live.get(id);
    const waiting = runtime?.waiting || [];
    const at = waiting.findIndex((item) => item.id === itemId);
    if (at < 0) return { status: 'gone', reason: 'that message is no longer queued' };
    const [dropped] = waiting.splice(at, 1);
    this.#update(id, { waiting: waiting.length });
    this.#sayAutoQueue(id);
    this.#record(id, KIND.notice, {
      text: `Took a queued message back out: "${short(dropped.text)}"`,
    });
    return { status: 'done', waiting: waiting.length };
  }

  /**
   * Put a queued message at the front of the queue, or into Cursor now.
   *
   * Cursor's own button sends it immediately, mid-turn, and pressing it is what a
   * desktop chat gets. Auto's own agents take one turn at a time, so the honest
   * equivalent is to make it the next one in rather than to interrupt work that
   * is already running.
   */
  async sendQueuedNow(id, itemId) {
    const meta = this.meta.get(id);
    if (meta?.kind === 'desktop') return this.#queueActInCursor(id, meta, itemId, 'now');

    const runtime = this.live.get(id);
    const waiting = runtime?.waiting || [];
    const at = waiting.findIndex((item) => item.id === itemId);
    if (at < 0) return { status: 'gone', reason: 'that message is no longer queued' };
    if (at > 0) waiting.unshift(...waiting.splice(at, 1));
    this.#sayAutoQueue(id);
    this.#record(id, KIND.notice, {
      text: `"${short(waiting[0].text)}" goes in first when this turn ends.`,
    });
    return { status: 'done', waiting: waiting.length, next: true };
  }

  /**
   * Change what a queued message says.
   *
   * Auto's own queue is edited where it sits. Cursor's cannot be: its edit button
   * opens an editor inside the IDE, which is no use to a thumb, so the message is
   * taken out and the new wording sent in its place — which Cursor queues at the
   * end. With one message waiting that is the same thing; with several it moves
   * to the back, and saying so is better than pretending otherwise.
   */
  async editQueued(id, itemId, text) {
    const wanted = String(text || '').trim();
    if (!wanted) return { status: 'error', reason: 'an empty message is not an edit' };

    const meta = this.meta.get(id);
    if (meta?.kind === 'desktop') {
      const dropped = await this.#queueActInCursor(id, meta, itemId, 'drop');
      if (dropped.status !== 'done') return dropped;
      const sent = await this.prompt(id, { text: wanted });
      return { status: sent?.status === 'error' ? 'error' : 'done', moved: true, ...sent };
    }

    const waiting = this.live.get(id)?.waiting || [];
    const item = waiting.find((entry) => entry.id === itemId);
    if (!item) return { status: 'gone', reason: 'that message is no longer queued' };
    item.text = wanted;
    this.#sayAutoQueue(id);
    this.#record(id, KIND.notice, { text: `Changed a queued message to: "${short(wanted)}"` });
    return { status: 'done', waiting: waiting.length };
  }

  /** Press one of Cursor's own queue buttons, and say what became of it. */
  async #queueActInCursor(id, meta, text, which) {
    const result = await this.cursor
      .queueAct({ threadId: meta.desktopThreadId, text, which })
      .catch((err) => ({ status: 'error', reason: err.message }));
    if (result.status === 'done') {
      this.emit('queue', { sessionId: id, ...(await this.queued(id)) });
      this.#record(id, KIND.notice, {
        text:
          which === 'drop'
            ? `Took a queued message back out of Cursor: "${short(text)}"`
            : `Sent a queued message into Cursor now: "${short(text)}"`,
      });
    }
    return result;
  }

  /** Send the next thing added while the agent was busy, if there is one. */
  #nextInTurn(id) {
    const runtime = this.live.get(id);
    const next = runtime?.waiting?.shift();
    this.#update(id, { waiting: runtime?.waiting?.length || 0 });
    this.#sayAutoQueue(id);
    if (!next) return;
    // Deliberately not awaited: the turn that has just ended is not answerable
    // for the one that follows it, and its caller is owed its own result.
    this.prompt(id, { ...next }).catch((err) => {
      this.#record(id, KIND.notice, {
        text: `The message that was waiting could not be sent: ${err.message}`,
      });
    });
  }

  async cancel(id) {
    const meta = this.meta.get(id);
    if (meta?.kind === 'desktop') return this.#stopDesktop(id, meta);

    // Stopping means stopping. Anything queued behind this turn was meant to
    // follow it, not to survive it being called off.
    const dropped = this.#dropWaiting(id);

    const runtime = this.live.get(id);
    if (!runtime?.client?.running) return Boolean(dropped);
    // A stopped turn is allowed to end with nothing said, and "Interrupted by
    // user." already covers it — so it must not also be reported as an answer
    // lost upstream.
    runtime.interrupted = true;
    runtime.client.cancel(runtime.acpSessionId);
    this.#record(id, KIND.error, { text: 'Interrupted by user.', interrupted: true });
    return true;
  }

  /** Forget what was queued, and say how much. */
  #dropWaiting(id) {
    const runtime = this.live.get(id);
    const dropped = runtime?.waiting?.length || 0;
    if (!dropped) return 0;
    runtime.waiting = [];
    this.#record(id, KIND.notice, {
      text: `Dropped ${dropped} queued message${dropped === 1 ? '' : 's'} along with the turn.`,
    });
    this.#update(id, { waiting: 0 });
    this.#sayAutoQueue(id);
    return dropped;
  }

  /**
   * Stop a turn that is running in the Cursor window.
   *
   * This used to be a refusal — the bridge can send but not interrupt, so the
   * only answer was "go and press it yourself", which is no use to someone
   * holding a phone. Pressing it is exactly what Auto does now, with Cursor's
   * own keyboard shortcut.
   */
  async #stopDesktop(id, meta) {
    const result = await this.cursor
      .stop({ threadId: meta.desktopThreadId })
      .catch((err) => ({ status: 'error', reason: err.message }));

    if (result.status === 'stopped') {
      this.#record(id, KIND.error, { text: 'Interrupted by user.', interrupted: true });
      if (result.putBack) {
        // Cursor offers the stopped message back for editing. Nobody is there
        // to edit it, and leaving it in the box would block the next one.
        this.#record(id, KIND.notice, {
          text:
            `Cursor put the stopped message back in its chat box; Auto took it out so the ` +
            `chat stays reachable from here. It said: ${result.putBack}`,
        });
      }
      this.#update(id, { status: STATUS.idle });
      this.emit('log', `stopped the turn in Cursor's window (${result.how})`);
      return true;
    }

    this.#record(id, KIND.notice, { text: this.#whyNotStopped(result) });
    return false;
  }

  /** Say what happened instead of stopping, in terms that suggest a fix. */
  #whyNotStopped(result) {
    if (result.status === 'not-running') return 'That chat is not running anything just now.';
    if (result.status === 'unknown-thread') {
      return 'No Cursor window has this chat open, so there is no turn here to stop.';
    }
    if (result.status === 'no-cdp') {
      return (
        'Cursor was started without its debugging port, so Auto cannot reach its buttons — ' +
        'stopping has to be done in Cursor itself.'
      );
    }
    return `Cursor would not stop that turn${result.reason ? `: ${result.reason}` : ''}.`;
  }

  async setMode(id, modeId) {
    if (this.meta.get(id)?.kind === 'desktop') return this.#chooseInCursor(id, 'mode', modeId);
    const runtime = await this.ensureLive(id);
    await runtime.client.setMode({ sessionId: runtime.acpSessionId, modeId });
    this.#update(id, { mode: modeId });
    return true;
  }

  /**
   * Set a desktop chat's model or mode the way a person would: in the window.
   *
   * These used to be refused outright — the chat runs in Cursor, so Cursor was
   * where you had to go and change them. Now the picker beside the chat box is
   * pressed for you, which means the one thing most worth reaching for from a
   * phone no longer needs a keyboard.
   *
   * The desktop's stored record is no use as proof here: it keeps the model a
   * chat was last *sent* with and only catches up on the next message, so the
   * word on the picker is what is trusted, and the outcome is written into the
   * transcript either way.
   */
  async #chooseInCursor(id, picker, wanted) {
    const meta = this.meta.get(id);
    const asked = picker === 'model' ? this.#cursorsNameFor(wanted) : String(wanted || '');
    const result = await this.cursor.choose({
      threadId: meta.desktopThreadId,
      picker,
      wanted: asked,
    });

    if (result.status === 'set' || result.status === 'already') {
      const now = result.now || result.was;
      this.#update(id, picker === 'mode' ? { mode: now } : { model: now, modelName: now });
      this.#record(id, KIND.notice, {
        text:
          result.status === 'already'
            ? `This chat was already on ${now}.`
            : `Cursor's ${picker} for this chat is now ${now} (was ${result.was}).`,
      });
      // Changing the model can end a paused turn; anything still waiting was
      // taken out first so Cursor would not auto-send it. Say what was held.
      if (result.held?.length) {
        const listed = result.held.map((t) => `"${short(t)}"`).join('; ');
        this.#record(id, KIND.notice, {
          text:
            `Took ${result.held.length} queued message${result.held.length === 1 ? '' : 's'} ` +
            `out so changing the ${picker} would not send ${result.held.length === 1 ? 'it' : 'them'}: ${listed}. ` +
            `Send again if you still want ${result.held.length === 1 ? 'it' : 'them'}.`,
        });
        this.emit('queue', { sessionId: id, owner: 'cursor', waiting: 0, items: [], hidden: 0 });
      }
      return true;
    }

    this.#record(id, KIND.notice, { text: this.#whyNotChosen(picker, asked, result) });
    return false;
  }

  /**
   * The name Cursor's own menu would use for a model.
   *
   * The web and Telegram pickers carry the agent's model ids, which are not what
   * a menu says: `claude-opus-5[thinking=true]` is offered as "Opus 5", and
   * `default[]` as "Auto". A plain name is passed through untouched, so typing
   * "Opus 5" works as well as tapping it.
   */
  #cursorsNameFor(wanted) {
    const asked = String(wanted || '');
    if (!asked.includes('[')) return asked;
    if (asked === 'default[]') return 'Auto';
    return this.catalog?.models?.find((m) => m.modelId === asked)?.name || asked.replace(/\[.*$/, '');
  }

  /** Say why a picker would not take a choice, in words worth reading. */
  #whyNotChosen(picker, wanted, result) {
    const offered = result.options?.length ? ` On offer: ${result.options.join(', ')}.` : '';
    if (result.status === 'no-such-option') {
      return `Cursor has no ${picker} matching "${wanted}".${offered}`;
    }
    if (result.status === 'unknown-thread') {
      return `No Cursor window has this chat open, so its ${picker} cannot be reached. Open it in Cursor and try again.`;
    }
    if (result.status === 'no-cdp') {
      return `Cursor is not listening on its debugging port, so its ${picker} cannot be reached. ${result.reason || ''}`.trim();
    }
    if (result.status === 'unchanged') {
      return `Pressed the ${picker} menu but Cursor did not change it — ${result.reason || 'it stayed as it was'}.`;
    }
    return `Could not set the ${picker}: ${result.reason || result.status}.`;
  }

  /**
   * What a desktop chat's pickers are offering.
   *
   * Only the window knows: the list depends on the account and Cursor keeps it
   * nowhere on disk. Reading it opens a menu and closes it again, so it is asked
   * for when somebody wants to choose, not on a timer.
   */
  async desktopChoices(id, picker) {
    const meta = this.meta.get(id);
    if (meta?.kind !== 'desktop') return { status: 'error', reason: 'that is not a Cursor chat' };
    return this.cursor.choices({ threadId: meta.desktopThreadId, picker });
  }

  /** What a desktop chat is set to, from the desktop's own records. */
  desktopSettings(id) {
    const meta = this.meta.get(id);
    if (meta?.kind !== 'desktop') return null;
    return this.cursor.settings({ threadId: meta.desktopThreadId });
  }

  /**
   * Ask the agent for every session it knows about — including ones started
   * from a terminal or by a previous install of Auto — and register the ones
   * we are missing. Without this, Auto shows only its own history while the
   * desktop shows more, which is exactly the wrong way round for a remote
   * control.
   *
   * @returns {Promise<number>} how many sessions were newly adopted
   */
  async syncFromAgent() {
    const live = [...this.live.values()].find((r) => r.client?.running);
    const client = live?.client || new AcpClient({ cwd: this.defaultFolder });
    const throwaway = !live;

    try {
      if (throwaway) await client.start();
      const res = await client.call('session/list', {}, { timeoutMs: 20_000 });
      const known = new Set(
        [...this.meta.values()].map((s) => s.acpSessionId).filter(Boolean),
      );

      let adopted = 0;
      for (const s of res?.sessions || []) {
        if (!s.sessionId || known.has(s.sessionId) || !s.cwd) continue;
        const id = randomUUID();
        this.meta.set(id, {
          id,
          title: s.title || basename(s.cwd) || 'session',
          titleLocked: Boolean(s.title),
          folder: s.cwd,
          mode: 'agent',
          policy: this.defaultPolicy,
          model: null,
          modelName: null,
          acpSessionId: s.sessionId,
          status: STATUS.idle,
          adopted: true,
          createdAt: s.updatedAt || new Date().toISOString(),
          updatedAt: s.updatedAt || new Date().toISOString(),
        });
        adopted += 1;
      }
      if (adopted) {
        this.#persist();
        this.emit('log', `adopted ${adopted} session(s) from the agent`);
      }
      return adopted;
    } finally {
      if (throwaway) await client.stop().catch(() => {});
    }
  }

  // --------------------------------------------------------- desktop threads

  /**
   * Take up a chat that lives in the Cursor desktop app.
   *
   * Nothing is copied: the session points at the desktop's own thread, and
   * from here both ends drive the same conversation. Its recent history is
   * written into our transcript so the phone has something to show, and a
   * watcher keeps it current — including messages typed in the IDE.
   *
   * @param {object} opts
   * @param {string} opts.threadId  the desktop thread (composer) id
   * @param {string} [opts.folder]  folder the thread belongs to
   * @param {string} [opts.title]
   * @param {boolean} [opts.fresh]  we just created it; wait for the desktop
   *   to write it, and attach even if the database has not caught up yet
   */
  async attachDesktopThread({ threadId, folder, title, fresh = false }) {
    // Opening the same thread twice should land you back where you were.
    const already = [...this.meta.values()].find(
      (s) => s.desktopThreadId === threadId && s.status !== STATUS.archived,
    );
    if (already) {
      this.setActive(already.id);
      this.#watchDesktop(already.id);
      return already;
    }

    let state = readThread(threadId, { tail: 40 });
    if (!state && fresh) {
      for (let look = 0; look < 12 && !state; look += 1) {
        await new Promise((resolve) => setTimeout(resolve, 80));
        state = readThread(threadId, { tail: 40 });
      }
    }
    if (!state && fresh) {
      state = { title: realTitle(title), generating: false, messages: [], visited: [], total: 0 };
    }
    if (!state) throw new Error('That chat is not in the Cursor desktop database');

    const named = realTitle(title) || realTitle(state.title);
    const id = randomUUID();
    const meta = {
      id,
      kind: 'desktop',
      desktopThreadId: threadId,
      // "Desktop chat" is a label, not a name. Locking it stopped Auto from
      // taking the title Cursor writes after the first exchange.
      title: named || UNTITLED_THREAD,
      titleLocked: Boolean(named),
      folder: folder || this.defaultFolder,
      mode: 'agent',
      policy: this.defaultPolicy,
      model: null,
      modelName: null,
      acpSessionId: null,
      status: state.generating ? STATUS.busy : STATUS.idle,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.meta.set(id, meta);
    this.activeId = id;
    this.#persist();

    await this.transcripts.get(id);
    const hidden = Math.max(0, state.total - state.visited.length);
    this.#record(id, KIND.notice, {
      text:
        `This chat lives in the Cursor desktop app — you are both in the same conversation.` +
        (hidden ? ` Showing the last ${state.messages.length} messages.` : ''),
    });
    for (const message of state.messages) this.#recordDesktopMessage(id, message);

    // Everything read above is history, not news.
    this.#watchDesktop(id, state.visited);
    this.emit('log', `attached desktop thread "${meta.title}"`);
    this.emit('sessions', this.list());
    return meta;
  }

  /** Turn one desktop bubble into transcript records. */
  #recordDesktopMessage(id, message) {
    if (message.role === 'user') {
      if (isHarnessPrompt(message.text)) return;
      this.#record(id, KIND.userMessage, { text: message.text, desktopBubbleId: message.id });
      return;
    }
    if (message.kind === 'thinking') {
      const words = this.#newWordsOf(id, message);
      if (words.text) {
        this.#record(id, KIND.agentThought, {
          text: words.text,
          desktopBubbleId: message.id,
          ...(words.replace ? { replace: true } : {}),
        });
      }
      return;
    }
    if (message.kind === 'tool') {
      // The desktop writes a call twice: once when it starts, with what it was
      // asked to do, and again with what came of it. The second sighting has
      // to update the card the first one drew, or a command and its output
      // end up as two unrelated things on the screen.
      const runtime = this.live.get(id) || {};
      runtime.toolsDrawn = runtime.toolsDrawn || new Set();
      runtime.toolNames = runtime.toolNames || new Map();
      this.live.set(id, runtime);

      if (message.question) this.#recordQuestion(id, message);

      if (runtime.toolsDrawn.has(message.id)) {
        // Cursor writes an MCP call before it knows what it is calling, so the
        // card was drawn as "mcp--" and stayed that way for good. If the name
        // has arrived since, send it along with the update.
        const better =
          message.name && message.name !== runtime.toolNames.get(message.id) ? message.name : null;
        if (better) runtime.toolNames.set(message.id, better);
        this.#record(id, KIND.toolUpdate, {
          toolCallId: message.id,
          status: message.status || 'completed',
          rawOutput: desktopOutput(message),
          ...(better ? { title: better } : {}),
          ...(message.content ? { content: message.content } : {}),
          ...(message.plan?.asked
            ? {
                rawInput: message.input || undefined,
                awaitingBuild: Boolean(message.plan.waiting),
              }
            : {}),
        });
        if (message.plan) this.#rememberPlan(id, message);
        return;
      }

      runtime.toolsDrawn.add(message.id);
      runtime.toolNames.set(message.id, message.name);
      const ui = classifyTool({ title: message.name, rawInput: message.input });
      this.#record(id, KIND.toolCall, {
        toolCallId: message.id,
        title: message.name,
        toolKind: ui.toolKind,
        status: message.status || 'completed',
        rawInput: message.input || undefined,
        rawOutput: desktopOutput(message),
        ...(message.content ? { content: message.content } : {}),
        ...(message.plan
          ? { awaitingBuild: Boolean(message.plan.waiting) }
          : {}),
      });
      if (message.plan) this.#rememberPlan(id, message);
      return;
    }
    const words = this.#newWordsOf(id, message);
    if (words.text) {
      this.#record(id, KIND.agentDelta, {
        text: words.text,
        desktopBubbleId: message.id,
        ...(words.replace ? { replace: true } : {}),
      });
    }
  }

  /**
   * A question Cursor is putting to a person, said out loud once.
   *
   * The bubble holding one is re-read every couple of seconds for as long as it
   * goes unanswered, so this is where the repetition stops: the question when it
   * appears, the answer when it arrives, nothing in between.
   *
   * It is also what tells the approval watcher to keep its hands off. A question
   * card's own buttons are "Skip" and "Continue" — indistinguishable from an
   * approval by their words, and pressing either from a phone answers the
   * question with whatever happened to be selected, which is usually nothing.
   */
  #recordQuestion(id, message) {
    const { question } = message;
    if (!question) return;

    const runtime = this.live.get(id) || {};
    runtime.questions = runtime.questions || new Map();
    this.live.set(id, runtime);
    const said = runtime.questions.get(message.id) || null;
    const statusOf = (s) => (typeof s === 'string' ? s : s?.status);
    const answered = /^(submitted|skipped|cancelled|accepted|rejected|error)$/i.test(
      question.state || '',
    );

    // The card is drawn before Cursor writes what it asks. Keep the approval
    // watcher off from that moment, even with no options yet — Skip on the
    // card is not a permission. Put it on the phone only once there is
    // something to answer.
    const stillOpen = question.waiting || (!question.asked && !answered);
    if (stillOpen) {
      const hadOptions = Boolean(said?.questions?.length);
      runtime.questions.set(message.id, {
        status: 'waiting',
        title: question.title || said?.title || null,
        questions: question.questions?.length ? question.questions : said?.questions || [],
      });
      if (question.asked && !hadOptions) {
        this.#record(id, KIND.question, {
          askId: message.id,
          title: question.title,
          questions: question.questions,
          state: question.state,
        });
      }
      return;
    }

    // Answered, in the IDE or from here. Either way it has stopped being an
    // open question, and what was chosen is worth keeping.
    if (statusOf(said) !== 'waiting') return;
    runtime.questions.set(message.id, { status: 'answered' });
    this.#record(id, KIND.questionAnswered, {
      askId: message.id,
      selections: question.selections,
      texts: question.texts,
      state: question.state,
    });
  }

  /** Is a question card waiting for a person in this chat? */
  #questionWaiting(id) {
    const runtime = this.live.get(id);
    if (!runtime?.questions) return false;
    for (const state of runtime.questions.values()) {
      if (state === 'waiting' || state?.status === 'waiting') return true;
    }
    return false;
  }

  /** The question still waiting in this chat, if there is one. */
  pendingQuestion(id) {
    const runtime = this.live.get(id);
    if (!runtime?.questions) return null;
    let found = null;
    for (const [askId, state] of runtime.questions) {
      if (state === 'waiting' || state?.status === 'waiting') {
        found = { askId, title: state?.title || null, questions: state?.questions || [] };
      }
    }
    return found;
  }

  /**
   * Answer a question from the web or Telegram, by pressing the choice in Cursor.
   *
   * The card stays "waiting" until Cursor itself marks it submitted: that is
   * what draws "Answered" on the phone, and marking it here first would swallow
   * that. A failed press leaves it waiting so it can be tried again.
   */
  async answerQuestion(id, { askId, selections = {}, texts = {}, skip = false } = {}) {
    const meta = this.meta.get(id);
    if (!meta) throw new Error(`Unknown session ${id}`);
    if (meta.kind !== 'desktop' || !meta.desktopThreadId) {
      throw new Error('Only a desktop chat can take an answer this way');
    }

    const held = this.live.get(id)?.questions?.get(askId);
    const waiting = held === 'waiting' || held?.status === 'waiting';
    if (!waiting) return { status: 'gone', reason: 'that question is no longer waiting' };

    const questions = held?.questions || [];
    const labels = skip ? [] : labelsForAnswer(questions, selections);
    const indexes = skip ? [] : indexesForAnswer(questions, selections);
    const typed = Object.values(texts || {}).filter(Boolean);

    const pressed = await this.cursor
      .answer({
        threadId: meta.desktopThreadId,
        askId,
        labels,
        indexes,
        texts: typed,
        skip: Boolean(skip),
      })
      .catch((err) => ({ status: 'error', reason: err.message }));

    const what = skip ? 'Skip' : labels.join(', ') || 'nothing';
    this.#record(id, KIND.notice, {
      text:
        pressed.status === 'pressed'
          ? `Answered in Cursor: ${what}.`
          : `Could not answer in Cursor: ${pressed.reason || pressed.status}.`,
    });
    return pressed;
  }

  /**
   * Remember a Created Plan so Build from the phone still knows which bubble
   * to press, and so a plan built in the IDE is marked built here too.
   */
  #rememberPlan(id, message) {
    const { plan } = message;
    if (!plan?.asked) return;
    const runtime = this.live.get(id) || {};
    runtime.plans = runtime.plans || new Map();
    this.live.set(id, runtime);
    runtime.plans.set(message.id, {
      status: plan.waiting ? 'waiting' : 'built',
      name: plan.name,
      overview: plan.overview,
      markdown: plan.markdown,
      planId: plan.planId,
    });
  }

  /**
   * Build a plan Cursor created, from the web or Telegram.
   *
   * Presses the card's own Build — and the model on that card, when one was
   * named — so the chat that wrote the plan is the one that implements it.
   * A plan already built in the IDE is refused rather than started twice.
   */
  async buildPlan(id, { toolCallId, model } = {}) {
    const meta = this.meta.get(id);
    if (!meta) throw new Error(`Unknown session ${id}`);
    if (meta.kind !== 'desktop' || !meta.desktopThreadId) {
      throw new Error('Only a desktop chat can build a plan this way');
    }
    if (!toolCallId) throw new Error('no plan was named');

    const held = this.live.get(id)?.plans?.get(toolCallId);
    if (held?.status === 'built') {
      return { status: 'gone', reason: 'that plan has already been built' };
    }

    const wanted = model ? this.#cursorsNameFor(model) : '';
    const pressed = await this.cursor
      .buildPlan({
        threadId: meta.desktopThreadId,
        bubbleId: toolCallId,
        model: wanted,
      })
      .catch((err) => ({ status: 'error', reason: err.message }));

    const how = wanted ? `Build with ${wanted}` : 'Build';
    this.#record(id, KIND.notice, {
      text:
        pressed.status === 'pressed'
          ? `Building in Cursor: ${how}.`
          : `Could not build in Cursor: ${pressed.reason || pressed.status}.`,
    });
    return pressed;
  }

  /**
   * The part of a mirrored message that has not been said yet.
   *
   * A desktop bubble is read repeatedly while it is being written, and each read
   * holds the whole answer so far. Clients append what they are given, so what
   * goes into the transcript is the new tail — record the whole bubble each time
   * and the reply reads as the same paragraph over and over.
   *
   * A stale shorter snapshot must not move `textSaid` backwards. A real rewrite
   * is marked `replace` so the client swaps the bubble rather than appending.
   */
  #newWordsOf(id, message) {
    const runtime = this.live.get(id) || {};
    runtime.textSaid = runtime.textSaid || new Map();
    this.live.set(id, runtime);

    const said = runtime.textSaid.get(message.id) || '';
    const whole = String(message.text || '');
    const delta = proseDelta(said, whole);
    // Nothing new (including a stale shorter read): leave the high-water mark.
    if (!delta.text && !delta.replace) return delta;
    // A bubble that is finished with needs no further bookkeeping.
    if (message.pending) runtime.textSaid.set(message.id, whole);
    else runtime.textSaid.delete(message.id);

    return delta;
  }

  /** Start following a desktop thread, if we are not already. */
  #watchDesktop(id, alreadySeen = [], { resumeTurn = false } = {}) {
    const meta = this.meta.get(id);
    if (!meta?.desktopThreadId || meta.status === STATUS.archived) return null;

    const existing = this.live.get(id);
    if (existing?.watcher) return existing.watcher;

    const watcher = new ThreadWatcher(meta.desktopThreadId).markSeen(alreadySeen);
    this.live.set(id, { ...(existing || {}), watcher });
    if (resumeTurn) {
      // The previous host died mid-turn. Pretend we are still in it so the
      // settle looks can pick up the answer, then end the turn once Cursor has.
      watcher.running = true;
      watcher.settleLooks = SETTLE_LOOKS;
      this.#update(id, { status: STATUS.busy });
    }

    watcher.on('message', (message) => {
      // Our own message comes back to us: it was written into the transcript
      // when we sent it, and the desktop stores it as a bubble like any
      // other. Show it once.
      if (message.role === 'user' && this.#consumeEcho(id, message.text)) return;
      this.#recordDesktopMessage(id, message);
    });
    watcher.on('running', (running) => {
      // A turn can start because someone typed in the IDE, so the transcript
      // should show one either way.
      if (running) this.#beginTurn(id);
      else {
        this.#endTurn(id, { stopReason: 'end_turn' });
        // Nothing written in a finished turn will grow again, so the record of
        // what was published can go rather than sit there for the session's life.
        this.live.get(id)?.textSaid?.clear();
      }
      this.#update(id, { status: running ? STATUS.busy : STATUS.idle });
      if (running) this.#watchDesktopAsks(id);
    });
    watcher.on('title', (title) => {
      const patch = adoptDesktopTitle(this.meta.get(id), title);
      if (patch) this.#update(id, patch);
    });
    watcher.on('error', (err) => this.emit('log', `[${meta.title}] watching: ${err.message}`));

    watcher.start();
    return watcher;
  }

  /**
   * While a desktop turn runs, watch its window for anything Cursor is asking
   * a person to answer, and ask that person wherever they are.
   *
   * Cursor's approvals are buttons in a window, which is no use to someone on a
   * bus. But an approval is an approval: parked in the same broker as an
   * agent's own, it appears on the phone with the same buttons, and whichever
   * option comes back is pressed in the window. If it gets answered in the IDE
   * first, the request is withdrawn rather than left hanging.
   *
   * The window's own view of whether a turn is running is trusted over the
   * database's, because an approval pauses a turn and might well clear the
   * database's mark of one.
   */
  #watchDesktopAsks(id) {
    const meta = this.meta.get(id);
    if (!meta?.desktopThreadId) return null;
    const runtime = this.live.get(id) || {};
    if (runtime.askTimer) return runtime.askTimer;

    let quiet = 0;
    const look = async () => {
      const state = await this.cursor
        .waitingOn({ threadId: meta.desktopThreadId })
        .catch((err) => ({ status: 'error', reason: err.message }));

      // No window, no port, no watching. It costs nothing to start again when
      // the next turn does.
      if (state.status !== 'ok') return stop();

      // A question card is not an approval. Its buttons read "Skip" and
      // "Continue", the words alone cannot tell them apart from one, and the
      // question has already gone to the phone with its own real options.
      const names = this.#questionWaiting(id)
        ? []
        : (state.asking || []).map((c) => c.label || c.text).filter(Boolean);
      if (names.length) this.#askOnBehalfOfCursor(id, meta, names);
      else this.#withdrawAsk(id, 'answered in Cursor');

      this.#queueChanged(id, state.queue);

      const running = state.generating || this.meta.get(id)?.status === STATUS.busy;
      quiet = running ? 0 : quiet + 1;
      if (quiet >= 2) stop();
    };

    const stop = () => {
      const live = this.live.get(id);
      if (live?.askTimer) clearInterval(live.askTimer);
      if (live) live.askTimer = null;
      this.#withdrawAsk(id, 'the turn ended');
      // A turn ending empties the queue into the agent, so say so once more
      // rather than leaving a phone showing messages that already went in.
      this.#queueChanged(id, { waiting: 0, items: [], hidden: 0 });
    };

    const timer = setInterval(() => {
      look().catch((err) => this.emit('log', `[${meta.title}] watching for asks: ${err.message}`));
    }, 2000);
    timer.unref?.();
    this.live.set(id, { ...runtime, askTimer: timer });
    look().catch(() => {});
    return timer;
  }

  /**
   * Tell clients what Cursor is holding, when it changes.
   *
   * Sent on change rather than on every look: this runs every two seconds for as
   * long as a turn lasts, and a phone does not need to be told twice a second
   * that nothing has happened.
   */
  #queueChanged(id, queue) {
    if (!queue) return;
    const runtime = this.live.get(id) || {};
    const items = (queue.items || []).map((item) => ({ id: item.text, text: item.text }));
    const print = `${queue.waiting}:${items.map((i) => i.text).join('|')}`;
    if (runtime.queuePrint === print) return;
    runtime.queuePrint = print;
    this.live.set(id, runtime);
    this.emit('queue', {
      sessionId: id,
      owner: 'cursor',
      waiting: queue.waiting || 0,
      hidden: queue.hidden || 0,
      items,
    });
  }

  /** Put Cursor's question to the user, once, and press their answer. */
  #askOnBehalfOfCursor(id, meta, names) {
    const runtime = this.live.get(id) || {};
    const signature = names.join('|');
    if (runtime.ask?.signature === signature) return;
    // A different question than the one outstanding: withdraw and ask again.
    this.#withdrawAsk(id, 'Cursor changed what it is asking');

    const options = names.map((name) => ({
      optionId: name,
      name,
      kind: /^(reject|deny|skip|no|cancel|undo)\b/i.test(name) ? 'reject_once' : 'allow_once',
    }));

    // Never decide this one automatically. Cursor's own settings already had
    // their say by asking at all, and Auto is not entitled to overrule them.
    const answer = this.permissions.request({
      sessionId: id,
      params: {
        toolCall: { title: `Cursor is asking in "${meta.title}"`, kind: 'other' },
        options,
      },
      policy: POLICY.ask,
    });

    const requestId = this.permissions.list(id).at(-1)?.requestId || null;
    this.live.set(id, { ...runtime, ask: { signature, requestId } });

    answer
      .then(async (res) => {
        const chosen = res?.outcome?.optionId;
        const current = this.live.get(id);
        if (current?.ask?.requestId === requestId) current.ask = null;
        if (!chosen) return;

        const pressed = await this.cursor
          .press({ threadId: meta.desktopThreadId, name: chosen })
          .catch((err) => ({ status: 'error', reason: err.message }));
        this.#record(id, KIND.notice, {
          text:
            pressed.status === 'pressed'
              ? `Pressed "${chosen}" in Cursor.`
              : `Could not press "${chosen}" in Cursor: ${pressed.reason || pressed.status}.`,
        });
      })
      .catch(() => {});
  }

  /** Take back a question Cursor is no longer asking. */
  #withdrawAsk(id, why) {
    const runtime = this.live.get(id);
    if (!runtime?.ask?.requestId) return;
    const { requestId } = runtime.ask;
    runtime.ask = null;
    this.permissions.cancel(requestId, why);
  }

  /** Follow every desktop thread we hold, so the IDE's activity shows up. */
  async watchDesktopThreads() {
    let watched = 0;
    for (const meta of this.meta.values()) {
      if (meta.kind !== 'desktop' || meta.status === STATUS.archived) continue;
      // Anything already in the transcript is history; only new bubbles from
      // here on are news. Seeding the watcher with Cursor's current visited
      // set used to drop whatever landed while we were down — a restart in
      // the middle of a turn marked the final answer seen and never said it.
      const t = await this.transcripts.get(meta.id);
      const state = readThread(meta.desktopThreadId, { tail: 0 });
      const seed = desktopWatchSeed(t.readFrom(0), state || {});
      const existing = this.live.get(meta.id) || {};
      existing.toolsDrawn = seed.drawn;
      existing.openTools = seed.openTools;
      if (seed.turnStarted) existing.turnStarted = seed.turnStarted;
      this.live.set(meta.id, existing);
      // Cursor may have named the thread while we were down — or while we
      // were showing the placeholder we locked at attach.
      const patch = adoptDesktopTitle(meta, state?.title);
      if (patch) this.#update(meta.id, patch);
      if (this.#watchDesktop(meta.id, seed.seen, { resumeTurn: seed.openTurn })) watched += 1;
    }
    return watched;
  }

  /**
   * Remember a message we just sent, so the copy the desktop stores of it
   * does not show up as a second one. Unmatched entries expire: a duplicate
   * is a smaller sin than swallowing something you typed later.
   */
  #expectEcho(id, text) {
    const runtime = this.live.get(id) || {};
    const now = Date.now();
    runtime.echoes = [...(runtime.echoes || []), { text: echoKey(text), at: now }].filter(
      (e) => now - e.at < 120_000,
    );
    this.live.set(id, runtime);
  }

  #consumeEcho(id, text) {
    const runtime = this.live.get(id);
    if (!runtime?.echoes?.length) return false;
    const now = Date.now();
    runtime.echoes = runtime.echoes.filter((e) => now - e.at < 120_000);
    const key = echoKey(text);
    // Leave a hit in the list: Cursor can write the same send as two bubbles
    // (Plan restating the prompt), and a duplicate is worse than matching twice.
    // Expiry is what forgets it, so two genuine sends still need two expectEchoes.
    return runtime.echoes.some((e) => e.text === key);
  }

  /**
   * Hand one message to the desktop. The only place that talks to the IDE.
   *
   * Two ways in, tried in order of how easily they can be shut. Typing into
   * the window over Cursor's debug port answers to no feature switch, so it
   * goes first; the bridge, which a window can refuse for as long as it lives,
   * catches the case where Cursor was started without the port.
   */
  async #deliverDesktop(id, text, images = []) {
    const meta = this.meta.get(id);
    if (!meta?.desktopThreadId) return { status: 'error', message: 'Not a desktop chat' };

    const typed = await this.cursor
      // A chat in a background tab is still this chat: bring it forward rather
      // than making someone open it in Cursor before their message will go.
      .sendText({ threadId: meta.desktopThreadId, text, images, bringForward: true })
      .catch((err) => ({ status: 'error', reason: err.message }));
    if (typed.status === 'submitted' || typed.status === 'queued') {
      // A submitted message will come back as a desktop bubble; a queued one
      // must not, or it would show in the stream before Cursor has included it.
      if (typed.status === 'submitted') this.#expectEcho(id, text);
      this.emit('log', `typed a message into Cursor's window for "${meta.title}"`);
      return {
        status: typed.status,
        via: 'cdp',
        attached: typed.attached || 0,
        ofImages: images.length,
        attachFailed: typed.attachFailed || null,
      };
    }
    // Say why the better way in was not taken. A silent fallback cost an
    // afternoon of guessing at which of the two transports had refused.
    this.emit(
      'log',
      `Cursor's window would not take a message (${typed.status}` +
        `${typed.reason ? `: ${typed.reason}` : ''}); trying the bridge`,
    );

    const sent = await sendMessage({ threadId: meta.desktopThreadId, text }).catch((err) => ({
      status: 'error',
      message: err.message,
    }));
    if (sent.status === 'submitted') this.#expectEcho(id, text);
    if (sent.status === 'submitted' || sent.status === 'queued') return { ...sent, via: 'bridge' };
    return { ...sent, cdp: typed.reason || typed.status };
  }

  /**
   * Send to a desktop thread and let the watcher report what comes back.
   *
   * A refusal is not the end of the message. Cursor decides whether its bridge
   * is open in the window's own memory, so no amount of writing switches from
   * out here will change a running window's mind — but it does change when it
   * next starts, and windows open and close all day. So the text waits in the
   * outbox and goes in the moment the desktop will take it.
   */
  async #promptDesktop(id, meta, text, images = []) {
    const result = await this.#deliverDesktop(id, text, images);

    if (result.status === 'queued') {
      // Cursor is holding it. The stream waits until the turn actually takes
      // it; the queue on screen is where it can be seen until then.
      // Expect the eventual desktop bubble now: we do not write the message
      // into the transcript while it is only queued, but Cursor will store it
      // as a user bubble when it runs, and that must not appear as a second send.
      this.#expectEcho(id, text);
      this.#update(id, { status: STATUS.busy });
      this.#watchDesktop(id);
      const seen = await this.queued(id);
      this.emit('queue', { sessionId: id, ...seen });
      return { ...result, waiting: seen.waiting };
    }

    if (result.status === 'submitted') {
      // deliverDesktop already #expectEcho'd; the web may have drawn the bubble
      // optimistically, so this record is what pendingEcho swallows there.
      this.#record(id, KIND.userMessage, { text, images: images.length || undefined });
      // An image that did not make it has to be said out loud: a message asking
      // "what do you think of this?" with nothing attached reads as an agent
      // ignoring the question.
      if (images.length && result.attached !== images.length) {
        const missing = images.length - (result.attached || 0);
        this.#record(id, KIND.notice, {
          text:
            `${missing} of ${images.length} image${images.length === 1 ? '' : 's'} did not reach ` +
            `Cursor's chat box${result.attachFailed ? ` — ${result.attachFailed}` : ''}. The message went without ${missing === 1 ? 'it' : 'them'}.`,
        });
      }
      this.#update(id, { status: STATUS.busy });
      this.#watchDesktop(id);
      return result;
    }

    const place = this.outbox.hold(id, text);
    // Held for later: still our send, and the desktop will echo it when it goes in.
    this.#expectEcho(id, text);
    this.#record(id, KIND.userMessage, { text, images: images.length || undefined });
    this.#record(id, KIND.notice, { text: this.#whyHeld(meta, result, place) });
    if (images.length) {
      // The outbox keeps words, not pictures: an image has to be pasted into a
      // window that exists, and there is no window to paste into.
      this.#record(id, KIND.notice, {
        text: `The ${images.length === 1 ? 'image' : `${images.length} images`} could not wait with it — send ${images.length === 1 ? 'it' : 'them'} again once Cursor is taking messages.`,
      });
    }
    // Held messages go in the registry, so a host restart does not lose them.
    this.#update(id, { status: STATUS.idle, outbox: this.outbox.list(id) });
    return result;
  }

  /**
   * Take up messages that were still waiting when the host last stopped.
   * Auto restarts far more often than Cursor does, and a message that
   * survived the wait should not be lost to our own deploy.
   */
  resumeDesktopOutbox() {
    let waiting = 0;
    for (const meta of this.meta.values()) {
      if (meta.kind !== 'desktop' || meta.status === STATUS.archived) continue;
      if (!meta.outbox?.length) continue;
      waiting += this.outbox.restore(meta.id, meta.outbox);
    }
    if (waiting) this.outbox.flush().catch(() => {});
    return waiting;
  }

  /** Say what the desktop refused with, and what actually puts it right. */
  #whyHeld(meta, result, place) {
    const waiting =
      place > 1 ? `Held it behind ${place - 1} other${place === 2 ? '' : 's'}` : 'Held it here';
    const reason = result.reason || result.message || '';

    // The other way in is typing into the window, which needs Cursor to have
    // been started with its debugging port. Worth saying when it is missing:
    // it is the difference between a wait and no wait at all.
    const noPort = /listening on port/i.test(String(result.cdp || ''))
      ? ` Typing straight into the window is not available either — Cursor was started without ` +
        `its debugging port, so both ways in are shut.`
      : '';

    if (/bridge is disabled/i.test(reason)) {
      return (
        `Cursor has its desktop bridge switched off in the running window, so it would not ` +
        `take this. ${waiting} — it goes in as soon as the bridge answers. Restarting Cursor ` +
        `is what turns it back on; Auto has already set the switches it reads at startup.${noPort}`
      );
    }
    if (result.status === 'unknown-thread') {
      return `No Cursor window has this chat open. ${waiting} — open ${meta.folder} in Cursor and it goes in by itself.`;
    }
    return `Cursor would not take this${reason ? `: ${reason}` : ''}. ${waiting} and will keep trying.`;
  }

  async setModel(id, modelId) {
    if (this.meta.get(id)?.kind === 'desktop') return this.#chooseInCursor(id, 'model', modelId);
    const runtime = await this.ensureLive(id);
    await runtime.client.setModel({ sessionId: runtime.acpSessionId, modelId });
    this.#update(id, { model: modelId, modelName: this.modelName(modelId) });
    return true;
  }

  /**
   * Display name for a model id, falling back to the id itself. The agent
   * calls its automatic pick "Auto", which reads as this app's name — say what
   * it actually does instead.
   */
  modelName(modelId) {
    if (!modelId) return null;
    if (modelId === 'default[]') return 'Auto-select';
    return this.catalog?.models?.find((m) => m.modelId === modelId)?.name || modelId;
  }

  setPolicy(id, policy) {
    if (!Object.values(POLICY).includes(policy)) throw new Error(`Unknown policy ${policy}`);
    this.#update(id, { policy, policyLocked: true });
    return true;
  }

  rename(id, title) {
    this.#update(id, { title, titleLocked: true });
    return true;
  }

  async archive(id) {
    await this.stop(id);
    this.#update(id, { status: STATUS.archived });
    if (this.activeId === id) {
      const next = this.list()[0];
      this.activeId = next ? next.id : null;
      this.#persist();
    }
    return true;
  }

  async stop(id) {
    const runtime = this.live.get(id);
    this.permissions.cancelForSession(id, 'session stopped');
    this.terminals.releaseForSession(id);
    runtime?.watcher?.stop();
    if (runtime?.client) await runtime.client.stop();
    this.live.delete(id);
  }

  async stopAll() {
    await Promise.all([...this.live.keys()].map((id) => this.stop(id)));
    this.terminals.releaseAll();
  }
}

/** Enough of a message to recognise it in a one-line notice. */
function short(text, most = 60) {
  const said = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  return said.length > most ? `${said.slice(0, most - 1)}…` : said;
}

/**
 * The part of a mirrored message that has not been published yet.
 *
 * Clients append what the transcript gives them, so a bubble read again as it
 * grows must contribute only its new tail. A stale shorter snapshot (the DB
 * caught mid-write) must be ignored — treating it as a rewrite used to reset
 * what we had said, and the next full read then appended the whole answer
 * again: "BuildBuildBuildBuild passes passes…".
 *
 * When Cursor really rewrites earlier tokens (speculative decoding), the new
 * version goes out with `replace: true` so clients swap the bubble instead of
 * stacking another copy underneath.
 *
 * @param {string} said  what has already gone into the transcript
 * @param {string} whole  what the bubble holds now
 * @returns {{ text: string, replace?: boolean }}
 */
export function proseDelta(said, whole) {
  if (!said) return { text: whole };
  if (whole === said) return { text: '' };
  // Same growing bubble, caught shorter than last time — not news.
  if (said.startsWith(whole)) return { text: '' };
  if (whole.startsWith(said)) return { text: whole.slice(said.length) };
  return { text: whole, replace: true };
}

/** @deprecated prefer proseDelta — kept for call sites that only need the tail string */
export function newWords(said, whole) {
  return proseDelta(said, whole).text;
}

const TERMINAL_TOOL = new Set(['completed', 'failed', 'cancelled']);

/**
 * What a desktop watcher should treat as already published after a host
 * restart, and which tool cards it has already drawn.
 *
 * Cursor's current `visited` set is the wrong seed: anything that landed
 * while we were down is visited in the IDE and missing from our transcript.
 * A turn that never got `turn_end` is the signal that we died mid-reply, so
 * only skip bubbles we actually wrote down.
 *
 * @param {object[]} records  transcript records, oldest first
 * @param {{ messages?: object[], visited?: string[] }} cursor
 */
export function desktopWatchSeed(records = [], cursor = {}) {
  const drawn = new Set();
  const completed = new Set();
  const openTools = new Set();
  const prose = [];
  const thoughts = [];
  const users = new Set();
  let openTurn = false;
  let turnStarted = 0;
  for (const rec of records) {
    if (rec.kind === KIND.turnStart) {
      openTurn = true;
      turnStarted = rec.ts || 0;
    } else if (rec.kind === KIND.turnEnd) {
      openTurn = false;
      turnStarted = 0;
    }
    if (rec.toolCallId) {
      if (rec.kind === KIND.toolCall) drawn.add(rec.toolCallId);
      if (TERMINAL_TOOL.has(rec.status)) {
        completed.add(rec.toolCallId);
        openTools.delete(rec.toolCallId);
      } else if (rec.status === 'in_progress' || rec.status === 'pending') {
        openTools.add(rec.toolCallId);
      }
    }
    if (rec.kind === KIND.agentDelta && rec.text) prose.push(rec.text);
    if (rec.kind === KIND.agentThought && rec.text) thoughts.push(rec.text);
    if (rec.kind === KIND.userMessage && rec.text) users.add(echoKey(rec.text));
  }

  const visited = cursor.visited || [];
  const messages = cursor.messages || [];
  if (!openTurn) {
    return { seen: visited, drawn, openTools: new Set(), openTurn: false, turnStarted: 0 };
  }

  const publishedProse = prose.join('');
  const publishedThoughts = thoughts.join('');
  const unpublished = new Set();
  for (const msg of messages) {
    if (msg.kind === 'tool') {
      if (!completed.has(msg.id)) unpublished.add(msg.id);
    } else if (msg.kind === 'text' && msg.text && !publishedProse.includes(msg.text)) {
      unpublished.add(msg.id);
    } else if (msg.kind === 'thinking' && msg.text && !publishedThoughts.includes(msg.text)) {
      unpublished.add(msg.id);
    } else if (msg.role === 'user' && msg.text && !users.has(echoKey(msg.text))) {
      unpublished.add(msg.id);
    }
  }

  return {
    seen: visited.filter((id) => !unpublished.has(id)),
    drawn,
    openTools,
    openTurn: true,
    turnStarted,
  };
}

export { POLICY };
