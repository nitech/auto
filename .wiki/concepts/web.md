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
  - id: tools
    resource: /src/web/desktop-tool-ui.js
    title: Desktop tool lanes
generated: { by: agent, at: 2026-08-15T09:36:00Z }
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
- Diffs, thinking (folded when the block ends), permission and question
  cards, [terminals](terminals.md), [browser](browser.md).

## Composer

Enter sends. Images attach, paste, or drop and go with the next prompt.
Stop interrupts. The busy session still accepts another message — it
queues.

## Related

- [Host](host.md)
- [Telegram](telegram.md)
