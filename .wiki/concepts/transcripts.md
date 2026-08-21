---
type: Concept
title: Transcripts
description: Append-only JSONL per session; sequence numbers are how clients resync.
tags: [transcript, jsonl, replay]
status: stable
sources:
  - id: transcript
    resource: /src/core/transcript.mjs
    title: Transcript store
  - id: map
    resource: /src/core/map-updates.mjs
    title: ACP update mapping
  - id: cache
    resource: /src/web/transcript-cache.js
    title: Client transcript cache
generated: { by: agent, at: 2026-08-21T08:50:00Z }
---

# Transcripts

Every prompt, tool call, result, diff, permission, plan, question, and error
is appended to `state/transcripts/<id>.jsonl` with a monotonic `seq` per
session. Clients replay from a sequence number. The host is the source of
truth; a client may keep a **cache** of the last stretch so a reload is not
a blank wait, but it is never authoritative — catch-up from `lastSeq` (or a
full replace when the host says so) wins.

Unknown ACP update kinds are stored as `acp:<kind>` rather than dropped. A
record we cannot render yet beats one we threw away.

Browser frames are the sole deliberate exception: a video stream is not
worth replaying. See [Browser](browser.md).

## Record kinds

`session_start`, `user_message`, `agent_delta`, `agent_thought`, `tool_call`,
`tool_update`, `diff`, `terminal_chunk`, `permission_request`,
`permission_resolved`, `question`, `question_answered`, `plan`,
`session_info`, `commands`, `turn_start`, `turn_end`, `error`, `notice`.

Renderers ignore kinds they do not know. `turn_end` carries `durationMs` when
the host saw the turn start, so a replay can still say "Worked for 7m 3s".

## ACP `session/update` → record

| Update kind | Transcript kind |
| --- | --- |
| `agent_message_chunk` | `agent_delta` |
| `agent_thought_chunk` | `agent_thought` |
| `user_message_chunk` | `user_message` (echoed) |
| `tool_call` | `tool_call` |
| `tool_call_update` | `tool_update` |
| `plan` | `plan` |
| `session_info_update` | `session_info` |
| `available_commands_update` | `commands` |
| `current_mode_update` | `session_info` (modeId) |
| anything else | `acp:<kind>` with raw payload |

Desktop mirroring writes the same record vocabulary from
[threads](desktop-threads.md), not through this mapper.

## Replay

The host sends the **end** of the log first (about 1200 records), not the
whole file. A chat that has run for days is tens of megabytes; sending it as
one WebSocket message locked the tab. Older records stay on disk and can be
asked for by sequence number. A reconnect that claims a `fromSeq` ahead of
the log is started over — that transcript was reset behind it.

The **opening prompt** (everything through the first real user message) is
always pinned above that tail. Between them the client shows how many records
were omitted. Without that pin, a long chat lost its first message — and the
scrubber landmark for it — because only the newest stretch travelled.

## Client cache

The [web app](web.md) keeps the same ~1200-record tail in memory (session
switches in this tab) and IndexedDB (hard reload). On boot or switch it
paints the cache immediately, then attaches with `fromSeq: lastSeq`. The
host either appends what is new or sets `replaced` / reports a gap — only
then does the client wipe and redraw. Live records update the cache as they
stream; disk writes are debounced and flushed on hide.

## Streaming assistant text

On a desktop chat, Cursor writes a reply into its bubble as it is spoken, so
what is in the database mid-turn is a prefix. Prose is unfinished business
while the chat is generating: re-read as it grows, announce again only when
it changed, and put only the new tail into the transcript (clients append).
A bubble Cursor rewrites rather than extends goes out whole. Details and
restart catch-up live on [desktop threads](desktop-threads.md).

## Related

- [Sessions](sessions.md)
- [Web](web.md)
- [ACP](acp.md)
- [Tool lanes](tool-lanes.md)
