# Security

Auto is a remote control for a logged-in Cursor on your machine. It has no
accounts of its own.

- Reach it only over Tailscale (or another private network). Do not expose
  port 4331 to the public internet, and do not enable Tailscale Funnel/Serve
  on that port.
- Default `AUTO_POLICY=auto` approves agent tool calls without asking.
- `TELEGRAM_CHAT_ID` is an allowlist. A bot token without a chat id is an
  open inbox.

Report vulnerabilities privately (GitHub Security Advisories on this repo,
or contact the maintainer). Please do not file a public issue that includes
a working reachability bypass.
