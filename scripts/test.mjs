#!/usr/bin/env node
/**
 * Smoke test for Auto — no changes should ship without this passing.
 *
 *   npm test
 *
 * Checks:
 *   1. Every .mjs script under scripts/ and src/ parses (node --check).
 *   1b–1f. Core behaviour: transcripts, permissions, terminals, diffs,
 *          the browser address bar, and Telegram rendering.
 *   2. The Cursor agent CLI resolves — nothing works without it.
 *   2b. Every skill under .claude/skills/ has valid SKILL.md frontmatter.
 *   3. If the host is running, its health and session API answer.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let failed = false;
function fail(msg) {
  failed = true;
  console.error(`FAIL: ${msg}`);
}
function ok(msg) {
  console.log(`ok: ${msg}`);
}

// 1. Syntax-check every script.
const files = readdirSync(HERE).filter((f) => f.endsWith('.mjs'));
for (const f of files) {
  const res = spawnSync(process.execPath, ['--check', join(HERE, f)], {
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    fail(`node --check ${f}\n${res.stderr}`);
  } else {
    ok(`syntax: ${f}`);
  }
}

// 1a. Syntax-check the v2 tree.
const SRC = join(ROOT, 'src');
if (existsSync(SRC)) {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      return e.name.endsWith('.mjs') ? [p] : [];
    });
  for (const p of walk(SRC)) {
    const res = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' });
    const rel = relative(ROOT, p);
    if (res.status !== 0) fail(`node --check ${rel}\n${res.stderr}`);
    else ok(`syntax: ${rel}`);
  }
}

// 1b. v2 core behaviour. Pure logic only — no agent process, no network.
if (existsSync(SRC)) {
  const tmp = mkdtempSync(join(tmpdir(), 'auto-test-'));
  try {
    const { Transcript, KIND } = await import('../src/core/transcript.mjs');
    const { mapUpdate } = await import('../src/core/map-updates.mjs');

    const t = await new Transcript(tmp, 'sess-1').open();
    t.append(KIND.userMessage, { text: 'one' });
    t.append(KIND.agentDelta, { text: 'two' });
    const third = t.append(KIND.turnEnd, { stopReason: 'end_turn' });

    if (third.seq !== 3) fail(`transcript seq should be 3, got ${third.seq}`);
    if (t.readFrom(0).length !== 3) fail('transcript readFrom(0) should return 3 records');
    if (t.readFrom(2).length !== 1) fail('transcript readFrom(2) should return 1 record');

    // Reopening must continue the sequence rather than restart it.
    const again = await new Transcript(tmp, 'sess-1').open();
    if (again.seq !== 3) fail(`reopened transcript seq should be 3, got ${again.seq}`);
    if (again.append(KIND.userMessage, {}).seq !== 4) fail('reopened transcript should append at 4');

    const delta = mapUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hi' },
    });
    if (delta?.kind !== KIND.agentDelta || delta.payload.text !== 'hi') {
      fail(`mapUpdate agent_message_chunk wrong: ${JSON.stringify(delta)}`);
    }
    const call = mapUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'c1',
      kind: 'execute',
      rawInput: { command: 'ls' },
    });
    if (call?.kind !== KIND.toolCall || call.payload.rawInput.command !== 'ls') {
      fail(`mapUpdate tool_call wrong: ${JSON.stringify(call)}`);
    }
    // Unknown kinds must be preserved, never dropped.
    const unknown = mapUpdate({ sessionUpdate: 'something_new', a: 1 });
    if (!unknown || !unknown.kind.startsWith('acp:') || !unknown.payload.raw) {
      fail('mapUpdate should preserve unknown update kinds');
    }

    if (!failed) ok('v2 core: transcript replay + update mapping');
  } catch (e) {
    fail(`v2 core: ${e.message}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  // Desktop outbox: a refused message waits its turn instead of being lost.
  try {
    const { DesktopOutbox } = await import('../src/core/desktop-outbox.mjs');

    let bridge = 'shut';
    const tried = [];
    const outbox = new DesktopOutbox({
      retryMs: 10,
      send: async (_id, text) => {
        tried.push(text);
        return bridge === 'shut'
          ? { status: 'error', message: 'Desktop bridge is disabled.' }
          : { status: 'submitted' };
      },
    });

    outbox.hold('s', 'first');
    outbox.hold('s', 'second');
    if (outbox.queued('s') !== 2) fail(`outbox should hold 2, got ${outbox.queued('s')}`);
    if ((await outbox.flush()) !== 0) fail('a shut bridge should deliver nothing');
    if (outbox.queued('s') !== 2) fail('a failed flush must keep everything queued');
    // One attempt per flush per session: the queue behind a stuck message waits.
    if (tried.length !== 1) fail(`a shut bridge should be asked once, was ${tried.length}`);

    const sent = [];
    outbox.on('sent', (e) => sent.push(e.text));
    bridge = 'open';
    if ((await outbox.flush()) !== 2) fail('an open bridge should deliver both');
    if (sent.join(',') !== 'first,second') fail(`order not kept: ${sent.join(',')}`);
    if (outbox.queued('s') !== 0) fail('delivered messages should leave the queue');

    // What survives a host restart is what was written to the registry.
    const saved = [{ text: 'held', at: Date.now() - 60_000 }];
    const revived = new DesktopOutbox({ retryMs: 10, send: async () => ({ status: 'submitted' }) });
    revived.restore('s', saved);
    if (revived.queued('s') !== 1) fail('restore should take back a saved queue');
    if ((await revived.flush()) !== 1) fail('a restored message should still go');
    outbox.stop();
    revived.stop();

    if (!failed) ok('v2 core: desktop outbox holds, keeps order, and drains');
  } catch (e) {
    fail(`v2 outbox: ${e.message}`);
  }

  // Typing into Cursor's own window: the transport that no feature switch can
  // shut. It must land in the right chat, never overwrite someone's half-typed
  // message, and never leave text behind when it fails.
  try {
    const { CursorCdp } = await import('../src/core/cursor-cdp.mjs');
    const { samePath } = await import('../src/core/cursor-dom.mjs');

    class FakeWindow {
      constructor(facts, { submits = true, focusable = true, controls = [], stopsOn = 'keyboard', generating = false } = {}) {
        this.given = facts;
        this.box = facts.composerText || '';
        this.submits = submits;
        this.focusable = focusable;
        this.controls = controls;
        this.stopsOn = stopsOn;
        this.generating = generating;
        this.pressed = [];
        this.sent = null;
        this.closed = false;
      }
      async facts() {
        return { ...this.given, composerText: this.box };
      }
      async actions() {
        return { generating: this.generating, controls: this.controls };
      }
      async click(name) {
        const named = (c) => c.label || c.text;
        const matches = this.controls.filter(
          (c) => named(c).toLowerCase() === String(name).toLowerCase() && !c.disabled,
        );
        if (!matches.length) return { clicked: false, reason: 'no control says that' };
        const target = matches[matches.length - 1];
        this.pressed.push(named(target));
        return { clicked: true, name: named(target), where: target.where, of: matches.length };
      }
      async stopTurn() {
        this.pressed.push('«keyboard»');
        if (this.stopsOn === 'keyboard') this.generating = false;
      }
      async clickStopIcon() {
        this.pressed.push('«stop icon»');
        if (this.stopsOn === 'button') this.generating = false;
        return true;
      }
      async focusComposer() {
        return this.focusable;
      }
      async composerText() {
        return this.box;
      }
      async insertText(text) {
        this.box += text;
      }
      async pressEnter() {
        if (!this.submits) return;
        this.sent = this.box;
        this.box = '';
      }
      async clearComposer() {
        this.box = '';
      }
      close() {
        this.closed = true;
      }
    }

    const THREAD = '645a0202-ac6e-4a33-b9c1-472acaf4e4cc';
    const OTHER = '4e9abaeb-7716-4f4d-a976-18ec10061759';
    const target = (id) => ({ id, type: 'page', url: `file:///workbench.html?${id}`, title: id });

    /** A machine with these windows open, and nothing else. */
    const machine = (windows, { owner } = {}) =>
      new CursorCdp({
        settleMs: 1,
        listTargets: async () => Object.keys(windows).map(target),
        openWindow: async (t) => windows[t.id],
        owner: owner || (() => null),
      });

    // The message goes into the window showing that chat, and no other.
    const mine = new FakeWindow({ threadId: THREAD, hasComposer: true });
    const theirs = new FakeWindow({ threadId: OTHER, hasComposer: true });
    let result = await machine({ theirs, mine }).sendText({ threadId: THREAD, text: 'hello' });
    if (result.status !== 'submitted') fail(`cdp send should submit, got ${JSON.stringify(result)}`);
    if (mine.sent !== 'hello') fail(`cdp send typed "${mine.sent}" into the right window`);
    if (theirs.sent !== null) fail('cdp send must not touch another chat');
    if (!mine.closed || !theirs.closed) fail('cdp send should close every window it opened');

    // No window has the chat open: the caller must fall back, not be told yes.
    result = await machine({ theirs }).sendText({ threadId: THREAD, text: 'hello' });
    if (result.status !== 'unknown-thread') fail(`cdp send should not claim a chat it cannot see: ${result.status}`);

    // A message someone is still writing is theirs; leave it alone.
    const busy = new FakeWindow({ threadId: THREAD, hasComposer: true, composerText: 'half a thou' });
    result = await machine({ busy }).sendText({ threadId: THREAD, text: 'hello' });
    if (result.status !== 'not-sendable') fail('cdp send should refuse a box with text in it');
    if (busy.box !== 'half a thou') fail(`cdp send overwrote what was being typed: "${busy.box}"`);

    // If Enter will not send, the box must be left as it was found.
    const stuck = new FakeWindow({ threadId: THREAD, hasComposer: true }, { submits: false });
    result = await machine({ stuck }).sendText({ threadId: THREAD, text: 'hello' });
    if (result.status !== 'not-sendable') fail('cdp send should report a box that will not send');
    if (stuck.box !== '') fail(`cdp send left "${stuck.box}" behind in the chat box`);

    // A window with no chat box at all, and one that will not take the caret.
    const bare = new FakeWindow({ threadId: THREAD, hasComposer: false });
    if ((await machine({ bare }).sendText({ threadId: THREAD, text: 'x' })).status !== 'not-sendable') {
      fail('cdp send should refuse a window with no chat box');
    }
    const numb = new FakeWindow({ threadId: THREAD, hasComposer: true }, { focusable: false });
    if ((await machine({ numb }).sendText({ threadId: THREAD, text: 'x' })).status !== 'not-sendable') {
      fail('cdp send should refuse a box that will not focus');
    }

    // When a window will not say which chat it shows, the messages on screen
    // are looked up instead — and an unknown answer sends nothing.
    const quiet = new FakeWindow({
      threadId: null,
      hasComposer: true,
      rows: [{ id: 'b1' }, { id: 'b2' }],
    });
    result = await machine({ quiet }, { owner: () => THREAD }).sendText({
      threadId: THREAD,
      text: 'by bubble',
    });
    if (result.status !== 'submitted') fail(`cdp send should identify a chat by its messages: ${result.status}`);
    if (quiet.sent !== 'by bubble') fail('cdp send should type after identifying by messages');

    const nameless = new FakeWindow({ threadId: null, hasComposer: true, rows: [{ id: 'b1' }] });
    if ((await machine({ nameless }).sendText({ threadId: THREAD, text: 'x' })).status !== 'unknown-thread') {
      fail('cdp send must not guess which chat a window is showing');
    }

    // Cursor started without its debugging port: say so, do not throw.
    const shut = new CursorCdp({ listTargets: async () => [] });
    if ((await shut.sendText({ threadId: THREAD, text: 'x' })).status !== 'no-cdp') {
      fail('cdp send should report a missing debug port as no-cdp');
    }
    if (await shut.available()) fail('cdp should not claim to be available with no windows');
    const broken = new CursorCdp({
      listTargets: async () => {
        throw new Error('connection refused');
      },
    });
    if ((await broken.sendText({ threadId: THREAD, text: 'x' })).status !== 'no-cdp') {
      fail('a refused debug port should be no-cdp, not an exception');
    }

    // Cursor says /d:/Sevenfold/auto where Auto says D:\Sevenfold\auto.
    if (!samePath('/d:/Sevenfold/auto', 'D:\\Sevenfold\\auto')) fail('samePath should see one folder');
    if (samePath('/d:/Sevenfold/auto', 'D:\\Sevenfold\\other')) fail('samePath should see two folders');
    if (samePath(null, 'D:\\Sevenfold\\auto')) fail('samePath should not match nothing');

    if (!failed) ok('v2 core: typing into a Cursor window lands in the right chat, or not at all');

    // Pressing Cursor's own buttons: stopping a turn, and answering what it asks.
    const { isApproval } = await import('../src/core/cursor-dom.mjs');

    // Stopping goes by keyboard first, because that is what Cursor's Stop
    // button advertises, and by the button only if the keystroke was ignored.
    const byKey = new FakeWindow({ threadId: THREAD, hasComposer: true }, { generating: true });
    let stopped = await machine({ byKey }).stop({ threadId: THREAD });
    if (stopped.status !== 'stopped' || stopped.how !== 'keyboard') {
      fail(`stop should use the keyboard first: ${JSON.stringify(stopped)}`);
    }

    const byButton = new FakeWindow(
      { threadId: THREAD, hasComposer: true },
      { generating: true, stopsOn: 'button' },
    );
    stopped = await machine({ byButton }).stop({ threadId: THREAD });
    if (stopped.status !== 'stopped' || stopped.how !== 'button') {
      fail(`stop should fall back to the button: ${JSON.stringify(stopped)}`);
    }
    if (byButton.pressed[0] !== '«keyboard»') fail('stop should try the keystroke before the button');

    const deaf = new FakeWindow(
      { threadId: THREAD, hasComposer: true },
      { generating: true, stopsOn: 'never' },
    );
    stopped = await machine({ deaf }).stop({ threadId: THREAD });
    if (stopped.status !== 'still-running') fail(`a turn that will not stop must say so: ${stopped.status}`);

    const idle = new FakeWindow({ threadId: THREAD, hasComposer: true }, { generating: false });
    if ((await machine({ idle }).stop({ threadId: THREAD })).status !== 'not-running') {
      fail('stopping an idle chat should say there is nothing to stop');
    }
    if (idle.pressed.length) fail('stopping an idle chat must press nothing');
    if ((await machine({ theirs }).stop({ threadId: THREAD })).status !== 'unknown-thread') {
      fail('stop must not reach into a chat it cannot see');
    }

    // What a chat is asking a person, told apart from what it merely offers.
    const asking = new FakeWindow(
      { threadId: THREAD, hasComposer: true },
      {
        generating: true,
        controls: [
          { label: 'Copy message', where: 'transcript' },
          { label: 'Run', where: 'transcript' },
          { label: 'Skip', where: 'transcript' },
          { label: 'Stop', where: 'composer' },
          { label: 'Accept', where: 'transcript', disabled: true },
        ],
      },
    );
    const state = await machine({ asking }).waitingOn({ threadId: THREAD });
    if (!state.generating) fail('a running turn should be reported as running');
    const wants = (state.asking || []).map((c) => c.label).join(',');
    if (wants !== 'Run,Skip') fail(`asking should be Run,Skip — got ${wants}`);

    // Pressing an answer, and refusing to press what is not there.
    const answered = await machine({ asking }).press({ threadId: THREAD, name: 'Run' });
    if (answered.status !== 'pressed' || asking.pressed.at(-1) !== 'Run') {
      fail(`pressing Run should press Run: ${JSON.stringify(answered)}`);
    }
    if ((await machine({ asking }).press({ threadId: THREAD, name: 'Demolish' })).status !== 'not-pressed') {
      fail('pressing a control that does not exist should be refused');
    }

    if (!isApproval('Run command') || !isApproval('Skip') || !isApproval('Accept all')) {
      fail('approval vocabulary should recognise Cursor asking');
    }
    if (isApproval('Copy message') || isApproval('Ran command') || isApproval('Review')) {
      fail('approval vocabulary should not catch ordinary controls');
    }

    if (!failed) ok('v2 core: Auto can stop a Cursor turn and press what Cursor asks');
  } catch (e) {
    fail(`v2 cursor-cdp: ${e.message}`);
  }

  // A desktop approval becomes a permission request, and the answer becomes a
  // press. The seam worth testing is that the broker hands back an id we can
  // withdraw by, and an option id that is the wording on the button.
  try {
    const { PermissionBroker, POLICY } = await import('../src/core/permissions.mjs');
    const broker = new PermissionBroker();
    const options = [
      { optionId: 'Run', name: 'Run', kind: 'allow_once' },
      { optionId: 'Skip', name: 'Skip', kind: 'reject_once' },
    ];

    const answer = broker.request({
      sessionId: 's',
      params: { toolCall: { title: 'Cursor is asking in "chat"' }, options },
      policy: POLICY.ask,
    });
    // The request must be findable the instant it is made: the poller needs its
    // id to withdraw it when the question is answered in the IDE instead.
    const requestId = broker.list('s').at(-1)?.requestId;
    if (!requestId) fail('a desktop ask should be parked and findable at once');

    broker.resolve(requestId, 'Run', { by: 'phone' });
    const outcome = await answer;
    if (outcome?.outcome?.optionId !== 'Run') {
      fail(`answering should come back as the button's wording: ${JSON.stringify(outcome)}`);
    }

    // Answered in the IDE first: the question is withdrawn, not left hanging.
    const second = broker.request({
      sessionId: 's',
      params: { toolCall: { title: 'again' }, options },
      policy: POLICY.ask,
    });
    const secondId = broker.list('s').at(-1)?.requestId;
    broker.cancel(secondId, 'answered in Cursor');
    if ((await second)?.outcome?.outcome !== 'cancelled') fail('a withdrawn ask should resolve as cancelled');
    if (broker.list('s').length) fail('a withdrawn ask should leave nothing pending');

    // Auto must never answer one of these on the user's behalf.
    const autoBroker = new PermissionBroker();
    let settled = false;
    autoBroker
      .request({ sessionId: 's', params: { toolCall: {}, options }, policy: POLICY.ask })
      .then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 20));
    if (settled) fail('a desktop ask must wait for a person, never resolve itself');

    if (!failed) ok('v2 core: Cursor asking becomes a permission request, answerable from a phone');
  } catch (e) {
    fail(`v2 desktop approvals: ${e.message}`);
  }

  // Permission broker: parked requests, policy shortcuts, and racing clients.
  try {
    const { PermissionBroker, POLICY } = await import('../src/core/permissions.mjs');
    const broker = new PermissionBroker();
    const options = [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ];

    // Auto policy must not park anything.
    const auto = await broker.request({
      sessionId: 's',
      params: { options, toolCall: { kind: 'execute' } },
      policy: POLICY.auto,
    });
    if (auto.outcome?.optionId !== 'allow-once') {
      fail(`auto policy should pick allow-once, got ${JSON.stringify(auto)}`);
    }
    if (broker.list().length !== 0) fail('auto policy should leave nothing pending');

    // ask-on-write approves reads but parks writes.
    const read = await broker.request({
      sessionId: 's',
      params: { options, toolCall: { kind: 'read' } },
      policy: POLICY.askOnWrite,
    });
    if (read.outcome?.optionId !== 'allow-once') fail('ask-on-write should auto-allow reads');

    const parked = broker.request({
      sessionId: 's',
      params: { options, toolCall: { kind: 'execute', title: 'rm -rf' } },
      policy: POLICY.askOnWrite,
    });
    const pending = broker.list('s');
    if (pending.length !== 1) fail(`ask-on-write should park a write, got ${pending.length}`);

    const reqId = pending[0].requestId;
    if (!broker.resolve(reqId, 'reject')) fail('resolve should report success');
    // A second client answering the same request must be a harmless no-op.
    if (broker.resolve(reqId, 'allow-once')) fail('double resolve should be a no-op');
    const settled = await parked;
    if (settled.outcome?.optionId !== 'reject') {
      fail(`parked request should settle with reject, got ${JSON.stringify(settled)}`);
    }
    if (broker.list().length !== 0) fail('broker should be empty after resolve');

    if (!failed) ok('v2 core: permission broker policies + resolution');
  } catch (e) {
    fail(`v2 permissions: ${e.message}`);
  }
}

