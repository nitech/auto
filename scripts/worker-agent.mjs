#!/usr/bin/env node
/**
 * Auto worker subagent — does the actual job, reports status to main-agent.
 *
 *   node worker-agent.mjs --file=job.json
 *   node worker-agent.mjs --text="…"
 *
 * Env:
 *   AUTO_CWD          working directory
 *   AUTO_MAIN_URL     main-agent base (default http://127.0.0.1:4332)
 *   AUTO_SKIP_PERMS   if "0", do not pass --dangerously-skip-permissions
 *   AUTO_REPLY_TELEGRAM  usually "0" when main narrates
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { arg, SKILL_ROOT, appendEvent, normalizeFsPath, ensureAutoProviderAuth, autoAgentIdentity, installSkills } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const RUNS = join(ROOT, 'runs');
const MAIN_URL = (
  process.env.AUTO_MAIN_URL || 'http://127.0.0.1:4332'
).replace(/\/$/, '');

await ensureAutoProviderAuth().catch(() => {});

// Junction Auto's own skills into ~/.claude/skills so this session loads them
// no matter which folder the job runs in. Idempotent, fast, self-healing.
for (const w of installSkills().warnings) console.error(`[skills] ${w}`);

function loadJob() {
  const file = arg('file', '');
  if (file && existsSync(file)) {
    return JSON.parse(readFileSync(file, 'utf8'));
  }
  const text = arg('text', '');
  if (text) return { text };
  const raw = process.env.AUTO_JOB_JSON;
  if (raw) return JSON.parse(raw);
  return null;
}

async function reportStatus(job, phase, text, extra = {}) {
  const body = {
    workerId: job.workerId || job.messageId,
    messageId: job.messageId,
    sessionId: job.sessionId || null,
    phase,
    text: String(text || '').slice(0, 4000),
    ...extra,
  };
  // The main agent re-broadcasts this same status to the debug UI once it
  // receives the POST below — logging it here too would double every status
  // bubble. Only log locally if the main agent is unreachable, so nothing
  // is silently lost.
  let delivered = false;
  try {
    const res = await fetch(`${MAIN_URL}/worker-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    delivered = res.ok;
  } catch (e) {
    console.error(`[worker] status post failed: ${e.message}`);
  }
  if (!delivered) {
    appendEvent({
      dir: 'sys',
      note: `auto: worker ${phase}`,
      text: body.text.slice(0, 300),
      sessionId: job.sessionId || null,
      workerId: body.workerId,
    });
  }
}

function extractAssistantText(msg) {
  const content = msg?.message?.content ?? msg?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && (b.type === 'text' || typeof b.text === 'string'))
    .map((b) => b.text || '')
    .join('')
    .trim();
}

/** Forward tool_use calls to the debug UI live, tagged with this worker's id — powers the Workers tab live stream. */
function emitToolEvents(ev, job) {
  const content = ev?.message?.content ?? ev?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!block || block.type !== 'tool_use') continue;
    const input = block.input || {};
    const path = input.file_path || input.path || input.notebook_path || null;
    const command = input.command || null;
    const line = [block.name, path, command ? String(command).slice(0, 140) : null]
      .filter(Boolean)
      .join(' · ');
    appendEvent({
      dir: 'agent',
      tool: block.name,
      path: path || null,
      command: command ? String(command).slice(0, 300) : null,
      text: line || block.name,
      sessionId: job.sessionId || null,
      workerId: job.workerId || job.messageId,
    });
  }
}

