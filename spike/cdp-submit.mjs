/**
 * Which step of a send fails, and why.
 *
 * A live send through the host fell back to the bridge, which means the window
 * refused somewhere between focusing the box and Enter. This walks the same
 * steps in the open and reports each one, so the answer is observed rather than
 * guessed at.
 *
 * The marker is labelled, because if Enter does submit, it becomes a real
 * message in whatever chat is open. Anything that does not submit is taken
 * back out of the box.
 *
 * Usage: node spike/cdp-submit.mjs [port]
 */
import { CursorCdp, CursorWindow } from '../src/core/cursor-cdp.mjs';

const MARKER = `Auto CDP submit check ${new Date().toISOString()} — ignore`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const cursor = new CursorCdp({ port: Number(process.argv[2] || 9222) });
const targets = (await cursor.listTargets()).filter(
  (t) => t.type === 'page' && /workbench/i.test(String(t.url || '')),
);

for (const target of targets) {
  const window = await CursorWindow.open(target);
  try {
    const facts = await window.facts();
    if (!facts.hasComposer) {
      console.log(`\n=== ${facts.title}\n  no chat box here`);
      continue;
    }
    console.log(`\n=== ${facts.title}`);
    console.log(`  chat            ${facts.threadId}`);
    console.log(`  box before      ${JSON.stringify(facts.composerText)}`);
    if (facts.composerText) {
      console.log('  something is already in the box — not touching it');
      continue;
    }

    console.log(`  focused         ${await window.focusComposer()}`);
    await window.insertText(MARKER);
    await wait(150);
    console.log(`  box after type  ${JSON.stringify(await window.composerText())}`);

    await window.pressEnter();
    for (const at of [250, 500, 1000, 2000]) {
      await wait(at === 250 ? 250 : 250);
      const now = await window.composerText();
      console.log(`  box +${String(at).padStart(4)}ms    ${JSON.stringify(now)}`);
      if (!now) break;
    }

    const left = await window.composerText();
    if (left) {
      await window.clearComposer();
      console.log(`  cleaned up      ${JSON.stringify(await window.composerText())}`);
      console.log('  verdict         Enter did not submit');
    } else {
      console.log('  verdict         Enter submitted');
    }
  } catch (err) {
    console.log(`  failed: ${err.message}`);
  } finally {
    window.close();
  }
}

process.exit(0);
