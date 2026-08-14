# Auto

Auto is a remote control for Cursor's agent, running at D:\Sevenfold\auto on
port 4331. It drives `cursor-agent` sessions on this machine and exposes them
through a web app (PWA) and a Telegram bot.

## Responsibilities
- Run agent sessions: new ones start as chats in the Cursor desktop app.
  Auto opens or starts a Cursor window for that folder when it has to, with
  the debug port if Cursor was not already listening. Otherwise over ACP
  (JSON-RPC to `cursor-agent acp`), one child process per session, resumable
  across restarts
- Record everything the agent emits — prose, thinking, tool calls, tool
  results, diffs, plans, terminal output, errors — to append-only transcripts
- Broker approvals (ask / ask-on-write / auto) answerable from web or Telegram
- Broker question cards from a desktop chat, answerable from web or Telegram
  by pressing the chosen option in Cursor
- Broker Created Plan cards from a desktop chat — view the markdown, pick a
  model, and press Build in Cursor
- Host real PTY terminals for the agent and for the user
- Host a Chrome instance the user can drive by hand from a phone
- Serve the web app and a WebSocket that replays transcripts from a sequence
  number, so a reload loses nothing

## Design rules
- The host owns state; web and Telegram are projections with no authority
- The transcript is the source of truth, not the socket
- Unknown ACP updates are recorded rather than dropped
- Browser frames are the one thing deliberately not persisted

## Key modules
- src/server/index.mjs — HTTP, WebSocket, session API, static web app
- src/acp/ — process resolution, JSON-RPC peer, ACP client
- src/core/sessions.mjs — session registry, lifecycle, resume
- src/core/transcript.mjs — append-only JSONL with monotonic sequence numbers
- src/core/permissions.mjs — approval broker and policies
- src/core/terminals.mjs — node-pty registry
- src/core/browser.mjs — Chrome over CDP, screencast and input
- src/core/telegram.mjs — Telegram control surface
- scripts/supervise.mjs — restart and health watchdog

## Related
- Agent workflow and restart rules: AGENTS.md
- Skills: .claude/skills/{auto-doctor,auto-restart,switch-repo}
- llm-wiki hosts this knowledge base under wiki/
