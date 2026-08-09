#!/usr/bin/env node
/**
 * Cursor hook → Telegram debug console.
 * Reads hook JSON from stdin, POSTs a summary to the debug server, exits 0.
 */
import { createInterface } from 'node:readline';

const PORT = process.env.TELEGRAM_DEBUG_PORT || '4331';
const BASE = `http://127.0.0.1:${PORT}`;

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

function pick(...vals) {
  for (const v of vals) {
    if (v != null && v !== '') return v;
  }
  return null;
}

function summarize(payload) {
  const event = payload.hook_event_name || payload.event || payload.type || 'hook';
  const tool =
    payload.tool_name ||
    payload.toolName ||
    payload.tool ||
    payload.matcher ||
    null;
  const cwd = pick(
    payload.cwd,
    payload.working_directory,
    payload.workspace_root,
    Array.isArray(payload.workspace_roots)
      ? payload.workspace_roots[0]
      : null,
  );
  const roots = payload.workspace_roots || payload.workspaceRoots || null;

  const input = payload.tool_input || payload.toolInput || payload.input || {};
  const path = pick(
    input.path,
    input.file_path,
    input.filePath,
    input.target_notebook,
    payload.path,
    payload.file_path,
  );
  const command = pick(input.command, payload.command);

  let text = '';
  if (tool) text += tool;
  if (path) text += (text ? ' · ' : '') + path;
  if (command) {
    const short = String(command).replace(/\s+/g, ' ').slice(0, 160);
    text += (text ? ' · ' : '') + short;
  }
  if (!text) {
    text = `${event}` + (payload.raw ? ` · ${String(payload.raw).slice(0, 120)}` : '');
  }

  // Rough token estimate from response / prompt fields when present
  const blob = [
    payload.agent_response,
    payload.response,
    payload.text,
    payload.prompt,
    JSON.stringify(input || {}),
  ]
    .filter(Boolean)
    .join('\n');
  const estTokens = blob ? Math.max(1, Math.round(blob.length / 4)) : 0;

  const tokens = payload.token_usage || payload.tokens || null;
  let tokenDelta = null;
  if (tokens && typeof tokens === 'object') {
    tokenDelta = {
      input: Number(tokens.input || tokens.prompt || 0) || 0,
      output: Number(tokens.output || tokens.completion || 0) || 0,
      total:
        Number(tokens.total || 0) ||
        Number(tokens.input || 0) + Number(tokens.output || 0) ||
        0,
      estimated: false,
    };
  } else if (estTokens && /afterAgentResponse|afterAgentThought|stop/i.test(event)) {
    tokenDelta = { input: 0, output: estTokens, total: estTokens, estimated: true };
  }

  return {
    dir: 'agent',
    event,
    tool,
    text,
    path: path || null,
    command: command ? String(command).slice(0, 300) : null,
    cwd: cwd || null,
    workspaces: roots || (cwd ? [cwd] : null),
    tokenDelta,
    note: event,
  };
}

async function post(path, body) {
  try {
    await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(1500),
    });
  } catch {
    // Debug server may be down — fail open
  }
}

const payload = await readStdin();
const summary = summarize(payload);

if (summary.cwd || summary.workspaces) {
  await post('/api/session', {
    folder: summary.cwd,
    workspaces: summary.workspaces,
    project: summary.cwd
      ? String(summary.cwd).replace(/[\\/]+$/, '').split(/[\\/]/).pop()
      : undefined,
  });
}

if (summary.tokenDelta) {
  await post('/api/tokens', summary.tokenDelta);
  delete summary.tokenDelta; // avoid double-count in /api/event
}

// Skip log spam for session/token-only hooks — footer already updated
const note = String(summary.note || summary.event || '');
const useful =
  summary.tool ||
  summary.path ||
  summary.command ||
  (summary.text &&
    String(summary.text).trim().length > 40 &&
    !/^(sessionStart|stop|afterAgentResponse|afterAgentThought)$/i.test(
      String(summary.text).trim(),
    ));
const skip =
  /^(sessionStart|stop|afterAgentThought)$/i.test(note) ||
  (note === 'afterAgentResponse' && !useful);
if (!skip) {
  await post('/api/event', summary);
}

// Always allow / continue
if (
  /preToolUse|beforeShell|beforeMCP|beforeRead/i.test(
    String(payload.hook_event_name || payload.event || ''),
  )
) {
  process.stdout.write(JSON.stringify({ permission: 'allow' }));
}
process.exit(0);
