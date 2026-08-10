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
export const ENV_PATH = join(PROJECT_ROOT, '.env');

/**
 * Load KEY=VALUE pairs from `.env` into process.env.
 * Does not override variables already set in the environment.
 * @param {string} [filePath]
 * @returns {Record<string, string>}
 */
export function loadDotEnv(filePath = ENV_PATH) {
  /** @type {Record<string, string>} */
  const loaded = {};
  if (!existsSync(filePath)) return loaded;
  let text = '';
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return loaded;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    loaded[key] = val;
    if (process.env[key] === undefined) process.env[key] = val;
  }
  return loaded;
}

/**
 * Point Claude Code at Kimi via Anthropic-compatible env vars.
 *
 * AUTO_PROVIDER=kimi|claude (default: claude)
 * AUTO_KIMI_MODE=coding|platform (default: coding = Kimi Code subscription)
 *   coding   → api.kimi.com/coding + membership (OAuth or Kimi Code console key)
 *   platform → api.moonshot.ai + pay-per-token Open Platform key
 * AUTO_KIMI_AUTH=oauth|key (coding mode; default oauth → ~/.kimi credentials)
 * KIMI_CODE_API_KEY — optional Kimi Code console key (subscription quota)
 * KIMI_API_KEY / MOONSHOT_API_KEY — platform pay-per-token key (mode=platform)
 * AUTO_MODEL — optional model id override
 *
 * @returns {{ provider: string, mode: string|null, model: string|null, ready: boolean, warning: string|null, auth?: string|null }}
 */
export function applyAutoProvider() {
  const provider = String(process.env.AUTO_PROVIDER || 'claude')
    .toLowerCase()
    .trim();
  if (provider !== 'kimi' && provider !== 'moonshot') {
    return {
      provider: provider || 'claude',
      mode: null,
      model: null,
      ready: true,
      warning: null,
      auth: null,
    };
  }

  let mode = String(process.env.AUTO_KIMI_MODE || 'coding')
    .toLowerCase()
    .trim();
  if (mode === 'subscription') mode = 'coding';

  const authMode = String(process.env.AUTO_KIMI_AUTH || 'oauth')
    .toLowerCase()
    .trim();

  let oauthAccess = '';
  if (mode === 'coding' && authMode !== 'key') {
    try {
      const credPath = join(homedir(), '.kimi', 'credentials', 'kimi-code.json');
      if (existsSync(credPath)) {
        const j = JSON.parse(readFileSync(credPath, 'utf8'));
        if (j?.access_token) oauthAccess = String(j.access_token);
      }
    } catch {
      /* ignore */
    }
  }

  const codingKey = String(
    process.env.KIMI_CODE_API_KEY ||
      (authMode === 'key' ? process.env.KIMI_API_KEY : '') ||
      '',
  ).trim();
  const platformKey = String(
    process.env.MOONSHOT_API_KEY ||
      process.env.ANTHROPIC_AUTH_TOKEN ||
      (mode === 'platform' ? process.env.KIMI_API_KEY : '') ||
      '',
  ).trim();

  const defaultModel = mode === 'coding' ? 'k3-256k' : 'kimi-k3[1m]';
  const model = String(
    process.env.AUTO_MODEL || process.env.ANTHROPIC_MODEL || defaultModel,
  ).trim();

  if (mode === 'coding') {
    const key = codingKey || oauthAccess;
    if (!key) {
      return {
        provider: 'kimi',
        mode,
        model,
        ready: false,
        auth: authMode,
        warning:
          'AUTO_PROVIDER=kimi (subscription) — run `npm run kimi:login` or set KIMI_CODE_API_KEY',
      };
    }
    process.env.ANTHROPIC_BASE_URL =
      process.env.ANTHROPIC_BASE_URL || 'https://api.kimi.com/coding/';
    process.env.ANTHROPIC_API_KEY = key;
    delete process.env.ANTHROPIC_AUTH_TOKEN;

    process.env.ANTHROPIC_MODEL = model;
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
    process.env.ANTHROPIC_DEFAULT_FABLE_MODEL = model;
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = model;
    if (!process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW) {
      process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '262144';
    }
    if (!process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS) {
      process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '262144';
    }
    if (!process.env.CLAUDE_CODE_EFFORT_LEVEL) {
      process.env.CLAUDE_CODE_EFFORT_LEVEL = 'high';
    }
    if (!process.env.ENABLE_TOOL_SEARCH) {
      process.env.ENABLE_TOOL_SEARCH = 'false';
    }

    return {
      provider: 'kimi',
      mode,
      model,
      ready: true,
      auth: codingKey ? 'key' : 'oauth',
      warning: null,
    };
  }

  if (!platformKey) {
    return {
      provider: 'kimi',
      mode,
      model,
      ready: false,
      auth: 'key',
      warning:
        'AUTO_KIMI_MODE=platform but MOONSHOT_API_KEY / KIMI_API_KEY is missing',
    };
  }
  process.env.ANTHROPIC_BASE_URL =
    process.env.ANTHROPIC_BASE_URL || 'https://api.moonshot.ai/anthropic';
  process.env.ANTHROPIC_AUTH_TOKEN = platformKey;
  delete process.env.ANTHROPIC_API_KEY;

  process.env.ANTHROPIC_MODEL = model;
  process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
  process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
  process.env.ANTHROPIC_DEFAULT_FABLE_MODEL = model;
  process.env.CLAUDE_CODE_SUBAGENT_MODEL = model;
  if (!process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW) {
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '1048576';
  }
  if (!process.env.CLAUDE_CODE_EFFORT_LEVEL) {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'max';
  }
  if (!process.env.ENABLE_TOOL_SEARCH) {
    process.env.ENABLE_TOOL_SEARCH = 'false';
  }

  return {
    provider: 'kimi',
    mode,
    model,
    ready: true,
    auth: 'key',
    warning: null,
  };
}

// Load .env before any port/env defaults so TELEGRAM_DEBUG_PORT etc. apply.
loadDotEnv();
export const AUTO_PROVIDER_INFO = applyAutoProvider();

/**
 * Refresh Kimi Code OAuth (if needed) and re-apply provider env.
 * Call from long-lived entrypoints before spawning Claude.
 */
export async function ensureAutoProviderAuth() {
  const provider = String(process.env.AUTO_PROVIDER || '')
    .toLowerCase()
    .trim();
  if (provider !== 'kimi' && provider !== 'moonshot') return AUTO_PROVIDER_INFO;
  const mode = String(process.env.AUTO_KIMI_MODE || 'coding')
    .toLowerCase()
    .trim();
  if (mode !== 'coding' && mode !== 'subscription') return AUTO_PROVIDER_INFO;

  const { ensureKimiAuthForProvider } = await import('./kimi-oauth.mjs');
  try {
    const r = await ensureKimiAuthForProvider();
    if (r.warning) {
      console.error(`[provider] WARNING: ${r.warning}`);
    }
    Object.assign(AUTO_PROVIDER_INFO, {
      ready: true,
      auth: r.source || 'oauth',
      warning: r.warning || null,
      mode: 'coding',
    });
  } catch (e) {
    Object.assign(AUTO_PROVIDER_INFO, {
      ready: false,
      warning: e.message,
    });
    console.error(`[provider] WARNING: ${e.message}`);
  }
  return AUTO_PROVIDER_INFO;
}


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
