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

let phase = 'waiting'; // waiting → switching → restoring → done
let original = null;
let target = null;

function beginSwitch(models) {
  console.log(`catalogue: ${models.length} models`);
  if (models.length < 2) {
    console.error('FAIL: no catalogue to switch within');
    process.exit(1);
  }
  target = models.find((m) => m.modelId !== original);
  phase = 'switching';
  console.log(`switching to ${target.name}…`);
  send({ op: 'session.model', modelId: target.modelId });
}

// No attach op needed: the host attaches a new socket to the active session.

ws.on('message', (raw) => {
  const msg = JSON.parse(raw);

  if (msg.type === 'attached' && phase === 'waiting') {
    original = msg.meta.model;
    console.log(`attached: ${msg.meta.title}`);
    console.log(`current model: ${msg.meta.modelName} (${msg.meta.model})`);
    const models = msg.catalog?.models || [];
    // A cold host has no catalogue yet; it warms one and broadcasts it.
    if (models.length) beginSwitch(models);
    else console.log('catalogue empty, waiting for the host to warm it…');
    return;
  }

  if (msg.type === 'catalog' && phase === 'waiting') {
    beginSwitch(msg.catalog?.models || []);
    return;
  }

  if (msg.type === 'sessions') {
    const mine = msg.sessions.find((s) => s.id && s.active);
    if (!mine) return;

    if (phase === 'switching' && mine.model === target.modelId) {
      console.log(`now on ${mine.modelName}`);
      phase = 'restoring';
      console.log('switching back…');
      send({ op: 'session.model', modelId: original });
      return;
    }

    if (phase === 'restoring' && mine.model === original) {
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
  console.error(`FAIL: timed out in phase ${phase}`);
  process.exit(1);
}, 60_000);
