#!/usr/bin/env node
/** Slice a region of a bundle around a pattern and unminify it for reading. */
import { readFileSync, writeFileSync } from 'node:fs';

const [file, pattern, lenArg, out, backArg] = process.argv.slice(2);
const len = Number(lenArg ?? 12000);
const back = Number(backArg ?? 0);
const text = readFileSync(file, 'utf8');
const at = text.search(new RegExp(pattern));
if (at < 0) {
  console.log('(no match)');
  process.exit(1);
}
const region = text.slice(Math.max(0, at - back), at + len);
const broken = region
  .replace(/;/g, ';\n')
  .replace(/\{/g, '{\n')
  .replace(/\}/g, '\n}\n')
  .replace(/,(?=[a-zA-Z_$"'])/g, ',\n');
writeFileSync(out, broken);
console.log(`match at ${at}, ${broken.split('\n').length} lines → ${out}`);
