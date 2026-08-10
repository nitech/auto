#!/usr/bin/env node
/**
 * Always-on Auto front-desk agent.
 *
 * Keeps a Claude Code stream-json session open for instant replies.
 * Spawns worker-agent.mjs for real work; workers report status here so
 * the main agent can update the user on Telegram / Auto Web.
 *
 *   node main-agent.mjs --port=4332 --debug-port=4331
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  arg,
  PROJECT_ROOT,
  normalizeFsPath,
  DEBUG_PORT,
  AUTO_PROVIDER_INFO,
  ensureAutoProviderAuth,
} from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = PROJECT_ROOT;
const WORKER = join(HERE, 'worker-agent.mjs');
const JOBS_DIR = join(ROOT, 'jobs');
const RUNS_DIR = join(ROOT, 'runs');
const SESSION_PATH = join(ROOT, 'main-session.json');
const PROVIDER_STAMP_PATH = join(ROOT, 'provider-stamp.json');
const LOG_PATH = join(ROOT, 'main-agent.log');

const port = Number(arg('port', process.env.AUTO_MAIN_PORT || '4332')) || 4332;
const debugPort =
  Number(arg('debug-port', process.env.TELEGRAM_DEBUG_PORT || String(DEBUG_PORT))) ||
  DEBUG_PORT;
const DEBUG_URL = `http://127.0.0.1:${debugPort}`;
const MAX_WORKERS = Math.max(1, Number(process.env.AUTO_MAX_WORKERS || 4) || 4);
const SKIP_PERMS = process.env.AUTO_SKIP_PERMS !== '0';

await ensureAutoProviderAuth();

if (AUTO_PROVIDER_INFO.warning) {
  console.error(`[provider] WARNING: ${AUTO_PROVIDER_INFO.warning}`);
}

const SYSTEM_PROMPT = `You are Auto's always-on front-desk agent for Simon (Telegram + Auto Web).
You keep this chat session open so you can reply instantly.

Role split:
- YOU = chat + status narrator. Stay available. Never do heavy coding, long shell jobs, or multi-file edits yourself.
- WORKERS = spawned by the bridge (worker-agent.mjs). They do the actual work and report status to you.

Rules:
1. When you see USER_MESSAGE: reply briefly only if the user needs an answer, clarification, or confirmation. Do NOT say "on it" / "starting worker" — the bridge already ack'd and started a worker.
2. When you see [WORKER_STATUS]: write a short plain-text user update (progress or final result). Under ~500 chars unless detail is needed.
3. If the user asks something while a worker is running, answer immediately from context.
4. Binding: every user ask is mandatory. Workers execute; you keep the user informed.
5. Prefer action updates over questions. No markdown fences unless essential.

Current repo: every USER_MESSAGE carries a \`folder:\` line — that is the
active session's folder and is what the worker is running in. It only
changes across turns if something calls debug-server's session API
(POST http://127.0.0.1:4331/api/session). If the user asks to switch
repos/projects, that persistence is the worker's job (it has Bash) — when
narrating a [WORKER_STATUS] for such a request, don't confirm the switch
to the user unless the worker's report shows it actually called that API,
not just that it \`cd\`-ed there.`;

/** @type {import('node:child_process').ChildProcess | null} */
let claude = null;
let sessionId = loadSessionId();
let claudeReady = false;
let startingClaude = false;
const pendingInjects = [];
const workers = new Map(); // workerId -> meta
let stdoutBuf = '';

// Worker display names — drawn from The Simpsons instead of "w-<messageId>".
const SIMPSONS_NAMES = [
  'Homer', 'Marge', 'Bart', 'Lisa', 'Maggie', 'Abe', 'Patty', 'Selma',
  'Ned', 'Maude', 'Rod', 'Todd', 'Milhouse', 'Kirk', 'Luann',
  'Nelson', 'Ralph', 'Wiggum', 'Moe', 'Barney', 'Lenny', 'Carl',
  'Krusty', 'Sideshow-Bob', 'Burns', 'Smithers', 'Otto', 'Skinner',
  'Edna', 'Apu', 'Manjula', 'Comic-Book-Guy', 'Kent-Brockman',
  'Troy-McClure', 'Lionel-Hutz', 'Fat-Tony', 'Snake', 'Duffman',
  'Disco-Stu', 'Cletus', 'Gil', 'Frink', 'Martin', 'Uter', 'Sherri',
  'Terri', 'Jimbo', 'Dolph', 'Kearney', 'Wolfcastle', 'Willie',
  'Moleman', 'Flanders', 'Quimby', 'Hibbert', 'Nick-Riviera',
];

