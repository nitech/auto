/**
 * The real thing, end to end: send a prompt the way the web UI sends one, to
 * a desktop-backed session, while Cursor's bridge is actually refusing. What
 * should happen is that the message is kept and explained, not lost.
 *
 * Usage: node spike/outbox-live.mjs <sessionId> [text]
 */
import { WebSocket } from 'ws';

const sessionId = process.argv[2];
const text = process.argv[3] || '(auto bridge check — please ignore)';
if (!sessionId) throw new Error('need a session id');

const ws = new WebSocket('ws://127.0.0.1:4331');
const seen = [];

ws.on('open', () => ws.send(JSON.stringify({ op: 'attach', sessionId, fromSeq: 0 })));

ws.on('message', (raw) => {
  const msg = JSON.parse(raw);
  // The host announces the active session too, which is not the one we asked
  // about — prompting on that one would send this to a stranger.
  if (msg.type === 'attached' && msg.meta?.id === sessionId) {
    console.log(`attached: ${msg.meta?.title} (${msg.meta?.kind}) status=${msg.meta?.status}`);
    console.log(`sending: ${text}`);
    ws.send(JSON.stringify({ op: 'prompt', sessionId, text }));
    return;
  }
  if (msg.type === 'record') seen.push(msg.record);
  if (msg.type === 'error') seen.push({ kind: 'ws-error', text: msg.message });
});

setTimeout(() => {
  console.log(`\nrecords after the prompt (${seen.length}):`);
  for (const r of seen) console.log(`  ${r.kind}: ${String(r.text || '').slice(0, 220)}`);
  ws.close();
  process.exit(0);
}, 6000);
