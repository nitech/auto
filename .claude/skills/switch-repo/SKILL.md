---
name: switch-repo
description: Use when the user asks Auto to switch the active repo/project/folder ("switch to repo X", "work in the Y project from now on", "go back to the auto repo"). A cd or verbal confirmation is NOT enough — the switch only persists through the session API.
---

# Switch Auto's active repo (make it stick)

The active session's `folder` is where every Telegram message runs. Only the
session API changes it — `cd`-ing and reporting "now in repo X" silently
reverts on the next message.

## Do this

```powershell
# Point the active session at a folder. Reuses a session already on that
# folder, creates one if there isn't, and makes it active:
curl -s -X POST http://127.0.0.1:4331/api/session -H "Content-Type: application/json" -d '{\"folder\":\"C:\\path\\to\\repo\"}'
```

To reactivate an existing session without touching its folder, switch by id
(or by its title, which is easier to type):

```powershell
curl -s http://127.0.0.1:4331/api/session   # inspect sessions + activeId
curl -s -X POST http://127.0.0.1:4331/api/session/active -H "Content-Type: application/json" -d '{\"id\":\"auto\"}'
```

## Verify before confirming

1. The POST response should show the session with the right `folder`.
2. `curl -s http://127.0.0.1:4331/api/session` — confirm `activeId` matches.
3. Only then tell the user the switch is done. If the API call failed, say
   so — never confirm a switch that didn't persist.

## Notes

- Use the absolute path with double backslashes in the JSON body.
- The folder must exist: the API rejects a missing path with 400 rather
  than creating a session that points at nowhere.
- Each session keeps its own transcript and its own agent process, so
  switching back to a repo returns to that conversation where it left off.
