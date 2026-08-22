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
  - id: md
    resource: /src/web/markdown.js
    title: Markdown parser
  - id: enrich
    resource: /src/web/enrich.js
    title: Diagram and math rendering
  - id: tools
    resource: /src/web/desktop-tool-ui.js
    title: Desktop tool lanes
  - id: manifest
    resource: /src/web/manifest.webmanifest
    title: Web app manifest
  - id: icon
    resource: /src/web/icon.svg
    title: App icon
generated: { by: agent, at: 2026-08-22T16:00:00Z }
---

# Web app

A projection of the host's [transcript](transcripts.md). It attaches over
the WebSocket, replays from a sequence number, and renders records as they
stream. A reload or a dropped connection does not lose history.

The last ~1200 records are cached in memory (switching chats in this tab)
and IndexedDB (hard reload), along with the pinned opening prompt. Boot paints
the cache first, then the handshake asks for `fromSeq: lastSeq` so only the
tail is downloaded; the loading overlay is skipped when the cache already
filled the pane. Switching back to a chat still in memory is the same path.
The host remains authoritative — `replaced` or a gap clears the pane and
redraws. A long chat always shows the first user message at the top (and on
the scrub timeline), with an omission notice for the middle stretch.

The open chat is this tab's, not the host's active session. A refresh puts
`?session=` on the URL and the handshake asks for that id even when the page
has nothing to replay yet; opening Auto at `/` (the PWA start URL) reads the
same id from the browser. Telegram `/switch` does not steal the tab.

Open `http://<tailscale-ip>:4331/`. It is a PWA: `display: standalone`, an
SVG tab icon (transparent glyph, cropped tight so it fills a PC tab), and PNG
icons (180 / 192 / 512) so a phone can put it on the Home Screen. The A is
scaled up inside a full-bleed dark tile on those PNGs so the mark fills more
of the preview; the tab favicon and `favicon.ico` stay clear of any matte so
they sit on the browser chrome.

Three icon tags, and that is deliberate: `favicon.ico` for browsers that do
not take an SVG, `icon.svg` for modern tabs, `apple-touch-icon.png` for iOS.
Paths stay clean, since `?v=` fingerprinting is for css/js.

Chasing the iOS share sheet, which centres Auto's mark on a white card
rather than filling the rounded square, is a known dead end: the enlarged
mark, clean icon URLs, a precomposed touch icon, raster favicons in three
sizes, demoting the SVG to `mask-icon`, a fresh MagicDNS origin, and HTTPS
on 443 through `tailscale serve` all left it identical. Treat that matte as
Safari's own chrome unless someone has new evidence. iOS needs
`apple-mobile-web-app-capable` and
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
keeping the first stylesheet it ever saw. A `webBuild` fingerprint hashes
every first-party file under `src/web`; it is stamped into
`<meta name="auto-build">`, returned by `/api/health`, and sent on the
WebSocket `hello`. The client compares that to what it loaded: on mismatch
(a host restart after a deploy) it shows a reload banner, and polls again
when the tab comes back to the foreground.

The composer floats over the transcript: no hairline above the box.
Messages scroll through a short fade and under the field. A measured
`--composer-height` pads the transcript (and lifts the jump button /
scrub rail) so the newest line stays readable at the live edge.

Mode and model live beside the composer, as in Cursor; approval policy
lives in the top bar (and in Settings on a narrow screen). The topbar
also has **New chat** — one tap starts an empty conversation in the open
session's folder (`session.create`), without the project picker, and puts
the caret in the composer as soon as you tap (again once the empty chat
attaches). Settings
is a row at the bottom of the session rail — a gear and the word Settings —
and opens a full-screen page. Above it sit the Browser and Terminals
toggles (optional panes; once open, the view tabs switch between them).
The rail header shows the Auto A mark and
this machine's name (OS hostname, or a nick set in Settings → Host), with
a status dot beside it. The same label leads the browser tab title
(`hostname · Auto`) so which PC this is stays visible in the chrome. The
dot is green when the WebSocket is up; words like Connected /
Reconnecting… stay on the dot's label and in Settings → Host.

Scrollbars are thin overlay thumbs: idle-invisible, visible on hover and
while scrolling (macOS-style), so Windows does not keep a wide gutter.

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

- While a long transcript replays with nothing cached, the chat pane shows
  the Auto A mark (same glyph as the rail) and "Loading conversation…", not
  a blank. A cache hit paints first and skips that overlay.
- The session rail as two accordion rows — **Chats** (date-grouped Auto
  sessions and Cursor's recent chats) and **Projects** (folders Cursor
  knows, plus per-folder desktop chats). Opening one closes the other;
  tapping an open row collapses it. Which row was open (or neither) is
  remembered in the browser. Rebuilding the list (sessions update, opening
  the drawer) must not treat the teardown `toggle` as a collapse — that used
  to write "neither" and always reopen shut. A left swipe's click-guard
  expires after the gesture so the next open can switch chats on the first
  tap.
- The [queue](queue.md) above the chat box, with reword / send now / delete.
- A **Review changes** card at the end of a turn when Cursor still has
  unreviewed edits (Keep / Undo / Redo) — scrub landmark with a +/−
  headline; see [approvals](approvals.md). Not mixed into permission cards.
