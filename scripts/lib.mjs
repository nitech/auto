import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Project root: D:\Sevenfold\auto */
export const PROJECT_ROOT = join(HERE, '..');
/** @deprecated alias — same as PROJECT_ROOT */
export const SKILL_ROOT = PROJECT_ROOT;
export const AUTH_PATH = join(PROJECT_ROOT, 'auth.json');
export const TOKEN_PATH = join(PROJECT_ROOT, 'bot-token.txt');
export const WHATSAPP_AUTH_DIR = join(PROJECT_ROOT, 'whatsapp-auth');
export const OFFSET_PATH = join(PROJECT_ROOT, 'offset.json');
export const EVENTS_PATH = join(PROJECT_ROOT, 'events.jsonl');
export const QUEUE_PATH = join(PROJECT_ROOT, 'pending-queue.json');
export const DEBUG_PORT = Number(process.env.TELEGRAM_DEBUG_PORT || 4331);
export const DEBUG_URL = `http://127.0.0.1:${DEBUG_PORT}`;

/** Fallback auth locations (legacy skill / bench). */
const LEGACY_AUTH_CANDIDATES = [
  join(homedir(), '.cursor', 'skills', 'telegram-notify', 'auth.json'),
  join(homedir(), 'Sevenfold', 'Setto', 'setto-agent', 'experiments', 'agent-bench', 'telegram-notify', 'auth.json'),
  'D:\\Sevenfold\\Setto\\setto-agent\\experiments\\agent-bench\\telegram-notify\\auth.json',
];

export function arg(name, fallback = '') {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

/** Normalize Cursor/hook paths like `/D:/foo` → `D:\foo` on Windows. */
export function normalizeFsPath(p) {
  if (p == null || p === '') return p;
  let s = String(p).trim();
  s = s.replace(/^\/([A-Za-z]):\//, '$1:/');
  s = s.replace(/^\/([A-Za-z]):\\/, '$1:\\');
  if (/^[A-Za-z]:\//.test(s)) s = s.replace(/\//g, '\\');
  return s;
}

export function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

export function loadAuth() {
  const candidates = [AUTH_PATH, ...LEGACY_AUTH_CANDIDATES];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const data = JSON.parse(readFileSync(p, 'utf8'));
    if (data.token && data.chatId != null) {
      if (p !== AUTH_PATH) {
        mkdirSync(SKILL_ROOT, { recursive: true });
        writeFileSync(AUTH_PATH, JSON.stringify(data, null, 2) + '\n');
      }
      return data;
    }
  }
  const token =
    process.env.TELEGRAM_BOT_TOKEN?.trim() ||
    (existsSync(TOKEN_PATH) ? readFileSync(TOKEN_PATH, 'utf8').trim() : '');
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim() || '';
  return {
    token,
    chatId: chatId ? Number(chatId) || chatId : '',
  };
}

export function saveAuth(auth) {
  mkdirSync(SKILL_ROOT, { recursive: true });
  writeFileSync(AUTH_PATH, JSON.stringify(auth, null, 2) + '\n');
}

export async function api(token, method, body) {
  const url = method.includes('?')
    ? `https://api.telegram.org/bot${token}/${method}`
    : `https://api.telegram.org/bot${token}/${method}`;
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`${method}: ${data.description || JSON.stringify(data)}`);
  }
  return data.result;
}

export function loadOffset() {
  if (!existsSync(OFFSET_PATH)) return 0;
  try {
    return Number(JSON.parse(readFileSync(OFFSET_PATH, 'utf8')).offset) || 0;
  } catch {
    return 0;
  }
}

export function saveOffset(offset) {
  writeFileSync(OFFSET_PATH, JSON.stringify({ offset }, null, 2) + '\n');
}

export function appendEvent(event) {
  mkdirSync(SKILL_ROOT, { recursive: true });
  const row = {
    ts: new Date().toISOString(),
    ...event,
  };
  appendFileSync(EVENTS_PATH, JSON.stringify(row) + '\n');
  // Best-effort notify live debug UI (ignore failures).
  fetch(`${DEBUG_URL}/api/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...row, _persisted: true }),
  }).catch(() => {});
  return row;
}

export async function debugServerUp() {
  try {
    const res = await fetch(`${DEBUG_URL}/api/health`, {
      signal: AbortSignal.timeout(800),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function normalizeMessage(update) {
  const msg = update.message || update.edited_message;
  if (!msg) return null;

  const hasPhoto = Array.isArray(msg.photo) && msg.photo.length > 0;
  const hasDoc = Boolean(msg.document);
  const text = (msg.text || msg.caption || '').trim();

  // Skip empty service noise, but keep photo/doc even without caption.
  if (!text && !hasPhoto && !hasDoc && !msg.voice && !msg.video) return null;

  const photo = hasPhoto ? msg.photo[msg.photo.length - 1] : null;

  return {
    updateId: update.update_id,
    messageId: msg.message_id,
    chatId: msg.chat?.id,
    from: msg.from?.username || msg.from?.first_name || null,
    date: msg.date,
    text,
    hasPhoto,
    hasDocument: hasDoc,
    photoFileId: photo?.file_id || null,
    documentFileId: msg.document?.file_id || null,
    documentName: msg.document?.file_name || null,
  };
}

/** Download a Telegram file_id to destPath. Returns absolute path. */
export async function downloadFile(token, fileId, destPath) {
  const file = await api(token, 'getFile', { file_id: fileId });
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`downloadFile HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const { writeFileSync: w, mkdirSync: m } = await import('node:fs');
  const { dirname: d } = await import('node:path');
  m(d(destPath), { recursive: true });
  w(destPath, buf);
  return destPath;
}
