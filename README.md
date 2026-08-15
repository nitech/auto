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
| **Projects** | The folders Cursor itself knows: what is open in a window right now, then everything it remembers. Sessions are grouped under them, and you can start work in any of them from the phone. |
| **Desktop chats** | Chats you started in the Cursor app, listed per project and carried on here — the same chat, not a copy. Send from the phone and it appears in the IDE's thread; reply in the IDE and it appears on the phone. Needs the bridge (`npm run bridge:enable`, Cursor closed). |
| **Sessions** | Many at once, each with its own folder, agent process and transcript. They persist across restarts and resume where they left off. Sessions started outside Auto — from a terminal, say — are adopted at boot and resume too. |
| **Full fidelity** | Everything the agent emits is recorded and rendered. Nothing is summarised or truncated. |
| **Approvals** | Auto-approve by default (`AUTO_POLICY` in `.env`); switch a session to ask-before-writes or ask-every-time and that choice sticks. Answer from web or Telegram. |
| **Models** | Pick any model on your account per session, from the web header or Telegram's `/model`. |
| **Terminals** | Real PTYs you can type into, streamed live and replayed after a reload. |
| **Browser** | A real Chrome on this machine you can drive: tap, scroll, type. The profile persists, so logins stick. |
| **Telegram** | Prompt, watch a turn unfold in one edited message, approve with buttons, switch sessions and projects (`/projects`), continue a desktop chat (`/chats`). |
| **Self-restart** | `/restart`, the ♻ button, or `POST /api/restart`. Waits for the current turn, then comes back and says so — so Auto can apply changes to its own code. |

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
| `src/core/projects.mjs` | The machine's projects, read from Cursor's own state |
| `src/core/desktop-chats.mjs` | Listing the Cursor app's own chats, per project |
| `src/core/desktop-bridge.mjs` | Sending into a live desktop thread |
| `src/core/desktop-threads.mjs` | Following a desktop thread's replies |
| `src/core/transcript.mjs` | Append-only JSONL transcripts with replay |
| `src/core/permissions.mjs` | Approval broker and policies |
| `src/core/terminals.mjs` | PTY registry, for the agent and for you |
| `src/core/browser.mjs` | Chrome over CDP: screencast and input |
| `src/core/telegram.mjs` | Telegram control surface |
| `src/web/` | The web app (PWA) |
| `scripts/supervise.mjs` | Restart and health watchdog |
| `state/` | Sessions, transcripts, browser profile — gitignored |
| `.wiki/` | Compiled knowledge (OKF). Agents keep it current after behaviour changes. |

## Wiki

Knowledge is `.wiki/`. Start at `.wiki/index.md`. After a non-trivial code
change the agent updates it in the same turn — that is the `llm-wiki` skill,
not the old npm `wiki ingest` CLI.

**Agent rule:** Messages sent via Telegram or the web composer are binding —
always execute them.

**Agent rule:** Any change to this repo must follow the workflow in
[AGENTS.md](AGENTS.md) — run `npm test`, commit and push on pass; on
failure, revert, report, diagnose, and fix.
