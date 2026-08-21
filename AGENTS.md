# Auto — agent instructions

> This is Auto's real instruction doc. `CLAUDE.md` in this repo is only a
> stub that imports this file — the harness auto-loads that fixed filename,
> but the content lives in `AGENTS.md`, the cross-tool convention for agent
> instructions.

Auto is an always-on remote control for Cursor's agent: one host
(`src/server/index.mjs`) serving a web app and a Telegram bot, driving
`cursor-agent` sessions over ACP. Any session working in this repo — one of
Auto's own sessions or a manual one — follows the rules below.

These rules apply when this clone is the Auto host you are running. If you
are only browsing the code, you can ignore the commit-and-push loop.

## Reporting back

Finish every piece of work with a short bullet list of what changed — not
prose. The operator reads these on a phone, often from Telegram. Lead with the
outcome, one bullet per thing that actually changed, and say plainly what you
did not do. Long explanations belong in the commit message or the wiki.

## Wiki

Compiled knowledge lives in `.wiki/` (schema: `.wiki/AGENTS.md`). After any
non-trivial change to architecture, contracts, APIs, or agent-critical
behaviour, update the touched pages, `overview.md`, `index.md`, and `log.md`
in the same turn. Skip trivial/no-behaviour diffs. The old `wiki/` + `raw/`
layout is retired.

## Agent independence

Auto's docs and wiki describe behaviour, not models. The agent behind a
session is whatever the Cursor CLI is configured to use, and it can change.
Never write a model name into these docs when describing what the agent *is*
or *does* — say "the agent". Naming the CLI (`cursor-agent`) or a config
value as setup documentation is fine.

## Architecture in one pass

- **One host, one port.** `src/server/index.mjs` on 4331 owns everything:
  HTTP, WebSocket, the session API, Telegram, the browser, terminals.
- **New sessions start in the IDE.** Starting from the web or Telegram opens a
  new chat in a Cursor window that already has that folder. If no window has
  it, Auto opens one; if Cursor is not running, Auto starts it with
  `--remote-debugging-port=9222`. If Cursor is already running *without* that
  port, Auto quits it and starts it again — Electron will not add the port to a
  process that has already started, and that restart closes every Cursor
  window. If none of that works, it falls back to `cursor-agent acp` and says
  so in the transcript.
- **One session, one conversation.** A desktop session is Cursor's own chat.
  An ACP session holds its own `cursor-agent acp` process and resumes via
  `session/load`, so an idle one costs nothing but its history stays intact.
- **The transcript is the truth.** Every prompt, tool call, result, diff,
  permission and error is appended to `state/transcripts/<id>.jsonl` with a
  monotonic sequence number. Clients replay from a sequence number; they may
  cache the last stretch for a fast paint, but the host remains authoritative.
  If you add a new kind of event, record it —
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
- **A chat's model and mode can be set from the phone.** The pickers beside
  Cursor's chat box are the one part of the window that ignores a dispatched
  click — they open only on input the window believes came from a mouse — so
  they are pressed *where they are* over the debug port. The menus disagree with
  each other (models are a `role=menu`, modes are the @-mention popover) and an
  item is named by its own text, never its subtree, or "Opus 5" holding a "High"
  badge reads as "Opus 5 HighEdit". A variant is the row then the badge on it.
  When the chat is on Auto, that menu hides every named model behind a search
  box — Auto types the stem (`composer-2.5 Fast` → `composer 2.5`) into it,
  and only once the caret is actually there, or the query becomes a message.
  A badge can also bundle more than one word in one press — Grok's row offers
  "High Fast" together, not separately — so either word finds that same press.
  Nothing is believed from the click: Cursor's stored record keeps the model a
  chat was last *sent* with, so the word on the picker is the proof, and asking
  for what it is already on presses nothing.
- **A mirrored answer arrives in pieces.** Cursor writes a reply into its bubble
  as it is spoken, so what is in the database mid-turn is a prefix. Reading a
  bubble once and marking it seen published whatever was written at that instant
  and threw the rest away — a long answer reached the phone cut off mid-word.
  Prose is therefore unfinished business while the chat is generating, re-read as
  it grows, and announced again only when it changed; what goes into the
  transcript is the new tail, because clients append. A bubble Cursor rewrites
  rather than extends goes out whole.
- **A picture gets in by being pasted.** There is no protocol command for
  attaching a file, so an image from a phone goes onto the Windows clipboard and
  the window is told to run its own `paste` editing command — a real Ctrl+V,
  spelled out. Each image is confirmed by a pill appearing beside the chat box
  before the next one goes, whatever text was on the clipboard is put back, and
  the words are sent even if the picture would not attach — with a note saying
  what was left behind, because "what do you make of this?" arriving empty reads
  as an agent ignoring the question. The outbox holds words only: a held message
  says its images have to be sent again.
- **A busy session takes another task.** Prompts sent mid-turn used to be
 refused with "Session is already working" — fine at a keyboard, useless from a
