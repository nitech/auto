---
type: Concept
title: Host
description: One Node process on port 4331 owns HTTP, WebSocket, Telegram, browser, and terminals.
tags: [host, http, websocket, restart]
status: stable
sources:
  - id: server
    resource: /src/server/index.mjs
    title: Host
  - id: supervise
    resource: /scripts/supervise.mjs
    title: Supervisor
generated: { by: agent, at: 2026-08-15T09:36:00Z }
---

# Host

One process, one port. `src/server/index.mjs` on **4331** (0.0.0.0) owns
HTTP, the WebSocket, the session API, Telegram, the browser, and terminals.
`npm run dev` is a second instance on 4340 with Telegram off.

The `AutoSupervise` scheduled task runs `scripts/supervise.mjs`, which
restarts the host on crash and on failed health checks. Do not host Auto in
a Cursor agent background shell.

## HTTP

| Path | What |
| --- | --- |
| `GET /api/health` | `ok`, session counts, `activeId`, whether Telegram is polling |
| `GET /api/session` | Sessions plus `activeId` |
| `GET /api/projects` | Folders as Cursor sees them, plus Auto's |
| `GET /api/desktop-chats?folder=` | That folder's desktop chats |
| `POST /api/session` | Point the active session at a folder (creates if needed) |
| `POST /api/session/active` | Switch by id, title, or folder |
| `POST /api/restart` | Answer first, wait for ACP work, then exit |

Everything else is the static web app.

## WebSocket

Clients send `{ op, … }`. The host replies with JSON of a stable shape
(deflate above 2 KB — a phone replay depends on it). Hello includes
sessions, recent desktop chats, and approval policies. Attach replays the
transcript from `fromSeq`.

Ops include `prompt`, `cancel`, `queue.*`, `permission`, `question.answer`,
`plan.build`, `session.create` / `archive` / `rename` / `mode` / `model` /
`policy`, `desktop.continue`, `terminal.*`, `browser.*`.

## Restart

`POST /api/restart` (Telegram `/restart`, web ♻) answers immediately, waits
for **ACP** turns to finish (not desktop — those belong to Cursor), writes
`state/restarting.json`, and exits. The supervisor starts it again. Killing
the port from inside Auto kills the session that asked.

Desktop chats keep running across a host restart; ACP children do not, but
their transcripts do, and they resume on next use.

The host re-asserts the desktop-bridge switches about once a minute. See
[desktop chats](desktop-chats.md).

## Related

- [Sessions](sessions.md)
- [Skills](skills.md) (auto-restart)
