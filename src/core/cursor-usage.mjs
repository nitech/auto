/**
 * Account-wide Cursor usage — the same numbers cursor.com/settings shows.
 *
 * Cursor does not expose these in the IDE chat chrome. The settings page
 * calls DashboardService over Connect RPC with the JWT from
 * `cursorAuth/accessToken`. Auto does the same, caches briefly, and never
 * stores the token itself.
 *
 * Labels match the dashboard:
 *   - Cursor Models  → autoPercentUsed (Composer / Grok / Auto pool)
 *   - Other Models   → apiPercentUsed (named models)
 *   - Included       → includedSpend / limit
 *   - On-demand      → hard-limit / spendLimitUsage
 */
import { cursorAccessToken, cursorRefreshToken, cursorAccount } from './cursor-auth.mjs';

const API = 'https://api2.cursor.sh';
const TTL_MS = 60_000;
const CLIENT_ID = 'KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB';

let cache = { at: 0, data: null };

const cents = (n) => (Number.isFinite(Number(n)) ? Number(n) / 100 : null);
const num = (n) => {
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
};
const ms = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

async function rpc(token, path, body = {}) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { ok: res.ok, status: res.status, json };
}

async function refreshAccessToken() {
  const refresh = cursorRefreshToken();
  if (!refresh) return null;
  const res = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: refresh,
    }),
  });
  if (!res.ok) return null;
  const json = await res.json().catch(() => null);
  if (!json?.access_token || json.shouldLogout) return null;
  return json.access_token;
}

function shape(period, plan, hard, agg, account) {
  const usage = period?.planUsage || {};
  const spend = period?.spendLimitUsage || {};
  const info = plan?.planInfo || {};
  const limit = num(usage.limit) ?? num(info.includedAmountCents);
  const included = num(usage.includedSpend);
  const includedPct =
    limit && included != null ? Math.min(100, (included / limit) * 100) : null;

  const models = (agg?.aggregations || [])
    .map((row) => ({
      model: row.modelIntent || 'unknown',
      inputTokens: num(row.inputTokens) || 0,
      outputTokens: num(row.outputTokens) || 0,
      cacheReadTokens: num(row.cacheReadTokens) || 0,
      cacheWriteTokens: num(row.cacheWriteTokens) || 0,
      costUsd: cents(row.totalCents) || 0,
      tier: row.tier ?? null,
    }))
    .sort((a, b) => b.costUsd - a.costUsd);

  const onDemandDisabled = Boolean(hard?.noUsageBasedAllowed);
  const onDemandLimit = cents(spend.individualLimit ?? spend.pooledLimit);
  const onDemandUsed = cents(spend.individualUsed ?? spend.pooledUsed);
  const onDemandRemaining = cents(spend.individualRemaining ?? spend.pooledRemaining);

  return {
    status: 'ok',
    account: {
      email: account.email || null,
      membership: account.membership || info.planName?.toLowerCase() || null,
    },
    plan: {
      name: info.planName || account.membership || null,
      price: info.price || null,
      includedUsd: cents(limit),
      cycleStart: ms(period?.billingCycleStart),
      cycleEnd: ms(period?.billingCycleEnd || info.billingCycleEnd),
    },
    /** Matches cursor.com "Cursor Models" / "Other Models". */
    buckets: {
      cursorModels: {
        label: 'Cursor Models',
        percent: num(usage.autoPercentUsed),
        note: 'Includes Cursor Grok and Composer',
        message: period?.autoModelSelectedDisplayMessage || null,
      },
      otherModels: {
        label: 'Other Models',
        percent: num(usage.apiPercentUsed),
        note: 'Named models outside the Cursor pool',
        message: period?.namedModelSelectedDisplayMessage || null,
      },
      included: {
        label: 'Included usage',
        percent: includedPct,
        usedUsd: cents(included),
        remainingUsd: cents(usage.remaining),
        limitUsd: cents(limit),
        message: period?.displayMessage || null,
      },
      total: {
        label: 'Combined',
        percent: num(usage.totalPercentUsed),
      },
    },
    onDemand: {
      enabled: !onDemandDisabled,
      disabled: onDemandDisabled,
      usedUsd: onDemandUsed,
      limitUsd: onDemandLimit,
      remainingUsd: onDemandRemaining,
      limitType: spend.limitType || null,
      note: onDemandDisabled
        ? 'On-demand spending is currently disabled'
        : 'Usage beyond the plan draws from on-demand spend',
    },
    models,
    totals: {
      inputTokens: num(agg?.totalInputTokens) || 0,
      outputTokens: num(agg?.totalOutputTokens) || 0,
      cacheReadTokens: num(agg?.totalCacheReadTokens) || 0,
      cacheWriteTokens: num(agg?.totalCacheWriteTokens) || 0,
      costUsd: cents(agg?.totalCostCents) || 0,
    },
    fetchedAt: Date.now(),
  };
}

/**
 * @param {{ force?: boolean }} [opts]
 */
export async function accountUsage({ force = false } = {}) {
  if (!force && cache.data && Date.now() - cache.at < TTL_MS) return cache.data;

  const account = cursorAccount();
  let token = cursorAccessToken();
  if (!token) {
    return {
      status: 'no-auth',
      reason: 'Cursor is not signed in on this machine, so account usage cannot be read.',
      account,
    };
  }

  let period = await rpc(token, '/aiserver.v1.DashboardService/GetCurrentPeriodUsage');
  if (period.status === 401 || period.status === 403) {
    const renewed = await refreshAccessToken();
    if (renewed) {
      token = renewed;
      period = await rpc(token, '/aiserver.v1.DashboardService/GetCurrentPeriodUsage');
    }
  }
  if (!period.ok) {
    return {
      status: 'error',
      reason:
        period.status === 401 || period.status === 403
          ? 'Cursor’s login has expired. Open Cursor and sign in again.'
          : `Cursor usage API returned ${period.status}.`,
      account,
    };
  }

  const [plan, hard, agg] = await Promise.all([
    rpc(token, '/aiserver.v1.DashboardService/GetPlanInfo'),
    rpc(token, '/aiserver.v1.DashboardService/GetHardLimit'),
    rpc(token, '/aiserver.v1.DashboardService/GetAggregatedUsageEvents'),
  ]);

  const data = shape(
    period.json,
    plan.ok ? plan.json : null,
    hard.ok ? hard.json : null,
    agg.ok ? agg.json : null,
    account,
  );
  cache = { at: Date.now(), data };
  return data;
}

/** Clear the cache — tests and forced refresh. */
export function clearAccountUsageCache() {
  cache = { at: 0, data: null };
}
