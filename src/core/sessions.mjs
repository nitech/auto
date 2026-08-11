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
import { importDesktopChat } from './desktop-chats.mjs';

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
          // Nothing is live yet after a restart. Sessions the user never gave
          // an explicit policy follow the configured default, so changing it
          // in .env applies everywhere rather than only to new sessions.
          this.meta.set(s.id, {
            ...s,
            status: STATUS.idle,
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
        // Usually we already have all of it on disk, so recording it again
        // would duplicate the history on every restart. A session that came
        // from somewhere else is the exception: its replay is the only copy
        // we will ever get, so let that one through.
        runtime.replaying = !meta.needsHistory;
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
      needsHistory: false,
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
    if (meta.status === STATUS.busy) throw new Error('Session is already working');

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

  cancel(id) {
    const runtime = this.live.get(id);
    if (!runtime?.client?.running) return false;
    runtime.client.cancel(runtime.acpSessionId);
    this.#record(id, KIND.error, { text: 'Interrupted by user.', interrupted: true });
    return true;
  }

  async setMode(id, modeId) {
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

  /**
   * Continue a chat started in the Cursor desktop app. The chat is copied into
   * a session of its own, so the two go their separate ways from here.
   *
   * @param {object} opts
   * @param {string} opts.chatId  desktop chat id
   * @param {string} opts.folder  folder to run in
   */
  importDesktopChat({ chatId, folder }) {
    const dir = folder || this.defaultFolder;
    const { sessionId, title, blobs, missing } = importDesktopChat({ chatId, cwd: dir });

    const id = randomUUID();
    const meta = {
      id,
      title: title || 'Desktop chat',
      titleLocked: true,
      folder: dir,
      mode: 'agent',
      policy: this.defaultPolicy,
      model: null,
      modelName: null,
      acpSessionId: sessionId,
      status: STATUS.idle,
      importedFrom: chatId,
      // Its history lives in the agent, not in our transcript — record the
      // replay the first time we load it so it can be read here too.
      needsHistory: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.meta.set(id, meta);
    this.#persist();
    this.emit('log', `imported desktop chat "${meta.title}" (${blobs} blobs, ${missing} missing)`);
    this.emit('sessions', this.list());
    return meta;
  }

  async setModel(id, modelId) {
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
    if (runtime?.client) await runtime.client.stop();
    this.live.delete(id);
  }

  async stopAll() {
    await Promise.all([...this.live.keys()].map((id) => this.stop(id)));
    this.terminals.releaseAll();
  }
}

export { POLICY };
