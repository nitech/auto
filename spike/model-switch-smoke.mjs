#!/usr/bin/env node
/**
 * Switch the running host's active session to another model over the same
 * WebSocket the web app uses, then switch it back.
 *
 *   node spike/model-switch-smoke.mjs [port]
 */
import { WebSocket } from 'ws';

const port = process.argv[2] || 4331;
const ws = new WebSocket(`ws://127.0.0.1:${port}/`);

const send = (msg) => ws.send(JSON.stringify(msg));
let original = null;
let target = null;

ws.on('open', () => send({ op: 'attach' }));

ws.on('message', (raw) => {
  const msg = JSON.parse(raw);

  if (msg.type === 'attached') {
    const models = msg.catalog?.models || [];
    console.log(`attached: ${msg.meta.title}`);
    console.log(`current model: ${msg.meta.modelName} (${msg.meta.model})`);
    console.log(`catalogue: ${models.length} models`);
    if (models.length < 2) {
      console.error('FAIL: no catalogue to switch within');
      process.exit(1);
    }
    original = msg.meta.model;
    target = models.find((m) => m.modelId !== original);
    console.log(`switching to ${target.name}…`);
    send({ op: 'session.model', modelId: target.modelId });
    return;
  }

  if (msg.type === 'sessions') {
    const mine = msg.sessions.find((s) => s.active);
    if (!mine) return;
    if (mine.model === target?.modelId) {
      console.log(`now on ${mine.modelName}`);
      console.log('switching back…');
      send({ op: 'session.model', modelId: original });
      target = null;
      return;
    }
    if (target === null && mine.model === original) {
      console.log(`restored ${mine.modelName}`);
      console.log('PASS: model switching works over the socket');
      process.exit(0);
    }
  }

  if (msg.type === 'error') {
    console.error(`FAIL: ${msg.message}`);
    process.exit(1);
  }
});

ws.on('error', (err) => {
  console.error(`FAIL: ${err.message}`);
  process.exit(1);
});

setTimeout(() => {
  console.error('FAIL: timed out');
  process.exit(1);
}, 60_000);
