---
type: Concept
title: Projects
description: The machine's folders as Cursor itself sees them — open windows, then everything it remembers.
tags: [projects, workspaces]
status: stable
sources:
  - id: projects
    resource: /src/core/projects.mjs
    title: Project list
  - id: chats
    resource: /src/core/desktop-chats.mjs
    title: Chats per workspace
generated: { by: agent, at: 2026-08-15T09:36:00Z }
---

# Projects

Auto does not invent "your projects". It is a remote control, so the list
is the desktop's list: folders open in a Cursor window right now, then
every workspace Cursor remembers. Folders Auto already has a session in
stay on the rail even if the IDE forgot them.

Read from `%APPDATA%\Cursor\User` — `globalStorage/storage.json` for open
windows (including multi-root `.code-workspace` files) and
`workspaceStorage` for history. Cheap enough to re-read whenever someone
asks. Nothing here talks to the agent.

A project's desktop chats are keyed by that folder's `workspaceId`. See
[desktop chats](desktop-chats.md).

Switching Auto's active folder is the [session](sessions.md) API, not a
`cd`. The `switch-repo` skill is the procedure.

## Related

- [Sessions](sessions.md)
- [Web](web.md)
- [Telegram](telegram.md)
