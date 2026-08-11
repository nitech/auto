#!/usr/bin/env node
/**
 * Smoke test for Auto — no changes should ship without this passing.
 *
 *   npm test
 *
 * Checks:
 *   1. Every .mjs script under scripts/ and src/ parses (node --check).
 *   1b. v2 core behaviour: transcript replay and ACP update mapping.
 *   2. lib.mjs's exports actually import and are the expected type.
 *   2b. Every skill under .claude/skills/ has valid SKILL.md frontmatter.
 *   3. If the service is already running, its /health endpoints respond.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
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

// 1a. Syntax-check the v2 tree.
const SRC = join(ROOT, 'src');
if (existsSync(SRC)) {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      return e.name.endsWith('.mjs') ? [p] : [];
    });
  for (const p of walk(SRC)) {
    const res = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' });
    const rel = relative(ROOT, p);
    if (res.status !== 0) fail(`node --check ${rel}\n${res.stderr}`);
    else ok(`syntax: ${rel}`);
  }
}

// 1b. v2 core behaviour. Pure logic only — no agent process, no network.
if (existsSync(SRC)) {
  const tmp = mkdtempSync(join(tmpdir(), 'auto-test-'));
  try {
    const { Transcript, KIND } = await import('../src/core/transcript.mjs');
    const { mapUpdate } = await import('../src/core/map-updates.mjs');

    const t = await new Transcript(tmp, 'sess-1').open();
    t.append(KIND.userMessage, { text: 'one' });
    t.append(KIND.agentDelta, { text: 'two' });
    const third = t.append(KIND.turnEnd, { stopReason: 'end_turn' });

    if (third.seq !== 3) fail(`transcript seq should be 3, got ${third.seq}`);
    if (t.readFrom(0).length !== 3) fail('transcript readFrom(0) should return 3 records');
    if (t.readFrom(2).length !== 1) fail('transcript readFrom(2) should return 1 record');

    // Reopening must continue the sequence rather than restart it.
    const again = await new Transcript(tmp, 'sess-1').open();
    if (again.seq !== 3) fail(`reopened transcript seq should be 3, got ${again.seq}`);
    if (again.append(KIND.userMessage, {}).seq !== 4) fail('reopened transcript should append at 4');

    const delta = mapUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hi' },
    });
    if (delta?.kind !== KIND.agentDelta || delta.payload.text !== 'hi') {
      fail(`mapUpdate agent_message_chunk wrong: ${JSON.stringify(delta)}`);
    }
    const call = mapUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'c1',
      kind: 'execute',
      rawInput: { command: 'ls' },
    });
    if (call?.kind !== KIND.toolCall || call.payload.rawInput.command !== 'ls') {
      fail(`mapUpdate tool_call wrong: ${JSON.stringify(call)}`);
    }
    // Unknown kinds must be preserved, never dropped.
    const unknown = mapUpdate({ sessionUpdate: 'something_new', a: 1 });
    if (!unknown || !unknown.kind.startsWith('acp:') || !unknown.payload.raw) {
      fail('mapUpdate should preserve unknown update kinds');
    }

    if (!failed) ok('v2 core: transcript replay + update mapping');
  } catch (e) {
    fail(`v2 core: ${e.message}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
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
