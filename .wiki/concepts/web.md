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
  - id: manifest
    resource: /src/web/manifest.webmanifest
    title: Web app manifest
  - id: icon
    resource: /src/web/icon.svg
    title: App icon
generated: { by: agent, at: 2026-08-17T18:05:00Z }
---

# Web app

A projection of the host's [transcript](transcripts.md). It attaches over
the WebSocket, replays from a sequence number, and renders records as they
stream. A reload or a dropped connection costs nothing.

The open chat is this tab's, not the host's active session. A refresh puts
`?session=` on the URL and the handshake asks for that id even when the page
has nothing to replay yet; opening Auto at `/` (the PWA start URL) reads the
same id from the browser. Telegram `/switch` does not steal the tab.

Open `http://<tailscale-ip>:4331/`. It is a PWA: `display: standalone`, an
SVG tab icon, and PNG icons (180 / 192 / 512) so a phone can put it on the
Home Screen. iOS needs `apple-mobile-web-app-capable` and
`apple-touch-icon.png` or Add to Home Screen still works but opens as a
Safari tab with a screenshot for an icon. Settings explains the path
(Share → Add to Home Screen on iPhone; the browser's own Install prompt
when Chrome offers one). Already running as the installed app hides that
block.

Installed on iOS, `black-translucent` draws under the status bar.
Standalone marks `data-standalone` before first paint. JS sizes `#app` to
the visual viewport and forces 8px under the composer — never
`env(safe-area-inset-bottom)`, which is ~80px on a Home Screen app even
with the keyboard up. The shell is `Cache-Control: no-store`; every
css/js URL in it is stamped `?v=<size>-<mtime>` on the way out, so a
change is a new URL and the installed app downloads it instead of
keeping the first stylesheet it ever saw.

Mode and model live beside the composer, as in Cursor; approval policy
lives in the top bar (and in Settings on a narrow screen). Settings is a
row at the bottom of the session rail — a gear and the word Settings —
and opens a full-screen page. The rail header shows this machine's name
under Auto (OS hostname, or a nick set in Settings → Host).

On a phone the session rail is a drawer. × on a row archives that session
on the first tap (the row used to eat it, so it felt like it needed two).
Swipe the rail left to close it (the list is a scroller, so this is a
touch swipe, not a pointer drag), or tap × in the header, or tap beside it.

New session is a bottom sheet. Soft keyboards shrink the visual viewport
without shrinking the layout one, so the sheet tracks `--vv-top` /
`--vv-height` from `visualViewport` and caps the project list to that
frame — otherwise a short filter result sat under the keys. The viewport
meta also asks for `interactive-widget=resizes-content` where supported.

## What it draws

- While a long transcript replays, the chat pane shows the Auto A mark
  (same glyph as the rail) and "Loading conversation…", not a blank.
- The session rail, grouped by [project](projects.md), plus Cursor's recent
  chats so the rail can be the same list the IDE shows.
- The [queue](queue.md) above the chat box, with reword / send now / delete.
- Tool calls the way Cursor groups them — see [tool lanes](tool-lanes.md).
- Diffs, thinking (folded when the block ends, timed from the record so a
  replay says "Thought for 8s" rather than staying "Thinking"), permission
  and question cards, [terminals](terminals.md), [browser](browser.md).
  Those two open as **tabs under the header**: Chat is always first and
  cannot be closed; Browser and each shell get an ×. The strip scrolls
  sideways when tabs overflow, and hides while only Chat is open. Topbar
  icons open or focus a tool; Escape returns to Chat without closing the
  tab.
  A http(s) URL in the chat is a link — markdown `[text](url)` and a bare
  address both. User bubbles too. Images you attach show as thumbnails in
  the bubble (and inside the composer before send); tap one for a full-screen
  viewer you can pinch / scroll to zoom.
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
edges so a thumb can see where each picker starts. Their base font is
**16px** — iOS Safari zooms the page into anything smaller and never zooms
back out, and an older `zoom: 0.75` trick still triggered it (WebKit uses
the scaled size). The installed PWA is different: there the viewport sets
`maximum-scale=1`, which a Home Screen app honours, so focus-zoom is
impossible and the chips draw at a true 12px, the size Cursor gives them.

Mode is Agent, Plan, Debug, Multitask, or Ask — the same five Cursor
lists. The ring around the box, the send button, and the mode chip itself —
word and a tint of background — all take that mode's colour (blue, amber,
red, purple, green), so a glance says which one is in force. An ACP catalog that only names three does
not drop Debug or Multitask from the picker. The model chip is keyed by
model id; after a desktop switch Auto keeps that id (and Cursor's label
as the name) so the control does not go blank. Catalog names that are
slugs (`kimi-k3`) are shown with spaces (`Kimi K3`) so the chip matches
the IDE. A fillable dial sits left
of the attach `+` — context fill for this chat; tap it for session detail
and account quotas ([usage](usage.md)).

## Related

- [Host](host.md)
- [Telegram](telegram.md)
- [Tool lanes](tool-lanes.md)
- [Access](access.md)
