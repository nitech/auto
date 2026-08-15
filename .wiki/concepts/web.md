---
type: Concept
title: Web app
description: PWA that attaches to a session, replays the transcript, and remembers which chat was open.
tags: [web, pwa]
status: stable
sources:
  - id: app
    resource: /src/web/app.js
    title: Web client
  - id: html
    resource: /src/web/index.html
    title: Shell
  - id: css
    resource: /src/web/style.css
    title: Chrome
  - id: tools
    resource: /src/web/desktop-tool-ui.js
    title: Desktop tool lanes
generated: { by: agent, at: 2026-08-15T17:50:00Z }
---

# Web app

A projection of the host's [transcript](transcripts.md). It attaches over
the WebSocket, replays from a sequence number, and renders records as they
stream. A reload or a dropped connection costs nothing.

The open chat is this tab's, not the host's active session. A refresh puts
`?session=` on the URL and the handshake asks for that id even when the page
has nothing to replay yet; opening Auto at `/` (the PWA start URL) reads the
same id from the browser. Telegram `/switch` does not steal the tab.

Open `http://<tailscale-ip>:4331/`. It is a PWA. Mode and model live beside
the composer, as in Cursor; approval policy lives in the top bar (and in
Settings on a narrow screen). Settings is a row at the bottom of the
session rail — a gear and the word Settings — and opens a full-screen
page.

On a phone the session rail is a drawer. × on a row archives that session
on the first tap (the row used to eat it, so it felt like it needed two).
Swipe the rail left to close it (the list is a scroller, so this is a
touch swipe, not a pointer drag), or tap × in the header, or tap beside it.

## What it draws

- The session rail, grouped by [project](projects.md), plus Cursor's recent
  chats so the rail can be the same list the IDE shows.
- The [queue](queue.md) above the chat box, with reword / send now / delete.
- Tool calls the way Cursor groups them: a quiet activity line for reads
  and searches, a file-change row for edits, cards for commands, questions,
  and Created Plan. The table lives in `desktop-tool-ui.js` so Telegram can
  share one copy.
- Diffs, thinking (folded when the block ends, timed from the record so a
  replay says "Thought for 8s" rather than staying "Thinking"), permission
  and question cards, [terminals](terminals.md), [browser](browser.md).
  A http(s) URL in the chat is a link — markdown `[text](url)` and a bare
  address both. User bubbles too.
- A turn still going says **Working…** at the bottom of the stream. When it
  ends, that line becomes **Worked for 7m 3s** or **Thought for 1s** above
  the answer, the way Cursor labels a finished turn. Commands left
  "running…" after the session goes idle settle to stopped — an idle chip
  with live cards is a lie.

## Composer

Enter sends. Images attach from a + on the lower-right of the box,
or paste, or drop, and go with the next prompt. Stop interrupts. The busy
session still accepts another message — it queues. `ask_question` is a
Question card with real options, not an OTHER tool bar.

Each session keeps its own unsent draft: switching chats parks what you
were typing and restores it when you come back. An idle send appears in
the stream at once — it used to wait until Cursor's window had taken it.

Mode and model are chips under the text: a slight background and rounded
edges so a thumb can see where each picker starts. Their font is 16px
(iOS zooms the page into anything smaller and never zooms back out) and
`zoom: 0.75` draws them at 12px so they still look like quiet chips.

Mode is Agent, Plan, Debug, Multitask, or Ask — the same five Cursor
lists. The ring around the box, the send button, and the mode word all
take that mode's colour (blue, amber, red, purple, green), so a glance
says which one is in force. An ACP catalog that only names three does
not drop Debug or Multitask from the picker. The model chip is keyed by
model id; after a desktop switch Auto keeps that id (and Cursor's label
as the name) so the control does not go blank.

## Related

- [Host](host.md)
- [Telegram](telegram.md)