/** Random unused Simpsons name for a new worker; disambiguated with -2, -3, … on collision. */
function generateWorkerId() {
  const active = new Set(workers.keys());
  const free = SIMPSONS_NAMES.filter((n) => !active.has(n));
  const pool = free.length ? free : SIMPSONS_NAMES;
  const base = pool[Math.floor(Math.random() * pool.length)];
  let id = base;
  let n = 2;
  while (workers.has(id)) {
    id = `${base}-${n++}`;
  }
  return id;
}

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(String).join(' ')}\n`;
  try {
    appendFileSync(LOG_PATH, line);
  } catch {
    /* ignore */
  }
  console.error(...args);
}

function loadSessionId() {
  try {
    if (existsSync(SESSION_PATH)) {
      const j = JSON.parse(readFileSync(SESSION_PATH, 'utf8'));
      if (j.sessionId) return String(j.sessionId);
    }
  } catch {
    /* ignore */
  }
  return randomUUID();
}

function saveSessionId(id) {
  sessionId = id;
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(
    SESSION_PATH,
    JSON.stringify({ sessionId: id, updatedAt: new Date().toISOString() }, null, 2) +
      '\n',
  );
}

async function postDebug(ev) {
  try {
    await fetch(`${DEBUG_URL}/api/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ev),
      signal: AbortSignal.timeout(2500),
    });
  } catch {
    /* ignore */
  }
}

/** Recent in/out turns for a session, so a freshly spawned worker isn't starting blind. */
async function fetchRecentContext(sessionId, excludeMessageId) {
  if (!sessionId) return '';
  try {
    const res = await fetch(
      `${DEBUG_URL}/api/events?session=${encodeURIComponent(sessionId)}`,
      { signal: AbortSignal.timeout(2500) },
    );
    if (!res.ok) return '';
    const events = await res.json();
    if (!Array.isArray(events)) return '';
    const turns = events
      .filter((ev) => (ev.dir === 'in' || ev.dir === 'out') && ev.text)
      .filter((ev) => String(ev.messageId || '') !== String(excludeMessageId || ''))
      .slice(-8)
      .map((ev) => `${ev.dir === 'in' ? 'User' : 'Assistant'}: ${String(ev.text).slice(0, 300)}`);
    return turns.join('\n');
  } catch {
    return '';
  }
}

