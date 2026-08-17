---
type: Concept
title: Terminals
description: node-pty shells for the user and, when ACP uses them, the agent.
tags: [pty, terminals]
status: stable
sources:
  - id: terminals
    resource: /src/core/terminals.mjs
    title: Terminal registry
  - id: web
    resource: /src/web/terminals.js
    title: Terminal panes
  - id: workspace
    resource: /src/web/workspace.js
    title: View tabs
generated: { by: agent, at: 2026-08-17T18:05:00Z }
---

# Terminals

One registry, two uses:

1. ACP `terminal/*` client methods, so an agent can run commands in
   terminals we own and the user watches live.
2. User-initiated shells you can type into.

Path 1 is presently unused: Cursor's agent runs its own shells and reports
through `tool_call_update`. The registry is still there so the moment the
CLI starts calling `terminal/create`, streaming comes for free.

Default shell is PowerShell on Windows (`AUTO_SHELL` overrides). Output is
flushed on a short timer so a noisy build is not one record per byte.
Chunks go to the [transcript](transcripts.md) as `terminal_chunk`.

If `node-pty` failed to load, the web pane says so rather than pretending
a terminal exists.

On the web each shell is its own tab under the header (Chat first, then
Browser, then shells), with × to close — see [web](web.md).

## Related

- [ACP](acp.md)
- [Web](web.md)