// 1c. Terminals: a real PTY runs a command and reports its output and exit.
{
  try {
    const { TerminalRegistry } = await import('../src/core/terminals.mjs');
    const reg = new TerminalRegistry();

    if (!reg.available) {
      fail(`v2 terminals: node-pty unavailable (${reg.unavailableReason})`);
    } else {
      const { terminalId } = reg.create({
        sessionId: 's1',
        command: 'echo',
        args: ['pty-check'],
      });

      let streamed = '';
      reg.on('chunk', (e) => {
        if (e.terminalId === terminalId) streamed += e.chunk;
      });

      const status = await Promise.race([
        reg.waitForExit(terminalId),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000)),
      ]);

      const { output } = reg.outputOf(terminalId);
      let failed = false;
      if (status.exitCode !== 0) {
        fail(`terminal should exit 0, got ${status.exitCode}`);
        failed = true;
      }
      if (!output.includes('pty-check')) {
        fail(`terminal output missing command output: ${JSON.stringify(output.slice(0, 120))}`);
        failed = true;
      }
      if (!streamed.includes('pty-check')) {
        fail('terminal should stream chunks as they arrive');
        failed = true;
      }
      reg.release(terminalId);
      if (reg.list().length !== 0) {
        fail('released terminal should leave the registry');
        failed = true;
      }
      if (!failed) ok('v2 core: PTY runs, streams, exits, releases');
    }
  } catch (e) {
    fail(`v2 terminals: ${e.message}`);
  }
}