async function replyUser(text, meta = {}) {
  const t = String(text || '').trim();
  if (!t) return;
  await postDebug({
    dir: 'out',
    text: t.slice(0, 4000),
    note: meta.note || 'main-agent',
    sessionId: meta.sessionId || null,
    messageId: meta.messageId || null,
    workerId: meta.workerId || null,
  });
  if (process.env.AUTO_REPLY_TELEGRAM === '0') return;
  try {
    const send = join(HERE, 'send.mjs');
    await new Promise((resolve) => {
      let err = '';
      const child = spawn(process.execPath, [send, `--text=${t.slice(0, 3500)}`, '--no-log'], {
        cwd: ROOT,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      child.stderr.on('data', (d) => {
        err += d.toString();
      });
      const onDone = (code) => {
        if (code) {
          const msg = `telegram send failed (code ${code}): ${err.trim().slice(0, 300)}`;
          log(`[main] ${msg}`);
          postDebug({
            dir: 'sys',
            note: 'auto: telegram send failed',
            text: msg,
            sessionId: meta.sessionId || null,
            messageId: meta.messageId || null,
          });
        }
        resolve();
      };
      child.on('close', onDone);
      child.on('error', (e) => {
        err = e.message;
        onDone(1);
      });
    });
  } catch {
    /* ignore */
  }
}

function publicAgents() {
  return {
    ok: true,
    main: {
      ready: claudeReady,
      sessionId,
      pid: claude?.pid || null,
    },
    provider: {
      name: AUTO_PROVIDER_INFO.provider,
      mode: AUTO_PROVIDER_INFO.mode,
      model: AUTO_PROVIDER_INFO.model,
      ready: AUTO_PROVIDER_INFO.ready,
    },
    workers: [...workers.values()],
    maxWorkers: MAX_WORKERS,
  };
}

function broadcastAgents() {
  postDebug({
    type: 'agents',
    silent: true,
    agents: publicAgents(),
  });
  try {
    fetch(`${DEBUG_URL}/api/processor`, {
      method: 'GET',
      signal: AbortSignal.timeout(500),
    }).catch(() => {});
  } catch {
    /* ignore */
  }
}

function extractAssistantText(msg) {
  const content = msg?.message?.content ?? msg?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && (b.type === 'text' || typeof b.text === 'string'))
    .map((b) => b.text || '')
    .join('')
    .trim();
}

function handleClaudeLine(line) {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return;
  }
  if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) {
    saveSessionId(ev.session_id);
    claudeReady = true;
    log(`[main] claude ready session=${sessionId}`);
    flushInjects();
    broadcastAgents();
  }
  if (ev.session_id && ev.session_id !== sessionId) {
    saveSessionId(ev.session_id);
  }
  if (ev.type === 'assistant') {
    const text = extractAssistantText(ev);
    if (text) {
      // Stream finals only on result; keep partials for log
      log(`[main] assistant partial: ${text.slice(0, 120)}`);
    }
  }
  if (ev.type === 'result') {
    const text =
      (typeof ev.result === 'string' && ev.result.trim()) ||
      extractAssistantText(ev) ||
      '';
    if (text) {
      log(`[main] result: ${text.slice(0, 160)}`);
      // Ignore warm-up handshake and bare "on it"-style filler — the bridge
      // already sent an instant ack, so this would just be noisy repetition.
      const isFiller = /^\s*(on it|starting( the)? worker|working on it|got it)[.…!]*\s*$/i.test(text);
      if (!/^\s*READY\s*$/i.test(text) && !isFiller) {
        replyUser(text, { note: 'main-agent' });
      }
    }
    claudeReady = true;
    flushInjects();
  }
  if (ev.type === 'control_request' && ev.request?.subtype === 'can_use_tool') {
    // Auto-allow tools for the front-desk session
    const resp = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: ev.request_id,
        response: { behavior: 'allow' },
      },
    };
    writeClaude(resp);
  }
}

function writeClaude(obj) {
  if (!claude?.stdin?.writable) {
    pendingInjects.push(obj);
    ensureClaude();
    return;
  }
  try {
    claude.stdin.write(JSON.stringify(obj) + '\n');
  } catch (e) {
    log(`[main] write failed: ${e.message}`);
    pendingInjects.push(obj);
    ensureClaude();
  }
}

function injectUserText(text) {
  writeClaude({
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    session_id: sessionId,
  });
}

function flushInjects() {
  if (!claude?.stdin?.writable) return;
  while (pendingInjects.length) {
    const obj = pendingInjects.shift();
    try {
      claude.stdin.write(JSON.stringify(obj) + '\n');
    } catch {
      pendingInjects.unshift(obj);
      break;
    }
  }
}

let resumeNext = true;
let restartDelayMs = 800;

/** If AUTO_PROVIDER/model changed since last run, mint a fresh Claude session. */
function rotateSessionIfProviderChanged() {
  const stamp = {
    provider: AUTO_PROVIDER_INFO.provider,
    mode: AUTO_PROVIDER_INFO.mode,
    model: AUTO_PROVIDER_INFO.model,
  };
  let prev = null;
  try {
    if (existsSync(PROVIDER_STAMP_PATH)) {
      prev = JSON.parse(readFileSync(PROVIDER_STAMP_PATH, 'utf8'));
    }
  } catch {
    prev = null;
  }
  const changed =
    prev &&
    (prev.provider !== stamp.provider ||
      prev.mode !== stamp.mode ||
      prev.model !== stamp.model);
  if (changed) {
    resumeNext = false;
    saveSessionId(randomUUID());
    log(
      `[main] provider changed ${prev.provider}/${prev.model} → ${stamp.provider}/${stamp.model}; new session=${sessionId}`,
    );
  }
  try {
    writeFileSync(PROVIDER_STAMP_PATH, JSON.stringify(stamp, null, 2) + '\n');
  } catch {
    /* ignore */
  }
}

