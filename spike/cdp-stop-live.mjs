/**
 * Stopping a real turn, in a chat created for the purpose.
 *
 * Stopping cannot be tested on the chat doing the testing, so this opens a
 * scratch chat in Cursor, gives it something long-winded to do, waits until it
 * is genuinely running, stops it, and checks the desktop's own database agrees
 * that it stopped. Then it puts the window back on the chat it was showing.
 *
 * Every step names the chat it is acting on, so the guard that refuses to touch
 * a chat it cannot identify is doing real work here rather than being taken on
 * trust.
 *
 * Usage: node spike/cdp-stop-live.mjs
 */
import { CursorCdp } from '../src/core/cursor-cdp.mjs';
import { readThread } from '../src/core/desktop-threads.mjs';

const NEW_CHAT = 'New Agent (Ctrl+N) [Alt] Replace Agent';
/**
 * Something that genuinely takes a while. Asking for prose was no good: the
 * first attempt at this test asked a chat to count to forty and it was finished
 * before the first look, so nothing was ever stopped.
 */
const PROMPT =
  'Run exactly this command and wait for it to finish: ' +
  'powershell -NoProfile -Command "Start-Sleep -Seconds 90; echo done". ' +
  'This is a test of stopping you mid-command.';

const cursor = new CursorCdp();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (step, detail) => console.log(`${step.padEnd(22)} ${detail}`);

const before = (await cursor.windows()).find((w) => w.hasComposer);
if (!before) {
  console.log('No Cursor window with a chat box.');
  process.exit(1);
}
const home = before.threadId;
say('window', `${before.title}`);
say('chat it was showing', home);

// A tab to go back to. Cursor names the tab after the chat, so the chat's own
// title is what identifies it later.
const tabs = (before.rows || []).length;
say('messages on screen', String(tabs));

// Reuse a scratch chat if one was named, rather than leaving a trail of them.
const reuse = process.argv[2];
if (reuse) {
  say('reusing chat', JSON.stringify(await cursor.showThread({ threadId: reuse })));
} else {
  const opened = await cursor.press({ threadId: home, name: NEW_CHAT });
  say('new chat', JSON.stringify(opened));
  if (opened.status !== 'pressed') process.exit(1);
}
await wait(1200);

const scratchWindow = (await cursor.windows()).find((w) => w.hasComposer);
const scratch = scratchWindow?.threadId;
say('scratch chat', `${scratch}`);
if (!scratch || scratch === home) {
  console.log('The window did not move to a new chat — stopping here rather than guessing.');
  process.exit(1);
}

const sent = await cursor.sendText({ threadId: scratch, text: PROMPT });
say('prompt sent', JSON.stringify(sent));

// Wait for it to actually be running before trying to stop it, or the test
// proves nothing.
let running = false;
for (let look = 0; look < 30 && !running; look += 1) {
  await wait(500);
  running = Boolean((await cursor.waitingOn({ threadId: scratch })).generating);
}
say('turn running', String(running));
say('database agrees', String(Boolean(readThread(scratch, { tail: 0 })?.generating)));

if (running) {
  const stopped = await cursor.stop({ threadId: scratch });
  say('stop', JSON.stringify(stopped));
  await wait(1500);
  say('window still running', String(Boolean((await cursor.waitingOn({ threadId: scratch })).generating)));
  say('database still running', String(Boolean(readThread(scratch, { tail: 0 })?.generating)));

  // And the guard: stopping a chat no window is showing must refuse.
  say('stop the hidden chat', JSON.stringify(await cursor.stop({ threadId: home })));
}

// Put the window back on the chat it was showing, by id rather than by name.
say('going home', JSON.stringify(await cursor.showThread({ threadId: home })));
const after = (await cursor.windows()).find((w) => w.hasComposer);
say('chat now showing', `${after?.threadId} ${after?.threadId === home ? '(back home)' : '(NOT home)'}`);

process.exit(0);
