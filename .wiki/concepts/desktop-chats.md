---
type: Concept
title: Continuing Cursor desktop chats
description: The same Cursor IDE chat on the phone — bridge in, database out, debug port as the dependable path.
tags: [desktop, bridge, threads]
status: stable
sources:
  - id: chats
    resource: /src/core/desktop-chats.mjs
    title: Listing desktop chats
  - id: bridge
    resource: /src/core/desktop-bridge.mjs
    title: Desktop bridge send
  - id: gate
    resource: /src/core/desktop-bridge-gate.mjs
    title: Bridge feature gate
  - id: threads
    resource: /src/core/desktop-threads.mjs
    title: Following a thread
  - id: sessions
    resource: /src/core/sessions.mjs
    title: Catch-up after restart
  - id: outbox
    resource: /src/core/desktop-outbox.mjs
    title: Held messages
generated: { by: agent, at: 2026-08-15T17:30:00Z }
---

# Continuing Cursor desktop chats

Auto can pick up a chat started in the Cursor desktop app and carry it on
from the phone — the same chat, not a copy. Send from Telegram and the
message appears in the IDE's own thread; reply in the IDE and it appears on
the phone. This leans on Cursor's internals rather than any published
interface, and that can change under us.

## Starting a chat from Auto

A session started from the web or Telegram is a new chat in Cursor. Auto
presses **New Agent** in a window that already has that folder, waits for a
new thread id, and attaches. If no window has the folder, Auto asks Cursor
for `--new-window`. If Cursor is not running, it starts it with
`--remote-debugging-port=9222`. If Cursor is already running *without* that
port, Auto quits it and starts it again — that closes every window. If none
of that works, Auto falls back to [ACP](acp.md) and writes a notice.

## Into the IDE, and back out

| | Into the IDE | Back out |
| --- | --- | --- |
| Mechanism | [Window](cursor-window.md) over the debug port; failing that, bridge over a named pipe; failing that, [outbox](#outbox) | Polling `state.vscdb` |
| Code | `cursor-cdp.mjs`, `desktop-bridge.mjs`, `desktop-outbox.mjs` | `desktop-threads.mjs` |

The bridge hands a message to the same code that runs when you press enter
in the composer. It has no way to report what comes back.

## The bridge gate

The bridge is gated: a server-side feature flag (`desktop_bridge`) and a
Settings → Beta toggle must both be on. `npm run bridge:enable` (Cursor
closed) sets the local overrides. **It does not stay on by itself** —
Cursor refreshes server config and wipes the dev-override flag, often
within minutes, and only reads that flag at startup. The host re-asserts
the switches once a minute, writing only what was cleared, and only if the
Beta toggle is on. By hand: `node scripts/desktop-bridge.mjs ensure`.

## Finding a thread

`composerHeaders` holds one row per chat. A folder's `workspaceId` is the
directory under `%APPDATA%\Cursor\User\workspaceStorage` whose
`workspace.json` points at that folder. Rows with `isSubagent` or
`isArchived` are left out.

Messages are `cursorDiskKV` rows: `composerData:<threadId>` holds bubble
ids in order; `bubbleId:<threadId>:<bubbleId>` is one message. Type 1 is
you; type 2 is the agent (`text`, thinking, or `toolFormerData`).

Every tool bubble is recorded. Projections then follow Cursor's lanes:
reads and searches fold into a quiet activity line; edits sit on a
file-change row; a few internal tools stay off the stream — including
unnamed MCP placeholders (`mcp--`, `tool`, `MCP: tool`) that the IDE also
hides. `create_plan` stays a card. See [approvals](approvals.md).

## Things learned the hard way

- A turn in flight is `chatGenerationUUID`, not stored `status` (which has
  said `aborted` during a healthy turn).
- The generation id clears before the last message lands — wait one more
  pass before calling a turn over.
- Your own message is written to the transcript when sent *and* stored as a
  bubble. Auto shows it once — the web draws an idle send immediately and
  swallows the host's later copy (and a stray Cursor echo); the host
  `#expectEcho`s every path that will come back from the desktop, including
  queued and outbox holds.
- Cursor stores agent-harness notes (`system_notification` when a background
  command finishes) as user bubbles. The IDE does not paint them; Auto must
  not copy them onto the phone.
- A mirrored answer grows a bubble in Cursor's database. Auto publishes only
  the new tail. A stale shorter re-read must be ignored — treating it as a
  rewrite used to reset the high-water mark and stutter the answer on the
  phone (`BuildBuildBuildBuild passes passes…`). A real rewrite (speculative
  decoding) replaces the bubble instead of appending.
- Empty bubbles are created before they are filled; leave them unread.
- `cursorDiskKV` values come back as bytes or as text; read `typeof(value)`.
- A host restart in the middle of a turn must not treat Cursor's current
  `visited` set as already in the transcript. Whatever landed while Auto
  was down — the last tool results, the closing prose — is visited in the
  IDE and missing here. An open `turn_start` with no `turn_end` is the
  signal; only skip bubbles we actually wrote down.

## What the desktop keeps

The name, model, and mode are Cursor's. Stopping is the IDE's button.
Images are not carried on the bridge path (the window paste path is).
Sending needs a window that has the thread; otherwise `unknown-thread`.

`session/list` over ACP and `agent --resume <id>` do not see desktop chats.
Copying a conversation into an ACP session branched it; that path is gone.

## Outbox

When the window and the bridge both refuse, the text is parked in order and
retried until the desktop accepts it (`submitted` or `queued`). Dropping a
message typed on a phone is the worst possible answer.

## If it breaks

`npm run bridge` reports each switch and how many instances answer.

- Switches on, no instances: Cursor needs restarting.
- `dev override allowed: false`: the host should fix it within a minute.
- Instances but send fails: no window has that thread.
- Send works, nothing comes back: the reading half.

`npm test` covers discovery, send guards, switches, and reading against a
stand-in database — never the real Cursor.
