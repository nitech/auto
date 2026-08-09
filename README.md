# auto · Auto Web

Personal Telegram bridge (`@Sausemesteren_bot`), **Auto Web** status console, and an [llm-wiki](https://www.npmjs.com/package/llm-wiki) knowledge base.

## Auto Web

```powershell
cd D:\Sevenfold\auto
npm start
```

Open: `http://<tailscale-ip>:4331/` (default port **4331**).

```powershell
npm run send -- --text="hello"
npm run listen
```

## llm-wiki

Scaffold lives under `wiki/` + `raw/`. Config: `.wikirc.yaml` (gitignored).

```powershell
npm run wiki:ingest          # ingest pending raw sources
npx wiki query "What is Auto Web?"
npm run wiki:lint
```

Concept pages so far: `wiki/concepts/auto_web.md`, `wiki/concepts/llm-wiki.md`.

## Layout

| Path | Purpose |
| --- | --- |
| `scripts/debug-server.mjs` | **Auto Web** UI + Telegram poller; starts main agent |
| `scripts/main-agent.mjs` | Always-on front-desk Claude session (`:4332`) |
| `scripts/worker-agent.mjs` | Per-task worker subagent (reports status to main) |
| `scripts/send.mjs` / `listen.mjs` | Outbound / inbound helpers |
| `hooks/cursor-debug-feed.mjs` | Cursor hook → `/api/event` |
| `wiki/` | llm-wiki pages |
| `raw/` | Sources for ingest |
| `auth.json` | Telegram `{ token, chatId }` — gitignored |

**Agent rule:** Messages via Telegram or Auto Web compose are binding — always execute.

**Agent rule:** Any change to this repo must follow the workflow in [CLAUDE.md](CLAUDE.md) — run `npm test`, commit on pass, restart the service; on failure, revert, report, diagnose, and fix.

**Auto agents (default ON):**
- **Main agent** (`scripts/main-agent.mjs`, `:4332`) — warm Claude stream-json session for instant replies
- **Workers** (`scripts/worker-agent.mjs`) — spawned per task; report status to main, which updates you on Telegram / Auto Web

Disable with `AUTO_PROCESS=0`.
