# Auto — agent instructions

Auto is Simon's own always-on Telegram/Auto-Web bridge (`scripts/main-agent.mjs`
+ `scripts/worker-agent.mjs`, fronted by `scripts/debug-server.mjs`). Any
Claude Code session working in this repo — main agent, worker, or a manual
session — follows the rule below when it edits files in this repo.

## Mandatory workflow for changes to this repo

Whenever you change any file in this repo (not just docs):

1. **Run tests**: `npm test`. This syntax-checks every script under
   `scripts/`, sanity-checks `lib.mjs`'s exports, and — if the service is
   already running — hits its `/health` / `/api/health` endpoints.
2. **If tests pass**: `git add -A` the relevant files and commit with a
   short message describing the change, then restart the service (see
   below) so the fix actually takes effect.
3. **If tests fail**: revert your change (`git checkout -- <files>` or
   `git stash` for uncommitted work), then tell the user which check
   failed and why. Do not leave the repo in a broken, uncommitted state.
   After reverting, investigate the root cause and fix the underlying
   issue, then repeat from step 1.

Do not skip the commit — uncommitted fixes are invisible to anyone
restarting the service later, which has caused fixes to silently not
apply before.

## Restarting the service

Prefer the supervisor (restarts on crash + health fail):

```powershell
npm run supervise
# or logon task: npm run autostart:install && Start-ScheduledTask -TaskName AutoSupervise
```

`npm start` (`scripts/debug-server.mjs`, port 4331) is the bare top-level
process; it spawns `scripts/main-agent.mjs` (port 4332) as a child and
auto-restarts that child on crash, but debug-server itself must be
restarted for changes to `debug-server.mjs` or `lib.mjs` to take effect.
Do not host Auto only inside a Cursor agent background shell — those get
killed and take Auto down.

To restart on Windows:

```powershell
# find and stop the current listener, then start it again under supervise
Get-NetTCPConnection -LocalPort 4331 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
npm run supervise
```

If only `main-agent.mjs` or `worker-agent.mjs` changed, killing the
process on port 4332 is enough — debug-server respawns it automatically.

## Current repo / active folder

There is one global "active session" (`debug-server.mjs`, persisted to
`session-state.json`) whose `folder` becomes the `job.folder` for every
Telegram/Auto-Web message: `main-agent.mjs` gets it as the `folder:` line
in each injected `USER_MESSAGE`, and `worker-agent.mjs` gets it as
`AUTO_CWD` (its spawned Claude's `cwd`) and as "Preferred working folder"
in its prompt. Named sessions (`auto`, `setto-agent`, …) already exist in
`session-state.json` for repos used regularly.

**Switching repos only sticks if you update that state.** `cd`-ing into a
repo and reporting back that you're "now in repo X" does *not* change
future jobs' folder — only a call to the debug-server's session API does:

```powershell
# Point the active session at a folder (creates the session if it doesn't
# exist yet, and makes it active) — this is what a "switch to repo X" /
# "switch to the Y project" request should actually do:
curl -s -X POST http://127.0.0.1:4331/api/session -H "Content-Type: application/json" -d '{\"folder\":\"D:\\Sevenfold\\auto\"}'

# If a session for that repo already exists and you just want to reactivate
# it without touching its folder, switch by id instead:
curl -s http://127.0.0.1:4331/api/session   # inspect sessions + activeId
curl -s -X POST http://127.0.0.1:4331/api/session/active -H "Content-Type: application/json" -d '{\"id\":\"auto\"}'
```

Both `main-agent.mjs` and `worker-agent.mjs` are told this in their
prompts. Whichever one handles a "switch repo/folder" request must make
this call (workers, which have Bash, are the ones normally doing this)
before confirming the switch to the user — a verbal confirmation without
the API call will silently revert on the next message.