// 1d. Diff rendering maths (pure module, shared with the web client).
{
  try {
    const { lineDiff, collapseContext, diffStats } = await import('../src/web/diff.js');
    let failed = false;

    const rows = lineDiff('alpha\nbeta\ngamma\n', 'alpha\nBETA\ngamma\n');
    const stats = diffStats(rows);
    if (stats.added !== 1 || stats.removed !== 1) {
      fail(`one-line edit should be +1 −1, got +${stats.added} −${stats.removed}`);
      failed = true;
    }
    if (rows.filter((r) => r.type === 'ctx').length !== 2) {
      fail('one-line edit should keep two context lines');
      failed = true;
    }

    // An empty original is a new file: additions only, no phantom blank line.
    const created = diffStats(lineDiff('', 'a\nb\nc'));
    if (created.added !== 3 || created.removed !== 0) {
      fail(`new file should be +3 −0, got +${created.added} −${created.removed}`);
      failed = true;
    }

    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const changed = [...long];
    changed[20] = 'CHANGED';
    const collapsed = collapseContext(lineDiff(long.join('\n'), changed.join('\n')));
    if (!collapsed.some((r) => r.type === 'gap')) {
      fail('long unchanged runs should collapse into a gap');
      failed = true;
    }
    if (collapsed.length > 20) {
      fail(`collapsed diff should be short, got ${collapsed.length} rows`);
      failed = true;
    }

    if (!failed) ok('v2 web: line diff, context collapse, stats');
  } catch (e) {
    fail(`v2 diff: ${e.message}`);
  }
}

