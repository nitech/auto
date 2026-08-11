#!/usr/bin/env node
/** grep with context, without fighting PowerShell quoting. */
import { readFileSync } from 'node:fs';

const [file, pattern, beforeArg, afterArg, maxArg] = process.argv.slice(2);
const before = Number(beforeArg ?? 200);
const after = Number(afterArg ?? 600);
const max = Number(maxArg ?? 5);

const text = readFileSync(file, 'utf8');
const re = new RegExp(pattern, 'g');
let m;
let n = 0;
while ((m = re.exec(text)) && n < max) {
  n += 1;
  const start = Math.max(0, m.index - before);
  console.log(`\n--- match ${n} @ ${m.index} ---`);
  console.log(text.slice(start, m.index + m[0].length + after));
}
if (!n) console.log('(no match)');
