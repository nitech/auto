#!/usr/bin/env node
/**
 * First-run checks for a machine that already has Cursor.
 *
 * `npm install` runs this as postinstall. It never fails the install: a
 * missing Tailscale or agent CLI is the next step, not a broken package.
 * `npm run setup` is the same script without that softness — it exits 1
 * when something Auto cannot start without is missing.
 * `npm run supervise` prints this checklist too, then starts the host.
 *
 * Prints a checklist and the next command, then points at docs/install.md.
 */
import { copyFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const MIN_NODE_MAJOR = 20;

function run(command, args, { timeout = 12_000, shell = process.platform === 'win32' } = {}) {
  try {
    return spawnSync(command, args, {
      encoding: 'utf8',
      timeout,
      shell,
      windowsHide: true,
    });
  } catch (err) {
    return { status: 1, stdout: '', stderr: String(err?.message || err), error: err };
  }
}

function which(name) {
  const probe = process.platform === 'win32' ? 'where.exe' : 'which';
  const res = run(probe, [name], { timeout: 4000, shell: false });
  if (res.status !== 0) return null;
  const line = String(res.stdout || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find(Boolean);
  return line || null;
}

function tailscaleBin() {
  const onPath = which('tailscale');
  if (onPath) return onPath;
  if (process.platform === 'win32') {
    const guess = join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Tailscale', 'tailscale.exe');
    if (existsSync(guess)) return guess;
  }
  return null;
}

export function supportsColor() {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout?.isTTY);
}

const ANSI = {
  green: '32',
  red: '31',
  yellow: '33',
  cyan: '36',
  bold: '1',
  brightCyan: '1;96',
};

/** Colour a string when stdout is a TTY (unless NO_COLOR). */
export function paint(kind, text) {
  const s = String(text ?? '');
  if (!supportsColor() || !ANSI[kind]) return s;
  return `\x1b[${ANSI[kind]}m${s}\x1b[0m`;
}

/** This machine's Tailscale IPv4, or null. */
export function tailscaleIpv4() {
  const ts = tailscaleBin();
  if (!ts) return null;
  const ip = run(ts, ['ip', '-4'], { timeout: 8000, shell: false });
  return (
    String(ip.stdout || '')
      .split(/\s+/)
      .map((s) => s.trim())
      .find((s) => /^100\.\d+\.\d+\.\d+$/.test(s)) || null
  );
}

/**
 * Where a phone (and this PC) should open Auto.
 * Pass the setup checks to reuse the Tailscale lookup already done.
 */
export function whereAutoLives(port, checks) {
  const n = Number(port) || 4331;
  const fromCheck = checks?.find((c) => c.id === 'tailscale');
  const ip = fromCheck ? fromCheck.ip || null : tailscaleIpv4();
  return {
    ip,
    port: n,
    phoneUrl: ip ? `http://${ip}:${n}/` : null,
    localUrl: `http://127.0.0.1:${n}/`,
  };
}

/** Whether the CLI is missing or `agent status` is not signed in. */
export function agentLoginRequired(checks) {
  const login = checks?.find((c) => c.id === 'agent-login');
  if (login) return !login.ok;
  const agent = checks?.find((c) => c.id === 'agent');
  return Boolean(agent) && !agent.ok;
}

/**
 * Plain-text banner for where Auto lives. Supervise colours this for a TTY.
 */
export function formatReachability({ ip, port, loginOk = true, agentOk = true, up = true } = {}) {
  const n = Number(port) || 4331;
  const lines = [up ? 'Auto is up' : 'Auto is starting'];
  if (ip) lines.push(`Phone: http://${ip}:${n}/`);
  else lines.push('Phone: Tailscale has no 100.x address yet — sign in, then: tailscale ip -4');
  lines.push(`This PC: http://127.0.0.1:${n}/`);
  if (agentOk === false) {
    lines.push('Cursor agent CLI not found — install it, then: agent login');
  } else if (!loginOk) {
    lines.push('Agent login required — run: agent login');
  }
  return lines.join('\n');
}

function nodeMajor(version = process.versions.node) {
  return Number(String(version).split('.')[0]) || 0;
}

export function ensureEnvFile(root = ROOT) {
  const dest = join(root, '.env');
  const src = join(root, '.env.example');
  if (existsSync(dest)) return { path: dest, copied: false };
  if (!existsSync(src)) return { path: dest, copied: false, missingExample: true };
  copyFileSync(src, dest);
  return { path: dest, copied: true };
}

/** Strip ANSI so `agent status` colour codes do not hide the words. */
function stripAnsi(text) {
  return String(text || '').replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Whether `agent status` says the CLI is signed in.
 *
 * The CLI prints `Not logged in` when it is not. A `/logged in/i` match
 * treated that as success, so setup went green and Auto then failed with
 * `Authentication required` (empty model picker, no ACP session).
 */
export function agentCliLoggedIn(text) {
  const s = stripAnsi(text);
  if (/\bnot logged in\b/i.test(s)) return false;
  if (/authentication required/i.test(s)) return false;
  if (/\blogged in as\b/i.test(s)) return true;
  if (/login successful/i.test(s)) return true;
  return false;
}

function agentCliWho(text) {
  return stripAnsi(text).match(/logged in as\s+(\S+)/i)?.[1] || null;
}

export async function collectChecks({ root = ROOT } = {}) {
  const checks = [];

  const major = nodeMajor();
  checks.push({
    id: 'node',
    required: true,
    ok: major >= MIN_NODE_MAJOR,
    detail:
      major >= MIN_NODE_MAJOR
        ? `Node v${process.versions.node}`
        : `Node v${process.versions.node} (need ${MIN_NODE_MAJOR}+)`,
    hint:
      major >= MIN_NODE_MAJOR
        ? null
        : 'Install the current LTS from https://nodejs.org and open a new terminal.',
  });

  const bun = Boolean(process.versions.bun);
  if (bun) {
    checks.push({
      id: 'runtime',
      required: false,
      ok: false,
      warn: true,
      detail: "running under Bun — Auto's host and scheduled task expect Node",
      hint: 'Use npm (not bun) to install, and node to run. See docs/install.md#why-npm-not-bun.',
    });
  }

  let ptyOk = false;
  let ptyDetail = 'node-pty failed to load';
  try {
    const pty = await import('node-pty');
    ptyOk = Boolean(pty?.default?.spawn || pty?.spawn);
    ptyDetail = ptyOk ? 'node-pty loaded' : 'node-pty imported but has no spawn';
  } catch (err) {
    ptyDetail = `node-pty: ${err?.message || err}`;
  }
  checks.push({
    id: 'pty',
    required: false,
    ok: ptyOk,
    detail: ptyDetail,
    hint: ptyOk
      ? null
      : process.platform === 'win32'
        ? 'Install “Desktop development with C++” from Visual Studio Build Tools, then npm install again. The web app still runs without terminals.'
        : 'Rebuild native modules (npm install) — terminals need node-pty. The web app still runs without them.',
  });

  let agentOk = false;
  let found = null;
  let agentDetail = 'Cursor agent CLI not found';
  let agentHint =
    process.platform === 'win32'
      ? "In PowerShell: irm 'https://cursor.com/install?win32=true' | iex   then: agent login"
      : 'Install from https://cursor.com/docs/cli/overview then run: agent login';
  try {
    const { resolveCursorAgent } = await import('../src/acp/resolve.mjs');
    found = resolveCursorAgent();
    agentOk = Boolean(found?.command);
    agentDetail = agentOk
      ? `Cursor agent CLI (${found.via || 'found'})`
      : agentDetail;
  } catch (err) {
    agentDetail = err?.message?.split('\n')[0] || agentDetail;
  }
  checks.push({
    id: 'agent',
    required: true,
    ok: agentOk,
    detail: agentDetail,
    hint: agentOk ? null : agentHint,
  });

  if (found) {
    const status = run(found.command, [...found.args, 'status'], {
      timeout: 15_000,
      shell: found.shell,
    });
    const text = `${status.stdout || ''}\n${status.stderr || ''}`;
    const loggedIn = agentCliLoggedIn(text);
    const who = loggedIn ? agentCliWho(text) : null;
    checks.push({
      id: 'agent-login',
      required: true,
      ok: loggedIn,
      detail: loggedIn
        ? who
          ? `CLI logged in as ${who}`
          : 'CLI logged in'
        : 'CLI found, not logged in',
      hint: loggedIn ? null : 'Run: agent login',
    });
  }

  const ts = tailscaleBin();
  if (!ts) {
    checks.push({
      id: 'tailscale',
      required: false,
      ok: false,
      ip: null,
      detail: 'Tailscale not installed',
      hint:
        process.platform === 'win32'
          ? 'Install from https://tailscale.com/download/windows, sign in, then install the app on your phone with the same account.'
          : 'Install from https://tailscale.com/download, sign in, then install the app on your phone with the same account.',
    });
  } else {
    const addr = tailscaleIpv4();
    const up = run(ts, ['status', '--json'], { timeout: 8000, shell: false });
    let backend = '';
    try {
      backend = JSON.parse(up.stdout || '{}').BackendState || '';
    } catch {
      backend = String(up.stdout || up.stderr || '').slice(0, 80);
    }
    checks.push({
      id: 'tailscale',
      required: false,
      ok: Boolean(addr),
      ip: addr || null,
      detail: addr
        ? `Tailscale ${addr}${backend && backend !== 'Running' ? ` (${backend})` : ''}`
        : `Tailscale installed${backend ? ` (${backend})` : ''}, no 100.x address yet`,
      hint: addr
        ? `From a phone on the same tailnet: http://${addr}:4331/`
        : 'Open the Tailscale tray icon and Log in. Then: tailscale ip -4',
    });
  }

  const env = ensureEnvFile(root);
  checks.push({
    id: 'env',
    required: false,
    ok: existsSync(env.path),
    detail: env.copied
      ? 'copied .env.example → .env'
      : existsSync(env.path)
        ? '.env present'
        : '.env missing',
    hint: existsSync(env.path)
      ? null
      : 'Copy .env.example to .env. Telegram is optional; Tailscale is how you reach the web app.',
  });

  return checks;
}

function mark(check) {
  if (check.ok) return paint('green', '✓');
  if (check.warn) return paint('yellow', '!');
  return paint('red', '✗');
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.postinstall]
 * @param {string} [opts.root]
 * @param {boolean} [opts.next]  when false (supervise), skip "run supervise" / tutorial
 */
export async function printReport({ postinstall = false, root = ROOT, next = true } = {}) {
  const checks = await collectChecks({ root });
  const requiredMissing = checks.filter((c) => c.required && !c.ok);
  const ts = checks.find((c) => c.id === 'tailscale');
  const tsHint = ts?.ok ? ts.hint : null;

  console.log('');
  console.log(paint('bold', 'Auto setup'));
  for (const c of checks) {
    console.log(`  ${mark(c)} ${c.detail}`);
    if (!c.ok && c.hint) console.log(paint('yellow', `    ${c.hint}`));
  }
  console.log('');

  if (requiredMissing.length) {
    console.log(paint('red', 'Still needed before Auto can drive Cursor:'));
    for (const c of requiredMissing) {
      if (c.hint) console.log(paint('yellow', `  – ${c.hint}`));
    }
    console.log('');
  } else if (next) {
    console.log('Next:  npm run supervise');
    if (tsHint) console.log(`Then:  ${tsHint}`);
    else console.log('Then:  install Tailscale (see docs/install.md) and open the 100.x:4331 URL from your phone.');
    console.log('');
  }

  if (next) {
    console.log('Tutorial: docs/install.md');
    if (postinstall) console.log('Re-run checks any time: npm run setup');
    console.log('');
  }

  return { checks, requiredMissing };
}

function invokedDirectly() {
  try {
    return pathToFileURL(resolvePath(process.argv[1] || '')).href === import.meta.url;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const postinstall = process.argv.includes('--postinstall');
  const report = await printReport({ postinstall });
  if (!postinstall && report.requiredMissing.length) process.exit(1);
}