// 1e. Browser address bar: URLs are opened, prose is searched.
{
  try {
    const { normalizeUrl, findChrome } = await import('../src/core/browser.mjs');
    let failed = false;

    const cases = [
      ['example.com', 'https://example.com'],
      ['https://example.com/x?y=1', 'https://example.com/x?y=1'],
      ['localhost:4340', 'http://localhost:4340'],
      ['127.0.0.1:4340/health', 'https://127.0.0.1:4340/health'],
    ];
    for (const [input, want] of cases) {
      const got = normalizeUrl(input);
      if (got !== want) {
        fail(`normalizeUrl(${input}) should be ${want}, got ${got}`);
        failed = true;
      }
    }
    if (!normalizeUrl('how tall is everest').startsWith('https://duckduckgo.com/?q=')) {
      fail('prose should become a search');
      failed = true;
    }
    if (!findChrome()) console.log('skip: no Chrome found for the browser panel');

    if (!failed) ok('v2 browser: address bar normalisation');
  } catch (e) {
    fail(`v2 browser: ${e.message}`);
  }
}

// 1e2. Approval policy: env sets the default, a hand-picked policy sticks.
{
  const dir = mkdtempSync(join(tmpdir(), 'auto-policy-'));
  try {
    const { SessionManager } = await import('../src/core/sessions.mjs');
    let failed = false;

    const first = new SessionManager({
      stateDir: dir,
      defaultFolder: ROOT,
      defaultPolicy: 'auto',
    }).init();
    const yolo = first.list()[0];
    if (yolo.policy !== 'auto') {
      fail(`new sessions should follow the configured default, got ${yolo.policy}`);
      failed = true;
    }

    const picked = first.create({ folder: ROOT });
    first.setPolicy(picked.id, 'ask');

    // Restart with a different default: only the untouched session moves.
    const second = new SessionManager({
      stateDir: dir,
      defaultFolder: ROOT,
      defaultPolicy: 'ask-on-write',
    }).init();
    if (second.get(yolo.id).policy !== 'ask-on-write') {
      fail('an untouched session should follow the new default after a restart');
      failed = true;
    }
    if (second.get(picked.id).policy !== 'ask') {
      fail('a hand-picked policy must survive a change of default');
      failed = true;
    }

    // Archiving must survive a restart: it used to be undone by the reset
    // that clears "busy" on load, so binned sessions came back every time.
    await second.archive(picked.id);
    const third = new SessionManager({ stateDir: dir, defaultFolder: ROOT }).init();
    if (third.list().some((s) => s.id === picked.id)) {
      fail('an archived session should stay archived across a restart');
      failed = true;
    }

    if (!failed) ok('v2 core: policy default from config, explicit choice wins');
  } catch (e) {
    fail(`v2 policy default: ${e.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 1f. Telegram turn rendering: status on top, prose escaped, size bounded.
{
  try {
    const { renderTurn } = await import('../src/core/telegram.mjs');
    let failed = false;

    const out = renderTurn({
      text: 'Fixed the <script> bug & shipped it',
      tools: [
        { label: 'Edit File', status: 'completed' },
        { label: 'npm test', status: 'in_progress' },
      ],
    });
    if (!out.startsWith('✓ <i>Edit File</i>')) {
      fail(`completed tool should lead the message, got ${JSON.stringify(out.slice(0, 40))}`);
      failed = true;
    }
    if (out.includes('<script>')) {
      fail('prose must be HTML-escaped');
      failed = true;
    }
    if (!out.includes('&lt;script&gt;') || !out.includes('&amp;')) {
      fail('escaping should preserve the original characters');
      failed = true;
    }

    const huge = renderTurn({
      text: 'x'.repeat(9000),
      tools: [{ label: 'shell', status: 'in_progress' }],
    });
    if (huge.length > 4096) {
      fail(`message must fit Telegram's limit, got ${huge.length}`);
      failed = true;
    }
    if (!huge.includes('▸ <i>shell</i>')) {
      fail('a long answer must not push out the tool status');
      failed = true;
    }
    if (renderTurn({}) !== '…') {
      fail('an empty turn should render a placeholder');
      failed = true;
    }

    if (!failed) ok('v2 telegram: turn rendering, escaping, limits');
  } catch (e) {
    fail(`v2 telegram: ${e.message}`);
  }
}

