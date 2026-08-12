# Auto — agent instructions

> This is Auto's real instruction doc. `CLAUDE.md` in this repo is only a
> stub that imports this file — the harness auto-loads that fixed filename,
> but the content lives in `AGENTS.md`, the cross-tool convention for agent
> instructions.

Auto is Simon's always-on remote control for Cursor's agent: one host
(`src/server/index.mjs`) serving a web app and a Telegram bot, driving
`cursor-agent` sessions over ACP. Any session working in this repo — one of
Auto's own sessions or a manual one — follows the rules below.

## Reporting back

Finish every piece of work with a short bullet list of what changed — not
prose. Simon reads these on a phone, often from Telegram. Lead with the
outcome, one bullet per thing that actually changed, and say plainly what you
did not do. Long explanations belong in the commit message or the wiki.

## Agent independence

Auto's docs and wiki describe behaviour, not models. The agent behind a
session is whatever the Cursor CLI is configured to use, and it can change.
Never write a model name into these docs when describing what the agent *is*
or *does* — say "the agent". Naming the CLI (`cursor-agent`) or a config
value as setup documentation is fine.

## Architecture in one pass

- **One host, one port.** `src/server/index.mjs` on 4331 owns everything:
  HTTP, WebSocket, the session API, Telegram, the browser, terminals.
- **One session, one agent process.** Each session spawns `cursor-agent acp`
  and holds an ACP session id, so sessions resume rather than restart.
- **The transcript is the truth.** Every prompt, tool call, result, diff,
  permission and error is appended to `state/transcripts/<id>.jsonl` with a
  monotonic sequence number. Clients replay from a sequence number; they
  hold no authoritative state. If you add a new kind of event, record it —
  a record we cannot render yet beats one we threw away.
- **Two ways into the IDE.** A desktop chat is driven by typing into Cursor's
  own window over its debugging port, and only failing that through the desktop
  bridge, then a persistent outbox. Typing answers to no feature switch; the
  bridge can shut itself mid-session. So Cursor wants starting with
  `--remote-debugging-port=9222` — `node scripts/desktop-bridge.mjs status`
  says whether it was.
- **The window can be pressed, not just typed into.** Over the same port Auto
  stops a turn, brings a chat in a background tab to the front, and presses a
  control by the words on it. Every one of those first proves the window is
  showing the chat it was asked about, so acting on the wrong conversation is
  not possible; `force` exists only for putting a window back where it was.
  Controls are found by what they say, never by class name — Cursor's are
  generated — and what a conversation says is excluded, or a message beginning
  "Run this…" reads as a Run button. It did once.
- **Cursor's own approvals go to the phone.** While a desktop turn runs, Auto
  watches the window for controls whose words mean it is waiting for a person,
  parks them in the same broker as an agent's own permission requests, and
  presses whichever option comes back — withdrawing the question if it gets
  answered in the IDE first. Never proven in the wild: with Cursor set to run
  everything automatically it never asks, so the vocabulary in `cursor-dom.mjs`
  has not met a real prompt. Treat the first sighting as a chance to learn the
  words Cursor actually uses.
- **Whether a turn is running comes from the database.** The window is a poor
  witness: the word "Stop" belongs to the bar offering to review file changes,
  so a chat that edited nothing looks idle while it works. Stopping is confirmed
  by both. Stopping also hands the message back into the chat box, which Auto
  clears and reports — left there it blocks the next message from a phone.
- **Live-only by exception.** Browser frames are the sole thing deliberately
  never recorded; a video stream is not worth replaying.
- **The web and Telegram are projections.** Neither owns state. Anything one
  can do, the other should be able to do.

## Mandatory workflow for changes to this repo

1. **Run tests**: `npm test`. It syntax-checks everything, exercises
   transcripts, permissions, PTYs, diff rendering, the browser address bar
   and Telegram rendering, validates skill frontmatter, and — if the host is
   running — checks its health and session API.
2. **If tests pass**: `git add -A`, commit with a short message describing
   the change, and **push**. Then restart the host so the change takes
   effect (see below).
3. **If tests fail**: revert (`git checkout -- <files>`), tell the user
   which check failed and why, then fix the root cause and start again.

Do not skip the commit — uncommitted fixes are invisible to anyone
restarting later, which has silently lost fixes before. Do not skip the
push either; an unpushed commit exists only on this machine.

**Testing a send goes to a scratch chat, not this one.** A message delivered
into the session you are working in becomes a prompt: it interrupts the turn
mid-thought, and every copy costs another one. Proving delivery cost five
turns of "no reply needed" once. Attach a throwaway desktop chat and send
there, or check the transcript records rather than sending at all.

## Restarting

The `AutoSupervise` scheduled task runs `scripts/supervise.mjs`, which keeps
the host alive. To apply a change to `src/`, ask the host to restart itself:

```powershell
curl -s -X POST http://127.0.0.1:4331/api/restart -H "Content-Type: application/json" -d '{\"reason\":\"applied a change\"}'
```

It answers immediately, waits for any running turn to finish, then exits and
the supervisor starts it again. **Use this, not a kill**, when you are
running inside Auto: your session is a child of the host, so killing the
port kills you mid-reply. Telegram has `/restart` and the web has ♻ for the
same thing. Killing the port listener is still fine from a plain shell.

Restarting does not lose a session: transcripts are on disk and the agent
resumes from its ACP session id. Skills and docs need no restart at all.
See the `auto-restart` skill for the full picture.

**Never run a second host with Telegram enabled** — a bot token allows one
poller, and two will split messages between them at random. Use
`npm run dev` (port 4340, Telegram off).

**Never host Auto in a Cursor agent background shell** — they get killed.

## Current repo / active folder

There is one active session, and its `folder` is where Telegram messages
run. Switching repos only sticks if you call the session API — `cd`-ing and
saying "now in repo X" reverts on the next message:

```powershell
curl -s -X POST http://127.0.0.1:4331/api/session -H "Content-Type: application/json" -d '{\"folder\":\"D:\\Sevenfold\\auto\"}'
```

The `switch-repo` skill covers this, including reactivating an existing
session by id or title.

## Auto's own skills

Skills live in `.claude/skills/<name>/SKILL.md` and load in every session in
this repo. To create or update one, follow the `create-skill` skill. Skills
go through the same workflow as any change: `npm test` (it validates
frontmatter), commit, **push**. No restart needed.
