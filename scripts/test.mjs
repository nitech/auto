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
    const { samePath } = await import('../src/core/cursor-dom.mjs');

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
        } = {},
      ) {
        this.takesPaste = takesPaste;
        this.pills = 0;
        /** messages Cursor is holding for this chat, newest last */
        this.queued = [...queued];
        this.queuedHidden = queuedHidden;
        this.deafToClicks = deafToClicks;
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
        const items = this.openMenu ? this.menus[this.openMenu] || [] : [];
        return { open: this.openMenu ? 1 : 0, items };
      }
      async pressEscape() {
        this.pressed.push('«escape»');
        this.openMenu = null;
      }
      /**
       * A real mouse press: on a picker it opens that menu, inside an open menu
       * it chooses, and choosing changes what the picker says — as Cursor's does.
       */
      async mouseAt({ x, y }) {
        this.clicks.push({ x, y });
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
          if (!item.inert) this.pickers[this.openMenu] = item.becomes || item.label;
          this.openMenu = null;
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
        this.sentWith = this.pills;
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
    const { pickItem } = await import('../src/core/cursor-cdp.mjs');
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

    if (!failed) ok('v2 web: markdown — tables, quotes, nested lists, code, escaping');
  } catch (e) {
    fail(`v2 markdown: ${e.message}`);
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

    // It shows in the transcript when it is added, not when it is sent, so
    // whoever typed it can see it landed.
    const history = await sessions.history(id, 0);
    const asked = history.filter((r) => r.kind === 'user_message').map((r) => r.text);
    if (asked.join('|') !== 'one|two|three') {
      fail(`queued messages should be in the transcript in order: ${asked.join('|')}`);
      failed = true;
    }
    if (!history.some((r) => r.kind === 'notice' && /goes in as soon as/.test(r.text || ''))) {
      fail('a queued message should say when it will go in');
      failed = true;
    }

    // The turn ends: the next one goes in by itself, and is not written twice.
    release();
    await first;
    await new Promise((r) => setTimeout(r, 30));
    if (turns[1] !== 'two') {
      fail(`the queue should drain in order: ${JSON.stringify(turns)}`);
      failed = true;
    }
    const again = (await sessions.history(id, 0)).filter((r) => r.kind === 'user_message');
    if (again.length !== 3) {
      fail(`a queued message must not be written to the transcript twice: ${again.length}`);
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
    if (toolLabel({ title: 'read_file' }) !== 'read_file') {
      fail('a tool with no command keeps its name');
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
      const { newWords } = await import('../src/core/sessions.mjs');
      if (newWords('', 'The first half') !== 'The first half') {
        fail('a first sighting is all new');
      }
      if (newWords('The first half', 'The first half and the rest') !== ' and the rest') {
        fail(`only the new tail belongs in the transcript, got ${JSON.stringify(newWords('The first half', 'The first half and the rest'))}`);
      }
      if (newWords('same', 'same') !== '') fail('nothing new is nothing to say');
      if (newWords('an early draft', 'a rewritten answer') !== 'a rewritten answer') {
        fail('a rewritten bubble goes out whole rather than being lost');
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
