#!/usr/bin/env node
/**
 * Auto host.
 *
 * Serves the web client and a WebSocket that carries the live transcript in one
 * direction and prompts, approvals, and steering in the other. The host owns
 * all state; clients are views that attach and replay.
 *
 *   node src/server/index.mjs [--port=4331] [--folder=D:\some\repo]
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { SessionManager, POLICY } from '../core/sessions.mjs';
import { BrowserHost } from '../core/browser.mjs';
import { TelegramBridge } from '../core/telegram.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const WEB = join(HERE, '..', 'web');

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

/** Load .env without a dependency. Real environment variables win. */
(function loadDotEnv() {
  const file = join(ROOT, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m || line.trimStart().startsWith('#')) continue;
    const value = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (!(m[1] in process.env)) process.env[m[1]] = value;
  }
})();

const PORT = Number(arg('port', process.env.AUTO_PORT || '4331')) || 4331;
const HOST = arg('host', '0.0.0.0');
const DEFAULT_FOLDER = arg('folder', ROOT);

const sessions = new SessionManager({
  stateDir: join(ROOT, 'state'),
  defaultFolder: DEFAULT_FOLDER,
  defaultPolicy: process.env.AUTO_POLICY || POLICY.auto,
}).init();

console.log(`[auto] approvals default to "${sessions.defaultPolicy}"`);

sessions.on('log', (m) => console.log(`[sessions] ${m}`));

/**
 * One browser for the whole host. Frames are live-only: they go to the clients
 * watching, and never into a transcript, because a video stream is the one
 * thing here that is genuinely worthless to replay.
 */
const browser = new BrowserHost({ stateDir: join(ROOT, 'state') });
browser.on('log', (m) => console.log(`[browser] ${m}`));

/**
 * A bot token allows exactly one poller, so only ever run one host with
 * Telegram enabled. `--no-telegram` is there for a second instance on another
 * port while developing.
 */
const telegram = new TelegramBridge({
  sessions,
  stateDir: join(ROOT, 'state'),
  webUrl: process.env.AUTO_WEB_URL || `http://127.0.0.1:${PORT}`,
});
telegram.on('log', (m) => console.log(`[telegram] ${m}`));

const wantTelegram = !process.argv.includes('--no-telegram') && process.env.AUTO_TELEGRAM !== '0';
if (wantTelegram && telegram.enabled) telegram.start();
else if (wantTelegram) console.log('[telegram] no credentials found; not starting');

/** @type {Map<import('ws').WebSocket, {sessionId: string|null, browser: boolean}>} */
const clients = new Map();

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

/** Broadcast to every socket, or only those watching one session. */
function broadcast(msg, sessionId = null) {
  for (const [ws, state] of clients) {
    if (sessionId && state.sessionId !== sessionId) continue;
    send(ws, msg);
  }
}

sessions.on('record', ({ sessionId, record }) =>
  broadcast({ type: 'record', sessionId, record }, sessionId),
);
sessions.on('sessions', (list) => broadcast({ type: 'sessions', sessions: list }));
sessions.on('catalog', (catalog) => broadcast({ type: 'catalog', catalog }));

// Terminal output reaches clients as transcript records; these only announce
// the widget's existence so the UI knows to open or close a pane.
sessions.terminals.on('opened', (t) =>
  broadcast({ type: 'terminal.opened', terminal: t }, t?.sessionId),
);
sessions.terminals.on('closed', (t) =>
  broadcast({ type: 'terminal.closed', terminalId: t.terminalId }, t.sessionId),
);

/** Frames go only to clients with the panel open; nobody else pays for them. */
function broadcastBrowser(msg) {
  for (const [ws, state] of clients) if (state.browser) send(ws, msg);
}

browser.on('frame', ({ data }) => broadcastBrowser({ type: 'browser.frame', data }));
browser.on('status', (status) => broadcastBrowser({ type: 'browser.status', status }));

/** Nobody watching means nothing to encode. */
function syncScreencast() {
  const watchers = [...clients.values()].filter((s) => s.browser).length;
  if (!watchers && browser.streaming) browser.stopScreencast().catch(() => {});
}

// ------------------------------------------------------------------ requests

