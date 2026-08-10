#!/usr/bin/env node
/**
 * Keep Auto Web + main agent alive.
 *
 * Restarts debug-server on crash/exit and force-restarts if health checks fail.
 * Run this outside Cursor agent shells (Scheduled Task / login) so Auto
 * doesn't die when an agent terminal is killed.
 *
 *   node scripts/supervise.mjs
 *   npm run supervise
 */
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { arg, AUTO_PROVIDER_INFO, ensureAutoProviderAuth } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SERVER = join(HERE, 'debug-server.mjs');
const LOG = join(ROOT, 'supervise.log');
const PID_FILE = join(ROOT, 'supervise.pid');

const host = arg('host', '0.0.0.0');
const port = Number(arg('port', '4331')) || 4331;
const mainPort = Number(arg('main-port', '4332')) || 4332;
const healthMs = Math.max(5000, Number(arg('health-ms', '15000')) || 15000);
const failLimit = Math.max(1, Number(arg('fail-limit', '3')) || 3);
const alertCooldownMs = 5 * 60 * 1000;

/** @type {import('node:child_process').ChildProcess | null} */
let child = null;
let restartDelay = 1000;
let consecutiveFails = 0;
let lastAlertAt = 0;
let stopping = false;
let generation = 0;

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(String).join(' ')}\n`;
  try {
    appendFileSync(LOG, line);
  } catch {
    /* ignore */
  }
  console.log(...args);
}

async function alert(text) {
  const now = Date.now();
  if (now - lastAlertAt < alertCooldownMs) return;
  lastAlertAt = now;
  if (process.env.AUTO_SUPERVISE_ALERT === '0') return;
  try {
    await new Promise((resolve) => {
      const p = spawn(
        process.execPath,
        [join(HERE, 'send.mjs'), `--text=${text}`],
        { cwd: ROOT, windowsHide: true, stdio: 'ignore' },
      );
      p.on('close', () => resolve());
      p.on('error', () => resolve());
    });
  } catch {
    /* ignore */
  }
}

async function healthy() {
  try {
    const [d, m] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(2500),
      }),
      fetch(`http://127.0.0.1:${mainPort}/health`, {
        signal: AbortSignal.timeout(2500),
      }),
    ]);
    if (!d.ok || !m.ok) return false;
    const dj = await d.json();
    const mj = await m.json();
    return Boolean(dj.ok && mj.ok && mj.main?.ready !== false);
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
    /* ignore */
  }
}

function startChild() {
  if (stopping) return;
  generation += 1;
  const gen = generation;
  log(`[supervise] starting debug-server (gen ${gen})`);
  child = spawn(
    process.execPath,
    [SERVER, `--host=${host}`, `--port=${port}`],
    {
      cwd: ROOT,
      windowsHide: true,
      env: {
        ...process.env,
        AUTO_MAIN_PORT: String(mainPort),
        TELEGRAM_DEBUG_PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  writeFileSync(
    PID_FILE,
    JSON.stringify(
      {
        supervisePid: process.pid,
        childPid: child.pid,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );

  child.stdout.on('data', (d) => {
    const s = d.toString().trim();
    if (s) console.log(s);
  });
  child.stderr.on('data', (d) => {
    const s = d.toString().trim();
    if (s) console.error(s);
  });
  child.on('exit', (code, signal) => {
    if (gen !== generation) return;
    child = null;
    log(`[supervise] debug-server exited code=${code} signal=${signal}`);
    if (stopping) return;
    alert(
      `Auto crashed (exit ${code ?? signal}). Supervisor restarting in ${Math.round(restartDelay / 1000)}s…`,
    );
    setTimeout(() => {
      restartDelay = Math.min(30_000, restartDelay * 1.5);
      startChild();
    }, restartDelay);
  });
}

async function healthLoop() {
  while (!stopping) {
    await new Promise((r) => setTimeout(r, healthMs));
    if (stopping) break;
    const ok = await healthy();
    if (ok) {
      if (consecutiveFails > 0) {
        log('[supervise] health restored');
        alert('Auto is healthy again (Auto Web + main agent).');
      }
      consecutiveFails = 0;
      restartDelay = 1000;
      continue;
    }
    consecutiveFails += 1;
    log(
      `[supervise] health fail ${consecutiveFails}/${failLimit} (ports ${port}/${mainPort})`,
    );
    if (consecutiveFails >= failLimit) {
      consecutiveFails = 0;
      log('[supervise] force-restarting unhealthy stack');
      alert(
        `Auto health checks failed ${failLimit}× — force-restarting Auto Web + main agent.`,
      );
      if (child) {
        killTree(child);
        child = null;
      } else {
        // Attached to an external process — kill listeners on our ports
        if (process.platform === 'win32') {
          for (const p of [port, mainPort]) {
            try {
              spawn(
                'powershell',
                [
                  '-NoProfile',
                  '-Command',
                  `Get-NetTCPConnection -LocalPort ${p} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`,
                ],
                { windowsHide: true, stdio: 'ignore' },
              );
            } catch {
              /* ignore */
            }
          }
        }
        setTimeout(() => {
          if (!child && !stopping) startChild();
        }, 2000);
      }
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

mkdirSync(ROOT, { recursive: true });
await ensureAutoProviderAuth();
log(
  `[supervise] watching Auto on :${port} / main :${mainPort} provider=${AUTO_PROVIDER_INFO.provider}` +
    (AUTO_PROVIDER_INFO.mode ? `/${AUTO_PROVIDER_INFO.mode}` : '') +
    (AUTO_PROVIDER_INFO.model ? ` model=${AUTO_PROVIDER_INFO.model}` : '') +
    (AUTO_PROVIDER_INFO.auth ? ` auth=${AUTO_PROVIDER_INFO.auth}` : ''),
);
if (AUTO_PROVIDER_INFO.warning) {
  log(`[supervise] WARNING: ${AUTO_PROVIDER_INFO.warning}`);
}

const alreadyUp = await healthy();
if (alreadyUp) {
  log('[supervise] stack already healthy — supervising without respawn');
} else {
  startChild();
}
healthLoop();

// If we attached to an existing stack and it later dies, startChild from healthLoop.
