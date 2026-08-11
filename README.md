# auto

Remote control for Cursor's agent. Auto runs on this machine, drives the
Cursor agent CLI, and gives you the Agents window from anywhere — a web app
and a Telegram bot, both showing the same live session.

You get the agent's full output, not a summary: streamed prose, thinking,
every tool call with its input and result, diffs, terminal output, browser
screenshots, and approval prompts you can answer from your phone.

## Run it

```powershell
cd D:\Sevenfold\auto
npm run supervise          # restarts on crash and health failure
```

Open `http://<tailscale-ip>:4331/`. Add it to your home screen — it is a
PWA. Access control is Tailscale: Auto has no login of its own, so do not
expose the port to the open internet.

**Stay up across reboots and Cursor shell kills:**

```powershell
npm run autostart:install  # Windows Scheduled Task at logon
Start-ScheduledTask -TaskName AutoSupervise
```

Do **not** host Auto in a Cursor agent background terminal — those get
killed with the agent and take Auto down.

For a second instance while developing: `npm run dev` (port 4340, Telegram
off — a bot token allows only one poller).

## What it can do

| | |
| --- | --- |
| **Sessions** | Many at once, each with its own folder, agent process and transcript. They persist across restarts and resume where they left off. |
| **Full fidelity** | Everything the agent emits is recorded and rendered. Nothing is summarised or truncated. |
| **Approvals** | Auto-approve by default (`AUTO_POLICY` in `.env`); switch a session to ask-before-writes or ask-every-time and that choice sticks. Answer from web or Telegram. |
| **Models** | Pick any model on your account per session, from the web header or Telegram's `/model`. |
| **Terminals** | Real PTYs you can type into, streamed live and replayed after a reload. |
| **Browser** | A real Chrome on this machine you can drive: tap, scroll, type. The profile persists, so logins stick. |
| **Telegram** | Prompt, watch a turn unfold in one edited message, approve with buttons, switch sessions. |

## Requirements

The Cursor agent CLI must be installed and logged in:

```powershell
agent status      # expect isAuthenticated: true
agent login       # if not
```

Telegram credentials come from `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`, or
the `auth.json` the telegram-notify skill writes. Copy `.env.example` to
`.env` for the rest; every setting there is optional.

## Layout

| Path | Purpose |
| --- | --- |
| `src/server/index.mjs` | The host: HTTP, WebSocket, session API, static web app |
| `src/acp/` | JSON-RPC client for the agent's ACP mode |
| `src/core/sessions.mjs` | Session lifecycle, registry, resume |
| `src/core/transcript.mjs` | Append-only JSONL transcripts with replay |
| `src/core/permissions.mjs` | Approval broker and policies |
| `src/core/terminals.mjs` | PTY registry, for the agent and for you |
| `src/core/browser.mjs` | Chrome over CDP: screencast and input |
| `src/core/telegram.mjs` | Telegram control surface |
| `src/web/` | The web app (PWA) |
| `scripts/supervise.mjs` | Restart and health watchdog |
| `state/` | Sessions, transcripts, browser profile — gitignored |
| `wiki/`, `raw/` | llm-wiki knowledge base |

## llm-wiki

```powershell
npm run wiki:ingest          # ingest pending raw sources
npx wiki query "How do sessions resume?"
npm run wiki:lint
```

**Agent rule:** Messages sent via Telegram or the web composer are binding —
always execute them.

**Agent rule:** Any change to this repo must follow the workflow in
[AGENTS.md](AGENTS.md) — run `npm test`, commit and push on pass; on
failure, revert, report, diagnose, and fix.
