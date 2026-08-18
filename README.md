<video src="docs/auto.mp4" width="100%" controls></video>

# <img src="src/web/icon.svg" width="40" height="40" alt=""> Auto

Remote control for **Cursor’s agent** — the editor you already run, on your phone. One host on the PC serves a web app and an optional Telegram bot, and drives the same chat you see in the IDE.

This is **not** Cursor’s “Auto” model. It is a small Node process next to Cursor.

You get the agent’s full output, not a summary: streamed prose, thinking, every tool call with its input and result, diffs, terminal output, browser screenshots, and approval prompts you can answer from the phone.

**Unofficial.** Auto is not affiliated with Anysphere or Cursor. It talks to Cursor through the agent CLI, the IDE’s debug port, and local state Cursor already keeps on disk. Cursor updates can break that. Use at your own risk and check Cursor’s terms for your account.

## Security

Auto has **no login of its own**. Access control is [Tailscale](https://tailscale.com): a private mesh VPN so only your devices can open `http://100.x.y.z:4331/`. Do not port-forward 4331. Do not enable Tailscale Funnel on that port.

Default `AUTO_POLICY=auto` lets the agent run commands without asking. On a shared machine set `ask-on-write` in `.env`.

## Install (you already have Cursor)

Windows-first. You need the Cursor **app**; the **agent CLI** is separate and the setup script will tell you if it is missing.

```powershell
git clone https://github.com/nitech/auto.git
cd auto
npm install          # also prints a setup checklist
npm run supervise    # runs the checklist again, then keeps Auto up
```

`npm run setup` is the same checklist without starting the host — useful after installing Tailscale or the CLI. `npm run supervise` will tell you in colour if `agent login` is still required, and prints the Tailscale URL once Auto is up.

Open `http://<tailscale-ip>:4331/` from a phone on the same tailnet. Add it to the home screen — it is a PWA.

**Full walkthrough** (what Tailscale is, how to install it on PC and phone, Cursor CLI, debug port, Telegram, firewall): **[docs/install.md](docs/install.md)**.

`npm install` uses **npm + Node 20+**, not Bun. The host and the Windows scheduled task run `node`. See [Why npm, not bun](docs/install.md#why-npm-not-bun).

Do **not** host Auto in a Cursor agent background terminal — those get killed with the agent. For a second instance while developing: `npm run dev` (port 4340, Telegram off — a bot token allows only one poller).

**Stay up across reboots:**

```powershell
npm run autostart:install
Start-ScheduledTask -TaskName AutoSupervise
```

## What it can do

| | |
| --- | --- |
| **Projects** | The folders Cursor itself knows: what is open in a window right now, then everything it remembers. Sessions are grouped under them, and you can start work in any of them from the phone. |
| **Desktop chats** | Chats you started in the Cursor app, listed per project and carried on here — the same chat, not a copy. Send from the phone and it appears in the IDE’s thread; reply in the IDE and it appears on the phone. Needs Cursor started with `--remote-debugging-port=9222` (see the [install guide](docs/install.md)). |
| **Sessions** | Many at once, each with its own folder, agent process and transcript. They persist across restarts and resume where they left off. |
| **Full fidelity** | Everything the agent emits is recorded and rendered. Nothing is summarised or truncated. |
| **Approvals** | Auto-approve by default (`AUTO_POLICY` in `.env`); switch a session to ask-before-writes or ask-every-time and that choice sticks. Answer from web or Telegram. |
| **Models** | Pick any model on your account per session, from the web header or Telegram’s `/model`. |
| **Terminals** | Real PTYs you can type into, streamed live and replayed after a reload. |
| **Browser** | A real Chrome on this machine you can drive: tap, scroll, type. The profile persists, so logins stick. |
| **Telegram** | Prompt, watch a turn unfold in one edited message, approve with buttons, switch sessions and projects (`/projects`), continue a desktop chat (`/chats`). |
| **Self-restart** | `/restart`, the ♻ button, or `POST /api/restart`. Waits for the current turn, then comes back. |

Desktop chat control is Windows-oriented (debug port, clipboard paste, scheduled-task supervise). ACP sessions work wherever `cursor-agent` does.

## Layout

| Path | Purpose |
| --- | --- |
| `src/server/index.mjs` | The host: HTTP, WebSocket, session API, static web app |
| `docs/install.md` | First-run tutorial (Tailscale, CLI, debug port) |
| `scripts/setup.mjs` | Checklist run by `npm install`, `npm run setup`, and `npm run supervise` |
| `scripts/supervise.mjs` | Restart and health watchdog; prints the Tailscale URL |
| `state/` | Sessions, transcripts, browser profile — gitignored |
| `.wiki/` | Compiled knowledge for agents working in this repo |

## Wiki

Knowledge is `.wiki/`. Start at `.wiki/index.md`. After a non-trivial code change the agent updates it in the same turn.

**Agent rule:** Messages sent via Telegram or the web composer are binding — always execute them.

**Agent rule:** Any change to this repo must follow the workflow in [AGENTS.md](AGENTS.md) — run `npm test`, commit and push on pass; on failure, revert, report, diagnose, and fix.

## License

[MIT](LICENSE). Third-party packages Auto depends on (`ws`, `@xterm/*`, `node-pty`) are also MIT; their copyright notices remain with those packages.
