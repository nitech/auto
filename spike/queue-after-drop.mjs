/**
 * Does a message sent straight after deleting a queued one arrive?
 *
 * Rewording a queued message is a delete followed by a send, and in a live check
 * the delete worked while the new wording vanished: Auto recorded it as sent and
 * Cursor never queued it. This narrows that down — same two steps, nothing else,
 * with the queue watched afterwards rather than glanced at once.
 *
 * Usage: node spike/queue-after-drop.mjs
 */
import { CursorCdp } from '../src/core/cursor-cdp.mjs';

const NEW_CHAT = 'New Agent (Ctrl+N) [Alt] Replace Agent';
const SLOW =
  'Write 120 numbered lines, each a full sentence about a different number. ' +
  'Do not use any tools and do not touch any files.';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const cursor = new CursorCdp();
const say = (step, detail) => console.log(`${step.padEnd(20)} ${detail}`);

const home = (await cursor.windows()).find((w) => w.hasComposer)?.threadId;
await cursor.press({ threadId: home, name: NEW_CHAT });
await wait(1500);
const scratch = (await cursor.windows()).find((w) => w.hasComposer && w.threadId !== home)?.threadId;
say('scratch chat', String(scratch));
await cursor.sendText({ threadId: scratch, text: SLOW });
await wait(3000);

for (const word of ['alpha', 'bravo']) {
  await cursor.sendText({ threadId: scratch, text: `Afterwards, say the word ${word}.` });
  await wait(700);
}
const list = async (step) => {
  const seen = await cursor.queue({ threadId: scratch });
  say(step, JSON.stringify(seen.items?.map((i) => i.text.match(/word (\w+)/)?.[1])));
  return seen;
};
await list('queued');

say('drop alpha', (await cursor.queueAct({ threadId: scratch, text: 'Afterwards, say the word alpha.', which: 'drop' })).status);
await list('after drop');

// The send that goes missing. Its own report first, then what Cursor did with it.
const sent = await cursor.sendText({ threadId: scratch, text: 'Afterwards, say the word charlie.' });
say('sent charlie', JSON.stringify(sent));
for (let look = 0; look < 6; look += 1) {
  await wait(1000);
  await list(`after ${look + 1}s`);
}

// And a send with no delete before it, for comparison.
say('sent delta', JSON.stringify((await cursor.sendText({ threadId: scratch, text: 'Afterwards, say the word delta.' })).status));
await wait(1500);
await list('after delta');

await cursor.stop({ threadId: scratch });
say('back home', (await cursor.showThread({ threadId: home, force: true })).status);
process.exit(0);
