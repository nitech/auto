#!/usr/bin/env node
/**
 * Telegram + agent debug console (multi-session).
 *
 *   node debug-server.mjs --host=0.0.0.0 --port=4331
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  arg,
  loadAuth,
  api,
  loadOffset,
  saveOffset,
  normalizeMessage,
  downloadFile,
  SKILL_ROOT,
  EVENTS_PATH,
  QUEUE_PATH,
  DEBUG_PORT,
  normalizeFsPath,
  AUTO_PROVIDER_INFO,
  ensureAutoProviderAuth,
} from './lib.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MAIN_AGENT = join(SCRIPT_DIR, 'main-agent.mjs');
const JOBS_DIR = join(SKILL_ROOT, 'jobs');
const AUTO_PROCESS = process.env.AUTO_PROCESS !== '0';
const MAIN_PORT = Number(process.env.AUTO_MAIN_PORT || 4332) || 4332;
const MAIN_URL = `http://127.0.0.1:${MAIN_PORT}`;

await ensureAutoProviderAuth();

if (AUTO_PROVIDER_INFO.warning) {
  console.error(`[provider] WARNING: ${AUTO_PROVIDER_INFO.warning}`);
} else {
  console.log(
    `[provider] ${AUTO_PROVIDER_INFO.provider}` +
      (AUTO_PROVIDER_INFO.mode ? `/${AUTO_PROVIDER_INFO.mode}` : '') +
      (AUTO_PROVIDER_INFO.model ? ` model=${AUTO_PROVIDER_INFO.model}` : '') +
      (AUTO_PROVIDER_INFO.auth ? ` auth=${AUTO_PROVIDER_INFO.auth}` : ''),
  );
}

const STATE_PATH = join(SKILL_ROOT, 'session-state.json');
const host = arg('host', '0.0.0.0');
const port = Number(arg('port', String(DEBUG_PORT))) || DEBUG_PORT;
const { token, chatId } = loadAuth();
if (!token) {
  console.error('Missing auth.json — cannot start debug server');
  process.exit(2);
}

const allowedChat = chatId != null ? Number(chatId) : null;
const sseClients = new Set();
/** @deprecated drain queue — messages are auto-processed; kept empty */
let queue = [];
let state = loadState();
const processedIds = new Set();
/** @type {import('node:child_process').ChildProcess | null} */
let mainAgentProc = null;
let agentsSnapshot = {
  main: { ready: false, sessionId: null, pid: null },
  workers: [],
  maxWorkers: 4,
};
let processorStatus = {
  enabled: AUTO_PROCESS,
  busy: false,
  pending: 0,
  mode: 'main+workers',
  lastMessageId: null,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastCode: null,
  mainReady: false,
};

