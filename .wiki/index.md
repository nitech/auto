# Auto

Remote control for Cursor's agent. Start at [overview](overview.md).

# Concepts

* [Sessions](concepts/sessions.md) - One conversation, desktop or ACP, with its own transcript
* [Transcripts](concepts/transcripts.md) - Append-only JSONL; clients hold no authoritative state
* [Host](concepts/host.md) - One process on 4331: HTTP, WebSocket, restart, supervisor
* [Supervise](concepts/supervise.md) - Scheduled-task watchdog; health restart; not an agent shell
* [Access](concepts/access.md) - Tailscale-only reachability, setup checklist, no Auto login
* [Cursor window](concepts/cursor-window.md) - Typing, pressing, pickers, paste, over the debug port
* [Desktop chats](concepts/desktop-chats.md) - Carry on a Cursor IDE chat from the phone
* [Desktop bridge](concepts/desktop-bridge.md) - Named-pipe send, gate, outbox
* [Desktop threads](concepts/desktop-threads.md) - Reading replies from `state.vscdb`
* [Tool lanes](concepts/tool-lanes.md) - Activity / file-change / card / hide for tool bubbles
* [ACP](concepts/acp.md) - Fallback `cursor-agent acp` sessions
* [Approvals](concepts/approvals.md) - Permissions, question cards, Created Plan, file-review bar
* [Queue](concepts/queue.md) - Messages waiting behind a turn, in Auto or in Cursor
* [Telegram](concepts/telegram.md) - Bot as a projection of the same host
* [Web](concepts/web.md) - PWA that replays the transcript, remembers the open chat, and installs to the Home Screen
* [Usage](concepts/usage.md) - Context dial for this chat, plus Cursor Models / Other Models account quotas
* [Browser](concepts/browser.md) - Headed Chrome, screencast, not recorded
* [Terminals](concepts/terminals.md) - node-pty shells for the user and the agent
* [Projects](concepts/projects.md) - Folders as Cursor itself sees them
* [Skills](concepts/skills.md) - Agent instructions, repo workflow, this wiki

# Entities

* [Auto](overview.md) - The host and its two projections
