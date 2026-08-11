#!/usr/bin/env node
/** The last thing the agent said in a session's transcript. */
import { readFileSync } from 'node:fs';

const file = `state/transcripts/${process.argv[2]}.jsonl`;
const records = readFileSync(file, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const lastUser = records.map((r) => r.kind).lastIndexOf('user_message');
const after = records.slice(lastUser);
console.log(`question: ${records[lastUser]?.text?.slice(0, 200)}\n`);
console.log(
  `answer: ${after
    .filter((r) => r.kind === 'agent_delta')
    .map((r) => r.text)
    .join('')
    .trim()}`,
);
