#!/usr/bin/env node
/**
 * Telegram + agent debug console (multi-session).
 *
 *   node debug-server.mjs --host=0.0.0.0 --port=4331
 */
import { createServer } from 'node:http';
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { join, basename } from 'node:path';
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
} from './lib.mjs';

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
let queue = loadQueue();
let state = loadState();

function loadQueue() {
  if (!existsSync(QUEUE_PATH)) return [];
  try {
    return JSON.parse(readFileSync(QUEUE_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function saveQueue() {
  writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2) + '\n');
}

function emptyTokens() {
  return { input: 0, output: 0, total: 0, estimated: false };
}

function slugId(folder) {
  const base = basename(String(folder || 'default').replace(/[\\/]+$/, '')) || 'default';
  return base.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 48) || 'default';
}

function makeSession(partial = {}) {
  const folder = partial.folder || null;
  const id = partial.id || (folder ? slugId(folder) : 'default');
  const now = new Date().toISOString();
  return {
    id,
    label: partial.label || partial.project || (folder ? basename(folder) : id),
    project: partial.project || (folder ? basename(String(folder).replace(/[\\/]+$/, '')) : null),
    folder,
    workspaces: Array.isArray(partial.workspaces) ? partial.workspaces : folder ? [folder] : [],
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
  const folder = patch.folder || patch.cwd || null;
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

function readEvents(limit = 800, sessionId = null) {
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
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Agent · Telegram debug</title>
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
    html, body { height: 100%; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      height: 100vh;
      overflow: hidden;
      display: grid;
      grid-template-rows: auto auto 1fr auto;
      grid-template-areas: "head" "tabs" "log" "foot";
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
    .head-actions { display: flex; align-items: center; gap: 8px; }
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
    footer {
      grid-area: foot; display: flex; flex-wrap: wrap; align-items: center;
      justify-content: space-between; gap: 10px 16px;
      padding: 8px 12px; border-top: 1px solid var(--line);
      background: #101512; color: var(--muted); font-size: 11px;
    }
    .tok-bar { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 14px; }
    .tok-bar .total {
      font-variant-numeric: tabular-nums; font-size: 18px; font-weight: 650; color: var(--ink);
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Agent · Telegram</h1>
      <div class="meta" id="active-label">—</div>
    </div>
    <div class="head-actions">
      <span id="status" class="pill dead">connecting</span>
      <span class="meta" id="count"></span>
      <button class="menu-btn" id="stats-btn" type="button" aria-expanded="false">Stats</button>
    </div>
    <div class="stats-panel" id="stats-panel" role="dialog" aria-label="Stats">
      <h2>Stats</h2>
      <div class="stats-grid">
        <div>
          <div class="k">Active session tokens</div>
          <div class="v num" id="st-active-tok">0</div>
          <div class="v" id="st-active-split">in 0 · out 0</div>
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
  <footer>
    <div class="tok-bar">
      <span class="meta">session tokens</span>
      <span class="total" id="tok-total">0</span>
      <span id="tok-detail">in 0 · out 0</span>
      <span id="tok-est" class="meta"></span>
      <button class="linkish" id="tok-reset" type="button">Reset</button>
    </div>
    <div class="meta">newest on top · you right · bot/agent left</div>
  </footer>
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
      const list = state.sessionList || Object.values(state.sessions || {});
      tabsEl.innerHTML = '';
      for (const s of list) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'tab' + (s.id === viewSessionId ? ' active' : '');
        b.innerHTML = escapeHtml(s.label || s.id) +
          '<span class="tok">' + fmt(s.tokens?.total || 0) + '</span>';
        b.onclick = () => switchSession(s.id);
        tabsEl.appendChild(b);
      }
    }

    async function switchSession(id) {
      viewSessionId = id;
      fetch('/api/session/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      }).catch(() => {});
      log.innerHTML = '';
      seen.clear();
      n = 0;
      const list = await fetch('/api/events?session=' + encodeURIComponent(id)).then((r) => r.json());
      // API returns oldest→newest; prepend each so newest ends on top
      list.forEach((ev) => add(ev, { skipScroll: true }));
      const sess = await fetch('/api/session').then((r) => r.json());
      applyState(sess);
      countEl.textContent = n + ' events';
      log.scrollTop = 0;
    }

    function isFileOp(ev) {
      const tool = String(ev.tool || '');
      return !!(ev.path || /^(Write|StrReplace|Delete|EditNotebook|Read|Grep|Glob)$/i.test(tool));
    }

    function shouldSkip(ev) {
      if (!ev) return true;
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
      const sid = ev.sessionId || (state && state.activeId);
      if (viewSessionId && sid && sid !== viewSessionId) return;
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

      // newest on top
      if (opts && opts.append) log.appendChild(wrap);
      else log.prepend(wrap);
      if (!(opts && opts.skipScroll)) log.scrollTop = 0;
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

    Promise.all([
      fetch('/api/session').then((r) => r.json()),
    ]).then(async ([sess]) => {
      applyState(sess);
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
    }, 5000);
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
    sendJson(res, 200, { ok: true, port, queue: queue.length, state: publicState() });
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
    sendJson(res, 200, readEvents(800, sid || null));
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
    const out = queue;
    queue = [];
    saveQueue();
    sendJson(res, 200, { count: out.length, messages: out });
    return;
  }

  if (url.pathname === '/api/event' && req.method === 'POST') {
    try {
      const ev = await readBody(req);
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
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
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

        const ev = logEvent({
          dir: 'in',
          sessionId: state.activeId,
          from: msg.from,
          text: msg.text,
          hasPhoto: msg.hasPhoto,
          messageId: msg.messageId,
          updateId: msg.updateId,
          previewUrl,
          localPath: msg.localPath || null,
        });

        queue.push({ ...msg, previewUrl, loggedAt: ev.ts });
        saveQueue();
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
  pollLoop();
});