// 1f2. Project discovery: URI decoding, slugs, and a real list from Cursor.
{
  try {
    const { fromFileUri, listProjects, workspaceIdFor } = await import('../src/core/projects.mjs');
    let failed = false;

    if (fromFileUri('file:///d%3A/Sevenfold/auto') !== 'D:\\Sevenfold\\auto') {
      fail(`file URI should decode to a Windows path, got ${fromFileUri('file:///d%3A/Sevenfold/auto')}`);
      failed = true;
    }
    if (fromFileUri('file:///d%3A/Projects/glose%20l%C3%A6rar') !== 'D:\\Projects\\glose lærar') {
      fail('file URI should decode escapes and non-ASCII');
      failed = true;
    }
    if (fromFileUri('not a uri') !== null) {
      fail('a non-URI should decode to null');
      failed = true;
    }
    // The repo we are in must show up, whether or not the IDE remembers it.
    const projects = listProjects([ROOT]);
    if (!projects.some((p) => p.path.toLowerCase() === ROOT.toLowerCase())) {
      fail('the current repo should appear in the project list');
      failed = true;
    }
    if (projects.some((p) => /AppData[\\/]Local[\\/]Temp/i.test(p.path))) {
      fail('temp folders should not be listed as projects');
      failed = true;
    }

    if (!failed) ok(`v2 core: projects (${projects.length} found)`);

    // Desktop chats: the folder must resolve to a workspace the IDE knows,
    // and its chats must come back with the fields the UI renders.
    const { desktopChats, desktopChatsAvailable, chatCountsByWorkspace } = await import(
      '../src/core/desktop-chats.mjs'
    );

    if (!desktopChatsAvailable()) {
      ok('v2 core: desktop chats (no Cursor database here, skipped)');
    } else {
      const wsId = workspaceIdFor(ROOT);
      const counts = chatCountsByWorkspace();
      const chats = desktopChats(wsId, { limit: 5 });
      let bad = false;

      if (!wsId) {
        fail('the current repo should map to a Cursor workspace id');
        bad = true;
      }
      if (!(counts instanceof Map)) {
        fail('chat counts should come back as a map');
        bad = true;
      }
      for (const c of chats) {
        if (!c.id || typeof c.title !== 'string') {
          fail(`malformed desktop chat entry: ${JSON.stringify(c).slice(0, 120)}`);
          bad = true;
          break;
        }
      }
      // Listing an unknown workspace is normal, not an error.
      if (desktopChats(null).length || desktopChats('nope-not-a-workspace').length) {
        fail('an unknown workspace should list no chats');
        bad = true;
      }
      if (!bad) ok(`v2 core: desktop chats (${chats.length} for this repo)`);
    }
  } catch (e) {
    fail(`v2 projects: ${e.message}`);
  }
}

