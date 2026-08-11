#!/usr/bin/env node
/**
 * End to end, the way the phone does it: list the desktop's chats, continue
 * one, and check the agent actually has the history.
 */
import { WebSocket } from 'ws';

const PORT = Number(process.env.AUTO_PORT || 4331);
const folder = process.argv[2] || 'D:\\Sevenfold\\auto';
const question =
  'Without using any tools: in one sentence, what was this conversation about, and name one specific detail from it.';

const chats = await fetch(
  `http://127.0.0.1:${PORT}/api/desktop-chats?folder=${encodeURIComponent(folder)}`,
).then((r) => r.json());

// Skip the newest: that one is probably open in the IDE right now.
const named = chats.chats.filter((c) => c.title !== 'Untitled chat');
const fresh = named.filter((c) => !c.imported);
const chat = fresh[1] || fresh[0] || named[1] || named[0];
if (!chat) {
  console.log('no desktop chat to try');
  process.exit(0);
}

// If it has been continued already, reuse that session rather than copying
// the whole conversation a second time.
const existing = await fetch(`http://127.0.0.1:${PORT}/api/session`)
  .then((r) => r.json())
  .then((s) => s.sessions.find((x) => x.importedFrom === chat.id));

console.log(`${existing ? 'reusing' : 'continuing'} desktop chat: ${chat.title}`);

const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
let sessionId = null;
let answer = '';
let asked = false;

const done = new Promise((resolve, reject) => {
  setTimeout(() => reject(new Error('timed out')), 180_000);

  ws.on('open', () => {
    ws.send(
      JSON.stringify(
        existing
          ? { op: 'attach', sessionId: existing.id }
          : { op: 'desktop.continue', chatId: chat.id, folder },
      ),
    );
  });

  ws.on('message', (buf) => {
    const msg = JSON.parse(buf.toString());

    // The server attaches every new socket to the active session, so wait for
    // the attach that belongs to the chat we just continued.
    if (msg.type === 'attached' && !asked && msg.meta?.importedFrom === chat.id) {
      console.log(`transcript holds ${msg.records?.length || 0} recorded events`);
      sessionId = msg.sessionId;
      asked = true;
      console.log(`attached to session ${sessionId} (${msg.meta?.title})`);
      ws.send(JSON.stringify({ op: 'prompt', sessionId, text: question }));
    }

    if (msg.type === 'record' && msg.record?.kind === 'agent_delta') {
      answer += msg.record.text || '';
    }
    if (msg.type === 'record' && msg.record?.kind === 'turn_end') resolve();
    if (msg.type === 'error') console.log(`error: ${msg.message}`);
  });

  ws.on('error', reject);
});

await done;
ws.close();
console.log(`\nanswer: ${answer.trim().slice(0, 600)}`);
process.exit(0);
