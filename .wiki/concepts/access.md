---
type: Concept
title: Access and config
description: Tailscale-only reachability, no Auto login, setup checklist, and the optional .env knobs.
tags: [access, tailscale, config, env]
status: stable
sources:
  - id: env
    resource: /.env.example
    title: Optional environment
  - id: setup
    resource: /scripts/setup.mjs
    title: First-run checklist
  - id: install
    resource: /docs/install.md
    title: Human install tutorial
  - id: readme
    resource: /README.md
    title: Run instructions
generated: { by: agent, at: 2026-08-17T10:35:00Z }
---

# Access and config

Access control is **Tailscale**. Auto has no login of its own. Open
`http://<tailscale-ip>:4331/` (or whatever `AUTO_WEB_URL` is). Do not expose
the port to the open internet, and do not enable Tailscale Funnel or Serve
on 4331.

The human walkthrough — what Tailscale is, CLI install, debug port, Telegram —
is [docs/install.md](../../docs/install.md). `npm install` runs
`scripts/setup.mjs --postinstall` (never fails the install). `npm run setup`
is the same checklist and exits 1 when the Cursor agent CLI is missing **or
not logged in**. The login row requires `Logged in as …` from `agent status`;
`Not logged in` is a fail (it contains the words "logged in", which used to
pass). Without that login, ACP start fails with `Authentication required` and
the model picker stays empty.

Credentials for Telegram come from `TELEGRAM_BOT_TOKEN` /
`TELEGRAM_CHAT_ID`, or the `auth.json` the telegram-notify skill writes.
`TELEGRAM_CHAT_ID` is an allowlist. Everything in `.env` is optional — the
setup script copies `.env.example` when `.env` is missing.

Default `AUTO_POLICY=auto` approves tool calls without asking. That is a
machine-wide remote control, not a product with accounts.

## Knobs that matter

| Variable | Default | Meaning |
| --- | --- | --- |
| `AUTO_PORT` | `4331` | Host listen port |
| `AUTO_POLICY` | `auto` | Default permission policy for new sessions |
| `AUTO_WEB_URL` | (unset) | What Telegram `/web` shows |
| `AUTO_TELEGRAM` | on | Set `0` to disable the poller |
| `AUTO_SHELL` | `powershell.exe` on Windows | Shell for [terminals](terminals.md) |
| `AUTO_BROWSER_HEADLESS` | off | Headed Chrome trips fewer bot checks |

## One Telegram poller

A bot token allows **one** poller. A second host with the token splits
messages at random. Develop with `npm run dev` (port **4340**, Telegram
off). See [Telegram](telegram.md) and [supervise](supervise.md).

The supported runtime is **Node 20+** via npm. Bun can import `node-pty`
but the [supervisor](supervise.md) and scheduled task execute `node`.

## Related

- [Host](host.md)
- [Overview](../overview.md)
