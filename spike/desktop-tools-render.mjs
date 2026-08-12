/**
 * What the web UI would be given for a real thread's tool calls.
 *
 * Attaches a live desktop thread in a throwaway state directory and prints the
 * tool records that go into the transcript, which is exactly what a client
 * replays. Reads Cursor's database; writes nothing outside its temp dir.
 *
 * Usage: node spike/desktop-tools-render.mjs <threadId>
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../src/core/sessions.mjs';

const threadId = process.argv[2];
if (!threadId) throw new Error('need a desktop thread id');

const dir = mkdtempSync(join(tmpdir(), 'auto-tools-'));
const sessions = new SessionManager({ stateDir: dir, defaultFolder: process.cwd() });

try {
  const meta = await sessions.attachDesktopThread({ threadId, folder: process.cwd() });
  const records = await sessions.history(meta.id, 0);
  const tools = records.filter((r) => r.kind === 'tool_call' || r.kind === 'tool_update');

  console.log(`${tools.length} tool record(s) of ${records.length}\n`);
  for (const r of tools.slice(-6)) {
    console.log(`--- ${r.kind}  ${r.title || ''}  [${r.toolKind || ''}] ${r.status}`);
    if (r.rawInput) console.log(`    input : ${JSON.stringify(r.rawInput).slice(0, 200)}`);
    if (r.rawOutput) console.log(`    output: ${String(r.rawOutput).slice(0, 200).replace(/\r?\n/g, ' ⏎ ')}`);
    if (!r.rawInput && !r.rawOutput) console.log('    (nothing to show — this is the bug)');
  }
} finally {
  await sessions.stopAll();
  sessions.outbox.stop();
  rmSync(dir, { recursive: true, force: true });
}

process.exit(0);