// 1f2. The desktop bridge: discovery must tolerate a missing directory, stale
// files and rubbish, and refuse to send anything the bridge would reject. We
// cannot assume a Cursor is running here, so nothing below needs one.
if (existsSync(SRC)) {
  const tmp = mkdtempSync(join(tmpdir(), 'auto-bridge-'));
  const previous = process.env.CURSOR_DESKTOP_BRIDGE_DIR;
  try {
    const { instances, bridgeAvailable, sendMessage, discoveryDir } = await import(
      '../src/core/desktop-bridge.mjs'
    );

    process.env.CURSOR_DESKTOP_BRIDGE_DIR = join(tmp, 'missing');
    if ((await instances()).length) fail('a missing discovery dir should yield no instances');
    if (await bridgeAvailable()) fail('a missing discovery dir means no bridge');

    process.env.CURSOR_DESKTOP_BRIDGE_DIR = tmp;
    if (discoveryDir() !== tmp) fail('the discovery dir should follow its environment override');

    // A dead pid, a wrong protocol and a broken file must all be ignored
    // rather than crash discovery or be treated as reachable.
    const write = (name, body) => writeFileSync(join(tmp, name), body);
    write('dead.json', JSON.stringify({ protocolVersion: 1, socketPath: '\\\\.\\pipe\\x', token: 't', pid: 0x7ffffffe, appName: 'Cursor', appVersion: '0' }));
    write('old.json', JSON.stringify({ protocolVersion: 99, socketPath: '\\\\.\\pipe\\y', token: 't', pid: process.pid, appName: 'Cursor', appVersion: '0' }));
    write('junk.json', 'not json at all');
    write('ignored.txt', 'not a discovery file');

    const found = await instances();
    if (found.length) fail(`stale discovery files should be ignored, got ${found.length}`);

    // This process is alive, so a well-formed file must be picked up.
    write('live.json', JSON.stringify({ protocolVersion: 1, socketPath: '\\\\.\\pipe\\auto-test', token: 'tok', pid: process.pid, appName: 'Cursor', appVersion: '1.2.3' }));
    const live = await instances();
    if (live.length !== 1 || live[0].label !== 'Cursor 1.2.3') {
      fail(`a live discovery file should be found once, got ${JSON.stringify(live.map((i) => i.label))}`);
    }

    // Bad input must be refused before a pipe is ever opened.
    for (const [why, args] of [
      ['a non-uuid thread', { threadId: 'nope', text: 'hi' }],
      ['empty text', { threadId: '00000000-0000-4000-8000-000000000000', text: '   ' }],
      ['oversized text', { threadId: '00000000-0000-4000-8000-000000000000', text: 'x'.repeat(300 * 1024) }],
    ]) {
      let threw = false;
      try {
        await sendMessage(args);
      } catch {
        threw = true;
      }
      if (!threw) fail(`sendMessage should refuse ${why}`);
    }

    if (!failed) ok('v2 core: desktop bridge discovery and guards');

    // The switches: setting them must be idempotent, and a snapshot taken
    // first must restore exactly — including keys that did not exist. Run
    // against a stand-in database so the real Cursor is never touched.
    const fakeAppData = join(tmp, 'appdata');
    const storageDir = join(fakeAppData, 'Cursor', 'User', 'globalStorage');
    mkdirSync(storageDir, { recursive: true });
    const { DatabaseSync } = await import('node:sqlite');
    const seed = new DatabaseSync(join(storageDir, 'state.vscdb'));
    seed.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
    seed.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
      'cursorai/serverConfig',
      JSON.stringify({ somethingElse: 'must survive' }),
    );
    seed.close();

    const realAppData = process.env.APPDATA;
    process.env.APPDATA = fakeAppData;
    try {
      const gate = await import(`../src/core/desktop-bridge-gate.mjs?t=${Date.now()}`);
      const before = gate.snapshot();

      if (gate.gateState().allOn) fail('a fresh install should not look enabled');
      const first = gate.assertSwitches();
      if (first.length !== 4) fail(`enabling should set four switches, set ${first.length}`);
      if (!gate.gateState().allOn) fail('all four switches should read as on afterwards');
      if (gate.assertSwitches().length) fail('asserting twice should change nothing');

      gate.restoreSwitches(before);
      const after = gate.gateState();
      if (after.allOn || after.override || after.devEligible || after.userEnabled) {
        fail(`restoring should undo every switch, got ${JSON.stringify(after)}`);
      }

      // Unrelated settings inside the shared config blob must come back intact.
      const check = new DatabaseSync(join(storageDir, 'state.vscdb'), { readOnly: true });
      const config = JSON.parse(
        String(check.prepare('SELECT value FROM ItemTable WHERE key = ?').get('cursorai/serverConfig').value),
      );
      check.close();
      if (config.somethingElse !== 'must survive') {
        fail('restoring the switches must not disturb the rest of the server config');
      }

      if (!failed) ok('v2 core: desktop bridge switches set once, undo cleanly');

      // Reading a desktop thread: roles and kinds must survive the trip, a
      // bubble the IDE has created but not filled in must not be reported as
      // an empty message, and a turn in flight must be visible.
      const thread = '11111111-2222-4333-8444-555555555555';
      const store = new DatabaseSync(join(storageDir, 'state.vscdb'));
      store.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)');
      const put = store.prepare('INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?, ?)');
      const bubbles = [
        { bubbleId: 'b1', type: 1, text: 'hello from the IDE' },
        { bubbleId: 'b2', type: 2, thinking: { text: 'considering' } },
        { bubbleId: 'b3', type: 2, toolFormerData: { name: 'read_file', status: 'completed' } },
        { bubbleId: 'b4', type: 2, text: 'answered' },
        { bubbleId: 'b5', type: 2, text: '' },
      ];
      for (const b of bubbles) put.run(`bubbleId:${thread}:${b.bubbleId}`, JSON.stringify(b));
      const composer = (extra = {}) =>
        put.run(
          `composerData:${thread}`,
          JSON.stringify({
            name: 'A desktop chat',
            fullConversationHeadersOnly: bubbles.map((b) => ({ bubbleId: b.bubbleId })),
            ...extra,
          }),
        );
      composer();

      const threads = await import(`../src/core/desktop-threads.mjs?t=${Date.now()}`);
      const read = threads.readThread(thread);
      const shape = read.messages.map((m) => `${m.role}:${m.kind}`).join(' ');
      if (shape !== 'user:text assistant:thinking assistant:tool assistant:text') {
        fail(`desktop thread read back as "${shape}"`);
      }
      if (read.visited.includes('b5')) fail('an unfilled bubble should not count as seen');
      if (read.generating) fail('a thread with no generation id is not running');
      if (!threads.threadExists(thread)) fail('threadExists should find a thread that is there');
      if (threads.threadExists('nope')) fail('threadExists should not invent threads');

      // Only what the caller has not seen comes back.
      const rest = threads.readThread(thread, { seen: new Set(['b1', 'b2', 'b3']) });
      if (rest.messages.length !== 1 || rest.messages[0].text !== 'answered') {
        fail(`seen bubbles should be skipped, got ${JSON.stringify(rest.messages)}`);
      }

      composer({ chatGenerationUUID: 'abc' });
      if (!threads.readThread(thread).generating) fail('a generation id means a turn is running');

      // The watcher must report a new bubble and the end of the turn.
      const watcher = new threads.ThreadWatcher(thread, { idleMs: 40, busyMs: 40 });
      watcher.markSeen(read.visited);
      const events = [];
      watcher.on('message', (m) => events.push(`message:${m.text}`));
      watcher.on('running', (r) => events.push(`running:${r}`));
      watcher.start();

      await new Promise((r) => setTimeout(r, 120));
      // A turn in flight, then the shape that used to trip us up: the desktop
      // clears the generation id while the reply's bubble is still empty, and
      // fills it in a moment later. The end of the turn must not be announced
      // before the answer it belongs to.
      bubbles.push({ bubbleId: 'b6', type: 2, text: '' });
      put.run(`bubbleId:${thread}:b6`, JSON.stringify(bubbles.at(-1)));
      composer({ chatGenerationUUID: 'abc' });
      await new Promise((r) => setTimeout(r, 150));
      composer();
      await new Promise((r) => setTimeout(r, 45));
      put.run(`bubbleId:${thread}:b6`, JSON.stringify({ bubbleId: 'b6', type: 2, text: 'a new reply' }));
      await new Promise((r) => setTimeout(r, 250));
      watcher.stop();

      // A running command: the command line is worth showing while it runs,
      // the output only exists when it ends — so the bubble must be read twice.
      const cmd = {
        bubbleId: 'b7',
        type: 2,
        toolFormerData: {
          name: 'run_terminal_command_v2',
          status: 'loading',
          params: JSON.stringify({ command: 'npm test', cwd: 'd:\\repo', parsingResult: { noise: 1 } }),
        },
      };
      bubbles.push(cmd);
      put.run(`bubbleId:${thread}:b7`, JSON.stringify(cmd));
      composer();

      const older = new Set(['b1', 'b2', 'b3', 'b4', 'b6']);
      const started = threads.readThread(thread, { seen: older });
      const call = started.messages.find((m) => m.kind === 'tool');
      if (call?.input?.command !== 'npm test') {
        fail(`a running command should carry its command line, got ${JSON.stringify(call?.input)}`);
      }
      if (call.input.parsingResult) fail('the shell parse tree is not worth showing');
      if (call.output) fail('a command that has not finished has printed nothing');
      if (started.visited.includes('b7')) fail('a command still running is not finished with');

      put.run(
        `bubbleId:${thread}:b7`,
        JSON.stringify({
          ...cmd,
          toolFormerData: {
            ...cmd.toolFormerData,
            status: 'completed',
            result: JSON.stringify({ output: 'All checks passed.' }),
          },
        }),
      );
      const ended = threads.readThread(thread, { seen: older });
      const done = ended.messages.find((m) => m.kind === 'tool');
      if (done?.output !== 'All checks passed.') {
        fail(`a finished command should carry its output, got ${JSON.stringify(done?.output)}`);
      }
      if (!ended.visited.includes('b7')) fail('a finished command should count as seen');

      store.close();

      if (!events.includes('message:a new reply')) {
        fail(`the watcher should report new messages, saw ${JSON.stringify(events)}`);
      }
      if (events.includes('message:hello from the IDE')) {
        fail('the watcher should not repeat bubbles it was told about');
      }
      if (events[0] !== 'running:true' || events.at(-1) !== 'running:false') {
        fail(`the watcher should see a turn start and end, saw ${JSON.stringify(events)}`);
      }
      if (events.indexOf('message:a new reply') > events.lastIndexOf('running:false')) {
        fail(`the turn ended before its reply arrived: ${JSON.stringify(events)}`);
      }

      if (!failed) ok('v2 core: desktop thread read, filtered, and followed');
    } finally {
      if (realAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = realAppData;
    }
  } catch (e) {
    fail(`v2 desktop bridge: ${e.message}`);
  } finally {
    if (previous === undefined) delete process.env.CURSOR_DESKTOP_BRIDGE_DIR;
    else process.env.CURSOR_DESKTOP_BRIDGE_DIR = previous;
    rmSync(tmp, { recursive: true, force: true });
  }
}

