/**
 * Auto v2 web client.
 *
 * A projection of the host's transcript: it attaches to a session, replays
 * from a sequence number, and renders records as they stream. The transcript
 * itself is not stored here, so a reload or a dropped connection costs
 * nothing; which chat was open is remembered, so you come back to it.
 */

import {
  initTerminals,
  openPane,
  closePane,
  resetTerminals,
  retheme,
  writeChunk,
} from './terminals.js';
import { lineDiff, collapseContext, diffStats } from './diff.js';
import { renderMarkdown, linkify } from './markdown.js';
import { initBrowser, onFrame, onStatus } from './browser.js';
import { initWorkspace, close as closeWorkspace, isOpen as workspaceIsOpen } from './workspace.js';
import {
  activityCopy,
  classifyTool,
  displayLabel,
  editCopy,
  fileStats,
  groupTally,
  isCreatedPlan,
  planFields,
  turnCopy,
} from './desktop-tool-ui.js';

const $ = (id) => document.getElementById(id);

const els = {
  app: $('app'),
  rail: $('session-list'),
  transcript: $('transcript'),
  historyLoading: $('transcript-loading'),
  box: $('box'),
  send: $('send'),
  stop: $('stop'),
  title: $('session-title'),
  folder: $('session-folder'),
  status: $('status'),
  mode: $('mode'),
  composerBox: document.querySelector('.composer-box'),
  model: $('model'),
  policy: $('policy'),
  conn: $('conn'),
  connLabel: $('conn-label'),
  sheet: $('sheet'),
  toBottom: $('to-bottom'),
  attachments: $('attachments'),
  file: $('file'),
  queue: $('queue'),
  queueCount: $('queue-count'),
  queueList: $('queue-list'),
  usage: $('usage'),
  usageSheet: $('usage-sheet'),
  usageBody: $('usage-body'),
};

const state = {
  ws: null,
  sessionId: null,
  sessions: [],
  projects: [],
  /** Cursor's own recent chats, whichever project they belong to */
  chats: [],
  lastSeq: 0,
  busy: false,
  /** toolCallId -> element, so tool_update mutates the card it belongs to */
  toolCards: new Map(),
  /** consecutive groupable/file-change calls folded into one card */
  bundle: null,
  /** requestId -> element */
  permCards: new Map(),
  /** askId -> element, so a question can be marked answered where it stands */
  askCards: new Map(),
  stream: null,
  streamKind: null,
  /** the thinking block being written to, so it can be folded when it ends */
  thinking: null,
  /** timestamp of the record currently being drawn, so replayed thinking is timed */
  now: 0,
  /** the open turn: when it started, whether tools ran, the live status line */
  turn: null,
  /** "Working…" while a turn runs; becomes "Worked for 7m 3s" when it ends */
  statusEl: null,
  /** true while history is being painted, so finished turns do not flash Working */
  replaying: false,
  lastPrompt: '',
  /** images waiting to go with the next prompt: {mimeType, data, url} */
  attachments: [],
  /** what is waiting for the turn to end: {owner, waiting, items, hidden} */
  queue: { owner: 'auto', waiting: 0, items: [] },
  /** the queued message being reworded, so the row stays an editor while typing */
  editing: null,
  /** Cursor chats dismissed with × this visit, so they do not reappear as "in Cursor" */
  dismissedChats: new Set(),
  /** unsent composer text (and images) kept per session across switches */
  drafts: new Map(),
  /** a send drawn immediately: credits that swallow the host record (and a stray echo) */
  pendingEchoes: [],
  /** latest usage snapshot for the dial / dialog */
  usage: null,
  usageTimer: null,
  /** this machine: OS hostname, optional nick, label for the rail */
  host: { hostname: '', nick: null, label: '' },
};

// ------------------------------------------------------------------ helpers

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Agent prose renders as markdown; user prose stays as typed, except that
bare http(s) URLs are links in both. Markdown `[text](url)` was already a
link; a URL sitting in the sentence was not. */
const markdown = renderMarkdown;

function nearBottom() {
  const t = els.transcript;
  return t.scrollHeight - t.scrollTop - t.clientHeight < 160;
}

/**
 * A long transcript takes a few seconds to arrive and draw. The overlay is
 * in the markup so it is there before this file runs; this only flips it.
 */
function setHistoryLoading(on) {
  els.historyLoading.hidden = !on;
  els.transcript.setAttribute('aria-busy', on ? 'true' : 'false');
}

function scrollDown(force = false) {
  if (force || nearBottom()) {
    requestAnimationFrame(() => {
      els.transcript.scrollTop = els.transcript.scrollHeight;
    });
  }
}

/**
 * Code is worth taking away, so every block carries a copy button. It lives
 * inside the <pre> and is skipped when reading the text back, which keeps the
 * markup free of a wrapper element that streaming would keep destroying.
 */
function decorate(root) {
  for (const pre of root.querySelectorAll?.('pre:not([data-copy])') ?? []) {
    pre.dataset.copy = '1';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'copy';
    b.textContent = 'Copy';
    b.setAttribute('aria-label', 'Copy code');
    b.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const text = [...pre.childNodes]
        .filter((n) => n !== b)
        .map((n) => n.textContent)
        .join('');
      try {
        await navigator.clipboard.writeText(text);
        b.textContent = 'Copied';
        b.classList.add('done');
        setTimeout(() => {
          b.textContent = 'Copy';
          b.classList.remove('done');
        }, 1200);
      } catch {
        b.textContent = 'Blocked';
      }
    };
    pre.prepend(b);
  }
}

/** The jump button only earns its place once you have scrolled away. */
function syncToBottom() {
  els.toBottom.hidden = nearBottom();
}

/**
 * Fold away the thinking once it has stopped.
 *
 * Reasoning is worth reading while it is the only thing happening and worth
 * getting out of the way the moment anything else is, so a thinking block is
 * born open and closed by whatever comes next — including the end of the turn,
 * which lands here too. A live spell of it is timed the way Cursor's is, so
 * the summary becomes "Thought for 8s" rather than staying "Thinking".
 */
function closeThinking() {
  if (!state.thinking) return;
  const started = Number(state.thinking.dataset.started || 0);
  const at = state.now || Date.now();
  const ms = started ? at - started : 0;
  if (ms >= 500) {
    const sum = state.thinking.querySelector('summary');
    if (sum) paintParts(sum, turnCopy({ durationMs: ms, worked: false }).parts);
  }
  state.thinking.open = false;
  state.thinking = null;
}

function nSpan(n) {
  const s = document.createElement('span');
  s.className = 'n';
  s.textContent = String(n);
  return s;
}

/** Draw a status line the way Cursor does: quiet words, loud counts. */
function paintParts(el, parts) {
  if (!el) return;
  el.replaceChildren(
    ...(parts || []).map((p) => {
      if (p.n == null) return document.createTextNode(p.t);
      return nSpan(p.n);
    }),
  );
}

/**
 * The line that says the turn is still going, or how long it took.
 *
 * Cursor writes "Worked for 7m 3s" / "Thought for 1s" above the answer. While
 * the turn is live the same slot says "Working…" and stays at the bottom of
 * the stream, so a finished-looking command cannot be mistaken for the end.
 */
function paintLiveStatus() {
  if (state.replaying) return;
  const el = state.statusEl && state.statusEl.isConnected ? state.statusEl : div('turn-status live');
  el.className = 'turn-status live';
  el.setAttribute('aria-live', 'polite');
  el.textContent = 'Working…';
  state.statusEl = el;
  els.transcript.appendChild(el);
  scrollDown();
}

function dropLiveStatus() {
  if (!state.statusEl?.classList.contains('live')) return;
  state.statusEl.remove();
  state.statusEl = null;
}

function beginTurn(rec) {
  state.turn = { started: rec.ts || state.now || Date.now(), worked: false, answer: null };
  paintLiveStatus();
}

function endTurn(rec) {
  settleRunningTools();
  closeThinking();
  const started = state.turn?.started || rec.ts;
  const durationMs =
    rec.durationMs > 0 ? rec.durationMs : rec.ts && started ? rec.ts - started : 0;
  const worked = Boolean(state.turn?.worked);
  const el = state.statusEl && state.statusEl.isConnected ? state.statusEl : div('turn-status');
  el.className = 'turn-status';
  el.removeAttribute('aria-live');
  paintParts(el, turnCopy({ durationMs, worked }).parts);
  const answer = state.turn?.answer;
  if (answer?.isConnected) answer.before(el);
  else if (!el.isConnected) add(el, { keepStream: true });
  state.statusEl = null;
  state.turn = null;
  decorate(els.transcript);
}

/**
 * Nothing can be running in an idle chat. Cards left "running…" after a
 * restart or a missed tool_update contradicted the idle chip, which is how
 * a finished turn looked unfinished.
 */
function settleRunningTools() {
  for (const card of els.transcript.querySelectorAll('.tool.running')) {
    card.classList.remove('running');
    card.classList.add('done');
    const word = card.querySelector('summary .state');
    if (word) word.textContent = 'stopped';
    if (!card.dataset.opened) card.open = false;
  }
  if (!state.bundle) return;
  for (const it of state.bundle.items) {
    const s = it.rec.status;
    if (s === 'in_progress' || s === 'pending') {
      it.rec.status = 'cancelled';
      paintItemStatus(it.row, 'cancelled', false);
    }
  }
  paintBundle(state.bundle);
}

function add(node, { keepStream = false } = {}) {
  if (!keepStream) {
    closeThinking();
    state.stream = null;
    state.streamKind = null;
  }
  const stick = nearBottom();
  els.transcript.appendChild(node);
  // A live "Working…" line belongs at the bottom of the stream, after
  // whatever just arrived — otherwise the last thing you see is a finished
  // command and there is no way to tell the turn is still going.
  if (state.statusEl?.classList.contains('live')) {
    els.transcript.appendChild(state.statusEl);
  }
  decorate(node);
  scrollDown(stick);
  syncToBottom();
  return node;
}

function div(cls, html) {
  const d = document.createElement('div');
  d.className = cls;
  if (html !== undefined) d.innerHTML = html;
  return d;
}

// ----------------------------------------------------------------- renderers

function renderUser(rec) {
  const node = div('msg user');
  if (rec.text) {
    const text = document.createElement('div');
    text.className = 'user-text';
    text.innerHTML = linkify(esc(rec.text));
    node.append(text);
  }
  const parts = imagePartsOf(rec);
  if (parts.length) {
    const thumbs = div('thumbs');
    for (const part of parts) {
      const src = srcOfPart(part);
      if (!src) continue;
      const img = document.createElement('img');
      img.src = src;
      img.alt = 'Attached image';
      img.loading = 'lazy';
      img.onclick = () => openLightbox(src);
      thumbs.append(img);
    }
    node.append(thumbs);
  } else if (imageCount(rec)) {
    const cap = div('cap');
    const n = imageCount(rec);
    cap.textContent = `${n} image${n === 1 ? '' : 's'} attached`;
    node.append(cap);
  }
  add(node);
}

/** Parts carried on the record, or a bare count for older transcripts. */
function imagePartsOf(rec) {
  if (Array.isArray(rec?.imageParts) && rec.imageParts.length) return rec.imageParts;
  if (Array.isArray(rec?.images) && rec.images.length && typeof rec.images[0] === 'object') {
    return rec.images;
  }
  return [];
}

function srcOfPart(part) {
  if (part?.url) return part.url;
  if (part?.data) return `data:${part.mimeType || 'image/png'};base64,${part.data}`;
  return '';
}

/** Same words already drawn for this send, so the host record is not a second bubble. */
function sameSend(a, b) {
  return (
    String(a?.text || '').trim() === String(b?.text || '').trim() &&
    imageCount(a) === imageCount(b)
  );
}

function imageCount(rec) {
  if (typeof rec?.images === 'number') return rec.images;
  if (Array.isArray(rec?.imageParts)) return rec.imageParts.length;
  if (Array.isArray(rec?.images)) return rec.images.length;
  return 0;
}

/**
 * An idle send is drawn at once; the host later writes the same user_message,
 * and Cursor may echo it again. Each credit swallows one matching record.
 */
function rememberSend(rec) {
  const now = Date.now();
  state.pendingEchoes = state.pendingEchoes.filter((e) => now - e.at < 120_000);
  state.pendingEchoes.push({
    sessionId: state.sessionId,
    text: String(rec.text || ''),
    images: imageCount(rec),
    left: 2,
    at: now,
  });
}

