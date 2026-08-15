---
type: Concept
title: Queue
description: A busy session takes another task — Cursor's queue in the window, Auto's queue in memory.
tags: [queue]
status: stable
sources:
  - id: sessions
    resource: /src/core/sessions.mjs
    title: Session manager (queue)
  - id: dom
    resource: /src/core/cursor-dom.mjs
    title: Cursor queue selectors
generated: { by: agent, at: 2026-08-15T09:36:00Z }
---

# Queue

Prompts sent mid-turn used to be refused with "Session is already working"
— fine at a keyboard, useless from a phone. They now queue: the message
sits until the turn ends, then goes into the transcript and the agent.
Stopping a turn drops what was queued behind it, because stopping means
stopping.

## Two queues, one face

| Kind | Who holds it | How Auto talks to it |
| --- | --- | --- |
| Desktop | Cursor, above the chat box | Read out of the window; press Cursor's own buttons |
| ACP | Auto, in memory | Edited in place |

Auto's queue does not survive a restart. A queued prompt is worth a minute
of patience, not a reboot. Send-now makes a message *next*, rather than
interrupting the turn already running — one agent, one turn.

## Finding a row

A row is found by its words, never its position: a turn can end between a
phone drawing the list and a thumb landing, and deleting whatever moved
into second place would delete the wrong message. Cursor's three actions
(reword, send now, delete) carry no words; they are found by `codicon`
name. Rewording Cursor's queue takes the message out and sends the new
words — its edit button opens an editor inside the IDE — so with several
waiting, the reworded one moves to the back.

## When the list is read

Reading Cursor's queue needs the chat on screen. An explicit ask brings the
tab forward. The poll that runs through a turn does not: seizing someone's
window every two seconds to look at a list is worse than not showing it.

## Related

- [Sessions](sessions.md)
- [Cursor window](cursor-window.md)
- [Web](web.md)
