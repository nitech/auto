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
} from './lib.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MAIN_AGENT = join(SCRIPT_DIR, 'main-agent.mjs');
const JOBS_DIR = join(SKILL_ROOT, 'jobs');
const AUTO_PROCESS = process.env.AUTO_PROCESS !== '0';
const MAIN_PORT = Number(process.env.AUTO_MAIN_PORT || 4332) || 4332;
const MAIN_URL = `http://127.0.0.1:${MAIN_PORT}`;

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

const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>Auto Web</title>
  <style>
    :root {
      --bg: #0b0f0d;
      --panel: #141a17;
      --ink: #e8ebe6;
      --muted: #8a948e;
      --you: #2f6f55;
      --you-bg: #1a3d30;
      --bot: #2a3030;
      --agent: #6b8cae;
      --sys: #5a6a62;
      --line: rgba(232,235,230,.1);
      --accent: #7dcea0;
      font-family: "Segoe UI", system-ui, sans-serif;
    }
    * { box-sizing: border-box; }
    html, body {
      height: 100%;
      width: 100%;
      max-width: 100%;
      overflow-x: hidden;
    }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      height: 100vh;
      height: 100dvh;
      overflow: hidden;
      display: grid;
      grid-template-rows: auto auto 1fr auto;
      grid-template-areas: "head" "tabs" "log" "compose";
    }
    header {
      grid-area: head;
      display: flex;
      gap: 10px;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
      position: relative;
      z-index: 5;
    }
    h1 { margin: 0; font-size: 12px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; }
    .meta { color: var(--muted); font-size: 11px; }
    .pill {
      display: inline-block; padding: 1px 7px; border-radius: 999px;
      font-size: 10px; letter-spacing: .06em; text-transform: uppercase;
    }
    .pill.live { background: rgba(61,139,110,.2); color: #7dcea0; }
    .pill.dead { background: rgba(164,112,63,.2); color: #d4a574; }
    .pill.work { background: rgba(212,165,116,.22); color: #e0b37a; animation: pulse 1.2s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity: .55; } }
    .head-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    button.menu-btn, button.linkish {
      appearance: none; border: 1px solid var(--line); background: transparent;
      color: var(--ink); border-radius: 999px; padding: 4px 10px;
      font-size: 10px; letter-spacing: .06em; text-transform: uppercase; cursor: pointer;
    }
    button.menu-btn[aria-expanded="true"] { border-color: var(--accent); color: var(--accent); }
    .stats-panel {
      display: none; position: absolute; top: calc(100% + 6px); right: 12px;
      width: min(340px, calc(100vw - 24px));
      background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
      padding: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.45); z-index: 20;
    }
    .stats-panel.open { display: block; }
    .stats-panel h2 {
      margin: 0 0 8px; font-size: 10px; letter-spacing: .1em;
      text-transform: uppercase; color: var(--muted);
    }
    .stats-grid { display: grid; gap: 8px; font-size: 12px; }
    .stats-grid .k { color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .05em; }
    .stats-grid .v { font-family: ui-monospace, Consolas, monospace; font-size: 12px; white-space: pre-wrap; word-break: break-word; }
    .stats-grid .num { font-size: 20px; font-weight: 650; font-variant-numeric: tabular-nums; }
    #tabs {
      grid-area: tabs;
      display: flex; gap: 4px; align-items: center;
      padding: 6px 10px; overflow-x: auto;
      border-bottom: 1px solid var(--line); background: #101512;
    }
    .tab {
      flex: 0 0 auto; border: 1px solid var(--line); background: transparent;
      color: var(--muted); border-radius: 999px; padding: 4px 10px;
      font-size: 11px; cursor: pointer; white-space: nowrap;
    }
    .tab.active { color: var(--ink); border-color: var(--accent); background: rgba(125,206,160,.08); }
    .tab .tok { color: var(--muted); margin-left: 6px; font-variant-numeric: tabular-nums; }
    #log {
      grid-area: log; padding: 12px 14px 20px;
      display: flex; flex-direction: column; gap: 8px;
      overflow: auto; min-height: 0;
    }
    .wrap {
      display: flex; width: 100%;
    }
    .wrap.you { justify-content: flex-end; }
    .wrap.them { justify-content: flex-start; }
    .wrap.center { justify-content: center; }
    .bubble {
      max-width: min(72%, 640px);
      border-radius: 14px;
      padding: 8px 11px;
      font-size: 13px;
      line-height: 1.4;
      word-break: break-word;
      white-space: pre-wrap;
    }
    .bubble.you { background: var(--you-bg); border: 1px solid rgba(47,111,85,.45); border-bottom-right-radius: 4px; }
    .bubble.bot { background: var(--bot); border: 1px solid var(--line); border-bottom-left-radius: 4px; }
    .bubble.agent { background: #182028; border: 1px solid rgba(107,140,174,.35); border-bottom-left-radius: 4px; }
    .bubble.sys { background: transparent; border: 1px dashed var(--line); color: var(--muted); font-size: 11px; max-width: 90%; }
    .bubble.compact {
      font-family: ui-monospace, Consolas, monospace; font-size: 12px;
      padding: 5px 10px; max-width: min(85%, 720px);
    }
    .meta-line {
      display: flex; justify-content: space-between; gap: 10px;
      font-size: 10px; color: var(--muted); text-transform: uppercase;
      letter-spacing: .04em; margin-bottom: 3px;
    }
    .bubble.you .meta-line { color: rgba(232,235,230,.55); }
    .body.clamp {
      display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 5;
      overflow: hidden; max-height: 7em; cursor: pointer;
    }
    .wrap.expandable { cursor: pointer; }
    .wrap.expanded .body.clamp { -webkit-line-clamp: unset; max-height: none; overflow: visible; }
    .hint { margin-top: 3px; font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
    img.thumb {
      margin-top: 6px; max-width: min(100%, 280px); border-radius: 8px;
      border: 1px solid var(--line); display: block;
    }
    #compose {
      grid-area: compose;
      flex-shrink: 0;
      padding: 10px 12px calc(12px + env(safe-area-inset-bottom, 0px));
      background: linear-gradient(180deg, transparent, var(--bg) 28%);
      position: relative;
      z-index: 4;
      width: 100%;
      max-width: 100%;
    }
    .composer {
      display: flex;
      flex-direction: column;
      gap: 8px;
      width: 100%;
      max-width: 48rem;
      margin: 0 auto;
      padding: 10px 12px;
      border: 1px solid var(--line);
      border-radius: 22px;
      background: #1a211e;
      box-shadow: 0 8px 28px rgba(0,0,0,.35);
    }
    .composer.drag { border-color: rgba(125,206,160,.55); background: #1e2a24; }
    .composer-previews {
      display: none;
      gap: 8px;
      flex-wrap: wrap;
    }
    .composer-previews.has { display: flex; }
    .composer-previews .shot {
      position: relative;
      width: 64px; height: 64px;
      border-radius: 10px;
      overflow: hidden;
      border: 1px solid var(--line);
    }
    .composer-previews .shot img {
      width: 100%; height: 100%; object-fit: cover; display: block;
    }
    .composer-previews .shot button {
      position: absolute; top: 2px; right: 2px;
      width: 20px; height: 20px; border: 0; border-radius: 999px;
      background: rgba(0,0,0,.65); color: #fff; font-size: 12px; cursor: pointer;
      line-height: 1;
    }
    .composer-row {
      display: flex;
      align-items: flex-end;
      gap: 8px;
      width: 100%;
    }
    .composer-row textarea {
      flex: 1 1 auto;
      min-width: 0;
      width: 100%;
      min-height: 24px;
      max-height: 160px;
      resize: none;
      border: 0;
      outline: none;
      background: transparent;
      color: var(--ink);
      /* 16px prevents iOS focus zoom */
      font: inherit;
      font-size: 16px;
      line-height: 1.45;
      padding: 6px 2px;
      field-sizing: content;
    }
    .composer-row textarea::placeholder { color: var(--muted); }
    .icon-btn {
      appearance: none;
      flex: 0 0 auto;
      width: 36px; height: 36px;
      border: 0;
      border-radius: 999px;
      background: transparent;
      color: var(--muted);
      font-size: 20px;
      line-height: 1;
      cursor: pointer;
    }
    .icon-btn:hover { color: var(--ink); background: rgba(232,235,230,.06); }
    #compose-file { display: none; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Auto Web</h1>
      <div class="meta" id="active-label">—</div>
    </div>
    <div class="head-actions">
      <span id="proc" class="pill dead" title="Auto processor">auto idle</span>
      <span id="status" class="pill dead">connecting</span>
      <span class="meta" id="count" hidden></span>
      <button class="menu-btn" id="stats-btn" type="button" aria-expanded="false">Stats</button>
    </div>
    <div class="stats-panel" id="stats-panel" role="dialog" aria-label="Stats">
      <h2>Stats</h2>
      <div class="stats-grid">
        <div>
          <div class="k">Active session tokens</div>
          <div class="v num" id="tok-total">0</div>
          <div class="v" id="tok-detail">in 0 · out 0</div>
          <div class="v meta" id="tok-est"></div>
          <div class="v num" id="st-active-tok" style="display:none">0</div>
          <div class="v" id="st-active-split" style="display:none">in 0 · out 0</div>
          <button class="linkish" id="tok-reset" type="button" style="margin-top:8px">Reset tokens</button>
        </div>
        <div>
          <div class="k">All sessions tokens</div>
          <div class="v num" id="st-all-tok">0</div>
          <div class="v" id="st-all-split">in 0 · out 0</div>
        </div>
        <div>
          <div class="k">Active folder</div>
          <div class="v" id="st-folder">—</div>
        </div>
        <div>
          <div class="k">Workspaces</div>
          <div class="v" id="st-workspaces">—</div>
        </div>
        <div>
          <div class="k">Sessions</div>
          <div class="v" id="st-sessions">—</div>
        </div>
      </div>
    </div>
  </header>
  <div id="tabs"></div>
  <div id="log"></div>
  <form id="compose" autocomplete="off">
    <div class="composer" id="composer">
      <div class="composer-previews" id="compose-previews"></div>
      <div class="composer-row">
        <button class="icon-btn" type="button" id="compose-attach" title="Attach image" aria-label="Attach image">+</button>
        <textarea
          id="compose-text"
          rows="1"
          placeholder="Message…"
          enterkeyhint="send"
          inputmode="text"
          autocomplete="off"
          autocorrect="on"
          autocapitalize="sentences"
          spellcheck="true"
        ></textarea>
      </div>
    </div>
  </form>
  <input id="compose-file" type="file" accept="image/*" multiple tabindex="-1" aria-hidden="true" />
  <script>
    const log = document.getElementById('log');
    const tabsEl = document.getElementById('tabs');
    const status = document.getElementById('status');
    const countEl = document.getElementById('count');
    const statsBtn = document.getElementById('stats-btn');
    const statsPanel = document.getElementById('stats-panel');
    const CAP = 320;
    let state = null;
    let viewSessionId = null;
    let viewMode = 'session'; // 'session' | 'workers' | 'worker-detail'
    let viewWorkerId = null;
    let agentsInfo = { workers: [], maxWorkers: 4 };
    let n = 0;
    const seen = new Set();

    function fmt(n) {
      return new Intl.NumberFormat('en-US').format(n || 0);
    }
    function shortTime(ts) {
      if (!ts) return '';
      try {
        return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      } catch { return String(ts).slice(11, 19); }
    }
    function escapeHtml(s) {
      return String(s)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }
    function eventKey(ev) {
      return ev.ts + '|' + (ev.messageId || '') + '|' + (ev.text || ev.note || '').slice(0, 40) + '|' + (ev.tool || '');
    }

    function applyState(s) {
      if (!s) return;
      state = s;
      if (!viewSessionId || !s.sessions[viewSessionId]) {
        viewSessionId = s.activeId;
      }
      const active = s.sessions[viewSessionId] || s.active || {};
      document.getElementById('active-label').textContent =
        (active.label || active.project || viewSessionId || '—') +
        (active.folder ? ' · ' + active.folder : '');

      const t = active.tokens || {};
      document.getElementById('tok-total').textContent = fmt(t.total || 0);
      document.getElementById('tok-detail').textContent =
        'in ' + fmt(t.input || 0) + ' · out ' + fmt(t.output || 0);
      document.getElementById('tok-est').textContent = t.estimated ? 'est.' : '';

      document.getElementById('st-active-tok').textContent = fmt(t.total || 0);
      document.getElementById('st-active-split').textContent =
        'in ' + fmt(t.input || 0) + ' · out ' + fmt(t.output || 0);
      const tot = s.totals || {};
      document.getElementById('st-all-tok').textContent = fmt(tot.total || 0);
      document.getElementById('st-all-split').textContent =
        'in ' + fmt(tot.input || 0) + ' · out ' + fmt(tot.output || 0);
      document.getElementById('st-folder').textContent = active.folder || '—';
      document.getElementById('st-workspaces').textContent =
        (active.workspaces && active.workspaces.length) ? active.workspaces.join('\\n') : '—';
      const list = s.sessionList || Object.values(s.sessions || {});
      document.getElementById('st-sessions').textContent = list
        .map((x) => (x.label || x.id) + ' (' + fmt(x.tokens?.total || 0) + ' tok)')
        .join('\\n') || '—';

      renderTabs();
    }

    function renderTabs() {
      if (!state) return;
      tabsEl.innerHTML = '';

      const activeWorkers = (agentsInfo.workers || []).filter(
        (w) => w.phase !== 'done' && w.phase !== 'error',
      ).length;
      const wb = document.createElement('button');
      wb.type = 'button';
      wb.className = 'tab workers-tab' + (viewMode !== 'session' ? ' active' : '');
      wb.innerHTML = 'Workers' + (activeWorkers ? '<span class="tok">' + activeWorkers + '</span>' : '');
      wb.onclick = () => showWorkers();
      tabsEl.appendChild(wb);

      const list = state.sessionList || Object.values(state.sessions || {});
      for (const s of list) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'tab' + (viewMode === 'session' && s.id === viewSessionId ? ' active' : '');
        b.innerHTML = escapeHtml(s.label || s.id) +
          '<span class="tok">' + fmt(s.tokens?.total || 0) + '</span>';
        b.onclick = () => switchSession(s.id);
        tabsEl.appendChild(b);
      }
    }

    async function switchSession(id) {
      viewMode = 'session';
      viewWorkerId = null;
      viewSessionId = id;
      document.getElementById('compose').style.display = '';
      fetch('/api/session/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      }).catch(() => {});
      log.innerHTML = '';
      seen.clear();
      n = 0;
      renderTabs();
      const list = await fetch('/api/events?session=' + encodeURIComponent(id)).then((r) => r.json());
      // API returns oldest→newest; prepend each so newest ends on top
      list.forEach((ev) => add(ev, { skipScroll: true }));
      const sess = await fetch('/api/session').then((r) => r.json());
      applyState(sess);
      countEl.textContent = n + ' events';
      log.scrollTop = 0;
    }

    function workerPhasePill(phase) {
      if (phase === 'done') return 'live';
      if (phase === 'error') return 'dead';
      return 'work';
    }

    function showWorkers() {
      viewMode = 'workers';
      viewWorkerId = null;
      document.getElementById('active-label').textContent = 'Workers';
      document.getElementById('compose').style.display = 'none';
      renderTabs();
      renderWorkersList();
    }

    function renderWorkersList() {
      log.innerHTML = '';
      seen.clear();
      n = 0;
      const workers = (agentsInfo.workers || [])
        .slice()
        .sort((a, b) => String(b.updatedAt || b.startedAt || '').localeCompare(String(a.updatedAt || a.startedAt || '')));
      countEl.textContent = workers.length + ' workers';
      if (!workers.length) {
        const empty = document.createElement('div');
        empty.className = 'wrap center';
        empty.innerHTML = '<div class="bubble sys">No workers yet.</div>';
        log.appendChild(empty);
        return;
      }
      for (const w of workers) {
        const wrap = document.createElement('div');
        wrap.className = 'wrap them';
        wrap.style.cursor = 'pointer';
        wrap.innerHTML =
          '<div class="bubble agent">' +
          '<div class="meta-line"><span>' + escapeHtml(w.workerId || '') +
          '</span><span class="pill ' + workerPhasePill(w.phase) + '">' + escapeHtml(w.phase || '') + '</span></div>' +
          '<div class="body">' + escapeHtml(w.text || '(no task text)') + '</div>' +
          '<div class="hint">' + escapeHtml(shortTime(w.startedAt)) +
          (w.sessionId ? ' · ' + escapeHtml(w.sessionId) : '') + ' · tap for live stream</div>' +
          '</div>';
        wrap.addEventListener('click', () => showWorkerDetail(w.workerId));
        log.appendChild(wrap);
      }
    }

    async function showWorkerDetail(workerId) {
      viewMode = 'worker-detail';
      viewWorkerId = workerId;
      const w = (agentsInfo.workers || []).find((x) => x.workerId === workerId);
      document.getElementById('active-label').textContent =
        'Worker · ' + workerId + (w ? ' · ' + (w.phase || '') : '');
      document.getElementById('compose').style.display = 'none';
      renderTabs();
      log.innerHTML = '';
      seen.clear();
      n = 0;
      const list = await fetch('/api/events?worker=' + encodeURIComponent(workerId)).then((r) => r.json());
      // Chronological, oldest first — appended top-to-bottom like a log tail
      list.forEach((ev) => add(ev, { skipScroll: true }));
      countEl.textContent = n + ' events';
      log.scrollTop = log.scrollHeight;
    }

    function isFileOp(ev) {
      const tool = String(ev.tool || '');
      return !!(ev.path || /^(Write|StrReplace|Delete|EditNotebook|Read|Grep|Glob)$/i.test(tool));
    }

    function applyProcessor(p) {
      if (!p) return;
      const agents = p.agents || {};
      agentsInfo = { workers: agents.workers || [], maxWorkers: agents.maxWorkers || 4 };
      renderTabs();
      if (viewMode === 'workers') renderWorkersList();
      if (viewMode === 'worker-detail') {
        const w = agentsInfo.workers.find((x) => x.workerId === viewWorkerId);
        if (w) {
          document.getElementById('active-label').textContent =
            'Worker · ' + viewWorkerId + (w.phase ? ' · ' + w.phase : '');
        }
      }
      const el = document.getElementById('proc');
      if (!el) return;
      const mainReady = p.mainReady || (agents.main && agents.main.ready);
      const workers = (agents.workers || []).filter(function (w) {
        return w.phase !== 'done' && w.phase !== 'error';
      });
      if (p.enabled === false) {
        el.textContent = 'auto off';
        el.className = 'pill dead';
        el.title = 'Set AUTO_PROCESS=1 (default) and restart';
        return;
      }
      if (workers.length > 0) {
        el.textContent = 'workers ' + workers.length;
        el.className = 'pill work';
        el.title = workers.map(function (w) {
          return (w.workerId || '') + ' · ' + (w.phase || '') + ' · ' + (w.text || '');
        }).join('\\n');
      } else if (!mainReady) {
        el.textContent = 'main starting';
        el.className = 'pill work';
        el.title = 'Warming front-desk Claude session';
      } else {
        el.textContent = 'main ready';
        el.className = 'pill live';
        el.title = 'Front-desk agent online — workers spawn on each message';
      }
    }

    function shouldSkip(ev) {
      if (!ev) return true;
      if (ev.type === 'processor' || ev.type === 'agents') {
        applyProcessor(Object.assign({}, ev.processor || {}, { agents: ev.agents || (ev.processor && ev.processor.agents) }));
        return true;
      }
      if (ev.silent || ev.type === 'state') return true;
      if (ev.state && !ev.text && !ev.note && !ev.tool && !ev.path) return true;
      return false;
    }

    function add(ev, opts) {
      if (ev && ev.type === 'state' && ev.state) {
        applyState(ev.state);
        return;
      }
      if (shouldSkip(ev)) {
        if (ev && ev.state) applyState(ev.state);
        return;
      }
      if (viewMode === 'workers') return; // list view is driven by renderWorkersList, not the raw event stream
      if (viewMode === 'worker-detail') {
        if (String(ev.workerId || '') !== String(viewWorkerId)) return;
      } else {
        const sid = ev.sessionId || (state && state.activeId);
        if (viewSessionId && sid && sid !== viewSessionId) return;
      }
      const key = eventKey(ev);
      if (seen.has(key)) return;
      seen.add(key);

      n++;
      countEl.textContent = n + ' events';
      const dir = ev.dir || 'sys';
      const text = (ev.text || ev.caption || ev.note || '').trim()
        || (ev.hasPhoto ? '[photo]' : '');
      const wrap = document.createElement('div');
      const side = dir === 'in' ? 'you' : (dir === 'sys' ? 'center' : 'them');
      wrap.className = 'wrap ' + side;

      let bubbleClass = 'bubble ';
      if (dir === 'in') bubbleClass += 'you';
      else if (dir === 'out') bubbleClass += 'bot';
      else if (dir === 'agent') bubbleClass += 'agent';
      else bubbleClass += 'sys';

      const label =
        dir === 'in' ? 'you' :
        dir === 'out' ? 'bot' :
        dir === 'agent' ? 'agent' : 'sys';

      if (dir === 'agent' && (isFileOp(ev) || ev.command)) {
        bubbleClass += ' compact';
        const line = ev.command
          ? ((ev.tool || 'Shell') + ' · ' + String(ev.command).slice(0, 140))
          : ((ev.tool || 'edit') + (ev.path ? ' · ' + ev.path : ''));
        wrap.innerHTML =
          '<div class="' + bubbleClass + '">' +
          '<div class="meta-line"><span>' + label + '</span><span>' + escapeHtml(shortTime(ev.ts)) + '</span></div>' +
          escapeHtml(line) + '</div>';
      } else {
        const long = text.length > CAP || (text.match(/\\n/g) || []).length >= 4;
        if (long) wrap.classList.add('expandable');
        wrap.innerHTML =
          '<div class="' + bubbleClass + '">' +
          '<div class="meta-line"><span>' + label +
          (ev.from ? ' · ' + escapeHtml(ev.from) : '') +
          (ev.tool ? ' · ' + escapeHtml(ev.tool) : '') +
          '</span><span>' + escapeHtml(shortTime(ev.ts)) + '</span></div>' +
          '<div class="body' + (text ? (long ? ' clamp' : '') : '') + '">' +
          escapeHtml(text || '—') + '</div>' +
          (long ? '<div class="hint">tap to expand</div>' : '') +
          '</div>';
        if (long) {
          wrap.addEventListener('click', () => {
            wrap.classList.toggle('expanded');
            const h = wrap.querySelector('.hint');
            if (h) h.textContent = wrap.classList.contains('expanded') ? 'tap to collapse' : 'tap to expand';
          });
        }
      }

      if (ev.previewUrl) {
        const img = document.createElement('img');
        img.className = 'thumb';
        img.src = ev.previewUrl;
        img.alt = 'photo';
        wrap.querySelector('.bubble').appendChild(img);
      }

      if (viewMode === 'worker-detail') {
        // chronological log tail — oldest on top, newest at bottom
        log.appendChild(wrap);
        if (!(opts && opts.skipScroll)) log.scrollTop = log.scrollHeight;
      } else {
        // newest on top
        log.prepend(wrap);
        if (!(opts && opts.skipScroll)) log.scrollTop = 0;
      }
    }

    statsBtn.onclick = (e) => {
      e.stopPropagation();
      const open = !statsPanel.classList.contains('open');
      statsPanel.classList.toggle('open', open);
      statsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    document.addEventListener('click', (e) => {
      if (!statsPanel.contains(e.target) && e.target !== statsBtn) {
        statsPanel.classList.remove('open');
        statsBtn.setAttribute('aria-expanded', 'false');
      }
    });

    document.getElementById('tok-reset').onclick = () => {
      fetch('/api/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reset: true, sessionId: viewSessionId }),
      });
    };

    const composeForm = document.getElementById('compose');
    const composeText = document.getElementById('compose-text');
    const composer = document.getElementById('composer');
    const composeFile = document.getElementById('compose-file');
    const composePreviews = document.getElementById('compose-previews');
    const pendingImages = [];

    function renderPreviews() {
      composePreviews.innerHTML = '';
      composePreviews.classList.toggle('has', pendingImages.length > 0);
      pendingImages.forEach((img, i) => {
        const el = document.createElement('div');
        el.className = 'shot';
        el.innerHTML = '<img alt="" /><button type="button" aria-label="Remove">×</button>';
        el.querySelector('img').src = img.dataUrl;
        el.querySelector('button').onclick = () => {
          pendingImages.splice(i, 1);
          renderPreviews();
        };
        composePreviews.appendChild(el);
      });
    }

    function addImageFile(file) {
      if (!file || !String(file.type || '').startsWith('image/')) return;
      if (pendingImages.length >= 6) return;
      const reader = new FileReader();
      reader.onload = () => {
        pendingImages.push({
          name: file.name || 'image.jpg',
          type: file.type || 'image/jpeg',
          dataUrl: String(reader.result),
        });
        renderPreviews();
      };
      reader.readAsDataURL(file);
    }

    async function sendChat() {
      const text = composeText.value.trim();
      if (!text && !pendingImages.length) return;
      const images = pendingImages.map((x) => ({
        name: x.name,
        type: x.type,
        dataUrl: x.dataUrl,
      }));
      composeText.disabled = true;
      applyProcessor({ busy: true, pending: 0 });
      add({
        dir: 'sys',
        note: 'auto: processing now…',
        text: text || '[photo]',
        ts: new Date().toISOString(),
        sessionId: viewSessionId,
      });
      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, sessionId: viewSessionId, images }),
        });
        if (!res.ok) throw new Error('chat HTTP ' + res.status);
        composeText.value = '';
        pendingImages.length = 0;
        renderPreviews();
      } catch (err) {
        add({
          dir: 'sys',
          note: 'auto: send failed — ' + String(err && err.message || err),
          ts: new Date().toISOString(),
        });
        applyProcessor({ busy: false, pending: 0 });
      } finally {
        composeText.disabled = false;
        composeText.focus({ preventScroll: true });
      }
    }

    composeForm.addEventListener('submit', (e) => { e.preventDefault(); sendChat(); });
    composeText.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChat();
      }
    });
    document.getElementById('compose-attach').onclick = () => composeFile.click();
    composeFile.addEventListener('change', () => {
      Array.from(composeFile.files || []).forEach(addImageFile);
      composeFile.value = '';
    });
    composeText.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const item of items) {
        if (item.type && item.type.startsWith('image/')) {
          const f = item.getAsFile();
          if (f) addImageFile(f);
        }
      }
    });
    ;['dragenter','dragover'].forEach((ev) => {
      composer.addEventListener(ev, (e) => {
        e.preventDefault();
        composer.classList.add('drag');
      });
    });
    ;['dragleave','drop'].forEach((ev) => {
      composer.addEventListener(ev, (e) => {
        e.preventDefault();
        composer.classList.remove('drag');
        if (ev === 'drop') {
          Array.from(e.dataTransfer.files || []).forEach(addImageFile);
        }
      });
    });

    Promise.all([
      fetch('/api/session').then((r) => r.json()),
      fetch('/api/processor').then((r) => r.json()).catch(() => null),
    ]).then(async ([sess, proc]) => {
      applyState(sess);
      applyProcessor(proc);
      viewSessionId = sess.activeId;
      const list = await fetch('/api/events?session=' + encodeURIComponent(viewSessionId)).then((r) => r.json());
      list.forEach((ev) => add(ev, { skipScroll: true }));
      log.scrollTop = 0;
      const es = new EventSource('/api/stream');
      es.onopen = () => { status.textContent = 'live'; status.className = 'pill live'; };
      es.onerror = () => { status.textContent = 'reconnecting'; status.className = 'pill dead'; };
      es.onmessage = (e) => {
        try {
          const ev = JSON.parse(e.data);
          add(ev);
        } catch {}
      };
    });

    setInterval(() => {
      fetch('/api/session').then((r) => r.json()).then(applyState).catch(() => {});
      fetch('/api/processor').then((r) => r.json()).then(applyProcessor).catch(() => {});
    }, 3000);
  </script>
</body>
</html>`;

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
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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
