#!/usr/bin/env node
/** Confirm the saved rows are the pre-enable values, without printing 59KB. */
import { readFileSync } from 'node:fs';

const { savedAt, values } = JSON.parse(readFileSync('state/desktop-bridge.backup.json', 'utf8'));
console.log(`saved at ${savedAt}`);
for (const [key, value] of Object.entries(values)) {
  if (value === null) {
    console.log(`${key} = (absent, will be deleted on disable)`);
    continue;
  }
  let note = `${value.length} chars`;
  if (value.length < 60) note = value;
  else if (key.includes('serverConfig')) {
    note += `, dev flag = ${JSON.parse(value).isDevDoNotUseForSecretThingsBecauseCanBeSpoofedByUsers ?? '(absent)'}`;
  } else if (key.includes('Overrides')) {
    note += `, desktop_bridge = ${JSON.stringify(JSON.parse(value).desktop_bridge ?? '(absent)')}`;
  }
  console.log(`${key} = ${note}`);
}
