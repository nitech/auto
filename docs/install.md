# Install Auto

This is for someone who **already runs Cursor** on a Windows PC and wants the same agent on a phone. Auto is not a Cursor replacement and it is not Cursor’s “Auto” model — it is a remote control that sits next to the editor you already use.

macOS and Linux can run ACP sessions (`cursor-agent acp`) but desktop-chat control (typing into the IDE, paste, scheduled-task supervise) is Windows-first. This tutorial is the Windows path.

## What you will have

- A small Node host on the PC (`http://<tailscale-ip>:4331/`) — a PWA you add to the phone’s home screen.
- Optional Telegram bot, same sessions as the web app.
- Cursor still does the work. Auto drives it.

**Unofficial.** Auto is not affiliated with Anysphere or Cursor. It talks to Cursor through the agent CLI, the IDE’s debug port, and local state Cursor already keeps on disk. Cursor updates can break that. Check Cursor’s terms for your account.

## Security, before anything else

Auto has **no login of its own**. Whoever can reach port 4331 can prompt your agent, see transcripts, and (with the default policy) let it run commands on the PC.

That is why reachability is **Tailscale**, not port-forwarding:

- Bind stays `0.0.0.0:4331` so the Tailscale interface can accept the phone.
- Do **not** forward 4331 on your router.
- Do **not** turn on Tailscale Funnel / Serve for this port — that would put Auto on the public internet.
- Default `AUTO_POLICY=auto` means the agent is not asked before writes and shell commands. On a shared PC set `AUTO_POLICY=ask-on-write` in `.env`.

Telegram is a second door. `TELEGRAM_CHAT_ID` is the allowlist: without it, anyone who finds the bot can talk to the agent.

## 1. Tailscale — the lock on the door

### What it is

Tailscale is a mesh VPN built on WireGuard. You install a client on each device, sign in with the same account, and those devices get stable addresses in `100.x.y.z`. Traffic between them is encrypted and does not go through your router’s port forwards. Devices not on your tailnet cannot open Auto.

A personal account is enough (PC + phone). You do not need an exit node, subnets, or Funnel.

### On the PC (the machine that runs Cursor)

