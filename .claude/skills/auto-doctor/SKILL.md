---
name: auto-doctor
description: Use when checking whether Auto is healthy, diagnosing why messages aren't getting replies, when a session seems stuck, or the user asks "is Auto up", "why didn't you answer", "what's Auto doing", "check the logs". Runs the health endpoint, inspects sessions, transcripts and supervisor logs.
---

# Auto doctor — health & diagnosis

Run these in order; stop when you have found the problem.

## 1. Is it up?

```powershell
curl -s http://127.0.0.1:4331/api/health
```

Expect `{"ok":true,"sessions":N,"live":N,"activeId":"…","telegram":true}`.

- No response → the host is down; use the `auto-restart` skill.
- `"telegram":false` → the web UI works but Telegram does not. Credentials
  are missing, or a second host stole the poller.

## 2. Sessions & active folder

```powershell
curl -s http://127.0.0.1:4331/api/session
```

Returns sessions plus `activeId`. The active session's `folder` is where
Telegram messages run. A wrong folder is why Auto looks like it is "in the
wrong repo" — fix it with the `switch-repo` skill.

`live` in the health output counts sessions with a running agent process;
`sessions` counts all of them. A session with `status: "error"` hit a fatal
agent exit and will restart on the next prompt.

## 3. Recent activity

- `state/transcripts/<sessionId>.jsonl` — the complete record of a session:
  every prompt, tool call, tool result, diff, permission and error, in
  order. Tail it to see exactly what happened; this is the primary source.
- `state/sessions.json` — session registry and which one is active.
- `supervise.log` — host crashes, restarts, health failures.

## 4. Common failure signatures

- Records with `"kind":"error"` and `"retryable":true` → an upstream blip
  from the model provider, not a bug here. The turn can be retried.
- `Agent process exited` in a transcript → the `cursor-agent` child died;
  usually authentication. Check `agent status` on the command line.
- Telegram silent but health ok → look for `poll error` lines in the
  supervisor log; a 409 means two pollers are fighting over the bot token.
- A turn that never ends → check for a pending permission request; on
  Telegram the approval buttons may be further up the chat.

Report findings plainly: what is up, what is down, the single most likely
cause, and what you did or recommend.
