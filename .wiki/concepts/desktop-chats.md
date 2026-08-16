---
type: Concept
title: Continuing Cursor desktop chats
description: The same Cursor IDE chat on the phone — window in, database out, bridge as fallback.
tags: [desktop, chats]
status: stable
sources:
  - id: chats
    resource: /src/core/desktop-chats.mjs
    title: Listing desktop chats
  - id: sessions
    resource: /src/core/sessions.mjs
    title: Session attach / catch-up
generated: { by: agent, at: 2026-08-16T06:35:00Z }
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
| Mechanism | [Window](cursor-window.md) over the debug port; failing that, [bridge](desktop-bridge.md); failing that, outbox | Polling `state.vscdb` — [threads](desktop-threads.md) |
| Code | `cursor-cdp.mjs`, `desktop-bridge.mjs`, `desktop-outbox.mjs` | `desktop-threads.mjs` |

## What the desktop keeps

The name, model, and mode are Cursor's. Stopping is the IDE's button.
Images are not carried on the bridge path (the window paste path is).
Sending needs a window that has the thread; otherwise `unknown-thread`.

`session/list` over ACP and `agent --resume <id>` do not see desktop chats.
Copying a conversation into an ACP session branched it; that path is gone.

How tools are drawn on the phone follows [tool lanes](tool-lanes.md).

## Related

- [Cursor window](cursor-window.md)
- [Desktop bridge](desktop-bridge.md)
- [Desktop threads](desktop-threads.md)
- [Queue](queue.md)
- [Approvals](approvals.md)