function takePendingEcho(rec) {
  const now = Date.now();
  state.pendingEchoes = state.pendingEchoes.filter((e) => now - e.at < 120_000);
  const hit = state.pendingEchoes.find(
    (e) => e.sessionId === state.sessionId && e.left > 0 && sameSend(e, rec),
  );
  if (!hit) return false;
  hit.left -= 1;
  if (hit.left <= 0) {
    state.pendingEchoes = state.pendingEchoes.filter((e) => e !== hit);
  }
  return true;
}

/**
 * Keep what you were typing with the chat it belongs to. Switching used to
 * carry the same words into the next box.
 */
function saveDraft(sessionId = state.sessionId) {
  if (!sessionId) return;
  const text = els.box.value;
  if (!text && !state.attachments.length) {
    state.drafts.delete(sessionId);
    return;
  }
  state.drafts.set(sessionId, {
    text,
    attachments: state.attachments.slice(),
  });
}

function loadDraft(sessionId) {
  const draft = sessionId ? state.drafts.get(sessionId) : null;
  els.box.value = draft?.text || '';
  state.attachments = draft?.attachments ? draft.attachments.slice() : [];
  renderAttachments();
  autosize();
}

function clearDraft(sessionId = state.sessionId) {
  if (sessionId) state.drafts.delete(sessionId);
}

function renderStreaming(rec) {
  const isThought = rec.kind === 'agent_thought';
  if (!state.stream || state.streamKind !== rec.kind) {
    state.streamKind = rec.kind;
    if (isThought) {
      const d = document.createElement('details');
      d.className = 'think';
      d.innerHTML = '<summary>Thinking</summary><div class="body"></div>';
      // Open while it runs: on a phone this is the only sign of life between a
      // prompt and the first words of an answer.
      d.open = true;
      d.dataset.started = String(rec.ts || Date.now());
      add(d, { keepStream: true });
      state.thinking = d;
      state.stream = d.querySelector('.body');
      state.stream.dataset.raw = '';
    } else {
      const d = div('msg agent');
      closeThinking();
      add(d, { keepStream: true });
      if (state.turn && !state.turn.answer) state.turn.answer = d;
      state.stream = d;
      state.stream.dataset.raw = '';
    }
  }
  const stick = nearBottom();
  // A desktop rewrite replaces the bubble; appending would stutter the answer.
  if (rec.replace) state.stream.dataset.raw = rec.text || '';
  else state.stream.dataset.raw += rec.text || '';
  if (isThought) state.stream.textContent = state.stream.dataset.raw;
  else state.stream.innerHTML = markdown(state.stream.dataset.raw);
  scrollDown(stick);
}

/**
 * ACP attaches richer content to tool calls than the raw input/output JSON:
 * file diffs, and images such as browser screenshots. Rendering these is what
 * makes an edit or a page visit legible at a glance.
 */
function renderContent(body, blocks, card) {
  for (const block of blocks || []) {
    if (!block) continue;

    if (block.type === 'diff') {
      body.appendChild(renderDiff(block));
      // A diff is the point of an edit, so never make the reader open it.
      if (card) {
        card.open = true;
        const label = card.querySelector('.label');
        if (label) label.textContent = (block.path || '').split(/[\\/]/).pop() || label.textContent;
      }
      continue;
    }

    if (block.type === 'content' && block.content?.type === 'image' && card) card.open = true;

    if (block.type === 'terminal') {
      const note = div('cap');
      note.textContent = `terminal ${block.terminalId || ''}`;
      body.appendChild(note);
      continue;
    }

    const inner = block.type === 'content' ? block.content : block;
    if (!inner) continue;

    if (inner.type === 'image' && inner.data) {
      const fig = div('shot');
      const img = document.createElement('img');
      img.src = `data:${inner.mimeType || 'image/png'};base64,${inner.data}`;
      img.alt = 'screenshot';
      img.loading = 'lazy';
      img.onclick = () => openLightbox(img.src);
      fig.appendChild(img);
      body.appendChild(fig);
    } else if (inner.type === 'text' && inner.text) {
      body.appendChild(div('cap', 'content'));
      const pre = document.createElement('pre');
      pre.innerHTML = `<code>${esc(inner.text)}</code>`;
      body.appendChild(pre);
    } else if (inner.type === 'resource_link' && inner.uri) {
      const p = div('cap');
      const a = document.createElement('a');
      a.href = inner.uri;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = inner.name || inner.uri;
      p.appendChild(a);
      body.appendChild(p);
    }
  }
}

/**
 * For a newly created file the agent puts unified-diff headers inside the
 * text itself (`-- /dev/null`, `++ b/path`); they are metadata, not content.
 * The marker arrives with two characters rather than the usual three.
 */
function stripDiffHeaders(oldText, newText) {
  const old = String(oldText ?? '');
  const neu = String(newText ?? '');
  const isNew = /^-{2,3} \/dev\/null/.test(old) && /^\+{2,3} /.test(neu);
  if (!isNew) return { oldText: old, newText: neu, isNew: false };
  return {
    oldText: old.split('\n').slice(1).join('\n'),
    newText: neu.split('\n').slice(1).join('\n'),
    isNew: true,
  };
}

function renderDiff(block) {
  const { oldText, newText, isNew } = stripDiffHeaders(block.oldText, block.newText);
  const rows = collapseContext(lineDiff(oldText, newText));
  const { added, removed } = diffStats(rows);

  const wrap = document.createElement('details');
  wrap.className = 'diff';
  wrap.open = true;
  wrap.innerHTML = `
    <summary>
      <span class="path"></span>
      ${isNew ? '<span class="tag">new</span>' : ''}
      <span class="stat"><span class="plus">+${added}</span> <span class="minus">−${removed}</span></span>
    </summary>`;
  wrap.querySelector('.path').textContent = (block.path || '').split(/[\\/]/).slice(-2).join('/');

  const pre = document.createElement('pre');
  pre.className = 'diff-body';
  for (const r of rows) {
    const line = document.createElement('div');
    line.className = `dl ${r.type}`;
    line.textContent = `${r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' '} ${r.text}`;
    pre.appendChild(line);
  }
  wrap.appendChild(pre);
  return wrap;
}

/** Human-friendly one-liner for a tool call. */
function toolLabel(rec) {
  return displayLabel(rec);
}

function statusWord(status, failed) {
  if (failed || status === 'failed') return 'failed';
  if (status === 'cancelled') return 'stopped';
  if (status === 'completed') return 'done';
  if (status === 'in_progress' || status === 'pending') return 'running…';
  return String(status || 'running…').replace('_', ' ');
}

function paintItemStatus(row, status, failed) {
  row.classList.toggle('failed', Boolean(failed) || status === 'failed');
  row.classList.toggle('done', status === 'completed' && !failed);
  const stateEl = row.querySelector('.state');
  if (stateEl) stateEl.textContent = statusWord(status, failed);
}

function bundleSummary(bundle) {
  const items = bundle.items;
  const running = items.some((it) => {
    const s = it.rec.status;
    return s === 'in_progress' || s === 'pending';
  });
  if (bundle.lane === 'fileChange') {
    const one = items.length === 1 ? displayLabel(items[0].rec) : '';
    return { kind: 'edit', ...editCopy(items.length, one) };
  }
  const { files, searches } = groupTally(items);
  return { kind: 'read', ...activityCopy({ files, searches, running }) };
}

function paintBundle(bundle) {
  const { card } = bundle;
  const { label, parts } = bundleSummary(bundle);
  paintParts(card.querySelector('summary .label'), parts || [{ t: label }]);
  let status = 'completed';
  let failed = false;
  for (const it of bundle.items) {
    const s = it.rec.status || 'completed';
    if (s === 'in_progress' || s === 'pending') status = 'in_progress';
    else if (s === 'failed') failed = true;
    else if (s === 'cancelled' && status !== 'in_progress') status = 'cancelled';
  }
  if (status === 'in_progress') {
    card.classList.add('running');
    card.classList.remove('done', 'failed');
  } else {
    card.classList.remove('running');
    card.classList.toggle('failed', failed);
    card.classList.toggle('done', !failed);
    if (!failed && !card.dataset.opened) card.open = false;
  }
  const stateEl = card.querySelector('summary .state');
  if (stateEl) {
    stateEl.textContent = statusWord(failed ? 'failed' : status, failed);
  }
}

function flushBundle() {
  state.bundle = null;
}

function startBundle(lane) {
  const card = document.createElement('details');
  card.className = `tool bundle ${lane === 'fileChange' ? 'files' : 'activity'}`;
  card.innerHTML = `
    <summary>
      <span class="row">
        <span class="kind"></span>
        <span class="label"></span>
        <span class="state">running…</span>
      </span>
    </summary>
    <div class="body bundle-list"></div>`;
  card.querySelector('summary').addEventListener('click', () => {
    card.dataset.opened = '1';
  });
  add(card);
  state.bundle = { lane, card, items: [] };
  return state.bundle;
}

function addBundleItem(rec, ui) {
  if (state.bundle?.lane !== ui.lane) {
    flushBundle();
    startBundle(ui.lane);
  }
  const { card } = state.bundle;
  const row = document.createElement('div');
  row.className = 'bundle-row';
  row.innerHTML = `
    <span class="row">
      <span class="kind">${esc(ui.toolKind)}</span>
      <span class="name"></span>
      <span class="stat"></span>
      <span class="state">running…</span>
    </span>
    <div class="item-body"></div>`;
  row.querySelector('.name').textContent = displayLabel(rec);
  const stats = fileStats(rec);
  if (stats) {
    row.querySelector('.stat').innerHTML =
      `<span class="plus">+${stats.added}</span> <span class="minus">−${stats.removed}</span>`;
  }
  const body = row.querySelector('.item-body');
  renderContent(body, rec.content, null);
  row.dataset.contentCount = String((rec.content || []).length);
  paintItemStatus(row, rec.status, rec.status === 'failed');
  card.querySelector('.bundle-list').appendChild(row);
  const item = { rec, ui, row };
  state.bundle.items.push(item);
  if (rec.toolCallId) state.toolCards.set(rec.toolCallId, { bundle: true, item, group: state.bundle });
  paintBundle(state.bundle);
}

function renderToolCall(rec) {
  const ui = classifyTool(rec);
  if (ui.lane === 'hide') {
    if (rec.toolCallId) state.toolCards.set(rec.toolCallId, { hidden: true });
    return;
  }
  if (state.turn) state.turn.worked = true;
  if (ui.lane === 'fileChange' || ui.lane === 'group') {
    addBundleItem(rec, ui);
    return;
  }
  flushBundle();

  if (isCreatedPlan(rec)) {
    renderCreatedPlan(rec);
    return;
  }

  const card = document.createElement('details');
  card.className = 'tool';
  card.innerHTML = `
    <summary>
      <span class="row">
        <span class="kind">${esc(ui.toolKind || rec.toolKind || 'tool')}</span>
        <span class="label"></span>
        <span class="state">running…</span>
      </span>
      <pre class="peek" hidden></pre>
    </summary>
    <div class="body"></div>`;
  card.querySelector('.label').textContent = toolLabel(rec);

  const body = card.querySelector('.body');
  if (rec.rawInput && Object.keys(rec.rawInput).length) {
    const pre = document.createElement('pre');
    pre.innerHTML = `<code>${esc(JSON.stringify(rec.rawInput, null, 2))}</code>`;
    body.appendChild(div('cap', 'input'));
    body.appendChild(pre);
  }
  renderContent(body, rec.content, card);
  // Opening a card by hand means you want it open: it stays that way when the
  // command finishes, instead of folding itself up under your thumb.
  card.querySelector('summary').addEventListener('click', () => {
    card.dataset.opened = '1';
  });
  card.dataset.contentCount = String((rec.content || []).length);
  if (rec.toolCallId) state.toolCards.set(rec.toolCallId, card);
  add(card);

  // Replayed history arrives already finished, so the card is drawn once with
  // everything on it rather than growing as it did the first time.
  const failed = rec.status === 'failed';
  if (rec.status === 'completed' || failed) {
    card.classList.add(failed ? 'failed' : 'done');
    card.querySelector('.state').textContent = failed ? 'failed' : 'done';
  } else if (ui.toolKind === 'execute' || rec.toolKind === 'execute') {
    // A command that is still going is the one thing worth watching, so its
    // output is shown as it arrives instead of behind a tap.
    card.classList.add('running');
  }
  showOutput(card, rec.rawOutput, failed);
}

