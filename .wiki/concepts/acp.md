---
type: Concept
title: ACP
description: Fallback sessions over cursor-agent acp — JSON-RPC on stdio, resumable, Auto-owned permissions.
tags: [acp, cursor-agent]
status: stable
sources:
  - id: client
    resource: /src/acp/client.mjs
    title: ACP client
  - id: jsonrpc
    resource: /src/acp/jsonrpc.mjs
    title: JSON-RPC peer
  - id: resolve
    resource: /src/acp/resolve.mjs
    title: CLI resolver
  - id: findings
    resource: /spike/FINDINGS.md
    title: ACP probe notes
generated: { by: agent, at: 2026-08-15T09:36:00Z }
---

# ACP

When a desktop chat cannot be started, Auto spawns `cursor-agent acp`. One
child process per live session. Transport is newline-delimited JSON-RPC 2.0
on stdin/stdout (no `Content-Length` framing).

On Windows the `cursor-agent` / `agent` entry points are PowerShell shims.
Auto resolves past them to the bundled `node.exe index.js` under
`%LOCALAPPDATA%\cursor-agent\versions\` so nothing sits between us and
stdio. That `versions\` directory is hidden.

## Handshake

`initialize` advertises `loadSession`, image prompts, MCP over http/sse,
and `session/list`. `session/new` returns the session id plus the account's
modes, models, and `configOptions` — pickers are built from the protocol,
nothing is hardcoded. `session/load` resumes after a restart.

## Updates

`session/update` kinds become [transcript](transcripts.md) records via
`map-updates.mjs`. Unrecognised kinds are stored verbatim. A prompt turn
ends with `{ stopReason: "end_turn" }`.

Cursor's agent currently runs its own shells and reports through
`tool_call_update` rather than calling Auto's `terminal/*` methods, so
[terminals](terminals.md) path 1 is unused until the CLI starts using it.

## Permissions

`session/request_permission` is a client request that blocks the turn.
Auto parks it in the same broker the web and Telegram answer. See
[approvals](approvals.md).

## Related

- [Sessions](sessions.md)
- [Host](host.md)
