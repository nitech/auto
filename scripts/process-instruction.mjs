#!/usr/bin/env node
/**
 * Back-compat entrypoint — prefer main-agent + worker-agent.
 *
 * If main-agent is up, POST the job there (instant ack + worker spawn).
 * Otherwise fall back to running worker-agent directly.
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { arg, PROJECT_ROOT, normalizeFsPath } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN_URL = (
  process.env.AUTO_MAIN_URL || 'http://127.0.0.1:4332'
).replace(/\/$/, '');
const WORKER = join(HERE, 'worker-agent.mjs');

function loadJob() {
  const file = arg('file', '');
  if (file && existsSync(file)) {
    return JSON.parse(readFileSync(file, 'utf8'));
  }
  const text = arg('text', '');
  if (text) return { text };
  return null;
}

async function mainUp() {
  try {
    const res = await fetch(`${MAIN_URL}/health`, {
      signal: AbortSignal.timeout(800),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const job = loadJob();
if (!job) {
  console.error('No job — pass --file=job.json or --text=…');
  process.exit(2);
}

job.folder = normalizeFsPath(job.folder || process.env.AUTO_CWD || PROJECT_ROOT);

if (await mainUp()) {
  const res = await fetch(`${MAIN_URL}/job`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(job),
  });
  const data = await res.json();
  console.log(JSON.stringify(data));
  process.exit(res.ok ? 0 : 1);
}

// Fallback: direct worker
mkdirSync(join(PROJECT_ROOT, 'jobs'), { recursive: true });
const file = join(PROJECT_ROOT, 'jobs', `legacy-${Date.now()}.json`);
writeFileSync(file, JSON.stringify(job, null, 2) + '\n');
const child = spawn(process.execPath, [WORKER, `--file=${file}`], {
  cwd: PROJECT_ROOT,
  windowsHide: true,
  stdio: 'inherit',
  env: { ...process.env, AUTO_REPLY_TELEGRAM: process.env.AUTO_REPLY_TELEGRAM || '1' },
});
child.on('close', (code) => process.exit(code ?? 1));
child.on('error', () => process.exit(1));