function ensureClaude() {
  if (claude && !claude.killed) return;
  if (startingClaude) return;
  startingClaude = true;
  claudeReady = false;
  rotateSessionIfProviderChanged();

  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--name',
    'auto-main',
    '--system-prompt',
    SYSTEM_PROMPT,
    '--add-dir',
    ROOT,
  ];
  // Prefer resume of the warm session; fall back to a fresh --session-id
  if (resumeNext && sessionId) {
    args.push('--resume', sessionId);
  } else {
    if (!sessionId) saveSessionId(randomUUID());
    args.push('--session-id', sessionId);
  }
  if (SKIP_PERMS) args.push('--dangerously-skip-permissions');

  log(
    `[main] starting claude ${resumeNext ? 'resume' : 'new'}=${sessionId} provider=${AUTO_PROVIDER_INFO.provider}${AUTO_PROVIDER_INFO.model ? ` model=${AUTO_PROVIDER_INFO.model}` : ''}`,
  );
  let errText = '';
  claude = spawn('claude', args, {
    cwd: ROOT,
    shell: true,
    windowsHide: true,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  startingClaude = false;

  claude.stdout.on('data', (buf) => {
    stdoutBuf += buf.toString();
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (line) handleClaudeLine(line);
    }
  });
  claude.stderr.on('data', (d) => {
    const s = d.toString();
    errText += s;
    const t = s.trim();
    if (t) log(`[claude:err] ${t.slice(0, 400)}`);
  });
  claude.on('exit', (code) => {
    log(`[main] claude exited code=${code}`);
    claude = null;
    claudeReady = false;
    broadcastAgents();
    if (/already in use/i.test(errText) || /not found/i.test(errText)) {
      // Stale lock or missing resume target → mint a fresh session id
      resumeNext = false;
      saveSessionId(randomUUID());
      restartDelayMs = Math.min(5000, restartDelayMs + 400);
      log(`[main] rotating session → ${sessionId}`);
    } else {
      resumeNext = true;
      restartDelayMs = 800;
    }
    setTimeout(() => ensureClaude(), restartDelayMs);
  });
  claude.on('error', (e) => {
    log(`[main] claude spawn error: ${e.message}`);
    claude = null;
    claudeReady = false;
    startingClaude = false;
    setTimeout(() => ensureClaude(), 1500);
  });

  // Bootstrap so the process stays warm
  setTimeout(() => {
    injectUserText(
      'SYSTEM: Front-desk session online. Reply with exactly: READY',
    );
  }, 400);
}

function activeWorkerCount() {
  let n = 0;
  for (const w of workers.values()) {
    if (w.phase !== 'done' && w.phase !== 'error') n++;
  }
  return n;
}

function spawnWorker(job) {
  mkdirSync(JOBS_DIR, { recursive: true });
  const workerId = generateWorkerId();
  const jobFile = join(JOBS_DIR, `${workerId}.json`);
  const payload = { ...job, workerId };
  writeFileSync(jobFile, JSON.stringify(payload, null, 2) + '\n');

  const meta = {
    workerId,
    messageId: job.messageId,
    sessionId: job.sessionId || null,
    text: String(job.text || '').slice(0, 160),
    phase: 'starting',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    pid: null,
  };
  workers.set(workerId, meta);
  broadcastAgents();

  const child = spawn(process.execPath, [WORKER, `--file=${jobFile}`], {
    cwd: ROOT,
    windowsHide: true,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      AUTO_CWD: job.folder || ROOT,
      AUTO_MAIN_URL: `http://127.0.0.1:${port}`,
      TELEGRAM_DEBUG_PORT: String(debugPort),
      AUTO_REPLY_TELEGRAM: '0', // main narrates; worker should not double-text
      PATH: process.env.PATH,
    },
  });
  child.unref();
  meta.pid = child.pid;
  meta.phase = 'running';
  meta.updatedAt = new Date().toISOString();
  workers.set(workerId, meta);
  broadcastAgents();

  postDebug({
    dir: 'sys',
    note: `auto: worker ${workerId} started`,
    text: meta.text,
    sessionId: job.sessionId,
    workerId,
  });

  return meta;
}

