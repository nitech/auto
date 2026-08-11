/**
 * Terminal registry.
 *
 * Serves two purposes through one abstraction:
 *
 *   1. the ACP `terminal/*` client methods, so an agent can run commands in
 *      terminals we own and the user watches them live;
 *   2. user-initiated shells you can type into.
 *
 * Cursor's agent currently runs its own shells and reports through
 * `tool_call_update` rather than calling `terminal/create` (see
 * spike/FINDINGS.md), so path 1 is presently unused — but it is cheap,
 * spec-compliant, and the moment the CLI starts using it we get live streaming
 * of agent commands for free.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

let ptyModule = null;
let ptyLoadError = null;
try {
  ptyModule = (await import('node-pty')).default ?? (await import('node-pty'));
} catch (err) {
  ptyLoadError = err;
}

/** Default shell for interactive terminals. */
function defaultShell() {
  if (process.platform === 'win32') {
    // PowerShell over COMSPEC's cmd.exe: it is what the repo's own docs and
    // scripts assume, so a terminal here behaves like one on the desktop.
    return { file: process.env.AUTO_SHELL || 'powershell.exe', args: ['-NoLogo'] };
  }
  return { file: process.env.AUTO_SHELL || process.env.SHELL || '/bin/bash', args: ['-l'] };
}

/** Output is flushed on a short timer so a noisy build is not one record per byte. */
const FLUSH_MS = 120;
const FLUSH_BYTES = 8192;
const DEFAULT_BYTE_LIMIT = 1024 * 1024;

class Terminal extends EventEmitter {
  constructor({ id, sessionId, proc, byteLimit, kind, title }) {
    super();
    this.id = id;
    this.sessionId = sessionId;
    this.proc = proc;
    this.kind = kind; // 'agent' | 'user'
    this.title = title;
    this.byteLimit = byteLimit || DEFAULT_BYTE_LIMIT;
    this.output = '';
    this.truncated = false;
    this.exitStatus = null;
    this.released = false;
    this.pending = '';
    this.timer = null;
    this.waiters = [];

    proc.onData((data) => this.#ingest(data));
    proc.onExit(({ exitCode, signal }) => {
      this.#flush();
      this.exitStatus = { exitCode: exitCode ?? null, signal: signal ?? null };
      this.emit('exit', this.exitStatus);
      for (const w of this.waiters.splice(0)) w(this.exitStatus);
    });
  }

  #ingest(data) {
    this.output += data;
    if (this.output.length > this.byteLimit) {
      this.output = this.output.slice(this.output.length - this.byteLimit);
      this.truncated = true;
    }
    this.pending += data;
    if (this.pending.length >= FLUSH_BYTES) {
      this.#flush();
      return;
    }
    if (!this.timer) this.timer = setTimeout(() => this.#flush(), FLUSH_MS);
  }

  #flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.pending) return;
    const chunk = this.pending;
    this.pending = '';
    this.emit('chunk', chunk);
  }

  write(data) {
    if (this.exitStatus) return false;
    this.proc.write(data);
    return true;
  }

  resize(cols, rows) {
    if (this.exitStatus) return false;
    try {
      this.proc.resize(Math.max(1, cols | 0), Math.max(1, rows | 0));
      return true;
    } catch {
      return false;
    }
  }

  waitForExit() {
    if (this.exitStatus) return Promise.resolve(this.exitStatus);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  kill() {
    if (this.exitStatus) return;
    try {
      this.proc.kill();
    } catch {
      /* already gone */
    }
  }
}

export class TerminalRegistry extends EventEmitter {
  constructor() {
    super();
    this.terminals = new Map();
  }

  get available() {
    return Boolean(ptyModule);
  }

  get unavailableReason() {
    return ptyLoadError ? ptyLoadError.message : null;
  }

