---
name: switch-repo
description: Use when the user asks Auto to switch the active repo/project/folder ("switch to repo X", "work in the Y project from now on", "go back to the auto repo"). A cd or verbal confirmation is NOT enough — the switch only persists through debug-server's session API.
---

# Switch Auto's active repo (make it stick)

The active session's `folder` (persisted in `session-state.json` by
debug-server) becomes `job.folder` for every future message. Only the
session API changes it — `cd`-ing and reporting "now in repo X" silently
reverts on the next message.

## Do this

```powershell
# Point the active session at a folder (creates the session if new, makes it active):
curl -s -X POST http://127.0.0.1:4331/api/session -H "Content-Type: application/json" -d '{\"folder\":\"D:\\Sevenfold\\auto\"}'
```

Or, if a named session for that repo already exists and you only want to
reactivate it without touching its folder:

```powershell
curl -s http://127.0.0.1:4331/api/session    # inspect sessions + activeId
curl -s -X POST http://127.0.0.1:4331/api/session/active -H "Content-Type: application/json" -d '{\"id\":\"auto\"}'
```

## Verify before confirming

1. The POST response should show the session with the right `folder`.
2. `curl -s http://127.0.0.1:4331/api/session` — confirm `activeId` matches.
3. Only then tell the user the switch is done. If the API call failed,
   say so — never confirm a switch that didn't persist.

## Notes

- Use the absolute path with double backslashes in the JSON body.
- Named sessions (`auto`, `setto-agent`, …) already exist for repos used
  regularly — prefer reactivating by `id` when one matches.
- The folder must exist; a typo'd path creates a session pointing at
  nowhere and every subsequent worker fails with "working directory does
  not exist".
