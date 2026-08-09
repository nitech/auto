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
import { arg, SKILL_ROOT, appendEvent, normalizeFsPath } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const RUNS = join(ROOT, 'runs');
const MAIN_URL = (
  process.env.AUTO_MAIN_URL || 'http://127.0.0.1:4332'
).replace(/\/$/, '');

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
  parts.push(
    'Do exactly what the user asked. Prefer action over questions. Do not treat it as optional.',
  );
  parts.push(
    'When finished, summarize what you did in short plain text (this is reported back to the main agent / user).',
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

function runClaude(prompt, cwd, promptFile, job) {
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

function jobSafeName() {
  return String(Date.now()).slice(-6);
}

async function replyTelegram(text) {
  if (process.env.AUTO_REPLY_TELEGRAM === '0') return;
  const send = join(HERE, 'send.mjs');
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [send, `--text=${text}`], {
      cwd: ROOT,
      windowsHide: true,
      stdio: 'inherit',
    });
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });
}

const job = loadJob();
if (!job) {
  console.error('No job — pass --file=job.json or --text=…');
  process.exit(2);
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
const result = await runClaude(prompt, cwd, promptFile, job);

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