const OPS = {
  async attach(ws, state, msg) {
    const id = msg.sessionId || sessions.activeId;
    if (!sessions.get(id)) throw new Error(`Unknown session ${id}`);
    state.sessionId = id;
    sessions.setActive(id);
    const records = await sessions.history(id, msg.fromSeq || 0);
    send(ws, {
      type: 'attached',
      sessionId: id,
      meta: sessions.get(id),
      records,
      pending: sessions.permissions.list(id),
      terminals: sessions.terminals.list(id),
      terminalsAvailable: sessions.terminals.available,
      catalog: sessions.catalog,
    });

    // The model list only exists once an agent has started. Warm it in the
    // background on a cold host so the picker fills shortly after you look at
    // it, rather than staying empty until the first prompt.
    if (!sessions.catalog.models.length) {
      sessions.ensureLive(id).catch((err) => console.error(`[catalog] ${err.message}`));
    }
  },

  async prompt(_ws, state, msg) {
    const id = msg.sessionId || state.sessionId;
    // Deliberately not awaited: the turn streams over the socket, and the
    // caller should not be blocked for its whole duration.
    sessions.prompt(id, { text: msg.text, images: msg.images || [] }).catch((err) => {
      console.error(`[prompt] ${err.message}`);
    });
  },

  cancel(_ws, state, msg) {
    sessions.cancel(msg.sessionId || state.sessionId);
  },

  permission(_ws, _state, msg) {
    sessions.permissions.resolve(msg.requestId, msg.optionId, { by: msg.by || 'web' });
  },

  'session.create'(ws, state, msg) {
    const meta = sessions.create({ folder: msg.folder, title: msg.title });
    return OPS.attach(ws, state, { sessionId: meta.id });
  },

  async 'session.archive'(_ws, _state, msg) {
    await sessions.archive(msg.sessionId);
  },

  'session.rename'(_ws, _state, msg) {
    sessions.rename(msg.sessionId, msg.title);
  },

  async 'session.mode'(_ws, state, msg) {
    await sessions.setMode(msg.sessionId || state.sessionId, msg.modeId);
  },

  async 'session.model'(_ws, state, msg) {
    await sessions.setModel(msg.sessionId || state.sessionId, msg.modelId);
  },

  'session.policy'(_ws, state, msg) {
    sessions.setPolicy(msg.sessionId || state.sessionId, msg.policy);
  },

  'terminal.open'(ws, state, msg) {
    const id = msg.sessionId || state.sessionId;
    const meta = sessions.get(id);
    if (!meta) throw new Error('No session');
    if (!sessions.terminals.available) {
      throw new Error(`Terminals unavailable: ${sessions.terminals.unavailableReason}`);
    }
    sessions.terminals.createUser({
      sessionId: id,
      cwd: meta.folder,
      cols: msg.cols,
      rows: msg.rows,
    });
  },

  'terminal.input'(_ws, _state, msg) {
    sessions.terminals.write(msg.terminalId, msg.data);
  },

  'terminal.resize'(_ws, _state, msg) {
    sessions.terminals.resize(msg.terminalId, msg.cols, msg.rows);
  },

  'terminal.close'(_ws, _state, msg) {
    sessions.terminals.release(msg.terminalId);
  },

  async 'browser.attach'(ws, state, msg) {
    state.browser = true;
    if (msg.width && msg.height) await browser.setViewport(msg.width, msg.height);
    await browser.ensure();
    send(ws, { type: 'browser.status', status: browser.status });
    await browser.startScreencast({ maxWidth: msg.maxWidth || 1280 });
  },

  'browser.detach'(_ws, state) {
    state.browser = false;
    syncScreencast();
  },

  async 'browser.navigate'(_ws, _state, msg) {
    await browser.navigate(msg.url);
  },

  async 'browser.click'(_ws, _state, msg) {
    await browser.click(msg.x, msg.y, { clickCount: msg.clickCount || 1 });
  },

  async 'browser.scroll'(_ws, _state, msg) {
    await browser.scroll(msg.x, msg.y, msg.deltaX || 0, msg.deltaY || 0);
  },

  async 'browser.type'(_ws, _state, msg) {
    await browser.type(msg.text);
  },

  async 'browser.key'(_ws, _state, msg) {
    await browser.key(msg.key);
  },

  async 'browser.nav'(_ws, _state, msg) {
    if (msg.action === 'back') await browser.back();
    else if (msg.action === 'forward') await browser.forward();
    else if (msg.action === 'reload') await browser.reload();
  },

  async 'browser.viewport'(_ws, _state, msg) {
    await browser.setViewport(msg.width, msg.height);
  },

  async 'browser.shot'() {
    await browser.screenshot();
  },

  async 'browser.close'() {
    await browser.close();
    broadcastBrowser({ type: 'browser.status', status: browser.status });
  },
};

