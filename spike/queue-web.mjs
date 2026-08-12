/**
 * Does the queue reach a phone, and do a phone's buttons reach Cursor?
 *
 * Goes the whole way round: queue three throwaway messages behind a slow turn in
 * a scratch chat, continue that chat in Auto, then speak to the host over the
 * same socket the web app uses — list the queue, delete one, send one now — and
 * check the window agrees each time.
 *
 * Everything happens in a scratch chat and its session is archived afterwards,
 * with the active session put back where it was.
 *
 * Usage: node spike/queue-web.mjs
 */
import { WebSocket } from 'ws';
import { CursorCdp } from '../src/core/cursor-cdp.mjs';

const HOST = 'ws://127.0.0.1:4331/ws';
const NEW_CHAT = 'New Agent (Ctrl+N) [Alt] Replace Agent';
const SLOW =
  'Write 60 numbered lines, each a full sentence about a different number between 1 and 60. ' +
  'Do not use any tools and do not touch any files.';
const WORDS = ['pineapple', 'wheelbarrow', 'trombone'];
const said = (word) => `Afterwards, say the word ${word}.`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const cursor = new CursorCdp();
const say = (step, detail) => console.log(`${step.padEnd(18)} ${detail}`);

const home = (await cursor.windows()).find((w) => w.hasComposer)?.threadId;
await cursor.press({ threadId: home, name: NEW_CHAT });
await wait(1500);
const scratch = (await cursor.windows()).find((w) => w.hasComposer && w.threadId !== home)?.threadId;
if (!scratch) {
  say('no scratch chat', 'giving up rather than queueing onto a real one');
  process.exit(1);
}
say('scratch chat', String(scratch));
await cursor.sendText({ threadId: scratch, text: SLOW });
await wait(2500);
for (const word of WORDS) {
  await cursor.sendText({ threadId: scratch, text: said(word) });
  await wait(800);
}

// Whichever session is active is where Telegram sends, and this steals it for a
// scratch chat, so remember it now rather than guessing at the end.
const wasActive = await fetch('http://127.0.0.1:4331/api/sessions')
  .then((r) => r.json())
  .then((j) => j.activeId)
  .catch(() => null);
say('active before', String(wasActive));

const ws = new WebSocket(HOST);
const seen = [];
ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw));
  seen.push(msg);
});
await new Promise((resolve, reject) => {
  ws.once('open', resolve);
  ws.once('error', reject);
});

const send = (op) => ws.send(JSON.stringify(op));
/** Wait for the next message of a kind, and hand it back. */
const next = async (type, within = 15000) => {
  const from = seen.length;
  for (let waited = 0; waited < within; waited += 100) {
    const found = seen.slice(from).find((m) => m.type === type);
    if (found) return found;
    await wait(100);
  }
  return null;
};

// The host greets a new client with whatever session is active; let that land
// before asking for ours, or its answer gets mistaken for this one's.
await next('attached');
send({ op: 'desktop.continue', chatId: scratch, folder: process.cwd() });
const attached = await next('attached');
say('continued in Auto', `session ${String(attached?.sessionId).slice(0, 8)}`);
const sessionId = attached?.sessionId;

// The web app asks for the queue as soon as it attaches; ask the same way.
send({ op: 'queue.list', sessionId });
let queue = await next('queue');
say('phone sees', `${queue?.waiting} waiting: ${JSON.stringify(queue?.items?.map((i) => i.text.slice(-13)))}`);
if (queue?.owner !== 'cursor') say('WRONG', `the queue should be Cursor's, got ${queue?.owner}`);

// Delete the middle one from the phone, and check the window agrees.
send({ op: 'queue.drop', sessionId, itemId: said(WORDS[1]) });
queue = await next('queue');
say('after delete', `${queue?.waiting} waiting: ${JSON.stringify(queue?.items?.map((i) => i.text.slice(-13)))}`);
const inWindow = await cursor.queue({ threadId: scratch });
say('window agrees', `${inWindow.waiting} waiting`);
if (inWindow.items.some((i) => i.text.includes(WORDS[1]))) {
  say('WRONG', 'the deleted message is still in Cursor');
}

// Send the last one now.
send({ op: 'queue.now', sessionId, itemId: said(WORDS[2]) });
queue = await next('queue');
say('after send now', `${queue?.waiting} waiting: ${JSON.stringify(queue?.items?.map((i) => i.text.slice(-13)))}`);

// Rewording: the old wording goes, the new one takes its place. It travels the
// long way round — out of Cursor's queue, back in as a fresh message — so this
// waits for the window rather than believing the reply.
send({ op: 'queue.edit', sessionId, itemId: said(WORDS[0]), text: said('rutabaga') });
for (let look = 0; look < 12; look += 1) {
  await wait(1000);
  const now = await cursor.queue({ threadId: scratch });
  const words = now.items.map((i) => i.text.match(/word (\w+)/)?.[1]);
  if (words.includes('rutabaga')) {
    say('after edit', `${JSON.stringify(words)} after ${look + 1}s`);
    break;
  }
  if (look === 11) say('WRONG', `the reworded message never arrived: ${JSON.stringify(words)}`);
}

// A message that has already gone must come back as a refusal, not silence.
send({ op: 'queue.drop', sessionId, itemId: said('ghost') });
const refused = await (async () => {
  // Every action broadcasts as well as replying, so wait for the one that says
  // what became of this press rather than the next queue to come along.
  for (let waited = 0; waited < 15000; waited += 100) {
    const found = seen.find((m) => m.type === 'queue' && m.acted?.status === 'gone');
    if (found) return found.acted;
    await wait(100);
  }
  return null;
})();
say('ghost refused', JSON.stringify(refused));

// `AUTO_KEEP=1` leaves the chat running with its queue standing, for looking at
// the web UI with real rows in it. Clean up afterwards with `--clean <id>`.
if (!process.env.AUTO_KEEP) {
  await cursor.stop({ threadId: scratch });
  send({ op: 'session.archive', sessionId });
  await wait(500);
} else {
  say('left standing', `session ${sessionId} on chat ${scratch}`);
}
ws.close();
if (!process.env.AUTO_KEEP) {
  say('back home', JSON.stringify((await cursor.showThread({ threadId: home, force: true })).status));
  // Put the active session back where it was: Telegram sends wherever it points.
  if (wasActive) {
    await fetch('http://127.0.0.1:4331/api/session/active', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: wasActive }),
    });
    say('active restored', String(wasActive));
  }
}
process.exit(0);
