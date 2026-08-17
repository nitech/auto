# Directory Update Log

## 2026-08-17
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
