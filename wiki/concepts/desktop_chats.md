# Continuing Cursor desktop chats

Auto can pick up a chat you started in the Cursor desktop app and carry it on
from the phone — the same chat, not a copy of it. Send from Telegram and the
message appears in the IDE's own thread; reply in the IDE and it appears on
the phone. This note records how, because it leans on Cursor's internals
rather than on any published interface, and that can change under us.

## Starting a chat from Auto

A session started from the web or from Telegram is a new chat in Cursor, not a
separate `cursor-agent` process. Auto presses the control labelled **New Agent**
in a window that already has that folder open, waits for the window to show a
new thread id, and attaches to it. The same conversation is then on the phone
and in the IDE.

If no window has the folder, Auto asks the running Cursor for a new window
(`--new-window`). If Cursor is not running at all, Auto starts it with
`--remote-debugging-port=9222` so the window is born reachable. If Cursor is
already running *without* that port, a second launch cannot add it — Electron
hands the folder to the existing process and exits — so Auto quits Cursor and
starts it again. That closes every window. It is the only way a new session
can appear in the IDE.

If none of that works, Auto falls back to an ACP session and writes a notice
saying why it is only in Auto.

## The two halves

Cursor ships a **desktop bridge**: a small HTTP server the main process runs
over a named pipe, which hands a message to the same code that runs when you
press enter in the composer. That carries messages *into* the IDE. It has no
way to report what comes back, so the other half is reading the desktop's own
database, which it writes as a thread progresses.

| | Into the IDE | Back out |
| --- | --- | --- |
| Mechanism | bridge over a named pipe | polling `state.vscdb` |
| Code | `src/core/desktop-bridge.mjs` | `src/core/desktop-threads.mjs` |
| Latency | immediate | under a second during a turn |

## Turning the bridge on

The bridge is finished code, but gated: a server-side feature gate
(`desktop_bridge`) and a Settings → Beta toggle must both be on. Cursor
consults a local override store before asking the server, so both can be set
here — the same rows its own developer override UI writes. `npm run
bridge:enable`, with Cursor closed, sets four values in `ItemTable`:

| Key | Why |
| --- | --- |
| `workbench.experiments.featureFlagOverrides` | turns the gate on locally |
| `cursorai/serverConfig` → `isDev…SpoofedByUsers` | permits overrides at all |
| `cursor/desktopBridgeUserEnabled` | the Beta toggle |
| `cursor.desktopBridge.enabled` | the copy the main process reads at startup |

The values as they were before any of this are saved to
`state/desktop-bridge.backup.json`, and `npm run bridge:disable` puts them
back. Both refuse to run while Cursor is open, because it holds this storage
in memory and would write over the rows when it exits.

**It does not stay on by itself.** Cursor refreshes its server config from the
network and that wipes the dev-override flag — observed clearing within
minutes — and it only reads that flag at startup. Left alone the bridge works
until the next restart and then silently stops. So the host re-asserts the
switches once a minute, writing only what was cleared, and only if the Beta
toggle is on: a gate we never set is not ours to turn on. By hand that is
`node scripts/desktop-bridge.mjs ensure`.

Once running, Cursor writes a discovery file per window to
`~/.cursor/desktop-bridge/<hash>.json` giving the pipe path and a bearer
token. Auto ignores files whose protocol version it does not know or whose
process is gone.

## Finding and reading a thread

`composerHeaders` holds one row per chat with `workspaceId`, timestamps and a
JSON `value` carrying the name and subtitle. A folder's `workspaceId` is the
directory name under `%APPDATA%\Cursor\User\workspaceStorage` whose
`workspace.json` points at that folder, which is how Auto shows a project's
chats. Rows with `isSubagent` or `isArchived` set are left out.

A thread's messages are `cursorDiskKV` rows: `composerData:<threadId>` holds
`fullConversationHeadersOnly`, the bubble ids in order, and each
`bubbleId:<threadId>:<bubbleId>` is one message. Type 1 is you; type 2 is the
agent, carrying either `text`, a `thinking` block, or `toolFormerData` for a
tool call.

Every tool bubble is recorded. The web and Telegram then follow Cursor's own
lanes rather than printing each one as a named step: reads and searches fold
into an activity group, edits sit on a file-change row with the path and a
+/- count (and the diff Cursor already stored, when it is there), and a few
internal tools stay off the stream entirely. `create_plan` is the exception
that stays a card: Auto draws Cursor's Created Plan (title, overview, View
Plan, Build with a model), and Build presses the button on that bubble.

## Things learned the hard way

- **Assistant text is written whole, not as it streams.** A 900-character
  answer went from absent to complete in one step. So a thread advances a
  message at a time, and the most Auto can honestly show meanwhile is that
  the agent is working.
- **A turn in flight is `chatGenerationUUID`, not `status`.** The stored
  status said `aborted` during a perfectly healthy turn. The generation id is
  the reliable signal.
- **The generation id clears before the last message lands.** Announce the end
  of a turn the moment it clears and the transcript puts the end above the
  answer. The watcher waits one more pass before calling a turn over.
- **Your own message comes back to you.** It is written to the transcript when
  sent *and* stored by the desktop as a bubble. Auto remembers what it sent
  briefly and shows it once; unmatched entries expire, because a duplicate is
  a smaller sin than swallowing something you typed later.
- **Bubbles appear before they are filled.** An empty bubble is one the IDE has
  created but not written yet, so it is left unread rather than reported as an
  empty message.
- **Values come back in two shapes.** `cursorDiskKV` rows are sometimes raw
  bytes and sometimes text; read `typeof(value)` rather than assuming.

## What the desktop keeps

A desktop session is a session like any other in Auto's rail, marked *in
Cursor*, but the IDE owns it:

- **The name** is the desktop's. A new chat shows as *Desktop chat* until
  Cursor names it after the first exchange; Auto then takes that name unless
  you renamed it here.
- **Model and mode** are set there, not here.
- **Stopping a turn** is the IDE's button; the bridge sends but cannot
  interrupt.
- **Approvals** appear in the IDE. A desktop thread waiting on a permission
  prompt will sit there until someone answers it on the machine.
- **Images** are not carried; the bridge takes text.

Sending needs a Cursor window that has the thread — its workspace open. If
none does, the bridge answers `unknown-thread` and Auto says which folder to
open.

## What does not work

- **`session/list` over ACP** returns only sessions the CLI itself has. Desktop
  chats are not in it.
- **`agent --resume <id>`** with a desktop chat id quietly creates an empty
  chat under that id, which looks like success until the agent tells you the
  conversation is new.
- **Copying the conversation.** Auto used to import a chat by copying its
  content-addressed blobs into an ACP session of its own. It worked, and the
  agent recalled the history, but it branched: the IDE knew nothing about what
  happened afterwards. That path is gone.

## If it breaks

Run `npm run bridge`. It reports each switch and how many instances answer.

- *Switches on, no instances*: Cursor needs restarting, or was started before
  the switches were set.
- *`dev override allowed: false`*: the config refresh got there first; the host
  should fix it within a minute, or run `bridge:ensure`.
- *Instances, but sending fails*: no window has that thread — open its folder.
- *Messages send but nothing comes back*: the reading half. Check that
  `composerData:<threadId>` still holds `fullConversationHeadersOnly` and that
  bubbles are still at `bubbleId:<threadId>:<bubbleId>`.

`npm test` covers discovery, the send guards, the switches, and reading and
following a thread against a stand-in database — never the real Cursor.