function buildPrompt(job) {
  const parts = [];
  parts.push('You are an Auto worker subagent.');
  parts.push(autoAgentIdentity());
  parts.push(
    'Do exactly what the user asked, in full. Prefer action over questions — do not stop to ask for confirmation or clarification unless truly blocked (e.g. missing credentials, or a destructive/irreversible action beyond what was asked). Treat the ask as mandatory, not optional.',
  );
  parts.push(
    'Finish the entire task before reporting back. Do not stop partway, leave TODOs, or hand back a partial result with "let me know if you want me to continue" — keep going until the ask is fully done.',
  );
  parts.push(
    'When finished, summarize what you did in short plain text (this is reported back to the main agent / user).',
  );
  parts.push(
    'If this request is asking to switch the active repo/project (e.g. "switch to repo X", "work in the Y project" from now on), verifying the path with `cd`/`git status` is not enough — that does not persist. Make it stick by calling: ' +
      'curl -s -X POST http://127.0.0.1:4331/api/session -H "Content-Type: application/json" -d \'{"folder":"<absolute path>"}\' ' +
      '(this creates/reactivates the session for that folder and makes it active, so future jobs default to it). Only confirm the switch in your summary once that call has succeeded.',
  );
  if (job.context) {
    parts.push('');
    parts.push(
      'Recent conversation in this session (oldest first) — use it to resolve what "this", "that", or "the changes mentioned" refer to:',
    );
    parts.push(job.context);
  }
  parts.push('');
  parts.push('User message:');
  parts.push(job.text || '(no text)');
  if (Array.isArray(job.images) && job.images.length) {
    parts.push('');
    parts.push('Attached images (local paths — inspect with Read):');
    for (const img of job.images) {
      parts.push(`- ${img.localPath || img}`);
    }
  }
  if (job.folder) {
    parts.push('');
    parts.push(`Preferred working folder: ${job.folder}`);
  }
  return parts.join('\n');
}

function jobSafeName() {
  return String(Date.now()).slice(-6);
}

/** 401 / auth rejection from the spawned claude process (often exit code 0!). */
function looksLikeAuthFailure(result) {
  const s = `${result.text || ''}\n${result.stderr || ''}`;
  return /Failed to authenticate|API Error:\s*401|API Key appears to be invalid|may have expired|authentication_error|invalid.?api.?key/i.test(
    s,
  );
}

/**
 * Refresh Kimi OAuth into process.env right before spawning Claude.
 * Force when near expiry or when a prior attempt already got 401.
 */
async function refreshAuthForClaude({ force = false, reason = '' } = {}) {
  const label = reason ? ` (${reason})` : '';
  try {
    const { loadKimiOAuthCreds, oauthTokenExpired } = await import(
      './kimi-oauth.mjs'
    );
    const creds = loadKimiOAuthCreds();
    const nearExpiry =
      !creds ||
      oauthTokenExpired(creds) ||
      Number(creds.expires_at || 0) - Date.now() / 1000 < 300;
    const doForce = force || nearExpiry;
    const auth = await ensureAutoProviderAuth({ force: doForce });
    if (!auth.ready) {
      console.error(
        `[worker] auth not ready${label}: ${auth.warning || 'unknown'}`,
      );
    } else {
      console.error(
        `[worker] auth ok${label} force=${doForce} auth=${auth.auth || '?'}`,
      );
    }
    return auth;
  } catch (e) {
    console.error(`[worker] auth refresh failed${label}: ${e.message}`);
    return { ready: false, warning: e.message };
  }
}

async function runClaude(prompt, cwd, promptFile, job, { forceAuth = false } = {}) {
  await refreshAuthForClaude({
    force: forceAuth,
    reason: forceAuth ? 'forced' : 'pre-spawn',
  });

  const skip =
    process.env.AUTO_SKIP_PERMS === '0'
      ? []
      : ['--dangerously-skip-permissions'];
  const args = [
    '-p',
    ...skip,
    '--add-dir',
    cwd,
    '--output-format',
    'stream-json',
    '--verbose',
    '--name',
    `auto-worker-${jobSafeName()}`,
  ];
  writeFileSync(promptFile, prompt, 'utf8');
  return new Promise((resolve) => {
    if (!existsSync(cwd)) {
      resolve({
        code: 1,
        text: '',
        stderr: `Working directory does not exist: ${cwd}`,
      });
      return;
    }
    // Snapshot env AFTER refresh so Claude gets the current access token.
    const child = spawn('claude', args, {
      cwd,
      shell: true,
      windowsHide: true,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdoutBuf = '';
    let finalText = '';
    let err = '';
    child.stdout.on('data', (d) => {
      stdoutBuf += d.toString();
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type === 'assistant') emitToolEvents(ev, job);
        if (ev.type === 'result') {
          finalText =
            (typeof ev.result === 'string' && ev.result.trim()) ||
            extractAssistantText(ev) ||
            finalText;
        }
      }
    });
    child.stderr.on('data', (d) => {
      err += d.toString();
    });
    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        text: finalText.trim(),
        stderr: err.trim(),
      });
    });
    child.on('error', (e) => {
      resolve({ code: 1, text: '', stderr: String(e) });
    });
    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch (e) {
      resolve({ code: 1, text: '', stderr: String(e) });
    }
  });
}

