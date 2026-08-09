# auto

Personal Telegram bridge (`@Sausemesteren_bot`) and live agent/status debug console.

## Quick start

```powershell
cd D:\Sevenfold\auto
npm start
```

Open: `http://<tailscale-ip>:4331/` (default port **4331**).

```powershell
npm run send -- --text="hello"
npm run listen
```

## Layout

| Path | Purpose |
| --- | --- |
| `auth.json` | `{ "token", "chatId" }` — gitignored |
| `scripts/debug-server.mjs` | Status UI + Telegram poller |
| `scripts/send.mjs` / `listen.mjs` | Outbound / inbound |
| `hooks/cursor-debug-feed.mjs` | Cursor hook → `/api/event` |
| `events.jsonl` | Append-only log |

Cursor skill `telegram-notify` points here. User hooks in `~/.cursor/hooks.json` call `hooks/cursor-debug-feed.mjs`.
