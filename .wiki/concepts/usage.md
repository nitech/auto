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
generated: { by: agent, at: 2026-08-21T19:05:00Z }
---

# Usage dial and account quotas

A fillable dial sits left of the attach `+` on the composer. It shows how
full **this chat's** context window is. Tapping it opens a sheet with that
session detail plus account-wide quotas Cursor keeps on cursor.com but not
in the IDE chat chrome.

## This chat

From `composerData:<threadId>` in Cursor's `state.vscdb`:

- `contextUsagePercent` — dial fill (0–100)
- absolute tokens — percent × context window (`200k` → 200000). Named models
  store the window on `modelConfig.selectedModels[0].parameters`; default /
  Auto often does not, so Auto assumes **200k** (and marks it assumed) unless
  Max Mode is on
- **Model** — `modelConfig.modelName` (or `selectedModels[0].modelId`). This is
  the model the chat was last *sent* with, not a live read of the picker.
  Auto-select is stored as `default`; Cursor does **not** write the backend
  model it routed to into this field (or into bubble `modelInfo`, which is
  usually `default` too). A named id such as `grok-4.6` means that model was
  last sent — and the IDE picker usually says the same. The web dropdown can
  still read Auto-select on a desktop chat whose picker is a named model,
  because Auto only records `model` after a change made through Auto
- `usageData.*.costInCents` — summed across every model key Cursor wrote
  (not only `default`). Shown as estimated cost for this chat **only when
  Cursor wrote a figure**; otherwise the line is omitted (Cursor often leaves
  `usageData` empty)
- bubble `tokenCount`s summed when present; usually zero on recent builds

The IDE chat chrome does not show last-sent model separately from the picker.
The picker is what the *next* send will use; the database catches up after a
send. See [Cursor window](cursor-window.md).

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
| By model | `GetAggregatedUsageEvents` (`modelIntent`) |

`autoModelSelectedDisplayMessage` / `namedModelSelectedDisplayMessage` are
quota sentences ("You've used 10% of your included total usage"), not the
name of the model Auto-select picked.

**By model** is this billing cycle, account-wide — not this chat. `default` is
the Auto-select pool; named rows (`cursor-grok-4.6-high`, …) are those models
whether you picked them or Auto did. Cursor does not label which.

Cached about a minute on the host. Web op: `usage.get` → `{ type: 'usage', session, account }`.

## Related

- [Web](web.md)
- [Desktop chats](desktop-chats.md)
