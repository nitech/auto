---
name: auto-doctor
description: Use when checking whether Auto is healthy, diagnosing why messages aren't getting replies, when a worker seems stuck or missing, or the user asks "is Auto up", "why didn't you answer", "what's Auto doing", "check the logs". Runs health endpoints, inspects sessions, logs, events, and recent worker runs.
---

# Auto doctor — health & diagnosis

Run these in order; stop when you've found the problem.

## 1. Is it up?

```powershell
curl -s http://127.0.0.1:4331/api/health   # debug-server
curl -s http://127.0.0.1:4332/health       # main-agent
```

Both should return ok. If 4331 is down, nothing works — restart via the
`auto-restart` skill. If only 4332 is down, debug-server should respawn it
within seconds; check again before intervening.

## 2. Sessions & active folder

```powershell
curl -s http://127.0.0.1:4331/api/session
```

Returns sessions + `activeId`. The active session's `folder` is where every
job runs. Wrong folder = user thinks Auto is "in the wrong repo".

## 3. Recent activity (newest last)

- `events.jsonl` — every message in/out, worker statuses, tool calls
  (`dir` field: `in` / `out` / `agent` / `sys`). Tail ~50 lines.
- `pending-queue.json` — jobs waiting for a worker slot. Non-empty for a
  long time = workers stuck or crashing.
- `runs/<workerId>.json` — one file per worker job with `code`, `text`,
  `stderr`. Sort by mtime; a recent run with `code != 0` shows why it failed.
- `main-agent.log` — main-agent's own log (claude spawns, auth refreshes,
  exits).
- `supervise.log`, `.debug-server.err.log` — supervisor/debug-server crashes.

## 4. Common failure signatures

- `401` / `API Key appears to be invalid` in logs → provider credentials
  expired; check `.env` (`AUTO_PROVIDER`, keys) and re-auth
  (`npm run kimi:login` for Kimi OAuth).
- Worker `started` in events.jsonl but no `done`/`error` → still running or
  died silently; check its `runs/<id>.json`.
- `provider changed ... new session` in main-agent.log → normal after
  provider/model switch, not an error.

Report findings plainly: what's up, what's down, the single most likely
cause, and what you did or recommend.