function loadQueue() {
  if (!existsSync(QUEUE_PATH)) return [];
  try {
    return JSON.parse(readFileSync(QUEUE_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function saveQueue() {
  // Keep file empty — we no longer accumulate a drain backlog
  writeFileSync(QUEUE_PATH, '[]\n');
}

function broadcastProcessor() {
  const activeWorkers = (agentsSnapshot.workers || []).filter(
    (w) => w.phase !== 'done' && w.phase !== 'error',
  ).length;
  processorStatus.pending = activeWorkers;
  processorStatus.busy = activeWorkers > 0;
  processorStatus.mainReady = Boolean(agentsSnapshot.main?.ready);
  broadcast({
    type: 'processor',
    silent: true,
    processor: { ...processorStatus, agents: agentsSnapshot },
    agents: agentsSnapshot,
  });
}

async function mainAgentUp() {
  try {
    const res = await fetch(`${MAIN_URL}/health`, {
      signal: AbortSignal.timeout(800),
    });
    if (!res.ok) return false;
    const data = await res.json();
    agentsSnapshot = {
      main: data.main || data,
      workers: data.workers || [],
      maxWorkers: data.maxWorkers || 4,
    };
    broadcastProcessor();
    return true;
  } catch {
    return false;
  }
}

function ensureMainAgent() {
  if (!AUTO_PROCESS) return;
  if (mainAgentProc && !mainAgentProc.killed) return;
  console.log(`Starting main agent on :${MAIN_PORT}…`);
  // AUTO_REPLY_TELEGRAM=0 is set by main-agent.mjs for the *worker* children
  // it spawns (so the worker doesn't double-text while main narrates). If
  // debug-server itself is ever started from a shell/process that inherited
  // that flag (e.g. a worker restarting the service per the repo's
  // test/commit/restart workflow), blindly spreading process.env would carry
  // it into main-agent and silently disable all Telegram replies. Strip it so
  // main-agent always defaults to sending unless explicitly configured here.
  const mainAgentEnv = { ...process.env };
  delete mainAgentEnv.AUTO_REPLY_TELEGRAM;
  mainAgentProc = spawn(
    process.execPath,
    [
      MAIN_AGENT,
      `--port=${MAIN_PORT}`,
      `--debug-port=${port}`,
    ],
    {
      cwd: SKILL_ROOT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...mainAgentEnv,
        TELEGRAM_DEBUG_PORT: String(port),
        AUTO_MAIN_PORT: String(MAIN_PORT),
        PATH: process.env.PATH,
      },
    },
  );
  mainAgentProc.stdout.on('data', (d) => {
    const s = d.toString().trim();
    if (s) console.log(`[main] ${s}`);
  });
  mainAgentProc.stderr.on('data', (d) => {
    const s = d.toString().trim();
    if (s) console.error(`[main] ${s}`);
  });
  mainAgentProc.on('exit', (code) => {
    console.error(`[main] exited code=${code} — restarting in 1s`);
    mainAgentProc = null;
    agentsSnapshot.main = { ready: false, sessionId: null, pid: null };
    broadcastProcessor();
    setTimeout(() => ensureMainAgent(), 1000);
  });
  mainAgentProc.on('error', (e) => {
    console.error(`[main] spawn error: ${e.message}`);
    mainAgentProc = null;
  });
  // Poll until healthy
  let tries = 0;
  const t = setInterval(async () => {
    tries++;
    if (await mainAgentUp() || tries > 30) clearInterval(t);
  }, 500);
}

/** Hand job to always-on main agent → instant ack + worker subagent. */
function acceptInstruction(msg) {
  const text = String(msg.text || msg.caption || '').trim();
  const hasMedia = Boolean(msg.hasPhoto || msg.localPath || (msg.images && msg.images.length));
  if (!text && !hasMedia) return;

  const messageId = String(msg.messageId || `job-${Date.now()}`);
  if (processedIds.has(messageId)) {
    logEvent({
      dir: 'sys',
      sessionId: msg.sessionId || state.activeId,
      note: 'auto: skipped duplicate',
      text: text.slice(0, 120) || messageId,
    });
    return;
  }
  processedIds.add(messageId);
  if (processedIds.size > 2000) {
    const drop = [...processedIds].slice(0, 500);
    for (const id of drop) processedIds.delete(id);
  }

  if (!AUTO_PROCESS) {
    logEvent({
      dir: 'sys',
      sessionId: msg.sessionId || state.activeId,
      note: 'AUTO_PROCESS=0 — instruction not executed',
      text: text.slice(0, 120),
    });
    return;
  }

  const folder = normalizeFsPath(
    getSession(msg.sessionId || state.activeId)?.folder ||
      state.folder ||
      SKILL_ROOT,
  );
  const job = {
    text: text || '[photo]',
    from: msg.from || null,
    messageId,
    sessionId: msg.sessionId || state.activeId,
    folder: folder || SKILL_ROOT,
    images: (msg.images ||
      (msg.localPath
        ? [{ localPath: msg.localPath, previewUrl: msg.previewUrl }]
        : [])
    ).map((img) =>
      typeof img === 'string'
        ? normalizeFsPath(img)
        : {
            ...img,
            localPath: normalizeFsPath(img.localPath),
          },
    ),
    source: msg.source || 'telegram',
  };

  processorStatus.lastMessageId = messageId;
  processorStatus.lastStartedAt = new Date().toISOString();
  logEvent({
    dir: 'sys',
    sessionId: job.sessionId,
    note: 'auto: handed to main agent → worker',
    text: job.text.slice(0, 160),
  });
  broadcastProcessor();
  ensureMainAgent();

  (async () => {
    for (let i = 0; i < 20; i++) {
      if (await mainAgentUp()) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    try {
      const res = await fetch(`${MAIN_URL}/job`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(job),
        signal: AbortSignal.timeout(30_000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `main HTTP ${res.status}`);
      logEvent({
        dir: 'sys',
        sessionId: job.sessionId,
        note: `auto: worker ${data.workerId || '?'} dispatched`,
        text: job.text.slice(0, 120),
      });
      await mainAgentUp();
    } catch (e) {
      logEvent({
        dir: 'sys',
        sessionId: job.sessionId,
        note: `auto: main-agent error — ${e.message}`,
        text: job.text.slice(0, 120),
      });
      processorStatus.lastCode = 1;
      processorStatus.lastFinishedAt = new Date().toISOString();
      broadcastProcessor();
    }
  })();
}

function emptyTokens() {
  return { input: 0, output: 0, total: 0, estimated: false };
}

function slugId(folder) {
  const base = basename(String(folder || 'default').replace(/[\\/]+$/, '')) || 'default';
  return base.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 48) || 'default';
}

function makeSession(partial = {}) {
  const folder = normalizeFsPath(partial.folder || null);
  const id = partial.id || (folder ? slugId(folder) : 'default');
  const now = new Date().toISOString();
  const workspaces = (
    Array.isArray(partial.workspaces) ? partial.workspaces : folder ? [folder] : []
  ).map((w) => normalizeFsPath(w));
  return {
    id,
    label: partial.label || partial.project || (folder ? basename(folder) : id),
    project: partial.project || (folder ? basename(String(folder).replace(/[\\/]+$/, '')) : null),
    folder,
    workspaces,
    tokens: { ...emptyTokens(), ...(partial.tokens || {}) },
    createdAt: partial.createdAt || now,
    updatedAt: partial.updatedAt || now,
    eventCount: Number(partial.eventCount || 0) || 0,
  };
}

function defaultState() {
  const s = makeSession({
    id: 'auto',
    label: 'auto',
    project: 'auto',
    folder: SKILL_ROOT,
    workspaces: [SKILL_ROOT],
  });
  return {
    activeId: s.id,
    sessions: { [s.id]: s },
    // legacy top-level mirrors of active session (compat)
    project: s.project,
    folder: s.folder,
    workspaces: s.workspaces,
    tokens: s.tokens,
    updatedAt: s.updatedAt,
  };
}

function migrateState(raw) {
  if (raw && raw.sessions && typeof raw.sessions === 'object') {
    const sessions = {};
    for (const [id, s] of Object.entries(raw.sessions)) {
      sessions[id] = makeSession({ ...s, id });
    }
    if (!Object.keys(sessions).length) return defaultState();
    const activeId =
      raw.activeId && sessions[raw.activeId]
        ? raw.activeId
        : Object.keys(sessions)[0];
    const active = sessions[activeId];
    return {
      activeId,
      sessions,
      project: active.project,
      folder: active.folder,
      workspaces: active.workspaces,
      tokens: active.tokens,
      updatedAt: raw.updatedAt || active.updatedAt,
    };
  }
  // legacy flat state → one session
  const s = makeSession({
    id: slugId(raw?.folder || raw?.project || 'legacy'),
    project: raw?.project,
    folder: raw?.folder,
    workspaces: raw?.workspaces,
    tokens: raw?.tokens,
  });
  return {
    activeId: s.id,
    sessions: { [s.id]: s },
    project: s.project,
    folder: s.folder,
    workspaces: s.workspaces,
    tokens: s.tokens,
    updatedAt: raw?.updatedAt || s.updatedAt,
  };
}

function loadState() {
  if (!existsSync(STATE_PATH)) return defaultState();
  try {
    return migrateState(JSON.parse(readFileSync(STATE_PATH, 'utf8')));
  } catch {
    return defaultState();
  }
}

function syncLegacyMirrors() {
  const active = state.sessions[state.activeId];
  if (!active) return;
  state.project = active.project;
  state.folder = active.folder;
  state.workspaces = active.workspaces;
  state.tokens = active.tokens;
}

function saveState() {
  state.updatedAt = new Date().toISOString();
  syncLegacyMirrors();
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
  broadcast({ type: 'state', silent: true, state: publicState() });
}

function publicState() {
  syncLegacyMirrors();
  const list = Object.values(state.sessions).sort((a, b) =>
    String(b.updatedAt).localeCompare(String(a.updatedAt)),
  );
  const totals = list.reduce(
    (acc, s) => {
      acc.input += s.tokens?.input || 0;
      acc.output += s.tokens?.output || 0;
      acc.total += s.tokens?.total || 0;
      if (s.tokens?.estimated) acc.estimated = true;
      return acc;
    },
    { input: 0, output: 0, total: 0, estimated: false },
  );
  return {
    ...state,
    sessionList: list,
    totals,
    active: state.sessions[state.activeId] || null,
  };
}

function getSession(id) {
  return state.sessions[id] || null;
}

function ensureSession(patch = {}) {
  const folder = normalizeFsPath(patch.folder || patch.cwd || null);
  const id = patch.id || (folder ? slugId(folder) : state.activeId || 'default');
  let s = state.sessions[id];
  if (!s) {
    s = makeSession({ ...patch, id, folder: folder || patch.folder });
    state.sessions[id] = s;
  } else {
    if (folder) s.folder = folder;
    if (patch.project) s.project = patch.project;
    else if (folder) s.project = basename(String(folder).replace(/[\\/]+$/, ''));
    if (patch.label) s.label = patch.label;
    else if (s.project) s.label = s.project;
    if (Array.isArray(patch.workspaces)) s.workspaces = patch.workspaces;
    s.updatedAt = new Date().toISOString();
  }
  if (patch.setActive !== false && (folder || patch.id || patch.setActive)) {
    state.activeId = id;
  }
  saveState();
  return s;
}

function setActiveSession(id) {
  if (!state.sessions[id]) throw new Error(`unknown session ${id}`);
  state.activeId = id;
  saveState();
}

function createSession(patch = {}) {
  const id = patch.id || `session-${Date.now().toString(36)}`;
  if (state.sessions[id]) throw new Error(`session ${id} already exists`);
  const s = makeSession({ ...patch, id, label: patch.label || 'New session' });
  state.sessions[id] = s;
  state.activeId = id;
  saveState();
  return s;
}

function closeSession(id) {
  if (!state.sessions[id]) throw new Error(`unknown session ${id}`);
  const remaining = Object.keys(state.sessions).filter((x) => x !== id);
  if (!remaining.length) throw new Error('cannot close the only session');
  delete state.sessions[id];
  if (state.activeId === id) {
    const next = remaining
      .map((x) => state.sessions[x])
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
    state.activeId = next.id;
  }
  saveState();
}

function applyTokens(delta = {}, sessionId) {
  const id = sessionId || delta.sessionId || state.activeId;
  const s = state.sessions[id] || ensureSession({ id, setActive: false });
  const t = { ...emptyTokens(), ...(s.tokens || {}) };
  if (delta.reset) {
    s.tokens = emptyTokens();
  } else {
    t.input += Number(delta.input || 0) || 0;
    t.output += Number(delta.output || 0) || 0;
    if (delta.total != null) t.total += Number(delta.total) || 0;
    else t.total = t.input + t.output;
    if (delta.estimated) t.estimated = true;
    if (delta.estimated === false) t.estimated = false;
    s.tokens = t;
  }
  s.updatedAt = new Date().toISOString();
  saveState();
}

function isSilentEvent(ev) {
  if (!ev || typeof ev !== 'object') return true;
  if (ev.silent || ev.type === 'state') return true;
  if (ev.dir === 'sys' && ev.state && !ev.text && !ev.note && !ev.tool) return true;
  const note = String(ev.note || ev.event || '');
  if (
    ev.dir === 'agent' &&
    !ev.tool &&
    !ev.path &&
    !ev.command &&
    /^(sessionStart|stop|afterAgentResponse|afterAgentThought)$/i.test(note)
  ) {
    if (/^afterAgentResponse$/i.test(note)) {
      const t = String(ev.text || '').trim();
      if (t && t !== note && t.length > 40) return false;
    }
    return true;
  }
  return false;
}

function readEvents(limit = 800, sessionId = null, workerId = null) {
  if (!existsSync(EVENTS_PATH)) return [];
  const lines = readFileSync(EVENTS_PATH, 'utf8').split(/\r?\n/).filter(Boolean);
  return lines
    .slice(-limit)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { type: 'raw', text: l };
      }
    })
    .filter((ev) => !isSilentEvent(ev))
    .filter((ev) => {
      // Worker detail view: everything tagged with this workerId, regardless
      // of which session it belongs to.
      if (workerId) return String(ev.workerId || '') === String(workerId);
      if (!sessionId) return true;
      // legacy events without sessionId → show on active only when requested
      if (!ev.sessionId) return sessionId === state.activeId;
      return ev.sessionId === sessionId;
    });
}

function logEvent(event) {
  mkdirSync(SKILL_ROOT, { recursive: true });
  const sessionId = event.sessionId || state.activeId;
  if (!state.sessions[sessionId]) {
    ensureSession({ id: sessionId, setActive: false });
  }
  const row = { ts: new Date().toISOString(), sessionId, ...event };
  delete row._persisted;
  if (state.sessions[sessionId]) {
    state.sessions[sessionId].eventCount =
      (state.sessions[sessionId].eventCount || 0) + 1;
    state.sessions[sessionId].updatedAt = row.ts;
    // don't broadcast full state on every event — light touch
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
  }
  appendFileSync(EVENTS_PATH, JSON.stringify(row) + '\n');
  broadcast(row);
  return row;
}

function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(data);
    } catch {
      sseClients.delete(res);
    }
  }
}

