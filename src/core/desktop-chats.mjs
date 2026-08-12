/**
 * Chats you started in the Cursor desktop app, listed per project.
 *
 * This is the catalogue only — picking one up is `desktop-threads.mjs` for
 * reading and `desktop-bridge.mjs` for sending. Auto used to continue a chat
 * by copying its conversation into a session of its own, which worked but
 * branched: carry on in the IDE afterwards and the two drifted apart. Cursor
 * turns out to expose the real thing, so the copy is gone and a chat opened
 * from Auto is the same chat the IDE has.
 *
 * We only ever read the desktop's database.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APPDATA = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
const IDE_DB = join(APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb');

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

/** One `composerHeaders` row as a chat. */
function chatOf(row) {
  let head = {};
  try {
    head = JSON.parse(textOf(row));
  } catch {
    /* a header we cannot read is still a chat */
  }
  return {
    id: row.composerId,
    title: head.name || 'Untitled chat',
    subtitle: head.subtitle || '',
    updatedAt: row.lastUpdatedAt || head.lastUpdatedAt || 0,
    createdAt: row.createdAt || head.createdAt || 0,
    linesAdded: head.totalLinesAdded || 0,
    linesRemoved: head.totalLinesRemoved || 0,
    workspaceId: row.workspaceId,
  };
}

/**
 * The desktop's most recent chats across every workspace, newest first.
 *
 * This is the list the IDE itself shows, which is what Auto's rail should be:
 * the same conversations under the same names, rather than a separate world.
 */
export function recentDesktopChats({ limit = 60 } = {}) {
  return (
    withDb((db) =>
      db
        .prepare(
          'SELECT composerId, workspaceId, createdAt, lastUpdatedAt, value FROM composerHeaders WHERE isArchived = 0 AND isSubagent = 0 ORDER BY lastUpdatedAt DESC LIMIT ?',
        )
        .all(limit)
        .map(chatOf),
    ) || []
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
      return db
        .prepare('SELECT composerId, workspaceId, createdAt, lastUpdatedAt, value FROM composerHeaders WHERE workspaceId = ? AND isArchived = 0 AND isSubagent = 0 ORDER BY lastUpdatedAt DESC LIMIT ?')
        .all(workspaceId, limit)
        .map(chatOf);
    }) || []
  );
}
