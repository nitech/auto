#!/usr/bin/env node
/**
 * Prove the host puts the dev-override flag back on its own: clear it the way
 * Cursor's config refresh does, then watch.
 */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { gateState } from '../src/core/desktop-bridge-gate.mjs';

const DB = join(process.env.APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
const FLAG = 'isDevDoNotUseForSecretThingsBecauseCanBeSpoofedByUsers';

const db = new DatabaseSync(DB);
const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'cursorai/serverConfig'").get();
const config = JSON.parse(String(row.value));
delete config[FLAG];
db.prepare("UPDATE ItemTable SET value = ? WHERE key = 'cursorai/serverConfig'").run(
  JSON.stringify(config),
);
db.close();

console.log(`cleared the flag at ${new Date().toLocaleTimeString()}`);
console.log(`immediately after: devEligible = ${gateState().devEligible}`);

for (let i = 1; i <= 9; i += 1) {
  await new Promise((r) => setTimeout(r, 10_000));
  const state = gateState();
  console.log(`+${i * 10}s  devEligible = ${state.devEligible}  allOn = ${state.allOn}`);
  if (state.devEligible) {
    console.log('\nThe host restored it. The bridge will survive the next Cursor restart.');
    process.exit(0);
  }
}
console.log('\nStill cleared after 90s — the keeper is not running.');
process.exit(1);