function renderToolUpdate(rec) {
  const card = rec.toolCallId ? state.toolCards.get(rec.toolCallId) : null;
  if (!card || card.hidden) return;

  if (card.createdPlan) {
    paintCreatedPlan(card, {
      ...card.rec,
      ...rec,
      rawInput: rec.rawInput ? { ...card.rec.rawInput, ...rec.rawInput } : card.rec.rawInput,
      awaitingBuild: rec.awaitingBuild ?? card.rec.awaitingBuild,
    });
    return;
  }

  if (card.bundle) {
    const { item, group } = card;
    if (rec.title) item.rec = { ...item.rec, title: rec.title };
    if (rec.status) item.rec = { ...item.rec, status: rec.status };
    if (rec.rawInput) item.rec = { ...item.rec, rawInput: { ...item.rec.rawInput, ...rec.rawInput } };
    if (rec.title) item.row.querySelector('.name').textContent = displayLabel(item.rec);
    const stats = fileStats(item.rec);
    if (stats) {
      item.row.querySelector('.stat').innerHTML =
        `<span class="plus">+${stats.added}</span> <span class="minus">−${stats.removed}</span>`;
    }
    const failed = rec.status === 'failed';
    if (rec.status) paintItemStatus(item.row, rec.status, failed);
    const blocks = rec.content || [];
    const seen = Number(item.row.dataset.contentCount || 0);
    if (blocks.length > seen) {
      renderContent(item.row.querySelector('.item-body'), blocks.slice(seen), null);
      item.row.dataset.contentCount = String(blocks.length);
    }
    paintBundle(group);
    return;
  }

  const stateEl = card.querySelector('.state');
  const body = card.querySelector('.body');
  const out = rec.rawOutput;
  const failed =
    rec.status === 'failed' || (out && typeof out === 'object' && out.exitCode > 0);

  // A name that only turns up once the call is under way, as an MCP call's does.
  if (rec.title) {
    const next = { ...rec, rawInput: rec.rawInput, title: rec.title };
    card.querySelector('.label').textContent = displayLabel(next);
  }

  if (rec.status === 'completed' || rec.status === 'failed' || rec.status === 'cancelled') {
    card.classList.remove('running');
    card.classList.add(failed ? 'failed' : 'done');
    stateEl.textContent = failed ? 'failed' : rec.status === 'cancelled' ? 'stopped' : 'done';
    // Finished and fine: fold it away again, unless it was opened by hand.
    if (!failed && !card.dataset.opened) card.open = false;
  } else if (rec.status) {
    stateEl.textContent = rec.status.replace('_', ' ');
  }

  // Updates repeat the whole content array as it grows, so render only the
  // blocks this card has not seen.
  const blocks = rec.content || [];
  const seen = Number(card.dataset.contentCount || 0);
  if (blocks.length > seen) {
    const stickForContent = nearBottom();
    renderContent(body, blocks.slice(seen), card);
    card.dataset.contentCount = String(blocks.length);
    scrollDown(stickForContent);
  }

  showOutput(card, out, failed);
}

/** What a tool printed, as one lot of text. */
function outputText(out) {
  if (!out) return '';
  if (typeof out !== 'object') return String(out);

  let text = '';
  // `text` is a command's two streams already in the order a terminal showed
  // them; stdout and stderr apart is how the agent's own tools report.
  if (out.text) text += out.text;
  if (out.stdout) text += (text ? '\n' : '') + out.stdout;
  if (out.stderr) text += (text ? '\n' : '') + out.stderr;
  if (!text) text = JSON.stringify(out, null, 2);

  const notes = [];
  if (out.exitCode !== undefined && out.exitCode !== null) notes.push(`exit ${out.exitCode}`);
  if (out.durationMs) notes.push(`${(out.durationMs / 1000).toFixed(1)}s`);
  return notes.length ? `${text}\n[${notes.join(', ')}]` : text;
}

/** How many lines of a command's output a folded card shows. */
const PEEK_LINES = 6;

/**
 * Put what a tool printed under its card.
 *
 * Replaced rather than added to: a command reports as it goes, each time with
 * everything it has printed so far, so appending gave the same output three and
 * four times over on a phone.
 *
 * The end of it also stays on the folded card. A card that shuts itself when the
 * command finishes reads as a chat where nothing printed anything — you have to
 * know to tap each one — and the last few lines are the ones that say whether it
 * worked. The whole log is still a tap away.
 */
function showOutput(card, out, failed) {
  const text = outputText(out);
  if (!text) return;
  const body = card.querySelector('.body');

  const peek = card.querySelector('summary > .peek');
  if (peek) {
    const lines = text.replace(/\s+$/, '').split('\n');
    peek.textContent = lines.slice(-PEEK_LINES).join('\n');
    peek.hidden = false;
    peek.classList.toggle('more', lines.length > PEEK_LINES);
  }

  const stick = nearBottom();
  let pre = card.querySelector('.body > pre.out');
  if (!pre) {
    body.appendChild(div('cap', 'output'));
    pre = document.createElement('pre');
    pre.className = 'out';
    body.appendChild(pre);
  }
  pre.innerHTML = `<code>${esc(text)}</code>`;
  // What you actually want to read: a command that broke, and one still going.
  if (failed || card.classList.contains('running')) card.open = true;
  scrollDown(stick);
}

function renderPermission(rec) {
  const card = div('perm');
  const title = rec.toolCall?.title || rec.toolCall?.kind || 'this action';
  card.innerHTML = `
    <div class="head">Permission needed</div>
    <div class="what"></div>
    <div class="opts"></div>`;
  card.querySelector('.what').textContent = title;

  const opts = card.querySelector('.opts');
  for (const opt of rec.options || []) {
    const b = document.createElement('button');
    b.textContent = opt.name || opt.optionId;
    b.className = /reject|deny/i.test(`${opt.kind} ${opt.optionId}`) ? 'deny' : 'allow';
    b.onclick = () => {
      sendOp({ op: 'permission', requestId: rec.requestId, optionId: opt.optionId });
      opts.innerHTML = '<span class="outcome">sending…</span>';
    };
    opts.appendChild(b);
  }
  state.permCards.set(rec.requestId, card);
  add(card);
}

function renderPermissionResolved(rec) {
  const card = state.permCards.get(rec.requestId);
  if (!card) return;
  card.classList.add('resolved');
  const how = rec.cancelled
    ? 'cancelled'
    : `${rec.optionId || 'answered'}${rec.automatic ? ' (policy)' : ''}`;
  card.querySelector('.opts').innerHTML = `<span class="outcome">${esc(how)}</span>`;
}

/**
 * A question the agent is asking, with its real options.
 *
 * Not an approval, and drawn nothing like one: an approval is a short row of
 * buttons, a question is a card of sentences, sometimes several questions deep.
 * A single question with one answer each is a tap; anything more is picked
 * then submitted, because one tap cannot honestly answer two questions.
 */
function renderQuestion(rec) {
  const card = div('ask');
  card.innerHTML = '<div class="head">Question</div>';
  if (rec.title) {
    const t = div('title');
    t.textContent = rec.title;
    card.append(t);
  }

  const questions = rec.questions || [];
  const chosen = {};
  const oneTap = questions.length === 1 && !questions[0]?.multiple;
  const buttons = [];

  const sendAnswer = ({ skip = false } = {}) => {
    sendOp({
      op: 'question.answer',
      sessionId: state.sessionId,
      askId: rec.askId,
      selections: chosen,
      skip,
    });
    for (const b of buttons) b.disabled = true;
    const outcome = card.querySelector('.outcome');
    if (outcome) outcome.textContent = 'sending…';
  };

  for (const q of questions) {
    const block = div('q');
    const prompt = div('prompt');
    prompt.textContent = q.prompt || '';
    block.append(prompt);
    const opts = div('opts');
    for (const opt of q.options || []) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = opt.label || opt.id || '';
      b.onclick = () => {
        if (oneTap) {
          chosen[q.id] = [opt.id];
          sendAnswer();
          return;
        }
        const have = new Set(chosen[q.id] || []);
        if (q.multiple) {
          if (have.has(opt.id)) have.delete(opt.id);
          else have.add(opt.id);
        } else {
          have.clear();
          have.add(opt.id);
        }
        chosen[q.id] = [...have];
        for (const other of opts.querySelectorAll('button')) {
          const id = other.dataset.optionId;
          other.classList.toggle('picked', (chosen[q.id] || []).includes(id));
        }
      };
      b.dataset.optionId = opt.id;
      buttons.push(b);
      opts.append(b);
    }
    block.append(opts);
    if (q.multiple) {
      const note = div('cap');
      note.textContent = 'several answers allowed';
      block.append(note);
    }
    card.append(block);
  }

  const actions = div('opts act');
  if (!oneTap) {
    const submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'allow';
    submit.textContent = 'Submit';
    submit.onclick = () => sendAnswer();
    buttons.push(submit);
    actions.append(submit);
  }
  const skip = document.createElement('button');
  skip.type = 'button';
  skip.className = 'deny';
  skip.textContent = 'Skip';
  skip.onclick = () => sendAnswer({ skip: true });
  buttons.push(skip);
  actions.append(skip);
  card.append(actions);

  const where = div('cap outcome');
  where.textContent = oneTap ? 'Tap an option to answer.' : 'Pick, then Submit.';
  card.append(where);
  state.askCards.set(rec.askId, card);
  add(card);
}

function renderQuestionAnswered(rec) {
  const card = state.askCards.get(rec.askId);
  if (!card) return;
  card.classList.add('resolved');
  const chosen = Object.values(rec.selections || {}).flat().filter(Boolean);
  const typed = Object.values(rec.texts || {}).filter(Boolean);
  const said = [...chosen, ...typed].join(', ') || rec.state || 'answered';
  card.querySelector('.outcome').textContent = `Answered: ${said}`;
}

function renderCreatedPlan(rec) {
  const card = div('created-plan');
  card.innerHTML = `
    <div class="head">Created Plan</div>
    <div class="title"></div>
    <div class="overview"></div>
    <div class="body md" hidden></div>
    <div class="acts">
      <button type="button" class="view">View Plan</button>
      <span class="build-group">
        <button type="button" class="build">Build</button>
        <select class="build-model" aria-label="Model to build with"></select>
      </span>
    </div>
    <div class="cap outcome"></div>`;
  card.rec = rec;
  card.createdPlan = true;
  fillPlanModels(card.querySelector('.build-model'));

  card.querySelector('.view').onclick = () => {
    const body = card.querySelector('.body');
    const open = body.hidden;
    body.hidden = !open;
    card.querySelector('.view').textContent = open ? 'Hide Plan' : 'View Plan';
    if (open) card.dataset.opened = '1';
  };
  card.querySelector('.build').onclick = () => sendPlanBuild(card);

  if (rec.toolCallId) state.toolCards.set(rec.toolCallId, card);
  paintCreatedPlan(card, rec);
  add(card);
}

function fillPlanModels(select) {
  select.innerHTML = '';
  const current = document.createElement('option');
  current.value = '';
  current.textContent = 'Current model';
  select.append(current);
  for (const opt of els.model.options) {
    if (!opt.value) continue;
    const copy = document.createElement('option');
    copy.value = opt.value;
    copy.textContent = opt.textContent;
    select.append(copy);
  }
  const mine = state.sessions.find((s) => s.id === state.sessionId);
  if (mine?.model && [...select.options].some((o) => o.value === mine.model)) {
    select.value = mine.model;
  }
}

function sendPlanBuild(card) {
  const rec = card.rec || {};
  const model = card.querySelector('.build-model')?.value || '';
  const build = card.querySelector('.build');
  const outcome = card.querySelector('.outcome');
  for (const b of card.querySelectorAll('button, select')) b.disabled = true;
  if (outcome) outcome.textContent = 'building…';
  sendOp({
    op: 'plan.build',
    sessionId: state.sessionId,
    toolCallId: rec.toolCallId,
    model,
  });
  build.dataset.sent = '1';
}

