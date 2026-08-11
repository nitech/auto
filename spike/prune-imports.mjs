#!/usr/bin/env node
/** Archive the imported sessions left behind by testing. */
import { WebSocket } from 'ws';

const PORT = Number(process.env.AUTO_PORT || 4331);
const { sessions } = await fetch(`http://127.0.0.1:${PORT}/api/session`).then((r) => r.json());
const doomed = sessions.filter((s) => s.importedFrom);
if (!doomed.length) {
  console.log('nothing to prune');
  process.exit(0);
}

const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
await new Promise((r) => ws.on('open', r));
for (const s of doomed) {
  console.log(`archiving ${s.title}`);
  ws.send(JSON.stringify({ op: 'session.archive', sessionId: s.id }));
}
await new Promise((r) => setTimeout(r, 1500));
ws.close();
process.exit(0);
