# Directory Update Log

## 2026-08-15
* **Update**: A finished turn now says how long it took (Worked for / Thought for), matching Cursor. The web shows Working… while it runs and no longer leaves commands "running…" after the session goes idle.
* **Creation**: Migrated the knowledge base from `wiki/` + `raw/` (npm llm-wiki CLI) into `.wiki/` (OKF). Seeded overview and concept pages covering the current host, sessions, transcripts, desktop chats, Cursor window, ACP, approvals, queue, Telegram, web, browser, terminals, projects, and skills.
* **Update**: Diagnosed why the wiki had gone stale — the global `llm-wiki` skill had `disable-model-invocation: true` (never auto-applied) and this repo had no `.wiki/` bundle for it to maintain.

## 2026-08-09
* **Creation**: `wiki/concepts/llm-wiki.md` and `wiki/concepts/auto_web.md` via npm `wiki ingest` (retired path).
* **Note**: `wiki/concepts/desktop_chats.md` was later written by hand into the old bundle; content now lives at [desktop-chats](concepts/desktop-chats.md).
