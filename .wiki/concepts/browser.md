---
type: Concept
title: Browser
description: A real Chrome on this machine, driven from the phone; frames are live-only.
tags: [browser, cdp, screencast]
status: stable
sources:
  - id: browser
    resource: /src/core/browser.mjs
    title: Browser host
  - id: web
    resource: /src/web/browser.js
    title: Browser pane
generated: { by: agent, at: 2026-08-15T09:36:00Z }
---

# Browser

One Chrome (or Edge) for the whole host, driven over CDP with the `ws`
package Auto already depends on. Frames stream out as JPEG screencast; taps
and keystrokes come back as input. The profile is
`state/browser-profile`, so logins stick — which is the point of running
the browser on this machine instead of in a container.

Frames are **never** written to a transcript. Nobody watching means nothing
to encode: screencast stops when the last client detaches.

Headed by default, parked off-screen; `AUTO_BROWSER_HEADLESS=1` is there
and trips more bot checks. Address bar: a URL is opened, anything else is
searched (DuckDuckGo). `localhost` becomes `http://`.

## Related

- [Host](host.md)
- [Web](web.md)
