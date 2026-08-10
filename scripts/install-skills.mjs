#!/usr/bin/env node
/**
 * Junction Auto's skills (.claude/skills/*) into ~/.claude/skills so every
 * session on this machine loads them, regardless of cwd. Idempotent.
 *
 *   node scripts/install-skills.mjs   (or: npm run skills:install)
 */
import { installSkills } from './lib.mjs';

const { installed, removed, warnings } = installSkills();
for (const name of installed) console.log(`installed: ${name}`);
for (const name of removed) console.log(`removed stale: ${name}`);
for (const w of warnings) console.error(`warning: ${w}`);
process.exit(warnings.length ? 1 : 0);
