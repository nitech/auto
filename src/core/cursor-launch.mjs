/**
 * Starting Cursor itself, so a session can live in the IDE.
 *
 * Opening a folder in a window that is already listening is cheap: the running
 * process takes `--new-window` and a new workbench appears on the same debug
 * port. Starting Cursor from nothing is the same command plus the port, so the
 * window is born reachable.
 *
 * The awkward case is Cursor already running *without* the port. Electron will
 * not add it to a process that has started: a second launch just hands the
 * folder to the existing instance and exits. The only way to get the port is
 * to quit Cursor and start it again, which closes every window. Auto refuses
 * that by default; set `AUTO_ALLOW_CURSOR_RESTART=1` to allow the kill.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cursorProcessCount } from './desktop-bridge-gate.mjs';

export const DEFAULT_CURSOR_PORT = 9222;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Where Cursor is installed on this machine, if anywhere we know. */
export function findCursorExe() {
  if (process.env.CURSOR_PATH && existsSync(process.env.CURSOR_PATH)) return process.env.CURSOR_PATH;
  const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  const candidates = [
    join(local, 'Programs', 'cursor', 'Cursor.exe'),
    join(local, 'Programs', 'Cursor', 'Cursor.exe'),
    join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Cursor', 'Cursor.exe'),
  ];
  return candidates.find((p) => existsSync(p)) || null;
}

export function cursorRunning() {
  return cursorProcessCount() > 0;
}

/**
 * Ask the running Cursor to open a folder, or start it if nothing is running.
 *
 * @param {object} opts
 * @param {string} [opts.folder]
 * @param {boolean} [opts.newWindow]
 * @param {number|null} [opts.debugPort]  set only when this process will be
 *   the first Cursor; a running instance ignores it
 * @param {typeof spawn} [opts.spawnFn]
 */
export function spawnCursor({
  folder,
  newWindow = true,
  debugPort = null,
  spawnFn = spawn,
  exe = findCursorExe(),
} = {}) {
  if (!exe) throw new Error('Cursor is not installed where Auto expects it');
  const args = [];
  if (debugPort) args.push(`--remote-debugging-port=${debugPort}`);
  if (newWindow) args.push('--new-window');
  if (folder) args.push(String(folder));

  const child = spawnFn(exe, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref?.();
  return { exe, args, pid: child.pid };
}

/** Kill every Cursor.exe. The debug port cannot be added any other way. */
export function quitCursor({ execFile = execFileSync } = {}) {
  try {
    execFile('taskkill', ['/IM', 'Cursor.exe', '/F'], {
      encoding: 'utf8',
      windowsHide: true,
    });
  } catch {
    // Already gone, or taskkill had nothing to kill.
  }
}

/** True once `check` stays true, or false if time runs out. */
export async function waitUntil(check, { timeoutMs = 15_000, intervalMs = 250, sleep = wait } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return true;
    await sleep(intervalMs);
  }
  return Boolean(await check());
}
