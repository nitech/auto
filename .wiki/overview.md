---
type: Overview
title: Auto
description: Remote control for Cursor's agent — one host, a web app, and a Telegram bot.
tags: [auto, overview]
status: stable
sources:
  - id: agents
    resource: /AGENTS.md
    title: Agent instructions
  - id: readme
    resource: /README.md
    title: README
  - id: host
    resource: /src/server/index.mjs
    title: Host process
generated: { by: agent, at: 2026-08-21T08:40:00Z }
---

# Auto

Auto is an always-on remote control for Cursor's agent. One process
(`src/server/index.mjs` on port 4331) serves a web app and a Telegram bot,
and drives conversations that live either in the Cursor desktop app or in a
`cursor-agent acp` child.

The host owns state. The web and Telegram are projections: anything one can
do, the other should be able to do. The [transcript](concepts/transcripts.md)
is the truth; clients replay from a sequence number.

## Two kinds of session

- **Desktop** — a chat in Cursor's own window. Auto types into it (debug
  port first, then the [desktop bridge](concepts/desktop-bridge.md), then an
  outbox) and reads replies from the desktop database
  ([threads](concepts/desktop-threads.md)). See
  [desktop chats](concepts/desktop-chats.md) and
  [the Cursor window](concepts/cursor-window.md).
- **ACP** — a `cursor-agent acp` subprocess, resumable via `session/load`.
  Used when a desktop chat cannot be started. See [ACP](concepts/acp.md).

New sessions prefer the IDE. If no window has the folder, Auto opens one; if
Cursor is not running, it starts it with `--remote-debugging-port=9222`. If
Cursor is already running *without* that port, Auto quits it and starts it
again — that closes every window. Only then does it fall back to ACP.

## Surfaces

| Surface | Role |
| --- | --- |
| [Host](concepts/host.md) | HTTP, WebSocket, session API, restart |
| [Supervise](concepts/supervise.md) | Keep the host alive across crash and reboot |
| [Web](concepts/web.md) | PWA that caches and replays the transcript |
| [Telegram](concepts/telegram.md) | Prompt, watch, approve, switch, restart |
| [Browser](concepts/browser.md) | Real Chrome on this machine, live frames only |
| [Terminals](concepts/terminals.md) | PTYs for you and (when ACP uses them) the agent |

## Standing rules

- [Access](concepts/access.md) is Tailscale; Auto has no login of its own.
  First clone: [docs/install.md](../docs/install.md). `npm run supervise`
  runs the setup checklist and prints the Tailscale URL.
- One Telegram poller. A second host with the bot token splits messages.
  Develop with `npm run dev` (port 4340, Telegram off).
- Never host Auto in a Cursor agent background shell — those get killed.
  Use [supervise](concepts/supervise.md).
- Skills, docs, and this wiki need no host restart. Anything under `src/`
  does: `POST /api/restart`, Telegram `/restart`, or the web ♻.

## Related

- [Sessions](concepts/sessions.md)
- [Projects](concepts/projects.md)
- [Approvals, questions, plans](concepts/approvals.md)
- [Queue](concepts/queue.md)
- [Tool lanes](concepts/tool-lanes.md)
- [Skills and workflow](concepts/skills.md)
