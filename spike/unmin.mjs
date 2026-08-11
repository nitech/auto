#!/usr/bin/env node
/** Crude but enough: break a minified bundle chunk into readable lines. */
import { readFileSync, writeFileSync } from 'node:fs';

const [src, out] = process.argv.slice(2);
const text = readFileSync(src, 'utf8');
const broken = text
  .replace(/;/g, ';\n')
  .replace(/\{/g, '{\n')
  .replace(/\}/g, '\n}\n')
  .replace(/,(?=[a-zA-Z_$"'])/g, ',\n');
writeFileSync(out, broken);
console.log(`${broken.split('\n').length} lines → ${out}`);