async function replyTelegram(text) {
  if (process.env.AUTO_REPLY_TELEGRAM === '0') return;
  const send = join(HERE, 'send.mjs');
  await new Promise((resolve) => {
    let err = '';
    const child = spawn(process.execPath, [send, `--text=${text}`], {
      cwd: ROOT,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.on('data', (d) => {
      err += d.toString();
    });
    const onDone = (code) => {
      if (code) console.error(`[worker] telegram send failed (code ${code}): ${err.trim().slice(0, 300)}`);
      resolve();
    };
    child.on('close', onDone);
    child.on('error', (e) => {
      err = e.message;
      onDone(1);
    });
  });
}

const job = loadJob();
if (!job) {
  console.error('No job — pass --file=job.json or --text=…');
  process.exit(2);
}

// Never spawn claude with credentials we already know are bad — that surfaces
// as an opaque 401 from the harness. Refresh (forced once), and if auth still
// isn't ready, fail the job with the real reason instead.
let auth = await refreshAuthForClaude({ force: false, reason: 'job-start' });
if (!auth.ready) {
  auth = await refreshAuthForClaude({ force: true, reason: 'job-start-retry' });
}
if (!auth.ready) {
  const msg = `Provider auth failed: ${auth.warning || 'unknown reason'}`;
  console.error(`[worker] ${msg}`);
  await reportStatus(job, 'error', msg, { code: 1 });
  process.exit(1);
}

const cwd =
  normalizeFsPath(
    process.env.AUTO_CWD || job.folder || job.cwd || SKILL_ROOT || ROOT,
  ) || ROOT;

mkdirSync(RUNS, { recursive: true });
const runId = job.workerId || job.messageId || `run-${Date.now()}`;
const runPath = join(RUNS, `${runId}.json`);
writeFileSync(
  runPath,
  JSON.stringify({ startedAt: new Date().toISOString(), job, cwd }, null, 2) +
    '\n',
);

console.error(`[worker ${runId}] processing in ${cwd}`);
await reportStatus(job, 'started', `Worker started in ${cwd}`);

const prompt = buildPrompt(job);
const promptFile = join(RUNS, `${runId}.prompt.txt`);
let result = await runClaude(prompt, cwd, promptFile, job);

// Kimi access tokens last ~15 min. Claude often returns the 401 as result text
// with exit code 0 — treat that as auth failure, force-refresh, retry once.
if (looksLikeAuthFailure(result)) {
  console.error(
    '[worker] claude rejected credentials — forcing token refresh and retrying once',
  );
  await reportStatus(
    job,
    'progress',
    'Credentials expired (401) — refreshing Kimi token and retrying…',
  );
  result = await runClaude(prompt, cwd, promptFile, job, { forceAuth: true });
}

// Still auth-fail after retry → hard error (don't report as a successful done).
if (looksLikeAuthFailure(result)) {
  result = {
    code: 1,
    text: '',
    stderr:
      result.text ||
      result.stderr ||
      'Kimi auth failed after refresh — run npm run kimi:login',
  };
}

const summary =
  result.text?.slice(0, 3500) ||
  `Worker finished with code ${result.code}${
    result.stderr ? `: ${result.stderr.slice(0, 500)}` : ''
  }`;

writeFileSync(
  runPath,
  JSON.stringify(
    {
      finishedAt: new Date().toISOString(),
      job,
      cwd,
      code: result.code,
      text: result.text,
      stderr: result.stderr,
    },
    null,
    2,
  ) + '\n',
);

// Report done/error to the main agent — it narrates the reply to the user
// (Auto Web + Telegram) so we don't post our own duplicate 'out' bubble here.
await reportStatus(
  job,
  result.code === 0 ? 'done' : 'error',
  summary,
  { code: result.code },
);

// Optional direct telegram (usually off — main agent narrates)
await replyTelegram(summary.slice(0, 3500));

process.exit(result.code === 0 ? 0 : 1);
