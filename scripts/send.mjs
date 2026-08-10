#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import {
  arg,
  hasFlag,
  loadAuth,
  saveAuth,
  api,
  appendEvent,
  AUTH_PATH,
  TOKEN_PATH,
} from './lib.mjs';

function loadText() {
  const file = arg('file', '');
  const direct = arg('text', '');
  if (direct) return direct;
  if (file && existsSync(file)) return readFileSync(file, 'utf8');
  return process.env.TELEGRAM_TEXT || '';
}

async function waitForChatId(token, timeoutMs = 180_000) {
  console.error('Waiting for /start on the bot…');
  const deadline = Date.now() + timeoutMs;
  let offset = 0;
  while (Date.now() < deadline) {
    const updates = await api(token, `getUpdates?timeout=25&offset=${offset}`);
    for (const u of updates) {
      offset = Math.max(offset, u.update_id + 1);
      const chat = u.message?.chat || u.my_chat_member?.chat;
      if (chat?.id != null) return chat.id;
    }
  }
  throw new Error('Timed out waiting for /start');
}

const text = loadText().trim();
if (!text) {
  console.error('Usage: node send.mjs --text="…"   or   --file=path.txt');
  process.exit(1);
}

let { token, chatId } = loadAuth();
if (!token) {
  console.error(
    `Missing token. Save BotFather token to:\n  ${TOKEN_PATH}\nor set TELEGRAM_BOT_TOKEN`,
  );
  process.exit(2);
}

if (!chatId) {
  chatId = await waitForChatId(token);
  saveAuth({ token, chatId });
  console.error(`Saved chatId → ${AUTH_PATH}`);
}

await api(token, 'sendMessage', {
  chat_id: chatId,
  text,
  disable_web_page_preview: false,
});

// Callers that already log this same reply to Auto Web themselves (e.g.
// main-agent.mjs's replyUser, worker-agent.mjs's replyTelegram) pass
// --no-log so it isn't posted a second time. Callers with no other record
// of the message (e.g. supervise.mjs's crash alerts) leave logging on.
if (!hasFlag('no-log')) {
  appendEvent({
    dir: 'out',
    text,
    chatId,
    note: 'send.mjs',
  });
}

console.log('OK sent');
