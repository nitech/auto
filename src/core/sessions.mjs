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
  constructor({ stateDir, defaultFolder }) {
    super();
    this.stateDir = stateDir;
    this.statePath = join(stateDir, 'sessions.json');
    this.defaultFolder = defaultFolder;
    this.transcripts = new TranscriptStore(join(stateDir, 'transcripts'));
    this.permissions = new PermissionBroker();
    /** @type {Map<string, object>} persisted session metadata */
    this.meta = new Map();
    /** @type {Map<string, object>} live runtime state, keyed by session id */
    this.live = new Map();
    this.activeId = null;
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
  }

  // ---------------------------------------------------------------- registry

  init() {
    if (existsSync(this.statePath)) {
      try {
        const raw = JSON.parse(readFileSync(this.statePath, 'utf8'));
        for (const s of raw.sessions || []) {
          // Nothing is live yet after a restart.
          this.meta.set(s.id, { ...s, status: STATUS.idle });
        }
        this.activeId = raw.activeId || null;
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

  create({ folder, title, policy = POLICY.ask, mode = 'agent' } = {}) {
    const dir = folder || this.defaultFolder;
    const id = randomUUID();
    const meta = {
      id,
      title: title || basename(dir.replace(/[\\/]+$/, '')) || 'session',
      folder: dir,
      mode,
      policy,
      model: null,
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
      },
    });

    const runtime = { client, turn: null, streamBuffer: '' };
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

    runtime.acpSessionId = session.sessionId;
    runtime.capabilities = info;
    runtime.modes = session.modes || null;
    runtime.models = session.models || null;

    this.#update(id, {
      acpSessionId: session.sessionId,
      status: STATUS.idle,
      model: session.models?.currentModelId || null,
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

  setPolicy(id, policy) {
    if (!Object.values(POLICY).includes(policy)) throw new Error(`Unknown policy ${policy}`);
    this.#update(id, { policy });
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
    if (runtime?.client) await runtime.client.stop();
    this.live.delete(id);
  }

  async stopAll() {
    await Promise.all([...this.live.keys()].map((id) => this.stop(id)));
  }
}

export { POLICY };
