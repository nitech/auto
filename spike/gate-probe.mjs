#!/usr/bin/env node
/** Inspect the local statsig bootstrap + override storage for the desktop_bridge gate. */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const db = new DatabaseSync(
  join(process.env.APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
  { readOnly: true },
);

const get = (key) => db.prepare('select value from ItemTable where key = ?').get(key)?.value;

for (const key of [
  'workbench.experiments.featureFlagOverrides',
  'cursor/desktopBridgeUserEnabled',
  'cursor.desktopBridge.enabled',
]) {
  console.log(`${key} = ${get(key) ?? '(unset)'}`);
}

const boot = get('workbench.experiments.statsigBootstrap');
console.log(`\nstatsigBootstrap: ${boot ? `${String(boot).length} bytes` : '(unset)'}`);
if (boot) {
  const text = String(boot);
  const at = text.indexOf('desktop_bridge');
  console.log(at < 0 ? 'desktop_bridge: NOT present in bootstrap' : `desktop_bridge found at ${at}: ${text.slice(at - 60, at + 200)}`);
  const hashed = /"feature_gates":\{"[a-zA-Z0-9+/=]{8}/.test(text);
  console.log(`gate names look hashed: ${hashed}`);
}

console.log('\n--- serverConfig-ish keys ---');
for (const r of db.prepare("select key, length(value) n from ItemTable where key like '%erverConfig%' or key like '%aiServer%'").all()) {
  console.log(`${r.key}  (${r.n} bytes)`);
}
