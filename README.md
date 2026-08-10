# auto · Auto Web

Personal Telegram bridge (`@Sausemesteren_bot`), **Auto Web** status console, and an [llm-wiki](https://www.npmjs.com/package/llm-wiki) knowledge base.

## Auto Web

```powershell
cd D:\Sevenfold\auto
npm run supervise          # recommended — auto-restarts on crash
# or: npm start            # bare server (dies if the shell dies)
```

Open: `http://<tailscale-ip>:4331/` (default port **4331**).

**Stay up across reboots / Cursor shell kills:**

```powershell
npm run autostart:install  # Windows Scheduled Task at logon
Start-ScheduledTask -TaskName AutoSupervise
```

Do **not** rely on Cursor agent background terminals to host Auto — those get killed with the agent.

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
| `scripts/main-agent.mjs` | Always-on front-desk agent session (`:4332`) |
| `scripts/worker-agent.mjs` | Per-task worker subagent (reports status to main) |
| `scripts/supervise.mjs` | Restart + health watchdog (preferred long-run entry) |
| `scripts/install-autostart.ps1` | Windows logon Scheduled Task for supervise |
| `scripts/send.mjs` / `listen.mjs` | Outbound / inbound helpers |
| `hooks/cursor-debug-feed.mjs` | Cursor hook → `/api/event` |
| `wiki/` | llm-wiki pages |
| `raw/` | Sources for ingest |
| `auth.json` | Telegram `{ token, chatId }` — gitignored |

**Agent rule:** Messages via Telegram or Auto Web compose are binding — always execute.

**Agent rule:** Any change to this repo must follow the workflow in [AUTO.md](AUTO.md) — run `npm test`, commit on pass, restart the service; on failure, revert, report, diagnose, and fix.

**Auto agents (default ON):**
- **Main agent** (`scripts/main-agent.mjs`, `:4332`) — warm agent stream-json session for instant replies
- **Workers** (`scripts/worker-agent.mjs`) — spawned per task; report status to main, which updates you on Telegram / Auto Web

Disable with `AUTO_PROCESS=0`.

**LLM provider (`.env`):** copy `.env.example` → `.env`. The provider is pluggable — everything above behaves identically regardless of which model is behind the agent (see the Agent-independence rule in [AUTO.md](AUTO.md)). Default Kimi path is **subscription** (`AUTO_KIMI_MODE=coding`): run `npm run kimi:login` once (browser device login), then restart. That uses membership quota via `api.kimi.com/coding`, not pay-per-token `platform.kimi.ai`. Optional: set `KIMI_CODE_API_KEY` from the Kimi Code console instead of OAuth. `AUTO_PROVIDER=claude` uses your normal Claude Code login.
