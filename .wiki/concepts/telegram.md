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
generated: { by: agent, at: 2026-08-15T11:50:00Z }
---

# Telegram

A projection of the host, not a second brain. Credentials come from
`TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` or the `auth.json` the
telegram-notify skill writes. A bot token allows **one** poller; two hosts
split messages at random.

Telegram says what is running; the [web](web.md) says what it printed.
Command output goes to the web transcript. Telegram gets the command line
and, for a failure, the exit code. A card folded up is still expected to
show the last lines it printed and its exit code.

A turn unfolds in one edited message. When it finishes, the same message
ends with how long it took — *Worked for 7m 3s* or *Thought for 1s* — so a
phone is not left staring at a command that still says it is running.
Approvals, question options, and Created Plan actions are buttons. Photos
are downloaded and sent with the prompt (desktop: pasted into the window;
ACP: image blocks).

## Commands

`/help`, `/sessions`, `/new [folder]`, `/stop`, `/mode`, `/projects`,
`/chats`, `/model`, `/policy`, `/status`, `/restart`, `/web`.

`/mode` and `/model` on a desktop chat press Cursor's own pickers. On ACP
they use the catalog from `session/new`. `/chats` continues a desktop
thread. `/restart` is `POST /api/restart`.

Plain text is a prompt to the active session. A lettered reply to a
question card is an answer, not a new prompt. See [approvals](approvals.md).

## Related

- [Host](host.md)
- [Sessions](sessions.md)
- [Queue](queue.md)
