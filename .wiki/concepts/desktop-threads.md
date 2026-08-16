---
type: Concept
title: Desktop threads
description: Reading Cursor's own chat back from state.vscdb — bubbles, streaming tails, restart catch-up.
tags: [desktop, threads, vscdb, mirroring]
status: stable
sources:
  - id: threads
    resource: /src/core/desktop-threads.mjs
    title: Following a thread
  - id: chats
    resource: /src/core/desktop-chats.mjs
    title: Listing desktop chats
  - id: sessions
    resource: /src/core/sessions.mjs
    title: Catch-up after restart
  - id: tools
    resource: /src/web/desktop-tool-ui.js
    title: Tool lane vocabulary
generated: { by: agent, at: 2026-08-16T19:10:00Z }
---

# Desktop threads

Replies leave the IDE through Cursor's on-disk database, not through the
bridge. Auto polls `state.vscdb` and appends what it learns to the
[transcript](transcripts.md).

## Finding a thread

`composerHeaders` holds one row per chat. A folder's `workspaceId` is the
directory under `%APPDATA%\Cursor\User\workspaceStorage` whose
`workspace.json` points at that folder. Rows with `isSubagent` or
`isArchived` are left out.

Messages are `cursorDiskKV` rows: `composerData:<threadId>` holds bubble
ids in order; `bubbleId:<threadId>:<bubbleId>` is one message. Type 1 is
you; type 2 is the agent (`text`, thinking, or `toolFormerData`).
`cursorDiskKV` values come back as bytes or as text — read `typeof(value)`.

Every tool bubble is recorded. Projections then follow Cursor's lanes —
see [tool lanes](tool-lanes.md).

## Turn in flight

A turn in flight is `chatGenerationUUID`, not stored `status` (which has
said `aborted` during a healthy turn). The generation id clears before the
last message lands — wait one more pass before calling a turn over.

## Streaming answers

Cursor writes a reply into its bubble as it is spoken, so mid-turn the
database holds a prefix. Auto publishes only the **new tail** into the
transcript (clients append). A stale shorter re-read must be ignored —
treating it as a rewrite used to reset the high-water mark and stutter the
answer on the phone. A real rewrite (speculative decoding) replaces the
bubble instead of appending. Empty bubbles are created before they are
filled; leave them unread.

## Echo and harness noise

Your own message is written to the transcript when sent *and* stored as a
bubble. Auto shows it once — the web draws an idle send immediately and
swallows the host's later copy (and a stray Cursor echo); the host
`#expectEcho`s every path that will come back from the desktop, including
queued and outbox holds.

Cursor stores agent-harness notes (`system_notification` when a background
command finishes) as user bubbles. The IDE does not paint them; Auto must
not copy them onto the phone.

## Restart catch-up

A host restart in the middle of a turn must not treat Cursor's current
`visited` set as already in the transcript. Whatever landed while Auto was
down — the last tool results, the closing prose — is visited in the IDE and
missing here. An open `turn_start` with no `turn_end` is the signal; only
skip bubbles we actually wrote down.

## Model switch vs queue

Changing the model (or mode) while Cursor holds a queue can end a paused
turn — high demand is one case — and Cursor would then send the next
waiting message on its own. Auto takes the queue out first; if the turn is
still running afterwards the messages go back in, otherwise a notice lists
what was held so it is not fired as a new turn. See [queue](queue.md).

## Context dial

`composerData.contextUsagePercent` is how full this chat's context window
is. Absolute tokens are that percent of the model's context size (or an
assumed 200k for default). Chat cost is the sum of `usageData.*.costInCents`.
Auto shows these on the usage sheet; account quotas come from Cursor's
dashboard API. See [usage](usage.md).

## Related

- [Desktop chats](desktop-chats.md)
- [Desktop bridge](desktop-bridge.md)
- [Tool lanes](tool-lanes.md)
- [Transcripts](transcripts.md)