function paintCreatedPlan(card, rec) {
  card.rec = { ...(card.rec || {}), ...rec };
  const fields = planFields(card.rec);
  card.querySelector('.title').textContent = fields.name;
  const overview = card.querySelector('.overview');
  overview.textContent = fields.overview;
  overview.hidden = !fields.overview;
  const body = card.querySelector('.body');
  if (fields.markdown) body.innerHTML = markdown(fields.markdown);
  const waiting = fields.awaitingBuild && card.rec.awaitingBuild !== false;
  card.classList.toggle('resolved', !waiting);
  const outcome = card.querySelector('.outcome');
  if (!waiting) {
    outcome.textContent = 'Built.';
    for (const b of card.querySelectorAll('button, select')) {
      if (!b.classList.contains('view')) b.disabled = true;
    }
  } else if (!card.querySelector('.build').dataset.sent) {
    outcome.textContent = '';
    for (const b of card.querySelectorAll('button, select')) b.disabled = false;
  }
}

function renderPlan(rec) {
  if (isCreatedPlan(rec) || rec.markdown || rec.name) {
    renderCreatedPlan(rec);
    return;
  }
  const card = div('plan', '<div class="head">Plan</div>');
  const ol = document.createElement('ol');
  for (const e of rec.entries || []) {
    const li = document.createElement('li');
    li.className = e.status || '';
    li.textContent = e.content || e.title || '';
    ol.appendChild(li);
  }
  card.appendChild(ol);
  add(card);
}

function renderError(rec) {
  const node = div('notice error');
  node.textContent = rec.text || 'error';
  if (rec.retryable && state.lastPrompt) {
    const b = document.createElement('button');
    b.className = 'retry';
    b.textContent = 'Retry';
    b.onclick = () => {
      b.disabled = true;
      submit(state.lastPrompt);
    };
    node.appendChild(b);
  }
  add(node);
}

function render(rec) {
  if (typeof rec.seq === 'number') state.lastSeq = Math.max(state.lastSeq, rec.seq);
  state.now = rec.ts || Date.now();
  if (rec.kind !== 'tool_call' && rec.kind !== 'tool_update') flushBundle();

  switch (rec.kind) {
    case 'user_message':
      if (!rec.echoed && !rec.waiting && !takePendingEcho(rec)) renderUser(rec);
      break;
    case 'agent_delta':
    case 'agent_thought':
      renderStreaming(rec);
      break;
    case 'tool_call':
      renderToolCall(rec);
      break;
    case 'tool_update':
      renderToolUpdate(rec);
      break;
    case 'permission_request':
      renderPermission(rec);
      break;
    case 'permission_resolved':
      renderPermissionResolved(rec);
      break;
    case 'question':
      renderQuestion(rec);
      break;
    case 'question_answered':
      renderQuestionAnswered(rec);
      break;
    case 'plan':
      renderPlan(rec);
      break;
    case 'terminal_chunk':
      writeChunk(rec);
      break;
    case 'error':
      renderError(rec);
      break;
    case 'turn_end':
      endTurn(rec);
      break;
    case 'notice': {
      const el = div('notice');
      el.textContent = rec.text || '';
      add(el);
      break;
    }
    case 'turn_start':
      beginTurn(rec);
      break;
    case 'session_start':
    case 'session_info':
    case 'commands':
      break;
    default:
      break;
  }
}

// -------------------------------------------------------------------- rail

/**
 * A div that acts like a button should answer to a keyboard like one. Rows are
 * divs because they hold their own controls, so they borrow the semantics.
 */
function actsAsButton(node, run) {
  node.setAttribute('role', 'button');
  node.tabIndex = 0;
  node.onclick = run;
  node.onkeydown = (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    run();
  };
}

/**
 * A control inside a clickable row. The first tap on a phone used to belong
 * to the row — on the open session that just closed the rail, so × looked
 * like it needed a second press to archive.
 */
function insideControl(node, run) {
  let x = 0;
  let y = 0;
  let last = 0;
  node.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    x = e.clientX;
    y = e.clientY;
  });
  node.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
  const go = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const pt = e.changedTouches?.[0] || e;
    const cx = pt.clientX ?? x;
    const cy = pt.clientY ?? y;
    if (Math.hypot(cx - x, cy - y) > 16) return;
    const now = Date.now();
    if (now - last < 400) return;
    last = now;
    run();
  };
  node.addEventListener('click', go);
  // iOS can apply :hover on the first tap and skip click; touchend still fires.
  node.addEventListener('touchend', go, { passive: false });
}

function dismissSession(item) {
  if (item.chatId) state.dismissedChats.add(item.chatId);
  state.sessions = state.sessions.filter((s) => s.id !== item.id);
  renderRail();
  sendOp({ op: 'session.archive', sessionId: item.id });
}

const sameFolder = (a, b) =>
  String(a || '').replace(/[\\/]+$/, '').toLowerCase() ===
  String(b || '').replace(/[\\/]+$/, '').toLowerCase();

/**
 * One row in the rail — either a session Auto is running, or a chat sitting
 * in Cursor that you have not opened here yet. They look alike on purpose:
 * tapping either one puts you in that conversation.
 */
function sessionRow(item) {
  const row = div('session' + (item.id && item.id === state.sessionId ? ' active' : ''));
  const dot = div(`dot ${item.session ? item.status || 'idle' : 'resting'}`);
  const meta = div('meta');

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = item.title || 'session';
  meta.append(name);

  // Anything with a thread id is the IDE's conversation, whether or not Auto
  // has opened it yet.
  const sub = document.createElement('span');
  sub.className = 'sub';
  sub.textContent = [item.project, item.chatId ? 'in Cursor' : ''].filter(Boolean).join(' · ');
  if (sub.textContent) meta.append(sub);

  row.append(dot, meta);

  // Only Auto's own list can be tidied; a chat belongs to the IDE.
  if (item.session) {
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'close';
    close.textContent = '×';
    close.title = 'Archive session';
    insideControl(close, () => dismissSession(item));
    row.append(close);
  }

  row.title = item.session
    ? item.title
    : `${item.title} — open it here; the same chat as in Cursor`;
  actsAsButton(row, () => {
    if (item.session) return attach(item.id);
    row.classList.add('busy');
    sendOp({ op: 'desktop.continue', chatId: item.chatId, folder: item.folder });
    return undefined;
  });
  return row;
}

/** The headings Cursor's own history uses. */
function dateBucket(ms) {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 86_400_000;
  if (!ms) return 'Older';
  if (ms >= midnight) return 'Today';
  if (ms >= midnight - day) return 'Yesterday';
  if (ms >= midnight - 7 * day) return 'Previous 7 days';
  if (ms >= midnight - 30 * day) return 'Previous 30 days';
  return new Date(ms).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

/**
 * Everything you might want to carry on with, newest first: Auto's sessions
 * and Cursor's chats in one list, since from here they are the same kind of
 * thing. A chat already open in Auto appears once, as the session.
 */
function conversations() {
  const rows = state.sessions.map((s) => ({
    session: true,
    id: s.id,
    chatId: s.desktopThreadId || null,
    title: s.title || 'session',
    status: s.status,
    folder: s.folder,
    project: (s.folder || '').split(/[\\/]/).filter(Boolean).pop() || '',
    at: Date.parse(s.updatedAt || s.createdAt || '') || 0,
  }));

  const open = new Set(rows.map((r) => r.chatId).filter(Boolean));
  for (const c of state.chats) {
    if (open.has(c.id) || state.dismissedChats.has(c.id)) continue;
    rows.push({
      session: false,
      id: null,
      chatId: c.id,
      title: c.title,
      folder: c.folder,
      project: c.project,
      at: c.updatedAt || c.createdAt || 0,
    });
  }

  return rows.sort((a, b) => b.at - a.at);
}

/**
 * The rail reads like Cursor's own history: one list of conversations, newest
 * first, under date headings. Projects follow at the bottom — you need them to
 * start work somewhere new, and to reach chats older than this list goes.
 */
function renderRail() {
  els.rail.innerHTML = '';

  let heading = null;
  for (const item of conversations()) {
    const bucket = dateBucket(item.at);
    if (bucket !== heading) {
      heading = bucket;
      const head = div('rail-group');
      head.textContent = bucket;
      els.rail.appendChild(head);
    }
    els.rail.appendChild(sessionRow(item));
  }

  if (!els.rail.childElementCount) {
    const empty = div('rail-empty');
    empty.textContent = 'No conversations yet.';
    els.rail.appendChild(empty);
  }

  const projects = state.projects.length
    ? state.projects
    : [...new Set(state.sessions.map((s) => s.folder))].map((path) => ({
        path,
        name: (path || '').split(/[\\/]/).pop(),
        open: false,
      }));
  if (!projects.length) return;

  const more = document.createElement('details');
  more.className = 'more-projects';
  const summary = document.createElement('summary');
  summary.textContent = `Projects (${projects.length})`;
  more.append(summary);
  for (const project of projects) {
    more.append(projectHeader(project, 0));
    const chats = desktopChatsBlock(project);
    if (chats) more.append(chats);
  }
  els.rail.appendChild(more);
}

/**
 * Chats you had in the desktop app. They are not Auto's, so they only load
 * when you ask for them; opening one gives you a session pointing at the
 * IDE's own thread, which both ends then share.
 */
function desktopChatsBlock(project) {
  if (!project.desktopChats || !project.path) return null;

  const box = document.createElement('details');
  box.className = 'desktop-chats';
  const summary = document.createElement('summary');
  summary.textContent = `${project.desktopChats} desktop ${project.desktopChats === 1 ? 'chat' : 'chats'}`;
  box.append(summary);

  const body = div('desktop-chat-list');
  body.textContent = 'Loading…';
  box.append(body);

  box.ontoggle = () => {
    if (!box.open) return;
    state.chatTarget = project.path;
    sendOp({ op: 'desktop.chats', folder: project.path });
  };
  box.dataset.folder = project.path;
  return box;
}

function renderDesktopChats(folder, chats) {
  const box = [...document.querySelectorAll('.desktop-chats')].find(
    (el) => sameFolder(el.dataset.folder, folder),
  );
  if (!box) return;
  const body = box.querySelector('.desktop-chat-list');
  body.innerHTML = '';

  if (!chats.length) {
    body.textContent = 'No chats found for this folder.';
    return;
  }

  for (const c of chats) {
    const row = div('desktop-chat');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = c.title;
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = c.attached
      ? 'open here'
      : [c.subtitle, c.updatedAt ? new Date(c.updatedAt).toLocaleDateString() : '']
          .filter(Boolean)
          .join(' · ');
    row.append(name, sub);
    row.title = 'Open this chat — the same conversation as in Cursor';
    actsAsButton(row, () => {
      row.classList.add('busy');
      sub.textContent = 'Opening…';
      sendOp({ op: 'desktop.continue', chatId: c.id, folder });
    });
    body.append(row);
  }
}

function projectHeader(project, count) {
  const head = div('project' + (project.open ? ' open' : ''));

  const name = document.createElement('span');
  name.className = 'project-name';
  name.textContent = project.name || project.path || 'Other';
  name.title = project.path || '';

  const note = document.createElement('span');
  note.className = 'project-note';
  const bits = [];
  if (project.open) bits.push('open in Cursor');
  if (count) bits.push(`${count} here`);
  else if (project.desktopChats) bits.push(`${project.desktopChats} chats`);
  note.textContent = bits.join(' · ');

  const add = document.createElement('button');
  add.className = 'close';
  add.textContent = '+';
  add.title = `New session in ${project.name || 'this folder'}`;
  add.onclick = (e) => {
    e.stopPropagation();
    if (project.path) sendOp({ op: 'session.create', folder: project.path });
  };

  // Tapping the project is the phone-sized target: go to its newest session,
  // or start one if it has none.
  actsAsButton(head, () => {
    if (!project.path) return;
    const mine = state.sessions.filter((s) => sameFolder(s.folder, project.path));
    if (mine.length) attach(mine[0].id);
    else sendOp({ op: 'session.create', folder: project.path });
  });

  head.append(name, note, add);
  return head;
}

/**
 * What the model <select> should say for a catalog row.
 *
 * The agent names models as slugs (`kimi-k3`) while Cursor's menu uses words
 * (`Kimi K3`). Hyphens become spaces so the chip matches what the IDE shows.
 */
function modelOptionLabel(m) {
  if (m.modelId === 'default[]') return 'Auto-select (Cursor picks)';
  const name = String(m.name || m.modelId || '').replace(/\[.*$/, '');
  if (/\s/.test(name) || !name.includes('-')) return m.name || m.modelId;
  return name
    .split('-')
    .map((part) => (part && /[a-z]/.test(part[0]) ? part[0].toUpperCase() + part.slice(1) : part))
    .join(' ');
}

/**
 * The model list comes from the agent, not from us — 33 entries whose ids
 * carry their options. Keep the id as the value and show the friendly name.
 */
function renderModels(models) {
  if (!models?.length || els.model.dataset.filled === String(models.length)) return;
  els.model.innerHTML = '';
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.modelId;
    opt.textContent = modelOptionLabel(m);
    els.model.append(opt);
  }
  els.model.dataset.filled = String(models.length);
}

/**
 * Point the model <select> at a session's choice.
 *
 * Options are keyed by model id. After a desktop switch Auto used to store
 * Cursor's label instead, which matched no option and left the control blank
 * even though a model was selected. Fall back to the friendly name (and to a
 * label Cursor's menu would show) so an already-wrong stored value still paints.
 */
function selectModel(modelId, modelName) {
  if (!els.model.options.length) return;
  const options = [...els.model.options];
  if (modelId && options.some((o) => o.value === modelId)) {
    els.model.value = modelId;
    return;
  }
  const name = String(modelName || modelId || '').trim();
  if (!name) return;
  const byName = options.find((o) => o.textContent === name);
  if (byName) {
    els.model.value = byName.value;
    return;
  }
  const byPrefix = options
    .filter((o) => o.textContent && name.toLowerCase().startsWith(o.textContent.toLowerCase()))
    .sort((a, b) => b.textContent.length - a.textContent.length)[0];
  if (byPrefix) els.model.value = byPrefix.value;
}

/**
 * Cursor's current modes, in the order the IDE lists them. The catalog from
 * an ACP session may only name three of these; Debug and Multitask still
 * belong in the picker, because a desktop chat has them.
 */
const CURSOR_MODES = [
  { id: 'agent', name: 'Agent' },
  { id: 'plan', name: 'Plan' },
  { id: 'debug', name: 'Debug' },
  { id: 'multitask', name: 'Multitask' },
  { id: 'ask', name: 'Ask' },
];

function canonicalModeId(raw) {
  const id = String(raw || 'agent').toLowerCase();
  return id === 'chat' ? 'ask' : id;
}

function mergeModes(modes) {
  const byId = new Map(CURSOR_MODES.map((m) => [m.id, { ...m }]));
  for (const m of modes || []) {
    const id = canonicalModeId(m.id || m);
    if (!id) continue;
    byId.set(id, { id, name: m.name || byId.get(id)?.name || id });
  }
  const known = CURSOR_MODES.map((m) => byId.get(m.id)).filter(Boolean);
  const extra = [...byId.values()].filter((m) => !CURSOR_MODES.some((k) => k.id === m.id));
  return [...known, ...extra];
}

/**
 * The ring, the send button, and the mode word all take the hue for the
 * mode in force — Agent blue, Plan amber, Ask green, Debug red, Multitask
 * purple — the same map Cursor uses on its own chat box.
 */
function paintMode(mode = els.mode.value) {
  if (!els.composerBox) return;
  els.composerBox.dataset.mode = canonicalModeId(mode);
}

/**
 * Modes travel with the same catalog. The five in the markup are the ones
 * Cursor currently offers; whatever else the agent names is appended.
 */
function renderModes(modes) {
  const list = mergeModes(modes);
  const ids = list.map((m) => m.id).join(',');
  if (els.mode.dataset.filled === ids) return;
  const was = els.mode.value;
  els.mode.innerHTML = '';
  for (const m of list) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name || m.id;
    els.mode.append(opt);
  }
  // Keep the session's choice selected if the new list still contains it.
  if ([...els.mode.options].some((o) => o.value === was)) els.mode.value = was;
  els.mode.dataset.filled = ids;
  paintMode();
}

