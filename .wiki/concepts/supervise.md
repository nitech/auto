---
type: Concept
title: Supervise and autostart
description: Scheduled-task watchdog that restarts the host on crash or failed health checks.
tags: [supervise, autostart, watchdog]
status: stable
sources:
  - id: supervise
    resource: /scripts/supervise.mjs
    title: Supervisor
  - id: autostart
    resource: /scripts/install-autostart.ps1
    title: Scheduled task install
generated: { by: agent, at: 2026-08-17T10:40:00Z }
---

# Supervise and autostart

The `AutoSupervise` scheduled task runs `scripts/supervise.mjs`, which
keeps the [host](host.md) alive across crashes, hung health checks, and
machine reboots.

```powershell
npm run supervise          # foreground watchdog
npm run autostart:install  # Windows Scheduled Task at logon
Start-ScheduledTask -TaskName AutoSupervise
```

## What it does

- Runs the same first-run [checklist](access.md) as `npm run setup` (Node,
  CLI, **CLI login**, Tailscale, `.env`). Missing `agent login` is printed
  in red; the host still starts so the web app can be reached.
- Once the host answers health, prints in colour where Auto lives: the
  Tailscale `http://100.x:4331/` URL for a phone, and `127.0.0.1` for this
  PC. The same text is appended to `supervise.log` without colour.
- Spawns `src/server/index.mjs` and restarts it when the process exits.
- Polls `GET /api/health` on a timer (default ~15s). After enough consecutive
  failures it force-restarts the child.
- Writes `supervise.log` and `host.log` (the scheduled-task console is
  invisible; without these, poll errors vanish).

## What must not host Auto

Never run the host inside a **Cursor agent background shell**. Those get
killed with the agent and take Auto down. The scheduled task (or a plain
terminal outside the agent) is the durable path.

## Restart vs kill

`POST /api/restart` (Telegram `/restart`, web ♻) is the polite path from
inside Auto: answer first, wait for ACP work, exit, supervisor starts it
again. Killing the port listener from a plain shell is fine; killing it
from a session that is a child of the host kills that session mid-reply.

Skills, docs, and `.wiki/` need no restart. Anything under `src/` does.

## Related

- [Host](host.md)
- [Access](access.md)
- [Skills](skills.md) (`auto-restart`)