  #spawn({ file, args, cwd, env, cols = 120, rows = 30 }) {
    if (!ptyModule) {
      throw new Error(`Terminals unavailable: node-pty failed to load (${ptyLoadError?.message})`);
    }
    return ptyModule.spawn(file, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: { ...process.env, ...env },
    });
  }

  #register(term) {
    this.terminals.set(term.id, term);
    term.on('chunk', (chunk) =>
      this.emit('chunk', { terminalId: term.id, sessionId: term.sessionId, chunk }),
    );
    term.on('exit', (status) =>
      this.emit('exit', { terminalId: term.id, sessionId: term.sessionId, status }),
    );
    this.emit('opened', this.describe(term.id));
    return term;
  }

  /** ACP `terminal/create`: run one command in a terminal we own. */
  create({ sessionId, command, args = [], env = [], cwd, outputByteLimit }) {
    const envObj = {};
    for (const e of env || []) if (e?.name) envObj[e.name] = e.value;

    // ACP hands us a command plus args; on Windows route through the shell so
    // built-ins and shell syntax behave as the agent expects.
    const spawnSpec =
      process.platform === 'win32'
        ? { file: process.env.COMSPEC || 'cmd.exe', args: ['/c', [command, ...args].join(' ')] }
        : { file: command, args };

    const proc = this.#spawn({ ...spawnSpec, cwd, env: envObj });
    const term = new Terminal({
      id: `t-${randomUUID()}`,
      sessionId,
      proc,
      kind: 'agent',
      title: [command, ...args].join(' '),
      byteLimit: outputByteLimit,
    });
    this.#register(term);
    return { terminalId: term.id };
  }

  /** An interactive shell the user drives. */
  createUser({ sessionId, cwd, cols, rows }) {
    const shell = defaultShell();
    const proc = this.#spawn({ file: shell.file, args: shell.args, cwd, cols, rows });
    const term = new Terminal({
      id: `t-${randomUUID()}`,
      sessionId,
      proc,
      kind: 'user',
      title: shell.file.split(/[\\/]/).pop(),
    });
    this.#register(term);
    return this.describe(term.id);
  }

  get(id) {
    return this.terminals.get(id) || null;
  }

  describe(id) {
    const t = this.terminals.get(id);
    if (!t) return null;
    return {
      terminalId: t.id,
      sessionId: t.sessionId,
      kind: t.kind,
      title: t.title,
      exitStatus: t.exitStatus,
      released: t.released,
    };
  }

  list(sessionId) {
    return [...this.terminals.keys()]
      .map((id) => this.describe(id))
      .filter((t) => t && (!sessionId || t.sessionId === sessionId));
  }

  /** Full retained output — used both by ACP `terminal/output` and by replay. */
  outputOf(id) {
    const t = this.terminals.get(id);
    if (!t) throw new Error(`Unknown terminal ${id}`);
    return {
      output: t.output,
      truncated: t.truncated,
      ...(t.exitStatus ? { exitStatus: t.exitStatus } : {}),
    };
  }

  async waitForExit(id) {
    const t = this.terminals.get(id);
    if (!t) throw new Error(`Unknown terminal ${id}`);
    return t.waitForExit();
  }

  kill(id) {
    this.terminals.get(id)?.kill();
    return {};
  }

  release(id) {
    const t = this.terminals.get(id);
    if (!t) return {};
    t.kill();
    t.released = true;
    this.terminals.delete(id);
    this.emit('closed', { terminalId: id, sessionId: t.sessionId });
    return {};
  }

  write(id, data) {
    return Boolean(this.terminals.get(id)?.write(data));
  }

  resize(id, cols, rows) {
    return Boolean(this.terminals.get(id)?.resize(cols, rows));
  }

  releaseForSession(sessionId) {
    for (const t of [...this.terminals.values()]) {
      if (t.sessionId === sessionId) this.release(t.id);
    }
  }

  releaseAll() {
    for (const id of [...this.terminals.keys()]) this.release(id);
  }
}