function applyMeta(meta) {
  if (!meta) return;
  els.title.textContent = meta.title || 'session';
  els.folder.textContent = meta.folder || '';
  els.mode.value = canonicalModeId(meta.mode);
  els.policy.value = meta.policy || 'ask';
  paintMode(meta.mode);
  // A session that has never run has no model yet; leave the picker as-is.
  if (meta.model) selectModel(meta.model, meta.modelName);
  setBusy(meta.status === 'busy');
  els.status.textContent = meta.status === 'busy' ? 'working' : meta.status || 'idle';
  els.status.className = `chip ${meta.status === 'busy' ? 'busy' : meta.status === 'error' ? 'error' : ''}`;
}

/**
 * Both buttons while a turn runs: stop it, or add to it.
 *
 * Sending used to be impossible until the agent was free, which meant holding a
 * thought until you noticed the turn had ended. Anything sent now joins a queue
 * and goes in when the turn finishes, so the button stays live and says which of
 * the two it is doing.
 */
function setBusy(busy) {
  const was = state.busy;
  state.busy = busy;
  els.stop.hidden = !busy;
  els.send.title = busy ? 'Add to the queue' : 'Send';
  els.send.setAttribute('aria-label', els.send.title);
  els.send.classList.toggle('queueing', busy);
  els.box.placeholder = busy ? 'Add to the queue…' : 'Message the agent…';
  syncSend();
  if (state.replaying) return;
  if (busy && !was) paintLiveStatus();
  if (!busy && was) {
    settleRunningTools();
    dropLiveStatus();
  }
}

/** Send is only live when there is something to send. */
function syncSend() {
  els.send.disabled = !(els.box.value.trim() || state.attachments.length);
}

// ------------------------------------------------------------------ socket

function sendOp(msg) {
  if (state.ws?.readyState === 1) state.ws.send(JSON.stringify(msg));
}

/**
 * Which chat this tab was looking at. The host's active session is shared with
 * Telegram, so it is a poor stand-in: a /switch there, or another tab, would
 * steal this one on reload. The URL is this tab's; localStorage is for opening
 * Auto at `/` (the PWA start URL) and still landing in the same conversation.
 */
const SESSION_KEY = 'auto.session';

