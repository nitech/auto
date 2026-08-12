#!/usr/bin/env node
/**
 * Turn Cursor's desktop bridge on, off, or report on it — and talk to it.
 *
 * The switches themselves live in `src/core/desktop-bridge-gate.mjs`, because
 * the host re-asserts them too; this is the hand-driven way in.
 *
 *   node scripts/desktop-bridge.mjs status
 *   node scripts/desktop-bridge.mjs enable    (Cursor must be closed)
 *   node scripts/desktop-bridge.mjs ensure    (re-assert; safe while it runs)
 *   node scripts/desktop-bridge.mjs disable   (Cursor must be closed)
 *   node scripts/desktop-bridge.mjs ls
 *   node scripts/desktop-bridge.mjs send <threadId> <text...> [--force]
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoveryDir, instances, listThreads, sendMessage } from '../src/core/desktop-bridge.mjs';
import { CursorCdp, DEFAULT_PORT } from '../src/core/cursor-cdp.mjs';
import {
  assertSwitches,
  cursorProcessCount,
  gateState,
  restoreSwitches,
  snapshot,
} from '../src/core/desktop-bridge-gate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BACKUP = join(ROOT, 'state', 'desktop-bridge.backup.json');

/** Writing while Cursor runs loses to the copy it holds in memory. */
function requireCursorClosed() {
  const running = cursorProcessCount();
  if (!running || process.argv.includes('--force')) return true;
  console.error(
    `Cursor is running (${running} processes). Quit it first — it holds this storage in\n` +
      'memory and would write over these rows when it exits.',
  );
  process.exitCode = 1;
  return false;
}

async function status() {
  const state = gateState();
  const live = await instances();

  console.log('Cursor desktop bridge');
  console.log(`  feature gate override : ${state.override}`);
  console.log(`  dev override allowed  : ${state.devEligible}`);
  console.log(`  user setting (Beta)   : ${state.userEnabled}`);
  console.log(`  gate mirrored to disk : ${state.mirror}`);
  console.log(`  Cursor running        : ${cursorProcessCount()} processes`);
  console.log(`  discovery dir         : ${discoveryDir()}`);
  console.log(`  reachable instances   : ${live.length}`);
  for (const i of live) console.log(`    - ${i.label}  pid ${i.pid}  ${i.socketPath}`);

  // The rows above are only what is on disk, and a running window decides from
  // the copy it read at startup — so all four can say true while every send is
  // refused. The only honest answer comes from asking it. A thread id nobody
  // has cannot be delivered to, so this reaches the gate and nothing else.
  let shut = false;
  if (live.length) {
    const probe = await sendMessage({ threadId: randomUUID(), text: 'gate probe' }).catch(
      (err) => ({ status: 'error', message: err.message }),
    );
    shut = /bridge is disabled/i.test(probe.reason || probe.message || '');
    console.log(`  window takes messages : ${shut ? 'no — gate shut in memory' : 'yes'}`);
  }

  const typing = await windowStatus();

  if (shut) {
    console.log(
      '\nCursor reads these switches when it starts, so setting them now cannot reach the\n' +
        'window that is already running. Restart Cursor to bring the bridge back.' +
        (typing
          ? ' Meanwhile\nAuto types into the window instead, so messages still arrive.'
          : ' Anything\nsent meanwhile waits in Auto and goes in by itself once it answers.'),
    );
  }

  if (!live.length) {
    console.log(
      state.allOn
        ? '\nAll switches are on. Start Cursor (or restart it) and the bridge will appear.'
        : '\nRun `npm run bridge:enable` with Cursor closed to turn it on.',
    );
  }
}

/**
 * The other way in: typing into the window over Cursor's debug port.
 *
 * Nothing in Cursor's settings governs this one, which is the whole point of
 * it — when the gate above is shut, this is the difference between a message
 * arriving and a message waiting. Reporting it is read-only.
 *
 * @returns {Promise<boolean>} whether Cursor is reachable this way
 */
async function windowStatus() {
  const cursor = new CursorCdp();
  const listening = await cursor.available();

  console.log('\nTyping into the window');
  console.log(`  debug port ${String(DEFAULT_PORT).padEnd(10)}: ${listening ? 'listening' : 'not listening'}`);

  if (!listening) {
    console.log(
      '\nCursor was started without its debugging port, so the bridge above is the only way\n' +
        'in. To have both, quit Cursor and start it like this:\n\n' +
        '  & "$env:LOCALAPPDATA\\Programs\\cursor\\Cursor.exe" --remote-debugging-port=9222 "D:\\Sevenfold\\auto"',
    );
    return false;
  }

  for (const w of await cursor.windows()) {
    if (w.error) {
      console.log(`    - ${w.title}: unreadable (${w.error})`);
      continue;
    }
    console.log(`    - ${w.title}`);
    console.log(
      `      ${w.workspace || 'no folder'} — ` +
        `${w.threadId ? `chat ${w.threadId}` : 'no chat id on screen'}, ` +
        `box ${w.hasComposer ? 'ready' : 'missing'}`,
    );
  }
  return true;
}

function enable() {
  if (!requireCursorClosed()) return;

  // Only ever save the untouched values: enabling twice must not record our
  // own switches as the state to go back to.
  if (!existsSync(BACKUP)) {
    mkdirSync(dirname(BACKUP), { recursive: true });
    writeFileSync(BACKUP, JSON.stringify(snapshot(), null, 2));
  }
  assertSwitches();

  console.log('Desktop bridge enabled.');
  console.log(`Values from before it was ever enabled: ${BACKUP}`);
  console.log('Start Cursor, then run `npm run bridge` to confirm.');
}

function ensure() {
  const changed = assertSwitches();
  console.log(changed.length ? `Re-asserted: ${changed.join(', ')}` : 'Switches already set.');
}

function disable() {
  if (!requireCursorClosed()) return;
  if (!existsSync(BACKUP)) {
    console.error(`No backup at ${BACKUP} — nothing to restore.`);
    process.exitCode = 1;
    return;
  }
  restoreSwitches(JSON.parse(readFileSync(BACKUP, 'utf8')));
  console.log('Desktop bridge disabled; Cursor storage restored to the saved values.');
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'status':
    case undefined:
      return status();
    case 'enable':
      return enable();
    case 'ensure':
      return ensure();
    case 'disable':
      return disable();
    case 'ls': {
      const threads = await listThreads();
      if (!threads.length) console.log('No threads.');
      for (const t of threads) {
        const when = new Date(t.lastUpdatedAt || 0).toISOString().replace('T', ' ').slice(0, 16);
        console.log(`${t.id}  ${when}  ${String(t.status).padEnd(9)}  ${t.title}`);
      }
      return undefined;
    }
    case 'send': {
      const [threadId, ...words] = rest.filter((a) => a !== '--force');
      const result = await sendMessage({
        threadId,
        text: words.join(' '),
        force: rest.includes('--force'),
      });
      console.log(JSON.stringify(result, null, 2));
      return undefined;
    }
    default:
      console.error(
        `Unknown command "${command}". Try: status | enable | ensure | disable | ls | send`,
      );
      process.exitCode = 1;
      return undefined;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
