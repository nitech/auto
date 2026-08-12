/**
 * Stopping a Cursor turn the way a phone would: through the host.
 *
 * Everything before this proved the mechanism; this proves the wiring. It makes
 * a scratch chat in Cursor, gives it a command that takes a minute, hands the
 * chat to the host as a session, sends the host the same `cancel` the web UI
 * and Telegram send, and reads the transcript to see what the user would see.
 *
 * The scratch chat exists so that the chat doing the testing is never the chat
 * being stopped. Afterwards the window goes back where it was and the borrowed
 * tab is closed.
 *
 * Usage: node spike/stop-live.mjs
 */
import { WebSocket } from 'ws';
import { CursorCdp } from '../src/core/cursor-cdp.mjs';
import { readThread } from '../src/core/desktop-threads.mjs';

const FOLDER = 'D:\\Sevenfold\\auto';
const NEW_CHAT = 'New Agent (Ctrl+N) [Alt] Replace Agent';
const PROMPT =
  'Run exactly this command and wait for it: ' +
  'powershell -NoProfile -Command "Start-Sleep -Seconds 60; echo done". ' +
  'A test of stopping from a phone; nothing else needed.';

const cursor = new CursorCdp();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (step, detail) => console.log(`${step.padEnd(26)} ${detail}`);

const home = (await cursor.windows()).find((w) => w.hasComposer)?.threadId;
say('window was showing', home);

say('new chat', JSON.stringify(await cursor.press({ threadId: home, name: NEW_CHAT })));
await wait(1500);
const scratch = (await cursor.windows()).find((w) => w.hasComposer)?.threadId;
say('scratch chat', String(scratch));
if (!scratch || scratch === home) {
  console.log('No new chat appeared — stopping rather than acting on the wrong one.');
  process.exit(1);
}

say('prompt sent', JSON.stringify(await cursor.sendText({ threadId: scratch, text: PROMPT })));

let running = false;
for (let look = 0; look < 40 && !running; look += 1) {
  await wait(500);
  running = Boolean(readThread(scratch, { tail: 0 })?.generating);
}
say('turn running', String(running));

// From here on, everything goes through the host, as a phone would.
const ws = new WebSocket('ws://127.0.0.1:4331');
const records = [];
let sessionId = null;

await new Promise((resolve, reject) => {
  ws.once('open', resolve);
  ws.once('error', reject);
});

ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw));
  if (msg.type === 'attached' && msg.meta?.desktopThreadId === scratch) {
    sessionId = msg.meta.id;
    say('host session', `${sessionId} (${msg.meta.status})`);
  }
  if (msg.type === 'record' && msg.record) records.push(msg.record);
});

ws.send(JSON.stringify({ op: 'desktop.continue', chatId: scratch, folder: FOLDER }));
for (let look = 0; look < 20 && !sessionId; look += 1) await wait(250);
if (!sessionId) {
  console.log('The host would not take the chat as a session.');
  process.exit(1);
}

const before = records.length;
say('sending cancel', 'as the web UI does');
ws.send(JSON.stringify({ op: 'cancel', sessionId }));
await wait(6000);

say('turn still running', String(Boolean(readThread(scratch, { tail: 0 })?.generating)));
console.log('\nwhat the transcript says:');
for (const r of records.slice(before)) {
  const text = String(r.text || r.stopReason || '').slice(0, 160);
  console.log(`  ${r.kind}${text ? `: ${text}` : ''}`);
}

// Tidy: archive the scratch session, go home, close the borrowed tab.
ws.send(JSON.stringify({ op: 'session.archive', sessionId }));
await wait(500);
ws.close();

say('\nback home', JSON.stringify(await cursor.showThread({ threadId: home, force: true })));
const closed = await cursor.readWindow(
  home,
  `(() => {
    const pane = document.querySelector('#workbench\\\\.parts\\\\.auxiliarybar') || document;
    const tab = pane.querySelector('[data-resource-name="${scratch}"]');
    if (!tab) return 'no tab';
    const shut = tab.querySelector('.codicon-close, [aria-label^="Close"]');
    if (!shut) return 'no close button';
    const rect = shut.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, view: window, button: 0,
      clientX: Math.round(rect.left + rect.width / 2), clientY: Math.round(rect.top + rect.height / 2) };
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      shut.dispatchEvent(new MouseEvent(type, at));
    }
    return 'pressed';
  })()`,
);
say('closed the tab', String(closed));
say('showing now', String((await cursor.windows()).find((w) => w.hasComposer)?.threadId));

process.exit(0);
