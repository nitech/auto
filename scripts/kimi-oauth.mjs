/**
 * Kimi Code subscription OAuth (device flow + refresh).
 * Credentials: ~/.kimi/credentials/kimi-code.json
 *
 * Used so Auto can call https://api.kimi.com/coding/ against membership
 * quota instead of pay-per-token platform.kimi.ai keys.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  openSync,
  closeSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir, hostname, release } from 'node:os';
import { randomUUID } from 'node:crypto';

export const KIMI_OAUTH_HOST =
  process.env.KIMI_CODE_OAUTH_HOST ||
  process.env.KIMI_OAUTH_HOST ||
  'https://auth.kimi.com';
export const KIMI_OAUTH_CLIENT_ID =
  process.env.KIMI_OAUTH_CLIENT_ID || '17e5f671-d194-4dfb-9706-5516cb48c098';
export const KIMI_HOME = join(homedir(), '.kimi');
export const KIMI_CRED_PATH = join(KIMI_HOME, 'credentials', 'kimi-code.json');
export const KIMI_DEVICE_ID_PATH = join(KIMI_HOME, 'device_id');

const REFRESH_SKEW_SEC = 180;

function deviceHeaders() {
  return {
    'X-Msh-Platform': process.platform === 'win32' ? 'win32' : process.platform,
    'X-Msh-Version': process.env.AUTO_KIMI_CLIENT_VERSION || 'auto',
    'X-Msh-Device-Name': hostname().slice(0, 64),
    'X-Msh-Os-Version': release().slice(0, 64),
    'X-Msh-Device-Id': getOrCreateDeviceId(),
  };
}

export function getOrCreateDeviceId() {
  try {
    if (existsSync(KIMI_DEVICE_ID_PATH)) {
      const id = readFileSync(KIMI_DEVICE_ID_PATH, 'utf8').trim();
      if (id) return id;
    }
  } catch {
    /* fall through */
  }
  mkdirSync(KIMI_HOME, { recursive: true });
  const id = randomUUID().replace(/-/g, '');
  writeFileSync(KIMI_DEVICE_ID_PATH, id, 'utf8');
  return id;
}

/** @returns {{ access_token: string, refresh_token: string, expires_at: number, token_type?: string, scope?: string } | null} */
export function loadKimiOAuthCreds() {
  try {
    if (!existsSync(KIMI_CRED_PATH)) return null;
    const j = JSON.parse(readFileSync(KIMI_CRED_PATH, 'utf8'));
    if (!j?.access_token || !j?.refresh_token) return null;
    return j;
  } catch {
    return null;
  }
}

