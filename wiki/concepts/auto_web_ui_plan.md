# Auto Web UI — improvement plan

Follow-up to the 2026-08-10 UI review (w-191). Security (bind/auth hardening,
item 5 of that review) is deliberately excluded — tracked separately.

## Already shipped (2026-08-10, worker w-195)
- Deduped `afterFileEdit`/`afterShellExecution` hook events in
  `hooks/cursor-debug-feed.mjs` — they fired <1s after `postToolUse` for the
  same Edit/Write/Shell call with no new info, doubling every file op into
  two bubbles.
- All message lists (session view, worker-detail view) now render
  chronologically oldest-on-top/newest-at-bottom, consistently. Session view
  previously did newest-on-top, which was the odd one out.
- New messages smooth-scroll the log into view instead of popping in
  (skipped when the user has scrolled up to read history and the message
  isn't their own).
- Tool-call/shell-command bubbles show the full text (tap-to-expand past the
  320-char clamp) instead of a hard 140-char truncation — makes worker-detail
  a genuine raw-output view.
- Added a paper-plane send button, bottom-right of the composer.

## 1. Tool-call bubbles still can't show diffs/output
What shipped above stops truncating the *summary line* (tool + path +
command), but the underlying hook payload (`hooks/cursor-debug-feed.mjs`)
never captures the actual diff or command stdout/stderr — that data doesn't
reach `/api/event` at all today. To close the rest of this gap:
- Extend the hook payload capture (`summarize()` in cursor-debug-feed.mjs) to
  include a bounded diff/output snippet where the Cursor hook exposes one
  (`payload.diff`, `payload.result`, `payload.output`, etc. — needs checking
  what the hook actually receives for PostToolUse).
- Add an `output`/`diff` field to logged events and render it in the compact
  bubble's expand panel (reuse the clamp/expand UI already in place).
- Cap stored size per event (e.g. 4-8 KB) to avoid bloating events.jsonl.

## 2. No worker control (cancel/kill from the UI)
- Add `POST /api/worker/:id/kill` on debug-server.mjs that forwards to
  main-agent's worker registry (main-agent.mjs owns the child processes —
  check how it tracks worker PIDs today) and marks the worker `phase: 'error'`
  / `'killed'` on success.
- Add a kill button in the worker-detail header (`showWorkerDetail`), visible
  only while `phase` is active (not `done`/`error`).
- Confirm before killing (destructive, mid-flight work is lost).

## 3. Session switcher won't scale
- Replace the horizontally-scrolling tab row with a searchable dropdown once
  session count passes some threshold (e.g. >6) — keep the pill row for small
  counts since it's more glanceable.
- Filter-as-you-type on label/folder; keep token count visible per row.
- Keep the Workers tab pinned/separate from the searchable list.

## 4. No log search/filter
- Add a search input above `#log` (or in the header) that filters currently
  rendered bubbles by text/tool/path substring, client-side against events
  already fetched — no new API needed for a first pass.
- Add quick-filter chips for event kind: tool calls / shell / messages only /
  errors.
- For sessions with long history beyond the 800-event `/api/events` cap,
  consider a server-side search endpoint later; not needed for v1.

## 6. Minor polish
- Theme toggle (currently hardcoded dark) — low priority, dark-only is fine
  for a personal debug console; revisit if requested again.
- Per-worker elapsed time / cost: `agentsSnapshot.workers[].startedAt` already
  exists — compute elapsed client-side with a ticking interval; cost needs
  token totals per worker, which aren't tracked yet (tokens are currently
  session-scoped only in `state.sessions[id].tokens`).
- Error retry action: `sys` bubbles for `auto: send failed` / `main-agent
  error` currently have no retry affordance — add a small "retry" link that
  resubmits the same job payload to `/api/chat` or `/job`.

## Suggested order
3 and 4 are independent and can land anytime. 1 (diff capture) and 2 (kill)
both touch main-agent.mjs/worker-agent.mjs process management and are more
invasive — worth doing together since both need a clearer picture of how
main-agent tracks worker child processes. 6 is cleanup, do last or on demand.
