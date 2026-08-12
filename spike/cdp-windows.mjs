/**
 * What Auto's own CDP module makes of the Cursor windows that are open.
 *
 * The probe next door discovers; this reports what `src/core/cursor-cdp.mjs`
 * actually returns, so the code that ships is the code being looked at.
 *
 * Read-only unless a message is given, in which case it is typed into the
 * named chat exactly as Auto would type it:
 *
 *   node spike/cdp-windows.mjs
 *   node spike/cdp-windows.mjs <threadId> "some text"
 */
import { CursorCdp } from '../src/core/cursor-cdp.mjs';

const [threadId, text] = process.argv.slice(2);
const cursor = new CursorCdp();

console.log(`listening: ${await cursor.available()}`);
for (const window of await cursor.windows()) {
  console.log(`\n=== ${window.title}`);
  if (window.error) {
    console.log(`  unreadable: ${window.error}`);
    continue;
  }
  console.log(`  workspace   ${window.workspace}`);
  console.log(`  chat        ${window.threadId} (${window.threadIdsSeen} seen)`);
  console.log(`  box         ${window.hasComposer ? 'ready' : 'none'} ${JSON.stringify(window.composerText)}`);
  console.log(`  on screen   ${window.rows?.length || 0} messages`);
  for (const row of (window.rows || []).slice(-3)) {
    console.log(`    ${row.role}/${row.kind} ${row.id}`);
  }
}

if (threadId && text) {
  console.log(`\nsending to ${threadId}…`);
  console.log(JSON.stringify(await cursor.sendText({ threadId, text }), null, 2));
}

process.exit(0);
