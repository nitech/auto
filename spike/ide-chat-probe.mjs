#!/usr/bin/env node
/**
 * Does an IDE chat carry an id the CLI could resolve — a server-side
 * conversation id rather than the local transcript filename?
 */
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const dir = join(homedir(), '.cursor', 'projects', 'd-Sevenfold-auto', 'agent-transcripts');
const chats = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
console.log(`chats: ${chats.map((c) => c.name).join(', ')}\n`);

const pick = chats.find((c) => c.name.startsWith('4e9abaeb')) || chats[0];
const file = join(dir, pick.name, `${pick.name}.jsonl`);
const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
console.log(`${pick.name}: ${lines.length} lines\n`);

// Collect every key that looks like an identifier, anywhere in the tree.
const idKeys = new Map();
const walk = (node) => {
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (/id$/i.test(k) && (typeof v === 'string' || typeof v === 'number')) {
      if (!idKeys.has(k)) idKeys.set(k, new Set());
      if (idKeys.get(k).size < 3) idKeys.get(k).add(String(v));
    }
    if (typeof v === 'object') walk(v);
  }
};
for (const line of lines.slice(0, 40)) {
  try {
    walk(JSON.parse(line));
  } catch {
    /* skip */
  }
}
for (const [k, vals] of idKeys) console.log(`${k}: ${[...vals].join(', ')}`);

console.log('\n--- top-level keys per line kind ---');
const kinds = new Set();
for (const line of lines) {
  try {
    kinds.add(Object.keys(JSON.parse(line)).join('+'));
  } catch {
    /* skip */
  }
}
console.log([...kinds].join('\n'));