// Heartbeat: keeps SSE connections alive through proxies/NAT timeouts and
// gives the client a liveness signal — the UI watchdog force-reconnects if
// nothing (event or ping) has arrived for a while. Marked `silent` so the
// UI never renders it.
setInterval(() => {
  broadcast({ type: 'ping', silent: true, ts: Date.now() });
}, 25000).unref();

// The Auto Web UI page lives in auto-web.html (same dir). It used to be
// inlined here as a template literal, which ate every backslash escape
// in the inline script's regexes and killed the page JS at parse time
// (stuck on CONNECTING). Keep it as a real file: escapes stay intact.
const HTML = readFileSync(new URL('./auto-web.html', import.meta.url), 'utf8');

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    // no-store: iOS Safari caches the UI aggressively and offers no hard
    // refresh — without this, client fixes never reach already-open devices.
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(HTML);
    return;
  }

  if (url.pathname === '/api/health') {
    const activeWorkers = (agentsSnapshot.workers || []).filter(
      (w) => w.phase !== 'done' && w.phase !== 'error',
    ).length;
    sendJson(res, 200, {
      ok: true,
      port,
      mainPort: MAIN_PORT,
      queue: 0,
      autoProcess: AUTO_PROCESS,
      provider: {
        name: AUTO_PROVIDER_INFO.provider,
        mode: AUTO_PROVIDER_INFO.mode,
        model: AUTO_PROVIDER_INFO.model,
        ready: AUTO_PROVIDER_INFO.ready,
      },
      processor: {
        ...processorStatus,
        pending: activeWorkers,
        busy: activeWorkers > 0,
        mainReady: Boolean(agentsSnapshot.main?.ready),
      },
      agents: agentsSnapshot,
      state: publicState(),
    });
    return;
  }

  if (url.pathname === '/api/processor' || url.pathname === '/api/agents') {
    const activeWorkers = (agentsSnapshot.workers || []).filter(
      (w) => w.phase !== 'done' && w.phase !== 'error',
    ).length;
    sendJson(res, 200, {
      ok: true,
      enabled: AUTO_PROCESS,
      ...processorStatus,
      pending: activeWorkers,
      busy: activeWorkers > 0,
      mainReady: Boolean(agentsSnapshot.main?.ready),
      agents: agentsSnapshot,
      mainUrl: MAIN_URL,
    });
    return;
  }

  if (url.pathname === '/api/session') {
    if (req.method === 'GET') {
      sendJson(res, 200, publicState());
      return;
    }
    if (req.method === 'POST') {
      try {
        const body = await readBody(req);
        ensureSession(body);
        sendJson(res, 200, { ok: true, state: publicState() });
      } catch (e) {
        sendJson(res, 400, { ok: false, error: String(e) });
      }
      return;
    }
  }

  if (url.pathname === '/api/session/active' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      setActiveSession(body.id);
      sendJson(res, 200, { ok: true, state: publicState() });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: String(e) });
    }
    return;
  }

  if (url.pathname === '/api/session/new' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const s = createSession(body);
      sendJson(res, 200, { ok: true, session: s, state: publicState() });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: String(e) });
    }
    return;
  }

  if (url.pathname === '/api/session/close' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      closeSession(body.id);
      sendJson(res, 200, { ok: true, state: publicState() });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: String(e) });
    }
    return;
  }

  if (url.pathname === '/api/tokens' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      applyTokens(body, body.sessionId);
      sendJson(res, 200, {
        ok: true,
        tokens: getSession(body.sessionId || state.activeId)?.tokens,
        state: publicState(),
      });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: String(e) });
    }
    return;
  }

  if (url.pathname === '/api/events') {
    const sid = url.searchParams.get('session');
    const wid = url.searchParams.get('worker');
    sendJson(res, 200, readEvents(800, sid || null, wid || null));
    return;
  }

  if (url.pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(': ok\n\n');
    res.write(
      `data: ${JSON.stringify({ type: 'state', silent: true, state: publicState() })}\n\n`,
    );
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (url.pathname === '/api/drain' && req.method === 'GET') {
    // No backlog — instructions are auto-processed on arrival
    queue = [];
    saveQueue();
    sendJson(res, 200, {
      count: 0,
      messages: [],
      autoProcess: AUTO_PROCESS,
      note: 'Messages are executed immediately by auto processor; drain is always empty.',
    });
    return;
  }

  // Chat from the debug UI → log + auto-process (no drain queue)
  if (url.pathname === '/api/chat' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const text = String(body.text || '').trim();
      const images = Array.isArray(body.images) ? body.images : [];
      if (!text && !images.length) {
        sendJson(res, 400, { ok: false, error: 'empty' });
        return;
      }
      const sessionId = body.sessionId || state.activeId;
      if (body.sessionId) {
        try {
          setActiveSession(body.sessionId);
        } catch {
          /* keep current */
        }
      }

      const saved = [];
      mkdirSync(join(SKILL_ROOT, 'inbox'), { recursive: true });
      for (let i = 0; i < images.length && i < 6; i++) {
        const img = images[i] || {};
        const dataUrl = String(img.dataUrl || '');
        const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl);
        if (!m) continue;
        const mime = m[1];
        const ext = mime.includes('png')
          ? 'png'
          : mime.includes('webp')
            ? 'webp'
            : mime.includes('gif')
              ? 'gif'
              : 'jpg';
        const messageId = `ui-${Date.now()}-${i}`;
        const dest = join(SKILL_ROOT, 'inbox', `${messageId}.${ext}`);
        writeFileSync(dest, Buffer.from(m[2], 'base64'));
        saved.push({
          messageId,
          previewUrl: `/inbox/${messageId}.${ext}`,
          localPath: dest,
        });
      }

      const primary = saved[0] || null;
      const messageId = primary?.messageId || `ui-${Date.now()}`;
      const ev = logEvent({
        dir: 'in',
        sessionId,
        from: 'ui',
        text: text || (saved.length ? '[photo]' : ''),
        hasPhoto: saved.length > 0,
        messageId,
        source: 'debug-ui',
        previewUrl: primary?.previewUrl || null,
        localPath: primary?.localPath || null,
        images: saved.map((s) => s.previewUrl),
      });
      // Extra images as follow-up log rows
      for (let i = 1; i < saved.length; i++) {
        logEvent({
          dir: 'in',
          sessionId,
          from: 'ui',
          text: '',
          hasPhoto: true,
          messageId: saved[i].messageId,
          source: 'debug-ui',
          previewUrl: saved[i].previewUrl,
          localPath: saved[i].localPath,
        });
      }
      acceptInstruction({
        text: text || (saved.length ? '[photo]' : ''),
        from: 'ui',
        hasPhoto: saved.length > 0,
        messageId,
        sessionId,
        source: 'debug-ui',
        previewUrl: primary?.previewUrl || null,
        localPath: primary?.localPath || null,
        images: saved.map((s) => ({
          previewUrl: s.previewUrl,
          localPath: s.localPath,
        })),
      });
      sendJson(res, 200, {
        ok: true,
        messageId,
        images: saved.length,
        processed: AUTO_PROCESS,
      });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: String(e) });
    }
    return;
  }

  if (url.pathname === '/api/event' && req.method === 'POST') {
    try {
      const ev = await readBody(req);
      if (ev.type === 'agents' || ev.agents) {
        agentsSnapshot = ev.agents || agentsSnapshot;
        broadcastProcessor();
        sendJson(res, 200, { ok: true, silent: true });
        return;
      }
      let session = null;
      if (ev.cwd || ev.folder || ev.workspaces || ev.project || ev.sessionId) {
        session = ensureSession({
          id: ev.sessionId,
          folder: ev.folder || ev.cwd,
          project: ev.project,
          workspaces: ev.workspaces,
          setActive: Boolean(ev.cwd || ev.folder),
        });
        ev.sessionId = session.id;
      } else {
        ev.sessionId = ev.sessionId || state.activeId;
      }
      if (ev.tokenDelta) {
        applyTokens(ev.tokenDelta, ev.sessionId);
        delete ev.tokenDelta;
      }
      if (
        !ev.tool &&
        !ev.path &&
        !ev.command &&
        !ev.text &&
        !ev.note &&
        !ev.hasPhoto &&
        (ev.cwd || ev.folder || ev.workspaces || ev.project)
      ) {
        sendJson(res, 200, { ok: true, silent: true });
        return;
      }
      if (isSilentEvent(ev)) {
        sendJson(res, 200, { ok: true, silent: true });
        return;
      }
      if (ev._persisted) {
        const { _persisted, ...rest } = ev;
        if (!rest.sessionId) rest.sessionId = state.activeId;
        broadcast(rest);
      } else {
        logEvent(ev);
      }
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: String(e) });
    }
    return;
  }

  if (url.pathname.startsWith('/inbox/')) {
    const name = decodeURIComponent(url.pathname.slice('/inbox/'.length));
    const path = join(SKILL_ROOT, 'inbox', name);
    if (!existsSync(path) || name.includes('..')) {
      res.writeHead(404);
      res.end('missing');
      return;
    }
    const buf = readFileSync(path);
    const lower = name.toLowerCase();
    const type = lower.endsWith('.png')
      ? 'image/png'
      : lower.endsWith('.webp')
        ? 'image/webp'
        : lower.endsWith('.gif')
          ? 'image/gif'
          : 'image/jpeg';
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
    });
    res.end(buf);
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

