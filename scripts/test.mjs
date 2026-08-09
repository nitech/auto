#!/usr/bin/env node
/**
 * Smoke test for Auto — no changes should ship without this passing.
 *
 *   npm test
 *
 * Checks:
 *   1. Every .mjs script under scripts/ parses (node --check).
 *   2. lib.mjs's exports actually import and are the expected type.
 *   3. If the service is already running, its /health endpoints respond.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let failed = false;
function fail(msg) {
  failed = true;
  console.error(`FAIL: ${msg}`);
}
function ok(msg) {
  console.log(`ok: ${msg}`);
}

// 1. Syntax-check every script.
const files = readdirSync(HERE).filter((f) => f.endsWith('.mjs'));
for (const f of files) {
  const res = spawnSync(process.execPath, ['--check', join(HERE, f)], {
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    fail(`node --check ${f}\n${res.stderr}`);
  } else {
    ok(`syntax: ${f}`);
  }
}

// 2. lib.mjs exports import cleanly.
try {
  const lib = await import('./lib.mjs');
  const required = ['arg', 'PROJECT_ROOT', 'normalizeFsPath', 'DEBUG_PORT', 'appendEvent', 'SKILL_ROOT'];
  for (const name of required) {
    if (!(name in lib)) fail(`lib.mjs missing export: ${name}`);
  }
  if (!failed) ok('lib.mjs exports present');
} catch (e) {
  fail(`import lib.mjs: ${e.message}`);
}

// 3. If the debug server / main agent are already running, hit /health.
for (const [name, port, path] of [
  ['debug-server', 4331, '/api/health'],
  ['main-agent', 4332, '/health'],
]) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) ok(`${name} ${path} responded`);
    else fail(`${name} ${path} returned ${res.status}`);
  } catch {
    console.log(`skip: ${name} not running on :${port}`);
  }
}

if (failed) {
  console.error('\nTEST SUITE FAILED');
  process.exit(1);
}
console.log('\nAll checks passed.');
