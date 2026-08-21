---
type: Concept
title: Telegram
description: The bot is a projection of the host — same sessions, shorter rendering.
tags: [telegram, bot]
status: stable
sources:
  - id: telegram
    resource: /src/core/telegram.mjs
    title: Telegram bridge
generated: { by: agent, at: 2026-08-21T21:00:00Z }
---

# Telegram

A projection of the host, not a second brain. Credentials and the one-poller
rule live under [access](access.md).

## What Telegram shows vs the web

| | Telegram | Web |
| --- | --- | --- |
| Role | What is running | What it printed |
| Your prompts | Shown (from web or Cursor; not duplicated when typed here) | Full transcript |
| Command output | Command line; exit code on failure | Full stream in the transcript |
| Folded card | Still shows last lines + exit code | Same expectation |
| Turn clock | Edited message ends with Worked/Thought for | Working… then the same label |
| Approvals / questions / plans | Inline buttons | Cards |
| File review (Keep / Undo / Redo) | Inline buttons (+/− headline) | Transcript card + scrub landmark |
| URLs | Tappable `<a>` | Links in markdown and bare http(s) |

Quoting a full build log in Telegram buries the reply it came with — that
is why command bodies stay on the web. Tool grouping follows
[tool lanes](tool-lanes.md).

A turn unfolds in one edited message. A failed first send is retried so a
blip does not leave the phone with a blank turn. Photos are downloaded and
sent with the prompt (desktop: pasted into the window; ACP: image blocks).

Prompts typed on the web or in Cursor are posted into the Telegram chat so
the phone stays in the same conversation. Prompts typed in Telegram are
already there, so they are not pasted back.

## Commands

`/help`, `/sessions`, `/new [folder]`, `/stop`, `/mode`, `/projects`,
`/chats`, `/model`, `/policy`, `/status`, `/restart`, `/web`.

`/mode` and `/model` on a desktop chat press Cursor's own pickers. On ACP
they use the catalog from `session/new`. `/mode` accepts Agent, Plan,
Debug, Multitask, and Ask. `/chats` continues a desktop thread. `/stop`
puts the interrupted prompt back as a draft you can edit and send again.
`/restart` is `POST /api/restart`.

Plain text is a prompt to the active session. A lettered reply to a
question card is an answer, not a new prompt. See [approvals](approvals.md).

## Related

- [Host](host.md)
- [Access](access.md)
- [Sessions](sessions.md)
- [Queue](queue.md)
- [Web](web.md)