async function pollLoop() {
  logEvent({
    dir: 'sys',
    sessionId: state.activeId,
    note: `Debug server listening — sessions + chat layout (chat ${allowedChat ?? 'any'})`,
  });
  while (true) {
    try {
      let offset = loadOffset();
      const updates = await api(
        token,
        `getUpdates?timeout=25&offset=${offset}`,
      );
      for (const u of updates) {
        offset = Math.max(offset, u.update_id + 1);
        const msg = normalizeMessage(u);
        if (!msg) continue;
        if (allowedChat != null && Number(msg.chatId) !== allowedChat) continue;

        let previewUrl = null;
        if (msg.photoFileId) {
          const dest = join(SKILL_ROOT, 'inbox', `${msg.messageId}.jpg`);
          try {
            await downloadFile(token, msg.photoFileId, dest);
            msg.localPath = dest;
            previewUrl = `/inbox/${msg.messageId}.jpg`;
          } catch (e) {
            msg.downloadError = String(e?.message || e);
          }
        }

        logEvent({
          dir: 'in',
          sessionId: state.activeId,
          from: msg.from,
          text: msg.text,
          hasPhoto: msg.hasPhoto,
          messageId: msg.messageId,
          updateId: msg.updateId,
          previewUrl,
          localPath: msg.localPath || null,
          source: 'telegram',
        });

        acceptInstruction({
          ...msg,
          sessionId: state.activeId,
          previewUrl,
          source: 'telegram',
          images: msg.localPath
            ? [{ localPath: msg.localPath, previewUrl }]
            : [],
        });
      }
      saveOffset(offset);
    } catch (err) {
      const m = String(err?.message || err);
      logEvent({ dir: 'sys', sessionId: state.activeId, note: `poll error: ${m}` });
      await new Promise((r) =>
        setTimeout(r, /Conflict/i.test(m) ? 3000 : 2000),
      );
    }
  }
}

// Ensure at least one session
if (!Object.keys(state.sessions || {}).length) {
  state = defaultState();
  saveState();
} else {
  ensureSession({
    id: state.activeId,
    folder: state.folder || SKILL_ROOT,
    project: state.project || 'auto',
    workspaces: state.workspaces,
    setActive: true,
  });
}

server.listen(port, host, () => {
  console.log(`Debug UI: http://127.0.0.1:${port}/`);
  console.log(`          bind ${host}:${port}`);
  console.log(
    `          auto-process: ${AUTO_PROCESS ? 'ON (main + workers)' : 'OFF'}`,
  );
  console.log(`          main-agent: ${MAIN_URL}`);

  ensureMainAgent();

  // Flush any legacy drain backlog into the processor, then clear it
  const backlog = loadQueue();
  saveQueue();
  for (const msg of backlog) {
    acceptInstruction({
      ...msg,
      sessionId: msg.sessionId || state.activeId,
      source: msg.source || 'backlog',
    });
  }

  setInterval(() => {
    mainAgentUp().catch(() => {});
  }, 4000);

  pollLoop();
});
