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
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { SessionManager, POLICY, STATUS } from '../core/sessions.mjs';
import { BrowserHost } from '../core/browser.mjs';
import { HostIdentity } from '../core/host-identity.mjs';
import { TelegramBridge } from '../core/telegram.mjs';
import { listProjects, workspaceIdFor, foldersByWorkspaceId } from '../core/projects.mjs';
import { desktopChats, recentDesktopChats } from '../core/desktop-chats.mjs';
import {
  assertSwitches,
  gateState,
  storageAvailable,
} from '../core/desktop-bridge-gate.mjs';
import { fileTag, stampHtml } from '../web/stamp.mjs';

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

const STATE_DIR = join(ROOT, 'state');
const hostIdentity = new HostIdentity(STATE_DIR);

const sessions = new SessionManager({
  stateDir: STATE_DIR,
  defaultFolder: DEFAULT_FOLDER,
  defaultPolicy: process.env.AUTO_POLICY || POLICY.auto,
}).init();

console.log(`[auto] approvals default to "${sessions.defaultPolicy}"`);
console.log(`[auto] host is "${hostIdentity.label()}"`);

sessions.on('log', (m) => console.log(`[sessions] ${m}`));

/**
 * One browser for the whole host. Frames are live-only: they go to the clients
 * watching, and never into a transcript, because a video stream is the one
 * thing here that is genuinely worthless to replay.
 */
const browser = new BrowserHost({ stateDir: STATE_DIR });
browser.on('log', (m) => console.log(`[browser] ${m}`));

/**
 * A bot token allows exactly one poller, so only ever run one host with
 * Telegram enabled. `--no-telegram` is there for a second instance on another
 * port while developing.
 */
