# Directory Update Log

## 2026-08-15
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
