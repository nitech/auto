#!/usr/bin/env node
/**
 * Send one rendered turn and one approval prompt to Telegram, without starting
 * a poller — the old stack still owns getUpdates until the cutover.
 *
 *   node spike/telegram-smoke.mjs
 */
import { loadTelegramAuth, tgApi, renderTurn } from '../src/core/telegram.mjs';

const auth = loadTelegramAuth();
if (!auth) {
  console.error('No Telegram credentials found');
  process.exit(1);
}
console.log(`auth ok: chat ${auth.chatId}`);

const body = renderTurn({
  text: 'Auto v2 is live: sessions, terminals, a browser panel & diffs.\n\nThis message came from the new host.',
  tools: [
    { label: 'Edit File', status: 'completed' },
    { label: 'npm test', status: 'completed' },
    { label: 'git push', status: 'in_progress' },
  ],
});

const sent = await tgApi(auth.token, 'sendMessage', {
  chat_id: auth.chatId,
  text: body,
  parse_mode: 'HTML',
  disable_web_page_preview: true,
});
console.log(`turn message sent: ${sent.message_id}`);

const perm = await tgApi(auth.token, 'sendMessage', {
  chat_id: auth.chatId,
  text: '🔐 <b>Permission needed</b>\nRun: git push origin master',
  parse_mode: 'HTML',
  reply_markup: {
    inline_keyboard: [
      [{ text: 'Allow once', callback_data: 'demo-allow' }],
      [{ text: 'Reject', callback_data: 'demo-reject' }],
    ],
  },
});
console.log(`permission message sent: ${perm.message_id}`);
console.log('PASS: outbound Telegram path works');