/** @param {Record<string, unknown>} token */
export function saveKimiOAuthCreds(token) {
  mkdirSync(join(KIMI_HOME, 'credentials'), { recursive: true });
  const expiresAt =
    typeof token.expires_at === 'number'
      ? token.expires_at
      : Date.now() / 1000 + Number(token.expires_in || 900);
  const out = {
    access_token: String(token.access_token),
    refresh_token: String(token.refresh_token || token.refreshToken || ''),
    expires_at: expiresAt,
    expires_in: Number(token.expires_in || 900),
    token_type: String(token.token_type || 'Bearer'),
    scope: String(token.scope || 'kimi-code'),
  };
  // Keep existing refresh_token if response omitted it.
  if (!out.refresh_token) {
    const prev = loadKimiOAuthCreds();
    if (prev?.refresh_token) out.refresh_token = prev.refresh_token;
  }
  // Atomic write (tmp + rename): main agent and workers share this file, and
  // a reader catching a half-written file would parse-fail and treat us as
  // logged out.
  const tmp = `${KIMI_CRED_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n', 'utf8');
  renameSync(tmp, KIMI_CRED_PATH);
  return out;
}

async function postForm(url, params) {
  const body = new URLSearchParams(params).toString();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      ...deviceHeaders(),
    },
    body,
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data };
}

export function oauthTokenExpired(creds, skewSec = REFRESH_SKEW_SEC) {
  if (!creds?.access_token) return true;
  const exp = Number(creds.expires_at || 0);
  if (!exp) return false;
  return Date.now() / 1000 >= exp - skewSec;
}

/** Refresh access token; throws on invalid_grant (need re-login). */
export async function refreshKimiOAuth(creds = loadKimiOAuthCreds()) {
  if (!creds?.refresh_token) {
    throw new Error('No Kimi Code refresh token — run: npm run kimi:login');
  }
  const { status, data } = await postForm(`${KIMI_OAUTH_HOST}/api/oauth/token`, {
    client_id: KIMI_OAUTH_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: creds.refresh_token,
  });
  if (status === 200 && data.access_token) {
    return saveKimiOAuthCreds({
      ...data,
      refresh_token: data.refresh_token || creds.refresh_token,
    });
  }
  const err = data.error || `HTTP ${status}`;
  const desc = data.error_description || data.message || '';
  const e = new Error(`Kimi OAuth refresh failed: ${err} ${desc}`.trim());
  e.code = err;
  throw e;
}

/**
 * Ensure a usable access token is on disk (refresh if needed).
 * @param {{ force?: boolean }} [opts] force=true always refreshes OAuth
 * @returns {Promise<{ access_token: string, source: 'oauth'|'env', warning: string|null }>}
 */
export async function ensureKimiCodingToken(opts = {}) {
  const force = Boolean(opts.force);
  const envKey = String(process.env.KIMI_CODE_API_KEY || '').trim();
  // Prefer explicit coding console key when set and auth mode isn't forced oauth-only.
  const authMode = String(process.env.AUTO_KIMI_AUTH || 'oauth')
    .toLowerCase()
    .trim();
  if (authMode === 'key') {
    const key = envKey || String(process.env.KIMI_API_KEY || '').trim();
    if (!key) {
      throw new Error(
        'AUTO_KIMI_AUTH=key but KIMI_CODE_API_KEY is missing — set it or run npm run kimi:login',
      );
    }
    return { access_token: key, source: 'env', warning: null };
  }

  let creds = loadKimiOAuthCreds();
  if (!creds) {
    if (envKey) {
      return {
        access_token: envKey,
        source: 'env',
        warning:
          'Using KIMI_CODE_API_KEY — for subscription OAuth run: npm run kimi:login',
      };
    }
    throw new Error(
      'No Kimi Code subscription login. Run: npm run kimi:login',
    );
  }
  if (force || oauthTokenExpired(creds)) {
    // Main agent and workers share this file and all refresh around the same
    // expiry — re-read before burning a refresh, and prefer fresh disk creds
    // a sibling process may have just saved.
    const onDisk = loadKimiOAuthCreds();
    if (!force && onDisk && !oauthTokenExpired(onDisk)) {
      creds = onDisk;
    } else {
      try {
        creds = await refreshKimiOAuth(
          onDisk && Number(onDisk.expires_at) > Number(creds.expires_at)
            ? onDisk
            : creds,
        );
      } catch (e) {
        // A concurrent refresh can rotate/invalidate the refresh token we just
        // tried — the winner saved fresh creds, so re-read once before failing.
        const again = loadKimiOAuthCreds();
        if (again && !oauthTokenExpired(again)) {
          creds = again;
        } else if (envKey) {
          return {
            access_token: envKey,
            source: 'env',
            warning: `OAuth refresh failed (${e.message}); fell back to KIMI_CODE_API_KEY`,
          };
        } else {
          throw new Error(
            `${e.message}. Re-login with: npm run kimi:login`,
          );
        }
      }
    }
  }
  return {
    access_token: creds.access_token,
    source: 'oauth',
    warning: null,
  };
}

/** Start device authorization. */
export async function startKimiDeviceLogin() {
  const { status, data } = await postForm(
    `${KIMI_OAUTH_HOST}/api/oauth/device_authorization`,
    { client_id: KIMI_OAUTH_CLIENT_ID },
  );
  if (status !== 200) {
    throw new Error(
      `Device authorization failed (HTTP ${status}): ${JSON.stringify(data)}`,
    );
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    verificationUriComplete: data.verification_uri_complete,
    expiresIn: Number(data.expires_in || 1800),
    interval: Number(data.interval || 5),
  };
}

/** Poll until device login completes; saves credentials. */
export async function pollKimiDeviceLogin(deviceCode, intervalSec = 5) {
  const grant = 'urn:ietf:params:oauth:grant-type:device_code';
  for (;;) {
    const { status, data } = await postForm(
      `${KIMI_OAUTH_HOST}/api/oauth/token`,
      {
        client_id: KIMI_OAUTH_CLIENT_ID,
        device_code: deviceCode,
        grant_type: grant,
      },
    );
    if (status === 200 && data.access_token) {
      return saveKimiOAuthCreds(data);
    }
    const err = data.error || '';
    if (err === 'authorization_pending' || err === 'slow_down') {
      const wait = err === 'slow_down' ? intervalSec * 2 : intervalSec;
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (err === 'expired_token') {
      throw new Error('Device code expired — run kimi:login again');
    }
    if (err === 'access_denied') {
      throw new Error('Access denied in browser');
    }
    throw new Error(
      `Device login failed (HTTP ${status}): ${err} ${data.error_description || ''}`.trim(),
    );
  }
}

/** Apply coding token into process.env for Claude Code. */
export function applyCodingTokenToEnv(accessToken) {
  process.env.ANTHROPIC_BASE_URL = 'https://api.kimi.com/coding/';
  process.env.ANTHROPIC_API_KEY = accessToken;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

/**
 * Refresh OAuth if needed and stamp Claude Code env for subscription.
 * No-op unless AUTO_PROVIDER=kimi and AUTO_KIMI_MODE=coding (default).
 * @param {{ force?: boolean }} [opts]
 */
export async function ensureKimiAuthForProvider(opts = {}) {
  const provider = String(process.env.AUTO_PROVIDER || '')
    .toLowerCase()
    .trim();
  if (provider !== 'kimi' && provider !== 'moonshot') {
    return { skipped: true };
  }
  const mode = String(process.env.AUTO_KIMI_MODE || 'coding')
    .toLowerCase()
    .trim();
  if (mode !== 'coding' && mode !== 'subscription') {
    return { skipped: true, mode };
  }
  const tok = await ensureKimiCodingToken(opts);
  applyCodingTokenToEnv(tok.access_token);
  return { skipped: false, mode: 'coding', ...tok };
}

// silence unused openSync import risk — keep file lock helper available
export function touchCredLock() {
  try {
    mkdirSync(join(KIMI_HOME, 'credentials'), { recursive: true });
    const fd = openSync(join(KIMI_HOME, 'credentials', 'kimi-code.lock'), 'a');
    closeSync(fd);
  } catch {
    /* ignore */
  }
}
