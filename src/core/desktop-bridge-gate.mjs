/**
 * The switches that let Cursor's desktop bridge run.
 *
 * The bridge is finished code inside Cursor, but its main process only starts
 * the listener when a server-side feature gate and a Settings → Beta toggle
 * are both on, and the window re-checks the gate on every request. Cursor
 * consults its own local override store before asking the server, so both can
 * be set here — the same rows its developer override UI writes.
 *
 * One wrinkle makes this a job rather than a one-off: Cursor refreshes its
 * server config from the network, and that wipes the flag marking this
 * machine eligible to use overrides — a flag Cursor only reads at startup.
 * Left alone, the bridge works until the next restart and then quietly stops.
 * So Auto re-asserts it, which is cheap and, being idempotent, invisible.
 *
 * Everything lives in one SQLite table. `snapshot` captures what we found
 * before ever touching it, so `restore` can put the machine back exactly.
 */
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APPDATA = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
const DB = join(APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb');

const GATE = 'desktop_bridge';
export const KEYS = {
  overrides: 'workbench.experiments.featureFlagOverrides',
  serverConfig: 'cursorai/serverConfig',
  userEnabled: 'cursor/desktopBridgeUserEnabled',
  gateMirror: 'cursor.desktopBridge.enabled',
};
/** Cursor's own name for the field, spelling out that it is a local hint. */
const DEV_FLAG = 'isDevDoNotUseForSecretThingsBecauseCanBeSpoofedByUsers';

/** Is Cursor's storage where we expect it? */
export function storageAvailable() {
  return existsSync(DB);
}

function withDb(readOnly, fn) {
  if (!existsSync(DB)) throw new Error(`Cursor's storage is not at ${DB}`);
  const db = new DatabaseSync(DB, { readOnly });
  try {
    return fn({
      read: (key) => db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key)?.value,
      readJson: (key) => {
        const raw = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key)?.value;
        if (raw === undefined) return undefined;
        try {
          return JSON.parse(Buffer.isBuffer(raw) ? Buffer.from(raw).toString('utf8') : String(raw));
        } catch {
          return undefined;
        }
      },
      write: (key, value) =>
        db
          .prepare(
            'INSERT INTO ItemTable (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
          )
          .run(key, value),
      remove: (key) => db.prepare('DELETE FROM ItemTable WHERE key = ?').run(key),
    });
  } finally {
    db.close();
  }
}

/** How many Cursor processes are running; zero means it is safe to write. */
export function cursorProcessCount() {
  if (process.platform !== 'win32') return 0;
  try {
    const out = execFileSync('tasklist', ['/fi', 'imagename eq Cursor.exe', '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
    });
    return [...out.matchAll(/^"Cursor\.exe","(\d+)"/gim)].length;
  } catch {
    return 0;
  }
}

/**
 * What the four switches currently say.
 *
 * @returns {{ override: boolean, devEligible: boolean, userEnabled: boolean,
 *   mirror: string, allOn: boolean }}
 */
export function gateState() {
  return withDb(true, ({ read, readJson }) => {
    const override = (readJson(KEYS.overrides) || {})[GATE];
    const state = {
      override: override?.value === true,
      devEligible: (readJson(KEYS.serverConfig) || {})[DEV_FLAG] === true,
      userEnabled: String(read(KEYS.userEnabled) ?? '') === 'true',
      mirror: String(read(KEYS.gateMirror) ?? '(unset)'),
    };
    return { ...state, allOn: state.override && state.devEligible && state.userEnabled };
  });
}

/** The untouched values, for putting things back later. */
export function snapshot() {
  return withDb(true, ({ read }) => ({
    savedAt: new Date().toISOString(),
    values: Object.fromEntries(
      Object.values(KEYS).map((k) => {
        const v = read(k);
        return [k, v === undefined ? null : String(v)];
      }),
    ),
  }));
}

/**
 * Turn all four switches on, writing only what is not already set.
 *
 * @returns {string[]} the keys that had to be changed
 */
export function assertSwitches() {
  return withDb(false, ({ readJson, read, write }) => {
    const changed = [];

    const overrides = readJson(KEYS.overrides) || {};
    if (overrides[GATE]?.value !== true) {
      overrides[GATE] = { value: true, expiresAt: null };
      write(KEYS.overrides, JSON.stringify(overrides));
      changed.push(KEYS.overrides);
    }

    const config = readJson(KEYS.serverConfig) || {};
    if (config[DEV_FLAG] !== true) {
      config[DEV_FLAG] = true;
      write(KEYS.serverConfig, JSON.stringify(config));
      changed.push(KEYS.serverConfig);
    }

    // The window reads these two itself; setting them means the bridge is up
    // on the very first launch instead of the one after.
    if (String(read(KEYS.userEnabled) ?? '') !== 'true') {
      write(KEYS.userEnabled, 'true');
      changed.push(KEYS.userEnabled);
    }
    if (String(read(KEYS.gateMirror) ?? '') !== 'true') {
      write(KEYS.gateMirror, 'true');
      changed.push(KEYS.gateMirror);
    }

    return changed;
  });
}

/** Put back the values from a snapshot. */
export function restoreSwitches({ values }) {
  return withDb(false, ({ write, remove }) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === null) remove(key);
      else write(key, value);
    }
  });
}
