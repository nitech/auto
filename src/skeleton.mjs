#!/usr/bin/env node
/**
 * M1 walking skeleton.
 *
 * One ACP session, prompt in, the complete update stream out over WebSocket to
 * a deliberately unstyled page. Exists to answer one question before any UI is
 * built: does the stream carry everything the desktop Agents window shows?
 *
 *   node src/skeleton.mjs [--port=4340] [--folder=D:\some\repo]
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { AcpClient } from './acp/client.mjs';
import { TranscriptStore, KIND } from './core/transcript.mjs';
import { mapUpdate } from './core/map-updates.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const PORT = Number(arg('port', '4340')) || 4340;
const FOLDER = arg('folder', ROOT);

const store = new TranscriptStore(join(ROOT, 'state', 'transcripts'));
const sockets = new Set();
const pendingPermissions = new Map();
let transcript = null;
let sessionId = null;
let sessionMeta = null;
let busy = false;

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of sockets) {
    if (ws.readyState === 1) ws.send(data);
  }
}

function record(kind, payload) {
  if (!transcript) return null;
  const rec = transcript.append(kind, payload);
  broadcast({ type: 'record', record: rec });
  return rec;
}

const agent = new AcpClient({
  cwd: FOLDER,
  handlers: {
    /** Real approve/deny round-trip: park the request until a client answers. */
    requestPermission: (params) =>
      new Promise((resolve) => {
        const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const options = params?.options || [];
        record(KIND.permissionRequest, {
          requestId,
          toolCall: params?.toolCall,
          options,
        });
        pendingPermissions.set(requestId, { resolve, options });
      }),

    readTextFile: ({ path }) => ({ content: readFileSync(path, 'utf8') }),
  },
});

agent.on('log', (m) => console.log(`[acp] ${m}`));
agent.on('stderr', (s) => {
  const t = s.trim();
  if (t) console.error(`[acp:err] ${t.slice(0, 400)}`);
});
agent.on('exit', ({ code, signal }) => {
  console.error(`[acp] agent exited code=${code} signal=${signal}`);
  record(KIND.error, { text: `Agent process exited (code ${code ?? signal}).` });
});

agent.on('update', ({ update }) => {
  const mapped = mapUpdate(update);
  if (mapped) record(mapped.kind, mapped.payload);
});

async function boot() {
  const info = await agent.start();
  console.log(`[skeleton] ACP ready, protocol v${info.protocolVersion}`);

  const session = await agent.newSession({ cwd: FOLDER });
  sessionId = session.sessionId;
  sessionMeta = {
    modes: session.modes,
    models: session.models,
    folder: FOLDER,
  };
  transcript = await store.get(sessionId);
  record(KIND.sessionStart, { folder: FOLDER, agentInfo: info, session: sessionMeta });
  console.log(`[skeleton] session ${sessionId} in ${FOLDER}`);
}

async function handlePrompt(text) {
  if (!text?.trim() || busy) return;
  busy = true;
  record(KIND.userMessage, { text });
  record(KIND.turnStart, {});
  broadcast({ type: 'busy', busy });
  try {
    const res = await agent.prompt({
      sessionId,
      prompt: [{ type: 'text', text }],
    });
    record(KIND.turnEnd, { stopReason: res?.stopReason });
  } catch (err) {
    record(KIND.error, { text: err?.message || String(err) });
  } finally {
    busy = false;
    broadcast({ type: 'busy', busy });
  }
}

const PAGE = readFileSync(join(HERE, 'skeleton.html'), 'utf8');

const server = createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(PAGE);
    return;
  }
  res.writeHead(404).end('not found');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  sockets.add(ws);
  ws.send(
    JSON.stringify({
      type: 'hello',
      sessionId,
      meta: sessionMeta,
      busy,
      records: transcript ? transcript.readFrom(0) : [],
    }),
  );

  ws.on('message', (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }
    if (msg.op === 'prompt') handlePrompt(msg.text);
    else if (msg.op === 'cancel') {
      try {
        agent.cancel(sessionId);
        record(KIND.error, { text: 'Cancel requested.' });
      } catch (e) {
        console.error(e);
      }
    } else if (msg.op === 'permission') {
      const entry = pendingPermissions.get(msg.requestId);
      if (!entry) return;
      pendingPermissions.delete(msg.requestId);
      record(KIND.permissionResolved, { requestId: msg.requestId, optionId: msg.optionId });
      entry.resolve({ outcome: { outcome: 'selected', optionId: msg.optionId } });
    }
  });

  ws.on('close', () => sockets.delete(ws));
});

await boot();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[skeleton] http://127.0.0.1:${PORT}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await agent.stop();
    process.exit(0);
  });
}
