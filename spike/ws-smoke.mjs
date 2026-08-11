#!/usr/bin/env node
/**
 * Smoke client for the v2 socket: connects, prompts, auto-approves permissions,
 * and prints a compact view of the resulting transcript.
 *
 * `--delay=N` holds the approval for N seconds, which is how we probe how long
 * the agent's upstream connection tolerates a human thinking about it.
 *
 *   node spike/ws-smoke.mjs [--port=4340] [--delay=20] "prompt text"
 */
import WebSocket from 'ws';

const portArg = process.argv.find((a) => a.startsWith('--port='));
const PORT = portArg ? Number(portArg.slice(7)) : 4340;
const delayArg = process.argv.find((a) => a.startsWith('--delay='));
const DELAY_MS = delayArg ? Number(delayArg.slice(8)) * 1000 : 0;
const PROMPT =
  process.argv.slice(2).filter((a) => !a.startsWith('--')).join(' ') ||
  'Run: echo smoke-ok . Then say DONE.';

const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
const seen = new Map();
let started = false;
let stream = '';

const t0 = Date.now();
const stamp = () => `${String((Date.now() - t0) / 1000).padStart(6, ' ')}s`;

function note(kind, text) {
  seen.set(kind, (seen.get(kind) || 0) + 1);
  if (text) console.log(`${stamp()} ${kind.padEnd(20)} ${text}`);
}

ws.on('open', () => console.log(`connected :${PORT}`));

ws.on('message', (buf) => {
  const msg = JSON.parse(buf.toString());

  if (msg.type === 'hello') {
    console.log(`session ${msg.sessionId} (${msg.records.length} existing records)`);
    if (!started) {
      started = true;
      console.log(`--> prompt: ${PROMPT}\n`);
      ws.send(JSON.stringify({ op: 'prompt', text: PROMPT }));
    }
    return;
  }
  if (msg.type !== 'record') return;

  const r = msg.record;
  switch (r.kind) {
    case 'agent_delta':
      stream += r.text || '';
      seen.set('agent_delta', (seen.get('agent_delta') || 0) + 1);
      break;
    case 'agent_thought':
      seen.set('agent_thought', (seen.get('agent_thought') || 0) + 1);
      break;
    case 'tool_call':
      note('tool_call', `${r.toolKind} · ${r.title} · input=${JSON.stringify(r.rawInput)}`);
      break;
    case 'tool_update':
      note(
        'tool_update',
        `${r.status}${r.rawOutput ? ` · out=${JSON.stringify(r.rawOutput).slice(0, 200)}` : ''}`,
      );
      break;
    case 'permission_request': {
      const opt =
        (r.options || []).find((o) => /allow_once|allow-once/i.test(o.optionId || '')) ||
        (r.options || []).find((o) => /allow/i.test(o.kind || o.optionId || '')) ||
        (r.options || [])[0];
      note(
        'permission_request',
        `${r.toolCall?.title} -> "${opt?.optionId}" after ${DELAY_MS / 1000}s`,
      );
      setTimeout(() => {
        ws.send(
          JSON.stringify({ op: 'permission', requestId: r.requestId, optionId: opt?.optionId }),
        );
        note('permission_sent', '');
      }, DELAY_MS);
      break;
    }
    case 'turn_end':
      note('turn_end', r.stopReason);
      console.log(`\n---- assistant text ----\n${stream.trim()}\n------------------------`);
      console.log(`kinds: ${[...seen.entries()].map(([k, n]) => `${k}×${n}`).join(', ')}`);
      ws.close();
      process.exit(/error/i.test(stream) ? 1 : 0);
      break;
    case 'error':
      note('error', r.text);
      break;
    default:
      break;
  }
});

ws.on('error', (e) => {
  console.error(`socket error: ${e.message}`);
  process.exit(1);
});

setTimeout(() => {
  console.error('timeout');
  process.exit(2);
}, 180_000);
