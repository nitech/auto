/**
 * Newline-delimited JSON-RPC 2.0 peer.
 *
 * Transport-agnostic and deliberately free of ACP semantics — this file should
 * not need to change when the ACP spec moves.
 */
import { EventEmitter } from 'node:events';

export const RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
};

export class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
  static from(payload) {
    return new RpcError(
      payload?.code ?? RPC_ERRORS.internal,
      payload?.message || 'Unknown RPC error',
      payload?.data,
    );
  }
}

/**
 * Speaks JSON-RPC over a readable/writable pair.
 *
 * Events: `notification` ({method, params}), `error` (Error), `raw` (string,
 * for lines that were not valid JSON — the CLI occasionally logs to stdout).
 */
export class JsonRpcPeer extends EventEmitter {
  /**
   * @param {object} opts
   * @param {NodeJS.ReadableStream} opts.input   stream we read messages from
   * @param {NodeJS.WritableStream} opts.output  stream we write messages to
   * @param {(method: string, params: any) => Promise<any>} [opts.onRequest]
   *   Handles inbound requests. Throw an RpcError to return a JSON-RPC error.
   */
  constructor({ input, output, onRequest }) {
    super();
    this.output = output;
    this.onRequest = onRequest;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.buffer = '';

    input.setEncoding('utf8');
    input.on('data', (chunk) => this.#ingest(chunk));
    input.on('close', () => this.#failAll(new Error('RPC transport closed')));
    input.on('error', (err) => this.#failAll(err));
  }

  #ingest(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.emit('raw', line);
        continue;
      }
      this.#dispatch(msg);
    }
  }

  #dispatch(msg) {
    // Response to one of our requests
    if (msg.id !== undefined && msg.method === undefined) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(RpcError.from(msg.error));
      else entry.resolve(msg.result);
      return;
    }

    // Inbound request — expects a response
    if (msg.method !== undefined && msg.id !== undefined) {
      this.#serve(msg);
      return;
    }

    // Notification
    if (msg.method !== undefined) {
      this.emit('notification', { method: msg.method, params: msg.params });
    }
  }

  async #serve(msg) {
    if (!this.onRequest) {
      this.#write({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: RPC_ERRORS.methodNotFound, message: `No handler for ${msg.method}` },
      });
      return;
    }
    try {
      const result = await this.onRequest(msg.method, msg.params);
      this.#write({ jsonrpc: '2.0', id: msg.id, result: result ?? {} });
    } catch (err) {
      const code = err instanceof RpcError ? err.code : RPC_ERRORS.internal;
      this.#write({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code, message: err?.message || String(err), data: err?.data },
      });
    }
  }

  #write(obj) {
    if (this.closed) return;
    try {
      this.output.write(JSON.stringify(obj) + '\n');
    } catch (err) {
      this.emit('error', err);
    }
  }

  #failAll(err) {
    if (this.closed) return;
    this.closed = true;
    for (const [, entry] of this.pending) entry.reject(err);
    this.pending.clear();
    this.emit('close', err);
  }

  /** Send a request and await its result. */
  request(method, params, { timeoutMs = 0 } = {}) {
    if (this.closed) return Promise.reject(new Error('RPC transport closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let timer = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`RPC timeout after ${timeoutMs}ms: ${method}`));
        }, timeoutMs);
      }
      this.pending.set(id, {
        resolve: (v) => {
          if (timer) clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        },
      });
      this.#write({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** Fire-and-forget notification. */
  notify(method, params) {
    this.#write({ jsonrpc: '2.0', method, params });
  }

  close() {
    this.#failAll(new Error('RPC peer closed locally'));
  }
}
