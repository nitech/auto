/**
 * Switching a chat's model and mode for real.
 *
 * Everything up to here proved the pickers open. This proves they can be set and
 * that the desktop agrees afterwards — in a chat made for the purpose, because
 * putting the chat doing the testing into Ask mode would stop it working
 * mid-sentence. The mode goes to Plan and back, the model to whatever the menu
 * offers that is not the one already chosen, and both are read back from the
 * desktop's own record rather than from the click.
 *
 * Tidies up: the window goes back to the chat it was showing and the borrowed
 * tab is closed.
 *
 * Usage: node spike/model-mode-live.mjs [--keep]
 */
import { CursorCdp } from '../src/core/cursor-cdp.mjs';
import { readSettings } from '../src/core/desktop-threads.mjs';

const NEW_CHAT = 'New Agent (Ctrl+N) [Alt] Replace Agent';
const keep = process.argv.includes('--keep');

const cursor = new CursorCdp();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (step, detail) => console.log(`${step.padEnd(24)} ${detail}`);
const stored = (id) => JSON.stringify(readSettings(id));

const home = (await cursor.windows()).find((w) => w.hasComposer)?.threadId;
say('window was showing', String(home));
if (!home) process.exit(1);

say('new chat', JSON.stringify(await cursor.press({ threadId: home, name: NEW_CHAT })));
await wait(1500);
const scratch = (await cursor.windows()).find((w) => w.hasComposer)?.threadId;
say('scratch chat', String(scratch));
if (!scratch || scratch === home) {
  console.log('No new chat appeared — stopping rather than acting on the wrong one.');
  process.exit(1);
}

try {
  say('settings', JSON.stringify(await cursor.settings({ threadId: scratch })));

  const modes = await cursor.choices({ threadId: scratch, picker: 'mode' });
  say('modes on offer', JSON.stringify(modes));
  const models = await cursor.choices({ threadId: scratch, picker: 'model' });
  say('models on offer', JSON.stringify(models));

  // Mode: somewhere else and back, so the chat is left as it was found.
  const otherMode = (modes.options || []).find((m) => !/^agent$/i.test(m) && /^(plan|ask)$/i.test(m));
  if (otherMode) {
    say(`mode -> ${otherMode}`, JSON.stringify(await cursor.choose({ threadId: scratch, picker: 'mode', wanted: otherMode })));
    say('record says', stored(scratch));
    say('mode -> Agent', JSON.stringify(await cursor.choose({ threadId: scratch, picker: 'mode', wanted: 'Agent' })));
    say('record says', stored(scratch));
    say('mode -> Agent again', JSON.stringify(await cursor.choose({ threadId: scratch, picker: 'mode', wanted: 'Agent' })));
  } else {
    say('mode', 'no other mode was offered');
  }

  // Model: the first thing offered that is not what it is already on.
  const on = (await cursor.settings({ threadId: scratch }))?.shown?.model || '';
  const otherModel = (models.options || []).find(
    (m) => m && !/^(add models|max|high|medium|fast|new|edit)$/i.test(m) && !on.toLowerCase().startsWith(m.toLowerCase()),
  );
  if (otherModel) {
    say(`model -> ${otherModel}`, JSON.stringify(await cursor.choose({ threadId: scratch, picker: 'model', wanted: otherModel })));
    say('record says', stored(scratch));
  } else {
    say('model', `nothing else was offered (on ${on})`);
  }

  say('a model that is not real', JSON.stringify(await cursor.choose({ threadId: scratch, picker: 'model', wanted: 'Clippy 9' })));
  say('the chat cannot be seen', JSON.stringify(await cursor.choose({ threadId: home, picker: 'mode', wanted: 'Agent' })));
} finally {
  say('back home', JSON.stringify(await cursor.showThread({ threadId: home, force: true })));
  if (!keep) {
    const shut = await cursor.readWindow(
      home,
      `(() => {
        const pane = document.querySelector('#workbench\\\\.parts\\\\.auxiliarybar') || document;
        const tab = pane.querySelector('[data-resource-name="${scratch}"]');
        if (!tab) return 'no tab';
        const close = tab.querySelector('.codicon-close, [aria-label^="Close"]');
        if (!close) return 'no close button';
        close.click();
        return 'closed';
      })()`,
    );
    say('scratch tab', String(shut));
  }
}

process.exit(0);
