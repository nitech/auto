/**
 * Session manager — the heart of the host.
 *
 * One Auto session is one Cursor agent. Each holds its own `cursor-agent acp`
 * process, its own transcript, and its own permission policy. Agent processes
 * are spawned lazily and resumed via `session/load`, so an idle session costs
 * nothing but its history stays intact across restarts.
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
import { ThreadWatcher, readThread } from './desktop-threads.mjs';

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
 */
const UPSTREAM_ERROR_RE =
  /\b(RetriableError|ConnectError|\[unavailable\]|PING timed out|rate.?limit(ed)?|upstream (error|timeout))\b/i;

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

  setActive(id) {
    if (!this.meta.has(id)) return false;
    this.activeId = id;
    this.#persist();
    return true;
  }

  #update(id, patch) {
    const meta = this.meta.get(id);
    if (!meta) return null;
    Object.assign(meta, patch, { updatedAt: new Date().toISOString() });
    this.#persist();
    return meta;
  }

  // ------------------------------------------------------------- transcripts

  transcript(id) {
    return this.transcripts.get(id);
  }

  async history(id, fromSeq = 0) {
    const t = await this.transcripts.get(id);
    return t.readFrom(fromSeq);
  }

  #record(sessionId, kind, payload) {
    const t = this.transcripts.open.get(sessionId);
    if (!t) return null;
    const rec = t.append(kind, payload);
    this.emit('record', { sessionId, record: rec });
    return rec;
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
        rt.streamBuffer = (rt.streamBuffer + (mapped.payload.text || '')).slice(-600);
        if (!rt.upstreamErrorFlagged && UPSTREAM_ERROR_RE.test(rt.streamBuffer)) {
          rt.upstreamErrorFlagged = true;
          this.#record(id, KIND.error, {
            text: rt.streamBuffer.trim(),
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
   */
  async prompt(id, { text, images = [] } = {}) {
    const meta = this.meta.get(id);
    if (!meta) throw new Error(`Unknown session ${id}`);
    // A desktop chat mid-turn is not a reason to refuse: Cursor queues a
    // message typed while it works, exactly as it does for the chat box, and
    // if it will not, the outbox holds it. Only our own agent, which has no
    // such queue, has to be told to wait.
    if (meta.status === STATUS.busy && meta.kind !== 'desktop') {
      throw new Error('Session is already working');
    }

    if (meta.kind === 'desktop') {
      if (!text?.trim()) return null;
      if (images.length) {
        this.#record(id, KIND.notice, {
          text: 'The desktop bridge carries text only, so the image was left out.',
        });
      }
      return this.#promptDesktop(id, meta, text);
    }

    const runtime = await this.ensureLive(id);
    const content = [];
    if (text?.trim()) content.push({ type: 'text', text });
    for (const img of images) {
      content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
    }
    if (content.length === 0) return null;

    this.#record(id, KIND.userMessage, { text, images: images.length });
    this.#record(id, KIND.turnStart, {});
    this.#update(id, { status: STATUS.busy });
    runtime.streamBuffer = '';
    runtime.upstreamErrorFlagged = false;

    try {
      const res = await runtime.client.prompt({
        sessionId: runtime.acpSessionId,
        prompt: content,
      });
      this.#record(id, KIND.turnEnd, {
        stopReason: res?.stopReason,
        upstreamError: Boolean(runtime.upstreamErrorFlagged),
      });
      this.#update(id, { status: STATUS.idle });
      return res;
    } catch (err) {
      this.#record(id, KIND.error, { text: err?.message || String(err) });
      this.#update(id, { status: STATUS.idle });
      throw err;
    }
  }

  async cancel(id) {
    const meta = this.meta.get(id);
    if (meta?.kind === 'desktop') return this.#stopDesktop(id, meta);

    const runtime = this.live.get(id);
    if (!runtime?.client?.running) return false;
    runtime.client.cancel(runtime.acpSessionId);
    this.#record(id, KIND.error, { text: 'Interrupted by user.', interrupted: true });
    return true;
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

  /** What the desktop owns, we cannot change from here. */
  #refuseForDesktop(id, what) {
    if (this.meta.get(id)?.kind !== 'desktop') return false;
    this.#record(id, KIND.notice, {
      text: `This chat runs in Cursor, so its ${what} is set there.`,
    });
    return true;
  }

  async setMode(id, modeId) {
    if (this.#refuseForDesktop(id, 'mode')) return false;
    const runtime = await this.ensureLive(id);
    await runtime.client.setMode({ sessionId: runtime.acpSessionId, modeId });
    this.#update(id, { mode: modeId });
    return true;
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
   */
  async attachDesktopThread({ threadId, folder, title }) {
    // Opening the same thread twice should land you back where you were.
    const already = [...this.meta.values()].find(
      (s) => s.desktopThreadId === threadId && s.status !== STATUS.archived,
    );
    if (already) {
      this.setActive(already.id);
      this.#watchDesktop(already.id);
      return already;
    }

    const state = readThread(threadId, { tail: 40 });
    if (!state) throw new Error('That chat is not in the Cursor desktop database');

    const id = randomUUID();
    const meta = {
      id,
      kind: 'desktop',
      desktopThreadId: threadId,
      title: title || state.title || 'Desktop chat',
      titleLocked: Boolean(title || state.title),
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
      this.#record(id, KIND.userMessage, { text: message.text });
      return;
    }
    if (message.kind === 'thinking') {
      this.#record(id, KIND.agentThought, { text: message.text });
      return;
    }
    if (message.kind === 'tool') {
      // The desktop writes a call twice: once when it starts, with what it was
      // asked to do, and again with what came of it. The second sighting has
      // to update the card the first one drew, or a command and its output
      // end up as two unrelated things on the screen.
      const runtime = this.live.get(id) || {};
      runtime.toolsDrawn = runtime.toolsDrawn || new Set();
      this.live.set(id, runtime);

      if (runtime.toolsDrawn.has(message.id)) {
        this.#record(id, KIND.toolUpdate, {
          toolCallId: message.id,
          status: message.status || 'completed',
          rawOutput: message.output || undefined,
        });
        return;
      }

      runtime.toolsDrawn.add(message.id);
      this.#record(id, KIND.toolCall, {
        toolCallId: message.id,
        title: message.name,
        toolKind: message.input?.command ? 'execute' : 'other',
        status: message.status || 'completed',
        rawInput: message.input || undefined,
        rawOutput: message.output || undefined,
      });
      return;
    }
    this.#record(id, KIND.agentDelta, { text: message.text });
  }

  /** Start following a desktop thread, if we are not already. */
  #watchDesktop(id, alreadySeen = []) {
    const meta = this.meta.get(id);
    if (!meta?.desktopThreadId || meta.status === STATUS.archived) return null;

    const existing = this.live.get(id);
    if (existing?.watcher) return existing.watcher;

    const watcher = new ThreadWatcher(meta.desktopThreadId).markSeen(alreadySeen);
    this.live.set(id, { ...(existing || {}), watcher });

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
      if (running) this.#record(id, KIND.turnStart, {});
      else this.#record(id, KIND.turnEnd, { stopReason: 'end_turn' });
      this.#update(id, { status: running ? STATUS.busy : STATUS.idle });
      if (running) this.#watchDesktopAsks(id);
    });
    watcher.on('title', (title) => {
      const current = this.meta.get(id);
      // The desktop names a thread after the first exchange; take that unless
      // the name came from us.
      if (current && !current.titleLocked) this.#update(id, { title, titleLocked: true });
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

      const names = (state.asking || []).map((c) => c.label || c.text).filter(Boolean);
      if (names.length) this.#askOnBehalfOfCursor(id, meta, names);
      else this.#withdrawAsk(id, 'answered in Cursor');

      const running = state.generating || this.meta.get(id)?.status === STATUS.busy;
      quiet = running ? 0 : quiet + 1;
      if (quiet >= 2) stop();
    };

    const stop = () => {
      const live = this.live.get(id);
      if (live?.askTimer) clearInterval(live.askTimer);
      if (live) live.askTimer = null;
      this.#withdrawAsk(id, 'the turn ended');
    };

    const timer = setInterval(() => {
      look().catch((err) => this.emit('log', `[${meta.title}] watching for asks: ${err.message}`));
    }, 2000);
    timer.unref?.();
    this.live.set(id, { ...runtime, askTimer: timer });
    look().catch(() => {});
    return timer;
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
  watchDesktopThreads() {
    let watched = 0;
    for (const meta of this.meta.values()) {
      if (meta.kind !== 'desktop' || meta.status === STATUS.archived) continue;
      // Anything already in the transcript is history; only new bubbles from
      // here on are news. The watcher learns what it has seen on its first
      // pass, so seed it with everything currently in the thread.
      const state = readThread(meta.desktopThreadId, { tail: 0 });
      if (this.#watchDesktop(meta.id, state?.visited || [])) watched += 1;
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
    runtime.echoes = [...(runtime.echoes || []), { text: String(text).trim(), at: now }].filter(
      (e) => now - e.at < 120_000,
    );
    this.live.set(id, runtime);
  }

  #consumeEcho(id, text) {
    const runtime = this.live.get(id);
    if (!runtime?.echoes?.length) return false;
    const at = runtime.echoes.findIndex((e) => e.text === String(text).trim());
    if (at < 0) return false;
    runtime.echoes.splice(at, 1);
    return true;
  }

  /**
   * Hand one message to the desktop. The only place that talks to the IDE.
   *
   * Two ways in, tried in order of how easily they can be shut. Typing into
   * the window over Cursor's debug port answers to no feature switch, so it
   * goes first; the bridge, which a window can refuse for as long as it lives,
   * catches the case where Cursor was started without the port.
   */
  async #deliverDesktop(id, text) {
    const meta = this.meta.get(id);
    if (!meta?.desktopThreadId) return { status: 'error', message: 'Not a desktop chat' };
    // Claim the echo before sending: the watcher may see the bubble the
    // moment the desktop writes it.
    this.#expectEcho(id, text);

    const typed = await this.cursor
      // A chat in a background tab is still this chat: bring it forward rather
      // than making someone open it in Cursor before their message will go.
      .sendText({ threadId: meta.desktopThreadId, text, bringForward: true })
      .catch((err) => ({ status: 'error', reason: err.message }));
    if (typed.status === 'submitted') {
      this.emit('log', `typed a message into Cursor's window for "${meta.title}"`);
      return { status: 'submitted', via: 'cdp' };
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
  async #promptDesktop(id, meta, text) {
    this.#record(id, KIND.userMessage, { text });

    const result = await this.#deliverDesktop(id, text);

    if (result.status === 'submitted' || result.status === 'queued') {
      if (result.status === 'queued') {
        this.#record(id, KIND.notice, {
          text: 'The desktop agent is mid-turn; this will go in when it finishes.',
        });
      }
      this.#update(id, { status: STATUS.busy });
      this.#watchDesktop(id);
      return result;
    }

    const place = this.outbox.hold(id, text);
    this.#record(id, KIND.notice, { text: this.#whyHeld(meta, result, place) });
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
    if (this.#refuseForDesktop(id, 'model')) return false;
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

export { POLICY };
