#!/usr/bin/env node
/**
 * Can we see the agent's own sessions — the ones the desktop Agents window
 * shows — and are they grouped by project? The initialize response advertises
 * a session list capability; find out what it actually returns.
 *
 *   node spike/session-list-probe.mjs [cwd]
 */
import { AcpClient } from '../src/acp/client.mjs';

const cwd = process.argv[2] || process.cwd();
const client = new AcpClient({ cwd });
client.on('log', (m) => console.log(`[acp] ${m}`));

const info = await client.start();
console.log('=== initialize ===');
console.log(JSON.stringify(info, null, 2).slice(0, 2000));

const attempts = [
  ['session/list', {}],
  ['session/list', { cwd }],
  ['session/list', { limit: 5 }],
];

for (const [method, params] of attempts) {
  try {
    const res = await client.call(method, params, { timeoutMs: 20_000 });
    const sessions = res?.sessions || res;
    const count = Array.isArray(sessions) ? sessions.length : 'n/a';
    console.log(`\n=== OK ${method} ${JSON.stringify(params)} → ${count} entries ===`);
    console.log(JSON.stringify(sessions, null, 2).slice(0, 3000));
    break;
  } catch (err) {
    console.log(`FAIL ${method} ${JSON.stringify(params)} → ${err.message}`);
  }
}

await client.stop();
process.exit(0);
