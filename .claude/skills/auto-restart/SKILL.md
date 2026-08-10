---
name: auto-restart
description: Use when Auto's service needs restarting — after changing debug-server.mjs or lib.mjs, when the service is wedged/crashed, when Telegram or Auto Web stop responding, or the user asks to "restart Auto", "restart the service", or "reload Auto". Covers which process to kill and how to bring it back under the supervisor.
---

# Restart Auto safely

Process layout (Windows):

- Port **4331** — `scripts/debug-server.mjs` (top level; spawns main-agent).
- Port **4332** — `scripts/main-agent.mjs` (child of debug-server; auto-respawned by debug-server on crash).
- Workers are spawned per job by main-agent — changes to `worker-agent.mjs`
  need **no restart at all**; the next job picks them up.

## Which restart do you need?

| What changed / what's wrong | Action |
|---|---|
| `worker-agent.mjs`, skills, docs | Nothing — next job picks it up |
| `main-agent.mjs`, or main agent wedged | Kill port 4332 only (debug-server respawns it) |
| `debug-server.mjs`, `lib.mjs`, or full reset | Kill port 4331, start under supervisor |

## Commands

Kill only the main agent (safe default):

```powershell
Get-NetTCPConnection -LocalPort 4332 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

Full restart under the supervisor (restarts on crash + health fail):

```powershell
Get-NetTCPConnection -LocalPort 4331 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
npm run supervise
```

## Pitfalls

- **Self-termination**: if you are a worker doing the restart, main-agent is
  your parent. Killing port 4332 orphans you mid-job and your final status
  report falls back to the events log. Restart only as the LAST step, tell
  the user first, and never kill 4332 before your work is otherwise done.
- After a full restart, verify: `curl -s http://127.0.0.1:4331/api/health`
  and `curl -s http://127.0.0.1:4332/health` both return ok.
- Do not leave Auto hosted inside an agent background shell — those get
  killed and take Auto down. The supervisor (`npm run supervise`) is the
  supported way.
