#!/usr/bin/env node
/**
 * Poll Telegram for inbound messages from the linked chat.
 *
 *   node listen.mjs --once --timeout=25
 *   node listen.mjs --watch --timeout=25
 *
 * If debug-server.mjs is running, drains /api/drain (avoids getUpdates conflict).
 */
import { join } from 'node:path';
import {
  arg,
  hasFlag,
  loadAuth,
  api,
  loadOffset,
  saveOffset,
  normalizeMessage,
  downloadFile,
  debugServerUp,
  DEBUG_URL,
  SKILL_ROOT,
  appendEvent,
} from './lib.mjs';

const { token, chatId } = loadAuth();
if (!token) {
  console.error('Missing auth — run send once or create auth.json');
  process.exit(2);
}

const timeout = Math.min(50, Math.max(0, Number(arg('timeout', '25')) || 25));
const once = hasFlag('once') || !hasFlag('watch');
const allChats = hasFlag('all-chats');
const doDownload = hasFlag('download');
const allowed = allChats ? null : Number(chatId);

async function drainFromDebug() {
  const res = await fetch(`${DEBUG_URL}/api/drain`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`debug drain HTTP ${res.status}`);
  const data = await res.json();
  return data.messages || [];
}

async function pollTelegram() {
  let offset = loadOffset();
  let updates;
  try {
    updates = await api(token, `getUpdates?timeout=${timeout}&offset=${offset}`);
  } catch (err) {
    const msg = String(err?.message || err);
    if (/Conflict/i.test(msg)) {
      await new Promise((r) => setTimeout(r, 1500));
      updates = await api(token, `getUpdates?timeout=0&offset=${offset}`);
    } else {
      throw err;
    }
  }
  const out = [];
  for (const u of updates) {
    offset = Math.max(offset, u.update_id + 1);
    const msg = normalizeMessage(u);
    if (!msg) continue;
    if (allowed != null && Number(msg.chatId) !== allowed) continue;
    if (doDownload && msg.photoFileId) {
      const dest = join(SKILL_ROOT, 'inbox', `${msg.messageId}.jpg`);
      try {
        msg.localPath = await downloadFile(token, msg.photoFileId, dest);
      } catch (e) {
        msg.downloadError = String(e?.message || e);
      }
    }
    appendEvent({
      dir: 'in',
      from: msg.from,
      text: msg.text,
      hasPhoto: msg.hasPhoto,
      messageId: msg.messageId,
      note: 'listen.mjs',
      previewUrl: msg.localPath
        ? `/inbox/${msg.messageId}.jpg`
        : null,
    });
    out.push(msg);
  }
  saveOffset(offset);
  return out;
}

async function pollRound() {
  if (await debugServerUp()) {
    return drainFromDebug();
  }
  return pollTelegram();
}

if (once) {
  const msgs = await pollRound();
  console.log(JSON.stringify({ count: msgs.length, messages: msgs }, null, 2));
  process.exit(0);
}

console.error('Watching Telegram… (Ctrl+C to stop)');
while (true) {
  try {
    const msgs = await pollRound();
    for (const m of msgs) {
      console.log(JSON.stringify(m));
    }
    if (await debugServerUp()) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  } catch (err) {
    console.error('poll error:', err?.message || err);
    await new Promise((r) => setTimeout(r, 2000));
  }
}
