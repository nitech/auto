#!/usr/bin/env node
/**
 * Keep Auto alive.
 *
 * Restarts the host on crash and force-restarts it when health checks fail.
 * Run this outside Cursor agent shells (Scheduled Task at logon) so Auto does
 * not die when an agent terminal is killed.
 *
 *   node scripts/supervise.mjs
 *   npm run supervise
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SERVER = join(ROOT, 'src', 'server', 'index.mjs');
const LOG = join(ROOT, 'supervise.log');
const HOST_LOG = join(ROOT, 'host.log');
const PID_FILE = join(ROOT, 'supervise.pid');

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const host = arg('host', '0.0.0.0');
const port = Number(arg('port', '4331')) || 4331;
const healthMs = Math.max(5000, Number(arg('health-ms', '15000')) || 15000);
const failLimit = Math.max(1, Number(arg('fail-limit', '3')) || 3);

let child = null;
let restartDelay = 1000;
let consecutiveFails = 0;
let stopping = false;
let generation = 0;

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(String).join(' ')}\n`;
  try {
    appendFileSync(LOG, line);
  } catch {
    /* logging must never take the supervisor down */
  }
  console.log(...args);
}

/**
 * The host's own words, kept. Under the scheduled task its console goes to a
 * window nobody can see, so without this every poll error and refused send is
 * lost the moment it is printed.
 */
function hostLog(line) {
  try {
    appendFileSync(HOST_LOG, `[${new Date().toISOString()}] ${line}\n`);
    if (statSync(HOST_LOG).size > 2_000_000) {
      // This file answers "what just happened" — the newest megabyte is plenty.
      writeFileSync(HOST_LOG, readFileSync(HOST_LOG, 'utf8').slice(-1_000_000));
    }
  } catch {
    /* logging must never take the supervisor down */
  }
}

async function healthy() {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return false;
    return Boolean((await res.json()).ok);
  } catch {
    return false;
  }
}

function killTree(proc) {
  if (!proc?.pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } else {
      proc.kill('SIGTERM');
    }
  } catch {
    /* already gone */
  }
}

function startChild() {
  if (stopping) return;
  generation += 1;
  const gen = generation;
  log(`[supervise] starting host (gen ${gen})`);

  child = spawn(process.execPath, [SERVER, `--host=${host}`, `--port=${port}`], {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  writeFileSync(
    PID_FILE,
    JSON.stringify(
      { supervisePid: process.pid, childPid: child.pid, startedAt: new Date().toISOString() },
      null,
      2,
    ) + '\n',
  );

  const hear = (chunk, isErr) => {
    const s = chunk.toString().trimEnd();
    if (!s) return;
    for (const line of s.split(/\r?\n/)) hostLog(line);
    (isErr ? console.error : console.log)(s);
  };
  child.stdout.on('data', (d) => hear(d, false));
  child.stderr.on('data', (d) => hear(d, true));

  child.on('exit', (code, signal) => {
    if (gen !== generation) return;
    child = null;
    log(`[supervise] host exited code=${code} signal=${signal}`);
    if (stopping) return;
    setTimeout(() => {
      restartDelay = Math.min(30_000, restartDelay * 1.5);
      startChild();
    }, restartDelay);
  });
}

/** Kill whatever owns the port when we are not the parent of the process. */
function killPortListener() {
  if (process.platform !== 'win32') return;
  try {
    spawn(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`,
      ],
      { windowsHide: true, stdio: 'ignore' },
    );
  } catch {
    /* best effort */
  }
}

async function healthLoop() {
  while (!stopping) {
    await new Promise((r) => setTimeout(r, healthMs));
    if (stopping) break;

    if (await healthy()) {
      if (consecutiveFails > 0) log('[supervise] health restored');
      consecutiveFails = 0;
      restartDelay = 1000;
      continue;
    }

    consecutiveFails += 1;
    log(`[supervise] health fail ${consecutiveFails}/${failLimit} on :${port}`);
    if (consecutiveFails < failLimit) continue;

    consecutiveFails = 0;
    log('[supervise] force-restarting unhealthy host');
    if (child) {
      killTree(child);
      child = null;
    } else {
      killPortListener();
      setTimeout(() => {
        if (!child && !stopping) startChild();
      }, 2000);
    }
  }
}

function shutdown() {
  stopping = true;
  log('[supervise] shutting down');
  killTree(child);
  try {
    if (existsSync(PID_FILE)) writeFileSync(PID_FILE, '');
  } catch {
    /* ignore */
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

log(`[supervise] watching Auto on :${port}`);

if (await healthy()) log('[supervise] already healthy — supervising without respawn');
else startChild();

healthLoop();
