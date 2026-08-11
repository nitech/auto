#!/usr/bin/env node
/**
 * How do you change the model mid-session? The protocol notes list the model
 * catalogue but not the call that switches it. Try the candidates and report
 * which one the agent accepts.
 *
 *   node spike/model-probe.mjs
 */
import { AcpClient } from '../src/acp/client.mjs';

const client = new AcpClient({ cwd: process.cwd() });
client.on('log', (m) => console.log(`[acp] ${m}`));

await client.start();
const session = await client.newSession({ cwd: process.cwd() });

console.log(`sessionId: ${session.sessionId}`);
console.log(`currentModelId: ${JSON.stringify(session.models?.currentModelId)}`);
console.log(`models: ${session.models?.availableModels?.length ?? 0}`);
console.log(
  `first few: ${JSON.stringify(session.models?.availableModels?.slice(0, 3), null, 2)}`,
);
console.log(`configOptions: ${JSON.stringify(session.configOptions, null, 2)?.slice(0, 1200)}`);

// Pick a model that is not the current one.
const target = session.models?.availableModels?.find(
  (m) => m.modelId !== session.models.currentModelId,
);
console.log(`\ntarget: ${target?.modelId} (${target?.name})`);

const attempts = [
  ['session/set_model', { sessionId: session.sessionId, modelId: target?.modelId }],
  [
    'session/set_config_option',
    { sessionId: session.sessionId, optionId: 'model', value: target?.modelId },
  ],
  [
    'session/set_session_model',
    { sessionId: session.sessionId, modelId: target?.modelId },
  ],
];

for (const [method, params] of attempts) {
  try {
    const res = await client.call(method, params, { timeoutMs: 15_000 });
    console.log(`OK   ${method} → ${JSON.stringify(res)}`);
    break;
  } catch (err) {
    console.log(`FAIL ${method} → ${err.message}`);
  }
}

await client.stop();
process.exit(0);
