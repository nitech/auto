/**
 * Permission broker.
 *
 * ACP asks the client to authorise a tool call and blocks the agent's turn
 * until we answer. We park the request, tell every attached view about it, and
 * resolve on the first answer that arrives — so an approval can come from the
 * web UI or from Telegram, whichever the user reaches first.
 *
 * Measured tolerance: the agent waits happily for at least two minutes, so a
 * request can sit until someone picks up their phone.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

/** How a session answers permission requests. */
export const POLICY = {
  /** Always ask a human. */
  ask: 'ask',
  /** Auto-approve everything. Convenient, and exactly what v1 did badly. */
  auto: 'auto',
  /** Auto-approve reads and other non-mutating calls; ask for the rest. */
  askOnWrite: 'ask-on-write',
};

/** Tool kinds we consider non-mutating for `ask-on-write`. */
const READ_ONLY_KINDS = new Set(['read', 'search', 'fetch', 'think']);

/** Pick the option that best matches an intent, tolerating naming drift. */
function pickOption(options, intent) {
  const list = Array.isArray(options) ? options : [];
  const match = (re) =>
    list.find((o) => re.test(o.optionId || '') || re.test(o.kind || '') || re.test(o.name || ''));
  if (intent === 'reject') {
    return match(/reject|deny|no/i) || list[list.length - 1];
  }
  // Prefer a one-shot allow over a blanket one when auto-approving.
  return match(/allow[-_]?once/i) || match(/allow/i) || list[0];
}

export class PermissionBroker extends EventEmitter {
  constructor() {
    super();
    this.pending = new Map();
  }

  /** Outstanding requests, for replay to a client that just attached. */
  list(sessionId) {
    return [...this.pending.values()]
      .filter((p) => !sessionId || p.sessionId === sessionId)
      .map(({ requestId, sessionId: sid, toolCall, options, createdAt }) => ({
        requestId,
        sessionId: sid,
        toolCall,
        options,
        createdAt,
      }));
  }

  /**
   * Handle an inbound `session/request_permission`.
   * @returns {Promise<object>} the ACP outcome object
   */
  request({ sessionId, params, policy = POLICY.ask }) {
    const options = params?.options || [];
    const toolCall = params?.toolCall;

    const autoIntent = this.#autoDecision(policy, toolCall);
    if (autoIntent) {
      const opt = pickOption(options, autoIntent);
      const decision = {
        requestId: randomUUID(),
        sessionId,
        toolCall,
        optionId: opt?.optionId,
        automatic: true,
        policy,
      };
      this.emit('resolved', decision);
      return Promise.resolve({
        outcome: { outcome: 'selected', optionId: opt?.optionId },
      });
    }

    const requestId = randomUUID();
    return new Promise((resolve) => {
      const entry = {
        requestId,
        sessionId,
        toolCall,
        options,
        createdAt: Date.now(),
        resolve,
      };
      this.pending.set(requestId, entry);
      this.emit('requested', {
        requestId,
        sessionId,
        toolCall,
        options,
        createdAt: entry.createdAt,
      });
    });
  }

  /** @returns {'allow'|'reject'|null} null means "ask a human" */
  #autoDecision(policy, toolCall) {
    if (policy === POLICY.auto) return 'allow';
    if (policy === POLICY.askOnWrite && READ_ONLY_KINDS.has(String(toolCall?.kind || ''))) {
      return 'allow';
    }
    return null;
  }

  /**
   * Answer a parked request. Safe to call for an unknown id (a second client
   * racing the first), in which case it is a no-op.
   * @returns {boolean} whether this call was the one that resolved it
   */
  resolve(requestId, optionId, { by = 'user' } = {}) {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    const chosen = optionId || pickOption(entry.options, 'reject')?.optionId;
    entry.resolve({ outcome: { outcome: 'selected', optionId: chosen } });
    this.emit('resolved', {
      requestId,
      sessionId: entry.sessionId,
      toolCall: entry.toolCall,
      optionId: chosen,
      automatic: false,
      by,
    });
    return true;
  }

  /** Cancel a request outright, e.g. when its session is being torn down. */
  cancel(requestId, reason = 'cancelled') {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    entry.resolve({ outcome: { outcome: 'cancelled' } });
    this.emit('resolved', {
      requestId,
      sessionId: entry.sessionId,
      optionId: null,
      cancelled: true,
      reason,
    });
    return true;
  }

  cancelForSession(sessionId, reason) {
    for (const entry of [...this.pending.values()]) {
      if (entry.sessionId === sessionId) this.cancel(entry.requestId, reason);
    }
  }
}