// --------------------------------------------------------------------- http

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
};

/** Third-party browser assets, served straight out of node_modules. */
const VENDOR = {
  '/vendor/xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js',
  '/vendor/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
  '/vendor/addon-fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js',
};

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  if (rel.includes('..')) {
    res.writeHead(400).end('bad path');
    return;
  }
  const file = VENDOR[rel] ? join(ROOT, VENDOR[rel]) : join(WEB, rel);
  const ext = rel.slice(rel.lastIndexOf('.'));
  try {
    const body = readFileSync(file);
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}

function json(res, body, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

/** Cursor and hooks hand out paths like `/D:/foo`; Windows wants `D:\foo`. */
function normalizeFolder(input) {
  let s = String(input).trim().replace(/^\/([A-Za-z]:)/, '$1');
  if (/^[A-Za-z]:[\\/]/.test(s)) s = s.replace(/\//g, '\\');
  return s.replace(/[\\/]+$/, '');
}

const sameFolder = (a, b) =>
  String(a || '').replace(/[\\/]+$/, '').toLowerCase() ===
  String(b || '').replace(/[\\/]+$/, '').toLowerCase();

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (pathname === '/api/health') {
    return json(res, {
      ok: true,
      sessions: sessions.list().length,
      live: sessions.live.size,
      activeId: sessions.activeId,
      telegram: telegram.running,
    });
  }

  if (pathname === '/api/sessions' || (pathname === '/api/session' && req.method === 'GET')) {
    return json(res, { sessions: sessions.list(), activeId: sessions.activeId });
  }

  // Point the active session at a folder, reusing a session already on it.
  // This is the contract the switch-repo skill depends on.
  if (pathname === '/api/session' && req.method === 'POST') {
    const body = await readBody(req);
    const folder = body.folder ? normalizeFolder(body.folder) : null;
    if (!folder) return json(res, { error: 'folder is required' }, 400);
    if (!existsSync(folder)) return json(res, { error: `No such folder: ${folder}` }, 400);

    let meta = sessions.list().find((s) => sameFolder(s.folder, folder));
    if (!meta) meta = sessions.create({ folder, title: body.title });
    sessions.setActive(meta.id);
    return json(res, { session: sessions.get(meta.id), activeId: sessions.activeId });
  }

  if (pathname === '/api/session/active' && req.method === 'POST') {
    const body = await readBody(req);
    const wanted = String(body.id || '').trim();
    const match = sessions
      .list()
      .find(
        (s) =>
          s.id === wanted ||
          s.title?.toLowerCase() === wanted.toLowerCase() ||
          sameFolder(s.folder, wanted),
      );
    if (!match) return json(res, { error: `Unknown session ${wanted}` }, 404);
    sessions.setActive(match.id);
    return json(res, { session: sessions.get(match.id), activeId: sessions.activeId });
  }

  return serveStatic(req, res);
});

// ----------------------------------------------------------------- websocket

const wss = new WebSocketServer({ server });

wss.on('connection', async (ws) => {
  const state = { sessionId: null, browser: false };
  clients.set(ws, state);

  send(ws, {
    type: 'hello',
    sessions: sessions.list(),
    activeId: sessions.activeId,
    policies: Object.values(POLICY),
  });
  try {
    await OPS.attach(ws, state, { sessionId: sessions.activeId, fromSeq: 0 });
  } catch (err) {
    send(ws, { type: 'error', message: err.message });
  }

  ws.on('message', async (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }
    const op = OPS[msg.op];
    if (!op) {
      send(ws, { type: 'error', message: `Unknown op ${msg.op}` });
      return;
    }
    try {
      await op(ws, state, msg);
    } catch (err) {
      send(ws, { type: 'error', message: err.message });
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    syncScreencast();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[auto] http://127.0.0.1:${PORT}  (${sessions.list().length} sessions)`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log('\n[auto] shutting down');
    telegram.stop();
    await browser.close().catch(() => {});
    await sessions.stopAll();
    process.exit(0);
  });
}
