/**
 * ACP client for the Cursor Agent CLI.
 *
 * Owns one `cursor-agent acp` subprocess and exposes the agent-side methods,
 * while serving the client-side methods (permissions, filesystem, terminals)
 * out to injected handlers. Everything above this layer deals in session ids
 * and update events, never in JSON-RPC.
 */
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { JsonRpcPeer, RpcError, RPC_ERRORS } from './jsonrpc.mjs';
import { resolveCursorAgent } from './resolve.mjs';

export const PROTOCOL_VERSION = 1;

/** Capabilities we advertise. The agent decides which of these it uses. */
export const CLIENT_CAPABILITIES = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: true,
};

export class AcpClient extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {object} [opts.handlers] client-side method implementations
   * @param {string} [opts.cwd] working directory for the agent process
   * @param {object} [opts.env] extra environment variables
   */
  constructor({ handlers = {}, cwd = process.cwd(), env = {} } = {}) {
    super();
    this.handlers = handlers;
    this.cwd = cwd;
    this.env = env;
    this.child = null;
    this.peer = null;
    this.initialized = null;
    this.stderrTail = '';
  }

  get running() {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }

  /** Spawn the agent and complete the ACP handshake. Returns the initialize result. */
  async start() {
    if (this.initialized) return this.initialized;

    const bin = resolveCursorAgent();
    this.emit('log', `spawning cursor-agent acp via ${bin.via}`);

    this.child = spawn(bin.command, [...bin.args, 'acp'], {
      cwd: this.cwd,
      shell: bin.shell,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.env },
    });

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (s) => {
      this.stderrTail = (this.stderrTail + s).slice(-4000);
      this.emit('stderr', s);
    });

    this.child.on('exit', (code, signal) => {
      this.initialized = null;
      this.emit('exit', { code, signal, stderr: this.stderrTail });
    });
    this.child.on('error', (err) => this.emit('error', err));

    this.peer = new JsonRpcPeer({
      input: this.child.stdout,
      output: this.child.stdin,
      onRequest: (method, params) => this.#serveClientMethod(method, params),
    });
    this.peer.on('raw', (line) => this.emit('log', `non-json from agent: ${line.slice(0, 300)}`));
    this.peer.on('notification', ({ method, params }) => {
      if (method === 'session/update') {
        this.emit('update', { sessionId: params?.sessionId, update: params?.update, raw: params });
        return;
      }
      this.emit('notification', { method, params });
    });

    this.initialized = await this.peer.request(
      'initialize',
      { protocolVersion: PROTOCOL_VERSION, clientCapabilities: CLIENT_CAPABILITIES },
      { timeoutMs: 30_000 },
    );
    return this.initialized;
  }

  /** Route an inbound request to the matching handler. */
  async #serveClientMethod(method, params) {
    const h = this.handlers;
    switch (method) {
      case 'session/request_permission':
        if (!h.requestPermission) break;
        return h.requestPermission(params);
      case 'fs/read_text_file':
        if (!h.readTextFile) break;
        return h.readTextFile(params);
      case 'fs/write_text_file':
        if (!h.writeTextFile) break;
        return h.writeTextFile(params);
      case 'terminal/create':
        if (!h.terminalCreate) break;
        return h.terminalCreate(params);
      case 'terminal/output':
        if (!h.terminalOutput) break;
        return h.terminalOutput(params);
      case 'terminal/wait_for_exit':
        if (!h.terminalWaitForExit) break;
        return h.terminalWaitForExit(params);
      case 'terminal/kill':
        if (!h.terminalKill) break;
        return h.terminalKill(params);
      case 'terminal/release':
        if (!h.terminalRelease) break;
        return h.terminalRelease(params);
      default:
        this.emit('log', `unhandled agent request: ${method}`);
        throw new RpcError(RPC_ERRORS.methodNotFound, `Unsupported method ${method}`);
    }
    throw new RpcError(RPC_ERRORS.methodNotFound, `No handler registered for ${method}`);
  }

  #requirePeer() {
    if (!this.peer || !this.running) throw new Error('ACP client is not running');
    return this.peer;
  }

  /** Create a session. Resolves to `{ sessionId, modes, models, configOptions }`. */
  newSession({ cwd, mcpServers = [] } = {}) {
    return this.#requirePeer().request(
      'session/new',
      { cwd: cwd || this.cwd, mcpServers },
      { timeoutMs: 60_000 },
    );
  }

  /** Resume a previously created session (requires the loadSession capability). */
  loadSession({ sessionId, cwd, mcpServers = [] }) {
    return this.#requirePeer().request(
      'session/load',
      { sessionId, cwd: cwd || this.cwd, mcpServers },
      { timeoutMs: 60_000 },
    );
  }

  /**
   * Send a prompt turn. Resolves with `{ stopReason }` when the turn ends —
   * all intermediate output arrives as `update` events meanwhile.
   * @param {object} p
   * @param {string} p.sessionId
   * @param {Array<object>} p.prompt content blocks, e.g. `[{type:'text',text:'hi'}]`
   */
  prompt({ sessionId, prompt }) {
    return this.#requirePeer().request('session/prompt', { sessionId, prompt });
  }

  /** Interrupt the current turn. Notification — the prompt settles on its own. */
  cancel(sessionId) {
    this.#requirePeer().notify('session/cancel', { sessionId });
  }

  setMode({ sessionId, modeId }) {
    return this.#requirePeer().request('session/set_mode', { sessionId, modeId });
  }

  /** Escape hatch for protocol methods this wrapper does not model yet. */
  call(method, params, opts) {
    return this.#requirePeer().request(method, params, opts);
  }

  async stop() {
    try {
      this.peer?.close();
    } catch {
      /* already gone */
    }
    if (this.child && this.child.exitCode === null) {
      this.child.kill();
    }
    this.initialized = null;
  }
}
