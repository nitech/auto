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
  - id: identity
    resource: /src/core/host-identity.mjs
    title: Hostname and nick
  - id: supervise
    resource: /scripts/supervise.mjs
    title: Supervisor
generated: { by: agent, at: 2026-08-20T16:50:00Z }
---

# Host

One process, one port. `src/server/index.mjs` on **4331** (0.0.0.0) owns
HTTP, the WebSocket, the session API, Telegram, the browser, and terminals.
`npm run dev` is a second instance on 4340 with Telegram off — see
[access](access.md).

How the process stays alive across crashes and reboots is
[supervise](supervise.md). Do not host Auto in a Cursor agent background
shell.

## Identity

The OS hostname rides on `hello` and `/api/health`. An optional nick in
`state/host.json` (Settings → Host, or `host.setNick`) replaces it on the
[web](web.md) rail and as the leading part of the browser tab title.
Clearing the nick falls back to the hostname. All clients see the same
label.

## HTTP

| Path | What |
| --- | --- |
| `GET /api/health` | `ok`, session counts, `activeId`, Telegram, `hostname` / `nick` / `label` |
| `GET /api/session` | Sessions plus `activeId` |
| `GET /api/projects` | Folders as Cursor sees them, plus Auto's |
| `GET /api/desktop-chats?folder=` | That folder's desktop chats |
| `POST /api/session` | Point the active session at a folder (creates if needed) |
| `POST /api/session/active` | Switch by id, title, or folder |
| `POST /api/restart` | Answer first, wait for ACP work, then exit |

Everything else is the static web app. `index.html` is `no-store` and
every css/js URL in it is stamped `?v=<size>-<mtime>` so an iOS Home
Screen app downloads a changed stylesheet instead of keeping the first
one it saw. Other assets revalidate with an ETag.

## WebSocket

Clients send `{ op, … }`. The host replies with JSON of a stable shape
(deflate above 2 KB — a phone replay depends on it). Hello includes
sessions, recent desktop chats, approval policies, and host identity.
The handshake URL may carry `session` and `fromSeq`; a named live
session is attached even with no `fromSeq` (a refresh). An archived or
unknown id falls through to the active session. Attach then replays the
transcript from `fromSeq`.

Ops include `prompt`, `cancel`, `queue.*`, `permission`, `question.answer`,
`plan.build`, `session.create` / `archive` / `rename` / `mode` / `model` /
`policy`, `desktop.continue`, `terminal.*`, `browser.*`, `host.setNick`,
`host.restart`.

## Restart

`POST /api/restart` (Telegram `/restart`, web ♻) answers immediately, waits
for **ACP** turns to finish (not desktop — those belong to Cursor), writes
`state/restarting.json`, and exits. The supervisor starts it again. Killing
the port from inside Auto kills the session that asked.

Desktop chats keep running across a host restart; ACP children do not, but
their transcripts do, and they resume on next use.

The host re-asserts the [desktop-bridge](desktop-bridge.md) switches about
once a minute.

## Related

- [Sessions](sessions.md)
- [Supervise](supervise.md)
- [Access](access.md)
- [Skills](skills.md) (auto-restart)