phone. They now queue: the message sits in the queue until the turn ends, then
goes into the transcript and the agent. The queue is memory only, and stopping
 a turn drops what was queued behind it, because stopping means stopping.
- **What is waiting can be seen and changed.** The web shows the queue above the
 chat box the way the IDE does, with the same three actions per row: reword,
 send now, delete. For a desktop chat the queue belongs to *Cursor* — Auto typed
 the message in and the IDE is holding it — so it is read out of the window and
 pressed through Cursor's own buttons. A row is found by its words, never its
 position: a turn can end between a phone drawing the list and a thumb landing,
 and deleting whatever moved into second place would delete the wrong message.
 Those buttons carry no words at all, so they alone are found by `codicon` name —
 VS Code's icon vocabulary, not Cursor's generated classes. Rewording Cursor's
 queue takes the message out and sends the new words, because its edit button
 opens an editor inside the IDE; with several waiting, the reworded one moves to
 the back. Auto's own queue is edited in place, and send-now makes a message next
 rather than interrupting the turn already running — one agent, one turn.
 Reading Cursor's queue needs the chat on screen, so an explicit ask brings the
 tab forward; the poll that runs through a turn does not, since seizing someone's
 window every two seconds to look at a list is worse than not showing it.
- **Telegram says what is running; the web says what it printed.** Command
  output goes to the web transcript, which has room to scroll and rewrites in
  place. Telegram gets the command line and, for a failure, the exit code —
  quoting a build log there buries the reply it came with. A card folded up is
  still expected to show the last lines it printed and its exit code: output
  that needs a tap to find reads as a chat where nothing printed anything.
- **The file-review bar is not a question.** "Keep All" and "Undo All" sit there
  for as long as a chat has unreviewed edits, and offering them as approvals
  meant offering to throw work away by accident. They are excluded from the
  approval vocabulary and belong to a deliberate action instead.
- **Cursor's own approvals go to the phone.** While a desktop turn runs, Auto
  watches the window for controls whose words mean it is waiting for a person,
  parks them in the same broker as an agent's own permission requests, and
  presses whichever option comes back — withdrawing the question if it gets
  answered in the IDE first. Never proven in the wild: with Cursor set to run
  everything automatically it never asks, so the vocabulary in `cursor-dom.mjs`
  has not met a real prompt. Treat the first sighting as a chance to learn the
  words Cursor actually uses.
- **A question the agent asks can be answered from the phone.** The card
  carries the real options, not Skip and Continue. A tap — or a letter back
  on Telegram — presses that option in Cursor and Continue. Skip is still
  there. Answering in the IDE first still works: Auto notices and marks it
  answered.
- **A plan Cursor created can be read and built from the phone.** `create_plan`
  is a Created Plan card: title, overview, View Plan for the markdown, and
  Build with a model picker. Build presses Cursor's own button on that card,
  after choosing the model there if one was named. Telegram gets the same
  two actions.
- **Whether a turn is running comes from the database.** The window is a poor
  witness: the word "Stop" belongs to the bar offering to review file changes,
  so a chat that edited nothing looks idle while it works. Stopping is confirmed
  by both. Stopping also hands the message back into Cursor's chat box, which
  Auto clears (left there it would block the next message from a phone) and
  puts into Auto's own composer instead — web and Telegram get the words back
  so they can be edited and sent again.
- **A finished turn says so.** Cursor writes "Worked for 7m 3s" or "Thought for
  1s" above the answer; Auto does the same, and a turn still going says
  "Working…" at the bottom of the stream. A command left "running…" after the
  session went idle is a lie — the cards settle when the turn ends.
- **Live-only by exception.** Browser frames are the sole thing deliberately
  never recorded; a video stream is not worth replaying.
- **The web and Telegram are projections.** Neither owns state. Anything one
  can do, the other should be able to do.

## Mandatory workflow for changes to this repo

1. **Run tests** unless the change is markdown only (`README.md`, `docs/`,
   `AGENTS.md`, `CLAUDE.md`, `.wiki/`). `npm test` syntax-checks everything,
   exercises transcripts, permissions, PTYs, diff rendering, the browser
   address bar and Telegram rendering, validates skill frontmatter, and —
   if the host is running — checks its health and session API. Skill
   `SKILL.md` files still need tests (frontmatter).
2. **If tests pass** (or were skipped): `git add -A`, commit with a short
   message describing the change, and **push**. Then restart the host so
   the change takes effect (see below). Docs and wiki need no restart.
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
curl -s -X POST http://127.0.0.1:4331/api/session -H "Content-Type: application/json" -d '{\"folder\":\"C:\\path\\to\\repo\"}'
```

The `switch-repo` skill covers this, including reactivating an existing
session by id or title.

## Auto's own skills

Skills live in `.claude/skills/<name>/SKILL.md` and load in every session in
this repo. To create or update one, follow the `create-skill` skill. Skills
go through the same workflow as any change: `npm test` (it validates
frontmatter), commit, **push**. No restart needed.
