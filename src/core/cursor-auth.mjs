/**
 * Cursor's signed-in account, as the IDE left it on disk.
 *
 * The dashboard API wants the same JWT Cursor already keeps in its state DB.
 * Auto only reads it — never writes tokens back — and treats a missing token
 * as "open Cursor and sign in", not as something Auto can fix.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APPDATA = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
const IDE_DB = join(APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb');

function withDb(fn) {
  if (!existsSync(IDE_DB)) return null;
  const db = new DatabaseSync(IDE_DB, { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function item(key) {
  return withDb((db) => {
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key);
    if (row == null || row.value == null) return null;
    return Buffer.isBuffer(row.value) ? Buffer.from(row.value).toString('utf8') : String(row.value);
  });
}

/** Bearer token Cursor's own settings page would send. */
export function cursorAccessToken() {
  return item('cursorAuth/accessToken');
}

/** Refresh credential — only used to renew a stale access token in memory. */
export function cursorRefreshToken() {
  return item('cursorAuth/refreshToken');
}

/** Quiet facts about who is signed in — never secrets. */
export function cursorAccount() {
  return {
    email: item('cursorAuth/cachedEmail'),
    membership: item('cursorAuth/stripeMembershipType'),
    status: item('cursorAuth/stripeSubscriptionStatus'),
  };
}
