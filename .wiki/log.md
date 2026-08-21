# Directory Update Log

## 2026-08-21
* **Update**: Chat text fades slightly while the scrub timeline is open so the landmark pills lead.
* **Fix**: Fast scrubbing no longer lets timeline labels slide past the top/bottom of the pane — pill `top` tracks instantly, off-wheel pills hide hard, and the timeline clips.
* **Fix**: "Loading conversation…" never left the screen — the opening-prompt refactor called `earlierNotice()` without ever defining it, so every replay threw. The function exists now, and `npm test` scans the web client for free calls to functions that exist nowhere (`node --check` accepts them as possible globals, which is how this shipped).
* **Update**: Long-chat replay pins the opening prompt above the newest tail so the first message (and its scrub landmark) stay visible.
* **Update**: Web client caches the transcript tail (memory + IndexedDB) so reload and chat switch paint immediately, then catch up from `lastSeq`.
* **Update**: Active scrub label is brighter (kind-coloured ring, stronger type) and stays opaque near centre.
* **Update**: Scrub mode draws a radial veil behind the label wheel so chat text cannot wash out the pills.
* **Update**: Scrub labels are now a counter-scrolling rotary wheel; widths trace a semicircle and fade to zero at the viewport ends.
* **Update**: Scrub labels sit 32px beyond the grip, use larger text/padding, and widen progressively toward vertical screen centre.
* **Fix**: Scrubber now spans the chat pane, making the label's 92px right clearance real instead of being measured inside a zero-width container.
* **Update**: Scrub plan pills use amber (yellow); labels sit further left so they never touch the grip.
* **Update**: Scrub snap is magnetic (only near a landmark); labels stay clear of the grip, thinner, active = whiter text only.
* **Update**: Scrub handle is a flush right-edge grip (rounded on the left, drag ridges, no arrows).
* **Update**: Scrubbing snaps to landmarks and buzzes (`navigator.vibrate`) on each new snap point.
* **Update**: Scrubber pills size to their labels (readable); density only raises the minimum width.
* **Update**: Chat scrubber is Photos-style — handle while scrolling; labeled density-weighted timeline expands left of the thumb only while scrubbing.
* **Update**: Long chats get a scroll scrubber (ticks for your messages, questions, plans, approvals + a floating preview) that appears while scrolling.

## 2026-08-20
* **Update**: Topbar has New chat (same-repo empty conversation); Browser and Terminals toggles moved to the session-rail foot above Settings.
* **Update**: Desktop attach no longer announces "lives in the Cursor desktop app" — that is the default; truncated catch-up still notes how many messages are shown.
* **Update**: Full-window View Plan keeps Build + model picker in a sticky footer under the plan text.
* **Update**: View Plan opens the plan markdown full-window (× / Escape), not inline in the card.
* **Update**: View Plan on the web keeps the Created Plan card in the chat column — wide fences scroll inside instead of clipping mid-line on a phone; repo-path links render as code.
* **Update**: Icons are three tags — `favicon.ico`, `icon.svg`, `apple-touch-icon.png` — after an attempt to make the iOS share sheet draw the mark full-bleed went nowhere. Ruled out: clean vs fingerprinted icon URLs, a precomposed touch icon, raster favicons in three sizes, `mask-icon`, a fresh MagicDNS origin, and HTTPS on 443. That white matte is Safari's chrome.
* **Update**: Auto is reachable over HTTPS inside the tailnet via `tailscale serve` (443 → 4331); Funnel stays off.
* **Update**: App icon mark scaled up (~1.28×) so it fills more of the home-screen / share preview.
* **Update**: Browser tab title leads with this machine's host label (`hostname · Auto`).
* **Update**: Session-rail WebSocket status is a coloured dot left of the host name (no Connected / Reconnecting… text in the header).

