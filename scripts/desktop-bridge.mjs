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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoveryDir, instances, listThreads, sendMessage } from '../src/core/desktop-bridge.mjs';
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

  if (!live.length) {
    console.log(
      state.allOn
        ? '\nAll switches are on. Start Cursor (or restart it) and the bridge will appear.'
        : '\nRun `npm run bridge:enable` with Cursor closed to turn it on.',
    );
  }
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
