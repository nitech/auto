#!/usr/bin/env node
/**
 * The other direction: something happens in the thread without Auto asking.
 *
 * Sends straight through the bridge, bypassing Auto entirely — from the
 * host's point of view that is indistinguishable from someone typing in the
 * IDE. Both the message and the reply should still turn up in Auto.
 */
import { WebSocket } from 'ws';
import { sendMessage } from '../src/core/desktop-bridge.mjs';

const threadId = process.argv[2];
const prompt = process.argv[3] || 'In one short sentence: what is a deadlock?';
const ws = new WebSocket('ws://127.0.0.1:4331/ws');
let sessionId = null;
let sawUser = false;

ws.on('open', () => ws.send(JSON.stringify({ op: 'sessions' })));

ws.on('message', async (raw) => {
  const msg = JSON.parse(raw);

  if (msg.type === 'sessions' && !sessionId) {
    const session = msg.sessions.find((s) => s.desktopThreadId === threadId);
    if (!session) {
      console.error('Auto has no session for that thread yet — open it first.');
      process.exit(1);
    }
    sessionId = session.id;
    ws.send(JSON.stringify({ op: 'attach', sessionId }));
    setTimeout(async () => {
      console.log(`sending outside Auto: ${prompt}`);
      console.log(JSON.stringify(await sendMessage({ threadId, text: prompt })));
    }, 800);
  }

  if (msg.type === 'record') {
    const r = msg.record;
    if (r.kind === 'user_message') {
      console.log(`  [user seen by Auto] ${r.text}`);
      sawUser = true;
    }
    if (r.kind === 'turn_start') console.log('  — working —');
    if (r.kind === 'agent_delta') {
      console.log(`  [assistant] ${String(r.text).slice(0, 160)}`);
      console.log(
        sawUser
          ? '\nAuto followed a conversation it was not part of. Both ends, one thread.'
          : '\nThe reply arrived, but Auto missed the message that caused it.',
      );
      process.exit(sawUser ? 0 : 1);
    }
  }
});

ws.on('error', (err) => {
  console.error(`socket: ${err.message}`);
  process.exit(1);
});
setTimeout(() => {
  console.error('Timed out.');
  process.exit(1);
}, 90_000);
