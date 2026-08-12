#!/usr/bin/env node
/**
 * End to end, the way a phone does it: open a desktop chat as an Auto
 * session over the host's socket, send a message, and wait for the desktop
 * agent's reply to arrive as transcript records.
 */
import { WebSocket } from 'ws';

const threadId = process.argv[2];
const prompt = process.argv[3] || 'In one short sentence, what is a named pipe?';
const ws = new WebSocket('ws://127.0.0.1:4331/ws');

const seen = [];
let sessionId = null;
let answered = false;
let sent = false;

const send = (msg) => ws.send(JSON.stringify(msg));

ws.on('open', () => {
  console.log('connected; opening the desktop chat as a session');
  send({ op: 'desktop.continue', chatId: threadId, folder: process.cwd() });
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw);

  if (msg.type === 'attached' || msg.type === 'session') {
    sessionId = msg.sessionId || msg.session?.id || sessionId;
  }
  if (msg.type === 'sessions' && !sessionId) {
    const desktop = msg.sessions.find((s) => s.desktopThreadId === threadId);
    if (desktop) sessionId = desktop.id;
  }

  if ((msg.type === 'history' || msg.type === 'attached') && !sent) {
    const records = msg.records || msg.history || [];
    console.log(`history: ${records.length} records`);
    sent = true;
    setTimeout(() => {
      console.log(`sending: ${prompt}`);
      send({ op: 'prompt', sessionId, text: prompt });
    }, 500);
  }

  if (msg.type === 'record') {
    const r = msg.record;
    seen.push(r.kind);
    if (r.kind === 'user_message') console.log(`  [user] ${r.text}`);
    if (r.kind === 'agent_thought') console.log(`  [thinking] ${String(r.text).slice(0, 80)}…`);
    if (r.kind === 'tool_call') console.log(`  [tool] ${r.title}`);
    if (r.kind === 'notice') console.log(`  [notice] ${r.text}`);
    if (r.kind === 'error') console.log(`  [error] ${r.text}`);
    if (r.kind === 'turn_start') console.log('  — the desktop agent is working —');
    if (r.kind === 'agent_delta') {
      console.log(`  [assistant] ${String(r.text).slice(0, 200)}`);
      answered = true;
    }
    if (r.kind === 'turn_end' && answered) {
      console.log('\nThe reply came back through Auto. Same thread, both ends.');
      ws.close();
      process.exit(0);
    }
  }
});

ws.on('error', (err) => {
  console.error(`socket: ${err.message}`);
  process.exit(1);
});

setTimeout(() => {
  console.error(`\nTimed out. Records seen: ${seen.join(', ') || 'none'}`);
  process.exit(1);
}, 90_000);
