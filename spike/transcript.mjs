#!/usr/bin/env node
/**
 * Read a transcript the way a person would.
 *
 * The transcript is the primary source for "what actually happened", and it is
 * a JSONL file of tens of thousands of records — so every diagnosis so far has
 * begun by hand-rolling a one-liner to parse it, in a shell that fights back.
 * This is that one-liner, kept.
 *
 * Read-only.
 *
 *   node spike/transcript.mjs <sessionId|path>
 *   node spike/transcript.mjs <id> --kinds=turn_start,turn_end,error
 *   node spike/transcript.mjs <id> --match='resource_exhausted' --full
 *   node spike/transcript.mjs <id> --from=4240 --to=4260
 *   node spike/transcript.mjs <id> --turns          one line per turn
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const STORE = join(HERE, '..', 'state', 'transcripts');

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const has = (name) => args.includes(`--${name}`);

const who = args.find((a) => !a.startsWith('--'));
if (!who) throw new Error('need a session id or a path to a .jsonl');
const path = existsSync(who) ? who : join(STORE, `${who}.jsonl`);
if (!existsSync(path)) throw new Error(`no transcript at ${path}`);

const kinds = flag('kinds') ? new Set(flag('kinds').split(',')) : null;
const match = flag('match') ? new RegExp(flag('match'), 'i') : null;
const from = Number(flag('from', 0));
const to = Number(flag('to', Infinity));
const width = has('full') ? Infinity : Number(flag('width', 220));

const records = [];
for (const line of readFileSync(path, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  try {
    records.push({ line, rec: JSON.parse(line) });
  } catch {
    /* a torn final line from an unclean shutdown */
  }
}

const when = (ts) => new Date(ts).toLocaleString('sv-SE').slice(5, 19);
const trim = (s) => (s.length > width ? `${s.slice(0, width)}…` : s);

/** Everything about a record except the bookkeeping every record carries. */
function payloadOf(rec) {
  const { seq, ts, kind, ...rest } = rec;
  if (typeof rest.text === 'string' && Object.keys(rest).length === 1) return rest.text;
  return JSON.stringify(rest);
}

if (has('turns')) {
  // One line per turn: how long it took, what it produced, how it ended.
  let open = null;
  const counts = new Map();
  const show = (end) => {
    if (!open) return;
    const parts = [...counts.entries()].map(([k, n]) => `${k}×${n}`).join(' ');
    const secs = end ? Math.round((end.ts - open.ts) / 1000) : null;
    console.log(
      `${String(open.seq).padStart(6)} ${when(open.ts)}  ${secs === null ? 'never ended' : `${secs}s`.padEnd(11)}` +
        `  ${end ? `${end.stopReason}${end.upstreamError ? ' (upstream)' : ''}` : ''}  ${parts}`,
    );
  };
  for (const { rec } of records) {
    if (rec.kind === 'turn_start') {
      show(null);
      open = rec;
      counts.clear();
      continue;
    }
    if (rec.kind === 'turn_end') {
      show(rec);
      open = null;
      counts.clear();
      continue;
    }
    counts.set(rec.kind, (counts.get(rec.kind) || 0) + 1);
  }
  show(null);
  process.exit(0);
}

let shown = 0;
for (const { line, rec } of records) {
  if (rec.seq < from || rec.seq > to) continue;
  if (kinds && !kinds.has(rec.kind)) continue;
  if (match && !match.test(line)) continue;
  shown += 1;
  console.log(`${String(rec.seq).padStart(6)} ${when(rec.ts)} ${String(rec.kind).padEnd(19)} ${trim(payloadOf(rec))}`);
}
console.log(`\n${shown} of ${records.length} records — ${path}`);
