/**
 * The new refusal path, against the real bridge, without touching the running
 * host: a SessionManager of its own in a temporary state directory, pointed at
 * a real desktop thread. Cursor's bridge is genuinely refusing right now, so
 * this is the actual failure the web UI hits.
 *
 * It reads Cursor's database and writes only to its own temp directory, and it
 * drops the queue at the end so nothing is ever delivered.
 *
 * Usage: node spike/outbox-session.mjs <desktopThreadId>
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../src/core/sessions.mjs';

const threadId = process.argv[2];
if (!threadId) throw new Error('need a desktop thread id');

const dir = mkdtempSync(join(tmpdir(), 'auto-outbox-'));
const sessions = new SessionManager({ stateDir: dir, defaultFolder: process.cwd() });

try {
  const meta = await sessions.attachDesktopThread({ threadId, folder: process.cwd() });
  console.log(`session ${meta.id} -> thread ${threadId}`);

  await sessions.prompt(meta.id, { text: '(outbox check — never delivered)' });

  const records = await sessions.history(meta.id, 0);
  console.log('\nwhat the transcript says:');
  for (const r of records.slice(-3)) {
    console.log(`  ${r.kind}: ${String(r.text || '').slice(0, 300)}`);
  }

  console.log(`\nqueued for this session : ${sessions.outbox.queued(meta.id)}`);
  console.log(`saved in the registry   : ${(sessions.get(meta.id).outbox || []).length}`);
  console.log(`status after refusal    : ${sessions.get(meta.id).status}`);

  // Prove a restart keeps it: rebuild the manager from the same directory.
  await sessions.stopAll();
  sessions.outbox.stop();
  const revived = new SessionManager({ stateDir: dir, defaultFolder: process.cwd() }).init();
  console.log(`survives a host restart : ${revived.resumeDesktopOutbox()} message(s) taken back up`);
  revived.outbox.drop(meta.id);
  revived.outbox.stop();
  await revived.stopAll();
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.exit(0);
