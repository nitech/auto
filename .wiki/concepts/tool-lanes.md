---
type: Concept
title: Tool lanes
description: How desktop tool bubbles become activity lines, file-change rows, cards — or stay hidden.
tags: [tools, lanes, ui, mcp]
status: stable
sources:
  - id: tools
    resource: /src/web/desktop-tool-ui.js
    title: Lane table (shared)
  - id: core
    resource: /src/core/desktop-tool-ui.mjs
    title: Node re-export for Telegram
generated: { by: agent, at: 2026-08-16T06:35:00Z }
---

# Tool lanes

Every tool bubble from a [desktop thread](desktop-threads.md) is recorded
in the [transcript](transcripts.md). Projections then classify it the way
Cursor groups steps in the IDE. The table lives in `desktop-tool-ui.js` so
the [web](web.md) and [Telegram](telegram.md) share one copy
(`desktop-tool-ui.mjs` re-exports it for Node).

## Lanes

| Lane | What the phone shows |
| --- | --- |
| `hide` | Nothing — Cursor draws nothing either |
| `group` | Folded into a quiet activity line ("N files, M searches") |
| `fileChange` | A path and a +/- count on the file-change row |
| `card` | A named step: command, question, Created Plan, other |

`create_plan` stays a card. `ask_question` is hidden from the OTHER lane —
the Question card is the real UI. See [approvals](approvals.md).

## Hidden MCP placeholders

Unnamed MCP placeholders arrive as `mcp--` / `tool`, or as `MCP: tool`
once the halves join. The IDE draws nothing for them; Auto used to show an
OTHER card and must not.

## Diffs

Edit results that carry a patch become `diff` transcript records and render
as diffs on the web. They are not a separate Auto subsystem — they ride the
file-change / tool-update path.

## Related

- [Desktop threads](desktop-threads.md)
- [Web](web.md)
- [Telegram](telegram.md)
- [Approvals](approvals.md)
