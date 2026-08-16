---
type: Concept
title: Desktop bridge
description: Named-pipe send into Cursor when the debug port cannot type — gated, fragile, and re-asserted by the host.
tags: [desktop, bridge, gate, outbox]
status: stable
sources:
  - id: bridge
    resource: /src/core/desktop-bridge.mjs
    title: Desktop bridge send
  - id: gate
    resource: /src/core/desktop-bridge-gate.mjs
    title: Bridge feature gate
  - id: outbox
    resource: /src/core/desktop-outbox.mjs
    title: Held messages
  - id: script
    resource: /scripts/desktop-bridge.mjs
    title: bridge status / enable CLI
generated: { by: agent, at: 2026-08-16T06:35:00Z }
---

# Desktop bridge

The bridge hands a message to the same code that runs when you press Enter
in Cursor's composer, over a named pipe. It has no way to report what comes
back — replies are [desktop threads](desktop-threads.md). Prefer the
[Cursor window](cursor-window.md) over the debug port when it answers;
the bridge can shut itself mid-session.

## Gate

A server-side feature flag (`desktop_bridge`) and a Settings → Beta toggle
must both be on. `npm run bridge:enable` (Cursor closed) sets the local
overrides. **It does not stay on by itself** — Cursor refreshes server
config and wipes the dev-override flag, often within minutes, and only
reads that flag at startup. The [host](host.md) re-asserts the switches
once a minute, writing only what was cleared, and only if the Beta toggle
is on. By hand: `node scripts/desktop-bridge.mjs ensure`.

## Outbox

When the window and the bridge both refuse, the text is parked in order and
retried until the desktop accepts it (`submitted` or `queued`). Dropping a
message typed on a phone is the worst possible answer. The outbox holds
**words only** — images have to be sent again via the window paste path.

## Diagnose

`npm run bridge` reports each switch and how many instances answer.

| Observation | Meaning |
| --- | --- |
| Switches on, no instances | Cursor needs restarting |
| `dev override allowed: false` | Host should fix within a minute |
| Instances but send fails | No window has that thread |
| Send works, nothing comes back | Reading half — see [threads](desktop-threads.md) |

`npm test` covers discovery, send guards, switches, and reading against a
stand-in database — never the real Cursor.

## Related

- [Desktop chats](desktop-chats.md)
- [Cursor window](cursor-window.md)
- [Desktop threads](desktop-threads.md)
