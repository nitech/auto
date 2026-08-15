---
type: Concept
title: Web app
description: PWA that attaches to a session, replays the transcript, and holds no authoritative state.
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
generated: { by: agent, at: 2026-08-15T14:22:00Z }
---

# Web app

A projection of the host's [transcript](transcripts.md). It attaches over
the WebSocket, replays from a sequence number, and renders records as they
stream. A reload or a dropped connection costs nothing.

Open `http://<tailscale-ip>:4331/`. It is a PWA. Mode and model live beside
the composer, as in Cursor; approval policy lives in the top bar (and in
the sheet on a narrow screen).

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

Mode and model are chips under the text: a slight background and rounded
edges so a thumb can see where each picker starts. Their font is 16px
(iOS zooms the page into anything smaller and never zooms back out) and
`zoom: 0.75` draws them at 12px so they still look like quiet chips.

Mode is Agent, Plan, Debug, Multitask, or Ask — the same five Cursor
lists. The ring around the box, the send button, and the mode word all
take that mode's colour (blue, amber, red, purple, green), so a glance
says which one is in force. An ACP catalog that only names three does
not drop Debug or Multitask from the picker.

## Related

- [Host](host.md)
- [Telegram](telegram.md)