function rememberedSession() {
  try {
    const fromUrl = new URLSearchParams(location.search).get('session');
    if (fromUrl) return fromUrl;
    return localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

function rememberSession(id) {
  if (!id) return;
  try {
    localStorage.setItem(SESSION_KEY, id);
  } catch {
    /* private mode: the choice lasts as long as the page does */
  }
  const url = new URL(location.href);
  if (url.searchParams.get('session') === id) return;
  url.searchParams.set('session', id);
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

function attach(sessionId) {
  if (sessionId === state.sessionId) {
    setRail(false);
    return;
  }
  saveDraft(state.sessionId);
  state.sessionId = sessionId;
  rememberSession(sessionId);
  state.lastSeq = 0;
  state.pendingEchoes = [];
  els.transcript.innerHTML = '';
  state.toolCards.clear();
  state.bundle = null;
  state.permCards.clear();
  state.askCards.clear();
  state.stream = null;
  state.thinking = null;
  state.statusEl = null;
  state.turn = null;
  resetTerminals();
  loadDraft(sessionId);
  setHistoryLoading(true);
  setRail(false);
  sendOp({ op: 'attach', sessionId, fromSeq: 0 });
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  // Say what is already on screen. The host replays the moment it accepts the
  // socket, so this has to travel with the handshake rather than be asked for
  // afterwards; without it every dropped connection redraws the conversation
  // from scratch, which on a flaky phone connection is most of them.
  // A first load has no lastSeq — that used to omit the session entirely, and
  // the host then opened whichever chat was active, not the one this tab had.
  const q = new URLSearchParams();
  const sessionId = state.sessionId || rememberedSession();
  if (sessionId) q.set('session', sessionId);
  if (state.sessionId && sessionId === state.sessionId && state.lastSeq) {
    q.set('fromSeq', String(state.lastSeq));
  }
  const query = q.toString();
  // A reconnect that already has the conversation on screen should not cover
  // it; a first load (or a replay from scratch) has nothing else to show.
  if (!state.lastSeq) setHistoryLoading(true);
  const ws = new WebSocket(`${proto}://${location.host}/${query ? `?${query}` : ''}`);
  state.ws = ws;

  ws.onopen = () => {
    els.conn.className = 'dot ok';
    els.connLabel.textContent = 'connected';
  };

  ws.onclose = () => {
    els.conn.className = 'dot error';
    els.connLabel.textContent = 'reconnecting…';
    setTimeout(connect, 1000);
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);

    if (msg.type === 'hello') {
      state.sessions = msg.sessions;
      if (msg.chats) state.chats = msg.chats;
      if (msg.host) applyHost(msg.host);
      renderRail();
      return;
    }

    if (msg.type === 'host') {
      if (msg.host) applyHost(msg.host);
      return;
    }

    if (msg.type === 'desktopRecent') {
      state.chats = msg.chats || [];
      renderRail();
      return;
    }

    if (msg.type === 'sessions') {
      state.sessions = msg.sessions;
      renderRail();
      const mine = msg.sessions.find((s) => s.id === state.sessionId);
      if (mine) applyMeta(mine);
      return;
    }

    if (msg.type === 'attached') {
      // The host says whether this stands in for what is on screen. It used to
      // be guessed from the first record being number one, which stopped being
      // true the moment a long transcript arrived as its tail — and a guess of
      // "not fresh" draws the conversation a second time underneath itself.
      // A catch-up that skipped records cannot be appended either: that would
      // leave a hole in the middle of the conversation with nothing to say so.
      const gap = !msg.replaced && msg.earlier > 0;
      const fresh =
        gap || (msg.replaced ?? (msg.sessionId !== state.sessionId || msg.records[0]?.seq === 1));
      state.sessionId = msg.sessionId;
      rememberSession(msg.sessionId);
      if (fresh) {
        els.transcript.innerHTML = '';
        state.toolCards.clear();
        state.bundle = null;
        state.permCards.clear();
        state.askCards.clear();
        state.stream = null;
        state.thinking = null;
        state.statusEl = null;
        state.turn = null;
        resetTerminals();
      }
      renderModels(msg.catalog?.models);
      renderModes(msg.catalog?.modes);
      if (msg.projects) state.projects = msg.projects;
      if (msg.chats) state.chats = msg.chats;
      state.replaying = true;
      applyMeta(msg.meta);
      renderRail();
      // Panes first, so replayed terminal chunks have somewhere to land.
      for (const t of msg.terminals || []) openPane(t);
      // Say what is not on screen, so the top of a long chat reads as the middle
      // of a conversation rather than the beginning of one.
      if (fresh && msg.earlier > 0) {
        const note = div('notice');
        note.textContent = `${msg.earlier.toLocaleString()} earlier records are not shown.`;
        add(note);
      }
      for (const rec of msg.records) render(rec);
      state.replaying = false;
      if (state.busy) paintLiveStatus();
      else if (state.turn) endTurn({ ts: state.now || Date.now() });
      else settleRunningTools();
      refreshUsage();
      startUsagePoll();
      // An approval the agent is still waiting on outlives the replay window,
      // and a turn stuck behind an unanswered question is the worst thing to
      // come back to. Anything the records already drew is skipped.
      for (const p of msg.pending || []) {
        if (!state.permCards.has(p.requestId)) renderPermission(p);
      }
      if (msg.terminalsAvailable === false) {
        for (const t of [$('term-toggle'), $('sheet-terminals')]) {
          t.disabled = true;
          t.title = 'Terminals are unavailable on this host';
        }
      }
      decorate(els.transcript);
      scrollDown(true);
      setHistoryLoading(false);
      // Whatever was queued before you looked is still queued.
      sendOp({ op: 'queue.list', sessionId: msg.sessionId });
      return;
    }

    if (msg.type === 'desktopChats') {
      renderDesktopChats(msg.folder, msg.chats || []);
      return;
    }

    if (msg.type === 'projects') {
      state.projects = msg.projects || [];
      renderRail();
      renderNewbie();
      return;
    }

    if (msg.type === 'synced') {
      state.sessions = msg.sessions || state.sessions;
      renderRail();
      return;
    }

    if (msg.type === 'host.restarting') {
      els.connLabel.textContent = 'restarting';
      return;
    }

    if (msg.type === 'catalog') {
      renderModels(msg.catalog?.models);
      renderModes(msg.catalog?.modes);
      const mine = state.sessions.find((s) => s.id === state.sessionId);
      if (mine?.model) selectModel(mine.model, mine.modelName);
      return;
    }

    if (msg.type === 'usage') {
      if (msg.sessionId && msg.sessionId !== state.sessionId) return;
      state.usage = msg;
      paintUsageDial(msg.session);
      if (!els.usageSheet.hidden) renderUsageSheet(msg);
      return;
    }

    if (msg.type === 'record') {
      if (msg.sessionId !== state.sessionId) return;
      render(msg.record);
      return;
    }

    if (msg.type === 'browser.frame') {
      onFrame(msg.data);
      return;
    }

    if (msg.type === 'browser.status') {
      onStatus(msg.status);
      return;
    }

    if (msg.type === 'terminal.opened') {
      if (msg.terminal?.sessionId === state.sessionId) openPane(msg.terminal);
      return;
    }

    if (msg.type === 'terminal.closed') {
      closePane(msg.terminalId);
      return;
    }

    if (msg.type === 'question.answer') {
      const card = state.askCards.get(msg.askId);
      if (!card || card.classList.contains('resolved')) return;
      if (msg.status === 'pressed') return;
      for (const b of card.querySelectorAll('button')) b.disabled = false;
      const outcome = card.querySelector('.outcome');
      if (outcome) outcome.textContent = msg.reason || 'could not answer — try again';
      return;
    }

    if (msg.type === 'plan.build') {
      const card = state.toolCards.get(msg.toolCallId);
      if (!card?.createdPlan) return;
      const outcome = card.querySelector('.outcome');
      if (msg.status === 'pressed') {
        card.classList.add('resolved');
        if (outcome) outcome.textContent = 'Building in Cursor…';
        for (const b of card.querySelectorAll('button, select')) {
          if (!b.classList.contains('view')) b.disabled = true;
        }
        return;
      }
      for (const b of card.querySelectorAll('button, select')) b.disabled = false;
      const build = card.querySelector('.build');
      if (build) delete build.dataset.sent;
      if (outcome) outcome.textContent = msg.reason || 'could not build — try again';
      return;
    }

    if (msg.type === 'queue') {
      if (msg.sessionId && msg.sessionId !== state.sessionId) return;
      state.queue = {
        owner: msg.owner || 'auto',
        waiting: msg.waiting || 0,
        items: msg.items || [],
        hidden: msg.hidden || 0,
        reason: msg.reason || null,
      };
      // An action that failed is worth a word: the message may have gone into
      // the agent between the list being drawn and the button being pressed.
      if (msg.acted && msg.acted.status !== 'done') {
        render({ kind: 'notice', text: msg.acted.reason || `That queued message is ${msg.acted.status}.` });
      }
      renderQueue();
      return;
    }

    if (msg.type === 'error') {
      setHistoryLoading(false);
      render({ kind: 'error', text: msg.message });
    }
  };
}

// ---------------------------------------------------------------- composer

function renderAttachments() {
  els.attachments.innerHTML = '';
  els.attachments.hidden = state.attachments.length === 0;
  syncSend();
  state.attachments.forEach((att, i) => {
    const box = div('att');
    const img = document.createElement('img');
    img.src = att.url;
    img.alt = att.name || 'attached image';
    img.title = 'View image';
    img.onclick = () => openLightbox(att.url);
    const drop = document.createElement('button');
    drop.type = 'button';
    drop.textContent = '×';
    drop.title = 'Remove';
    drop.setAttribute('aria-label', 'Remove image');
    drop.onclick = (e) => {
      e.stopPropagation();
      state.attachments.splice(i, 1);
      renderAttachments();
    };
    box.append(img, drop);
    els.attachments.append(box);
  });
}

/**
 * The messages waiting for the turn to end, above the box you typed them in.
 *
 * The same three things the IDE offers, because a message queued from a phone is
 * the one most likely to need taking back: reword it, push it to the front, or
 * throw it away. Rewording happens in the row itself rather than in the message
 * box, so a half-typed follow-up is never overwritten by an edit.
 */
function renderQueue() {
  const { items, waiting, hidden, owner, reason } = state.queue;
  const none = !waiting && !items.length;
  els.queue.hidden = none;
  if (none) {
    state.editing = null;
    return;
  }

  // Open on the first sight of a queue, then leave it however it was left.
  if (!els.queue.dataset.touched) els.queue.open = true;
  const extra = hidden ? ` (${hidden} out of view)` : '';
  els.queueCount.textContent = `${waiting} queued${extra}`;
  els.queue.title = owner === 'cursor' ? 'Held by Cursor until this turn ends' : '';

  els.queueList.innerHTML = '';
  if (reason) els.queueList.append(said('queue-note', `Cursor's queue is out of reach: ${reason}`));

  for (const item of items) {
    const row = div('queued');
    if (state.editing === item.id) {
      const editor = document.createElement('textarea');
      editor.value = item.text;
      editor.rows = Math.min(6, item.text.split('\n').length + 1);
      const save = button('✓', 'Save', () => {
        const text = editor.value.trim();
        state.editing = null;
        if (text && text !== item.text) {
          sendOp({ op: 'queue.edit', sessionId: state.sessionId, itemId: item.id, text });
        } else {
          renderQueue();
        }
      });
      const cancel = button('×', 'Cancel', () => {
        state.editing = null;
        renderQueue();
      });
      const acts = div('queued-acts');
      acts.append(save, cancel);
      row.append(editor, acts);
      els.queueList.append(row);
      editor.focus();
      continue;
    }

    const text = said('queued-text', item.text);
    if (item.images) {
      text.append(said('cap', `+${item.images} image${item.images === 1 ? '' : 's'}`));
    }
    const acts = div('queued-acts');
    acts.append(
      button('✎', 'Edit this message', () => {
        state.editing = item.id;
        renderQueue();
      }),
      button('↑', owner === 'cursor' ? 'Send it now' : 'Send it next', () =>
        sendOp({ op: 'queue.now', sessionId: state.sessionId, itemId: item.id }),
      ),
      button('🗑', 'Delete this message', () =>
        sendOp({ op: 'queue.drop', sessionId: state.sessionId, itemId: item.id }),
      ),
    );
    row.append(text, acts);
    els.queueList.append(row);
  }
}

/** A div holding words, never markup: a queued message is somebody's typing. */
function said(cls, words) {
  const d = document.createElement('div');
  d.className = cls;
  d.textContent = words;
  return d;
}

/** A small square button, the only kind the queue rows need. */
function button(face, title, onclick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'queued-act';
  b.textContent = face;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.onclick = onclick;
  return b;
}

/** Screenshots are half of what you want to say from a phone. */
function addImage(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = () => {
    const url = String(reader.result);
    state.attachments.push({
      mimeType: file.type,
      data: url.slice(url.indexOf(',') + 1),
      url,
      name: file.name,
    });
    renderAttachments();
  };
  reader.readAsDataURL(file);
}

function submit(text) {
  const body = (text ?? els.box.value).trim();
  const images = state.attachments.map(({ mimeType, data, url }) => ({ mimeType, data, url }));
  // A turn already running is no reason to refuse: the host queues it.
  if (!body && !images.length) return;
  state.lastPrompt = body;
  // Idle sends go on the stream at once — waiting for Cursor's window made
  // the phone look like nothing had been sent. A busy turn queues instead,
  // and the queue is where those belong until they go in.
  if (!state.busy) {
    renderUser({
      text: body,
      images: images.length || undefined,
      imageParts: images.length
        ? images.map(({ mimeType, data, url }) => ({ mimeType, data, url }))
        : undefined,
    });
    rememberSend({ text: body, images: images.length || 0 });
  }
  sendOp({
    op: 'prompt',
    sessionId: state.sessionId,
    text: body,
    images: images.map(({ mimeType, data }) => ({ mimeType, data })),
  });
  state.attachments = [];
  renderAttachments();
  if (text === undefined) {
    els.box.value = '';
    autosize();
  }
  clearDraft(state.sessionId);
  scrollDown(true);
}

function autosize() {
  els.box.style.height = 'auto';
  els.box.style.height = `${Math.min(els.box.scrollHeight, window.innerHeight * 0.4)}px`;
  syncSend();
}

// Folding the queue away is a choice worth keeping; the count stays visible.
els.queue.addEventListener('toggle', () => {
  els.queue.dataset.touched = '1';
});

els.send.onclick = () => submit();
els.stop.onclick = () => sendOp({ op: 'cancel', sessionId: state.sessionId });
els.box.addEventListener('input', autosize);
els.box.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
  }
});
els.box.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return;
  e.preventDefault();
  files.forEach(addImage);
});
$('attach').onclick = () => els.file.click();
els.file.onchange = () => {
  [...els.file.files].forEach(addImage);
  els.file.value = '';
};

els.transcript.addEventListener('scroll', syncToBottom);
els.toBottom.onclick = () => {
  scrollDown(true);
  syncToBottom();
};

// --------------------------------------------------------- new session

/**
 * Soft keyboards shrink the visual viewport without shrinking the layout one.
 * Publish that frame as --vv-top / --vv-height so the New session sheet (and
 * anything else that wants it) can sit above the keys instead of under them.
 */
function syncVisualViewport() {
  const vv = window.visualViewport;
  const root = document.documentElement;
  if (!vv) {
    root.style.removeProperty('--vv-top');
    root.style.removeProperty('--vv-height');
    return;
  }
  root.style.setProperty('--vv-top', `${Math.round(vv.offsetTop)}px`);
  root.style.setProperty('--vv-height', `${Math.round(vv.height)}px`);
  fitStandaloneShell();
}

/**
 * iOS Home Screen: the layout viewport stops above the home indicator, which
 * reads as a white strip under the composer. Size the shell to the visual
 * viewport (the pixels you can see) and keep composer padding at 8px — never
 * env(safe-area-inset-bottom), which is ~80px here even with the keyboard up.
 */
function fitStandaloneShell() {
  if (!document.documentElement.hasAttribute('data-standalone')) return;
  const app = $('app');
  const composer = $('composer');
  const vv = window.visualViewport;
  if (app && vv) {
    app.style.top = `${Math.round(vv.offsetTop)}px`;
    app.style.height = `${Math.round(vv.height)}px`;
    app.style.left = '0';
    app.style.right = '0';
    app.style.bottom = 'auto';
  }
  if (composer) composer.style.setProperty('padding-bottom', '8px', 'important');
}

{
  const vv = window.visualViewport;
  if (vv) {
    vv.addEventListener('resize', syncVisualViewport);
    vv.addEventListener('scroll', syncVisualViewport);
  }
  window.addEventListener('resize', syncVisualViewport);
  syncVisualViewport();
}

/**
 * Starting a session is choosing where it works. The list is Cursor's own
 * project list rather than anything Auto invented, and a folder can always be
 * typed by hand for the project nobody has opened in a while. When that folder
 * is already open in Cursor, the new session is a chat in the IDE.
 */
function setNewbie(open) {
  $('newbie').hidden = !open;
  if (!open) return;
  syncVisualViewport();
  $('newbie-filter').value = '';
  $('newbie-path').value = '';
  $('newbie-note').textContent = '';
  renderNewbie();
  // The rail's copy may be stale; the host re-reads Cursor's records on ask.
  sendOp({ op: 'projects.list' });
  $('newbie-filter').focus();
}

/** The same fallback the rail uses: sessions prove a folder was a project. */
function projectChoices() {
  if (state.projects.length) return state.projects;
  return [...new Set(state.sessions.map((s) => s.folder))].map((path) => ({
    path,
    name: (path || '').split(/[\\/]/).pop(),
    open: false,
  }));
}

function renderNewbie() {
  const list = $('newbie-list');
  if ($('newbie').hidden) return;
  const filter = $('newbie-filter').value.trim().toLowerCase();
  list.innerHTML = '';

  const choices = projectChoices().filter(
    (p) =>
      !filter ||
      (p.name || '').toLowerCase().includes(filter) ||
      (p.path || '').toLowerCase().includes(filter),
  );

  for (const p of choices) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'newbie-row';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = p.name || p.path;
    const path = document.createElement('span');
    path.className = 'path';
    path.textContent = p.path || '';
    row.append(name, path);
    if (p.open) {
      const tag = document.createElement('span');
      tag.className = 'open-here';
      tag.textContent = 'open in Cursor';
      row.append(tag);
    }
    row.onclick = () => createSession(p.path);
    list.append(row);
  }

  if (!choices.length) {
    list.append(
      said(
        'queue-note',
        filter ? 'Nothing matches that filter.' : 'No projects yet — type a folder path below.',
      ),
    );
  }
}