// 1g. Telegram must stay responsive during a turn. A prompt does not resolve
// until the agent is done, and the agent may be waiting on the very approval
// the user is about to tap — so handling a message must not block the loop.
{
  const dir = mkdtempSync(join(tmpdir(), 'auto-tg-'));
  try {
    const { TelegramBridge } = await import('../src/core/telegram.mjs');
    let failed = false;
    let resolved = null;

    const fakeSessions = {
      activeId: 's1',
      on() {},
      get: () => ({ id: 's1', title: 't', folder: ROOT, mode: 'agent', policy: 'ask' }),
      list: () => [{ id: 's1', title: 't', folder: ROOT, active: true }],
      prompt: () => new Promise(() => {}), // a turn that never ends
      permissions: {
        resolve(requestId, optionId) {
          resolved = { requestId, optionId };
          return true;
        },
      },
    };

    const bridge = new TelegramBridge({
      sessions: fakeSessions,
      stateDir: dir,
      auth: { token: 'test', chatId: 1 },
    });
    bridge.send = async () => ({ message_id: 1 });
    bridge.edit = async () => ({});
    bridge.answerCallback = async () => ({});

    const raced = await Promise.race([
      bridge.handleUpdate({ update_id: 1, message: { chat: { id: 1 }, text: 'go' } }).then(
        () => 'returned',
      ),
      new Promise((r) => setTimeout(() => r('blocked'), 1000)),
    ]);
    if (raced !== 'returned') {
      fail('handling a message must not wait for the turn to finish');
      failed = true;
    }

    // Now the approval that unblocks it has to get through.
    await bridge.handleUpdate({
      update_id: 2,
      callback_query: {
        id: 'q1',
        data: bridge.tokenFor({ kind: 'permission', requestId: 'r1', optionId: 'allow' }),
      },
    });
    if (resolved?.requestId !== 'r1' || resolved?.optionId !== 'allow') {
      fail(`approval did not reach the broker, got ${JSON.stringify(resolved)}`);
      failed = true;
    }

    // The commands that browse the machine must answer, with buttons that
    // survive a round trip through Telegram's 64-byte callback data.
    const sent = [];
    bridge.send = async (text, opts) => {
      sent.push({ text, opts });
      return { message_id: 1 };
    };
    for (const text of ['/projects', '/chats']) {
      sent.length = 0;
      await bridge.handleUpdate({ update_id: 3, message: { chat: { id: 1 }, text } });
      if (!sent.length) {
        fail(`${text} said nothing`);
        failed = true;
        continue;
      }
      for (const row of sent[0].opts?.reply_markup?.inline_keyboard || []) {
        const data = row[0]?.callback_data;
        if (!data || Buffer.byteLength(data) > 64) {
          fail(`${text} produced a callback that Telegram would reject`);
          failed = true;
        }
      }
      ok(`v2 telegram: ${text}`);
    }

    if (!failed) ok('v2 telegram: approvals get through while a turn runs');
  } catch (e) {
    fail(`v2 telegram responsiveness: ${e.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 2. The agent CLI the whole host depends on must be resolvable.
try {
  const { resolveCursorAgent } = await import('../src/acp/resolve.mjs');
  const found = resolveCursorAgent();
  if (!found?.command) fail('cursor-agent could not be resolved');
  else ok(`agent CLI: ${found.command.split(/[\\/]/).slice(-3).join('/')}`);
} catch (e) {
  fail(`resolve cursor-agent: ${e.message}`);
}

// 2b. Auto's own skills: every .claude/skills/<name>/SKILL.md must have valid
// frontmatter (name matching the directory, non-empty description).
const SKILLS_DIR = join(ROOT, '.claude', 'skills');
if (existsSync(SKILLS_DIR)) {
  const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  for (const dir of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const before = failed;
    const mdPath = join(SKILLS_DIR, dir.name, 'SKILL.md');
    if (!existsSync(mdPath)) {
      fail(`skill ${dir.name}: missing SKILL.md`);
      continue;
    }
    const text = readFileSync(mdPath, 'utf8');
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fm) {
      fail(`skill ${dir.name}: no frontmatter block`);
      continue;
    }
    const name = fm[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
    const desc = fm[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
    if (!name) fail(`skill ${dir.name}: frontmatter missing name`);
    else if (name !== dir.name) {
      fail(`skill ${dir.name}: name "${name}" != directory name`);
    } else if (!NAME_RE.test(name) || name.length > 64) {
      fail(`skill ${dir.name}: invalid name format "${name}"`);
    }
    if (!desc) fail(`skill ${dir.name}: frontmatter missing description`);
    else if (desc.length > 1024) fail(`skill ${dir.name}: description too long`);
    if (failed === before) ok(`skill: ${dir.name}`);
  }
}

// 3. If the host is already running, check its health and session API.
const PORT = Number(process.env.AUTO_PORT || 4331);
try {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, {
    signal: AbortSignal.timeout(2000),
  });
  if (!res.ok) fail(`/api/health returned ${res.status}`);
  else {
    const body = await res.json();
    if (!body.ok) fail('/api/health reported not ok');
    else ok(`host healthy on :${PORT} (${body.sessions} sessions)`);

    // The switch-repo skill depends on this shape.
    const s = await fetch(`http://127.0.0.1:${PORT}/api/session`, {
      signal: AbortSignal.timeout(2000),
    }).then((r) => r.json());
    if (!Array.isArray(s.sessions) || !('activeId' in s)) {
      fail('/api/session should return { sessions, activeId }');
    } else {
      ok('session API shape');
    }

    // Every read-only route, because a route that throws used to take the
    // whole host down and only showed up when someone opened the rail.
    for (const [path, check] of [
      ['/api/projects', (b) => Array.isArray(b.projects)],
      [
        `/api/desktop-chats?folder=${encodeURIComponent(ROOT)}`,
        (b) => Array.isArray(b.chats),
      ],
    ]) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
          signal: AbortSignal.timeout(8000),
        });
        const body = await r.json();
        if (!r.ok || !check(body)) fail(`${path} answered ${r.status}: ${JSON.stringify(body).slice(0, 120)}`);
        else ok(`route ${path.split('?')[0]}`);
      } catch (e) {
        fail(`${path} failed: ${e.message}`);
      }
    }

    // The host must still be alive after all of that.
    const after = await fetch(`http://127.0.0.1:${PORT}/api/health`, {
      signal: AbortSignal.timeout(2000),
    }).then((r) => r.json());
    if (!after.ok) fail('host stopped being healthy while answering routes');
  }
} catch {
  console.log(`skip: host not running on :${PORT}`);
}

if (failed) {
  console.error('\nTEST SUITE FAILED');
  process.exit(1);
}
console.log('\nAll checks passed.');
// node-pty leaves handles behind after a terminal is released, which would
// otherwise keep this process alive forever.
process.exit(0);