const telegram = new TelegramBridge({
  sessions,
  stateDir: STATE_DIR,
  webUrl: process.env.AUTO_WEB_URL || `http://127.0.0.1:${PORT}`,
  restart: (opts) => restartHost(opts),
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

/**
 * Cursor's projects, plus any folder Auto has a session in — so a project
 * never disappears from the rail just because the IDE forgot it.
 */
function projectList() {
  return listProjects(sessions.list().map((s) => s.folder));
}

/** The desktop app's own chats for a folder, newest first. */
function desktopChatsFor(folder) {
  if (!folder) return [];
  const open = new Set(sessions.list().map((s) => s.desktopThreadId).filter(Boolean));
  return desktopChats(workspaceIdFor(folder)).map((c) => ({ ...c, attached: open.has(c.id) }));
}

/**
 * Cursor's own recent chats, whichever project they belong to — the list the
 * IDE shows, so Auto's rail can be the same one. Cached briefly because the
 * folder lookup reads a directory per workspace and the rail asks often.
 */
let recentCache = { at: 0, chats: [] };
function recentChats() {
  if (Date.now() - recentCache.at < 5_000) return recentCache.chats;
  const folders = foldersByWorkspaceId();
  const open = new Set(sessions.list().map((s) => s.desktopThreadId).filter(Boolean));
  const chats = recentDesktopChats({ limit: 60 })
    .map((c) => {
      const folder = folders.get(c.workspaceId) || '';
      return {
        ...c,
        folder,
        project: folder ? basename(folder) : '',
        attached: open.has(c.id),
      };
    })
    // A chat whose folder the IDE has forgotten cannot be sent to, since the
    // bridge needs a window with that workspace open.
    .filter((c) => c.folder);
  recentCache = { at: Date.now(), chats };
  return chats;
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
// A queue can change without anyone asking: a turn ends and takes the first
// message with it, or somebody queues one in the IDE itself.
sessions.on('queue', ({ sessionId, ...queue }) =>
  broadcast({ type: 'queue', sessionId, ...queue }, sessionId),
);
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

/**
 * How much of a transcript a client is given at once.
 *
 * It used to be all of it. A chat running for days reaches tens of thousands
 * of records and tens of megabytes, and that went over the socket as a single
 * message the browser had to parse whole and then turn into a DOM node apiece
 * — so the tab locked up and the conversation never appeared. A conversation
 * is read from its end, so the end is what gets sent; the rest stays on disk
 * and is still there to ask for by sequence number.
 */
const REPLAY_LIMIT = 1200;

const OPS = {
  async attach(ws, state, msg) {
    const id = msg.sessionId || sessions.activeId;
    if (!sessions.get(id)) throw new Error(`Unknown session ${id}`);
    state.sessionId = id;
    sessions.setActive(id);
    // A client that claims to be further along than the log is holding a
    // conversation this host has never heard of — a transcript that was reset
    // behind it. Start it over rather than leaving it showing the impossible.
    const asked = msg.fromSeq || 0;
    const fromSeq = asked > (await sessions.transcript(id)).seq ? 0 : asked;
    // Bounded tail plus the opening prompt — a long chat used to lose the
    // first message (and its scrub landmark) because only the newest records
    // travelled. The gap between them is counted as `earlier`.
    const window = await sessions.replay(id, fromSeq, REPLAY_LIMIT);
    send(ws, {
      type: 'attached',
      sessionId: id,
      meta: sessions.get(id),
      records: window.records,
      head: window.head,
      // Whether this payload replaces what the client has or adds to it.
      // Catching up from a sequence number appends; a replay from the start
      // stands in for the lot, and saying so is what stops a reconnect drawing
      // the same conversation twice.
      replaced: !fromSeq,
      // Catch-up hole (forces a redraw when the host skipped records). Not the
      // intentional gap between the pinned opening and the tail — that is omitted.
      earlier: Math.max(0, window.earlier),
      omitted: Math.max(0, window.omitted),
      pending: sessions.permissions.list(id),
      terminals: sessions.terminals.list(id),
      terminalsAvailable: sessions.terminals.available,
      catalog: sessions.catalog,
      projects: projectList(),
      chats: recentChats(),
    });

    // The model list only exists once an agent has started. Warm it in the
    // background on a cold host so the picker fills shortly after you look at
    // it, rather than staying empty until the first prompt.
    if (!sessions.catalog.models.length) {
      sessions.ensureLive(id).catch((err) => console.error(`[catalog] ${err.message}`));
    }
  },

  async prompt(ws, state, msg) {
    const id = msg.sessionId || state.sessionId;
    // Deliberately not awaited: the turn streams over the socket, and the
    // caller should not be blocked for its whole duration.
    sessions.prompt(id, { text: msg.text, images: msg.images || [] }).catch((err) => {
      console.error(`[prompt] ${err.message}`);
      // Whoever typed it is owed the reason. This used to be logged and
      // nowhere else, so a refused message just vanished from the screen.
      send(ws, { type: 'error', message: err.message });
    });
  },

  cancel(_ws, state, msg) {
    sessions.cancel(msg.sessionId || state.sessionId);
  },

  /**
   * What is waiting behind the turn, and the three things that can be done to it.
   *
   * Each answer carries the queue as it is afterwards, since these come from a
   * phone: the list on screen has to be right without waiting for a poll.
   */
  async 'queue.list'(ws, state, msg) {
    const id = msg.sessionId || state.sessionId;
    send(ws, { type: 'queue', sessionId: id, ...(await sessions.queued(id)) });
  },

  async 'queue.drop'(ws, state, msg) {
    const id = msg.sessionId || state.sessionId;
    const result = await sessions.dropQueued(id, msg.itemId);
    send(ws, { type: 'queue', sessionId: id, acted: result, ...(await sessions.queued(id)) });
  },

  async 'queue.now'(ws, state, msg) {
    const id = msg.sessionId || state.sessionId;
    const result = await sessions.sendQueuedNow(id, msg.itemId);
    send(ws, { type: 'queue', sessionId: id, acted: result, ...(await sessions.queued(id)) });
  },

  async 'queue.edit'(ws, state, msg) {
    const id = msg.sessionId || state.sessionId;
    const result = await sessions.editQueued(id, msg.itemId, msg.text);
    send(ws, { type: 'queue', sessionId: id, acted: result, ...(await sessions.queued(id)) });
  },

  permission(_ws, _state, msg) {
    sessions.permissions.resolve(msg.requestId, msg.optionId, { by: msg.by || 'web' });
  },

  async 'question.answer'(ws, state, msg) {
    const id = msg.sessionId || state.sessionId;
    const result = await sessions.answerQuestion(id, {
      askId: msg.askId,
      selections: msg.selections || {},
      texts: msg.texts || {},
      skip: Boolean(msg.skip),
    });
    send(ws, { type: 'question.answer', sessionId: id, askId: msg.askId, ...result });
  },

  async 'plan.build'(ws, state, msg) {
    const id = msg.sessionId || state.sessionId;
    const result = await sessions.buildPlan(id, {
      toolCallId: msg.toolCallId,
      model: msg.model || '',
    });
    send(ws, { type: 'plan.build', sessionId: id, toolCallId: msg.toolCallId, ...result });
  },

  async 'session.create'(ws, state, msg) {
    // The web client offers a folder by hand as well as from the project list,
    // so a path that names nothing must be refused rather than spawn an agent
    // that cannot see its own working directory.
    const folder = msg.folder ? normalizeFolder(msg.folder) : undefined;
    if (folder && !existsSync(folder)) throw new Error(`No such folder: ${folder}`);
    const meta = await sessions.startInIde({ folder, title: msg.title });
    return OPS.attach(ws, state, { sessionId: meta.id });
  },

  async 'sessions.sync'(ws) {
    const adopted = await sessions.syncFromAgent();
    send(ws, { type: 'synced', adopted, sessions: sessions.list() });
  },

  'projects.list'(ws) {
    send(ws, { type: 'projects', projects: projectList() });
  },

  /** Cursor's recent chats, for the rail. */
  'desktop.recent'(ws) {
    send(ws, { type: 'desktopRecent', chats: recentChats() });
  },

  'desktop.chats'(ws, state, msg) {
    send(ws, {
      type: 'desktopChats',
      folder: msg.folder,
      chats: desktopChatsFor(msg.folder),
    });
  },

  async 'desktop.continue'(ws, state, msg) {
    const meta = await sessions.attachDesktopThread({
      threadId: msg.chatId,
      folder: msg.folder,
    });
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

  async 'usage.get'(ws, state, msg) {
    const id = msg.sessionId || state.sessionId;
    const usage = await sessions.usage(id, { force: Boolean(msg.force) });
    send(ws, { type: 'usage', sessionId: id, ...usage });
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
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** Third-party browser assets, served straight out of node_modules. */
const VENDOR = {
  '/vendor/xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js',
  '/vendor/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
  '/vendor/addon-fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js',
};

/**
 * Serve a file, and let the browser keep it.
 *
 * Everything here used to be `no-store`, so every load pulled the whole client
 * down again — half a megabyte of terminal emulator among it — before a single
 * record could be drawn. Caching it outright would be worse: Auto edits its own
 * front end, and a stale one is unfixable from a phone. So the browser is told
 * to ask every time and given a tag it can ask with. Nothing changed means an
 * empty 304; a file that changed has a different size or timestamp, which
 * breaks the cache by itself with nothing to remember to bump.
 *
 * iOS Home Screen apps ignore that for a named file. The shell (`index.html`)
 * is therefore `no-store`, and every css/js URL in it carries a `?v=` of the
 * file's size and mtime. A change is a new URL, so the installed app downloads
 * it instead of keeping the first stylesheet it ever saw.
 */
function assetTag(urlPath) {
  const file = VENDOR[urlPath] ? join(ROOT, VENDOR[urlPath]) : join(WEB, urlPath);
  try {
    return fileTag(file);
  } catch {
    return '0';
  }
}

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
    if (rel === '/index.html') {
      const html = stampHtml(readFileSync(file, 'utf8'), assetTag);
      const etag = `W/"${createHash('sha1').update(html).digest('base64url').slice(0, 16)}"`;
      const headers = {
        'Content-Type': CONTENT_TYPES['.html'],
        'Cache-Control': 'no-store',
        ETag: etag,
      };
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers);
        res.end();
        return;
      }
      res.writeHead(200, headers);
      res.end(html);
      return;
    }
    const stat = statSync(file);
    const etag = `W/"${stat.size.toString(36)}-${Math.round(stat.mtimeMs).toString(36)}"`;
    const headers = {
      'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ETag: etag,
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, headers);
    res.end(readFileSync(file));
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

const server = createServer((req, res) => {
  // A failing route must not take the host down with it: Auto is the thing
  // you use to fix Auto, so it has to survive its own bad days.
  route(req, res).catch((err) => {
    console.error(`[http] ${req.method} ${req.url}: ${err.stack || err.message}`);
    if (!res.headersSent) json(res, { error: err.message }, 500);
    else res.end();
  });
});

async function route(req, res) {
  const { pathname, searchParams } = new URL(req.url, 'http://localhost');

  if (pathname === '/api/health') {
    return json(res, {
      ok: true,
      sessions: sessions.list().length,
      live: sessions.liveCount(),
      watching: sessions.watchingCount(),
      activeId: sessions.activeId,
      telegram: telegram.running,
      ...hostIdentity.snapshot(),
    });
  }

  if (pathname === '/api/sessions' || (pathname === '/api/session' && req.method === 'GET')) {
    return json(res, { sessions: sessions.list(), activeId: sessions.activeId });
  }

  if (pathname === '/api/projects') {
    return json(res, { projects: projectList() });
  }

  if (pathname === '/api/desktop-chats') {
    const folder = searchParams.get('folder');
    return json(res, { folder, chats: desktopChatsFor(folder) });
  }

  // Point the active session at a folder, reusing a session already on it.
  // This is the contract the switch-repo skill depends on.
  if (pathname === '/api/session' && req.method === 'POST') {
    const body = await readBody(req);
    const folder = body.folder ? normalizeFolder(body.folder) : null;
    if (!folder) return json(res, { error: 'folder is required' }, 400);
    if (!existsSync(folder)) return json(res, { error: `No such folder: ${folder}` }, 400);

    let meta = sessions.list().find((s) => sameFolder(s.folder, folder));
    if (!meta) meta = await sessions.startInIde({ folder, title: body.title });
    sessions.setActive(meta.id);
    return json(res, { session: sessions.get(meta.id), activeId: sessions.activeId });
  }

  // Restart from a shell or from an agent working on this repo. Answers first,
  // then waits for work to finish before exiting.
  if (pathname === '/api/restart' && req.method === 'POST') {
    const body = await readBody(req);
    json(res, { ok: true, restarting: true });
    restartHost({ reason: body.reason || 'api' });
    return undefined;
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
}

// ----------------------------------------------------------------- websocket

/**
 * Everything a client is told is JSON, and JSON of this shape — the same keys
 * over and over, the same command echoed in a call and its result — compresses
 * by about tenfold. On a phone that is the difference between a replay arriving
 * and a replay timing out, so the socket negotiates deflate. Only messages
 * worth the CPU are compressed; a keystroke is not.
 */
const wss = new WebSocketServer({
  server,
  perMessageDeflate: {
    threshold: 2048,
    zlibDeflateOptions: { level: 6, memLevel: 8 },
    concurrencyLimit: 10,
    // Contexts are what make deflate expensive to hold; a chat is bursty and
    // long-lived, so let both ends drop theirs between bursts.
    clientNoContextTakeover: true,
    serverNoContextTakeover: true,
  },
});

wss.on('connection', async (ws, req) => {
  const state = { sessionId: null, browser: false };
  clients.set(ws, state);

  send(ws, {
    type: 'hello',
    sessions: sessions.list(),
    activeId: sessions.activeId,
    policies: Object.values(POLICY),
    chats: recentChats(),
    host: hostIdentity.snapshot(),
  });
  // A client says which chat it was in, in the URL, because the first thing
  // this socket does is replay and there is no room for a question first. A
  // refresh and a dropped connection both come through here; without the
  // session id, this would open whichever chat is active, not the one the tab
  // had. An archived id is treated as missing.
  const asked = new URL(req.url || '/', 'http://localhost').searchParams;
  const wanted = asked.get('session');
  const askedMeta = wanted && sessions.get(wanted);
  const known =
    askedMeta && askedMeta.status !== STATUS.archived ? wanted : sessions.activeId;
  try {
    await OPS.attach(ws, state, {
      sessionId: known,
      fromSeq: known === wanted ? Number(asked.get('fromSeq')) || 0 : 0,
    });
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

// ------------------------------------------------------------------- restart

/**
 * Restart the host from inside it, which is how Auto applies changes to its
 * own code. Exiting is enough: the supervisor starts us again.
 *
 * The catch is that a session lives in a child process, so an immediate exit
 * would kill the very turn that asked for the restart. So we wait for work to
 * finish first, and leave a note to announce ourselves when we return.
 */
const RESTART_MARKER = join(ROOT, 'state', 'restarting.json');
let restartPending = false;

async function restartHost({ reason = 'requested', maxWaitMs = 180_000 } = {}) {
  if (restartPending) return 'already restarting';
  restartPending = true;

  broadcast({ type: 'host.restarting', reason });
  // Only our own agents live in this process's children. A desktop chat's turn
  // belongs to Cursor and carries on whatever the host does, so waiting for one
  // is waiting for someone else's work — it held a restart for eleven minutes
  // while the change that restart was meant to apply sat unused.
  const busy = () =>
    sessions.list().some((s) => s.status === 'busy' && s.kind !== 'desktop');
  if (busy()) {
    await telegram.send('Restarting once the current turn finishes…').catch(() => {});
    const until = Date.now() + maxWaitMs;
    while (busy() && Date.now() < until) await new Promise((r) => setTimeout(r, 500));
  }

  writeFileSync(
    RESTART_MARKER,
    JSON.stringify({ at: Date.now(), reason, telegram: telegram.running }),
  );
  console.log(`[auto] restarting (${reason})`);
  // Give the socket write and the marker a tick to land before we go.
  setTimeout(() => process.exit(0), 250);
  return 'restarting';
}

OPS['host.restart'] = (_ws, _state, msg) => restartHost({ reason: msg.reason || 'web' });

OPS['host.setNick'] = (_ws, _state, msg) => {
  const host = hostIdentity.setNick(msg.nick);
  broadcast({ type: 'host', host });
  return host;
};

/** Announce the return, so a restart requested from a phone visibly completes. */
function announceRestart() {
  if (!existsSync(RESTART_MARKER)) return;
  let note = null;
  try {
    note = JSON.parse(readFileSync(RESTART_MARKER, 'utf8'));
  } catch {
    /* a corrupt marker is not worth failing a boot over */
  }
  rmSync(RESTART_MARKER, { force: true });
  const secs = note?.at ? Math.max(1, Math.round((Date.now() - note.at) / 1000)) : null;
  telegram
    .send(`♻️ Auto is back${secs ? ` after ${secs}s` : ''} — sessions resume where they left off.`)
    .catch(() => {});
}

/**
 * Keep Cursor's desktop bridge able to start.
 *
 * Cursor wipes the flag that permits local feature-gate overrides whenever it
 * refreshes its server config, and only reads that flag at startup — so the
 * bridge works until the next restart and then silently stops. Re-asserting
 * costs a read, writes only when something was cleared, and means Auto can
 * still reach the desktop's threads tomorrow. Only worth doing once someone
 * has turned the bridge on: never enable it behind the user's back.
 */
function keepBridgeEnabled() {
  const tick = () => {
    try {
      if (!storageAvailable()) return;
      const state = gateState();
      // A gate we never set is not ours to turn on.
      if (!state.userEnabled) return;
      const changed = assertSwitches();
      if (changed.length) console.log(`[bridge] re-asserted ${changed.length} switch(es)`);
    } catch (err) {
      console.error(`[bridge] could not check the desktop bridge switches: ${err.message}`);
    }
  };
  tick();
  // Often, because the only moment that matters is the one Cursor happens to
  // start in: whatever the flag says then is what that window believes for the
  // rest of its life. A minute of being wrong was a whole day without a bridge.
  setInterval(tick, 15_000).unref();
}

server.listen(PORT, HOST, () => {
  console.log(`[auto] http://127.0.0.1:${PORT}  (${sessions.list().length} sessions)`);
  announceRestart();
  keepBridgeEnabled();
  // Threads in the IDE keep moving whether or not Auto is watching, so pick
  // them back up: a reply typed into Cursor should still reach the phone.
  const watching = sessions.watchDesktopThreads().then((n) => {
    if (n) console.log(`[auto] following ${n} desktop thread(s)`);
  });
  watching.catch((err) => console.error(`[auto] watching desktop threads: ${err.message}`));
  const waiting = sessions.resumeDesktopOutbox();
  if (waiting) console.log(`[auto] ${waiting} message(s) still waiting for the desktop`);
  // Pick up sessions started outside Auto. Costs one short-lived agent
  // process, so do it once at boot rather than on every attach.
  sessions
    .syncFromAgent()
    .then((n) => n && broadcast({ type: 'sessions', sessions: sessions.list() }))
    .catch((err) => console.error(`[sync] ${err.message}`));
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
