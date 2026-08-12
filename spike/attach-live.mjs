/**
 * Does a picture from a phone reach a real Cursor chat?
 *
 * The paste itself was proved by `paste-image.mjs`. This one goes through the
 * shipping path instead — `CursorCdp.sendText({ images })` — so what is being
 * tested is the code a phone actually reaches: clipboard, pill counting, the
 * words going in after the picture, and the clipboard put back as it was found.
 *
 * A scratch chat takes the message, so nothing lands in the session you are
 * working in. It does send: an attachment that is never submitted proves half
 * the path. The clipboard is Windows-wide and is trampled and restored.
 *
 * Usage: node spike/attach-live.mjs
 */
import { CursorCdp } from '../src/core/cursor-cdp.mjs';
import * as clipboard from '../src/core/clipboard.mjs';

const NEW_CHAT = 'New Agent (Ctrl+N) [Alt] Replace Agent';

/** A 2x2 red PNG, written out by hand so the spike needs nothing on disk. */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8Dwn4GBgYEBAwMDAA' +
  'EEAgAB9wUmAAAAAElFTkSuQmCC';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const cursor = new CursorCdp();
const say = (step, detail) => console.log(`${step.padEnd(22)} ${detail}`);

await clipboard.putText('the words that were on the clipboard before Auto ran');

const home = (await cursor.windows()).find((w) => w.hasComposer)?.threadId;
say('window was showing', String(home));
say('new chat', JSON.stringify(await cursor.press({ threadId: home, name: NEW_CHAT })));
await wait(1500);

const scratch = (await cursor.windows()).find((w) => w.hasComposer && w.threadId !== home);
say('scratch chat', String(scratch?.threadId));

if (scratch) {
  const sent = await cursor.sendText({
    threadId: scratch.threadId,
    text: 'Auto attachment check — a 2x2 red square should be attached above. No reply needed.',
    images: [
      { mimeType: 'image/png', data: PNG },
      { mimeType: 'image/png', data: PNG },
    ],
  });
  say('sendText', JSON.stringify(sent));
  say('clipboard after', JSON.stringify((await clipboard.takeText())?.slice(0, 60)));
}

say('back home', JSON.stringify(await cursor.showThread({ threadId: home, force: true })));
process.exit(0);
