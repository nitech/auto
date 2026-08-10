#!/usr/bin/env node
/**
 * Smoke test for Auto — no changes should ship without this passing.
 *
 *   npm test
 *
 * Checks:
 *   1. Every .mjs script under scripts/ parses (node --check).
 *   2. lib.mjs's exports actually import and are the expected type.
 *   2b. Every skill under .claude/skills/ has valid SKILL.md frontmatter.
 *   3. If the service is already running, its /health endpoints respond.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
  const required = [
    'arg',
    'PROJECT_ROOT',
    'normalizeFsPath',
    'DEBUG_PORT',
    'appendEvent',
    'SKILL_ROOT',
    'loadDotEnv',
    'applyAutoProvider',
    'ensureAutoProviderAuth',
    'AUTO_PROVIDER_INFO',
    'autoAgentIdentity',
  ];
  for (const name of required) {
    if (!(name in lib)) fail(`lib.mjs missing export: ${name}`);
  }
  if (typeof lib.loadDotEnv !== 'function') fail('loadDotEnv should be a function');
  if (typeof lib.applyAutoProvider !== 'function') fail('applyAutoProvider should be a function');
  if (typeof lib.ensureAutoProviderAuth !== 'function') {
    fail('ensureAutoProviderAuth should be a function');
  }
  if (typeof lib.autoAgentIdentity !== 'function') {
    fail('autoAgentIdentity should be a function');
  } else {
    const id = lib.autoAgentIdentity();
    if (typeof id !== 'string' || !/Model identity:/.test(id)) {
      fail('autoAgentIdentity should return a "Model identity:" string');
    } else {
      ok(`identity: ${id.split('.')[0]}`);
    }
  }
  if (!lib.AUTO_PROVIDER_INFO || typeof lib.AUTO_PROVIDER_INFO.provider !== 'string') {
    fail('AUTO_PROVIDER_INFO.provider missing');
  } else {
    ok(
      `provider: ${lib.AUTO_PROVIDER_INFO.provider}` +
        (lib.AUTO_PROVIDER_INFO.mode ? `/${lib.AUTO_PROVIDER_INFO.mode}` : ''),
    );
  }
  if (!failed) ok('lib.mjs exports present');
} catch (e) {
  fail(`import lib.mjs: ${e.message}`);
}

// kimi-oauth helpers import cleanly
try {
  const oauth = await import('./kimi-oauth.mjs');
  for (const name of [
    'ensureKimiCodingToken',
    'startKimiDeviceLogin',
    'pollKimiDeviceLogin',
    'loadKimiOAuthCreds',
  ]) {
    if (typeof oauth[name] !== 'function') fail(`kimi-oauth missing ${name}`);
  }
  if (!failed) ok('kimi-oauth.mjs exports present');
} catch (e) {
  fail(`import kimi-oauth.mjs: ${e.message}`);
}

// 2b. Auto's own skills: every .claude/skills/<name>/SKILL.md must have valid
// frontmatter (name matching the directory, non-empty description).
const SKILLS_DIR = join(ROOT, '.claude', 'skills');
if (existsSync(SKILLS_DIR)) {
  const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  for (const dir of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const before = failed;
    const mdPath = join(SKILLS_DIR, dir.name, 'SKILL.md');
    if (!existsSync(mdPath)) {
      fail(`skill ${dir.name}: missing SKILL.md`);
      continue;
    }
    const text = readFileSync(mdPath, 'utf8');
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fm) {
      fail(`skill ${dir.name}: no frontmatter block`);
      continue;
    }
    const name = fm[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
    const desc = fm[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
    if (!name) fail(`skill ${dir.name}: frontmatter missing name`);
    else if (name !== dir.name) {
      fail(`skill ${dir.name}: name "${name}" != directory name`);
    } else if (!NAME_RE.test(name) || name.length > 64) {
      fail(`skill ${dir.name}: invalid name format "${name}"`);
    }
    if (!desc) fail(`skill ${dir.name}: frontmatter missing description`);
    else if (desc.length > 1024) fail(`skill ${dir.name}: description too long`);
    if (failed === before) ok(`skill: ${dir.name}`);
  }
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
