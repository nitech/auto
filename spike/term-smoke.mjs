#!/usr/bin/env node
/**
 * Terminal smoke test: open a user PTY over the WebSocket, type a command,
 * and confirm its output comes back as transcript records.
 *
 *   node spike/term-smoke.mjs [--port=4340]
 */
import WebSocket from 'ws';

const port = Number(process.argv.find((a) => a.startsWith('--port='))?.slice(7) || 4340);
const ws = new WebSocket(`ws://127.0.0.1:${port}`);

let terminalId = null;
let seen = '';

const send = (m) => ws.send(JSON.stringify(m));

// The host attaches us to the active session on connect, so we do not ask.
ws.on('message', (buf) => {
  const msg = JSON.parse(buf.toString());

  if (msg.type === 'attached') {
    console.log(`attached ${msg.sessionId} terminals=${msg.terminals?.length ?? 0}`);
    send({ op: 'terminal.open', cols: 100, rows: 24 });
    return;
  }

  if (msg.type === 'terminal.opened' && !terminalId) {
    terminalId = msg.terminal.terminalId;
    console.log(`terminal opened: ${terminalId} (${msg.terminal.title})`);
    setTimeout(() => send({ op: 'terminal.input', terminalId, data: 'echo smoke-ok\r' }), 700);
    return;
  }

  if (msg.type === 'record' && msg.record.kind === 'terminal_chunk') {
    if (msg.record.text) {
      seen += msg.record.text;
      process.stdout.write(msg.record.text);
    }
    if (seen.includes('smoke-ok') && seen.split('smoke-ok').length > 2) {
      console.log('\n\nPASS: input reached the PTY and output streamed back');
      send({ op: 'terminal.close', terminalId });
      setTimeout(() => process.exit(0), 200);
    }
  }

  if (msg.type === 'error') console.error(`ERROR: ${msg.message}`);
});

setTimeout(() => {
  console.error(`\n\nFAIL: timed out. saw ${JSON.stringify(seen.slice(-200))}`);
  process.exit(1);
}, 15000);