function createSession(folder) {
  const path = String(folder || '').trim();
  if (!path) return;
  setNewbie(false);
  sendOp({ op: 'session.create', folder: path });
}

$('new-session').onclick = () => {
  // The rail covers the screen on a phone; the dialog has to sit above it.
  setRail(false);
  setNewbie(true);
};
$('newbie-close').onclick = () => setNewbie(false);
$('newbie').onclick = (e) => {
  if (e.target === $('newbie')) setNewbie(false);
};
$('newbie-filter').addEventListener('input', renderNewbie);
$('newbie-create').onclick = () => createSession($('newbie-path').value);
$('newbie-path').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') createSession($('newbie-path').value);
});

$('restart').onclick = () => {
  if (!confirm('Restart Auto? It waits for the current turn, then reconnects.')) return;
  sendOp({ op: 'host.restart', reason: 'web' });
};
/**
 * Open or close the session rail. On a narrow screen it slides over the page,
 * covering the button that opened it — so closing has to be possible from the
 * rail itself (× or a swipe left), from the page beside it, and from the keyboard.
 */
function setRail(open) {
  els.app.classList.toggle('rail-open', open);
  $('rail-scrim').hidden = !open;
  $('rail').style.transform = '';
  els.app.classList.remove('rail-dragging');
  // Cursor may have moved on since you last looked.
  if (open) sendOp({ op: 'desktop.recent' });
}

/**
 * The rail is a drawer on a narrow screen. Swiping it left closes it the
 * same way the × and the scrim do — following the finger, then settling.
 *
 * Pointer events never see the swipe on iOS: the session list is a scroller,
 * so Safari eats the gesture as a pan and `pointermove` never fires. A
 * non-passive `touchmove` has to be on the rail before the finger goes down,
 * or iOS will not let it cancel the scroll.
 */
function bindRailSwipe() {
  const rail = $('rail');
  const list = $('session-list');
  const overlay = () => window.matchMedia('(max-width: 760px)').matches;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastT = 0;
  let vx = 0;
  let mode = 'idle';

  const finger = (e) => {
    const t = e.changedTouches?.[0] || e.touches?.[0];
    return t
      ? { x: t.clientX, y: t.clientY, t: e.timeStamp }
      : { x: e.clientX, y: e.clientY, t: e.timeStamp };
  };

  const settle = (close) => {
    const dragged = mode === 'drag';
    mode = 'idle';
    els.app.classList.remove('rail-dragging');
    list.style.overflow = '';
    if (close) {
      // Keep the finger's offset until rail-open drops, or the drawer
      // would jump fully open and then animate closed.
      els.app.classList.remove('rail-open');
      $('rail-scrim').hidden = true;
      requestAnimationFrame(() => {
        rail.style.transform = '';
      });
    } else {
      rail.style.transform = '';
    }
    if (!dragged) return;
    // A swipe that ends on a row must not attach or archive it.
    const eat = (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    rail.addEventListener('click', eat, { capture: true, once: true });
  };

  const onMove = (e) => {
    if (e.pointerType === 'touch') return;
    if (mode === 'idle') return;
    const p = finger(e);
    const dx = p.x - startX;
    const dy = p.y - startY;
    const dt = p.t - lastT || 1;
    vx = (p.x - lastX) / dt;
    lastX = p.x;
    lastT = p.t;

    if (mode === 'maybe') {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      // Vertical scroll of the list wins; swiping right has nowhere to go.
      if (dx > -6 || Math.abs(dy) >= Math.abs(dx)) {
        mode = 'idle';
        return;
      }
      mode = 'drag';
      els.app.classList.add('rail-dragging');
      list.style.overflow = 'hidden';
    }

    if (e.cancelable) e.preventDefault();
    rail.style.transform = `translateX(${Math.min(0, dx)}px)`;
  };

  const onEnd = (e) => {
    if (e.pointerType === 'touch') return;
    if (mode === 'idle') return;
    const dx = finger(e).x - startX;
    const width = rail.getBoundingClientRect().width || 280;
    settle(mode === 'drag' && (dx < -width * 0.18 || (dx < -24 && vx < -0.25)));
  };

  const onCancel = (e) => {
    if (e.pointerType === 'touch') return;
    if (mode === 'idle') return;
    settle(false);
  };

  const onStart = (e) => {
    if (!overlay() || !els.app.classList.contains('rail-open')) return;
    if (e.type === 'pointerdown' && e.pointerType === 'touch') return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest?.('button, input, select, textarea, a')) return;
    const p = finger(e);
    startX = lastX = p.x;
    startY = p.y;
    lastT = p.t;
    vx = 0;
    mode = 'maybe';
  };

  rail.addEventListener('touchstart', onStart, { capture: true, passive: true });
  rail.addEventListener('touchmove', onMove, { capture: true, passive: false });
  rail.addEventListener('touchend', onEnd, { capture: true });
  rail.addEventListener('touchcancel', onCancel, { capture: true });
  rail.addEventListener('pointerdown', onStart);
  rail.addEventListener('pointermove', onMove);
  rail.addEventListener('pointerup', onEnd);
  rail.addEventListener('pointercancel', onCancel);
}

$('rail-toggle').onclick = () => setRail(!els.app.classList.contains('rail-open'));
$('rail-close').onclick = () => setRail(false);
$('rail-scrim').onclick = () => setRail(false);
bindRailSwipe();

// --------------------------------------------------------------- appearance

/**
 * Three choices, not two: a phone that turns light at sunrise should take the
 * app with it unless you have said otherwise. The stored preference is the
 * choice ("system"), never the outcome ("light").
 */
const THEME_KEY = 'auto.theme';
const prefersLight = window.matchMedia('(prefers-color-scheme: light)');

function themeChoice() {
  try {
    return localStorage.getItem(THEME_KEY) || 'system';
  } catch {
    return 'system';
  }
}

function applyTheme(choice = themeChoice()) {
  const light = choice === 'light' || (choice === 'system' && prefersLight.matches);
  document.documentElement.dataset.theme = light ? 'light' : 'dark';

  // The browser's own chrome should not be the one thing left behind.
  const meta = document.querySelector('meta[name="theme-color"]');
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  if (meta && bg) meta.setAttribute('content', bg);

  for (const b of document.querySelectorAll('#theme-seg button')) {
    b.setAttribute('aria-pressed', String(b.dataset.themeChoice === choice));
  }
  retheme();
}

for (const b of document.querySelectorAll('#theme-seg button')) {
  b.onclick = () => {
    try {
      localStorage.setItem(THEME_KEY, b.dataset.themeChoice);
    } catch {
      /* private mode: the choice lasts as long as the page does */
    }
    applyTheme(b.dataset.themeChoice);
  };
}

prefersLight.addEventListener('change', () => {
  if (themeChoice() === 'system') applyTheme();
});

// -------------------------------------------------------------------- sheet

/**
 * Everything that is not the conversation. Mode and model stay in the
 * composer at every width, the way Cursor's chat box carries them — they say
 * what the next message will run as. The approval policy is the rare change,
 * so it alone moves into the sheet on a narrow screen, which is how it used
 * to go missing on a phone, the one place it matters most.
 */
const compact = window.matchMedia('(max-width: 900px)');

function placeControls() {
  const inSheet = compact.matches;
  const host = inSheet ? $('sheet-controls') : $('topbar-controls');
  host.append(els.policy);
  // Whichever holder is left empty should not keep its gap.
  $('sheet-controls').hidden = !inSheet;
}

function setSheet(open) {
  els.sheet.hidden = !open;
  if (!open) return;
  $('rename').value = state.sessionId ? els.title.textContent : '';
  $('sheet-folder').textContent = els.folder.textContent;
  $('host-nick').value = state.host.nick || '';
  $('host-nick').placeholder = state.host.hostname || 'Display name';
  $('sheet-hostname').textContent = state.host.hostname
    ? `hostname · ${state.host.hostname}`
    : '';
  $('sheet-conn').textContent = `${els.connLabel.textContent} · ${location.host}`;
}

/** Rail brand + Settings Host both read from this. */
function applyHost(host) {
  state.host = {
    hostname: host.hostname || '',
    nick: host.nick || null,
    label: host.label || host.nick || host.hostname || '',
  };
  const el = $('host-label');
  if (el) el.textContent = state.host.label || '…';
  if (!els.sheet.hidden) {
    $('host-nick').value = state.host.nick || '';
    $('host-nick').placeholder = state.host.hostname || 'Display name';
    $('sheet-hostname').textContent = state.host.hostname
      ? `hostname · ${state.host.hostname}`
      : '';
  }
}

/**
 * iOS never fires beforeinstallprompt — Share → Add to Home Screen is the
 * whole path. Android Chrome does, so that one gets a real button. Already
 * running as the installed app hides the block.
 */
let installPrompt = null;

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
}

function isIos() {
  return /iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function paintInstall() {
  const block = $('install-block');
  const row = $('install-row');
  const note = $('install-note');
  if (!block || !row || !note) return;
  if (isStandalone()) {
    block.hidden = true;
    return;
  }
  block.hidden = false;
  if (isIos()) {
    row.hidden = true;
    note.textContent =
      'On iPhone: tap Share, then Add to Home Screen. Auto opens as its own app, not a Safari tab.';
    return;
  }
  row.hidden = !installPrompt;
  note.textContent = installPrompt
    ? 'Install Auto so it sits on the Home Screen and opens without browser chrome.'
    : 'Use the browser menu → Install app (or Add to Home Screen). Auto then opens without browser chrome.';
}

compact.addEventListener('change', placeControls);
placeControls();
applyTheme();
paintInstall();

$('sheet-open').onclick = () => {
  setRail(false);
  setSheet(true);
};
$('sheet-close').onclick = () => setSheet(false);
els.sheet.onclick = (e) => {
  if (e.target === els.sheet) setSheet(false);
};

$('rename-save').onclick = () => {
  const title = $('rename').value.trim();
  if (!title || !state.sessionId) return;
  sendOp({ op: 'session.rename', sessionId: state.sessionId, title });
  els.title.textContent = title;
  setSheet(false);
};

$('host-nick-save').onclick = () => {
  const nick = $('host-nick').value.trim();
  sendOp({ op: 'host.setNick', nick });
  // Optimistic: the broadcast confirms; empty nick falls back to hostname.
  applyHost({
    hostname: state.host.hostname,
    nick: nick || null,
    label: nick || state.host.hostname,
  });
};
$('host-nick').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('host-nick-save').click();
});

$('sheet-sync').onclick = () => sendOp({ op: 'sessions.sync' });

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  paintInstall();
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  paintInstall();
});
$('install-app').onclick = async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => {});
  installPrompt = null;
  paintInstall();
};
$('sheet-browser').onclick = () => {
  setSheet(false);
  $('browser-toggle').click();
};
$('sheet-terminals').onclick = () => {
  setSheet(false);
  $('term-toggle').click();
};

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // Innermost first: the dialogs sit over the sheet, which sits over the
  // workspace, which sits over the rail.
  if (!$('lightbox').hidden) closeLightbox();
  else if (!els.usageSheet.hidden) setUsageSheet(false);
  else if (!$('newbie').hidden) setNewbie(false);
  else if (!els.sheet.hidden) setSheet(false);
  else if (workspaceIsOpen()) closeWorkspace();
  else if (els.app.classList.contains('rail-open')) setRail(false);
});

els.mode.onchange = () => {
  paintMode();
  sendOp({ op: 'session.mode', sessionId: state.sessionId, modeId: els.mode.value });
};
els.model.onchange = () =>
  sendOp({ op: 'session.model', sessionId: state.sessionId, modelId: els.model.value });
els.policy.onchange = () =>
  sendOp({ op: 'session.policy', sessionId: state.sessionId, policy: els.policy.value });

els.usage.onclick = () => {
  setUsageSheet(true);
  refreshUsage(true);
};
$('usage-close').onclick = () => setUsageSheet(false);
els.usageSheet.onclick = (e) => {
  if (e.target === els.usageSheet) setUsageSheet(false);
};

