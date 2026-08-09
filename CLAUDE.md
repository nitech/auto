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

`npm start` (`scripts/debug-server.mjs`, port 4331) is the top-level
process; it spawns `scripts/main-agent.mjs` (port 4332) as a child and
auto-restarts that child on crash, but debug-server itself must be
restarted for changes to `debug-server.mjs` or `lib.mjs` to take effect.

To restart on Windows:

```powershell
# find and stop the current listener, then start it again
Get-NetTCPConnection -LocalPort 4331 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
npm start
```

If only `main-agent.mjs` or `worker-agent.mjs` changed, killing the
process on port 4332 is enough — debug-server respawns it automatically.
