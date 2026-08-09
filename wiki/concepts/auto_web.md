# Auto Web

Auto Web is the browser UI for the Auto project at D:\Sevenfold\auto (port 4331).

## Responsibilities
- Live SSE log of Telegram inbound/outbound and Cursor agent tool activity
- Session tabs (per project folder) with token stats in the Stats menu
- ChatGPT-style compose box (Enter to send, image attach/paste/drop)
- Auto-process: each message runs immediately via claude -p (scripts/process-instruction.mjs); no drain backlog

## Key scripts
- scripts/debug-server.mjs — Auto Web HTTP UI + Telegram poller + processor pump
- scripts/lib.mjs — auth, Telegram API, paths, normalizeFsPath
- scripts/send.mjs / listen.mjs — outbound / inbound helpers
- scripts/process-instruction.mjs — Claude Code executor for instructions
- hooks/cursor-debug-feed.mjs — Cursor hooks → /api/event

## Related
- llm-wiki installed as npm dependency for a local knowledge wiki under wiki/
- Cursor skill telegram-notify points here

[src: raw/ingested/2026/08/09-auto-web-architecture.md]