## 2026-08-18
* **Update**: Picking a model whose row bundles two badge words into one span (Grok's "High Fast") now works — either word finds that same press, instead of the row going unmatched and its badge text gluing onto the next row's "New" tag.
* **Update**: Picking a named model from the phone works while Cursor is on Auto — the menu hides every other row until Auto types the name into its search box.
* **Update**: Markdown-only edits skip `npm test`; skill `SKILL.md` and any non-markdown file still run the suite.

## 2026-08-17
* **Update**: Mode/model chips scale as one group (no overlap); still ~75% with a 16px font so iOS Safari does not focus-zoom.
* **Update**: Mode/model chips draw at ~75% size via `transform: scale(0.75)` while keeping a 16px font so iOS Safari does not focus-zoom; Home Screen PWA still uses true 12px.
* **Update**: WebSocket status sits in the session-rail header beside Auto (Connected / Reconnecting…), not under Settings at the foot.
* **Update**: View tabs (Browser / shells / which was selected) are remembered per chat across refresh and session switch.
* **Update**: Browser and each shell open as tabs under the header (Chat first, no × on Chat); the side workspace dock is gone. The strip scrolls sideways when tabs overflow.
* **Update**: Browser and terminal toggles live in the topbar at every width (including phone); Settings no longer has a Panels section for them.
* **Update**: Mode/model chips draw at a true 12px in the installed PWA (maximum-scale=1 makes focus-zoom impossible there; the 16px base stays for Safari tabs), and the mode chip's background takes a tint of the mode colour. The rail's new-session and close buttons are inline SVGs instead of text glyphs.
* **Update**: Transcript loading overlay shows the Auto A mark (breathing) instead of a spinner.
* **Update**: Session rail shows this machine's hostname (or a nick from Settings → Host); stored in `state/host.json`.
* **Update**: iOS Home Screen no longer zooms when tapping mode/model — dropped CSS `zoom` on those chips (WebKit still focus-zoomed the scaled size) and locked `maximum-scale=1` in standalone.
* **Update**: New chats started from Auto land on Auto-select (`default[]` / Cursor's "Auto"), instead of inheriting the last chat's model.
* **Update**: Telegram posts prompts typed on the web or in Cursor (without echoing ones typed in Telegram), and retries a turn whose first send failed.
* **Update**: `npm run supervise` runs the setup checklist, flags a missing `agent login` in red, and prints the Tailscale URL (and local port) in colour once the host is up.
* **Update**: Setup treats `agent status` `Not logged in` as a fail (it used to match `/logged in/` and go green). CLI present but unsigned-in is why the model picker stayed empty.
* **Update**: Usage sheet "Model" is the last-sent id in `composerData` (`default` for Auto-select — Cursor does not store which model it routed to). Account "By model" is cycle-wide billed `modelIntent`, not this turn.
* **Update**: Picking Kimi K3 from the phone no longer fails — agent slugs (`kimi-k3`) match Cursor's menu words (`Kimi K3`), and `reasoning=max` is the Max badge.
* **Update**: iOS Home Screen composer still had a strip under it — 8px padding, shell sized to the visual viewport; css/js URLs are now fingerprinted from file mtime so the installed app redownloads them.
* **Update**: Web app is actually installable on the Home Screen — Apple meta + PNG touch icon, 192/512 manifest icons, SVG favicon, and a Settings hint (Share → Add to Home Screen on iPhone).
* **Update**: First-run tutorial at `docs/install.md` (Tailscale, Cursor CLI, debug port). `npm install` runs `scripts/setup.mjs`. Access/overview depersonalised for a public clone.

## 2026-08-16
* **Update**: Desktop prompt echoes are expected before the Cursor write and re-seeded after restart, so user messages stop appearing two or three times.
* **Update**: Usage sheet shows tokens used / context max and estimated chat cost (summed from Cursor’s `usageData`).
* **Update**: Pasted images sit inside the composer box (above the text), not in a strip above it.
* **Update**: New session sheet on a phone tracks the visual viewport so project filter results stay above the soft keyboard.
* **Lint / expand**: Split overloaded `desktop-chats` into [desktop-bridge](concepts/desktop-bridge.md) and [desktop-threads](concepts/desktop-threads.md); added [access](concepts/access.md), [supervise](concepts/supervise.md), [tool-lanes](concepts/tool-lanes.md). Deepened ACP (shell deviation, error-as-prose), host, transcripts (map table), Telegram (web parity). Refreshed overview and index.

## 2026-08-15
* **Update**: MIT `LICENSE`; README notes unofficial status and license. Settings gear is an inline SVG (Icons8 PNGs removed).
* **Update**: Browser and terminals share one workspace — right dock on a wide screen, full-screen sheet on a phone — instead of stacking strips on the chat column.
* **Update**: Usage sheet meters use the amber fill (same as the context dial), with a slightly clearer plan card and bar layout.
* **Update**: Attached images show as thumbnails in the chat stream and above the composer; tap opens a zoomable lightbox (pinch / wheel / drag).
* **Update**: Composer usage dial (this chat's context fill) plus a sheet for Cursor Models / Other Models / included / on-demand and per-model spend — same numbers as cursor.com, not shown in the IDE chat chrome.
* **Update**: Changing a desktop chat's model keeps the web picker on that model — it used to store Cursor's label as the value and go blank.
* **Update**: Changing a desktop chat's model no longer lets Cursor auto-send the next queued message when the switch ends a paused turn (e.g. high demand) — the queue is held first.
* **Update**: Unnamed MCP placeholders (`MCP: tool`) are hidden like in the IDE, instead of showing as OTHER cards.
* **Update**: A submitted message no longer appears two or three times — the web keeps echo credits for the optimistic bubble, and the host expects Cursor's copy on queued and held sends too.
* **Update**: Mirrored answers no longer stutter — stale shorter DB reads are ignored, and real rewrites replace the bubble instead of appending.
* **Update**: Each web session keeps its own composer draft; idle sends appear in the stream immediately.
* **Update**: Cursor harness notes (`system_notification` when a background command finishes) are not copied onto the phone — they are stored as user bubbles, but the IDE never paints them.
* **Update**: Bare http(s) URLs in the chat are links — on the web and on Telegram.
* **Update**: Swiping the session rail left on iPhone uses touch events, because Safari never fires pointermove on a scrolling list.
* **Update**: On a phone, × archives a session on the first tap, and swiping the session rail left closes it.
* **Update**: The web tab remembers the open chat (`?session=` and the browser) so a refresh or returning to Auto opens the same conversation, not the host's active session.
* **Update**: Settings is a gear + label at the bottom of the session rail, and the panel fills the screen. The top-bar ⋯ is gone.
* **Update**: A host restart mid-turn no longer marks Cursor's finished bubbles as already in the transcript, so the closing answer still reaches the phone.
* **Update**: Composer mode/model chips stay 16px for iOS but `zoom: 0.75` so they look like 12px.
* **Update**: The web composer's attach control is a + on the lower-right. Mode and model are chips (background, rounded edges) at 16px so iOS does not zoom on tap.
* **Update**: Question answers press Cursor's questionnaire toolbar (sibling of the tool bubble). Option text is often glued as "ARed"; Continue is located even while disabled.
* **Update**: Question answers are a real mouse on lettered option rows, not a click for `role=radio` inside the tool bubble — that was "no option says Red".
* **Update**: The web composer's attach control is a binder on the lower-right of the box, not a + in the typing row.
* **Update**: Skip/Continue on an `ask_question` bubble are not approvals. A question with no options yet still keeps the approval watcher off. Option press matches a truncated label and falls back to the Nth row.
* **Update**: A prompt Auto typed into Cursor is matched with normalised quotes and spacing, and a second desktop bubble of the same send is not drawn again.
* **Update**: The web composer colours its ring, send button, and mode word from the mode in force (Agent / Plan / Debug / Multitask / Ask), matching Cursor, and Debug and Multitask are in the picker.
* **Update**: A finished turn now says how long it took (Worked for / Thought for), matching Cursor. The web shows Working… while it runs and no longer leaves commands "running…" after the session goes idle.
* **Creation**: Migrated the knowledge base from `wiki/` + `raw/` (npm llm-wiki CLI) into `.wiki/` (OKF). Seeded overview and concept pages covering the current host, sessions, transcripts, desktop chats, Cursor window, ACP, approvals, queue, Telegram, web, browser, terminals, projects, and skills.
* **Update**: Diagnosed why the wiki had gone stale — the global `llm-wiki` skill had `disable-model-invocation: true` (never auto-applied) and this repo had no `.wiki/` bundle for it to maintain.

## 2026-08-09
* **Creation**: `wiki/concepts/llm-wiki.md` and `wiki/concepts/auto_web.md` via npm `wiki ingest` (retired path).
* **Note**: `wiki/concepts/desktop_chats.md` was later written by hand into the old bundle; content now lives at [desktop-chats](concepts/desktop-chats.md).
