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
  - id: map
    resource: /src/core/map-updates.mjs
    title: session/update → transcript
generated: { by: agent, at: 2026-08-16T06:35:00Z }
---

# ACP

When a desktop chat cannot be started, Auto spawns `cursor-agent acp`. One
child process per live session. Transport is newline-delimited JSON-RPC 2.0
on stdin/stdout (no `Content-Length` framing).

On Windows the `cursor-agent` / `agent` entry points are PowerShell shims.
Auto resolves past them to the bundled `node.exe index.js` under
`%LOCALAPPDATA%\cursor-agent\versions\` so nothing sits between us and
stdio. That `versions\` directory is hidden — list it with `-Force`.

## Handshake

`initialize` advertises `loadSession`, image prompts, MCP over http/sse,
and `session/list`. `session/new` returns the session id plus the account's
modes, models, and `configOptions` — pickers are built from the protocol,
nothing is hardcoded. `session/load` resumes after a restart.

## Updates

`session/update` kinds become [transcript](transcripts.md) records via
`map-updates.mjs`. Unrecognised kinds are stored as `acp:<kind>` verbatim.
A prompt turn ends with `{ stopReason: "end_turn" }`.

Observed kinds include `agent_message_chunk`, `agent_thought_chunk`,
`tool_call` / `tool_call_update`, `session_info_update`,
`available_commands_update`. Thinking is suppressed entirely in print mode
on the CLI; Auto still records `agent_thought` when it arrives.

## Shells — plan vs reality

Auto advertises `terminal: true`, but Cursor's agent currently runs its own
shells and reports through `tool_call_update.rawOutput` rather than calling
Auto's `terminal/*` methods. Consequences:

- Agent command output arrives **complete, at completion**, not streamed
  during execution.
- The `terminal/*` handlers stay implemented — cheap, spec-compliant, may
  be used by a future CLI.
- User-initiated [terminals](terminals.md) are unaffected.

## Permissions

`session/request_permission` is a client request that blocks the turn.
Auto parks it in the same broker the web and Telegram answer. Approvals of
two minutes are fine in probing; treat transient `PING timed out` as
upstream, not as "user was too slow". See [approvals](approvals.md).

Upstream failures sometimes arrive as **agent message text** with
`stopReason: end_turn`, indistinguishable from a normal answer. The
[session](sessions.md) layer recognises shapes like `RetriableError` and
records them as errors rather than finished prose.

## Related

- [Sessions](sessions.md)
- [Host](host.md)
- [Transcripts](transcripts.md)
