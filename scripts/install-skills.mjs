#!/usr/bin/env node
/**
 * Junction Auto's skills (.claude/skills/*) into ~/.claude/skills so every
 * session on this machine loads them, regardless of cwd. Idempotent.
 *
 *   node scripts/install-skills.mjs   (or: npm run skills:install)
 */
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(HERE, '..', '.claude', 'skills');
const PERSONAL_SKILLS_DIR = join(homedir(), '.claude', 'skills');

const normPath = (p) => String(p).replace(/[\\/]+$/, '').toLowerCase();

const installed = [];
const removed = [];
const warnings = [];

let names = [];
try {
  names = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
} catch {
  console.log('no skills to install');
  process.exit(0);
}

mkdirSync(PERSONAL_SKILLS_DIR, { recursive: true });

for (const name of names) {
  const target = join(SKILLS_DIR, name);
  const link = join(PERSONAL_SKILLS_DIR, name);
  try {
    const st = lstatSync(link, { throwIfNoEntry: false });
    if (st) {
      if (!st.isSymbolicLink()) {
        warnings.push(`${name}: ${link} exists (not a junction) — left untouched`);
        continue;
      }
      if (normPath(readlinkSync(link)) === normPath(target)) {
        installed.push(name);
        continue;
      }
      rmSync(link, { force: true }); // stale junction → recreate below
    }
    symlinkSync(target, link, 'junction');
    installed.push(name);
  } catch (e) {
    warnings.push(`${name}: ${e.message}`);
  }
}

// Remove junctions pointing into our skills dir whose repo skill is gone.
for (const entry of readdirSync(PERSONAL_SKILLS_DIR, { withFileTypes: true })) {
  if (names.includes(entry.name)) continue;
  const link = join(PERSONAL_SKILLS_DIR, entry.name);
  try {
    const st = lstatSync(link, { throwIfNoEntry: false });
    if (!st || !st.isSymbolicLink()) continue;
    if (normPath(readlinkSync(link)).startsWith(normPath(SKILLS_DIR) + sep)) {
      rmSync(link, { force: true });
      removed.push(entry.name);
    }
  } catch (e) {
    warnings.push(`${entry.name}: cleanup failed: ${e.message}`);
  }
}

for (const name of installed) console.log(`installed: ${name}`);
for (const name of removed) console.log(`removed stale: ${name}`);
for (const w of warnings) console.error(`warning: ${w}`);
process.exit(warnings.length ? 1 : 0);