// Mobile browsers suspend sockets in the background; resync when we come back.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.ws?.readyState !== 1) connect();
  if (!document.hidden && state.sessionId) refreshUsage();
});

paintMode();
syncSend();
initWorkspace();
initTerminals(sendOp);
initBrowser(sendOp);
connect();

// ------------------------------------------------------------------ usage

function usageLevel(pct) {
  if (pct == null || !Number.isFinite(pct)) return '';
  if (pct >= 85) return 'hot';
  if (pct >= 65) return 'warn';
  return '';
}

function paintUsageDial(session) {
  const btn = els.usage;
  if (!state.sessionId) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  const pct = Number(session?.contextUsagePercent);
  const fill = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
  btn.style.setProperty('--usage-pct', String(fill));
  btn.dataset.level = usageLevel(fill);
  const parts = [];
  if (Number.isFinite(pct)) parts.push(`Context ${Math.round(pct)}% full`);
  if (session?.contextTokensUsed != null && session?.contextTokensMax != null) {
    parts.push(`${tokens(session.contextTokensUsed)} / ${tokens(session.contextTokensMax)} tokens`);
  }
  if (session?.costCents != null) parts.push(money(session.costCents / 100));
  btn.title = parts.length ? `${parts.join(' · ')} — tap for usage` : 'Usage — tap for details';
}

function refreshUsage(force = false) {
  if (!state.sessionId) return;
  sendOp({ op: 'usage.get', sessionId: state.sessionId, force: Boolean(force) });
}

function startUsagePoll() {
  if (state.usageTimer) clearInterval(state.usageTimer);
  state.usageTimer = setInterval(() => {
    if (!state.sessionId || document.hidden) return;
    refreshUsage(false);
  }, 20_000);
  state.usageTimer.unref?.();
}

function setUsageSheet(open) {
  els.usageSheet.hidden = !open;
  if (open) {
    if (state.usage) renderUsageSheet(state.usage);
    else els.usageBody.innerHTML = '<div class="sheet-note">Loading…</div>';
    els.usageBody.scrollTop = 0;
  }
}

function money(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

function tokens(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function whenCycle(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const left = Math.max(0, Math.ceil((ms - Date.now()) / 86_400_000));
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} (${left} day${left === 1 ? '' : 's'} left)`;
}

function meter(kind, label, pct, note) {
  const p = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
  return `<div class="usage-meter">
    <div class="usage-meter-head"><span>${esc(label)}</span><span>${Math.round(p)}% used</span></div>
    <div class="usage-bar" style="--pct:${p}"><i></i></div>
    ${note ? `<div class="usage-note">${esc(note)}</div>` : ''}
  </div>`;
}

function renderUsageSheet(msg) {
  const session = msg.session || {};
  const account = msg.account || {};
  const pct = Number(session.contextUsagePercent);
  const fill = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
  const level = usageLevel(fill);
  const bits = [];
  const used = session.contextTokensUsed;
  const max = session.contextTokensMax;
  const hasTokens = used != null && max != null;
  const tokenLine = hasTokens
    ? `${session.contextAssumed ? '≈ ' : ''}${tokens(used)} / ${tokens(max)} tokens`
    : null;

  bits.push(`<section class="sheet-block"><h2>This chat</h2>`);
  bits.push(`<div class="usage-hero">
    <div class="usage-hero-dial" data-level="${esc(level)}" style="--usage-pct:${fill}"></div>
    <div class="usage-hero-copy">
      <strong>${Number.isFinite(pct) ? `${Math.round(pct)}%` : '—'}</strong>
      <span>${tokenLine || `of context used${session.maxMode ? ' · Max Mode' : ''}`}</span>
      <span class="usage-hero-cost">${
        session.costCents != null
          ? `Est. ${money(session.costCents / 100)} this chat`
          : Number.isFinite(pct)
            ? 'Est. cost not recorded yet'
            : ''
      }</span>
    </div>
  </div>`);
  if (hasTokens && session.contextAssumed) {
    bits.push(`<div class="usage-note">Window assumed ${esc(session.context || '200k')} — this model did not store a size.</div>`);
  } else if (hasTokens && session.context) {
    bits.push(`<div class="usage-note">${esc(session.context)} context window${session.maxMode ? ' · Max Mode' : ''}</div>`);
  } else if (session.maxMode) {
    bits.push(`<div class="usage-note">Max Mode — absolute tokens need a named context size.</div>`);
  }
  if (session.model) bits.push(`<div class="usage-note">Model: ${esc(session.model)}</div>`);
  if (session.tokens) {
    bits.push(
      `<div class="usage-note">Recorded tokens: ${tokens(session.tokens.input)} in · ${tokens(session.tokens.output)} out across ${session.tokens.bubbles} message${session.tokens.bubbles === 1 ? '' : 's'}</div>`,
    );
  }
  if (session.note) bits.push(`<div class="usage-note">${esc(session.note)}</div>`);
  if (!Number.isFinite(pct) && !session.note) {
    bits.push(`<div class="usage-note">Cursor has not written a context fill for this chat yet.</div>`);
  }
  bits.push(`</section>`);

  bits.push(`<section class="sheet-block"><h2>Account</h2>`);
  if (account.status !== 'ok') {
    bits.push(`<div class="sheet-note">${esc(account.reason || 'Account usage is unavailable.')}</div>`);
  } else {
    const plan = account.plan || {};
    const buckets = account.buckets || {};
    bits.push(
      `<div class="usage-plan"><strong>${esc(plan.name || 'Plan')}</strong>${plan.price ? ` · ${esc(plan.price)}` : ''}${plan.cycleEnd ? `<br>Resets ${esc(whenCycle(plan.cycleEnd))}` : ''}${account.account?.email ? `<br>${esc(account.account.email)}` : ''}</div>`,
    );
    bits.push(
      meter(
        'cursor',
        buckets.cursorModels?.label || 'Cursor Models',
        buckets.cursorModels?.percent,
        buckets.cursorModels?.note || buckets.cursorModels?.message,
      ),
    );
    bits.push(
      meter(
        'other',
        buckets.otherModels?.label || 'Other Models',
        buckets.otherModels?.percent,
        buckets.otherModels?.note || buckets.otherModels?.message,
      ),
    );
    const included = buckets.included || {};
    bits.push(
      meter(
        'included',
        included.label || 'Included usage',
        included.percent,
        included.message ||
          (included.usedUsd != null
            ? `${money(included.usedUsd)} of ${money(included.limitUsd)} · ${money(included.remainingUsd)} left`
            : null),
      ),
    );
    const od = account.onDemand || {};
    bits.push(`<div class="usage-note">${esc(od.note || '')}${od.enabled && od.limitUsd != null ? ` · ${money(od.usedUsd)} of ${money(od.limitUsd)}` : ''}</div>`);

    if (account.totals) {
      bits.push(
        `<div class="usage-note">This cycle: ${tokens(account.totals.inputTokens)} in · ${tokens(account.totals.outputTokens)} out · ${money(account.totals.costUsd)}</div>`,
      );
    }
    if (account.models?.length) {
      bits.push(`<h2 style="margin-top:14px">By model</h2><ul class="usage-models">`);
      for (const row of account.models.slice(0, 8)) {
        bits.push(
          `<li><span>${esc(row.model)}</span><span class="mono">${money(row.costUsd)} · ${tokens(row.inputTokens + row.outputTokens)}</span></li>`,
        );
      }
      bits.push(`</ul>`);
    }
  }
  bits.push(`</section>`);

  els.usageBody.innerHTML = bits.join('');
}

// ------------------------------------------------------------------ lightbox

const lightbox = {
  scale: 1,
  x: 0,
  y: 0,
  /** @type {{ x: number, y: number } | null} */
  drag: null,
  /** @type {{ dist: number, scale: number } | null} */
  pinch: null,
};

function lightboxEls() {
  return {
    root: $('lightbox'),
    stage: $('lightbox-stage'),
    img: $('lightbox-img'),
    close: $('lightbox-close'),
  };
}

function openLightbox(src) {
  if (!src) return;
  const { root, img, stage } = lightboxEls();
  img.src = src;
  lightbox.scale = 1;
  lightbox.x = 0;
  lightbox.y = 0;
  lightbox.drag = null;
  lightbox.pinch = null;
  paintLightboxTransform();
  root.hidden = false;
  stage.classList.remove('dragging');
}

function closeLightbox() {
  const { root, img, stage } = lightboxEls();
  root.hidden = true;
  img.removeAttribute('src');
  lightbox.drag = null;
  lightbox.pinch = null;
  stage.classList.remove('dragging');
}

function paintLightboxTransform() {
  const { img } = lightboxEls();
  img.style.transform = `translate(${lightbox.x}px, ${lightbox.y}px) scale(${lightbox.scale})`;
}

function zoomLightbox(factor, cx, cy) {
  const { stage, img } = lightboxEls();
  const next = Math.min(5, Math.max(1, lightbox.scale * factor));
  if (next === lightbox.scale) return;
  const rect = stage.getBoundingClientRect();
  const px = (cx ?? rect.left + rect.width / 2) - rect.left - rect.width / 2;
  const py = (cy ?? rect.top + rect.height / 2) - rect.top - rect.height / 2;
  const ratio = next / lightbox.scale;
  lightbox.x = px - (px - lightbox.x) * ratio;
  lightbox.y = py - (py - lightbox.y) * ratio;
  lightbox.scale = next;
  if (lightbox.scale === 1) {
    lightbox.x = 0;
    lightbox.y = 0;
  }
  paintLightboxTransform();
  img.style.cursor = lightbox.scale > 1 ? 'grab' : 'zoom-in';
}

{
  const { root, stage, close } = lightboxEls();
  close.onclick = (e) => {
    e.stopPropagation();
    closeLightbox();
  };
  root.onclick = (e) => {
    if (e.target === root || e.target === stage) closeLightbox();
  };
  stage.addEventListener(
    'wheel',
    (e) => {
      if (root.hidden) return;
      e.preventDefault();
      zoomLightbox(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY);
    },
    { passive: false },
  );
  stage.addEventListener('dblclick', (e) => {
    e.preventDefault();
    if (lightbox.scale > 1) {
      lightbox.scale = 1;
      lightbox.x = 0;
      lightbox.y = 0;
      paintLightboxTransform();
    } else {
      zoomLightbox(2.5, e.clientX, e.clientY);
    }
  });

  const point = (t) => ({ x: t.clientX, y: t.clientY });
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  stage.addEventListener(
    'pointerdown',
    (e) => {
      if (root.hidden || e.button) return;
      if (e.target.closest('#lightbox-close')) return;
      stage.setPointerCapture(e.pointerId);
      lightbox.drag = { x: e.clientX - lightbox.x, y: e.clientY - lightbox.y };
      stage.classList.add('dragging');
    },
    { passive: true },
  );
  stage.addEventListener(
    'pointermove',
    (e) => {
      if (!lightbox.drag || lightbox.pinch) return;
      if (lightbox.scale <= 1) return;
      lightbox.x = e.clientX - lightbox.drag.x;
      lightbox.y = e.clientY - lightbox.drag.y;
      paintLightboxTransform();
    },
    { passive: true },
  );
  const endDrag = () => {
    lightbox.drag = null;
    stage.classList.remove('dragging');
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);

  stage.addEventListener(
    'touchstart',
    (e) => {
      if (root.hidden || e.touches.length !== 2) return;
      lightbox.pinch = {
        dist: dist(point(e.touches[0]), point(e.touches[1])),
        scale: lightbox.scale,
      };
      lightbox.drag = null;
    },
    { passive: true },
  );
  stage.addEventListener(
    'touchmove',
    (e) => {
      if (!lightbox.pinch || e.touches.length !== 2) return;
      e.preventDefault();
      const d = dist(point(e.touches[0]), point(e.touches[1]));
      const mid = {
        x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
        y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
      };
      const target = Math.min(5, Math.max(1, lightbox.pinch.scale * (d / lightbox.pinch.dist)));
      const factor = target / lightbox.scale;
      zoomLightbox(factor, mid.x, mid.y);
    },
    { passive: false },
  );
  stage.addEventListener(
    'touchend',
    () => {
      lightbox.pinch = null;
    },
    { passive: true },
  );
}