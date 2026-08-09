#!/usr/bin/env node
/**
 * WhatsApp channel — sends via a linked-device session (Baileys).
 * One-time: scan the QR (WhatsApp → Linked devices). After that, auth
 * is reused from WHATSAPP_AUTH_DIR and messages send unattended.
 *
 *   node send-whatsapp.mjs --to=+4746634123 --file=message.txt
 *   node send-whatsapp.mjs --to=+4746634123 --text="…"
 */
import baileys, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exec } from 'node:child_process';
import pino from 'pino';
import { arg, appendEvent, PROJECT_ROOT, WHATSAPP_AUTH_DIR } from './lib.mjs';

const makeWASocket = baileys.makeWASocket ?? baileys.default?.makeWASocket ?? baileys;

mkdirSync(WHATSAPP_AUTH_DIR, { recursive: true });

const toRaw = arg('to', process.env.WHATSAPP_TO || '');
const textFile = arg('file', '');
const text =
  arg('text', '') ||
  (textFile && existsSync(textFile) ? readFileSync(textFile, 'utf8') : '') ||
  process.env.WHATSAPP_TEXT ||
  '';

if (!toRaw) {
  console.error('Missing --to=+<phone> (or WHATSAPP_TO)');
  process.exit(1);
}
if (!text.trim()) {
  console.error('Missing --text="…" or --file=path.txt');
  process.exit(1);
}

function toJid(phone) {
  const digits = phone.replace(/\D/g, '');
  if (!digits) throw new Error(`Bad phone: ${phone}`);
  return `${digits}@s.whatsapp.net`;
}

const jid = toJid(toRaw);
const maxAttempts = Number(arg('attempts', '3'));
const qrPath = join(PROJECT_ROOT, 'whatsapp-qr.png');
console.log(`Sending to ${toRaw} (${jid})`);

let openedQrThisAttempt = false;

async function writeQr(qr) {
  writeFileSync(join(PROJECT_ROOT, 'whatsapp-last-qr.txt'), qr);
  await QRCode.toFile(qrPath, qr, { width: 480, margin: 2 });
  if (!openedQrThisAttempt && process.platform === 'win32') {
    openedQrThisAttempt = true;
    exec(`start "" "${qrPath}"`);
    console.log('Opened whatsapp-qr.png for this attempt — scan it now (Linked devices).');
  }
}

async function connectOnce() {
  const { state, saveCreds } = await useMultiFileAuthState(WHATSAPP_AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try {
        sock.end(undefined);
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('\n── Scan this QR (also opened whatsapp-qr.png) ──\n');
        qrcode.generate(qr, { small: true });
        try {
          await writeQr(qr);
        } catch (err) {
          console.error('Could not write whatsapp-qr.png:', err?.message || err);
        }
      }

      if (connection === 'open') {
        try {
          await sock.sendMessage(jid, { text: text.trim() });
          console.log('✓ WhatsApp message sent');
          setTimeout(() => finish({ ok: true }), 1200);
        } catch (err) {
          console.error('Send failed:', err);
          finish({ ok: false, fatal: true });
        }
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        console.error(`Connection closed (${code ?? 'unknown'})`);
        finish({ ok: false, retry: !loggedOut, fatal: loggedOut });
      }
    });
  });
}

let sent = false;
for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  openedQrThisAttempt = false;
  console.log(`\nAttempt ${attempt}/${maxAttempts}…`);
  const result = await connectOnce();
  if (result.ok) {
    sent = true;
    break;
  }
  if (result.fatal) break;
  console.log('Retrying (scan the new QR when it appears)…');
  await new Promise((r) => setTimeout(r, 1500));
}

if (!sent) {
  console.error('Gave up waiting for WhatsApp link / send.');
  process.exit(1);
}

appendEvent({
  dir: 'out',
  channel: 'whatsapp',
  text,
  to: jid,
  note: 'send-whatsapp.mjs',
});
