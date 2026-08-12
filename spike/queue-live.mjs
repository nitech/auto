/**
 * Can Auto read Cursor's queue and press its buttons?
 *
 * Queues three throwaway messages behind a slow question in a scratch chat, then
 * reads the list, deletes the middle one and sends the last one now — the three
 * things a phone needs to offer. Every step is checked against the window rather
 * than assumed from the press.
 *
 * Uses a scratch chat, so nothing of yours is queued, sent or deleted.
 *
 * Usage: node spike/queue-live.mjs
 */
import { CursorCdp } from '../src/core/cursor-cdp.mjs';

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

say('asked', (await cursor.sendText({ threadId: scratch, text: SLOW })).status);
await wait(2500);
for (const word of WORDS) {
  await cursor.sendText({ threadId: scratch, text: said(word) });
  await wait(800);
}

const list = async (step) => {
  const seen = await cursor.queue({ threadId: scratch });
  say(step, `${seen.waiting} waiting: ${JSON.stringify(seen.items?.map((i) => i.text.slice(-14)))}`);
  return seen;
};
await list('queue reads');

// Delete the middle one: the row must be found by its own words, not its place.
say(
  'delete middle',
  JSON.stringify(
    (await cursor.queueAct({ threadId: scratch, text: said(WORDS[1]), which: 'drop' })).status,
  ),
);
const afterDrop = await list('after delete');
if (afterDrop.items?.some((i) => i.text.includes(WORDS[1]))) {
  say('WRONG', 'the deleted message is still queued');
}
if (!afterDrop.items?.some((i) => i.text.includes(WORDS[0]))) {
  say('WRONG', 'deleting one message took another with it');
}

// Send the last one now, which takes it out of the queue and into the agent.
say(
  'send now',
  JSON.stringify(
    (await cursor.queueAct({ threadId: scratch, text: said(WORDS[2]), which: 'now' })).status,
  ),
);
await list('after send now');

// A message that is no longer queued must be refused, not acted on blindly.
say(
  'act on a ghost',
  JSON.stringify(await cursor.queueAct({ threadId: scratch, text: said('ghost'), which: 'drop' })),
);

say('stop the turn', JSON.stringify((await cursor.stop({ threadId: scratch })).status));
say('back home', JSON.stringify((await cursor.showThread({ threadId: home, force: true })).status));
process.exit(0);
