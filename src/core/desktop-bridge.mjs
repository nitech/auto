/**
 * Cursor's desktop bridge — talking to the chat threads of the running IDE.
 *
 * Copying a desktop chat into a session of our own was always a branch: the
 * agent could read the history, but the thread in the IDE never moved. Cursor
 * ships the real thing. Its main process listens on a local pipe and forwards
 * requests into the window, where `sendMessage` goes through the same submit
 * path as typing in the chat box. So a message from the phone lands in the
 * actual thread, with its actual context, and the reply appears in the IDE.
 *
 * Finding it: the app drops a small file per running instance in
 * `~/.cursor/desktop-bridge`, naming the pipe and a bearer token. The file is
 * only trustworthy if its protocol matches and its process is still alive —
 * a crashed Cursor leaves its file behind.
 *
 * The bridge is send-only. Replies are read back from the desktop's database
 * (see `desktop-threads.mjs`); together they make one conversation.
 */
import { readFile, readdir } from 'node:fs/promises';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PROTOCOL_VERSION = 1;
const MAX_TEXT_BYTES = 256 * 1024;
const TIMEOUT_MS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where Cursor advertises its running instances. */
export function discoveryDir() {
  return (
    process.env.CURSOR_DESKTOP_BRIDGE_DIR ||
    join(homedir().replace(/[\\/]+$/, ''), '.cursor', 'desktop-bridge')
  );
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function usable(d) {
  return (
    d &&
    typeof d === 'object' &&
    d.protocolVersion === PROTOCOL_VERSION &&
    typeof d.socketPath === 'string' &&
    typeof d.token === 'string' &&
    alive(d.pid)
  );
}

/**
 * Every Cursor instance we can currently talk to.
 *
 * @returns {Promise<Array<{ socketPath: string, token: string, pid: number,
 *   appName: string, appVersion: string, userDataDir: string, label: string }>>}
 */
export async function instances() {
  let entries;
  try {
    entries = await readdir(discoveryDir(), { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const found = await Promise.all(
    entries
      .filter((e) => e.isFile() && e.name.endsWith('.json'))
      .map(async (e) => {
        try {
          const d = JSON.parse(await readFile(join(discoveryDir(), e.name), 'utf8'));
          return usable(d) ? { ...d, label: `${d.appName} ${d.appVersion}` } : null;
        } catch {
          return null;
        }
      }),
  );
  return found.filter(Boolean);
}

/** Is a Cursor window reachable right now? */
export async function bridgeAvailable() {
  return (await instances()).length > 0;
}

function post(instance, body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: instance.socketPath,
        path: '/',
        method: 'POST',
        headers: {
          authorization: `Bearer ${instance.token}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('error', reject);
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: res.statusCode || 500, body: JSON.parse(text) });
          } catch {
            reject(new Error(`${instance.label} returned invalid JSON: ${text.slice(0, 200)}`));
          }
        });
      },
    );
    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy(new Error(`${instance.label} did not answer within ${TIMEOUT_MS}ms`));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function callAll(body) {
  const live = await instances();
  if (!live.length) {
    throw new Error(
      'No running Cursor desktop instance is exposing its bridge. Is the desktop bridge enabled and Cursor open?',
    );
  }

  const failures = [];
  const answers = [];
  for (const instance of live) {
    try {
      const { status, body: answer } = await post(instance, body);
      if (status !== 200) {
        failures.push(`${instance.label}: HTTP ${status} ${answer?.error || ''}`.trim());
        continue;
      }
      answers.push({ instance, answer });
    } catch (err) {
      failures.push(`${instance.label}: ${err.message}`);
    }
  }

  if (!answers.length) throw new Error(failures.join('; ') || 'The desktop bridge did not answer');
  return answers;
}

/**
 * Chat threads open in the desktop app, newest first.
 *
 * Cursor answers per window; one thread can only belong to one, so the first
 * window claiming an id wins.
 */
export async function listThreads() {
  const answers = await callAll({ type: 'listThreads' });
  const byId = new Map();
  for (const { instance, answer } of answers) {
    for (const t of answer?.threads || []) {
      if (!t?.id || byId.has(t.id)) continue;
      byId.set(t.id, { ...t, instance: instance.label, userDataDir: instance.userDataDir });
    }
  }
  return [...byId.values()].sort((a, b) => (b.lastUpdatedAt || 0) - (a.lastUpdatedAt || 0));
}

/**
 * Send a message to a live desktop thread.
 *
 * `queued` means the thread was mid-turn and Cursor will send it when the
 * turn ends; `force` interrupts instead. Both are the desktop's own semantics,
 * the same as typing while the agent is working.
 *
 * @param {object} opts
 * @param {string} opts.threadId
 * @param {string} opts.text
 * @param {boolean} [opts.force]
 * @returns {Promise<{ status: string, threadId?: string, threadTitle?: string,
 *   windowId?: number, reason?: string, message?: string }>}
 */
export async function sendMessage({ threadId, text, force = false }) {
  if (!UUID.test(String(threadId || ''))) {
    throw new Error(`"${threadId}" is not a desktop thread id`);
  }
  if (!text || !String(text).trim()) throw new Error('Nothing to send');
  if (Buffer.byteLength(String(text)) > MAX_TEXT_BYTES) {
    throw new Error(`Message is larger than the bridge's ${MAX_TEXT_BYTES} byte limit`);
  }

  // Only one window owns the thread; the others answer "unknown-thread".
  const answers = await callAll({ type: 'sendMessage', threadId, text: String(text), force });
  const accepted = answers.find(({ answer }) =>
    ['submitted', 'queued'].includes(answer?.status),
  );
  if (accepted) return accepted.answer;

  const refused = answers.find(({ answer }) => answer?.status && answer.status !== 'unknown-thread');
  return refused?.answer || { status: 'unknown-thread' };
}
