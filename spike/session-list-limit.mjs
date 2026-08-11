#!/usr/bin/env node
/** Is session/list truncated, and does it page? */
import { AcpClient } from '../src/acp/client.mjs';

const client = new AcpClient({ cwd: process.cwd() });
await client.start();

for (const params of [{}, { limit: 200 }, { limit: 200, includeAll: true }, { cursor: null }]) {
  try {
    const res = await client.call('session/list', params, { timeoutMs: 20_000 });
    const list = res?.sessions || [];
    const cwds = [...new Set(list.map((s) => s.cwd))];
    console.log(
      `${JSON.stringify(params)} → ${list.length} sessions across ${cwds.length} folders` +
        `${res?.nextCursor ? ` (nextCursor: ${res.nextCursor})` : ''}`,
    );
    console.log(`  keys: ${Object.keys(res || {}).join(', ')}`);
    for (const c of cwds) console.log(`  ${c}: ${list.filter((s) => s.cwd === c).length}`);
  } catch (err) {
    console.log(`${JSON.stringify(params)} → FAIL ${err.message}`);
  }
}

await client.stop();
process.exit(0);
