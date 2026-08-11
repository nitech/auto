#!/usr/bin/env node
/**
 * Turn Cursor's desktop bridge on, off, or report on it.
 *
 * The bridge is finished code that ships in Cursor, but it only starts when
 * two switches are on: a server-side feature gate (`desktop_bridge`, off for
 * this account) and a user setting in Settings → Beta that stays hidden while
 * the gate is off. Cursor checks its own local override store before asking
 * the server, so both can be set here — the same rows its developer override
 * UI writes.
 *
 * Everything happens in one SQLite table, and every value we touch is saved
 * first, so `disable` puts the machine back exactly as it was. Cursor must be
 * closed: it keeps this storage in memory and would write over us on exit.
 *
 *   node scripts/desktop-bridge.mjs status
 *   node scripts/desktop-bridge.mjs enable
 *   node scripts/desktop-bridge.mjs disable
 *   node scripts/desktop-bridge.mjs ls
 *   node scripts/desktop-bridge.mjs send <threadId> <text...>
 */
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoveryDir, instances, listThreads, sendMessage } from '../src/core/desktop-bridge.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APPDATA = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
const DB = join(APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
const BACKUP = join(ROOT, 'state', 'desktop-bridge.backup.json');

const GATE = 'desktop_bridge';
const KEY = {
  overrides: 'workbench.experiments.featureFlagOverrides',
  serverConfig: 'cursorai/serverConfig',
  userEnabled: 'cursor/desktopBridgeUserEnabled',
  gateMirror: 'cursor.desktopBridge.enabled',
};
// Cursor's own name for the field, spelling out that it is only a local hint.
const DEV_FLAG = 'isDevDoNotUseForSecretThingsBecauseCanBeSpoofedByUsers';

function open(readOnly = true) {
  if (!existsSync(DB)) throw new Error(`Cursor's storage is not at ${DB}`);
  return new DatabaseSync(DB, { readOnly });
}

const read = (db, key) => db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key)?.value;

function readJson(db, key) {
  const raw = read(db, key);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(Buffer.isBuffer(raw) ? Buffer.from(raw).toString('utf8') : String(raw));
  } catch {
    return undefined;
  }
}

function write(db, key, value) {
  db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    value,
  );
}

/** Cursor windows currently running, by pid. */
function cursorPids() {
  if (process.platform !== 'win32') return [];
  try {
    const out = execFileSync('tasklist', ['/fi', 'imagename eq Cursor.exe', '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
    });
    return [...out.matchAll(/^"Cursor\.exe","(\d+)"/gim)].map((m) => Number(m[1]));
  } catch {
    return [];
  }
}

function gateState() {
  const db = open(true);
  try {
    const overrides = readJson(db, KEY.overrides) || {};
    const config = readJson(db, KEY.serverConfig) || {};
    return {
      override: overrides[GATE],
      devEligible: config[DEV_FLAG] === true,
      userEnabled: String(read(db, KEY.userEnabled) ?? '') === 'true',
      mirror: String(read(db, KEY.gateMirror) ?? '(unset)'),
    };
  } finally {
    db.close();
  }
}

async function status() {
  const state = gateState();
  const live = await instances();
  const pids = cursorPids();

  console.log('Cursor desktop bridge');
  console.log(`  feature gate override : ${state.override ? `${state.override.value}` : '(none)'}`);
  console.log(`  dev override allowed  : ${state.devEligible}`);
  console.log(`  user setting (Beta)   : ${state.userEnabled}`);
  console.log(`  gate mirrored to disk : ${state.mirror}`);
  console.log(
    `  Cursor running        : ${pids.length ? `yes (${pids.length} processes)` : 'no'}`,
  );
  console.log(`  discovery dir         : ${discoveryDir()}`);
  console.log(`  reachable instances   : ${live.length}`);
  for (const i of live) console.log(`    - ${i.label}  pid ${i.pid}  ${i.socketPath}`);

  if (!live.length) {
    const enabled = state.override?.value === true && state.devEligible && state.userEnabled;
    console.log(
      enabled
        ? '\nAll switches are on. Start Cursor (or restart it) and the bridge will appear.'
        : '\nRun `node scripts/desktop-bridge.mjs enable` with Cursor closed to turn it on.',
    );
  }
}

function enable() {
  const pids = cursorPids();
  if (pids.length && !process.argv.includes('--force')) {
    console.error(
      `Cursor is running (${pids.length} processes). Quit it first — it holds this storage\n` +
        'in memory and would write over these rows when it exits.',
    );
    process.exitCode = 1;
    return;
  }

  const db = open(false);
  try {
    const before = {
      savedAt: new Date().toISOString(),
      values: Object.fromEntries(
        Object.values(KEY).map((k) => {
          const v = read(db, k);
          return [k, v === undefined ? null : String(v)];
        }),
      ),
    };
    mkdirSync(dirname(BACKUP), { recursive: true });
    writeFileSync(BACKUP, JSON.stringify(before, null, 2));

    const overrides = readJson(db, KEY.overrides) || {};
    overrides[GATE] = { value: true, expiresAt: null };
    write(db, KEY.overrides, JSON.stringify(overrides));

    const config = readJson(db, KEY.serverConfig) || {};
    config[DEV_FLAG] = true;
    write(db, KEY.serverConfig, JSON.stringify(config));

    // The window reads these two itself; setting them now means the bridge is
    // up on the very first launch instead of the one after.
    write(db, KEY.userEnabled, 'true');
    write(db, KEY.gateMirror, 'true');
  } finally {
    db.close();
  }

  console.log('Desktop bridge enabled.');
  console.log(`Previous values saved to ${BACKUP}`);
  console.log('Start Cursor, then run `node scripts/desktop-bridge.mjs status` to confirm.');
}

function disable() {
  const pids = cursorPids();
  if (pids.length && !process.argv.includes('--force')) {
    console.error(`Cursor is running (pid ${pids.join(', ')}). Quit it first.`);
    process.exitCode = 1;
    return;
  }
  if (!existsSync(BACKUP)) {
    console.error(`No backup at ${BACKUP} — nothing to restore.`);
    process.exitCode = 1;
    return;
  }

  const { values } = JSON.parse(readFileSync(BACKUP, 'utf8'));
  const db = open(false);
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === null) db.prepare('DELETE FROM ItemTable WHERE key = ?').run(key);
      else write(db, key, value);
    }
  } finally {
    db.close();
  }
  console.log('Desktop bridge disabled; Cursor storage restored to the saved values.');
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'status':
    case undefined:
      return status();
    case 'enable':
      return enable();
    case 'disable':
      return disable();
    case 'ls': {
      const threads = await listThreads();
      if (!threads.length) console.log('No threads.');
      for (const t of threads) {
        const when = new Date(t.lastUpdatedAt || 0).toISOString().replace('T', ' ').slice(0, 16);
        console.log(`${t.id}  ${when}  ${String(t.status).padEnd(9)}  ${t.title}`);
      }
      return undefined;
    }
    case 'send': {
      const [threadId, ...words] = rest.filter((a) => a !== '--force');
      const result = await sendMessage({
        threadId,
        text: words.join(' '),
        force: rest.includes('--force'),
      });
      console.log(JSON.stringify(result, null, 2));
      return undefined;
    }
    default:
      console.error(`Unknown command "${command}". Try: status | enable | disable | ls | send`);
      process.exitCode = 1;
      return undefined;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
