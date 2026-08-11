#!/usr/bin/env node
/**
 * M0 spike: probe `cursor-agent acp`.
 *
 * Answers the questions that gate the Auto v2 build:
 *   - does the hidden `acp` subcommand speak ACP at all?
 *   - what protocolVersion and agentCapabilities does it advertise?
 *   - does it support loadSession (resumable sessions)?
 *   - does it accept our terminal / fs client capabilities?
 *   - what does a real prompt turn's session/update stream look like?
 *
 * Throwaway diagnostic. Run: node spike/acp-probe.mjs [prompt]
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const PROMPT = process.argv.slice(2).join(' ') || 'Reply with exactly: PROBE_OK';
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 120_000);

/** Resolve the real node.exe + index.js so we avoid the PowerShell shim. */
function resolveAgent() {
  const home = process.env.LOCALAPPDATA || '';
  const base = join(home, 'cursor-agent');
  const versions = join(base, 'versions');
  if (existsSync(versions)) {
    const dirs = readdirSync(versions).filter((d) =>
      /^\d{4}\.\d{1,2}\.\d{1,2}(-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/.test(d),
    );
    dirs.sort();
    const latest = dirs[dirs.length - 1];
    if (latest) {
      const node = join(versions, latest, 'node.exe');
      const index = join(versions, latest, 'index.js');
      if (existsSync(node) && existsSync(index)) {
        return { cmd: node, args: [index], shell: false, how: `${latest} (direct)` };
      }
    }
  }
  const cmd = join(base, 'cursor-agent.cmd');
  if (existsSync(cmd)) return { cmd, args: [], shell: true, how: 'cursor-agent.cmd' };
  return { cmd: 'cursor-agent', args: [], shell: true, how: 'PATH' };
}

const bin = resolveAgent();
console.log(`[probe] launching via ${bin.how}`);

const child = spawn(bin.cmd, [...bin.args, 'acp'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: bin.shell,
  windowsHide: true,
  env: { ...process.env },
});

let nextId = 1;
const pending = new Map();
const updateKinds = new Map();
let buf = '';
let sawAnyJson = false;

function send(method, params) {
  const id = nextId++;
  const msg = { jsonrpc: '2.0', id, method, params };
  console.log(`\n[probe] --> ${method}`);
  child.stdin.write(JSON.stringify(msg) + '\n');
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method });
  });
}

function respond(id, result) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function handle(msg) {
  sawAnyJson = true;

  // Response to something we sent
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
    return;
  }

  // Request FROM the agent -> we are the client, answer minimally
  if (msg.method && msg.id !== undefined) {
    console.log(`[probe] <-- REQUEST ${msg.method} ${JSON.stringify(msg.params).slice(0, 300)}`);
    if (msg.method === 'session/request_permission') {
      const opt = msg.params?.options?.find((o) => /allow/i.test(o.kind || o.optionId || ''));
      respond(msg.id, {
        outcome: { outcome: 'selected', optionId: opt?.optionId ?? msg.params?.options?.[0]?.optionId },
      });
    } else if (msg.method === 'fs/read_text_file') {
      respond(msg.id, { content: '' });
    } else if (msg.method === 'fs/write_text_file') {
      respond(msg.id, {});
    } else if (msg.method === 'terminal/create') {
      respond(msg.id, { terminalId: 'probe-term-1' });
    } else if (msg.method === 'terminal/output') {
      respond(msg.id, { output: '', truncated: false, exitStatus: { exitCode: 0, signal: null } });
    } else if (msg.method === 'terminal/wait_for_exit') {
      respond(msg.id, { exitCode: 0, signal: null });
    } else {
      respond(msg.id, {});
    }
    return;
  }

  // Notification
  if (msg.method === 'session/update') {
    const kind = msg.params?.update?.sessionUpdate || 'unknown';
    updateKinds.set(kind, (updateKinds.get(kind) || 0) + 1);
    const preview = JSON.stringify(msg.params?.update).slice(0, 220);
    console.log(`[probe] <-- update:${kind} ${preview}`);
    return;
  }

  console.log(`[probe] <-- ${msg.method || 'message'} ${JSON.stringify(msg).slice(0, 240)}`);
}

child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      console.log(`[probe] <-- (non-json) ${line.slice(0, 200)}`);
    }
  }
});

child.stderr.on('data', (d) => {
  const s = d.toString().trim();
  if (s) console.log(`[probe] stderr: ${s.slice(0, 400)}`);
});

child.on('exit', (code) => {
  console.log(`\n[probe] agent exited code=${code}`);
  summarize();
  process.exit(code ?? 0);
});

function summarize() {
  console.log('\n================ PROBE SUMMARY ================');
  console.log(`spoke JSON-RPC:      ${sawAnyJson}`);
  console.log(`session/update kinds: ${[...updateKinds.entries()].map(([k, n]) => `${k}×${n}`).join(', ') || '(none)'}`);
  console.log('===============================================');
}

const timer = setTimeout(() => {
  console.log('\n[probe] TIMEOUT');
  summarize();
  child.kill();
  process.exit(2);
}, TIMEOUT_MS);

try {
  const init = await send('initialize', {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    },
  });
  console.log('\n[probe] initialize result:');
  console.log(JSON.stringify(init, null, 2));

  const caps = init?.agentCapabilities || {};
  console.log('\n---- CAPABILITY GATE ----');
  console.log(`protocolVersion : ${init?.protocolVersion}`);
  console.log(`loadSession     : ${caps.loadSession === true ? 'YES (resumable sessions)' : 'no'}`);
  console.log(`promptCapabilities: ${JSON.stringify(caps.promptCapabilities || {})}`);
  console.log(`authMethods     : ${JSON.stringify(init?.authMethods || [])}`);
  console.log('-------------------------');

  const session = await send('session/new', {
    cwd: process.cwd(),
    mcpServers: [],
  });
  console.log(`\n[probe] session/new -> ${JSON.stringify(session)}`);

  const sessionId = session?.sessionId;
  if (sessionId) {
    const res = await send('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: PROMPT }],
    });
    console.log(`\n[probe] session/prompt -> ${JSON.stringify(res)}`);
  }

  clearTimeout(timer);
  summarize();
  child.kill();
  process.exit(0);
} catch (e) {
  clearTimeout(timer);
  console.log(`\n[probe] FAILED: ${e.message}`);
  summarize();
  child.kill();
  process.exit(1);
}
