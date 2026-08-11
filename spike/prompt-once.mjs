#!/usr/bin/env node
/**
 * Send one prompt to the running host's active session and print the reply.
 *
 *   node spike/prompt-once.mjs "what is 2+2?"
 *   node spike/prompt-once.mjs --port=4340 "hello"
 */
import { WebSocket } from 'ws';

const args = process.argv.slice(2);
const portArg = args.find((a) => a.startsWith('--port='));
const port = portArg ? portArg.slice(7) : 4331;
const text = args.filter((a) => !a.startsWith('--')).join(' ');

if (!text) {
  console.error('usage: node spike/prompt-once.mjs "your prompt"');
  process.exit(1);
}

const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
let sent = false;
let reply = '';

ws.on('message', (raw) => {
  const msg = JSON.parse(raw);

  if (msg.type === 'attached' && !sent) {
    sent = true;
    console.log(`session: ${msg.meta.title} (${msg.meta.model ?? 'no model yet'})`);
    ws.send(JSON.stringify({ op: 'prompt', text }));
    return;
  }

  if (msg.type !== 'record') return;
  const rec = msg.record;

  if (rec.kind === 'agent_delta') reply += rec.text || '';
  if (rec.kind === 'tool_call') console.log(`  · ${rec.title || rec.toolKind}`);
  if (rec.kind === 'error') console.log(`  ! ${rec.text}`);

  if (rec.kind === 'turn_end') {
    console.log(`\n${reply.trim()}\n`);
    console.log(`stopReason: ${rec.stopReason}`);
    process.exit(0);
  }
});

ws.on('error', (err) => {
  console.error(`FAIL: ${err.message}`);
  process.exit(1);
});

setTimeout(() => {
  console.error('FAIL: timed out');
  process.exit(1);
}, 180_000);
