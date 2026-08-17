---
type: Concept
title: Cursor window
description: Driving Cursor over its debug port — type, press, pick, paste — without acting on the wrong chat.
tags: [cdp, cursor, composer, pickers]
status: stable
sources:
  - id: cdp
    resource: /src/core/cursor-cdp.mjs
    title: Cursor CDP
  - id: dom
    resource: /src/core/cursor-dom.mjs
    title: Window vocabulary
  - id: launch
    resource: /src/core/cursor-launch.mjs
    title: Launch / quit Cursor
  - id: clipboard
    resource: /src/core/clipboard.mjs
    title: Image paste via clipboard
generated: { by: agent, at: 2026-08-17T07:20:00Z }
---

# The Cursor window

Launched with `--remote-debugging-port=9222`, Cursor exposes its windows as
pages. Auto puts the caret in the chat box, types, and presses Enter — the
crudest transport and the most dependable, because it is what a person at
the keyboard does. The desktop bridge can refuse for the rest of a window's
life; the debug port answers to no feature switch.

Reading history is still the database's job. The window only holds what it
has scrolled into view.

## Honesty

- **Never type into the wrong conversation.** A window is written to only
  after it has proved which chat it is showing (id in markup, or the
  messages on screen looked up in the desktop database).
- **Never leave a mess.** If the box will not send, the typed text is taken
  back out and the message goes to the [bridge](desktop-bridge.md) or its outbox.

`force` exists only for putting a window back where it was.

## Pressing, not just typing

The same port stops a turn, brings a background tab to the front, and
presses a control **by the words on it**. Cursor's class names are
generated. What a conversation says is excluded, or a message beginning
"Run this…" reads as a Run button.

Queue icon buttons carry no words — those alone are found by `codicon`
name (VS Code's icon vocabulary).

A question is answered on Cursor's questionnaire toolbar above the chat
box — a sibling of the `ask_question` bubble, not inside it. Each option
is a lettered row ("A" in one element, "Red" in the next, often glued as
"ARed"). Auto matches the label, including that glued letter, and presses
the row then Continue with a real mouse. Continue stays disabled until a
row is chosen, so it is found even while disabled. Skip is on that
toolbar, not an approval. `spike/question-card.mjs` dumps a real card
when a press misses.

When Cursor's UI moves, `src/core/cursor-dom.mjs` is the only file that
should need to change. `spike/cdp-probe.mjs --discover` is how to find the
new selectors.

## Model and mode from the phone

The pickers beside the chat box ignore a dispatched click; they open only
on input the window believes came from a mouse, so they are pressed *where
they are*. Models are a `role=menu`; modes are the @-mention popover. An
item is named by its own text, never its subtree — or "Opus 5" holding a
"High" badge reads as "Opus 5 HighEdit". A variant is the row then the
badge on it.

The phone picker sends agent ids (`kimi-k3[reasoning=max]`), not menu
words. The catalog often names that row `kimi-k3` too. Hyphens are spaces
(`kimi-k3` is "Kimi K3"), a slug can omit a prefix the menu adds
(`grok-4.6` is "Cursor Grok 4.6"), and `reasoning=max` / `fast=true` are
the Max and Fast badges. `effort=high` is not — High sits on several rows.

Nothing is believed from the click: Cursor's stored record keeps the model
a chat was last *sent* with, so the word on the picker is the proof, and
asking for what it is already on presses nothing.

## Pictures

There is no protocol command for attaching a file. An image from a phone
goes onto the Windows clipboard and the window is told to run its own
`paste` editing command. Each image is confirmed by a pill beside the chat
box before the next one goes. Whatever text was on the clipboard is put
back. An existing image on the clipboard cannot be restored. Words are sent
even if the picture would not attach, with a note saying what was left
behind. The outbox holds words only.

## Launching Cursor

A running instance that already has the debug port takes `--new-window`.
Starting from nothing adds the port so the window is born reachable. Cursor
already running *without* the port cannot have it added — Electron hands
the folder over and exits — so Auto quits Cursor and starts it again. That
closes every window. It is the only way a new session can appear in the IDE.

## Related

- [Desktop chats](desktop-chats.md)
- [Desktop bridge](desktop-bridge.md)
- [Queue](queue.md)
- [Approvals](approvals.md)
