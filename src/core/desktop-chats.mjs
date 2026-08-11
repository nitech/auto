/**
 * Chats you started in the Cursor desktop app — listed, and handed to the
 * agent so they can be continued from the phone.
 *
 * The desktop and the CLI turn out to run the same machinery. A conversation
 * is a set of content-addressed blobs plus a manifest naming them; the desktop
 * keeps its blobs in `state.vscdb` under `agentKv:blob:<sha256>` and the
 * manifest in `composerData.conversationState`, while an ACP session keeps the
 * identical structure in its own small SQLite file. So continuing a desktop
 * chat is a copy: take the manifest as the session's root, bring the blobs it
 * names across, and the agent loads it like any other session.
 *
 * We only ever read the desktop's database. The copy is a snapshot — carry on
 * in the IDE afterwards and the two diverge, like branching.
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APPDATA = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
const IDE_DB = join(APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
const ACP_SESSIONS = join(homedir(), '.cursor', 'acp-sessions');

/** Is the desktop's chat database where we expect it? */
export function desktopChatsAvailable() {
  return existsSync(IDE_DB);
}

/**
 * The desktop database is large and written to constantly by a running
 * Cursor, so open it read-only for the length of one query and let go.
 */
function withDb(fn) {
  if (!existsSync(IDE_DB)) return null;
  const db = new DatabaseSync(IDE_DB, { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const textOf = (row, column = 'value') =>
  row[`${column}_t`] === 'blob' || Buffer.isBuffer(row[column])
    ? Buffer.from(row[column]).toString('utf8')
    : String(row[column]);

/** How many desktop chats each workspace has, in one pass. */
export function chatCountsByWorkspace() {
  return (
    withDb((db) => {
      const out = new Map();
      for (const r of db
        .prepare('SELECT workspaceId, COUNT(*) c FROM composerHeaders WHERE isArchived = 0 AND isSubagent = 0 GROUP BY workspaceId')
        .all()) {
        out.set(r.workspaceId, r.c);
      }
      return out;
    }) || new Map()
  );
}

/**
 * The desktop's chats for one workspace, newest first.
 *
 * @param {string} workspaceId  the workspaceStorage id for the folder
 */
export function desktopChats(workspaceId, { limit = 40 } = {}) {
  if (!workspaceId) return [];
  return (
    withDb((db) => {
      const rows = db
        .prepare('SELECT composerId, createdAt, lastUpdatedAt, value FROM composerHeaders WHERE workspaceId = ? AND isArchived = 0 AND isSubagent = 0 ORDER BY lastUpdatedAt DESC LIMIT ?')
        .all(workspaceId, limit);

      return rows.map((r) => {
        let head = {};
        try {
          head = JSON.parse(textOf(r));
        } catch {
          /* a header we cannot read is still a chat */
        }
        return {
          id: r.composerId,
          title: head.name || 'Untitled chat',
          subtitle: head.subtitle || '',
          updatedAt: r.lastUpdatedAt || head.lastUpdatedAt || 0,
          createdAt: r.createdAt || head.createdAt || 0,
          linesAdded: head.totalLinesAdded || 0,
          linesRemoved: head.totalLinesRemoved || 0,
        };
      });
    }) || []
  );
}

/** The 32-byte length-delimited entries of a manifest blob. */
function refs(buf) {
  const out = [];
  let off = 0;
  while (off < buf.length) {
    const tag = buf[off];
    if ((tag & 0x07) !== 2) break;
    off += 1;
    let len = 0;
    let shift = 0;
    let complete = false;
    while (off < buf.length) {
      const b = buf[off++];
      len |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) {
        complete = true;
        break;
      }
      shift += 7;
    }
    if (!complete || off + len > buf.length) break;
    if (len === 32) out.push(buf.subarray(off, off + len).toString('hex'));
    off += len;
  }
  return out;
}

/**
 * The readable conversation inside a set of blobs, in the order the manifest
 * names them.
 *
 * The agent gets the whole conversation regardless; this is only so the phone
 * has something to show. Tool traffic is left out — it is most of the volume
 * and none of the thread — and the environment preambles that wrap every real
 * message are unwrapped back to what was actually typed.
 *
 * @param {string[]} order    blob digests, in conversation order
 * @param {Map<string, Buffer>} blobs
 * @param {number} [limit]    keep only the last N messages
 */
function readConversation(order, blobs, limit = 300) {
  const out = [];

  for (const digest of order) {
    const buf = blobs.get(digest);
    if (!buf || buf[0] !== 0x7b) continue; // not JSON

    let msg;
    try {
      msg = JSON.parse(buf.toString('utf8'));
    } catch {
      continue;
    }
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;

    const text = (
      typeof msg.content === 'string'
        ? msg.content
        : (msg.content || [])
            .filter((c) => c?.type === 'text' && c.text)
            .map((c) => c.text)
            .join('\n')
    ).trim();
    if (!text) continue;

    if (msg.role === 'user') {
      // Real messages arrive wrapped in context the harness adds; anything
      // without a query in it is that scaffolding, not something you said.
      const query = /<user_query>([\s\S]*?)<\/user_query>/.exec(text);
      if (!query) continue;
      out.push({ role: 'user', text: query[1].trim() });
    } else {
      out.push({ role: 'assistant', text });
    }
  }

  return out.length > limit ? out.slice(-limit) : out;
}

/**
 * Copy a desktop chat into a new ACP session the agent can load.
 *
 * @param {object} opts
 * @param {string} opts.chatId  the desktop chat (composer) id
 * @param {string} opts.cwd     folder the session should run in
 * @returns {{ sessionId: string, title: string, blobs: number, missing: number,
 *            messages: Array<{role: string, text: string}> }}
 */
export function importDesktopChat({ chatId, cwd }) {
  const chat = withDb((db) => {
    const row = db
      .prepare('SELECT value, typeof(value) value_t FROM cursorDiskKV WHERE key = ?')
      .get(`composerData:${chatId}`);
    if (!row) throw new Error(`Desktop chat ${chatId} not found`);
    const data = JSON.parse(textOf(row));
    if (!data.conversationState) {
      throw new Error('That chat has no conversation state to continue from');
    }

    const rootBytes = Buffer.from(String(data.conversationState).replace(/^~/, ''), 'base64');
    const getBlob = db.prepare(
      'SELECT value, typeof(value) value_t FROM cursorDiskKV WHERE key = ?',
    );

    // Walk the manifest; entries can name further blobs of their own.
    const blobs = new Map();
    const queue = refs(rootBytes);
    const missing = new Set();
    while (queue.length) {
      const digest = queue.pop();
      if (blobs.has(digest) || missing.has(digest)) continue;
      const row2 = getBlob.get(`agentKv:blob:${digest}`);
      if (!row2) {
        missing.add(digest);
        continue;
      }
      const buf =
        row2.value_t === 'blob' ? Buffer.from(row2.value) : Buffer.from(String(row2.value), 'hex');
      blobs.set(digest, buf);
      for (const child of refs(buf)) queue.push(child);
    }

    return {
      name: data.name || 'Desktop chat',
      key: data.blobEncryptionKey,
      rootBytes,
      blobs,
      missing: missing.size,
      messages: readConversation(refs(rootBytes), blobs),
    };
  });

  if (!chat) throw new Error('The Cursor desktop database is not available');
  if (!chat.blobs.size) {
    throw new Error('None of that chat is stored on this machine any more');
  }

  const sessionId = randomUUID();
  const dir = join(ACP_SESSIONS, sessionId);
  mkdirSync(dir, { recursive: true });

  try {
    writeFileSync(
      join(dir, 'meta.json'),
      JSON.stringify({ schemaVersion: 1, cwd, title: chat.name }),
    );

    const db = new DatabaseSync(join(dir, 'store.db'));
    try {
      db.exec('PRAGMA journal_mode=WAL');
      db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)');
      db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');

      const insert = db.prepare('INSERT OR REPLACE INTO blobs (id, data) VALUES (?, ?)');
      for (const [digest, buf] of chat.blobs) insert.run(digest, buf);

      const rootId = createHash('sha256').update(chat.rootBytes).digest('hex');
      insert.run(rootId, chat.rootBytes);

      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
        '0',
        Buffer.from(
          JSON.stringify({
            agentId: sessionId,
            latestRootBlobId: rootId,
            name: chat.name,
            mode: 'default',
            isRunEverything: false,
            createdAt: Date.now(),
            blobEncryptionKey: Buffer.from(chat.key || '', 'base64').toString('hex'),
          }),
        ).toString('hex'),
      );
    } finally {
      db.close();
    }
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }

  return {
    sessionId,
    title: chat.name,
    blobs: chat.blobs.size,
    missing: chat.missing,
    messages: chat.messages,
  };
}
