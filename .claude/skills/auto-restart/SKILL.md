---
name: auto-restart
description: Use when Auto's service needs restarting — after changing anything under src/, when the service is wedged or crashed, when Telegram or the web UI stop responding, or the user asks to "restart Auto", "restart the service", or "reload Auto". Covers which process to stop and how to bring it back under the supervisor.
---

# Restart Auto safely

Auto is one process: `src/server/index.mjs` on port **4331**. It hosts the
web UI, the WebSocket, the Telegram poller, the browser and the terminals,
and it spawns one `cursor-agent acp` child per live session.

The supervisor (`scripts/supervise.mjs`) keeps it alive and restarts it on
crash or health failure. Normally it runs from the `AutoSupervise` logon
task, not from a shell.

## Which restart do you need?

| What changed / what's wrong | Action |
|---|---|
| Skills, docs, `.wiki/` | Nothing — picked up automatically |
| Anything under `src/` | Restart the host |
| Host wedged, or Telegram silent | Restart the host |
| Supervisor itself misbehaving | Restart the scheduled task |

## Commands

Ask the host to restart itself — the safe default, and the only correct one
if you are a session running inside Auto:

```powershell
curl -s -X POST http://127.0.0.1:4331/api/restart -H "Content-Type: application/json" -d '{\"reason\":\"applied a change\"}'
```

It replies at once, waits for any running turn to finish, then exits so the
supervisor can start it again. Telegram's `/restart` and the web's ♻ button
do the same. When it comes back it says so on Telegram.

From a plain shell you can also just kill the listener:

```powershell
Get-NetTCPConnection -LocalPort 4331 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

Restart everything, supervisor included:

```powershell
Stop-ScheduledTask -TaskName AutoSupervise
Start-ScheduledTask -TaskName AutoSupervise
```

If the task is not installed: `npm run autostart:install`, or run
`npm run supervise` in a terminal that will outlive your session.

## Verify

```powershell
curl -s http://127.0.0.1:4331/api/health
```

Expect `{"ok":true,...,"telegram":true}`. `telegram:false` means the poller
did not start — usually missing credentials.

## Pitfalls

- **Do not kill the port from inside Auto.** Each session runs in a child of
  the host, so killing the listener kills the session that asked — the work
  is fine, but the reply never arrives. Use `/api/restart`.
- **One Telegram poller only.** A bot token allows a single `getUpdates`
  caller. Never run a second host with Telegram enabled; use
  `npm run dev` (port 4340, `--no-telegram`) for a parallel instance.
- **Do not host Auto inside an agent background shell** — those get killed
  and take Auto down with them. Use the scheduled task.
- Restarting drops live agent sessions' processes, but not their history:
  transcripts are on disk and sessions resume on next use.
