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
generated: { by: agent, at: 2026-08-15T09:36:00Z }
---

# Transcripts

Every prompt, tool call, result, diff, permission, plan, question, and error
is appended to `state/transcripts/<id>.jsonl` with a monotonic `seq` per
session. Clients replay from a sequence number. They hold no authoritative
state.

Unknown ACP update kinds are stored as `acp:<kind>` rather than dropped. A
record we cannot render yet beats one we threw away.

Browser frames are the sole deliberate exception: a video stream is not
worth replaying. See [Browser](browser.md).

## Record kinds

`session_start`, `user_message`, `agent_delta`, `agent_thought`, `tool_call`,
`tool_update`, `diff`, `terminal_chunk`, `permission_request`,
`permission_resolved`, `question`, `question_answered`, `plan`,
`session_info`, `commands`, `turn_start`, `turn_end`, `error`, `notice`.

Renderers ignore kinds they do not know.

## Replay

The host sends the **end** of the log first (about 1200 records), not the
whole file. A chat that has run for days is tens of megabytes; sending it as
one WebSocket message locked the tab. Older records stay on disk and can be
asked for by sequence number. A reconnect that claims a `fromSeq` ahead of
the log is started over — that transcript was reset behind it.

## Streaming assistant text

On a desktop chat, Cursor writes a reply into its bubble as it is spoken, so
what is in the database mid-turn is a prefix. Prose is unfinished business
while the chat is generating: re-read as it grows, announce again only when
it changed, and put only the new tail into the transcript (clients append).
A bubble Cursor rewrites rather than extends goes out whole.

## Related

- [Sessions](sessions.md)
- [Web](web.md)
- [ACP](acp.md)
