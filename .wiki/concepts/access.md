---
type: Concept
title: Access and config
description: Tailscale-only reachability, no Auto login, and the optional .env knobs.
tags: [access, tailscale, config, env]
status: stable
sources:
  - id: env
    resource: /.env.example
    title: Optional environment
  - id: readme
    resource: /README.md
    title: Run instructions
generated: { by: agent, at: 2026-08-16T06:35:00Z }
---

# Access and config

Access control is **Tailscale**. Auto has no login of its own. Open
`http://<tailscale-ip>:4331/` (or whatever `AUTO_WEB_URL` is). Do not expose
the port to the open internet.

Credentials for Telegram come from `TELEGRAM_BOT_TOKEN` /
`TELEGRAM_CHAT_ID`, or the `auth.json` the telegram-notify skill writes.
Everything in `.env` is optional — copy `.env.example` when you want to set
something explicitly.

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

## Related

- [Host](host.md)
- [Overview](../overview.md)
