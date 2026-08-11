# M0 spike results — `cursor-agent acp`

Probed with `node spike/acp-probe.mjs` against Cursor CLI `2026.08.04-aaa8809`
on 2026-08-11. **Verdict: GO — build the full ACP plan.**

## Launching

The `cursor-agent` / `agent` entry points on Windows are PowerShell shims. The
real process is:

```
%LOCALAPPDATA%\cursor-agent\versions\<version>\node.exe
%LOCALAPPDATA%\cursor-agent\versions\<version>\index.js acp
```

Spawn that directly — going through `cursor-agent.cmd` adds a PowerShell layer
between us and the agent's stdio, which we do not want on the protocol path.
Note the `versions\` directory is hidden, so `Get-ChildItem` needs `-Force`.

Transport is newline-delimited JSON-RPC 2.0 on stdin/stdout (no `Content-Length`
framing).

## `initialize` response

```json
{
  "protocolVersion": 1,
  "agentCapabilities": {
    "loadSession": true,
    "mcpCapabilities": { "http": true, "sse": true },
    "promptCapabilities": { "audio": false, "embeddedContext": false, "image": true },
    "sessionCapabilities": { "list": {} }
  },
  "authMethods": [{ "id": "cursor_login", "name": "Cursor Login" }]
}
```

- `loadSession: true` — sessions are resumable, so session state survives
  restarts.
- `image: true` — images can be sent in prompts, so Telegram photos work.
- `sessionCapabilities.list` — the agent can enumerate its own sessions.
- MCP over http and sse is supported.

## `session/new` response

Returns far more than a session id:

- `sessionId`
- `modes` — `agent`, `plan`, `ask`, with `currentModeId`
- `models` — the full account model list (`claude-opus-5`, `gpt-5.6-sol`,
  `gemini-3.6-flash`, `kimi-k3`, `glm-5.2`, … 33 entries) with `currentModelId`
- `configOptions` — the same mode/model choices as declarative select widgets

The renderer's mode and model pickers can therefore be built entirely from the
protocol; nothing needs hardcoding.

## Prompt turn — observed `session/update` kinds

| Kind | Notes |
|------|-------|
| `session_info_update` | Auto-generated session title, e.g. `"Shell Command Echo"` |
| `available_commands_update` | Slash commands available in the session |
| `agent_thought_chunk` | **Thinking, streamed.** Suppressed entirely in print mode |
| `agent_message_chunk` | Token-level assistant text |
| `tool_call` | `toolCallId`, `title`, `kind` (`execute`, …), `status`, `rawInput` |
| `tool_call_update` | Status transitions plus `rawOutput` |

`session/prompt` resolves with `{ "stopReason": "end_turn" }`.

## Permissions

`session/request_permission` **is** issued as a client request before a shell
command runs, carrying the full `toolCall`. Real approve/deny round-trips work.
The probe auto-allowed and the command then executed.

## Shell output

For `echo hello-from-acp` the completing `tool_call_update` carried:

```json
{ "rawOutput": { "exitCode": 0, "stdout": "hello-from-acp\r\n", "stderr": "" } }
```

Complete stdout and exit code, no truncation.

## Deviation from the plan's assumption

The plan assumed Auto would host agent shells via the ACP `terminal/*` methods.
**It does not happen.** We advertised `terminal: true` and Cursor's agent still
ran the command internally, reporting through `tool_call_update.rawOutput`
instead.

Consequences:

- Agent command output arrives **complete, at completion** rather than streaming
  during execution. Fine for short commands; needs a follow-up check with a
  long-running one (e.g. `npm test`) to see how a slow build feels.
- The `terminal/*` client handlers should still be implemented — they are cheap,
  spec-compliant, and may be exercised by future CLI versions.
- User-initiated terminals are unaffected and still need our own PTY.

## Permission latency tolerance

Measured by holding the approval before answering (`ws-smoke.mjs --delay=N`):

| Approval delay | Result |
|----------------|--------|
| instant | turn completes, 12s total |
| 20s | turn completes |
| 120s | turn completes |

A two-minute approval is fine, so a phone user can take their time. An early
run did die with `RetriableError: [unavailable] PING timed out` after a slow
approval, but the delay was not the cause — it did not reproduce at 120s. Treat
it as a transient upstream failure.

That failure is still instructive: the error arrived as **agent message text**
and ended the turn with `stopReason: end_turn`, indistinguishable from a normal
answer. The session layer needs to detect upstream errors and record them as
errors rather than assistant prose, and should offer a retry.

## Not yet exercised

`fs/read_text_file` and `fs/write_text_file` (the agent appears to do its own
file IO), `session/load` round-trip, `session/cancel`, image prompts, and
MCP server passthrough.