async function handleJob(job) {
  const text = String(job.text || '').trim() || '[photo]';
  const messageId = String(job.messageId || `job-${Date.now()}`);
  const folder =
    normalizeFsPath(job.folder || process.env.AUTO_CWD || ROOT) || ROOT;

  // Instant ack — do not wait for Claude or for context lookup
  const preview = text.length > 120 ? `${text.slice(0, 117)}…` : text;
  await replyUser(`On it — spinning up a worker for: ${preview}`, {
    note: 'main-ack',
    sessionId: job.sessionId,
    messageId,
  });

  const context = await fetchRecentContext(job.sessionId, messageId);
  const fullJob = {
    ...job,
    text,
    messageId,
    folder,
    context,
  };

  if (activeWorkerCount() >= MAX_WORKERS) {
    await replyUser(
      `All ${MAX_WORKERS} workers busy — queued behind current jobs. I'll update you when a worker picks this up.`,
      { note: 'main-queue', sessionId: job.sessionId, messageId },
    );
  }

  // Wait for a free slot (simple queue)
  while (activeWorkerCount() >= MAX_WORKERS) {
    await new Promise((r) => setTimeout(r, 1000));
  }

  const worker = spawnWorker(fullJob);

  ensureClaude();
  injectUserText(
    [
      'USER_MESSAGE',
      `messageId: ${messageId}`,
      `workerId: ${worker.workerId}`,
      `source: ${job.source || 'unknown'}`,
      `folder: ${folder}`,
      '',
      text,
      Array.isArray(job.images) && job.images.length
        ? `\nImages:\n${job.images
            .map((i) => `- ${i.localPath || i}`)
            .join('\n')}`
        : '',
      '',
      'A worker was just started for this. Stay ready for [WORKER_STATUS] and for follow-up questions.',
    ]
      .filter(Boolean)
      .join('\n'),
  );

  return { ok: true, workerId: worker.workerId, messageId, sessionId };
}

async function handleWorkerStatus(body) {
  const workerId = String(body.workerId || body.messageId || 'unknown');
  const phase = String(body.phase || 'progress');
  const text = String(body.text || body.summary || '').trim();
  const prev = workers.get(workerId) || {
    workerId,
    messageId: body.messageId,
    startedAt: new Date().toISOString(),
  };
  const meta = {
    ...prev,
    phase,
    text: text.slice(0, 300) || prev.text,
    updatedAt: new Date().toISOString(),
    code: body.code ?? prev.code,
    sessionId: body.sessionId || prev.sessionId,
  };
  workers.set(workerId, meta);
  if (workers.size > 40) {
    for (const [id, w] of workers) {
      if (w.phase === 'done' || w.phase === 'error') {
        workers.delete(id);
        if (workers.size <= 30) break;
      }
    }
  }
  broadcastAgents();

  await postDebug({
    dir: 'sys',
    note: `auto: worker ${phase}`,
    text: text.slice(0, 400) || workerId,
    sessionId: meta.sessionId,
    workerId,
  });

  // "started" is redundant with the instant "On it — spinning up a worker" ack
  // (main-ack in handleJob) — narrating it too is what produced back-to-back
  // "On it…" replies. Only surface phases that actually tell the user something new.
  if (phase !== 'started') {
    ensureClaude();
    injectUserText(
      [
        `[WORKER_STATUS]`,
        `workerId: ${workerId}`,
        `phase: ${phase}`,
        body.code != null ? `code: ${body.code}` : null,
        '',
        text || '(no details)',
        '',
        'Update the user now with a short plain-text status.',
      ]
        .filter((x) => x != null)
        .join('\n'),
    );
  }

  // Fallback: if Claude is down, still tell the user on done/error
  if (!claudeReady && (phase === 'done' || phase === 'error') && text) {
    await replyUser(text.slice(0, 3500), {
      note: 'worker-fallback',
      sessionId: meta.sessionId,
      workerId,
    });
  }

  return { ok: true };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

mkdirSync(RUNS_DIR, { recursive: true });
mkdirSync(JOBS_DIR, { recursive: true });
ensureClaude();

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }
  if (url.pathname === '/health') {
    sendJson(res, 200, {
      ok: true,
      ...publicAgents(),
    });
    return;
  }
  if (url.pathname === '/agents') {
    sendJson(res, 200, publicAgents());
    return;
  }
  if (url.pathname === '/job' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const result = await handleJob(body);
      sendJson(res, 200, result);
    } catch (e) {
      sendJson(res, 500, { ok: false, error: String(e?.message || e) });
    }
    return;
  }
  if (url.pathname === '/worker-status' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const result = await handleWorkerStatus(body);
      sendJson(res, 200, result);
    } catch (e) {
      sendJson(res, 500, { ok: false, error: String(e?.message || e) });
    }
    return;
  }
  sendJson(res, 404, { ok: false, error: 'not found' });
});

server.listen(port, '127.0.0.1', () => {
  log(`[main] listening http://127.0.0.1:${port}/ (debug ${debugPort})`);
  console.log(`Main agent: http://127.0.0.1:${port}/`);
});
