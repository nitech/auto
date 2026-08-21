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
 *   1g. First-run setup checklist (scripts/setup.mjs) has the expected rows.
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
      // The browser's own script counts: a typo in it breaks the whole web app,
      // and nothing else here would have caught one.
      return e.name.endsWith('.mjs') || e.name.endsWith('.js') ? [p] : [];
    });
  for (const p of walk(SRC)) {
    const res = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' });
    const rel = relative(ROOT, p);
    if (res.status !== 0) fail(`node --check ${rel}\n${res.stderr}`);
    else ok(`syntax: ${rel}`);
  }
}

// 1g. First-run checklist — the rows a stranger sees after npm install.
{
  const { collectChecks, ensureEnvFile, agentCliLoggedIn, formatReachability, whereAutoLives, agentLoginRequired } =
    await import('./setup.mjs');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  if (pkg.scripts?.postinstall !== 'node scripts/setup.mjs --postinstall') {
    fail('package.json postinstall should run scripts/setup.mjs --postinstall');
  }
  if (pkg.scripts?.setup !== 'node scripts/setup.mjs') {
    fail('package.json setup should run scripts/setup.mjs');
  }
  // `Not logged in` contains "logged in" — that used to pass the checklist.
  if (agentCliLoggedIn('Not logged in')) fail('setup must treat "Not logged in" as unsigned-in');
  if (agentCliLoggedIn('\x1b[31mNot logged in\x1b[39m')) {
    fail('setup must treat a coloured "Not logged in" as unsigned-in');
  }
  if (agentCliLoggedIn('Authentication required')) {
    fail('setup must treat "Authentication required" as unsigned-in');
  }
  if (agentCliLoggedIn('')) fail('setup must not treat empty agent status as signed-in');
  if (!agentCliLoggedIn('✓ Logged in as nitech@gmail.com')) {
    fail('setup must accept "Logged in as …"');
  }
  if (!agentCliLoggedIn('\x1b[32m✓\x1b[39m Logged in as nitech@gmail.com')) {
    fail('setup must accept a coloured "Logged in as …"');
  }
  if (!agentCliLoggedIn('Login successful!')) fail('setup must accept "Login successful!"');
  if (agentLoginRequired([{ id: 'agent-login', ok: false }]) !== true) {
    fail('agentLoginRequired must be true when the login row failed');
  }
  if (agentLoginRequired([{ id: 'agent-login', ok: true }]) !== false) {
    fail('agentLoginRequired must be false when the login row passed');
  }
  const live = formatReachability({ ip: '100.64.1.2', port: 4331, loginOk: true, up: true });
  if (!live.includes('http://100.64.1.2:4331/')) fail('reachability banner must include the Tailscale URL and port');
  if (!live.includes('http://127.0.0.1:4331/')) fail('reachability banner must include the local URL');
  if (!live.includes('Auto is up')) fail('reachability banner must say Auto is up');
  const needLogin = formatReachability({ ip: null, port: 4331, loginOk: false, up: false });
  if (!/agent login/i.test(needLogin)) fail('reachability banner must say when agent login is required');
  if (!needLogin.includes('100.x')) fail('reachability banner must say when Tailscale has no address');
  const where = whereAutoLives(4331, [{ id: 'tailscale', ip: '100.9.8.7', ok: true }]);
  if (where.phoneUrl !== 'http://100.9.8.7:4331/') fail(`whereAutoLives should use the check IP, got ${where.phoneUrl}`);
  const noTs = whereAutoLives(4331, [{ id: 'tailscale', ip: null, ok: false }]);
  if (noTs.phoneUrl !== null) fail('whereAutoLives should not invent a Tailscale URL');
  const sup = readFileSync(join(HERE, 'supervise.mjs'), 'utf8');
  if (!sup.includes("from './setup.mjs'")) fail('supervise should run the setup checklist');
  if (!sup.includes('announceReachability') || !sup.includes('formatReachability')) {
    fail('supervise should print where Auto lives after the host is up');
  }
  if (!sup.includes('agentLoginRequired')) fail('supervise should detect when agent login is required');
  const checks = await collectChecks({ root: ROOT });
  const ids = checks.map((c) => c.id);
  for (const need of ['node', 'pty', 'agent', 'tailscale', 'env']) {
    if (!ids.includes(need)) fail(`setup checklist missing ${need}`);
  }
  if (checks.find((c) => c.id === 'agent')?.ok && !ids.includes('agent-login')) {
    fail('setup must check agent login when the CLI is present');
  }
  const node = checks.find((c) => c.id === 'node');
  if (!node?.ok) fail(`setup should accept this Node, got ${node?.detail}`);
  const tmpEnv = mkdtempSync(join(tmpdir(), 'auto-setup-'));
  try {
    writeFileSync(join(tmpEnv, '.env.example'), 'AUTO_POLICY=auto\n');
    const first = ensureEnvFile(tmpEnv);
    if (!first.copied || !existsSync(join(tmpEnv, '.env'))) {
      fail('setup should copy .env.example when .env is missing');
    }
    const second = ensureEnvFile(tmpEnv);
    if (second.copied) fail('setup should not overwrite an existing .env');
  } finally {
    rmSync(tmpEnv, { recursive: true, force: true });
  }
  const post = spawnSync(process.execPath, [join(HERE, 'setup.mjs'), '--postinstall'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (post.status !== 0) {
    fail(`setup --postinstall should exit 0, got ${post.status}\n${post.stderr}`);
  } else {
    ok('setup checklist');
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

    // A long transcript must travel in bounded pieces. Sending one whole was
    // 28,000 records in a single message, and the browser never came back.
    const long = await new Transcript(tmp, 'sess-long').open();
    for (let i = 0; i < 5000; i += 1) long.append(KIND.agentDelta, { text: `d${i}` });

    const capped = long.readFrom(0, { limit: 100 });
    if (capped.length !== 100) fail(`a limited read should return 100, got ${capped.length}`);
    // The newest, not the oldest: a conversation is read from its end.
    if (capped.at(-1).seq !== 5000 || capped[0].seq !== 4901) {
      fail(`a limited read should keep the newest records, got ${capped[0].seq}..${capped.at(-1).seq}`);
    }
    if (capped.some((r, i) => i && r.seq !== capped[i - 1].seq + 1)) {
      fail('a limited read should stay in order and without gaps');
    }
    // Records older than the memory tail must still be reachable by number,
    // or "load earlier" would have nothing to load.
    const old = long.readFrom(10, { limit: 5 });
    if (old.length !== 5 || old.at(-1).seq !== 5000) {
      fail(`catching up from an old sequence should still be bounded, got ${old.length}`);
    }
    if (long.readFrom(4995).length !== 5) fail('an unlimited catch-up should return the tail');
    if (long.readFrom(0, { limit: 99_999 }).length !== 5000) {
      fail('a limit larger than the log should return all of it');
    }

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
    const { samePath, showsFolder } = await import('../src/core/cursor-dom.mjs');

    class FakeWindow {
      constructor(
        facts,
        {
          submits = true,
          focusable = true,
          controls = [],
          stopsOn = 'keyboard',
          generating = false,
          pickers = null,
          menus = null,
          takesPaste = true,
          queued = [],
          queuedHidden = 0,
          deafToClicks = false,
          hasNewAgent = false,
          nextThreadId = null,
          modelChangeEndsTurn = true,
          hasMenuSearch = false,
        } = {},
      ) {
        this.takesPaste = takesPaste;
        this.pills = 0;
        /** messages Cursor is holding for this chat, newest last */
        this.queued = [...queued];
        this.queuedHidden = queuedHidden;
        this.deafToClicks = deafToClicks;
        this.hasNewAgent = hasNewAgent;
        this.nextThreadId = nextThreadId;
        this.modelChangeEndsTurn = modelChangeEndsTurn;
        this.hasMenuSearch = hasMenuSearch;
        this.menuQuery = '';
        this.typedSearch = '';
        this.searchFocused = false;
        this.given = facts;
        this.box = facts.composerText || '';
        this.submits = submits;
        this.focusable = focusable;
        this.controls = controls;
        this.stopsOn = stopsOn;
        this.generating = generating;
        /** what each picker currently says, e.g. { mode: 'Agent' } */
        this.pickers = pickers;
        /** what each picker's menu offers: { mode: [{ label, x, y }] } */
        this.menus = menus || {};
        this.openMenu = null;
        this.clicks = [];
        this.pressed = [];
        this.sent = null;
        this.closed = false;
      }
      /** Both pickers sit in a row at the bottom, so give them fixed places. */
      async pickerAt(which) {
        if (!this.pickers?.[which]) return null;
        return { label: this.pickers[which], x: which === 'mode' ? 10 : 60, y: 400 };
      }
      async menuItems() {
        const all = this.openMenu ? this.menus[this.openMenu] || [] : [];
        const q = String(this.menuQuery || '')
          .replace(/[_-]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();
        const items = all.filter((i) => {
          if (!i.needSearch) return true;
          if (!q) return false;
          const hay = String(i.needSearch)
            .replace(/[_-]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
          return hay.includes(q);
        });
        return { open: this.openMenu ? 1 : 0, items };
      }
      async menuSearch() {
        if (this.openMenu !== 'model' || !this.hasMenuSearch) return null;
        return { x: 70, y: 50 };
      }
      async menuSearchFocused() {
        return this.searchFocused === true;
      }
      async pressEscape() {
        this.pressed.push('«escape»');
        this.openMenu = null;
        this.searchFocused = false;
        this.menuQuery = '';
      }
      /**
       * A real mouse press: on a picker it opens that menu, inside an open menu
       * it chooses, and choosing changes what the picker says — as Cursor's does.
       */
      /** When a turn ends, Cursor sends the next queued message on its own. */
      endTurn() {
        this.generating = false;
        if (!this.queued.length) return;
        this.sent = this.queued.shift();
        this.sentWith = this.pills;
        this.generating = true;
      }
      async mouseAt({ x, y }) {
        this.clicks.push({ x, y });
        if (this.openMenu === 'model' && this.hasMenuSearch && Math.abs(x - 70) < 1 && Math.abs(y - 50) < 1) {
          this.pressed.push('«search»');
          this.searchFocused = true;
          return;
        }
        const item = (this.menus[this.openMenu] || []).find(
          (i) => Math.abs(i.x - x) < 1 && Math.abs(i.y - y) < 1,
        );
        if (item) {
          this.pressed.push(item.label);
          // A model row with badges beside it does not commit on its own: the
          // variant sitting on that row is what gets chosen, so the menu stays.
          const beside = (this.menus[this.openMenu] || []).filter(
            (i) => i !== item && Math.abs(i.y - item.y) < 2,
          );
          if (beside.length && !item.becomes) return;
          const which = this.openMenu;
          if (!item.inert) this.pickers[this.openMenu] = item.becomes || item.label;
          this.openMenu = null;
          // A model switch while a turn is stuck (high demand, etc.) ends that
          // turn in Cursor, which would otherwise drain the queue into the next.
          if (which === 'model' && this.generating && this.modelChangeEndsTurn !== false) {
            this.endTurn();
          }
          return;
        }
        for (const which of ['mode', 'model']) {
          const at = await this.pickerAt(which);
          if (at && Math.abs(at.x - x) < 1 && Math.abs(at.y - y) < 1) {
            this.openMenu = this.menus[which] ? which : null;
            this.pressed.push(`«open ${which}»`);
            return;
          }
        }
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
      async showThread(id) {
        if (!(this.given.tabs || []).includes(id)) return false;
        this.given = { ...this.given, threadId: id };
        return true;
      }
      async newAgent() {
        if (!this.hasNewAgent) return { pressed: false, reason: 'no New Agent control' };
        this.pressed.push('New Agent');
        if (this.nextThreadId) this.given = { ...this.given, threadId: this.nextThreadId };
        return { pressed: true, name: 'New Agent (Ctrl+N) [Alt] Replace Agent' };
      }
      async newAgentKey() {
        this.pressed.push('«ctrl+n»');
        if (this.nextThreadId) this.given = { ...this.given, threadId: this.nextThreadId };
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
        if (this.openMenu && this.searchFocused) {
          this.menuQuery += String(text);
          this.typedSearch = this.menuQuery;
          return;
        }
        this.box += text;
      }
      async pressEnter() {
        if (!this.submits) return;
        this.sent = this.box;
        this.sentWith = this.pills;
        // A turn in flight is queued by Cursor, not sent into the thread yet.
        if (this.generating) this.queued.push(this.box);
        this.box = '';
      }
      /** Images sitting beside the box, as Cursor's context pills do. */
      async attached() {
        return this.pills || 0;
      }
      async paste() {
        this.pasted = (this.pasted || 0) + 1;
        if (this.takesPaste === false) return;
        this.pills = (this.pills || 0) + 1;
      }
      async clearComposer() {
        this.box = '';
      }
      /**
       * Cursor's own queue: messages it is holding until the turn ends, each with
       * its three buttons. `deafToClicks` is the window that ignores a dispatched
       * click, as the pickers do, and only gives in to a real mouse.
       */
      async queue() {
        return {
          waiting: this.queued.length + (this.queuedHidden || 0),
          hidden: this.queuedHidden || 0,
          items: this.queued.map((text, i) => ({
            text,
            at: { drop: { x: 10, y: 100 + i * 20 }, now: { x: 30, y: 100 + i * 20 }, edit: { x: 50, y: 100 + i * 20 } },
          })),
        };
      }
      async queueAct(text, which) {
        const at = this.queued.indexOf(text);
        if (at < 0) return { pressed: false, reason: 'that message is no longer queued' };
        this.pressed.push(`«queue ${which}: ${text}»`);
        if (!this.deafToClicks) this.queued.splice(at, 1);
        return { pressed: true, at: { x: 10, y: 100 + at * 20 } };
      }
      async answer({ askId, labels = [], indexes = [], texts = [], skip = false }) {
        if (this.missingAsk) return { pressed: false, reason: 'the question is not on screen' };
        if (!skip && this.optionNames) {
          const { optionMatches } = this.optionMatch || { optionMatches: () => false };
          const selected = [];
          for (const [i, label] of labels.entries()) {
            const byName = this.optionNames.find((n) => optionMatches(label, n));
            const byIndex = Number.isInteger(indexes[i]) ? this.optionNames[indexes[i]] : null;
            if (!byName && !byIndex) {
              return { pressed: false, reason: 'no option says ' + JSON.stringify(label), selected };
            }
            selected.push(label);
          }
          this.answered = { askId, labels: [...labels], indexes: [...indexes], texts: [...texts], skip: false };
          this.pressed.push([...selected, 'Continue'].join('|'));
          return { pressed: true, selected, submitted: 'Continue' };
        }
        this.answered = { askId, labels: [...labels], indexes: [...indexes], texts: [...texts], skip: Boolean(skip) };
        this.pressed.push(skip ? 'Skip' : [...labels, 'Continue'].join('|'));
        return { pressed: true, selected: labels, submitted: skip ? 'Skip' : 'Continue' };
      }
      async planAction({ bubbleId, action = 'locate' } = {}) {
        if (this.missingPlan) return { found: false, pressed: false, reason: 'the plan is not on screen' };
        const at = { x: 80, y: 200 };
        const loc = {
          found: true,
          pressed: false,
          viewAt: at,
          buildAt: at,
          menuAt: this.planMenuAt || null,
        };
        if (action === 'locate') return loc;
        this.pressed.push(action === 'build' ? 'Build' : 'View Plan');
        return { ...loc, pressed: true, name: action === 'build' ? 'Build' : 'View Plan' };
      }
      close() {
        this.closed = true;
      }
    }

    const THREAD = '645a0202-ac6e-4a33-b9c1-472acaf4e4cc';
    const OTHER = '4e9abaeb-7716-4f4d-a976-18ec10061759';
    const target = (id) => ({ id, type: 'page', url: `file:///workbench.html?${id}`, title: id });

    /**
     * A machine with these windows open, and nothing else. The desktop's
     * database is not consulted unless a test says what it would answer.
     */
    const machine = (windows, { owner, isGenerating, clipboard } = {}) =>
      new CursorCdp({
        settleMs: 1,
        listTargets: async () => Object.keys(windows).map(target),
        openWindow: async (t) => windows[t.id],
        owner: owner || (() => null),
        isGenerating: isGenerating || (() => false),
        // Nothing in a test may touch the machine's real clipboard.
        clipboard: clipboard || fakeClipboard(),
      });

    /** A clipboard that remembers what it was asked to hold. */
    const fakeClipboard = (fail = false) => {
      const board = {
        held: 'what the user had copied',
        images: [],
        restored: [],
        takeText: async () => board.held,
        putText: async (text) => {
          board.restored.push(text);
        },
        putImage: async (bytes) => {
          if (fail) throw new Error('the clipboard would not take the image');
          board.images.push(bytes.length);
          return true;
        },
      };
      return board;
    };

    // The message goes into the window showing that chat, and no other.
    const mine = new FakeWindow({ threadId: THREAD, hasComposer: true });
    const theirs = new FakeWindow({ threadId: OTHER, hasComposer: true });
    let result = await machine({ theirs, mine }).sendText({ threadId: THREAD, text: 'hello' });
    if (result.status !== 'submitted') fail(`cdp send should submit, got ${JSON.stringify(result)}`);
    if (mine.sent !== 'hello') fail(`cdp send typed "${mine.sent}" into the right window`);
    if (theirs.sent !== null) fail('cdp send must not touch another chat');
    if (!mine.closed || !theirs.closed) fail('cdp send should close every window it opened');

    // Mid-turn, Cursor holds the message rather than putting it in the thread.
    const working = new FakeWindow({ threadId: THREAD, hasComposer: true }, { generating: true });
    result = await machine({ working }).sendText({ threadId: THREAD, text: 'later' });
    if (result.status !== 'queued') fail(`a send during a turn should queue, got ${JSON.stringify(result)}`);
    if (!working.queued.includes('later')) fail('Cursor should be holding the queued message');
    if (working.box !== '') fail('the chat box should be empty after a queued send');

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

    // A chat in a background tab: brought forward, then written to. Only when
    // asked, and never over someone's half-written message.
    const background = new FakeWindow({ threadId: OTHER, hasComposer: true, tabs: [OTHER, THREAD] });
    result = await machine({ background }).sendText({ threadId: THREAD, text: 'from a tab', bringForward: true });
    if (result.status !== 'submitted') fail(`a chat in a tab should be reachable: ${JSON.stringify(result)}`);
    if (background.sent !== 'from a tab') fail('bringing a chat forward should then type into it');

    const untouched = new FakeWindow({ threadId: OTHER, hasComposer: true, tabs: [OTHER, THREAD] });
    if ((await machine({ untouched }).sendText({ threadId: THREAD, text: 'x' })).status !== 'unknown-thread') {
      fail('a background chat should stay in the background unless asked for');
    }
    if (untouched.given.threadId !== OTHER) fail('an unasked-for switch must not happen');

    const writing = new FakeWindow({
      threadId: OTHER,
      hasComposer: true,
      composerText: 'mid-sentence',
      tabs: [OTHER, THREAD],
    });
    result = await machine({ writing }).sendText({ threadId: THREAD, text: 'x', bringForward: true });
    if (result.status === 'submitted') fail('a window with unsent text must not be switched away');
    if (writing.box !== 'mid-sentence') fail(`unsent text was disturbed: "${writing.box}"`);

    const noTab = new FakeWindow({ threadId: OTHER, hasComposer: true, tabs: [OTHER] });
    if ((await machine({ noTab }).sendText({ threadId: THREAD, text: 'x', bringForward: true })).status !== 'unknown-thread') {
      fail('a chat with no tab anywhere is still unknown-thread');
    }

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

    // Sending a picture: it is pasted in before the words, each paste confirmed
    // by a pill appearing, and the clipboard is put back as it was found.
    const photo = { mimeType: 'image/png', data: Buffer.from('not really a png').toString('base64') };
    const withPhoto = new FakeWindow({ threadId: THREAD, hasComposer: true });
    const board = fakeClipboard();
    result = await machine({ withPhoto }, { clipboard: board }).sendText({
      threadId: THREAD,
      text: 'what do you make of this?',
      images: [photo, photo],
    });
    if (result.status !== 'submitted' || result.attached !== 2) {
      fail(`two images should reach the chat box: ${JSON.stringify(result)}`);
    }
    if (withPhoto.sentWith !== 2) fail('the images must be in the box before the message goes');
    if (board.images.length !== 2) fail('each image should go through the clipboard');
    if (board.restored.at(-1) !== 'what the user had copied') {
      fail(`the clipboard should be put back as it was: ${JSON.stringify(board.restored)}`);
    }

    // A window that ignores the paste still sends the words, and says so.
    const deafToPaste = new FakeWindow(
      { threadId: THREAD, hasComposer: true },
      { takesPaste: false },
    );
    result = await machine({ deafToPaste }).sendText({
      threadId: THREAD,
      text: 'look at this',
      images: [photo],
    });
    if (result.status !== 'submitted' || result.attached !== 0 || !result.attachFailed) {
      fail(`an image that will not attach must be reported, not hidden: ${JSON.stringify(result)}`);
    }
    if (deafToPaste.sent !== 'look at this') fail('the words should go even when the picture cannot');

    // A clipboard that refuses is the same story, and must still be put back.
    const clipboardBroken = fakeClipboard(true);
    const noBoard = new FakeWindow({ threadId: THREAD, hasComposer: true });
    result = await machine({ noBoard }, { clipboard: clipboardBroken }).sendText({
      threadId: THREAD,
      text: 'and this',
      images: [photo],
    });
    if (result.status !== 'submitted' || !result.attachFailed) {
      fail(`a clipboard that refuses should be reported: ${JSON.stringify(result)}`);
    }
    if (noBoard.pasted) fail('nothing should be pasted when the clipboard would not take it');
    if (!clipboardBroken.restored.length) fail('the clipboard must be put back even after a failure');

    // Cursor says /d:/Sevenfold/auto where Auto says D:\Sevenfold\auto.
    if (!samePath('/d:/Sevenfold/auto', 'D:\\Sevenfold\\auto')) fail('samePath should see one folder');
    if (samePath('/d:/Sevenfold/auto', 'D:\\Sevenfold\\other')) fail('samePath should see two folders');
    if (samePath(null, 'D:\\Sevenfold\\auto')) fail('samePath should not match nothing');
    if (!showsFolder({ workspace: '/d:/Sevenfold/auto' }, 'D:\\Sevenfold\\auto')) {
      fail('a window should match its workspace folder');
    }
    if (!showsFolder({ folders: ['/d:/Projects/other'] }, 'D:\\Projects\\other')) {
      fail('a multi-root window should match one of its folders');
    }
    if (showsFolder({ workspace: '/d:/Sevenfold/auto' }, 'D:\\Projects\\other')) {
      fail('a window should not match a different folder');
    }

    // A new Auto session is a new chat in the window that already has that folder.
    const FRESH = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const here = new FakeWindow(
      { threadId: THREAD, hasComposer: true, workspace: '/d:/Sevenfold/auto' },
      { hasNewAgent: true, nextThreadId: FRESH },
    );
    result = await machine({ here }).newChat({ folder: 'D:\\Sevenfold\\auto' });
    if (result.status !== 'created' || result.threadId !== FRESH) {
      fail(`new chat should open in the matching window: ${JSON.stringify(result)}`);
    }
    if (!here.pressed.includes('New Agent')) fail('new chat should press New Agent, not guess a shortcut');
    if (here.pressed.includes('«ctrl+n»')) fail('Ctrl+N is the fallback, not the first try');

    const elsewhere = new FakeWindow(
      { threadId: THREAD, hasComposer: true, workspace: '/d:/Sevenfold/auto' },
      { hasNewAgent: true, nextThreadId: FRESH },
    );
    result = await machine({ elsewhere }).newChat({ folder: 'D:\\Projects\\other' });
    if (result.status !== 'no-window') {
      fail(`a new chat must not open in the wrong repo: ${JSON.stringify(result)}`);
    }
    if (elsewhere.pressed.length) fail('the wrong window must not be pressed');

    const noBox = new FakeWindow(
      { threadId: THREAD, hasComposer: false, workspace: '/d:/Sevenfold/auto' },
      { hasNewAgent: true, nextThreadId: FRESH },
    );
    if ((await machine({ noBox }).newChat({ folder: 'D:\\Sevenfold\\auto' })).status !== 'no-window') {
      fail('a window with no chat box cannot start a chat');
    }

    const viaKey = new FakeWindow(
      { threadId: THREAD, hasComposer: true, workspace: '/d:/Sevenfold/auto' },
      { hasNewAgent: false, nextThreadId: FRESH },
    );
    result = await machine({ viaKey }).newChat({ folder: 'D:\\Sevenfold\\auto' });
    if (result.status !== 'created' || result.threadId !== FRESH) {
      fail(`new chat should fall back to Ctrl+N when the control is missing: ${JSON.stringify(result)}`);
    }
    if (!viaKey.pressed.includes('«ctrl+n»')) fail('the missing-control path should type Ctrl+N');

    const didNothing = new FakeWindow(
      { threadId: THREAD, hasComposer: true, workspace: '/d:/Sevenfold/auto' },
      { hasNewAgent: true },
    );
    result = await machine({ didNothing }).newChat({ folder: 'D:\\Sevenfold\\auto' });
    if (result.status !== 'error') fail(`a New Agent that does nothing should be an error, got ${result.status}`);

    if ((await machine({ here }).newChat({ folder: '' })).status !== 'error') {
      fail('new chat without a folder must be refused');
    }
    if ((await shut.newChat({ folder: 'D:\\Sevenfold\\auto' })).status !== 'no-cdp') {
      fail('new chat with no debug port should be no-cdp');
    }

    // Opening a folder Cursor is not showing: a new window on the running instance.
    const launches = [];
    let live = {
      auto: new FakeWindow({ threadId: THREAD, hasComposer: true, workspace: '/d:/Sevenfold/auto' }),
    };
    const opener = new CursorCdp({
      settleMs: 1,
      waitMs: 1,
      windowWaitMs: 40,
      listTargets: async () => Object.keys(live).map(target),
      openWindow: async (t) => live[t.id],
      cursorRunning: () => true,
      launchCursor: async (opts) => {
        launches.push(opts);
        live.other = new FakeWindow({
          threadId: OTHER,
          hasComposer: true,
          workspace: '/d:/Projects/other',
        });
      },
      quitCursor: async () => {
        throw new Error('must not quit Cursor when the debug port is already up');
      },
    });
    result = await opener.ensureWindow({ folder: 'D:\\Projects\\other' });
    if (result.status !== 'opened') fail(`a missing folder should open a window, got ${JSON.stringify(result)}`);
    if (launches.length !== 1 || launches[0].debugPort != null) {
      fail(`open-window should not restart Cursor: ${JSON.stringify(launches)}`);
    }
    if ((await opener.ensureWindow({ folder: 'D:\\Sevenfold\\auto' })).status !== 'showing') {
      fail('a folder already open should not launch anything');
    }

    // Cursor running without the port: the only way in is to quit and start it.
    let listening = false;
    let running = true;
    let quits = 0;
    const restarter = new CursorCdp({
      settleMs: 1,
      waitMs: 1,
      windowWaitMs: 40,
      listTargets: async () => (listening ? [target('mine')] : []),
      openWindow: async () =>
        new FakeWindow({ threadId: THREAD, hasComposer: true, workspace: '/d:/Sevenfold/auto' }),
      cursorRunning: () => running,
      quitCursor: async () => {
        quits += 1;
        running = false;
      },
      launchCursor: async (opts) => {
        launches.push(opts);
        listening = true;
        running = true;
      },
    });
    result = await restarter.ensureWindow({ folder: 'D:\\Sevenfold\\auto' });
    if (result.status !== 'restarted') fail(`blind Cursor should be restarted, got ${JSON.stringify(result)}`);
    if (quits !== 1) fail('Cursor running without its port must be quit first');
    if (!launches.at(-1)?.debugPort) fail('the restarted Cursor must be started with the debug port');

    // Nothing running: just start it with the port.
    listening = false;
    running = false;
    quits = 0;
    const starter = new CursorCdp({
      settleMs: 1,
      waitMs: 1,
      windowWaitMs: 40,
      listTargets: async () => (listening ? [target('mine')] : []),
      openWindow: async () =>
        new FakeWindow({ threadId: THREAD, hasComposer: true, workspace: '/d:/Sevenfold/auto' }),
      cursorRunning: () => running,
      quitCursor: async () => {
        quits += 1;
      },
      launchCursor: async (opts) => {
        launches.push(opts);
        listening = true;
        running = true;
      },
    });
    result = await starter.ensureWindow({ folder: 'D:\\Sevenfold\\auto' });
    if (result.status !== 'started') fail(`a stopped Cursor should be started, got ${JSON.stringify(result)}`);
    if (quits) fail('a stopped Cursor must not be killed');
    if (!launches.at(-1)?.debugPort) fail('a first launch must include the debug port');

    if (!failed) ok('v2 core: typing into a Cursor window lands in the right chat, or not at all');

    // Pressing Cursor's own buttons: stopping a turn, and answering what it asks.
    const { isApproval, isFileReview } = await import('../src/core/cursor-dom.mjs');

    // Stopping goes by keyboard first, because that is what Cursor's Stop
    // button advertises, and by the button only if the keystroke was ignored.
    const byKey = new FakeWindow({ threadId: THREAD, hasComposer: true }, { generating: true });
    let stopped = await machine({ byKey }).stop({ threadId: THREAD });
    if (stopped.status !== 'stopped' || stopped.how !== 'keyboard') {
      fail(`stop should use the keyboard first: ${JSON.stringify(stopped)}`);
    }

    // Cursor hands the stopped message back into the chat box. Left there it
    // would block the next message from a phone, so it is taken out and told.
    const handedBack = new FakeWindow({ threadId: THREAD, hasComposer: true }, { generating: true });
    handedBack.stopTurn = async function stopWithPutBack() {
      this.pressed.push('«keyboard»');
      this.generating = false;
      this.box = 'the prompt Cursor gave back';
    };
    stopped = await machine({ handedBack }).stop({ threadId: THREAD });
    if (stopped.putBack !== 'the prompt Cursor gave back') {
      fail(`stop should report what Cursor put back: ${JSON.stringify(stopped)}`);
    }
    if (handedBack.box !== '') fail('a returned message must not be left blocking the chat box');

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

    // The window's own idea of "running" is not the last word. A chat that has
    // edited no files shows no Stop, and looked idle while it was working — so
    // the desktop's record can start a stop, and has to agree it finished.
    const quietlyBusy = new FakeWindow({ threadId: THREAD, hasComposer: true }, { generating: false });
    let dbRunning = true;
    stopped = await machine(
      { quietlyBusy },
      {
        isGenerating: () => {
          // Stops when the keystroke arrives, as the desktop would record it.
          if (quietlyBusy.pressed.includes('«keyboard»')) dbRunning = false;
          return dbRunning;
        },
      },
    ).stop({ threadId: THREAD });
    if (stopped.status !== 'stopped') {
      fail(`a turn the window does not show should still be stoppable: ${JSON.stringify(stopped)}`);
    }

    // And the window saying "stopped" is not enough while the record disagrees.
    const lying = new FakeWindow({ threadId: THREAD, hasComposer: true }, { generating: true });
    stopped = await machine({ lying }, { isGenerating: () => true }).stop({ threadId: THREAD });
    if (stopped.status !== 'still-running') {
      fail(`a turn the desktop still records must not be called stopped: ${stopped.status}`);
    }
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
          { label: 'Skip', where: 'transcript', inMessage: true },
          { label: 'Stop', where: 'composer' },
          { label: 'Accept', where: 'transcript', disabled: true },
        ],
      },
    );
    const state = await machine({ asking }).waitingOn({ threadId: THREAD });
    if (!state.generating) fail('a running turn should be reported as running');
    const wants = (state.asking || []).map((c) => c.label).join(',');
    if (wants !== 'Run') fail(`asking should be Run, not Skip on a question card — got ${wants}`);

    // Pressing an answer, and refusing to press what is not there.
    const answered = await machine({ asking }).press({ threadId: THREAD, name: 'Run' });
    if (answered.status !== 'pressed' || asking.pressed.at(-1) !== 'Run') {
      fail(`pressing Run should press Run: ${JSON.stringify(answered)}`);
    }
    if ((await machine({ asking }).press({ threadId: THREAD, name: 'Demolish' })).status !== 'not-pressed') {
      fail('pressing a control that does not exist should be refused');
    }

    const planner = new FakeWindow({ threadId: THREAD, hasComposer: true });
    const built = await machine({ planner }).buildPlan({
      threadId: THREAD,
      bubbleId: 'plan-bubble',
    });
    if (built.status !== 'pressed' || planner.pressed.at(-1) !== 'Build') {
      fail(`building a plan should press Build: ${JSON.stringify(built)}`);
    }
    planner.missingPlan = true;
    if ((await machine({ planner }).buildPlan({ threadId: THREAD, bubbleId: 'gone' })).status !== 'not-pressed') {
      fail('building a plan that is not on screen should be refused');
    }

    // A question card is answered by pressing its options, then Continue.
    const quiz = new FakeWindow({ threadId: THREAD, hasComposer: true });
    const picked = await machine({ quiz }).answer({
      threadId: THREAD,
      askId: 'b9',
      labels: ['This way'],
    });
    if (picked.status !== 'pressed' || quiz.answered?.labels?.[0] !== 'This way') {
      fail(`answering a question should press its option: ${JSON.stringify(picked)}`);
    }
    if (quiz.pressed.at(-1) !== 'This way|Continue') {
      fail(`Continue should follow the option: ${JSON.stringify(quiz.pressed)}`);
    }
    const skipped = await machine({ quiz }).answer({ threadId: THREAD, askId: 'b9', skip: true });
    if (skipped.status !== 'pressed' || quiz.answered?.skip !== true) {
      fail(`skipping a question should press Skip: ${JSON.stringify(skipped)}`);
    }
    if ((await machine({ quiz }).answer({ threadId: THREAD, labels: ['This way'] })).status !== 'error') {
      fail('answering with no ask id should be refused');
    }
    quiz.missingAsk = true;
    if ((await machine({ quiz }).answer({ threadId: THREAD, askId: 'b9', labels: ['This way'] })).status !== 'not-pressed') {
      fail('a question that is not on screen should be refused');
    }

    // Long options are truncated in the window; the stored label still finds them,
    // and the Nth option is the fallback when the words are gone entirely.
    const { optionMatches } = await import('../src/core/questions.mjs');
    const long =
      'Move the current + actions (attach files / extra composer actions) to a binder in the lower-right of the chat box';
    const cut = long.slice(0, 24);
    const truncated = new FakeWindow({ threadId: THREAD, hasComposer: true });
    truncated.optionNames = [cut, 'Just swap the glyph'];
    truncated.optionMatch = { optionMatches };
    const longHit = await machine({ truncated }).answer({
      threadId: THREAD,
      askId: 'b9',
      labels: [long],
    });
    if (longHit.status !== 'pressed') {
      fail(`a truncated option should still press: ${JSON.stringify(longHit)}`);
    }
    const missingWords = new FakeWindow({ threadId: THREAD, hasComposer: true });
    missingWords.optionNames = ['Red', 'Blue'];
    missingWords.optionMatch = { optionMatches };
    const nth = await machine({ missingWords }).answer({
      threadId: THREAD,
      askId: 'b9',
      labels: [long],
      indexes: [1],
    });
    if (nth.status !== 'pressed' || missingWords.pressed.at(-1) !== `${long}|Continue`) {
      fail(`the Nth option is the fallback when the label is missing: ${JSON.stringify(nth)}`);
    }
    const lettered = new FakeWindow({ threadId: THREAD, hasComposer: true });
    lettered.optionNames = ['ARed', 'BBlue'];
    lettered.optionMatch = { optionMatches };
    const letterHit = await machine({ lettered }).answer({
      threadId: THREAD,
      askId: 'b9',
      labels: ['Red'],
    });
    if (letterHit.status !== 'pressed') {
      fail(`a lettered row should still press: ${JSON.stringify(letterHit)}`);
    }

    if (!isApproval('Run command') || !isApproval('Skip') || !isApproval('Allow once')) {
      fail('approval vocabulary should recognise Cursor asking');
    }
    if (isApproval('Copy message') || isApproval('Ran command') || isApproval('Review')) {
      fail('approval vocabulary should not catch ordinary controls');
    }
    // The bar offering to review file changes is not a question, and offering
    // "Undo All" to a phone as if it were one is how work gets thrown away.
    for (const word of ['Keep All', 'Undo All', 'Accept all', 'Reject all', 'Revert']) {
      if (isApproval(word)) fail(`${word} belongs to file review, not to approvals`);
      if (!isFileReview(word)) fail(`${word} should be recognised as a file-review control`);
    }
    if (isFileReview('Run') || isFileReview('Skip')) {
      fail('answering a question is not reviewing files');
    }
    // A message that begins with "Run…" is a message. Auto asked to approve one
    // of these before the length test existed.
    if (isApproval('Run exactly this command and wait for it: powershell -NoProfile')) {
      fail('a sentence starting with Run is not a button');
    }

    // Cursor's own queue: a message sent into a busy chat is held by the IDE,
    // and a phone gets the same three things the IDE offers.
    const holding = new FakeWindow(
      { threadId: THREAD, hasComposer: true },
      { queued: ['say pineapple', 'say wheelbarrow', 'say trombone'], queuedHidden: 1 },
    );
    let seen = await machine({ holding }).queue({ threadId: THREAD });
    if (seen.status !== 'ok' || seen.items.length !== 3 || seen.waiting !== 4) {
      fail(`the queue should read back with what is in it: ${JSON.stringify(seen)}`);
    }
    if (seen.hidden !== 1) fail('a row out of view should be counted, not silently dropped');

    // Deleting acts on the message that was chosen, and leaves the rest alone.
    let acted = await machine({ holding }).queueAct({
      threadId: THREAD,
      text: 'say wheelbarrow',
      which: 'drop',
    });
    if (acted.status !== 'done') fail(`deleting a queued message should work: ${JSON.stringify(acted)}`);
    if (holding.queued.join('|') !== 'say pineapple|say trombone') {
      fail(`deleting took the wrong message: ${holding.queued.join('|')}`);
    }
    if (holding.pressed.at(-1) !== '«queue drop: say wheelbarrow»') {
      fail(`the row's own delete button should be pressed: ${JSON.stringify(holding.pressed)}`);
    }

    // A message that has already gone in is refused rather than acted on: the
    // turn may have ended between the phone drawing the list and the tap.
    acted = await machine({ holding }).queueAct({
      threadId: THREAD,
      text: 'say wheelbarrow',
      which: 'drop',
    });
    if (acted.status !== 'gone') fail(`acting on a message that left the queue: ${JSON.stringify(acted)}`);

    // Send-now is Cursor's own button, and it must actually leave the queue.
    acted = await machine({ holding }).queueAct({ threadId: THREAD, text: 'say trombone', which: 'now' });
    if (acted.status !== 'done' || holding.queued.join('|') !== 'say pineapple') {
      fail(`sending a queued message now should take it out: ${JSON.stringify(acted)}`);
    }

    // A window that ignores a dispatched click gets a real mouse, as the model
    // pickers taught us — and if it still will not, that is reported.
    const stubborn = new FakeWindow(
      { threadId: THREAD, hasComposer: true },
      { queued: ['say pineapple'], deafToClicks: true },
    );
    acted = await machine({ stubborn }).queueAct({
      threadId: THREAD,
      text: 'say pineapple',
      which: 'drop',
    });
    if (acted.status !== 'error' || !/kept the message/.test(acted.reason)) {
      fail(`a queue that will not budge should be reported: ${JSON.stringify(acted)}`);
    }
    if (!stubborn.clicks.length) fail('a click that did nothing should be followed by a real mouse');

    if (!failed) ok('v2 core: Auto can stop a Cursor turn and press what Cursor asks');

    // Setting a chat's model and mode: the menu is opened, one item is pressed,
    // and nothing is believed until the picker itself says something new.
    const { pickItem, menuSearchStem } = await import('../src/core/cursor-cdp.mjs');
    let picking = false;
    const withPickers = () =>
      new FakeWindow(
        { threadId: THREAD, hasComposer: true },
        {
          pickers: { mode: 'Agent', model: 'Opus 5 High' },
          menus: {
            mode: [
              { label: 'Agent', x: 200, y: 100 },
              { label: 'Plan', x: 200, y: 130 },
              { label: 'Ask', x: 200, y: 160 },
            ],
            model: [
              { label: 'Opus 5', x: 300, y: 100 },
              { label: 'High', x: 380, y: 100, becomes: 'Opus 5 High' },
              { label: 'Kimi K3', x: 300, y: 130 },
              { label: 'Max', x: 380, y: 130, becomes: 'Kimi K3 Max' },
            ],
          },
        },
      );

    // What is on offer, without changing anything.
    const listing = withPickers();
    const offer = await machine({ listing }).choices({ threadId: THREAD, picker: 'mode' });
    if (offer.status !== 'ok' || offer.options.join(',') !== 'Agent,Plan,Ask') {
      picking = fail(`the mode menu should list what it offers: ${JSON.stringify(offer)}`) ?? true;
    }
    if (offer.was !== 'Agent') picking = fail(`listing should say what it is on: ${offer.was}`) ?? true;
    if (listing.openMenu) picking = fail('a menu opened to be read must be closed again') ?? true;
    if (listing.pickers.mode !== 'Agent') picking = fail('reading a menu must not change anything') ?? true;

    const switching = withPickers();
    const set = await machine({ switching }).choose({ threadId: THREAD, picker: 'mode', wanted: 'Plan' });
    if (set.status !== 'set' || set.now !== 'Plan' || set.was !== 'Agent') {
      picking = fail(`choosing a mode should set it: ${JSON.stringify(set)}`) ?? true;
    }
    if (switching.openMenu) picking = fail('choosing must not leave the menu open') ?? true;

    // A variant is a badge on the model's row: press the row, then the badge.
    const variant = withPickers();
    const chose = await machine({ variant }).choose({
      threadId: THREAD,
      picker: 'model',
      wanted: 'Kimi K3 Max',
    });
    if (chose.status !== 'set' || chose.now !== 'Kimi K3 Max') {
      picking = fail(`a model variant should be reachable: ${JSON.stringify(chose)}`) ?? true;
    }
    if (!variant.pressed.includes('Kimi K3') || !variant.pressed.includes('Max')) {
      picking = fail(`a variant is pressed on its own row: ${variant.pressed.join(',')}`) ?? true;
    }

    // Asking for what it is already on presses nothing at all.
    const same = withPickers();
    const already = await machine({ same }).choose({ threadId: THREAD, picker: 'mode', wanted: 'agent' });
    if (already.status !== 'already') picking = fail(`already-on should say so: ${already.status}`) ?? true;
    if (same.pressed.length) picking = fail('nothing should be pressed to stay where we are') ?? true;

    // A name nothing answers to, and a menu that presses but does not take.
    const missing = withPickers();
    const nope = await machine({ missing }).choose({ threadId: THREAD, picker: 'model', wanted: 'Clippy 9' });
    if (nope.status !== 'no-such-option' || !nope.options?.length) {
      picking = fail(`an unknown model should be refused with the list: ${JSON.stringify(nope)}`) ?? true;
    }
    if (missing.openMenu) picking = fail('a refused choice must still close the menu') ?? true;

    const deafMenu = withPickers();
    deafMenu.menus.mode = deafMenu.menus.mode.map((i) => ({ ...i, inert: true }));
    const ignored = await machine({ deafMenu }).choose({ threadId: THREAD, picker: 'mode', wanted: 'Plan' });
    if (ignored.status !== 'unchanged') {
      picking = fail(`a press that changes nothing is not a success: ${JSON.stringify(ignored)}`) ?? true;
    }

    const noPicker = new FakeWindow({ threadId: THREAD, hasComposer: true });
    if ((await machine({ noPicker }).choices({ threadId: THREAD, picker: 'mode' })).status !== 'no-picker') {
      picking = fail('a window with no picker should say so') ?? true;
    }
    if ((await machine({ listing }).choose({ threadId: OTHER, picker: 'mode', wanted: 'Plan' })).status !== 'unknown-thread') {
      picking = fail('a chat no window shows must not have its mode changed') ?? true;
    }

    // Changing the model while Cursor is holding a queue must not submit the
    // next message — high demand ending the turn used to drain the queue.
    const queuedSwitch = new FakeWindow(
      { threadId: THREAD, hasComposer: true },
      {
        generating: true,
        queued: ['next please', 'after that'],
        pickers: { mode: 'Agent', model: 'Opus 5 High' },
        menus: {
          model: [
            { label: 'Opus 5', x: 300, y: 100 },
            { label: 'High', x: 380, y: 100, becomes: 'Opus 5 High' },
            { label: 'Kimi K3', x: 300, y: 130 },
          ],
        },
      },
    );
    const held = await machine({ queuedSwitch }).choose({
      threadId: THREAD,
      picker: 'model',
      wanted: 'Kimi K3',
    });
    if (held.status !== 'set' || held.now !== 'Kimi K3') {
      picking = fail(`model switch with a queue should still set it: ${JSON.stringify(held)}`) ?? true;
    }
    if (queuedSwitch.sent === 'next please' || queuedSwitch.sent === 'after that') {
      picking = fail(`changing the model must not submit a queued message, sent ${queuedSwitch.sent}`) ?? true;
    }
    if (!held.held || held.held.join('|') !== 'next please|after that') {
      picking = fail(`held queue should be returned, got ${JSON.stringify(held.held)}`) ?? true;
    }
    if (queuedSwitch.queued.length) {
      picking = fail('held messages must leave Cursor’s queue') ?? true;
    }

    // If the turn is still running after the switch, put the queue back.
    const stillBusy = new FakeWindow(
      { threadId: THREAD, hasComposer: true },
      {
        generating: true,
        modelChangeEndsTurn: false,
        queued: ['keep me'],
        pickers: { model: 'Opus 5 High' },
        menus: {
          model: [
            { label: 'Opus 5', x: 300, y: 100 },
            { label: 'High', x: 380, y: 100, becomes: 'Opus 5 High' },
            { label: 'Kimi K3', x: 300, y: 130 },
          ],
        },
      },
    );
    const restored = await machine({ stillBusy }).choose({
      threadId: THREAD,
      picker: 'model',
      wanted: 'Kimi K3',
    });
    if (restored.held?.length) {
      picking = fail('a still-running turn should get its queue back') ?? true;
    }
    if (stillBusy.queued.join('|') !== 'keep me') {
      picking = fail(`queue should be restored while generating, got ${stillBusy.queued.join('|')}`) ?? true;
    }

    // Matching names the way a reader does, and refusing what is ambiguous.
    const rows = [
      { label: 'Opus 5', x: 1, y: 10 },
      { label: 'High', x: 9, y: 10 },
      { label: 'Kimi K3', x: 1, y: 40 },
      { label: 'High', x: 9, y: 40 },
    ];
    if (pickItem(rows, 'opus 5').press.length !== 1) picking = fail('case should not matter') ?? true;
    if (pickItem(rows, 'Opus 5 High').press.length !== 2) {
      picking = fail('a variant needs the row and the badge') ?? true;
    }
    if (pickItem(rows, 'High').item) picking = fail('a badge on every row is ambiguous') ?? true;
    if (pickItem(rows, 'Opus 5 Max').item) picking = fail('a variant not on that row is not a match') ?? true;

    // Agent ids use hyphens; Cursor's menu uses spaces. Same name.
    const slugs = [
      { label: 'Kimi K3', x: 1, y: 40 },
      { label: 'Max', x: 9, y: 40 },
      { label: 'Cursor Grok 4.6', x: 1, y: 70 },
      { label: 'High', x: 9, y: 70 },
    ];
    if (pickItem(slugs, 'kimi-k3').press.length !== 1) {
      picking = fail('kimi-k3 should match the Kimi K3 row') ?? true;
    }
    if (pickItem(slugs, 'kimi-k3 Max').press.length !== 2) {
      picking = fail('kimi-k3 Max should press the row then Max') ?? true;
    }
    if (pickItem(slugs, 'grok-4.6').press.length !== 1) {
      picking = fail('grok-4.6 should match Cursor Grok 4.6') ?? true;
    }
    if (pickItem(slugs, 'grok-4.6 High').press.length !== 2) {
      picking = fail('grok-4.6 High should press the row then High') ?? true;
    }

    const composer = [
      { label: 'Composer 2.5', x: 1, y: 10 },
      { label: 'Fast', x: 9, y: 10 },
    ];
    if (pickItem(composer, 'composer-2.5').press.length !== 1) {
      picking = fail('composer-2.5 should match the Composer 2.5 row') ?? true;
    }
    if (pickItem(composer, 'composer-2.5 Fast').press.length !== 2) {
      picking = fail('composer-2.5 Fast should press the row then Fast') ?? true;
    }
    if (menuSearchStem('composer-2.5 Fast') !== 'composer 2.5') {
      picking = fail(`search should drop the Fast badge, got ${JSON.stringify(menuSearchStem('composer-2.5 Fast'))}`) ?? true;
    }
    if (menuSearchStem('Auto') !== 'auto') {
      picking = fail('Auto has no badge to strip') ?? true;
    }

    // Grok's row bundles two badge words into one press ("High Fast"), not
    // two separate ones. Either word on its own must still find that badge.
    const grok = [
      { label: 'Cursor Grok 4.6', x: 1, y: 10 },
      { label: 'High Fast', x: 9, y: 10 },
    ];
    if (pickItem(grok, 'grok-4.6 Fast').press.length !== 2) {
      picking = fail('grok-4.6 Fast should press the row then the combined badge') ?? true;
    }
    if (pickItem(grok, 'grok-4.6 High').item !== grok[1]) {
      picking = fail('grok-4.6 High should also land on the combined High Fast badge') ?? true;
    }
    if (pickItem(grok, 'grok-4.6 Max').item) {
      picking = fail('a word not on the badge is not a match') ?? true;
    }

    // Cursor's Auto-on menu hides named models until search is typed.
    const autoOn = new FakeWindow(
      { threadId: THREAD, hasComposer: true },
      {
        pickers: { model: 'Auto' },
        hasMenuSearch: true,
        menus: {
          model: [
            { label: 'Auto', x: 300, y: 90, becomes: 'Auto' },
            { label: 'Composer 2.5', x: 300, y: 130, needSearch: 'Composer 2.5' },
            { label: 'Fast', x: 380, y: 130, needSearch: 'Composer 2.5', becomes: 'Composer 2.5 Fast' },
          ],
        },
      },
    );
    const fromAuto = await machine({ autoOn }).choose({
      threadId: THREAD,
      picker: 'model',
      wanted: 'composer-2.5 Fast',
    });
    if (fromAuto.status !== 'set' || fromAuto.now !== 'Composer 2.5 Fast') {
      picking = fail(`searching the Auto-on menu should find Composer: ${JSON.stringify(fromAuto)}`) ?? true;
    }
    if (!autoOn.pressed.includes('«search»') || autoOn.typedSearch !== 'composer 2.5') {
      picking = fail(`should type the stem into search, pressed ${autoOn.pressed.join(',')} query=${autoOn.typedSearch}`) ?? true;
    }
    if (autoOn.box) picking = fail('search text must not land in the chat box') ?? true;

    const stillAuto = new FakeWindow(
      { threadId: THREAD, hasComposer: true },
      {
        pickers: { model: 'Auto' },
        hasMenuSearch: true,
        menus: { model: [{ label: 'Auto', x: 300, y: 90, becomes: 'Auto' }] },
      },
    );
    const stay = await machine({ stillAuto }).choose({
      threadId: THREAD,
      picker: 'model',
      wanted: 'Auto',
    });
    if (stay.status !== 'already') {
      picking = fail(`already on Auto should not search: ${JSON.stringify(stay)}`) ?? true;
    }

    if (!picking) ok('v2 core: a chat’s model and mode can be set from its own menus');
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

// 1d2. Markdown rendering: escape-first, with the blocks agent replies use.
{
  try {
    const { renderMarkdown } = await import('../src/web/markdown.js');
    let failed = false;
    const has = (md, bits) => {
      const html = renderMarkdown(md);
      for (const b of bits) {
        if (!html.includes(b)) {
          fail(`renderMarkdown(${JSON.stringify(md)}) should include ${JSON.stringify(b)}\n  got: ${html}`);
          failed = true;
        }
      }
      return html;
    };

    has('a **bold** and *slant* and `code`', ['<strong>bold</strong>', '<em>slant</em>', '<code>code</code>']);
    has('~~gone~~', ['<del>gone</del>']);
    has('[link](https://example.com)', ['<a href="https://example.com"']);
    has('see https://example.com/x', ['<a href="https://example.com/x"', '>https://example.com/x</a>']);
    has('end https://example.com.', ['href="https://example.com"', 'example.com</a>.']);
    // A markdown link is already an <a>; wrapping it again would nest them.
    if ((renderMarkdown('[x](https://example.com)').match(/<a /g) || []).length !== 1) {
      fail('a markdown link must stay a single <a>');
      failed = true;
    }
    // Plans cite files as [label](src/…); those are not http, so show the label.
    has('[sessions.mjs](src/core/sessions.mjs)', ['<code>sessions.mjs</code>']);
    if (renderMarkdown('[sessions.mjs](src/core/sessions.mjs)').includes('<a ')) {
      fail('a relative markdown link must not become an <a>');
      failed = true;
    }
    if (renderMarkdown('`https://example.com`').includes('<a ')) {
      fail('a url in code must stay code');
      failed = true;
    }
    has('## Title', ['<h4>Title</h4>']);
    has('---', ['<hr>']);
    has('> quoted', ['<blockquote><p>quoted</p></blockquote>']);
    has('| a | b |\n|---|---|\n| 1 | 2 |', ['<table>', '<th>a</th>', '<td>2</td>', '</table>']);
    has('- one\n  - two', ['<ul><li>one<ul><li>two</li></ul></li></ul>']);
    has('- [x] done\n- [ ] todo', ['checkbox', 'checked']);
    has('1. first\n2. second', ['<ol><li>first</li><li>second</li></ol>']);

    // Emphasis must not reach inside code, inline or fenced.
    has('`**not bold**`', ['<code>**not bold**</code>']);
    has('```js\n**x**\n```', ['<pre><code data-lang="js">**x**</code></pre>']);
    // Identifiers are everywhere in agent prose; intraword `_` is not emphasis.
    if (renderMarkdown('foo_bar_baz').includes('<em>')) {
      fail('snake_case must not italicise');
      failed = true;
    }
    // The source is untrusted: markup in it stays markup-shaped text.
    if (renderMarkdown('<script>alert(1)</script>').includes('<script>')) {
      fail('HTML in the source must stay escaped');
      failed = true;
    }
    // A pipe-rich line without a separator row is prose, not a table.
    if (renderMarkdown('a | b\ntext').includes('<table>')) {
      fail('pipes alone do not make a table');
      failed = true;
    }
    const app = readFileSync(join(ROOT, 'src/web/app.js'), 'utf8');
    if (!app.includes('linkify(esc(rec.text))')) {
      fail('user bubbles must turn urls into links without running markdown');
      failed = true;
    }

    if (!failed) ok('v2 web: markdown — tables, quotes, nested lists, code, escaping');
  } catch (e) {
    fail(`v2 markdown: ${e.message}`);
  }
}

// 1d3. Chat history is not a blank pane while it loads. A long transcript
// takes a few seconds to replay, and an empty #transcript used to look like
// the app had frozen.
{
  const html = readFileSync(join(ROOT, 'src/web/index.html'), 'utf8');
  const css = readFileSync(join(ROOT, 'src/web/style.css'), 'utf8');
  const js = readFileSync(join(ROOT, 'src/web/app.js'), 'utf8');
  let failed = false;
  if (!html.includes('id="transcript-loading"')) {
    fail('the page must ship a loading marker so history is not a blank pane');
    failed = true;
  }
  if (!/id="transcript-loading"[^>]*role="status"/.test(html)) {
    fail('the loading marker should announce itself as a status');
    failed = true;
  }
  if (!html.includes('loading-mark') || !html.includes('Loading conversation')) {
    fail('the loading marker should show the Auto mark while history replays');
    failed = true;
  }
  if (!css.includes('.transcript-loading') || !css.includes('.transcript-loading[hidden]')) {
    fail('the loading marker needs a style, and a way to leave the screen');
    failed = true;
  }
  if (!css.includes('.loading-mark') || !css.includes('loading-breathe')) {
    fail('the Auto mark on the loading overlay needs a size and a breathe');
    failed = true;
  }
  if (!js.includes('function setHistoryLoading') || !js.includes('setHistoryLoading(true)')) {
    fail('app.js must show the loading marker while history is on its way');
    failed = true;
  }
  if (!js.includes("from './desktop-tool-ui.js'")) {
    fail('app.js must classify desktop tools the same way Telegram does');
    failed = true;
  }
  if (!failed) ok('v2 web: transcript loading marker');
}

// A refresh used to omit the session from the handshake (lastSeq is 0 on a
// fresh page), so the host opened whichever chat was active — often not the
// one this tab had been looking at.
{
  const js = readFileSync(join(ROOT, 'src/web/app.js'), 'utf8');
  let failed = false;
  if (!js.includes('auto.session') || !js.includes('function rememberSession')) {
    fail('the web client must remember the open session across a reload');
    failed = true;
  }
  if (!js.includes('history.replaceState')) {
    fail('the open session must live in the URL so a refresh asks for the same chat');
    failed = true;
  }
  const connectAt = js.indexOf('function connect()');
  const connect = connectAt >= 0 ? js.slice(connectAt, js.indexOf('ws.onopen', connectAt)) : '';
  if (!connect.includes('rememberedSession')) {
    fail('connect() must ask for the remembered session on first load, not only on reconnect');
    failed = true;
  }
  if (/if \(state\.sessionId && state\.lastSeq\)/.test(connect)) {
    fail('a first load has no lastSeq; that must not drop the session from the handshake');
    failed = true;
  }
  if (!failed) ok('v2 web: remembers the open session');
}

// Browser and terminals open as tabs under the header (Chat first, closable tools).
{
  const html = readFileSync(join(ROOT, 'src/web/index.html'), 'utf8');
  const css = readFileSync(join(ROOT, 'src/web/style.css'), 'utf8');
  const app = readFileSync(join(ROOT, 'src/web/app.js'), 'utf8');
  const ws = readFileSync(join(ROOT, 'src/web/workspace.js'), 'utf8');
  let failed = false;
  if (!html.includes('id="view-tabs"') || !html.includes('id="view-chat"')) {
    fail('browser and terminals need Chat-first view tabs under the header');
    failed = true;
  }
  if (html.includes('id="workspace"') || html.includes('id="ws-tab-browser"')) {
    fail('the side workspace dock is retired — tools are header tabs');
    failed = true;
  }
  const mainAt = html.indexOf('id="main"');
  const mainEnd = html.indexOf('</main>', mainAt);
  const main = mainAt >= 0 && mainEnd >= 0 ? html.slice(mainAt, mainEnd) : '';
  if (!main.includes('id="browser"') || !main.includes('id="terminals"')) {
    fail('browser and terminals must live inside #main as tabbed views');
    failed = true;
  }
  if (!css.includes('.view-tabs') || !css.includes('overflow-x: auto')) {
    fail('view tabs must scroll sideways when they overflow');
    failed = true;
  }
  if (css.includes('minmax(360px, 44vw)') || css.includes('#app.workspace-open')) {
    fail('the right-dock workspace layout must stay gone');
    failed = true;
  }
  if (!ws.includes('closable: false') || !ws.includes("'Chat'")) {
    fail('Chat must be the first tab and must not be closable');
    failed = true;
  }
  if (!app.includes("from './workspace.js'") || !app.includes('initWorkspace')) {
    fail('app.js must own the workspace lifecycle');
    failed = true;
  }
  if (!app.includes('auto.views') || !app.includes('restoreViews') || !ws.includes('restoreViews')) {
    fail('view tabs must be remembered across refresh via restoreViews');
    failed = true;
  }
  if (!failed) ok('v2 web: browser/terminals as header tabs');
}

// Composer modes: Cursor's five, coloured the way the IDE colours them.
{
  const html = readFileSync(join(ROOT, 'src/web/index.html'), 'utf8');
  const css = readFileSync(join(ROOT, 'src/web/style.css'), 'utf8');
  const js = readFileSync(join(ROOT, 'src/web/app.js'), 'utf8');
  const tg = readFileSync(join(ROOT, 'src/core/telegram.mjs'), 'utf8');
  let failed = false;
  for (const mode of ['agent', 'plan', 'debug', 'multitask', 'ask']) {
    if (!new RegExp(`<option value="${mode}"`).test(html)) {
      fail(`the mode picker must include ${mode}`);
      failed = true;
    }
    if (!css.includes(`--mode-${mode}`)) {
      fail(`style.css must name a --mode-${mode} token`);
      failed = true;
    }
  }
  if (!html.includes('data-mode="agent"')) {
    fail('the chat box must start in agent so the ring has a hue before JS');
    failed = true;
  }
  if (!js.includes('function paintMode') || !js.includes('dataset.mode')) {
    fail('app.js must paint the composer from the selected mode');
    failed = true;
  }
  if (!js.includes('function selectModel') || !js.includes('selectModel(meta.model, meta.modelName)')) {
    fail('the model picker must resolve by id or Cursor label, or it goes blank after a switch');
    failed = true;
  }
  if (!js.includes('function modelOptionLabel') || !js.includes("split('-')")) {
    fail('the model picker must show kimi-k3 as Kimi K3, not the catalog slug');
    failed = true;
  }
  if (!tg.includes('debug|multitask|ask') && !tg.includes("'debug', 'multitask', 'ask'")) {
    fail('Telegram /mode must accept debug and multitask');
    failed = true;
  }
  const attachAt = html.indexOf('id="attach"');
  const controlsAt = html.indexOf('class="composer-controls"');
  const mainAt = html.indexOf('class="composer-main"');
  if (attachAt < 0 || controlsAt < 0 || attachAt < controlsAt) {
    fail('attach must live in composer-controls, not the typing row');
    failed = true;
  }
  if (mainAt >= 0 && attachAt > mainAt && attachAt < controlsAt) {
    fail('attach must not sit in composer-main');
    failed = true;
  }
  if (!/id="attach"[^>]*>\s*\+/.test(html)) {
    fail('attach must be a plus sign');
    failed = true;
  }
  if (html.includes('binder-icon') || css.includes('.binder-icon')) {
    fail('attach must not be a binder icon');
    failed = true;
  }
  if (!html.includes('id="usage"') || !html.includes('id="usage-sheet"') || !html.includes('composer-actions')) {
    fail('usage dial and dialog must sit beside the attach control');
    failed = true;
  }
  if (!html.includes('id="plan-sheet"') || !html.includes('id="plan-close"') || !html.includes('id="plan-body"')) {
    fail('View Plan must open a full-window plan sheet with a close control');
    failed = true;
  }
  if (!html.includes('id="plan-foot"') || !html.includes('id="plan-build"') || !html.includes('id="plan-build-model"')) {
    fail('full-window View Plan must keep Build controls in a sticky footer');
    failed = true;
  }
  if (!js.includes('function openPlanView') || !js.includes('function setPlanSheet') || !js.includes('openPlanView(card)')) {
    fail('View Plan must open the plan sheet, not expand inline');
    failed = true;
  }
  if (js.includes("textContent = open ? 'Hide Plan'") || js.includes('Hide Plan')) {
    fail('View Plan must not toggle Hide Plan inline');
    failed = true;
  }
  if (!css.includes('#plan-sheet') || !css.includes('.plan-body') || !css.includes('.plan-foot')) {
    fail('plan sheet must be styled as a full-window viewer with a sticky Build footer');
    failed = true;
  }
  const attAt = html.indexOf('id="attachments"');
  const boxAt = html.indexOf('class="composer-box"');
  // Close of the composer-box itself — not an inner </div>, and not the
  // "composer-controls" string that also appears in the standalone <style>.
  const boxEnd = html.indexOf('</div>', controlsAt > 0 ? controlsAt : boxAt);
  if (attAt < 0 || boxAt < 0 || attAt < boxAt || (boxEnd > 0 && attAt > boxEnd)) {
    fail('pasted images must sit inside the composer box, not above it');
    failed = true;
  }
  if (!css.includes('.composer-box > #attachments')) {
    fail('attachment strip styles must target thumbnails inside the composer box');
    failed = true;
  }
  if (!css.includes('.usage-dial') || !css.includes('conic-gradient')) {
    fail('usage dial must be a fillable ring');
    failed = true;
  }
  if (!js.includes("op: 'usage.get'") || !js.includes('function paintUsageDial') || !js.includes('Cursor Models')) {
    fail('web client must fetch and render session + account usage');
    failed = true;
  }
  if (!js.includes('contextTokensUsed') || !js.includes('Est. ') || !js.includes('usage-hero-cost')) {
    fail('usage sheet must show context tokens used/max and estimated chat cost');
    failed = true;
  }
  const pickerCss = css.slice(css.indexOf('.composer-controls select {'));
  const pickerBlock = pickerCss.slice(0, pickerCss.indexOf('}') + 1);
  if (!/font-size:\s*16px/.test(pickerBlock)) {
    fail('composer pickers must be 16px so iOS does not zoom on tap');
    failed = true;
  }
  if (/zoom\s*:/.test(pickerBlock) || /transform\s*:/.test(pickerBlock)) {
    fail('composer pickers must not use CSS zoom/transform on the select — scale the group instead');
    failed = true;
  }
  const pickersGroupAt = css.indexOf('.composer-pickers {');
  const pickersGroup = pickersGroupAt < 0 ? '' : css.slice(pickersGroupAt, css.indexOf('}', pickersGroupAt) + 1);
  if (!/transform:\s*scale\(0\.75\)/.test(pickersGroup)) {
    fail('composer pickers group must scale to ~75% via transform (keeps 16px font, no chip overlap)');
    failed = true;
  }
  if (!html.includes('composer-pickers')) {
    fail('mode and model must share a composer-pickers wrapper so scale keeps their gap');
    failed = true;
  }
  if (!/background:\s*var\(--bg-3\)/.test(pickerBlock) || !/border-radius:\s*8px/.test(pickerBlock)) {
    fail('composer pickers must read as chips (background and rounded edges)');
    failed = true;
  }
  if (!html.includes('maximum-scale=1') || !html.includes('data-standalone')) {
    fail('Home Screen PWA must lock scale so iOS cannot zoom the page on picker tap');
    failed = true;
  }
  if (!html.includes('zoom: normal')
      || !/composer-pickers[\s\S]*transform:\s*none\s*!important/.test(html)
      || !/composer-controls select[\s\S]*font-size:\s*12px\s*!important/.test(html)) {
    fail('standalone inline CSS must pin pickers at 12px without zoom/scale (beats a cached sheet)');
    failed = true;
  }
  const standalonePickersAt = css.indexOf('html[data-standalone] .composer-pickers');
  const standalonePickers = standalonePickersAt < 0
    ? ''
    : css.slice(standalonePickersAt, css.indexOf('}', standalonePickersAt) + 1);
  const standaloneAt = css.indexOf('html[data-standalone] .composer-controls select');
  const standaloneBlock = standaloneAt < 0 ? '' : css.slice(standaloneAt, css.indexOf('}', standaloneAt) + 1);
  if (!/transform:\s*none/.test(standalonePickers) || !/font-size:\s*12px/.test(standaloneBlock)) {
    fail('the installed PWA must draw pickers at true 12px with no group transform — maximum-scale=1 makes focus-zoom impossible there');
    failed = true;
  }
  const modeChip = css.slice(css.indexOf('#mode,'), css.indexOf('#mode option'));
  if (!/background:\s*color-mix\(in srgb, var\(--mode-color\)/.test(modeChip)) {
    fail('the mode chip background must follow the mode colour');
    failed = true;
  }
  if (!failed) ok('v2 web: composer mode colours');
}

// Settings lives at the bottom of the session rail, not as ⋯ in the top bar.
{
  const html = readFileSync(join(ROOT, 'src/web/index.html'), 'utf8');
  const css = readFileSync(join(ROOT, 'src/web/style.css'), 'utf8');
  const js = readFileSync(join(ROOT, 'src/web/app.js'), 'utf8');
  let failed = false;
  const openAt = html.indexOf('id="sheet-open"');
  const railEnd = html.indexOf('</aside>');
  const topbarAt = html.indexOf('id="topbar"');
  if (openAt < 0 || railEnd < 0 || openAt > railEnd) {
    fail('settings must live in the session rail');
    failed = true;
  }
  if (topbarAt >= 0 && openAt > topbarAt) {
    fail('settings must not sit in the top bar');
    failed = true;
  }
  const settingsChunk = html.slice(openAt, openAt + 1200);
  if (!html.includes('class="rail-settings"') || !/>\s*Settings\s*</.test(settingsChunk)) {
    fail('the rail settings row must say Settings');
    failed = true;
  }
  if (html.includes('⋯')) {
    fail('settings must not be a ⋯ glyph');
    failed = true;
  }
  if (!css.includes('.rail-settings .gear') || !html.includes('class="gear"') || !html.includes('<svg')) {
    fail('settings must use an inline SVG gear');
    failed = true;
  }
  if (existsSync(join(ROOT, 'src/web/settings.png')) || /icons8/i.test(css) || /icons8/i.test(html)) {
    fail('settings must not use Icons8 assets');
    failed = true;
  }
  if (!css.includes('#sheet .sheet-panel') || !/height:\s*100%/.test(css.slice(css.indexOf('#sheet .sheet-panel')))) {
    fail('the settings panel must fill the screen');
    failed = true;
  }
  const openJs = js.slice(js.indexOf("$('sheet-open')"), js.indexOf("$('sheet-close')"));
  if (!openJs.includes('setRail(false)') || !openJs.includes('setSheet(true)')) {
    fail('opening settings must close the rail');
    failed = true;
  }
  if (!html.includes('id="host-label"') || !html.includes('id="host-nick"') || !html.includes('id="host-nick-save"')) {
    fail('the rail must show the host label, and Settings must edit its nick');
    failed = true;
  }
  if (!js.includes('host.setNick') || !js.includes('applyHost') || !js.includes('msg.type === \'host\'')) {
    fail('the web must apply host identity from hello and host.setNick');
    failed = true;
  }
  if (!js.includes('document.title') || !js.includes('${state.host.label} · Auto')) {
    fail('the tab title must lead with the host label so which machine is clear');
    failed = true;
  }
  if (!failed) ok('v2 web: settings in the rail, full screen');
}

// Host identity: OS hostname on the rail, optional nick in state/host.json.
{
  const tmp = mkdtempSync(join(tmpdir(), 'auto-host-'));
  try {
    const { HostIdentity } = await import('../src/core/host-identity.mjs');
    const a = new HostIdentity(tmp);
    if (!a.hostname || a.label() !== a.hostname) {
      fail(`host identity should default the label to the OS hostname, got ${a.label()}`);
    }
    if (a.snapshot().nick !== null) fail('host identity nick should be null when unset');
    const set = a.setNick('  Office PC  ');
    if (set.nick !== 'Office PC' || set.label !== 'Office PC') {
      fail(`host.setNick should trim and become the label, got ${JSON.stringify(set)}`);
    }
    if (!existsSync(join(tmp, 'host.json'))) fail('host.setNick must persist state/host.json');
    const b = new HostIdentity(tmp);
    if (b.nick !== 'Office PC' || b.label() !== 'Office PC') {
      fail('host identity must reload the nick from disk');
    }
    b.setNick('   ');
    if (b.nick !== '' || b.label() !== b.hostname) {
      fail('clearing the nick must fall back to the OS hostname');
    }
    const server = readFileSync(join(ROOT, 'src/server/index.mjs'), 'utf8');
    if (!server.includes('HostIdentity') || !server.includes('host.setNick') || !server.includes('host: hostIdentity.snapshot()')) {
      fail('the host must send identity on hello and accept host.setNick');
    }
    ok('v2 core: host identity nick + hostname');
  } catch (e) {
    fail(`host identity: ${e.message}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Home Screen install: iOS needs Apple meta + a PNG touch icon; Android wants
// 192/512 PNGs with purpose split (not "any maskable"). The tab uses the SVG.
{
  const html = readFileSync(join(ROOT, 'src/web/index.html'), 'utf8');
  const js = readFileSync(join(ROOT, 'src/web/app.js'), 'utf8');
  const css = readFileSync(join(ROOT, 'src/web/style.css'), 'utf8');
  const manifest = JSON.parse(readFileSync(join(ROOT, 'src/web/manifest.webmanifest'), 'utf8'));
  const icon = readFileSync(join(ROOT, 'src/web/icon.svg'), 'utf8');
  let failed = false;
  if (!html.includes('rel="icon"') || !html.includes('href="/icon.svg"')) {
    fail('the tab needs an SVG favicon');
    failed = true;
  }
  if (!html.includes('href="/favicon.ico"')) {
    fail('browsers that do not take an SVG favicon need favicon.ico');
    failed = true;
  }
  if (!html.includes('apple-touch-icon') || !html.includes('/apple-touch-icon.png')) {
    fail('iOS Home Screen needs an apple-touch-icon PNG');
    failed = true;
  }
  if (!html.includes('apple-mobile-web-app-capable') || !html.includes('mobile-web-app-capable')) {
    fail('installed Auto must open standalone, not as a Safari tab');
    failed = true;
  }
  if (!html.includes('id="install-block"') || !js.includes('beforeinstallprompt') || !js.includes('display-mode: standalone')) {
    fail('Settings must explain Add to Home Screen, and offer the install prompt when the browser has one');
    failed = true;
  }
  if (manifest.display !== 'standalone' || manifest.start_url !== '/') {
    fail('the manifest must open Auto standalone at /');
    failed = true;
  }
  const purposes = (manifest.icons || []).map((i) => i.purpose);
  if (purposes.some((p) => /\bany\b/.test(p) && /\bmaskable\b/.test(p))) {
    fail('manifest icon purpose must not combine any and maskable on one entry');
    failed = true;
  }
  if (!purposes.includes('any') || !purposes.includes('maskable')) {
    fail('the manifest needs both any and maskable icons');
    failed = true;
  }
  const pngs = (manifest.icons || []).filter((i) => i.type === 'image/png');
  if (!pngs.some((i) => i.sizes === '192x192') || !pngs.some((i) => i.sizes === '512x512')) {
    fail('Android install needs 192 and 512 PNG icons');
    failed = true;
  }
  if (!icon.includes('viewBox="0 0 512 512"') || !icon.includes('#0b0d12') || !icon.includes('#dfe3ea') || !icon.includes('#e5a95a')) {
    fail('icon.svg must be the full-bleed Auto mark');
    failed = true;
  }
  if (/<rect[^>]*\brx=/.test(icon)) {
    fail('the PWA icon must be full-bleed so iOS/Android can mask it — no rounded rect');
    failed = true;
  }
  const pngFiles = ['apple-touch-icon.png', 'icon-192.png', 'icon-512.png'];
  const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  for (const name of pngFiles) {
    const p = join(ROOT, 'src/web', name);
    if (!existsSync(p)) {
      fail(`missing ${name} — run node scripts/raster-icon.mjs`);
      failed = true;
      continue;
    }
    const head = readFileSync(p).subarray(0, 4);
    if (!head.equals(pngMagic)) {
      fail(`${name} is not a PNG`);
      failed = true;
    }
  }
  const icoPath = join(ROOT, 'src/web/favicon.ico');
  if (!existsSync(icoPath)) {
    fail('missing favicon.ico — run node scripts/raster-icon.mjs');
    failed = true;
  } else {
    const ico = readFileSync(icoPath);
    if (ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1 || ico.readUInt16LE(4) < 1) {
      fail('favicon.ico is not an ICO');
      failed = true;
    }
  }
  if (!html.includes('dataset.standalone') && !html.includes("dataset.standalone = ''")) {
    fail('standalone must be marked on <html> before first paint');
    failed = true;
  }
  if (!html.includes('navigator.standalone') || !html.includes('--vv-height')) {
    fail('an installed app must read the visual viewport before first paint');
    failed = true;
  }
  if (!css.includes('html[data-standalone] #app')) {
    fail('installed Auto must pin #app when standalone');
    failed = true;
  }
  if (!js.includes('function fitStandaloneShell') || !js.includes("padding-bottom', '8px'")) {
    fail('standalone must size to the visual viewport and force 8px under the composer');
    failed = true;
  }
  if (!html.includes('html[data-standalone] #composer') || !html.includes('padding-bottom: 8px !important')) {
    fail('standalone composer padding must live in index.html so a cached style.css cannot keep the 80px gap');
    failed = true;
  }
  const standaloneComposer = css.slice(css.indexOf('html[data-standalone] #composer'));
  if (!standaloneComposer.includes('padding-bottom: 8px') || /html\[data-standalone\] #composer[^}]*env\(safe-area-inset-bottom/.test(css)) {
    fail('standalone composer must not use env(safe-area-inset-bottom) — iOS reports ~80px even with the keyboard up');
    failed = true;
  }
  const topbarCss = css.slice(css.indexOf('#topbar {'), css.indexOf('#topbar-controls'));
  if (!topbarCss.includes('safe-area-inset-top')) {
    fail('the topbar must pad by safe-area-inset-top or it sits under the iOS status bar');
    failed = true;
  }
  if (!css.includes('overflow: hidden') || !/html,\s*body \{[^}]*overflow:\s*hidden/.test(css)) {
    fail('html/body must not scroll — a too-tall page clips the header on iOS');
    failed = true;
  }
  const server = readFileSync(join(ROOT, 'src/server/index.mjs'), 'utf8');
  if (!server.includes('stampHtml') || !server.includes("rel === '/index.html'") || !server.includes("'no-store'")) {
    fail('the host must fingerprint css/js in the shell and not let iOS store a stale index.html');
    failed = true;
  }
  if (!failed) ok('v2 web: Home Screen install (favicon, Apple tags, icons)');
}

{
  const { stampHtml } = await import('../src/web/stamp.mjs');
  const out = stampHtml(
    '<link href="/style.css" /><script src="/app.js"></script><link href="/style.css?v=old" /><link href="/apple-touch-icon.png" /><link href="/icon.svg" />',
    (p) => ({ '/style.css': 'aaa', '/app.js': 'bbb' }[p] || 'x'),
  );
  if (!out.includes('/style.css?v=aaa') || !out.includes('/app.js?v=bbb') || out.includes('?v=old')) {
    fail(`stampHtml must rewrite css/js URLs with ?v=, got ${out}`);
  } else if (out.includes('/apple-touch-icon.png?v=') || out.includes('/icon.svg?v=')) {
    // A query string is a way for WebKit to skip a site icon; the share sheet
    // then draws a small favicon on white instead of the full-bleed mark.
    fail(`icon URLs must stay clean, got ${out}`);
  } else {
    ok('v2 web: css/js URLs are fingerprinted from size+mtime');
  }
}

// × on a session row must archive on the first tap, and the rail must close
// when swiped left — a phone has no hover, and the row used to eat the tap.
{
  const js = readFileSync(join(ROOT, 'src/web/app.js'), 'utf8');
  const css = readFileSync(join(ROOT, 'src/web/style.css'), 'utf8');
  let failed = false;
  const row = js.slice(js.indexOf('function sessionRow'), js.indexOf('function dateBucket'));
  if (!row.includes('insideControl') || !js.includes('pointerdown')) {
    fail('the session × must stop the row from seeing the tap');
    failed = true;
  }
  if (!js.includes('dismissSession') || !js.includes('session.archive')) {
    fail('the session × must archive');
    failed = true;
  }
  const swipe = js.slice(js.indexOf('function bindRailSwipe'), js.indexOf("$('rail-toggle')"));
  if (!swipe.includes('touchmove') || !swipe.includes('passive: false')) {
    fail('a left swipe on iOS must use touchmove, not only pointer events');
    failed = true;
  }
  if (!css.includes('(hover: hover)') || !css.includes('.session:hover .close')) {
    fail('session hover styles must not apply on a phone');
    failed = true;
  }
  if (!css.includes('rail-dragging')) {
    fail('a swipe must be able to drag the rail with the finger');
    failed = true;
  }
  if (!failed) ok('v2 web: session × archives on first tap, swipe closes rail');
}

// Filtering projects on a phone must keep the list above the soft keyboard.
// iOS leaves the layout viewport alone, so a bottom sheet pinned with inset:0
// would put short result lists under the keys.
{
  const html = readFileSync(join(ROOT, 'src/web/index.html'), 'utf8');
  const css = readFileSync(join(ROOT, 'src/web/style.css'), 'utf8');
  const js = readFileSync(join(ROOT, 'src/web/app.js'), 'utf8');
  let failed = false;
  if (!js.includes('function syncVisualViewport') || !js.includes('--vv-height')) {
    fail('the web client must publish the visual viewport size for phone sheets');
    failed = true;
  }
  if (!css.includes('#newbie') || !css.includes('var(--vv-height')) {
    fail('the New session sheet must size itself to the visual viewport');
    failed = true;
  }
  if (!/interactive-widget=resizes-content/.test(html)) {
    fail('the viewport meta should ask browsers that support it to resize content for the keyboard');
    failed = true;
  }
  if (!failed) ok('v2 web: New session list stays above the keyboard');
}

// Long chats get a Photos-style scrubber: handle while scrolling, labeled
// timeline (density-weighted pills) left of the thumb while scrubbing.
{
  const html = readFileSync(join(ROOT, 'src/web/index.html'), 'utf8');
  const css = readFileSync(join(ROOT, 'src/web/style.css'), 'utf8');
  const js = readFileSync(join(ROOT, 'src/web/app.js'), 'utf8');
  let failed = false;
  if (
    !html.includes('id="chat-scrub"') ||
    !html.includes('scrub-handle') ||
    !html.includes('scrub-grip') ||
    !html.includes('scrub-timeline') ||
    !html.includes('data-mode="hint"')
  ) {
    fail('index.html must include the Photos-style chat scrubber chrome');
    failed = true;
  }
  if (
    !css.includes('#chat-scrub') ||
    !css.includes('.scrub-handle') ||
    !css.includes('.scrub-grip') ||
    !css.includes('.scrub-pill') ||
    !css.includes("[data-mode='scrub']") ||
    !css.includes('border-radius: 12px 0 0 12px')
  ) {
    fail('style.css must style hint and scrub modes');
    failed = true;
  }
  if (
    !js.includes('function bindScrubber') ||
    !js.includes('function scrubLandmarks') ||
    !js.includes('function showScrubHint') ||
    !js.includes('function enterScrubMode') ||
    !js.includes('function rebuildScrubTimeline') ||
    !js.includes('function scrubWheelProgress') ||
    !js.includes('function layoutScrubWheel') ||
    !js.includes('Math.sqrt(Math.max(0, 1 - normalized * normalized))') ||
    !js.includes('function snapScrubToEntry') ||
    !js.includes('function scrubBuzz') ||
    !js.includes('SCRUB_SNAP_PX') ||
    !js.includes('navigator.vibrate') ||
    !js.includes(".msg.user, .ask, .created-plan, .perm")
  ) {
    fail('app.js must drive the two-mode scrubber from transcript landmarks');
    failed = true;
  }
  if (!failed) ok('v2 web: chat scroll scrubber');
}

// Composer drafts stay with the chat you typed them in, and an idle send
// appears in the stream before Cursor has finished taking it — without
// drawing the host's later copy as a second bubble.
{
  const js = readFileSync(join(ROOT, 'src/web/app.js'), 'utf8');
  const sessionsJs = readFileSync(join(ROOT, 'src/core/sessions.mjs'), 'utf8');
  let failed = false;
  if (!js.includes('function saveDraft') || !js.includes('function loadDraft')) {
    fail('switching chats must park and restore the composer draft');
    failed = true;
  }
  if (!js.includes('saveDraft(state.sessionId)') || !js.includes('loadDraft(sessionId)')) {
    fail('attach must save the old draft and load the new one');
    failed = true;
  }
  if (!js.includes('pendingEchoes') || !js.includes('rememberSend') || !js.includes('!state.busy')) {
    fail('an idle send must appear in the stream immediately without duplicating');
    failed = true;
  }
  const desktopDeliver = sessionsJs.slice(
    sessionsJs.indexOf('async #deliverDesktop'),
    sessionsJs.indexOf('async #promptDesktop'),
  );
  const desktopPrompt = sessionsJs.slice(
    sessionsJs.indexOf('async #promptDesktop'),
    sessionsJs.indexOf('resumeDesktopOutbox'),
  );
  // Expect before the window write — Cursor can store the bubble while sendText
  // is still awaiting, and the watcher would otherwise publish a duplicate.
  const echoAt = desktopDeliver.indexOf('this.#expectEcho(id, text)');
  const sendAt = desktopDeliver.indexOf('.sendText(');
  if (echoAt < 0 || sendAt < 0 || echoAt > sendAt) {
    fail('a desktop send must #expectEcho before typing into Cursor’s window');
    failed = true;
  }
  if (!desktopPrompt.includes("result.status === 'queued'")) {
    fail('queued desktop sends must still be handled');
    failed = true;
  }
  if (!desktopPrompt.includes('outbox.hold') || !desktopPrompt.includes('#recentUserEcho')) {
    fail('a held or submitted desktop send must not record a user_message already mirrored from Cursor');
    failed = true;
  }
  if (!sessionsJs.includes('#seedUserDedup') || !sessionsJs.includes('#shouldSkipDesktopUser')) {
    fail('desktop user bubbles must dedupe by echo, bubble id, and restart seed');
    failed = true;
  }
  const html = readFileSync(join(ROOT, 'src/web/index.html'), 'utf8');
  const css = readFileSync(join(ROOT, 'src/web/style.css'), 'utf8');
  if (!html.includes('id="lightbox"') || !js.includes('function openLightbox') || !css.includes('#lightbox')) {
    fail('images need a zoomable lightbox, not a new tab');
    failed = true;
  }
  if (!js.includes('imageParts') || !js.includes("div('thumbs')")) {
    fail('user messages must show image thumbnails in the stream');
    failed = true;
  }
  if (!sessionsJs.includes('#userMessageFields') || !sessionsJs.includes('imageParts:')) {
    fail('transcripts must keep imageParts so a reload still shows the pictures');
    failed = true;
  }
  if (!failed) ok('v2 web: per-session drafts and immediate send');
}

// A prompt Auto typed into Cursor must not come back as a second bubble.
{
  const { echoKey, modelIdFor, cursorNameFor } = await import('../src/core/sessions.mjs');
  let failed = false;
  if (echoKey("auto's ability") !== echoKey('auto\u2019s ability')) {
    fail('a curly apostrophe is the same prompt as a straight one');
    failed = true;
  }
  if (echoKey('  hello   there  ') !== echoKey('hello there')) {
    fail('collapsed whitespace is the same prompt');
    failed = true;
  }
  if (echoKey('ok') === echoKey('okay')) {
    fail('different prompts must stay different');
    failed = true;
  }
  const catalog = [
    { modelId: 'claude-opus-5[thinking=true]', name: 'Opus 5' },
    { modelId: 'kimi-k3[]', name: 'Kimi K3' },
  ];
  if (modelIdFor('kimi-k3[]', 'Kimi K3', catalog) !== 'kimi-k3[]') {
    fail('a tapped model id must stay the stored value after a desktop switch');
    failed = true;
  }
  if (modelIdFor('Kimi K3', 'Kimi K3', catalog) !== 'kimi-k3[]') {
    fail('a Cursor model label must resolve back to a model id');
    failed = true;
  }
  if (modelIdFor('x', 'Opus 5 High', catalog) !== 'claude-opus-5[thinking=true]') {
    fail('a variant label must resolve to its model row');
    failed = true;
  }
  const slugs = [
    { modelId: 'kimi-k3[reasoning=max]', name: 'kimi-k3' },
    { modelId: 'composer-2.5[fast=true]', name: 'composer-2.5' },
    { modelId: 'claude-opus-5[thinking=true,effort=high]', name: 'claude-opus-5' },
  ];
  if (cursorNameFor('kimi-k3[reasoning=max]', slugs) !== 'kimi-k3 Max') {
    fail('a Max variant must become the row name plus Max');
    failed = true;
  }
  if (cursorNameFor('kimi-k3', slugs) !== 'kimi-k3 Max') {
    fail('a slug without brackets must still pick up the catalog id\'s Max badge');
    failed = true;
  }
  if (cursorNameFor('composer-2.5[fast=true]', slugs) !== 'composer-2.5 Fast') {
    fail('fast=true must become the Fast badge');
    failed = true;
  }
  if (cursorNameFor('claude-opus-5[thinking=true,effort=high]', slugs) !== 'claude-opus-5') {
    fail('effort=high is not a badge — High sits on several rows');
    failed = true;
  }
  if (cursorNameFor('default[]') !== 'Auto') {
    fail('default[] is Auto in Cursor\'s menu');
    failed = true;
  }
  if (cursorNameFor('Kimi K3', slugs) !== 'Kimi K3') {
    fail('a typed Cursor label must pass through');
    failed = true;
  }
  if (!failed) ok('v2 core: desktop echo matching');
}

// Account usage shaping: Cursor Models / Other Models match the dashboard.
{
  const { clearAccountUsageCache, accountUsage } = await import('../src/core/cursor-usage.mjs');
  const { cursorAccount } = await import('../src/core/cursor-auth.mjs');
  const { parseContextTokens, sumUsageCostCents } = await import('../src/core/desktop-threads.mjs');
  let failed = false;

  if (parseContextTokens('200k') !== 200_000 || parseContextTokens('1M') !== 1_000_000 || parseContextTokens('272k') !== 272_000) {
    fail('parseContextTokens must read Cursor window labels');
    failed = true;
  }
  if (sumUsageCostCents({ default: { costInCents: 100 }, 'composer-1': { costInCents: 50 } }) !== 150) {
    fail('sumUsageCostCents must total every model key');
    failed = true;
  }
  if (sumUsageCostCents({}) != null || sumUsageCostCents(null) != null) {
    fail('sumUsageCostCents must be null when Cursor wrote no cost');
    failed = true;
  }

  clearAccountUsageCache();
  const account = cursorAccount();
  if (account && typeof account !== 'object') {
    fail('cursorAccount should return an object');
    failed = true;
  }
  // Live call when Cursor is signed in on this machine; otherwise the no-auth path.
  const usage = await accountUsage({ force: true });
  if (!usage?.status) {
    fail('accountUsage must always return a status');
    failed = true;
  } else if (usage.status === 'ok') {
    if (usage.buckets?.cursorModels?.label !== 'Cursor Models') {
      fail('account usage must name the Cursor Models bucket');
      failed = true;
    }
    if (usage.buckets?.otherModels?.label !== 'Other Models') {
      fail('account usage must name the Other Models bucket');
      failed = true;
    }
    if (usage.plan?.name == null) {
      fail('account usage should include the plan name when signed in');
      failed = true;
    }
  } else if (usage.status !== 'no-auth' && usage.status !== 'error') {
    fail(`unexpected account usage status ${usage.status}`);
    failed = true;
  }
  if (!failed) ok('v2 core: Cursor account usage');
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

// 1e3. Adding to a session that is already working. A second prompt used to be
// turned away with "Session is already working", which from a phone means
// remembering to send it again later.
{
  const dir = mkdtempSync(join(tmpdir(), 'auto-queue-'));
  try {
    const { SessionManager } = await import('../src/core/sessions.mjs');
    let failed = false;

    const sessions = new SessionManager({ stateDir: dir, defaultFolder: ROOT }).init();
    const id = sessions.list()[0].id;
    // Starting the agent is what normally opens the transcript, and this test
    // never starts one.
    await sessions.transcript(id);

    // A stand-in agent whose turn lasts exactly as long as the test allows.
    const turns = [];
    let release = null;
    sessions.ensureLive = async () => {
      const runtime = sessions.live.get(id) || {};
      runtime.acpSessionId = 'acp-1';
      runtime.client = {
        running: true,
        prompt: async ({ prompt }) => {
          turns.push(prompt.map((p) => p.text).join(''));
          await new Promise((resolve) => {
            release = resolve;
          });
          return { stopReason: 'end_turn' };
        },
        cancel: () => {},
      };
      sessions.live.set(id, runtime);
      return runtime;
    };

    const first = sessions.prompt(id, { text: 'one' });
    await new Promise((r) => setTimeout(r, 10));
    if (sessions.get(id).status !== 'busy') {
      fail('a session running a turn should be busy');
      failed = true;
    }

    const queued = await sessions.prompt(id, { text: 'two' });
    if (queued?.status !== 'queued' || queued.waiting !== 1) {
      fail(`a prompt sent mid-turn should be queued, not refused: ${JSON.stringify(queued)}`);
      failed = true;
    }
    const alsoQueued = await sessions.prompt(id, { text: 'three' });
    if (alsoQueued?.waiting !== 2) {
      fail(`a second addition should join the queue: ${JSON.stringify(alsoQueued)}`);
      failed = true;
    }
    if (turns.length !== 1) {
      fail(`nothing queued may reach the agent early: ${JSON.stringify(turns)}`);
      failed = true;
    }

    // It sits in the queue until it is sent, so the stream is not a second
    // copy of something that has not gone in yet.
    const history = await sessions.history(id, 0);
    const asked = history.filter((r) => r.kind === 'user_message').map((r) => r.text);
    if (asked.join('|') !== 'one') {
      fail(`a queued message must not appear in the transcript yet: ${asked.join('|')}`);
      failed = true;
    }

    // The turn ends: the next one goes in by itself, and is written once.
    release();
    await first;
    await new Promise((r) => setTimeout(r, 30));
    if (turns[1] !== 'two') {
      fail(`the queue should drain in order: ${JSON.stringify(turns)}`);
      failed = true;
    }
    const afterTwo = (await sessions.history(id, 0))
      .filter((r) => r.kind === 'user_message')
      .map((r) => r.text);
    if (afterTwo.join('|') !== 'one|two') {
      fail(`a queued message appears when it is sent, got ${afterTwo.join('|')}`);
      failed = true;
    }

    // What is waiting can be looked at, reworded, moved to the front and thrown
    // away — the same things the IDE offers for its own queue.
    const nowQueued = async () => (await sessions.queued(id)).items.map((i) => i.text);
    let listed = await sessions.queued(id);
    if (listed.owner !== 'auto' || listed.items.length !== 1) {
      fail(`a session should report what it is holding: ${JSON.stringify(listed)}`);
    }
    if (!listed.items[0].id) fail('a queued message needs a name of its own to be acted on');

    await sessions.prompt(id, { text: 'four' });
    listed = await sessions.queued(id);
    const [waitingFirst, waitingLast] = listed.items;
    if ((await sessions.editQueued(id, waitingFirst.id, 'two, reworded')).status !== 'done') {
      fail('a queued message should be editable while it waits');
      failed = true;
    }
    if ((await nowQueued()).join('|') !== 'two, reworded|four') {
      fail(`editing should change only that message: ${(await nowQueued()).join('|')}`);
      failed = true;
    }
    if ((await sessions.sendQueuedNow(id, waitingLast.id)).status !== 'done') {
      fail('a queued message should be promotable to the front');
      failed = true;
    }
    if ((await nowQueued()).join('|') !== 'four|two, reworded') {
      fail(`send-now should put it first: ${(await nowQueued()).join('|')}`);
      failed = true;
    }
    if ((await sessions.dropQueued(id, waitingLast.id)).status !== 'done') {
      fail('a queued message should be removable');
      failed = true;
    }
    if ((await nowQueued()).join('|') !== 'two, reworded') {
      fail(`dropping should take out only that message: ${(await nowQueued()).join('|')}`);
      failed = true;
    }
    if ((await sessions.dropQueued(id, waitingLast.id)).status !== 'gone') {
      fail('a message already gone from the queue should be refused, not repeated');
      failed = true;
    }
    if ((await sessions.editQueued(id, waitingFirst.id, '   ')).status !== 'error') {
      fail('an empty edit is not an edit');
      failed = true;
    }

    // Stopping means stopping: what was queued behind the turn goes with it.
    if (!(await sessions.cancel(id))) {
      fail('cancelling a running turn should report that it did something');
      failed = true;
    }
    if (sessions.get(id).waiting) {
      fail('a cancelled turn should leave nothing queued behind it');
      failed = true;
    }
    if (release) release();
    await new Promise((r) => setTimeout(r, 20));

    if (!failed) ok('v2 core: a task can be added to a session that is already working');
  } catch (e) {
    fail(`v2 queue: ${e.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 1e4. What the host reports as running has to be something that is running.
// `live` is a scratchpad as much as a process table — a desktop chat parks its
// watcher and its echoes there — so counting the map told the phone two
// sessions were working while no agent existed at all.
{
  const dir = mkdtempSync(join(tmpdir(), 'auto-live-'));
  try {
    const { SessionManager } = await import('../src/core/sessions.mjs');
    let failed = false;

    const sessions = new SessionManager({ stateDir: dir, defaultFolder: ROOT }).init();
    const id = sessions.list()[0].id;

    if (sessions.liveCount() !== 0) fail('a fresh manager runs no agents');

    // A desktop chat's bookkeeping: a watcher and a remembered echo, no agent.
    sessions.live.set(id, { watcher: { stop() {} }, echoes: [{ text: 'hi', at: Date.now() }] });
    if (sessions.liveCount() !== 0) {
      fail(`a watched desktop chat is not a running agent, got ${sessions.liveCount()}`);
      failed = true;
    }
    if (sessions.watchingCount() !== 1) {
      fail(`a watched desktop chat should be counted as watched, got ${sessions.watchingCount()}`);
      failed = true;
    }

    // An agent that has exited is not running either.
    const other = sessions.create({ folder: ROOT });
    sessions.live.set(other.id, { client: { running: false } });
    if (sessions.liveCount() !== 0) {
      fail('an agent that has exited must not be counted as live');
      failed = true;
    }

    sessions.live.set(other.id, { client: { running: true } });
    if (sessions.liveCount() !== 1) {
      fail(`a running agent should be counted once, got ${sessions.liveCount()}`);
      failed = true;
    }

    if (!failed) ok('v2 core: only a running agent counts as a live session');
  } catch (e) {
    fail(`v2 live count: ${e.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 1e4a. Starting a session from the phone opens it in the IDE when a window
// has that folder, and falls back to an Auto-only agent with a notice if not.
{
  const dir = mkdtempSync(join(tmpdir(), 'auto-start-ide-'));
  try {
    const { SessionManager } = await import('../src/core/sessions.mjs');
    const { KIND } = await import('../src/core/transcript.mjs');
    let failed = false;

    const sessions = new SessionManager({ stateDir: dir, defaultFolder: ROOT }).init();
    sessions.cursor = {
      newChat: async () => ({ status: 'no-window', reason: 'no Cursor window has it open' }),
      ensureWindow: async () => ({ status: 'no-window', reason: 'could not open a window' }),
    };
    const meta = await sessions.startInIde({ folder: ROOT, title: 'From the phone' });
    if (meta.kind === 'desktop') {
      fail('a missing window must not pretend the session is in Cursor');
      failed = true;
    }
    if (meta.title !== 'From the phone') {
      fail(`fallback should keep the title, got ${meta.title}`);
      failed = true;
    }
    if (meta.model !== 'default[]') {
      fail(`Auto-only fallback should still prefer Auto-select, got ${meta.model}`);
      failed = true;
    }
    const recs = await sessions.history(meta.id);
    const notice = recs.find((r) => r.kind === KIND.notice);
    if (!notice?.text?.includes('only in Auto') || !notice.text.includes(ROOT)) {
      fail(`fallback should say why it is not in the IDE, got ${notice?.text}`);
      failed = true;
    }

    sessions.cursor = {
      newChat: async () => ({ status: 'created', threadId: 'not-a-real-thread' }),
      choose: async () => ({ status: 'already', picker: 'model', was: 'Auto' }),
    };
    const opened = await sessions.startInIde({ folder: ROOT, title: 'In Cursor' });
    if (opened.kind !== 'desktop' || opened.desktopThreadId !== 'not-a-real-thread') {
      fail(`a created chat should attach as desktop, got ${JSON.stringify(opened)}`);
      failed = true;
    }
    if (opened.title !== 'In Cursor' || !opened.titleLocked) {
      fail(`an explicit title should stick, got ${opened.title} locked=${opened.titleLocked}`);
      failed = true;
    }
    if (opened.model !== 'default[]') {
      fail(`a new desktop chat should land on Auto-select, got ${opened.model}`);
      failed = true;
    }
    await sessions.stop(opened.id);

    sessions.cursor = {
      newChat: async () => ({ status: 'created', threadId: 'unnamed-fresh-thread' }),
      choose: async () => ({ status: 'already', picker: 'model', was: 'Auto' }),
    };
    const unnamed = await sessions.startInIde({ folder: ROOT });
    if (unnamed.title !== 'Desktop chat' || unnamed.titleLocked) {
      fail(
        `a new desktop chat is unnamed until Cursor names it, got ${unnamed.title} locked=${unnamed.titleLocked}`,
      );
      failed = true;
    }
    await sessions.stop(unnamed.id);

    let attempts = 0;
    let chose = null;
    sessions.cursor = {
      newChat: async () => {
        attempts += 1;
        return attempts === 1
          ? { status: 'no-window', reason: 'no Cursor window has it open' }
          : { status: 'created', threadId: 'opened-after-launch' };
      },
      ensureWindow: async () => ({ status: 'opened' }),
      choose: async ({ picker, wanted }) => {
        chose = { picker, wanted };
        return { status: 'set', picker: 'model', was: 'Grok 4.6', now: 'Auto' };
      },
    };
    const launched = await sessions.startInIde({ folder: ROOT, title: 'Opened a window' });
    if (launched.kind !== 'desktop' || launched.desktopThreadId !== 'opened-after-launch') {
      fail(`a missing window should be opened, then attached, got ${JSON.stringify(launched)}`);
      failed = true;
    }
    if (attempts !== 2) fail(`should retry the chat after opening a window, tried ${attempts}`);
    if (chose?.picker !== 'model' || chose?.wanted !== 'Auto') {
      fail(`a new chat must press Auto-select, got ${JSON.stringify(chose)}`);
      failed = true;
    }
    if (launched.model !== 'default[]') {
      fail(`switching onto Auto should store default[], got ${launched.model}`);
      failed = true;
    }
    const switched = (await sessions.history(launched.id)).find(
      (r) => r.kind === KIND.notice && /now Auto/.test(r.text || ''),
    );
    if (!switched) {
      fail('changing off a inherited model should say so in the transcript');
      failed = true;
    }
    await sessions.stop(launched.id);

    if (!failed) ok('v2 core: new sessions start in the IDE, or say why they could not');
  } catch (e) {
    fail(`v2 start in ide: ${e.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  try {
    const { spawnCursor } = await import('../src/core/cursor-launch.mjs');
    const calls = [];
    spawnCursor({
      folder: 'D:\\Sevenfold\\auto',
      newWindow: true,
      debugPort: 9222,
      exe: 'C:\\Cursor.exe',
      spawnFn: (exe, args, opts) => {
        calls.push({ exe, args, opts });
        return { pid: 1, unref() {} };
      },
    });
    const { args, opts } = calls[0];
    if (!args.includes('--remote-debugging-port=9222')) fail('a first launch must pass the debug port');
    if (!args.includes('--new-window')) fail('a launch must ask for a new window');
    if (!args.includes('D:\\Sevenfold\\auto')) fail('a launch must pass the folder');
    if (!opts.detached) fail('Cursor must outlive Auto');
    ok('v2 core: Cursor is launched with a new window and the debug port');
  } catch (e) {
    fail(`v2 cursor launch: ${e.message}`);
  }
}

// 1e4b. A turn that ends without a word. Upstream can drop an answer without
// saying so, and the CLI reports the truncation as an ordinary end_turn — seen
// as thinking stopping mid-word, then a finished turn and no reply. Recorded as
// a success it is indistinguishable from one, so the phone gets silence.
{
  const dir = mkdtempSync(join(tmpdir(), 'auto-silent-'));
  try {
    const { SessionManager } = await import('../src/core/sessions.mjs');
    let failed = false;

    const sessions = new SessionManager({ stateDir: dir, defaultFolder: ROOT }).init();
    const id = sessions.list()[0].id;
    // Starting the agent is what normally opens the transcript, and this test
    // never starts one.
    const log = await sessions.transcript(id);

    // A stand-in agent. Its `say` stands in for the update stream, which is
    // where a real turn's prose comes from and where `spoke` is set.
    let say = [];
    let holding = false;
    let release = null;
    sessions.ensureLive = async () => {
      const runtime = sessions.live.get(id) || {};
      runtime.acpSessionId = 'acp-1';
      runtime.client = {
        running: true,
        prompt: async () => {
          for (const text of say) {
            sessions.live.get(id).spoke = true;
            log.append('agent_delta', { text });
          }
          if (holding) {
            await new Promise((resolve) => {
              release = resolve;
            });
          }
          return { stopReason: 'end_turn' };
        },
        cancel: () => {},
      };
      sessions.live.set(id, runtime);
      return runtime;
    };

    let mark = log.seq;
    await sessions.prompt(id, { text: 'the turn that says nothing' });
    const records = await sessions.history(id, mark);
    const cutOff = records.find((r) => r.kind === 'error' && /cut off upstream/.test(r.text || ''));
    if (!cutOff) {
      fail('a turn that ends without a reply should say so');
      failed = true;
    }
    const ended = records.find((r) => r.kind === 'turn_end');
    if (!ended?.upstreamError) {
      fail('a turn that ends without a reply is an upstream failure');
      failed = true;
    }
    if (typeof ended?.durationMs !== 'number') {
      fail('a finished turn should record how long it took');
      failed = true;
    }
    // The complaint belongs inside the turn, before the divider that closes it.
    if (cutOff && ended && cutOff.seq > ended.seq) {
      fail('the complaint should be recorded before the turn ends');
      failed = true;
    }

    // A turn that answered is left alone.
    say = ['Here is the answer.'];
    mark = log.seq;
    await sessions.prompt(id, { text: 'the turn that answers' });
    if ((await sessions.history(id, mark)).some((r) => r.kind === 'error')) {
      fail('a turn that replied must not be reported as cut off');
      failed = true;
    }

    // Stopping a turn is allowed to end it in silence; "Interrupted by user."
    // already covers that, and a second complaint would contradict it.
    say = [];
    holding = true;
    mark = log.seq;
    const stopped = sessions.prompt(id, { text: 'the turn that is stopped' });
    await new Promise((r) => setTimeout(r, 10));
    await sessions.cancel(id);
    if (release) release();
    await stopped;
    if ((await sessions.history(id, mark)).some((r) => /cut off upstream/.test(r.text || ''))) {
      fail('a stopped turn should not also be reported as cut off upstream');
      failed = true;
    }

    if (!failed) ok('v2 core: a turn that ends without a reply says it was cut off');
  } catch (e) {
    fail(`v2 silent turn: ${e.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 1e4c. A turn that spells its tool call out instead of making one. The silent
// check above cannot see it — the agent spoke, at length — so the turn was
// recorded as a clean success with control tokens for a reply.
{
  try {
    const { upstreamComplaint } = await import('../src/core/sessions.mjs');
    let failed = false;

    // Verbatim from the session where this was first seen.
    const leaked =
      'Rich material. Let me grab the product page and contact details to complete the fact base.' +
      '<|open|>toolscall tool="WebFetchargument<|sep|><|open|>argument key="url" type="string"' +
      '<|sep|>https://www.roadtech.no/produkt/stikkemaskin/<|close|>argument<|sep|><|close|>call<|sep|>';
    if (!/tool-call markup/.test(upstreamComplaint(leaked) || '')) {
      fail('a printed tool call should be reported as a lost tool call');
      failed = true;
    }

    // The older kind still says what upstream said.
    const said = 'Error: RetriableError: [resource_exhausted] Error';
    if (upstreamComplaint(said) !== said) {
      fail('an upstream error should be reported in its own words');
      failed = true;
    }

    // An answer is an answer, including one that talks about chat templates.
    for (const fine of [
      'Here is the answer. I fetched the page and it lists three products.',
      'Each turn is wrapped in a <|im_start|> token by the template.',
      'Use pipes and angles like a <| b or c |> d in prose.',
    ]) {
      if (upstreamComplaint(fine)) {
        fail(`ordinary prose must not be reported as a failure: ${fine.slice(0, 40)}`);
        failed = true;
      }
    }

    if (!failed) ok('v2 core: a printed tool call is reported, ordinary prose is not');
  } catch (e) {
    fail(`v2 leaked tool call: ${e.message}`);
  }
}

// A new desktop chat is unnamed until Cursor names it. The placeholder must
// not lock, and a name we chose here must not be overwritten.
{
  try {
    const { adoptDesktopTitle } = await import('../src/core/sessions.mjs');
    const { realTitle } = await import('../src/core/desktop-threads.mjs');
    let failed = false;

    if (realTitle('') || realTitle('Desktop chat') || realTitle('  ')) {
      fail('the placeholder is not a real title');
      failed = true;
    }
    if (realTitle('Hidden file edits session') !== 'Hidden file edits session') {
      fail('a name Cursor chose should pass through');
      failed = true;
    }

    const take = adoptDesktopTitle({ title: 'Desktop chat', titleLocked: true }, 'Plan mode content issue');
    if (take?.title !== 'Plan mode content issue') {
      fail(`a locked placeholder should still take the desktop's name, got ${JSON.stringify(take)}`);
      failed = true;
    }
    if (adoptDesktopTitle({ title: 'I named it', titleLocked: true }, 'Plan mode content issue')) {
      fail('a name chosen here must not be overwritten');
      failed = true;
    }
    if (adoptDesktopTitle({ title: 'Desktop chat', titleLocked: false }, '')) {
      fail('an empty name is not one');
      failed = true;
    }

    if (!failed) ok('v2 core: desktop chats take Cursor’s name unless renamed here');
  } catch (e) {
    fail(`v2 desktop title: ${e.message}`);
  }
}

// 1e2. Reading the blob Cursor keeps a tool call in. Built by hand rather than
// captured, so the test says what the shape is instead of only that it once was.
{
  try {
    const { decodeToolBinary } = await import('../src/core/tool-binary.mjs');
    let failed = false;

    /** Protobuf, enough of it to write a message: field number, then bytes. */
    const varint = (n) => {
      const out = [];
      let v = BigInt(n);
      do {
        const byte = Number(v & 0x7fn);
        v >>= 7n;
        out.push(v ? byte | 0x80 : byte);
      } while (v);
      return Buffer.from(out);
    };
    const bytes = (field, value) => {
      const buf = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
      return Buffer.concat([varint((field << 3) | 2), varint(buf.length), buf]);
    };
    const number = (field, value) => Buffer.concat([varint(field << 3), varint(value)]);
    const msg = (...parts) => Buffer.concat(parts);
    const call = (request, result) => msg(bytes(1, msg(bytes(1, request), bytes(2, result)))).toString('base64');

    // A command that worked: both streams, in the order a terminal showed them.
    const ran = decodeToolBinary(
      call(
        msg(bytes(1, 'npm test'), bytes(2, 'D:\\repo')),
        bytes(1, msg(bytes(5, 'all good'), bytes(6, 'a warning'), number(13, 1922))),
      ),
    );
    if (ran.command !== 'npm test' || ran.cwd !== 'D:\\repo') {
      fail(`the command and its folder should be read: ${JSON.stringify(ran)}`);
      failed = true;
    }
    if (ran.output !== 'all good\na warning') {
      fail(`both streams should come back in order: ${JSON.stringify(ran.output)}`);
      failed = true;
    }
    if (ran.exitCode !== 0 || ran.failed || !ran.finished || ran.durationMs !== 1922) {
      fail(`a finished command should read as finished and fine: ${JSON.stringify(ran)}`);
      failed = true;
    }

    // A command that broke: the answer sits in the other branch, with its code.
    const broke = decodeToolBinary(
      call(bytes(1, 'rg nothing'), bytes(2, msg(number(3, 1), bytes(6, 'no matches'), number(12, 40)))),
    );
    if (!broke.failed || broke.exitCode !== 1 || broke.output !== 'no matches') {
      fail(`a failed command should be read as failed: ${JSON.stringify(broke)}`);
      failed = true;
    }

    // Still running: an answer that is not there yet invents nothing.
    const running = decodeToolBinary(msg(bytes(1, msg(bytes(1, bytes(1, 'sleep 90'))))).toString('base64'));
    if (running.finished || running.output || running.exitCode !== null) {
      fail(`a running command has no answer to report: ${JSON.stringify(running)}`);
      failed = true;
    }

    // Escape codes are noise on a phone; carriage returns are noise anywhere.
    const coloured = decodeToolBinary(
      call(bytes(1, 'ls'), bytes(1, bytes(5, '\u001b[31mred\u001b[0m\r\ndone'))),
    );
    if (coloured.output !== 'red\ndone') {
      fail(`escape codes should be stripped: ${JSON.stringify(coloured.output)}`);
      failed = true;
    }

    // Rubbish in, nothing out — never a throw, since this reads foreign bytes.
    for (const bad of [null, '', 'not base64 at all!!', Buffer.from([0xff, 0xff]).toString('base64')]) {
      const got = decodeToolBinary(bad);
      if (got.command || got.output || got.finished) {
        fail(`unreadable input should give nothing: ${JSON.stringify(bad)}`);
        failed = true;
      }
    }

    if (!failed) ok('v2 core: a tool call reads back with its command, output and exit code');
  } catch (e) {
    fail(`v2 tool-binary: ${e.message}`);
  }
}

// 1e3. Whether a command is still running. Cursor's own marks are misleading
// here, and reading them literally lost the output of every command.
{
  try {
    const { toolStatus } = await import('../src/core/desktop-threads.mjs');
    let failed = false;
    const check = (what, got, want) => {
      if (got !== want) {
        fail(`${what}: expected ${want}, got ${got}`);
        failed = true;
      }
    };

    // Cursor writes "cancelled" for the whole time a command is in flight.
    check(
      'a command in flight in a running chat',
      toolStatus({ said: 'loading', finished: false, verdict: 'cancelled', generating: true }),
      'in_progress',
    );
    // Nothing can be running in a chat that is not.
    check(
      'the same command once the chat is idle',
      toolStatus({ said: 'loading', finished: false, verdict: 'cancelled', generating: false }),
      'cancelled',
    );
    check(
      'a command whose answer has arrived',
      toolStatus({ said: 'loading', finished: true, verdict: 'success', generating: true }),
      'completed',
    );
    check(
      'a command that broke',
      toolStatus({ said: 'completed', finished: true, failed: true, generating: true }),
      'failed',
    );
    check(
      "the desktop's own verdict of error",
      toolStatus({ said: 'completed', finished: true, verdict: 'error', generating: false }),
      'failed',
    );
    // Tools that are not commands have no answer branch to wait for.
    check(
      'a file edit Cursor calls done',
      toolStatus({ said: 'completed', finished: false, generating: true }),
      'completed',
    );

    if (!failed) ok('v2 core: a running command is told apart from a stopped one');
  } catch (e) {
    fail(`v2 tool status: ${e.message}`);
  }
}

// 1e4. Desktop tools follow Cursor’s chat lanes: edits are file changes,
// reads fold together, and a few internal calls stay off the stream.
{
  try {
    const { classifyTool, displayLabel, foldTools, isSimpleLs, diffFromPrecomputed } = {
      ...(await import('../src/core/desktop-tool-ui.mjs')),
      diffFromPrecomputed: (await import('../src/core/desktop-threads.mjs')).diffFromPrecomputed,
    };
    let failed = false;
    const check = (what, got, want) => {
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        fail(`${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
        failed = true;
      }
    };

    check('edit_file_v2 lane', classifyTool({ title: 'edit_file_v2' }).lane, 'fileChange');
    check('edit_file_v2 kind', classifyTool({ title: 'edit_file_v2' }).toolKind, 'edit');
    check('read_file_v2 lane', classifyTool({ title: 'read_file_v2' }).lane, 'group');
    check('read_file_v2 kind', classifyTool({ title: 'read_file_v2' }).toolKind, 'read');
    check(
      'shell lane',
      classifyTool({ title: 'run_terminal_command_v2', rawInput: { command: 'npm test' } }).lane,
      'card',
    );
    check(
      'shell kind',
      classifyTool({ title: 'run_terminal_command_v2', rawInput: { command: 'npm test' } }).toolKind,
      'execute',
    );
    check('apply_agent_diff', classifyTool({ title: 'apply_agent_diff' }).lane, 'hide');
    check('mcp placeholder', classifyTool({ title: 'mcp--' }).lane, 'hide');
    check('nameless mcp tool', classifyTool({ title: 'tool' }).lane, 'hide');
    check('formatted mcp placeholder', classifyTool({ title: 'MCP: tool' }).lane, 'hide');
    check('server with nameless tool', classifyTool({ title: 'cursor-ide-browser: tool' }).lane, 'hide');
    check('ask_question is the Question card, not OTHER', classifyTool({ title: 'ask_question' }).lane, 'hide');
    check('a real mcp call stays a card', classifyTool({ title: 'cursor-ide-browser: browser_cdp' }).lane, 'card');
    check('ACP Edit File stays a card', classifyTool({ title: 'Edit File', toolKind: 'edit' }).lane, 'card');
    check('ls is grouped', isSimpleLs('ls src'), true);
    check('ls with a pipe is not grouped', isSimpleLs('ls | wc'), false);

    const folded = foldTools([
      { title: 'read_file_v2', status: 'completed' },
      { title: 'read_file_v2', status: 'completed' },
      { title: 'ripgrep_raw_search', status: 'completed' },
      { title: 'edit_file_v2', rawInput: { relativeWorkspacePath: 'a.mjs' }, status: 'completed' },
      { title: 'edit_file_v2', rawInput: { relativeWorkspacePath: 'b.mjs' }, status: 'completed' },
      { title: 'apply_agent_diff', status: 'completed' },
      { title: 'run_terminal_command_v2', rawInput: { command: 'npm test' }, status: 'completed' },
    ]);
    check(
      'folded labels',
      folded.map((t) => t.label),
      ['Explored 2 files, 1 search', 'Edited 2 files', 'npm test'],
    );

    check(
      'a live search',
      foldTools([{ title: 'ripgrep_raw_search', status: 'in_progress' }]).map((t) => t.label),
      ['Exploring 1 search'],
    );
    check(
      'a finished search',
      foldTools([
        { title: 'ripgrep_raw_search', status: 'completed' },
        { title: 'ripgrep_raw_search', status: 'completed' },
        { title: 'ripgrep_raw_search', status: 'completed' },
      ]).map((t) => t.label),
      ['Searched 3 files'],
    );
    const live = foldTools([
      { title: 'read_file_v2', status: 'completed' },
      { title: 'ripgrep_raw_search', status: 'in_progress' },
    ]);
    check('a mixed live group', live.map((t) => t.label), ['Exploring 1 file, 1 search']);
    check(
      'counts stay separate from words',
      (live[0].parts || []).filter((p) => p.n != null).map((p) => p.n),
      [1, 1],
    );

    const { turnCopy, durationBits } = await import('../src/core/desktop-tool-ui.mjs');
    check('8 seconds', durationBits(8000), [8, 's']);
    check('a minute thirty', durationBits(90_000), [1, 'm ', 30, 's']);
    check('exact minutes', durationBits(120_000), [2, 'm']);
    check(
      'worked',
      turnCopy({ durationMs: 423_000, worked: true }).label,
      'Worked for 7m 3s',
    );
    check(
      'thought',
      turnCopy({ durationMs: 1000, worked: false }).label,
      'Thought for 1s',
    );
    check('no clock yet', turnCopy({ durationMs: 0, worked: true }).label, 'Done');

    const diff = diffFromPrecomputed(
      {
        lines: [
          { type: 'deleted', content: 'old' },
          { type: 'added', content: 'new' },
        ],
      },
      'src/foo.mjs',
    );
    check('precomputed diff path', diff.path, 'src/foo.mjs');
    check('precomputed diff texts', { oldText: diff.oldText, newText: diff.newText }, { oldText: 'old', newText: 'new' });

    if (displayLabel({ title: 'edit_file_v2' }) !== 'Edit file') {
      fail(`a pathless edit still needs a human name, got ${displayLabel({ title: 'edit_file_v2' })}`);
      failed = true;
    }

    if (!failed) ok('v2 core: desktop tools follow Cursor’s chat lanes');
  } catch (e) {
    fail(`v2 desktop-tool-ui: ${e.message}`);
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
    const linked = renderTurn({ text: 'see https://example.com' });
    if (!linked.includes('<a href="https://example.com">https://example.com</a>')) {
      fail('a url in the reply must be a Telegram <a>');
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

    const exploring = renderTurn({
      tools: [{ title: 'ripgrep_raw_search', status: 'in_progress' }],
    });
    if (!exploring.includes('Exploring <b>1</b> search')) {
      fail(`a live search should bold its count, got ${JSON.stringify(exploring)}`);
      failed = true;
    }

    // A command line says what a tool name cannot, and a failure is worth
    // quoting: Telegram used to show only "run_terminal_command_v2".
    const { toolLabel, failureNote } = await import('../src/core/telegram.mjs');
    if (
      toolLabel({ title: 'run_terminal_command_v2', rawInput: { command: 'npm test -- --watch' } }) !==
      'npm test -- --watch'
    ) {
      fail('a shell tool should be labelled with its command');
      failed = true;
    }
    if (toolLabel({ title: 'read_file' }) !== 'Read file') {
      fail('a desktop read should use Cursor’s name for it, not the raw tool id');
      failed = true;
    }
    if (
      toolLabel({
        title: 'edit_file_v2',
        rawInput: { relativeWorkspacePath: 'src/core/questions.mjs' },
      }) !== 'Edited questions.mjs'
    ) {
      fail('a file edit should be labelled with the file, not edit_file_v2');
      failed = true;
    }

    // Cursor writes an MCP call before it knows what it is calling.
    const { toolName } = await import('../src/core/desktop-threads.mjs');
    if (toolName({ name: 'mcp--' }) !== 'tool') {
      fail(`a call Cursor has not named yet should not be labelled "mcp--": ${toolName({ name: 'mcp--' })}`);
      failed = true;
    }
    if (toolName({ name: 'mcp-cursor-ide-browser-browser_cdp' }) !== 'cursor-ide-browser: browser_cdp') {
      fail(`an MCP call should read as server and tool: ${toolName({ name: 'mcp-cursor-ide-browser-browser_cdp' })}`);
      failed = true;
    }
    if (toolName({ name: 'run_terminal_cmd' }) !== 'run_terminal_cmd') {
      fail('an ordinary tool keeps the name Cursor gave it');
      failed = true;
    }
    if (toolName({}) !== 'tool') {
      fail('a nameless call still needs a label');
      failed = true;
    }
    const long = toolLabel({ rawInput: { command: `echo ${'x'.repeat(200)}` } });
    if (long.length > 70 || !long.endsWith('…')) {
      fail(`a long command should be cut down for a phone: ${long.length} chars`);
      failed = true;
    }
    if (toolLabel({ rawInput: { command: 'git commit -m "one\ntwo"' } }).includes('\n')) {
      fail('a label must stay on one line');
      failed = true;
    }

    if (failureNote({ status: 'completed', rawOutput: { text: 'fine', exitCode: 0 } })) {
      fail('a command that worked needs no note');
      failed = true;
    }
    // Telegram says what ran and how it ended, never what it printed: output
    // belongs where there is room to scroll.
    const note = failureNote({ status: 'failed', rawOutput: { text: 'boom\nnot found', exitCode: 1 } });
    if (note !== 'exit 1') {
      fail(`a failure should say only how it ended: ${note}`);
      failed = true;
    }
    if (failureNote({ status: 'failed', rawOutput: { text: 'boom' } }) !== 'failed') {
      fail('a failure with no exit code should still be marked as one');
      failed = true;
    }
    const shown = renderTurn({ tools: [{ label: 'rg missing', status: 'failed', failure: 'exit 1' }] });
    if (!shown.includes('✗') || !shown.includes('exit 1') || shown.includes('<code>')) {
      fail('a failed command should show how it ended, on its own line and nothing more');
      failed = true;
    }
    if (renderTurn({ tools: [{ label: 'npm test', status: 'in_progress' }] }).includes('exit')) {
      fail('a running command should show only what is running');
      failed = true;
    }
    const done = renderTurn({
      text: 'Queued messages stay in the queue.',
      conclusion: 'Worked for 7m 3s',
    });
    if (!done.includes('<i>Worked for 7m 3s</i>')) {
      fail(`a finished turn should say how long it took, got ${JSON.stringify(done.slice(-40))}`);
      failed = true;
    }

    const { questionText, planText } = await import('../src/core/telegram.mjs');
    const { parseQuestionReply, labelsForAnswer, indexesForAnswer, optionLetter, optionMatches } = await import('../src/core/questions.mjs');
    const card = {
      title: 'What should the plan change?',
      questions: [
        {
          id: 'fix',
          prompt: 'Which way?',
          options: [
            { id: 'a', label: 'Hide/fold steps' },
            { id: 'b', label: 'Keep and label' },
          ],
        },
      ],
    };
    const asked = questionText(card);
    if (asked.includes('not wired up')) {
      fail('a question on the phone should be answerable');
      failed = true;
    }
    if (!asked.includes('<b>A</b>') || !asked.includes('Hide/fold steps')) {
      fail('a question should letter its options');
      failed = true;
    }
    if (optionLetter(0, 0, 1) !== 'A' || optionLetter(1, 0, 2) !== '2A') {
      fail('letters should number only when there are several questions');
      failed = true;
    }
    const picked = parseQuestionReply('A', card.questions);
    if (picked?.selections?.fix?.[0] !== 'a' || picked.skip) {
      fail(`"A" should pick the first option, got ${JSON.stringify(picked)}`);
      failed = true;
    }
    if (parseQuestionReply('skip', card.questions)?.skip !== true) {
      fail('Skip should skip');
      failed = true;
    }
    if (parseQuestionReply('please do the first one', card.questions) !== null) {
      fail('ordinary words are a message, not an answer');
      failed = true;
    }
    const two = [
      { id: 'q1', options: [{ id: 'a', label: 'One' }, { id: 'b', label: 'Two' }] },
      { id: 'q2', options: [{ id: 'c', label: 'Three' }] },
    ];
    if (parseQuestionReply('A', two) !== null) {
      fail('"A" with several questions is ambiguous');
      failed = true;
    }
    const both = parseQuestionReply('1B 2A', two);
    if (both?.selections?.q1?.[0] !== 'b' || both?.selections?.q2?.[0] !== 'c') {
      fail(`"1B 2A" should pick both, got ${JSON.stringify(both)}`);
      failed = true;
    }
    if (labelsForAnswer(card.questions, { fix: ['b'] })[0] !== 'Keep and label') {
      fail('an answer should carry the label Cursor printed');
      failed = true;
    }
    if (indexesForAnswer(card.questions, { fix: ['b'] })[0] !== 1) {
      fail('an answer should know which option was picked');
      failed = true;
    }
    const longOpt =
      'Move the current + actions (attach files / extra composer actions) to a binder in the lower-right of the chat box';
    if (!optionMatches(longOpt, longOpt.slice(0, 24))) {
      fail('a truncated option still belongs to its label');
      failed = true;
    }
    if (optionMatches(longOpt, 'the') || optionMatches(longOpt, 'Red')) {
      fail('a short crumb is not an option match');
      failed = true;
    }
    if (!optionMatches('Red', 'A Red') || !optionMatches('Blue', 'B. Blue')) {
      fail('a lettered row still belongs to its label');
      failed = true;
    }
    if (!optionMatches('Red', 'ARed')) {
      fail('a letter glued to the label still belongs to it');
      failed = true;
    }
    if (optionMatches('Red', 'Bored') || optionMatches('Red', 'A')) {
      fail('a letter prefix is not an excuse to match the wrong word');
      failed = true;
    }

    const { classifyTool, isCreatedPlan, planFields } = await import('../src/core/desktop-tool-ui.mjs');
    if (classifyTool({ title: 'create_plan' }).toolKind !== 'plan') {
      fail('create_plan should be a plan card, not OTHER');
      failed = true;
    }
    const created = {
      title: 'create_plan',
      rawInput: { name: 'Match IDE tool stream', overview: 'Fold the cards.', plan: '# Hello' },
    };
    if (!isCreatedPlan(created) || planFields(created).name !== 'Match IDE tool stream') {
      fail('a create_plan record should expose the plan title');
      failed = true;
    }
    const said = planText(created);
    if (!said.includes('Created Plan') || !said.includes('Match IDE tool stream') || !said.includes('Fold the cards.')) {
      fail(`a plan on the phone should show title and overview: ${said}`);
      failed = true;
    }

    if (!failed) ok('v2 telegram: turn rendering, commands, failures, limits');
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
      if (read.title !== 'A desktop chat') fail(`a named thread should keep its name, got ${read.title}`);
      if (!threads.threadExists(thread)) fail('threadExists should find a thread that is there');
      if (threads.threadExists('nope')) fail('threadExists should not invent threads');
      if (threads.isHarnessPrompt('hello')) fail('ordinary prose is not a harness prompt');
      if (!threads.isHarnessPrompt('<system_notification>\nThe following task has finished.\n</system_notification>')) {
        fail('a system_notification is a harness prompt');
      }

      put.run(
        `bubbleId:${thread}:bHarness`,
        JSON.stringify({
          bubbleId: 'bHarness',
          type: 1,
          text: '<timestamp>Saturday, Aug 15, 2026, 6:38 PM (UTC+2)</timestamp>\n<system_notification>\nThe following task has finished.\n</system_notification><user_query>Briefly inform the user…</user_query>',
        }),
      );
      composer({
        fullConversationHeadersOnly: [
          ...bubbles.map((b) => ({ bubbleId: b.bubbleId })),
          { bubbleId: 'bHarness' },
        ],
      });
      const harnessed = threads.readThread(thread, { seen: new Set() });
      if (harnessed.messages.some((m) => /system_notification/.test(m.text || ''))) {
        fail('a Cursor harness notification must not appear as a chat message');
      }
      if (!harnessed.visited.includes('bHarness')) {
        fail('a harness notification must still be marked seen, or it is re-read forever');
      }

      // An unnamed thread has no title yet — "Desktop chat" is Auto's label,
      // not a name the desktop chose, and must not be reported as one.
      const blankId = '22222222-3333-4333-8444-666666666666';
      const writeBlank = (name) =>
        put.run(
          `composerData:${blankId}`,
          JSON.stringify({ name, fullConversationHeadersOnly: [] }),
        );
      writeBlank('');
      if (threads.readThread(blankId).title) {
        fail(`an unnamed thread should have no title, got ${threads.readThread(blankId).title}`);
      }
      writeBlank('Desktop chat');
      if (threads.readThread(blankId).title) {
        fail('the placeholder is not a name the desktop chose');
      }

      const namer = new threads.ThreadWatcher(blankId, { idleMs: 30, busyMs: 30 });
      const titles = [];
      namer.on('title', (t) => titles.push(t));
      namer.start();
      await new Promise((r) => setTimeout(r, 50));
      writeBlank('Named by Cursor');
      await new Promise((r) => setTimeout(r, 90));
      namer.stop();
      if (titles.join() !== 'Named by Cursor') {
        fail(`the watcher should report the desktop's name, saw ${JSON.stringify(titles)}`);
      }

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

      // A reply is written into its bubble as it is spoken. Reading it once and
      // calling it done published a prefix and threw the rest away — a long
      // answer reached the phone cut off mid-word. So a bubble of prose is
      // unfinished while the chat is generating, read again as it grows, and
      // announced once more only if it actually changed.
      const grow = (text) =>
        put.run(`bubbleId:${thread}:b8`, JSON.stringify({ bubbleId: 'b8', type: 2, text }));
      bubbles.push({ bubbleId: 'b8', type: 2, text: '' });
      composer({ chatGenerationUUID: 'writing-a-long-answer' });
      grow('The first half of an answer');

      const growing = new threads.ThreadWatcher(thread, { idleMs: 30, busyMs: 30 });
      growing.markSeen(['b1', 'b2', 'b3', 'b4', 'b6']);
      const spoken = [];
      growing.on('message', (m) => spoken.push(m.text));
      growing.start();
      await new Promise((r) => setTimeout(r, 120));
      grow('The first half of an answer, and the second half of it too');
      await new Promise((r) => setTimeout(r, 120));
      composer();
      await new Promise((r) => setTimeout(r, 150));
      growing.stop();

      const whole = 'The first half of an answer, and the second half of it too';
      if (spoken.at(-1) !== whole) {
        fail(`the whole answer should arrive, saw ${JSON.stringify(spoken)}`);
      }
      if (spoken.filter((t) => t === whole).length !== 1) {
        fail(`a finished answer should be announced once, saw ${JSON.stringify(spoken)}`);
      }
      if (!spoken.includes('The first half of an answer')) {
        fail(`a reply should show while it is written, saw ${JSON.stringify(spoken)}`);
      }
      if (!threads.readThread(thread, { seen: new Set() }).visited.includes('b8')) {
        fail('a reply in an idle chat is finished and should count as seen');
      }
      composer({ chatGenerationUUID: 'still-writing' });
      const midFlight = threads
        .readThread(thread, { seen: new Set(['b1', 'b2', 'b3', 'b4', 'b6']) })
        .messages.find((m) => m.id === 'b8');
      if (!midFlight?.pending) fail('a reply being written is not finished with');
      composer();

      // What reaches the transcript is the tail, since clients append: record
      // the whole bubble each pass and the answer reads as itself repeated.
      const { newWords, proseDelta, desktopWatchSeed } = await import('../src/core/sessions.mjs');
      if (newWords('', 'The first half') !== 'The first half') {
        fail('a first sighting is all new');
      }
      if (newWords('The first half', 'The first half and the rest') !== ' and the rest') {
        fail(`only the new tail belongs in the transcript, got ${JSON.stringify(newWords('The first half', 'The first half and the rest'))}`);
      }
      if (newWords('same', 'same') !== '') fail('nothing new is nothing to say');
      // A stale shorter snapshot must not reset the high-water mark — that was
      // the stutter: next full read appended the whole answer again.
      if (newWords('Build passes cleanly', 'Build') !== '') {
        fail('a shorter re-read of the same bubble is not news');
      }
      const rewritten = proseDelta('an early draft', 'a rewritten answer');
      if (rewritten.text !== 'a rewritten answer' || !rewritten.replace) {
        fail(`a rewritten bubble must replace, not append: ${JSON.stringify(rewritten)}`);
      }
      const appJs = readFileSync(join(ROOT, 'src/web/app.js'), 'utf8');
      if (!appJs.includes('rec.replace') || !appJs.includes('dataset.raw = rec.text')) {
        fail('the web must replace a rewritten bubble instead of appending');
      }

      const midTurn = desktopWatchSeed(
        [
          { kind: 'turn_start', ts: 1 },
          { kind: 'user_message', text: 'fix the padding' },
          { kind: 'tool_call', toolCallId: 'git-commit', status: 'in_progress' },
          { kind: 'agent_delta', text: 'Working on it.' },
        ],
        {
          visited: ['user1', 'git-commit', 'git-push', 'said', 'final'],
          messages: [
            { id: 'user1', role: 'user', text: 'fix the padding' },
            { id: 'git-commit', kind: 'tool', status: 'completed' },
            { id: 'git-push', kind: 'tool', status: 'completed' },
            { id: 'said', kind: 'text', text: 'Working on it.' },
            { id: 'final', kind: 'text', text: 'The chips are inset now.' },
          ],
        },
      );
      if (!midTurn.openTurn) fail('a turn with no turn_end is still open after a restart');
      if (midTurn.seen.includes('final')) {
        fail('a final answer that landed while we were down must not be marked seen');
      }
      if (midTurn.seen.includes('git-push')) {
        fail('a tool that finished while we were down must be read again');
      }
      if (!midTurn.seen.includes('said') || !midTurn.seen.includes('user1')) {
        fail('bubbles already in the transcript should stay seen');
      }
      if (!midTurn.drawn.has('git-commit') || !midTurn.openTools.has('git-commit')) {
        fail('an in-progress tool should still be the card we already drew');
      }
      const idle = desktopWatchSeed(
        [
          { kind: 'turn_start', ts: 1 },
          { kind: 'turn_end', ts: 2 },
        ],
        { visited: ['a', 'b'] },
      );
      if (idle.openTurn || idle.seen.join() !== 'a,b') {
        fail('an idle chat after restart should keep Cursor’s visited set');
      }

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
      // A chat with a command in flight has a turn in flight, and that is what
      // says the command is running: Cursor's own marks on the bubble do not.
      composer({ chatGenerationUUID: 'running-a-command' });

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
      composer();
      const ended = threads.readThread(thread, { seen: older });
      const done = ended.messages.find((m) => m.kind === 'tool');
      if (done?.output !== 'All checks passed.') {
        fail(`a finished command should carry its output, got ${JSON.stringify(done?.output)}`);
      }
      if (done.status !== 'completed') fail(`a finished command should read as completed, got ${done.status}`);
      if (!ended.visited.includes('b7')) fail('a finished command should count as seen');

      // The same bubble left unfinished in a chat that has stopped: whatever it
      // was doing, it is not doing it now.
      put.run(`bubbleId:${thread}:b7`, JSON.stringify(cmd));
      const abandoned = threads.readThread(thread, { seen: older });
      const stopped = abandoned.messages.find((m) => m.kind === 'tool');
      if (stopped.status !== 'cancelled' || stopped.pending) {
        fail(`a command left running in an idle chat is stopped, got ${stopped.status}`);
      }

      // A question put to a person. Cursor writes the card before it writes
      // what it asks, marks the call "completed" the moment it is drawn, and
      // says whether anyone has answered somewhere else entirely — in
      // `additionalData.status`. Reading the outer status is why a question
      // reached a phone as a finished tool call with nothing on it.
      const asking = (additionalData, params) => {
        const bubble = {
          bubbleId: 'b9',
          type: 2,
          toolFormerData: {
            name: 'ask_question',
            status: 'completed',
            ...(params ? { params: JSON.stringify(params) } : {}),
            ...(additionalData ? { additionalData } : {}),
          },
        };
        put.run(`bubbleId:${thread}:b9`, JSON.stringify(bubble));
        if (!bubbles.some((b) => b.bubbleId === 'b9')) bubbles.push(bubble);
        // The header list is what says a bubble exists; rewrite it so the new
        // one is part of the conversation rather than an orphan row.
        composer();
        return threads.readThread(thread, { seen: older }).messages.find((m) => m.id === 'b9');
      };

      const card = { questions: [{ id: 'fix', prompt: 'Which way?', options: [{ id: 'a', label: 'This way' }] }] };

      // Drawn, but Cursor has not said what it asks yet.
      const blank = asking(null, null);
      if (blank.question?.asked || blank.question?.waiting) {
        fail(`a card with no text asks nothing yet, got ${JSON.stringify(blank.question)}`);
      }

      const waiting = asking({ status: 'pending' }, card);
      if (!waiting.question?.waiting) {
        fail(`a pending question is waiting for someone, got ${JSON.stringify(waiting.question)}`);
      }
      if (waiting.question.questions[0]?.prompt !== 'Which way?') {
        fail('a question should carry what it asks');
      }
      if (waiting.question.questions[0]?.options[0]?.label !== 'This way') {
        fail('a question should carry its real options, not the card buttons');
      }
      if (!waiting.pending) fail('a question is not finished with until it is answered');
      if (abandoned.visited.includes('b9')) fail('an unanswered question must be read again');

      const answered = asking(
        { status: 'submitted', currentSelections: { fix: ['a'] }, freeformTexts: { fix: '' } },
        card,
      );
      if (answered.question?.waiting) fail('a submitted question is nobody’s business any more');
      if (answered.question.selections?.fix?.[0] !== 'a') fail('what was chosen is worth keeping');
      if (answered.pending) fail('an answered question is finished with');

      // An unfamiliar word for the state counts as still waiting, and carries
      // the word itself — being nagged is recoverable, silence is the bug.
      const strange = asking({ status: 'awaiting-user-input' }, card);
      if (!strange.question?.waiting || strange.question.state !== 'awaiting-user-input') {
        fail(`an unknown state should still wait and say so, got ${JSON.stringify(strange.question)}`);
      }

      put.run(
        `bubbleId:${thread}:b10`,
        JSON.stringify({
          bubbleId: 'b10',
          type: 2,
          toolFormerData: {
            name: 'edit_file_v2',
            status: 'completed',
            params: JSON.stringify({ relativeWorkspacePath: 'src/foo.mjs' }),
            additionalData: {
              precomputedDiff: {
                lines: [
                  { type: 'deleted', content: 'old' },
                  { type: 'added', content: 'new' },
                ],
                hasChanges: true,
              },
            },
          },
        }),
      );
      composer({
        fullConversationHeadersOnly: [
          ...bubbles.map((b) => ({ bubbleId: b.bubbleId })),
          {
            bubbleId: 'b10',
            grouping: { toolDisplayPath: 'src/foo.mjs', editLinesAdded: 1, editLinesRemoved: 1 },
          },
        ],
      });
      const edited = threads
        .readThread(thread, { seen: new Set(bubbles.map((b) => b.bubbleId)) })
        .messages.find((m) => m.id === 'b10');
      if (edited?.input?.added !== 1 || edited?.input?.removed !== 1) {
        fail(`an edit should carry the header’s line counts, got ${JSON.stringify(edited?.input)}`);
      }
      if (edited?.content?.[0]?.type !== 'diff' || edited.content[0].newText !== 'new') {
        fail(`an edit should carry Cursor’s precomputed diff, got ${JSON.stringify(edited?.content)}`);
      }

      const planning = (additionalData, params) => {
        const bubble = {
          bubbleId: 'b11',
          type: 2,
          toolFormerData: {
            name: 'create_plan',
            status: 'completed',
            ...(params ? { params: JSON.stringify(params) } : {}),
            ...(additionalData ? { additionalData } : {}),
          },
        };
        put.run(`bubbleId:${thread}:b11`, JSON.stringify(bubble));
        composer({
          fullConversationHeadersOnly: [
            ...bubbles.map((b) => ({ bubbleId: b.bubbleId })),
            { bubbleId: 'b10' },
            { bubbleId: 'b11' },
          ],
        });
        return threads.readThread(thread, { seen: new Set(['b1', 'b2', 'b3', 'b4', 'b6', 'b7', 'b9', 'b10']) })
          .messages.find((m) => m.id === 'b11');
      };

      const blankPlan = planning(null, null);
      if (blankPlan.plan?.asked) fail('a plan with no text is not ready to show');

      const written = planning(
        { reviewData: { status: 'Requested', selectedOption: 'none' }, planId: 'match_ide' },
        {
          name: 'Match IDE tool stream',
          overview: 'Fold the OTHER cards.',
          plan: '# Match Auto’s stream\n\nDo the fold.',
          todos: [{ id: 'web-fold', content: 'Fold on the web', status: 'pending' }],
        },
      );
      if (!written.plan?.asked || written.plan.name !== 'Match IDE tool stream') {
        fail(`a written plan should carry its title, got ${JSON.stringify(written.plan)}`);
      }
      if (written.plan.overview !== 'Fold the OTHER cards.') fail('a plan should carry its overview');
      if (!written.plan.markdown.includes('Do the fold.')) fail('a plan should carry its markdown');
      if (!written.plan.waiting) fail('a Requested plan is waiting to be built');
      if (!written.pending) fail('a plan waiting to be built is not finished with');
      if (written.input?.planId !== 'match_ide') fail('a plan should carry its id on the input');

      const builtPlan = planning(
        { reviewData: { status: 'Done', selectedOption: 'approve' }, planId: 'match_ide' },
        { name: 'Match IDE tool stream', overview: 'Fold the OTHER cards.', plan: '# done' },
      );
      if (builtPlan.plan?.waiting) fail('a Done plan is nobody’s to build any more');
      if (builtPlan.pending) fail('a built plan is finished with');

      const headed = planning(null, { plan: '# Smooth lyric transitions\n\nFix the clip.' });
      if (headed.plan?.name !== 'Smooth lyric transitions') {
        fail(`a plan with only markdown should take its title from the heading, got ${headed.plan?.name}`);
      }

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

    let answered = null;
    fakeSessions.pendingQuestion = () => ({
      askId: 'b9',
      questions: [
        {
          id: 'fix',
          prompt: 'Which way?',
          options: [
            { id: 'a', label: 'This way' },
            { id: 'b', label: 'That way' },
          ],
        },
      ],
    });
    fakeSessions.answerQuestion = async (id, payload) => {
      answered = { id, ...payload };
      return { status: 'pressed' };
    };
    fakeSessions.prompt = () => {
      prompted += 1;
      return new Promise(() => {});
    };
    let prompted = 0;

    await bridge.handleUpdate({ update_id: 4, message: { chat: { id: 1 }, text: 'A' } });
    if (answered?.askId !== 'b9' || answered?.selections?.fix?.[0] !== 'a') {
      fail(`a typed letter should answer the question, got ${JSON.stringify(answered)}`);
      failed = true;
    }
    if (prompted) {
      fail('a lettered answer must not go in as a prompt');
      failed = true;
    }

    answered = null;
    bridge.asks.set('b9', {
      sessionId: 's1',
      questions: fakeSessions.pendingQuestion().questions,
      chosen: {},
    });
    await bridge.handleUpdate({
      update_id: 5,
      callback_query: {
        id: 'q2',
        data: bridge.tokenFor({
          kind: 'question',
          askId: 'b9',
          questionId: 'fix',
          optionId: 'b',
          label: 'B',
        }),
      },
    });
    if (answered?.selections?.fix?.[0] !== 'b') {
      fail(`tapping an option should answer, got ${JSON.stringify(answered)}`);
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

// 1h. Telegram mirrors web/Cursor prompts, skips its own echo, and retries a
// turn whose first send failed.
{
  const dir = mkdtempSync(join(tmpdir(), 'auto-tg-mirror-'));
  try {
    const { TelegramBridge } = await import('../src/core/telegram.mjs');
    let failed = false;

    const fakeSessions = {
      activeId: 's1',
      on() {},
      get: () => ({ id: 's1', title: 't', folder: ROOT, mode: 'agent', policy: 'ask' }),
      list: () => [{ id: 's1', title: 't', folder: ROOT, active: true }],
      prompt: async () => ({ status: 'submitted' }),
    };

    const bridge = new TelegramBridge({
      sessions: fakeSessions,
      stateDir: dir,
      auth: { token: 'test', chatId: 1 },
    });
    const sent = [];
    let sendFails = 0;
    bridge.send = async (text) => {
      if (sendFails > 0) {
        sendFails -= 1;
        return null;
      }
      sent.push(String(text));
      return { message_id: sent.length };
    };
    bridge.edit = async (_id, text) => {
      sent.push(`edit:${text}`);
      return { ok: true };
    };

    await bridge.onRecord('s1', { kind: 'user_message', text: 'from the web' });
    if (!sent.some((t) => t.includes('from the web'))) {
      fail('a prompt typed on the web must appear on Telegram');
      failed = true;
    }

    sent.length = 0;
    await bridge.handleUpdate({
      update_id: 10,
      message: { chat: { id: 1 }, text: 'typed on the phone' },
    });
    await bridge.onRecord('s1', { kind: 'user_message', text: 'typed on the phone' });
    if (sent.some((t) => t === 'typed on the phone')) {
      fail('Telegram must not paste your own message back at you');
      failed = true;
    }

    sent.length = 0;
    sendFails = 1;
    await bridge.onRecord('s1', { kind: 'turn_start', ts: Date.now() });
    await bridge.onRecord('s1', { kind: 'agent_delta', text: 'hello from Auto' });
    await bridge.onRecord('s1', { kind: 'turn_end', ts: Date.now() + 1000, durationMs: 1000 });
    if (!sent.some((t) => t.includes('hello from Auto'))) {
      fail('a turn whose first send fails must still reach Telegram on retry');
      failed = true;
    }

    if (!failed) ok('v2 telegram: mirrors web prompts and retries failed sends');
  } catch (e) {
    fail(`v2 telegram mirror: ${e.message}`);
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

    // Nothing may claim to be running that is not. `live` counts agents, and
    // the desktop chats being followed are counted apart from them.
    if (typeof body.live !== 'number' || typeof body.watching !== 'number') {
      fail('/api/health should say how many agents run and how many chats are watched');
    } else if (body.live > body.sessions) {
      fail(`/api/health claims ${body.live} live of ${body.sessions} sessions`);
    } else {
      ok(`host reports ${body.live} live agent(s), ${body.watching} watched chat(s)`);
    }

    // The client is cached and revalidated rather than re-sent. Half a megabyte
    // of terminal emulator on every load was most of the time to first paint.
    try {
      const first = await fetch(`http://127.0.0.1:${PORT}/vendor/xterm.js`, {
        signal: AbortSignal.timeout(8000),
      });
      const etag = first.headers.get('etag');
      if (!first.ok || !etag) {
        fail('a static asset should come back with an ETag to revalidate against');
      } else {
        const again = await fetch(`http://127.0.0.1:${PORT}/vendor/xterm.js`, {
          headers: { 'If-None-Match': etag },
          signal: AbortSignal.timeout(8000),
        });
        const body304 = await again.text();
        if (again.status !== 304 || body304.length) {
          fail(`an unchanged asset should answer 304 and no body, got ${again.status}`);
        } else if (/no-store/.test(first.headers.get('cache-control') || '')) {
          fail('no-store means the browser may never reuse the file');
        } else {
          ok('web: unchanged assets revalidate instead of downloading again');
        }
      }
    } catch (e) {
      fail(`static caching: ${e.message}`);
    }

    // Attaching must not hand over the whole log, and a client that says where
    // it got to must not be sent what it already has.
    try {
      const { WebSocket } = await import('ws');
      /** Connect, and resolve with the first `attached` payload. */
      const attachOnce = (query = '') =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${PORT}/${query}`);
          const timer = setTimeout(() => {
            ws.close();
            reject(new Error('no attach within 20s'));
          }, 20_000);
          let bytes = 0;
          ws.on('message', (buf) => {
            bytes += buf.length;
            let msg;
            try {
              msg = JSON.parse(buf.toString());
            } catch {
              return;
            }
            if (msg.type !== 'attached') return;
            clearTimeout(timer);
            ws.close();
            resolve({ ...msg, bytes });
          });
          ws.on('error', (err) => (clearTimeout(timer), reject(err)));
        });

      const full = await attachOnce();
      if (!full.replaced) {
        fail('a replay from the start must say it replaces what the client has');
      }
      // The number here is the host's, not ours; what matters is that there is
      // one. A session that had run for two days replayed 28,000 records and
      // 27MB in a single message, and the browser never finished with it.
      if (full.records.length > 2000) {
        fail(`attach sent ${full.records.length} records; a replay must be bounded`);
      } else if (full.bytes > 8_000_000) {
        fail(`attach sent ${full.bytes} bytes; a replay must be bounded`);
      } else {
        ok(`web: attach replays ${full.records.length} records (${Math.round(full.bytes / 1024)}KB)`);
      }

      const seq = full.records.at(-1)?.seq;
      if (seq) {
        const caught = await attachOnce(`?session=${full.sessionId}&fromSeq=${seq}`);
        if (caught.replaced) {
          fail('catching up from a sequence number must add to the client, not replace it');
        } else if (caught.records.some((r) => r.seq <= seq)) {
          fail('catching up must not re-send records the client already had');
        } else if (caught.records.length > full.records.length) {
          fail('catching up sent more than a full replay');
        } else {
          ok(`web: a reconnect re-sends ${caught.records.length} record(s), not the log`);
        }
      }

      // A refresh has a session id and no fromSeq. That must still open the
      // named chat, not fall through to whichever one is active.
      const listed = await fetch(`http://127.0.0.1:${PORT}/api/sessions`, {
        signal: AbortSignal.timeout(4000),
      }).then((r) => r.json());
      const named = listed.sessions?.find((s) => s.id && s.id !== listed.activeId) || {
        id: full.sessionId,
      };
      const byUrl = await attachOnce(`?session=${named.id}`);
      if (byUrl.sessionId !== named.id) {
        fail(
          `handshake with ?session= must attach that chat, got ${byUrl.sessionId} wanted ${named.id}`,
        );
      } else {
        ok('web: a refresh with ?session= opens that chat');
      }
    } catch (e) {
      fail(`attach replay: ${e.message}`);
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