1. Download the Windows installer: [tailscale.com/download/windows](https://tailscale.com/download/windows).
2. Run it. A Tailscale icon appears in the system tray (click the `^` if it is hidden).
3. Right-click → **Log in** and finish the browser sign-in.
4. Confirm you have an address:

```powershell
tailscale ip -4
```

You want a line like `100.64.12.34`. That is the host you will type on the phone.

### On the phone

1. Install **Tailscale** from the App Store (iOS) or Play Store (Android).
2. Sign in with **the same account** as the PC.
3. Wait until the PC shows as connected in the app’s machine list.

You are not giving Tailscale your Cursor account. You are putting the phone and the PC on a private network so `http://100.x.y.z:4331/` is reachable only to you.

## 2. Node.js

Auto’s host is Node, not Bun (see [Why npm, not bun](#why-npm-not-bun)).

1. Install the current **LTS** (20 or 22) from [nodejs.org](https://nodejs.org).
2. Open a **new** PowerShell and check:

```powershell
node -v    # v20.x or v22.x
npm -v
```

On Windows, `node-pty` (the terminal pane) needs a C++ toolchain if a prebuild is not available. If `npm install` complains about `node-gyp` / `node-pty`, install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with **Desktop development with C++**, then `npm install` again. Auto’s web UI still runs without terminals.

## 3. Clone and install

```powershell
git clone https://github.com/nitech/auto.git
cd auto
npm install
```

`npm install` compiles dependencies and then runs `scripts/setup.mjs`. You should see a checklist:

```
Auto setup
  ✓ Node v22.x
  ✓ node-pty loaded
  ✗ Cursor agent CLI not found
    In PowerShell: irm 'https://cursor.com/install?win32=true' | iex   then: agent login
  ✗ Tailscale not installed
  ✓ copied .env.example → .env
```

Fix anything with `✗`, then:

```powershell
npm run setup
```

That command exits `1` until the required rows are green. `npm install` itself will not fail because Tailscale or the CLI is missing — those are the next steps.

## 4. Cursor agent CLI

The Cursor **app** does not install the **agent CLI**. Auto needs the CLI even when it is driving a desktop chat (and always when it falls back to ACP).

In PowerShell:

```powershell
irm 'https://cursor.com/install?win32=true' | iex
agent login
agent status      # expect: Logged in as …
```

Close and reopen the terminal if `agent` is not found after the installer.

Official overview: [cursor.com/docs/cli/overview](https://cursor.com/docs/cli/overview).

## 5. First run

```powershell
npm run supervise
```

Leave that window open. Open the Tailscale address from the phone’s browser (Safari / Chrome), not from a PC-only bookmark:

```text
http://100.x.y.z:4331/
```

Use the value `tailscale ip -4` printed on the PC. Add to Home Screen — it is a PWA.

If the phone spins and never loads:

- Phone and PC must both show as connected in Tailscale.
- Windows Firewall sometimes blocks Node on 4331. From an elevated PowerShell on the PC:

```powershell
New-NetFirewallRule -DisplayName "Auto" -Direction Inbound -Protocol TCP -LocalPort 4331 -Action Allow
```

- On the PC, `http://127.0.0.1:4331/` should work even when Tailscale does not. If that fails, the host is not up.

Do **not** run `npm run supervise` inside a Cursor agent background terminal — those get killed with the agent and take Auto down.

### Stay up across reboot

```powershell
npm run autostart:install
Start-ScheduledTask -TaskName AutoSupervise
```

That registers a logon scheduled task. The task runs `node`, not Bun.

## 6. Let Auto type into Cursor (recommended)

New sessions prefer a real Cursor window. That needs the IDE listening on its debug port.

**If Cursor is already running without that port**, Auto will quit it and start it again so it can pass `--remote-debugging-port=9222`. That closes every Cursor window. Quit Cursor yourself first if you have unsaved work.

Start Cursor like this (adjust the folder):

```powershell
& "$env:LOCALAPPDATA\Programs\cursor\Cursor.exe" --remote-debugging-port=9222 "C:\path\to\your\project"
```

Check:

```powershell
npm run bridge
```

You want `debug port … listening`. The named-pipe bridge (`npm run bridge:enable`, Cursor closed) is a fallback when the debug port is not there; the debug port is the one you want.

## 7. Telegram (optional)

The web app is enough. Telegram is the same sessions, shorter rendering.

1. In Telegram, talk to [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token.
2. Talk to your new bot once, then get your chat id (for example via `@userinfobot`, or from `getUpdates` after you have messaged the bot).
3. Put both in `.env`:

```
TELEGRAM_BOT_TOKEN=…
TELEGRAM_CHAT_ID=…
AUTO_WEB_URL=http://100.x.y.z:4331
```

4. Restart the host (`npm run supervise`, or `/restart` once it is up).

A bot token allows **one** poller. A second Auto with the same token splits messages at random. Use `npm run dev` (port 4340, Telegram off) for a second instance while developing.

## Approvals

| `.env` value | Meaning |
| --- | --- |
| `auto` (default) | Approve everything |
| `ask-on-write` | Approve reads; ask before writes and commands |
| `ask` | Ask every time |

You can change a running session from the web header or Telegram `/policy` without editing `.env`. `.env` only sets the default for new sessions.

## Why npm, not bun

Bun is installed on some of these machines and can import `node-pty`, but Auto is a **Node** process:

- `scripts/supervise.mjs` and the `AutoSupervise` scheduled task execute `node`.
- ACP talks to Cursor’s own bundled Node, not to Bun.
- `npm test` syntax-checks with `node --check`.
- `node-pty` is a native addon built for Node’s ABI; `bun install` on Windows is not the path we test.

Use `npm install` and `node`. If you run the setup script under Bun it will warn and still print the rest of the checklist.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `npm run setup` says CLI not found | Step 4; new terminal after the installer |
| `agent status` not logged in | `agent login` |
| Phone cannot open `100.x:4331` | Tailscale not on both devices, or Windows Firewall (step 5) |
| Host dies when a Cursor chat ends | Auto was started in an agent background shell — use supervise / the scheduled task |
| Desktop send sits in the outbox | Cursor was started without the debug port — step 6 |
| Two Telegrams, half the messages | Two hosts polling the same bot token — only one may |
| `node-pty` failed | VS Build Tools C++; terminals optional |

Re-run `npm run setup` after each fix. The full map of how Auto behaves once it is up is [`.wiki/index.md`](../.wiki/index.md).