- Tool calls the way Cursor groups them — see [tool lanes](tool-lanes.md).
- Diffs, thinking (folded when the block ends, timed from the record so a
  replay says "Thought for 8s" rather than staying "Thinking"), permission
  and question cards, [terminals](terminals.md), [browser](browser.md).
  Those two open as **tabs under the header**: Chat is always first and
  cannot be closed; Browser and each shell get an ×. The strip scrolls
  sideways when tabs overflow, and hides while only Chat is open. Rail-foot
  icons open or focus a tool; Escape returns to Chat without closing the
  tab. Which tabs were open (and which was selected) is remembered per chat
  in the browser, so a refresh or switching back restores them — live shells
  the host still has, plus the Browser tab.
  A http(s) URL in the chat is a link — markdown `[text](url)` and a bare
  address both. User bubbles too. Images you attach show as thumbnails in
  the bubble (and inside the composer before send); tap one for a full-screen
  viewer you can pinch / scroll to zoom.
- A turn still going says **Working…** at the bottom of the stream. When it
  ends, that line becomes **Worked for 7m 3s** or **Thought for 1s** above
  the answer, the way Cursor labels a finished turn. Commands left
  "running…" after the session goes idle settle to stopped — an idle chip
  with live cards is a lie. Stopping a turn pulls the prompt back into the
  composer (and off the stream) so it can be edited and sent again — same
  gesture as Cursor's own Stop; Cursor's box is cleared so a phone can still
  reach the chat.
- While scrolling a long chat, a flush right-edge grip appears (rounded on
  the left, drag ridges — Google Photos style). Grabbing it expands a labeled
  timeline **to the left of the thumb** — your messages, questions, plans,
  approvals, and file-review cards — and the chat text dims hard so the pills lead. Labels
  follow the finger continuously; only the chat content snaps to landmarks,
  so the wheel does not jitter under a magnetic latch. Label motion is linear
  along the rail (index × finger), independent of how much chat text sits
  between landmarks — chat scroll and snap keep their own mapping. The timeline
  spans the chat pane and keeps 32px of air beyond the
  28px grip, so the finger never covers the labels without disconnecting them
  visually. It is a rotary wheel: moving the grip down moves the evenly spaced
  label stack up. Every landmark remains on the wheel, including those beyond
  the viewport. Pill widths follow a semicircle (`sqrt(r²-y²)`), widest at
  vertical centre (~260px) and tapering/fading to nothing at the top and bottom; past
  that radius each pill is `visibility: hidden` and the timeline clips
  (`overflow: hidden`). Pill `top` and `width` update with no CSS transition so
  they stay locked to the finger. Active only changes
  text colour — now with a kind-coloured ring and brighter fill
  so the centre label reads as the focus. A radial veil anchored on the right
  edge sits behind the wheel so transcript text cannot wash out the pills.
  Dragging scrolls the chat so the **active pill's landmark sits at the top
  of the viewport** (labels still follow the finger on their own rail).
  Arrow keys step landmark-to-landmark. Release
  collapses back to the handle, which docks into the right edge as a peek
  when idle (scroll or tap slides it out again). Short chats never
  show it. The ↓ jump-to-newest button is unchanged.
- Agent prose renders from markdown. The bubble keeps the **raw source** on
  `data-raw` and paints HTML into an inner `.agent-body`, so a long answer
  can offer **Copy markdown** at the bottom without destroying that control
  on every streamed chunk. Short replies skip the button. Code blocks still
  have their own Copy control. The control is a quiet right-aligned clipboard
  icon (check on success), not a text label.
- While an answer streams, stick-to-bottom is **instant** (one scroll per
  frame, `behavior: 'auto'`). `#transcript` no longer uses CSS
  `scroll-behavior: smooth` — that animated every chunk and jumped as
  animations cancelled. The ↓ button still scrolls smoothly on its own.
  The live `.agent-body` also pins a `min-height` floor so incomplete
  markdown (open fence, half a table) cannot collapse the bubble and yank
  the pane; the pin clears when the bubble finishes. **Tables** sit in a
  `.table-wrap` scroll strip (`overflow-x: auto`) with cells capped at
  `28em` and `overflow-wrap: break-word` — prose wraps, short columns stay
  narrow, many columns still scroll sideways. **Mermaid** (` ```mermaid `
  fences), **KaTeX** math (`$…$`, `$$…$$`, and ` ```math ` fences), and
  **GitHub callouts** (`> [!NOTE]` etc.) render like Cursor's chat — diagrams
  and math load from `/vendor/` on demand via `enrich.js` after the HTML is
  painted; Telegram still gets plain text.

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
the scaled size). They sit in a `.composer-pickers` group scaled with
`transform: scale(0.75)` so the chips and the gap between them shrink
together (about 12px) without overlapping; computed font-size stays 16px.
The installed PWA is different: there the viewport sets `maximum-scale=1`,
which a Home Screen app honours, so focus-zoom is impossible and the chips
draw at a true 12px with no transform, the size Cursor gives them.

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
