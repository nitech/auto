/**
 * Does a long answer reach the transcript whole?
 *
 * Cursor writes a reply into its bubble as it is spoken. This asks a scratch
 * chat for an answer long enough to be written in pieces, follows it with the
 * same watcher the host uses, reassembles the tails exactly as the sessions
 * layer does, and compares the result with what the database ended up holding.
 * A short answer proves nothing here — it lands in one write.
 *
 * Uses a scratch chat, so nothing goes into the session you are working in.
 *
 * Usage: node spike/mirror-live.mjs
 */
import { CursorCdp } from '../src/core/cursor-cdp.mjs';
import { ThreadWatcher, readThread } from '../src/core/desktop-threads.mjs';
import { newWords } from '../src/core/sessions.mjs';

const NEW_CHAT = 'New Agent (Ctrl+N) [Alt] Replace Agent';
// Long enough that Cursor cannot write it in one go: a short answer lands in a
// single write and proves nothing about following one as it grows.
const ASK =
  'Write 60 numbered lines, each a full sentence about a different number between 1 and 60, ' +
  'explaining something mathematically true about it. Do not use any tools and do not touch any files.';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const cursor = new CursorCdp();
const say = (step, detail) => console.log(`${step.padEnd(20)} ${detail}`);

const home = (await cursor.windows()).find((w) => w.hasComposer)?.threadId;
await cursor.press({ threadId: home, name: NEW_CHAT });
await wait(1500);
const scratch = (await cursor.windows()).find((w) => w.hasComposer && w.threadId !== home);
if (!scratch) {
  say('no scratch chat', 'giving up rather than typing into a real one');
  process.exit(1);
}
say('scratch chat', String(scratch.threadId));

// Everything already there is history, exactly as the host treats it.
const before = readThread(scratch.threadId);
const watcher = new ThreadWatcher(scratch.threadId).markSeen(before.visited);

/** What the transcript would hold, built from the tails the watcher gives us. */
const built = new Map();
const said = new Map();
let growths = 0;
watcher.on('message', (m) => {
  if (m.kind !== 'text' || m.role !== 'assistant') return;
  const tail = newWords(said.get(m.id) || '', m.text);
  if (m.pending) said.set(m.id, m.text);
  else said.delete(m.id);
  if (!tail) return;
  if (built.has(m.id)) growths += 1;
  built.set(m.id, (built.get(m.id) || '') + tail);
});

let ended = false;
watcher.on('running', (running) => {
  say('turn', running ? 'started' : 'ended');
  if (!running && built.size) ended = true;
});
watcher.start();

say('asking', JSON.stringify((await cursor.sendText({ threadId: scratch.threadId, text: ASK })).status));

for (let look = 0; look < 120 && !ended; look += 1) await wait(1000);
await wait(1500);
watcher.stop();

const after = readThread(scratch.threadId, { seen: new Set(before.visited) });
for (const [id, text] of built) {
  const truth = after.messages.find((m) => m.id === id)?.text || '';
  const same = text.trim() === truth.trim();
  say('bubble', `${id.slice(0, 8)} mirrored ${text.length} of ${truth.length} chars — ${same ? 'whole' : 'WRONG'}`);
  if (!same) {
    say('mirrored tail', JSON.stringify(text.slice(-120)));
    say('database tail', JSON.stringify(truth.slice(-120)));
  }
}
say('growth reads', `${growths} (0 would mean the answer landed in one write)`);
say('back home', JSON.stringify((await cursor.showThread({ threadId: home, force: true })).status));
process.exit(0);
