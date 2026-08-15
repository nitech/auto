---
type: Concept
title: Usage dial and account quotas
description: Session context fill beside the composer, plus Cursor Models / Other Models / included / on-demand from the dashboard API.
tags: [usage, billing, context, web]
status: stable
sources:
  - id: auth
    resource: /src/core/cursor-auth.mjs
    title: Cursor JWT from state.vscdb
  - id: usage
    resource: /src/core/cursor-usage.mjs
    title: DashboardService account usage
  - id: threads
    resource: /src/core/desktop-threads.mjs
    title: contextUsagePercent on composerData
  - id: web
    resource: /src/web/app.js
    title: Dial and usage sheet
generated: { by: agent, at: 2026-08-15T18:10:00Z }
---

# Usage dial and account quotas

A fillable dial sits left of the attach `+` on the composer. It shows how
full **this chat's** context window is. Tapping it opens a sheet with that
session detail plus account-wide quotas Cursor keeps on cursor.com but not
in the IDE chat chrome.

## This chat

From `composerData:<threadId>` in Cursor's `state.vscdb`:

- `contextUsagePercent` — dial fill (0–100)
- `modelConfig` window size (`context` parameter) and `maxMode`
- sparse `usageData.default.costInCents` when Cursor wrote a chat cost
- bubble `tokenCount` summed when present; otherwise a note that fill is
  not written yet

ACP-only sessions have no `composerData`; the dial still opens the account
sheet and says context fill is desktop-only.

## Account (Cursor Models / Other Models)

Same Connect RPC the settings page uses, with the JWT at
`ItemTable` key `cursorAuth/accessToken` (read-only; never written back):

| Dashboard label | Field |
| --- | --- |
| Cursor Models | `planUsage.autoPercentUsed` |
| Other Models | `planUsage.apiPercentUsed` |
| Included usage | `includedSpend / limit` |
| On-demand | `GetHardLimit.noUsageBasedAllowed` + spend-limit fields |
| Plan / reset | `GetPlanInfo` + billing cycle timestamps |
| By model | `GetAggregatedUsageEvents` |

Cached about a minute on the host. Web op: `usage.get` → `{ type: 'usage', session, account }`.

## Related

- [Web](web.md)
- [Desktop chats](desktop-chats.md)
