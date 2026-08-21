/**
 * Auto v2 web client.
 *
 * A projection of the host's transcript: it attaches to a session, replays
 * from a sequence number, and renders records as they stream. The host is
 * still the source of truth; a local cache (memory + IndexedDB) only keeps
 * the last stretch so a reload or switching back can paint immediately and
 * catch up from lastSeq. Which chat was open is remembered separately.
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
import { initWorkspace, isOpen as workspaceIsOpen, showChat, onViewsChange, restoreViews } from './workspace.js';
import {
  activityCopy,
  classifyTool,
  displayLabel,
  editCopy,
  editStatsForTurn,
  fileStats,
  groupTally,
  isCreatedPlan,
  planFields,
  reviewHeadline,
  turnCopy,
} from './desktop-tool-ui.js';
import {
  appendLive,
  flushDiskSave,
  loadCache,
  makeSnap,
  memoryGet,
  mergeRecords,
  saveCache,
  scheduleDiskSave,
} from './transcript-cache.js';

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
  composer: $('composer'),
  composerBox: document.querySelector('.composer-box'),
  viewChat: $('view-chat'),
  model: $('model'),
  policy: $('policy'),
  conn: $('conn'),
  sheet: $('sheet'),
  toBottom: $('to-bottom'),
  scrub: $('chat-scrub'),
  scrubHandle: document.querySelector('#chat-scrub .scrub-handle'),
  scrubTimeline: document.querySelector('#chat-scrub .scrub-timeline'),
  attachments: $('attachments'),
  file: $('file'),
  queue: $('queue'),
  queueCount: $('queue-count'),
  queueList: $('queue-list'),
  usage: $('usage'),
  usageSheet: $('usage-sheet'),
  usageBody: $('usage-body'),
  planSheet: $('plan-sheet'),
  planSheetTitle: $('plan-sheet-title'),
  planBody: $('plan-body'),
  planFoot: $('plan-foot'),
  planBuild: $('plan-build'),
  planBuildModel: $('plan-build-model'),
  planOutcome: $('plan-outcome'),
};

const state = {
  ws: null,
  sessionId: null,
  sessions: [],
  projects: [],
  /** Cursor's own recent chats, whichever project they belong to */
  chats: [],
  lastSeq: 0,
  /** records currently drawn for this session (tail only) — fed into the cache */
  liveRecords: [],
  /** pinned opening prompt (through the first real user message) */
  liveHead: [],
  /** how many records sit between liveHead and liveRecords (omitted middle) */
  liveEarlier: 0,
  /** painted from cache; attached must still restore tool tabs even on catch-up */
  paintedFromCache: false,
  busy: false,
  /** toolCallId -> element, so tool_update mutates the card it belongs to */
  toolCards: new Map(),
  /** consecutive groupable/file-change calls folded into one card */
  bundle: null,
  /** requestId -> element */
  permCards: new Map(),
  /** askId -> element, so a question can be marked answered where it stands */
  askCards: new Map(),
  /** toolCallId of the plan currently open in the full-window viewer */
  openPlanId: null,
  /** card element for that open plan — Build in the footer uses it */
  openPlanCard: null,
  stream: null,
  streamKind: null,
  /** rendered-html child of the live agent bubble (keeps the copy footer intact) */
  streamBody: null,
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
  /** prompt to put back in the box once replay finishes (latest interrupt only) */
  pendingRestore: null,
  /** turn was pulled back into the composer — skip the "Worked for…" line */
  withdrawnTurn: false,
  lastPrompt: '',
  /** images waiting to go with the next prompt: {mimeType, data, url} */
  attachments: [],
  /** what is waiting for the turn to end: {owner, waiting, items, hidden} */
  queue: { owner: 'auto', waiting: 0, items: [] },
  /** Cursor's file-review Keep/Undo card for this chat (transcript landmark) */
  review: { actions: [], added: null, removed: null },
  reviewCard: null,
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
  /** after session.create, put the caret in the box once the chat is attached */
  focusComposer: false,
  /** this machine: OS hostname, optional nick, label for the rail */
  host: { hostname: '', nick: null, label: '' },
  /** chat scrubber: visible while scrolling a long transcript */
  scrubHide: null,
  scrubbing: false,
  scrubTimelineDirty: true,
  /** landmark elements currently drawn as timeline pills */
  scrubEntries: [],
  /** landmark currently snapped to while scrubbing (for haptic edges) */
  scrubSnapEl: null,
  /** finger is on the grip — layout follows the finger, not snapped scrollTop */
  scrubPointer: false,
  /** 0–1 along the rail while scrubPointer; labels read this, chat may snap */
  scrubDriveRatio: null,
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

/** Coalesce stick-to-bottom into one instant scroll per frame. CSS
 *  `scroll-behavior: smooth` on #transcript used to animate every chunk,
 *  so a fast answer stuttered and jumped as animations cancelled each other. */
let scrollDownRaf = 0;
function scrollDown(force = false) {
  if (!(force || nearBottom())) return;
  if (scrollDownRaf) return;
  scrollDownRaf = requestAnimationFrame(() => {
    scrollDownRaf = 0;
    const t = els.transcript;
    t.scrollTo({ top: t.scrollHeight, behavior: 'auto' });
  });
}

/** Smooth only for the explicit ↓ control — never for streamed chunks. */
function scrollDownSmooth() {
  els.transcript.scrollTo({ top: els.transcript.scrollHeight, behavior: 'smooth' });
}

/**
 * A long transcript takes a few seconds to arrive and draw. The overlay is
 * in the markup so it is there before this file runs; this only flips it.
 * A cache hit skips it — the conversation is already on screen.
 */
function setHistoryLoading(on) {
  els.historyLoading.hidden = !on;
  els.transcript.setAttribute('aria-busy', on ? 'true' : 'false');
}

/** Wipe the chat pane and the maps that point into it. */
function resetChatUi() {
  els.transcript.innerHTML = '';
  hideScrub(true);
  markScrubDirty();
  state.toolCards.clear();
  state.bundle = null;
  state.permCards.clear();
  state.askCards.clear();
  state.reviewCard = null;
  state.review = { actions: [], added: null, removed: null };
  state.stream = null;
  state.streamKind = null;
  state.streamBody = null;
  state.thinking = null;
  state.statusEl = null;
  state.turn = null;
  resetTerminals();
}

/** Keep the live record list (and cache) in step with what render just drew. */
function noteLiveRecord(rec) {
  if (state.replaying || !state.sessionId) return;
  if (typeof rec?.seq !== 'number') return;
  const { records, earlierDelta } = appendLive(state.liveRecords, rec);
  state.liveRecords = records;
  if (earlierDelta) state.liveEarlier += earlierDelta;
  persistLive(state.sessionId);
}

function persistLive(sessionId) {
  if (!sessionId || !(state.liveRecords.length || state.liveHead.length)) return;
  const snap = saveCache(sessionId, state.liveRecords, state.liveEarlier, state.liveHead);
  if (snap) scheduleDiskSave(sessionId, snap);
}

function adoptLive(records, earlier = 0, head = null) {
  const pinned = head == null ? state.liveHead : head;
  const snap = makeSnap(records, earlier, pinned);
  state.liveHead = (snap.head || []).slice();
  state.liveRecords = snap.records.slice();
  state.liveEarlier = snap.omitted || snap.earlier || 0;
  state.lastSeq = snap.lastSeq;
  if (state.sessionId && (snap.records.length || snap.head.length)) {
    saveCache(state.sessionId, snap.records, state.liveEarlier, snap.head);
    scheduleDiskSave(state.sessionId, snap);
  }
}

/** fromSeq for a cached snap. */
function cacheAttachSeq(snap) {
  return snap?.lastSeq || 0;
}

/**
 * The "N earlier records are not shown." row, or null when nothing is omitted.
 * Tagged so ensureOpening can tell it apart from real conversation nodes.
 */
function earlierNotice(count) {
  if (!count || count <= 0) return null;
  const note = div('notice');
  note.dataset.earlier = '1';
  note.textContent = `${count.toLocaleString()} earlier records are not shown.`;
  return note;
}

/** Paint opening + optional omission notice + tail into an empty transcript. */
function paintTranscriptParts(head, omitted, records) {
  for (const rec of head || []) render(rec);
  const note = earlierNotice(omitted);
  if (note) add(note);
  for (const rec of records || []) render(rec);
}

/**
 * Prepend the opening prompt when catch-up brought it and the pane never had it
 * (e.g. a cache from before opening prompts were pinned).
 */
function ensureOpening(head, omitted) {
  if (!head?.length || state.liveHead.length) return;
  const keep = [...els.transcript.childNodes].filter(
    (n) => !(n.nodeType === 1 && n.dataset?.earlier),
  );
  els.transcript.innerHTML = '';
  state.replaying = true;
  for (const rec of head) render(rec);
  const gap =
    omitted > 0
      ? omitted
      : Math.max(0, (state.liveRecords[0]?.seq || 0) - head.at(-1).seq - 1);
  const note = earlierNotice(gap);
  if (note) add(note);
  state.replaying = false;
  for (const n of keep) els.transcript.appendChild(n);
  state.liveHead = head.slice();
  state.liveEarlier = gap;
  persistLive(state.sessionId);
  markScrubDirty();
}

/**
 * Draw a cached snapshot so the pane is not blank while the host catches up.
 * Tool tabs wait for `attached` (panes are host-owned); terminal chunks land
 * in the early buffer until then.
 */
function paintFromCache(snap) {
  if (!snap?.records?.length && !snap?.head?.length) return;
  resetChatUi();
  state.paintedFromCache = true;
  state.liveRecords = [];
  state.liveHead = [];
  state.liveEarlier = 0;
  state.lastSeq = 0;
  state.replaying = true;
  const omitted = snap.omitted || (snap.head?.length ? snap.earlier : 0) || 0;
  if (!snap.head?.length && snap.earlier > 0) {
    const note = earlierNotice(snap.earlier);
    if (note) add(note);
  }
  paintTranscriptParts(snap.head || [], snap.head?.length ? omitted : 0, snap.records || []);
  state.replaying = false;
  applyPendingRestore();
  state.liveHead = (snap.head || []).slice();
  state.liveRecords = (snap.records || []).slice();
  state.liveEarlier = omitted || snap.earlier || 0;
  state.lastSeq = snap.lastSeq || state.lastSeq;
  if (state.turn) endTurn({ ts: state.now || Date.now() });
  else settleRunningTools();
  decorate(els.transcript);
  scrollDown(true);
}

/** Long enough that "copy the whole answer as markdown" earns a button. */
const COPY_MD_MIN = 200;

/**
 * Flash a copy control as done, then restore. Text buttons pass a label;
 * icon buttons pass a restore function (or HTML string via opts.html).
 */
function flashCopied(btn, idle) {
  clearTimeout(btn._copyFlash);
  btn.classList.add('done');
  if (typeof idle === 'function') {
    btn._copyFlash = setTimeout(() => {
      idle();
      btn.classList.remove('done');
    }, 1200);
    return;
  }
  btn.textContent = 'Copied';
  btn._copyFlash = setTimeout(() => {
    btn.textContent = idle;
    btn.classList.remove('done');
  }, 1200);
}

/** Clipboard glyph — same stroke language as the rest of the chrome. */
const COPY_MD_ICON =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const COPY_MD_DONE =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

/**
 * Code is worth taking away, so every block carries a copy button. It lives
 * inside the <pre> and is skipped when reading the text back, which keeps the
 * markup free of a wrapper element that streaming would keep destroying.
 *
 * Long agent answers also get a "Copy markdown" footer — the raw source sits
 * on the bubble as `data-raw`, so the clipboard gets what was written, not a
 * DOM→text guess that loses fences and emphasis.
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
        flashCopied(b, 'Copy');
      } catch {
        b.textContent = 'Blocked';
      }
    };
    pre.prepend(b);
  }
  const msgs =
    root.matches?.('.msg.agent') ? [root] : [...(root.querySelectorAll?.('.msg.agent') ?? [])];
  for (const msg of msgs) syncAgentMdCopy(msg);
}

/**
 * Keep (or remove) the markdown copy footer as the answer grows. The button
 * sits outside `.agent-body`, so streaming HTML rewrites never destroy it.
 */
function syncAgentMdCopy(msg) {
  if (!msg?.classList?.contains('agent')) return;
  const raw = msg.dataset.raw || '';
  let foot = msg.querySelector(':scope > .copy-md');
  if (raw.length < COPY_MD_MIN) {
    foot?.remove();
    delete msg.dataset.mdCopy;
    return;
  }
  if (foot) return;
  msg.dataset.mdCopy = '1';
  foot = document.createElement('button');
  foot.type = 'button';
  foot.className = 'copy-md';
  foot.innerHTML = COPY_MD_ICON;
  foot.setAttribute('aria-label', 'Copy message as markdown');
  foot.title = 'Copy markdown';
  foot.onclick = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(msg.dataset.raw || '');
      foot.innerHTML = COPY_MD_DONE;
      flashCopied(foot, () => {
        foot.innerHTML = COPY_MD_ICON;
      });
    } catch {
      foot.title = 'Blocked';
    }
  };
  msg.append(foot);
}

/** The jump button only earns its place once you have scrolled away. */
function syncToBottom() {
  // Scrubbing owns the right edge — the ↓ would fight the grip.
  els.toBottom.hidden = state.scrubbing || nearBottom();
}

/**
 * Landmarks worth marking on the scrub timeline — the structure of a long
 * chat, not every tool card. Order matches the DOM.
 */
function scrubLandmarks() {
  return [...els.transcript.querySelectorAll('.msg.user, .ask, .created-plan, .perm, .file-review')];
}

function scrubKindOf(el) {
  if (el.classList.contains('user')) return 'you';
  if (el.classList.contains('ask')) return 'question';
  if (el.classList.contains('created-plan')) return 'plan';
  if (el.classList.contains('perm')) return 'approval';
  if (el.classList.contains('file-review')) return 'review';
  return '';
}

function scrubLabel(el) {
  if (el.classList.contains('user')) {
    const t = el.querySelector('.user-text')?.textContent?.trim() || '';
    if (t) return { kind: 'You', text: t };
    if (el.querySelector('.thumbs, .cap')) return { kind: 'You', text: 'Image' };
    return { kind: 'You', text: 'Message' };
  }
  if (el.classList.contains('ask')) {
    const t =
      el.querySelector('.title')?.textContent?.trim() ||
      el.querySelector('.prompt')?.textContent?.trim() ||
      '';
    return { kind: 'Question', text: t || 'Waiting for an answer' };
  }
  if (el.classList.contains('created-plan')) {
    const t = el.querySelector('.title')?.textContent?.trim() || '';
    return { kind: 'Plan', text: t || 'Created plan' };
  }
  if (el.classList.contains('perm')) {
    const t = el.querySelector('.what')?.textContent?.trim() || '';
    return { kind: 'Approval', text: t || 'Needs a decision' };
  }
  if (el.classList.contains('file-review')) {
    const t = el.querySelector('.what')?.textContent?.trim() || '';
    return { kind: 'Review', text: t || 'Edits' };
  }
  return { kind: '', text: '' };
}

function scrubClip(s, n = 72) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  return `${t.slice(0, n - 1).trimEnd()}…`;
}

/** Tall enough that a scrubber earns its keep. */
function scrubWorthShowing() {
  const t = els.transcript;
  return t.scrollHeight > t.clientHeight + 240;
}

function scrubScrollRatio() {
  const t = els.transcript;
  const max = Math.max(1, t.scrollHeight - t.clientHeight);
  return Math.min(1, Math.max(0, t.scrollTop / max));
}

/**
 * Where the wheel and handle sit. While a finger drives the grip, that is the
 * finger — not scrolled/snapped chat — so labels glide even when the transcript
 * latches onto a landmark.
 */
function scrubLayoutRatio() {
  if (state.scrubPointer && typeof state.scrubDriveRatio === 'number') {
    return state.scrubDriveRatio;
  }
  return scrubScrollRatio();
}

/**
 * Build every landmark into a rotary timeline. More entries than fit are
 * deliberate: the wheel moves them through the viewport and fades its ends.
 */
function rebuildScrubTimeline() {
  if (!els.scrubTimeline) return;
  const t = els.transcript;
  const h = t.scrollHeight || 1;
  const maxScroll = Math.max(1, t.scrollHeight - t.clientHeight);
  const marks = scrubLandmarks();
  const entries = marks.map((el, i) => {
    const topPx = el.offsetTop;
    const nextTop = i + 1 < marks.length ? marks[i + 1].offsetTop : h;
    const span = Math.max(1, nextTop - topPx);
    return {
      el,
      kind: scrubKindOf(el),
      top: topPx / h,
      spanFrac: span / h,
      snapRatio: scrubScrollTopFor(el) / maxScroll,
      label: scrubLabel(el),
    };
  });
  els.scrubTimeline.replaceChildren();
  state.scrubEntries = [];

  for (const entry of entries) {
    const pill = document.createElement('div');
    pill.className = 'scrub-pill';
    pill.dataset.kind = entry.kind;
    paintScrubPill(pill, entry);
    els.scrubTimeline.append(pill);
    state.scrubEntries.push({ ...entry, pill });
  }
  state.scrubTimelineDirty = false;
  requestAnimationFrame(layoutScrubWheel);
}

function paintScrubPill(pill, entry) {
  let text = pill.querySelector('.scrub-text');
  if (!text) {
    text = document.createElement('span');
    text.className = 'scrub-text';
    pill.replaceChildren(text);
  }
  text.textContent = scrubClip(entry.label.text, 72);
  pill.style.width = '22px';
  pill.style.opacity = '0';
}

/**
 * Finger (or scroll) progress → fractional landmark index on the wheel.
 * Linear in the rail, not in chat scroll: a long stretch of text between two
 * landmarks must not make the labels crawl, and a dense cluster must not make
 * them leap. Chat scroll and snap stay on their own path.
 */
function scrubWheelProgress(ratio) {
  const entries = state.scrubEntries;
  if (entries.length <= 1) return 0;
  const r = Math.min(1, Math.max(0, ratio));
  return r * (entries.length - 1);
}

/**
 * Counter-scroll the label wheel. Its left edge traces a semicircle: width is
 * sqrt(r²-y²), widest at vertical centre and zero at the top/bottom.
 */
function layoutScrubWheel() {
  if (!state.scrubbing || !els.scrubTimeline) return;
  const entries = state.scrubEntries;
  if (!entries.length) return;
  const height = els.scrubTimeline.clientHeight;
  const centre = height / 2;
  const radius = Math.max(1, centre - 6);
  const gap = 34;
  const progress = scrubWheelProgress(scrubLayoutRatio());
  const activeIndex = Math.max(0, Math.min(entries.length - 1, Math.round(progress)));

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const y = centre + (i - progress) * gap;
    const normalized = Math.min(1, Math.abs(y - centre) / radius);
    const circle = Math.sqrt(Math.max(0, 1 - normalized * normalized));
    const active = i === activeIndex;
    // Past the semicircle: hide hard. Opacity alone still painted a ghost
    // while width/colour eased, and half a pill sat past the clip edge.
    const onWheel = normalized < 1;
    entry.pill.style.top = `${y}px`;
    // Widest ~260px at centre — room for a readable sentence fragment.
    entry.pill.style.width = `${Math.round(22 + circle * 238)}px`;
    entry.pill.style.transform = 'translateY(-50%)';
    entry.pill.style.visibility = onWheel ? 'visible' : 'hidden';
    // Active stays fully readable even when slightly off-centre.
    entry.pill.style.opacity = String(
      !onWheel ? 0 : active ? Math.max(0.95, Math.pow(circle, 0.75)) : Math.pow(circle, 0.75),
    );
    entry.pill.classList.toggle('active', active);
  }
}

function nearestScrubEntry(y) {
  const entries = state.scrubEntries;
  if (!entries.length) return null;
  let best = entries[0];
  let bestDist = Infinity;
  for (const entry of entries) {
    const mid = entry.el.offsetTop + entry.el.offsetHeight / 2;
    const d = Math.abs(mid - y);
    if (d < bestDist) {
      bestDist = d;
      best = entry;
    }
  }
  return best;
}

/** Scroll so the landmark sits at the same reading line used for “active”. */
function scrubScrollTopFor(el) {
  const t = els.transcript;
  const max = Math.max(0, t.scrollHeight - t.clientHeight);
  return Math.max(0, Math.min(max, el.offsetTop - t.clientHeight * 0.28));
}

/** Short tick on phones that expose Vibration API (Android Chrome; iOS no-ops). */
function scrubBuzz() {
  try {
    navigator.vibrate?.(12);
  } catch {
    /* ignore */
  }
}

/** How close (in rail pixels) the finger must be before the magnet pulls. */
const SCRUB_SNAP_PX = 14;

function snapScrubToEntry(entry, { buzz = true } = {}) {
  if (!entry) return;
  const t = els.transcript;
  const prev = t.style.scrollBehavior;
  t.style.scrollBehavior = 'auto';
  t.scrollTop = scrubScrollTopFor(entry.el);
  t.style.scrollBehavior = prev;
  if (buzz && state.scrubSnapEl !== entry.el) {
    state.scrubSnapEl = entry.el;
    scrubBuzz();
  } else {
    state.scrubSnapEl = entry.el;
  }
  syncScrubHandle();
  syncScrubActive();
}

function nearestScrubByScrollRatio(ratio) {
  const entries = state.scrubEntries;
  const t = els.transcript;
  const max = Math.max(1, t.scrollHeight - t.clientHeight);
  if (!entries.length) return { entry: null, distPx: Infinity };
  let best = entries[0];
  let bestDist = Infinity;
  for (const entry of entries) {
    const snapRatio = scrubScrollTopFor(entry.el) / max;
    const d = Math.abs(snapRatio - ratio);
    if (d < bestDist) {
      bestDist = d;
      best = entry;
    }
  }
  const rail = els.scrub?.getBoundingClientRect().height || t.clientHeight;
  return { entry: best, distPx: bestDist * Math.max(1, rail - 48) };
}

function scrubStepLandmark(dir) {
  const entries = state.scrubEntries;
  if (!entries.length) return;
  let idx = entries.findIndex((e) => e.el === state.scrubSnapEl);
  if (idx < 0) {
    const y = els.transcript.scrollTop + els.transcript.clientHeight * 0.28;
    const cur = nearestScrubEntry(y);
    idx = Math.max(0, entries.indexOf(cur));
  }
  const next = entries[Math.max(0, Math.min(entries.length - 1, idx + dir))];
  snapScrubToEntry(next);
}

function syncScrubHandle() {
  const ratio = scrubLayoutRatio();
  const pct = `${ratio * 100}%`;
  if (els.scrubHandle) {
    els.scrubHandle.style.top = pct;
    els.scrubHandle.setAttribute('aria-valuemin', '0');
    els.scrubHandle.setAttribute('aria-valuemax', '100');
    els.scrubHandle.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
    els.scrubHandle.setAttribute('role', 'slider');
  }
  return ratio;
}

function syncScrubActive() {
  layoutScrubWheel();
}

function setScrubMode(mode) {
  if (!els.scrub) return;
  els.scrub.dataset.mode = mode;
  if (els.scrubTimeline) {
    const open = mode === 'scrub';
    els.scrubTimeline.hidden = !open;
    els.scrubTimeline.setAttribute('aria-hidden', open ? 'false' : 'true');
  }
}

/** Hint mode: handle only, while scrolling a long chat. */
function showScrubHint() {
  if (!els.scrub || !scrubWorthShowing()) {
    hideScrub(true);
    return;
  }
  els.scrub.hidden = false;
  els.scrub.dataset.active = '1';
  if (!state.scrubbing) setScrubMode('hint');
  syncScrubHandle();
  clearTimeout(state.scrubHide);
  if (!state.scrubbing) {
    // Dock to a right-edge peek — do not remove from the pane.
    state.scrubHide = setTimeout(() => hideScrub(), 1400);
  }
}

/** Scrub mode: expand labeled timeline left of the thumb. */
function enterScrubMode() {
  if (!els.scrub || !scrubWorthShowing()) return;
  state.scrubbing = true;
  state.scrubSnapEl = null;
  clearTimeout(state.scrubHide);
  els.scrub.hidden = false;
  els.scrub.dataset.active = '1';
  els.toBottom.hidden = true;
  if (state.scrubTimelineDirty) rebuildScrubTimeline();
  setScrubMode('scrub');
  syncScrubHandle();
  syncScrubActive();
}

function leaveScrubMode() {
  if (!state.scrubbing) return;
  state.scrubbing = false;
  state.scrubPointer = false;
  state.scrubDriveRatio = null;
  state.scrubSnapEl = null;
  setScrubMode('hint');
  // Rebuild so secondary pills regain their resting tops/widths.
  state.scrubTimelineDirty = true;
  syncToBottom();
  state.scrubHide = setTimeout(() => hideScrub(), 900);
}

/**
 * Idle = docked peek on the right edge. Force tears it down (short chat /
 * session switch). Tapping the peek or scrolling slides it back out.
 */
function hideScrub(force = false) {
  if (!els.scrub) return;
  if (state.scrubbing && !force) return;
  clearTimeout(state.scrubHide);
  state.scrubHide = null;
  delete els.scrub.dataset.active;
  setScrubMode('hint');
  if (force || !scrubWorthShowing()) {
    state.scrubbing = false;
    state.scrubPointer = false;
    state.scrubDriveRatio = null;
    els.scrub.hidden = true;
  }
}

function onTranscriptScroll() {
  if (state.scrubbing) {
    els.toBottom.hidden = true;
    syncScrubHandle();
    syncScrubActive();
    return;
  }
  els.toBottom.hidden = nearBottom();
  if (state.replaying) return;
  showScrubHint();
}

function scrubToClientY(clientY) {
  const t = els.transcript;
  if (!t || !els.scrub) return;
  const rect = els.scrub.getBoundingClientRect();
  const pad = 24;
  const usable = Math.max(1, rect.height - pad * 2);
  const ratio = Math.min(1, Math.max(0, (clientY - rect.top - pad) / usable));
  // Labels and the grip follow the finger; chat may still snap underneath.
  state.scrubDriveRatio = ratio;
  const max = Math.max(0, t.scrollHeight - t.clientHeight);
  const prev = t.style.scrollBehavior;
  t.style.scrollBehavior = 'auto';

  // Rail bottom = true chat bottom (not "last landmark mid-view"), so ↓
  // stays hidden because we are actually there.
  if ((1 - ratio) * usable <= SCRUB_SNAP_PX) {
    t.scrollTop = max;
    if (state.scrubSnapEl !== els.transcript) {
      state.scrubSnapEl = els.transcript;
      scrubBuzz();
    }
    t.style.scrollBehavior = prev;
    syncScrubHandle();
    syncScrubActive();
    return;
  }

  const { entry, distPx } = nearestScrubByScrollRatio(ratio);
  if (entry && distPx <= SCRUB_SNAP_PX) {
    // Snap the transcript only — leave scrubDriveRatio alone so the wheel
    // does not jump to the latch point and jitter under the finger.
    if (state.scrubSnapEl !== entry.el) {
      state.scrubSnapEl = entry.el;
      scrubBuzz();
    }
    t.scrollTop = scrubScrollTopFor(entry.el);
    t.style.scrollBehavior = prev;
    syncScrubHandle();
    syncScrubActive();
    return;
  }
  // Free scrub — clear the latch once the finger leaves the snap zone so the
  // next approach can buzz again.
  if (state.scrubSnapEl && distPx > SCRUB_SNAP_PX * 1.6) {
    state.scrubSnapEl = null;
  }
  t.scrollTop = ratio * max;
  t.style.scrollBehavior = prev;
  syncScrubHandle();
  syncScrubActive();
}

function bindScrubber() {
  const handle = els.scrubHandle;
  if (!handle) return;

  const start = (e) => {
    if (!scrubWorthShowing()) return;
    e.preventDefault();
    state.scrubPointer = true;
    enterScrubMode();
    scrubToClientY(e.clientY);
    handle.setPointerCapture?.(e.pointerId);
  };
  const move = (e) => {
    if (!state.scrubbing) return;
    e.preventDefault();
    scrubToClientY(e.clientY);
  };
  const end = () => {
    if (!state.scrubbing) return;
    state.scrubPointer = false;
    state.scrubDriveRatio = null;
    leaveScrubMode();
  };

  handle.addEventListener('pointerdown', start);
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  handle.addEventListener('lostpointercapture', end);

  handle.addEventListener('keydown', (e) => {
    const t = els.transcript;
    const keys = ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    enterScrubMode();
    if (state.scrubTimelineDirty) rebuildScrubTimeline();
    const entries = state.scrubEntries;
    if (e.key === 'ArrowDown' || e.key === 'PageDown') {
      scrubStepLandmark(1);
    } else if (e.key === 'ArrowUp' || e.key === 'PageUp') {
      scrubStepLandmark(-1);
    } else if (e.key === 'Home' && entries[0]) {
      snapScrubToEntry(entries[0]);
    } else if (e.key === 'End') {
      const max = Math.max(0, t.scrollHeight - t.clientHeight);
      t.style.scrollBehavior = 'auto';
      t.scrollTop = max;
      syncScrubHandle();
      syncScrubActive();
    } else {
      syncScrubHandle();
      syncScrubActive();
    }
    clearTimeout(state.scrubHide);
    state.scrubHide = setTimeout(() => leaveScrubMode(), 1200);
  });
}

/** Timeline goes stale whenever the transcript gains or loses a landmark. */
function markScrubDirty() {
  state.scrubTimelineDirty = true;
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
  // A turn that was pulled back into the composer has nothing left to summarise.
  if (rec?.interrupted || state.withdrawnTurn) {
    state.withdrawnTurn = false;
    settleRunningTools();
    closeThinking();
    dropLiveStatus();
    state.turn = null;
    return;
  }
  settleRunningTools();
  closeThinking();
  if (state.streamBody) state.streamBody.style.minHeight = '';
  if (state.stream?.classList?.contains('agent')) syncAgentMdCopy(state.stream);
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
    // Stream is closing — drop the height pin and offer the markdown copy
    // icon before we drop the pointer (tools/notices arrive without keepStream).
    if (state.streamBody) state.streamBody.style.minHeight = '';
    if (state.stream?.classList?.contains('agent')) syncAgentMdCopy(state.stream);
    closeThinking();
    state.stream = null;
    state.streamKind = null;
    state.streamBody = null;
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
  markScrubDirty();
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
      state.streamBody = null;
      state.stream.dataset.raw = '';
    } else {
      // Body holds rendered HTML; the outer bubble keeps data-raw + the copy
      // footer. Rewriting innerHTML on the outer node would destroy the button.
      const d = div('msg agent');
      const body = div('agent-body');
      d.append(body);
      closeThinking();
      add(d, { keepStream: true });
      if (state.turn && !state.turn.answer) state.turn.answer = d;
      state.stream = d;
      state.streamBody = body;
      state.stream.dataset.raw = '';
    }
  }
  const stick = nearBottom();
  // A desktop rewrite replaces the bubble; appending would stutter the answer.
  if (rec.replace) {
    state.stream.dataset.raw = rec.text || '';
    if (state.streamBody) state.streamBody.style.minHeight = '';
  } else {
    state.stream.dataset.raw += rec.text || '';
  }
  if (isThought) {
    state.stream.textContent = state.stream.dataset.raw;
  } else {
    const body = state.streamBody || state.stream.querySelector(':scope > .agent-body') || state.stream;
    // Incomplete markdown (open fence, half a table) briefly collapses then
    // grows — pin the floor so the pane does not jump up under the reader.
    const floor = Math.max(body.offsetHeight, parseFloat(body.style.minHeight) || 0);
    body.innerHTML = markdown(state.stream.dataset.raw);
    body.style.minHeight = `${Math.max(floor, body.offsetHeight)}px`;
  }
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

  card.querySelector('.view').onclick = () => openPlanView(card);
  card.querySelector('.build').onclick = () => sendPlanBuild(card);

  if (rec.toolCallId) state.toolCards.set(rec.toolCallId, card);
  paintCreatedPlan(card, rec);
  add(card);
}

/** Full-window plan markdown — same idea as Settings, closed with ×. */
function openPlanView(card) {
  const fields = planFields(card.rec || {});
  state.openPlanId = card.rec?.toolCallId || null;
  state.openPlanCard = card;
  els.planSheetTitle.textContent = fields.name || 'Plan';
  els.planBody.innerHTML = fields.markdown
    ? markdown(fields.markdown)
    : '<p class="sheet-note">No plan text yet.</p>';
  els.planBody.scrollTop = 0;
  fillPlanModels(els.planBuildModel);
  const fromCard = card.querySelector('.build-model')?.value;
  if (fromCard != null && [...els.planBuildModel.options].some((o) => o.value === fromCard)) {
    els.planBuildModel.value = fromCard;
  }
  delete els.planBuild.dataset.sent;
  if (card.querySelector('.build')?.dataset.sent) els.planBuild.dataset.sent = '1';
  paintPlanActions(card);
  setPlanSheet(true);
}

function setPlanSheet(open) {
  els.planSheet.hidden = !open;
  if (!open) {
    els.planBody.innerHTML = '';
    els.planSheetTitle.textContent = 'Plan';
    els.planOutcome.textContent = '';
    state.openPlanId = null;
    state.openPlanCard = null;
  }
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

function sendPlanBuild(card, modelSelect) {
  const rec = card.rec || {};
  const pick = modelSelect || card.querySelector('.build-model');
  const model = pick?.value || '';
  const outcome = card.querySelector('.outcome');
  for (const b of card.querySelectorAll('button, select')) {
    if (!b.classList.contains('view')) b.disabled = true;
  }
  card.querySelector('.build').dataset.sent = '1';
  if (outcome) outcome.textContent = 'building…';
  if (state.openPlanCard === card) {
    els.planBuild.disabled = true;
    els.planBuildModel.disabled = true;
    els.planBuild.dataset.sent = '1';
    els.planOutcome.textContent = 'building…';
  }
  sendOp({
    op: 'plan.build',
    sessionId: state.sessionId,
    toolCallId: rec.toolCallId,
    model,
  });
}

/** Keep the card and the full-window footer in the same Build state. */
function paintPlanActions(card) {
  const fields = planFields(card.rec || {});
  const waiting = fields.awaitingBuild && card.rec.awaitingBuild !== false;
  const sent = Boolean(card.querySelector('.build')?.dataset.sent);
  const outcome = card.querySelector('.outcome');
  card.classList.toggle('resolved', !waiting);
  if (!waiting) {
    if (outcome) outcome.textContent = outcome.textContent?.startsWith('Building')
      ? outcome.textContent
      : 'Built.';
    for (const b of card.querySelectorAll('button, select')) {
      if (!b.classList.contains('view')) b.disabled = true;
    }
  } else if (!sent) {
    if (outcome) outcome.textContent = '';
    for (const b of card.querySelectorAll('button, select')) b.disabled = false;
  }
  if (els.planSheet.hidden || state.openPlanCard !== card) return;
  if (!waiting) {
    els.planOutcome.textContent = els.planOutcome.textContent?.startsWith('Building')
      ? els.planOutcome.textContent
      : 'Built.';
    els.planBuild.disabled = true;
    els.planBuildModel.disabled = true;
  } else if (!sent) {
    els.planOutcome.textContent = '';
    els.planBuild.disabled = false;
    els.planBuildModel.disabled = false;
  } else {
    els.planBuild.disabled = true;
    els.planBuildModel.disabled = true;
    if (!els.planOutcome.textContent) els.planOutcome.textContent = 'building…';
  }
}

function paintCreatedPlan(card, rec) {
  card.rec = { ...(card.rec || {}), ...rec };
  const fields = planFields(card.rec);
  card.querySelector('.title').textContent = fields.name;
  const overview = card.querySelector('.overview');
  overview.textContent = fields.overview;
  overview.hidden = !fields.overview;
  // If this plan is open in the modal, keep the text current as Cursor
  // streams more of it in.
  if (!els.planSheet.hidden && card.rec?.toolCallId && card.rec.toolCallId === state.openPlanId) {
    els.planSheetTitle.textContent = fields.name || 'Plan';
    if (fields.markdown) els.planBody.innerHTML = markdown(fields.markdown);
  }
  paintPlanActions(card);
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
  // Stopping puts the prompt back in the box so it can be fixed and sent
  // again — same gesture as Cursor's own Stop. The interrupted turn leaves
  // the stream; the words belong in the composer now.
  if (rec.interrupted && (rec.restore != null || rec.imageParts?.length)) {
    withdrawInterruptedTurn();
    const payload = {
      text: rec.restore || '',
      imageParts: rec.imageParts || [],
    };
    if (state.replaying) state.pendingRestore = payload;
    else fillComposer(payload);
    return;
  }
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

/**
 * Take the interrupted turn off the stream — user bubble and everything that
 * followed it this turn — so the prompt can live in the composer instead.
 */
function withdrawInterruptedTurn() {
  state.withdrawnTurn = true;
  if (state.streamBody) state.streamBody.style.minHeight = '';
  state.stream = null;
  state.streamKind = null;
  state.streamBody = null;
  state.bundle = null;
  closeThinking();
  dropLiveStatus();
  state.turn = null;
  state.pendingEchoes = [];
  const nodes = [...els.transcript.children];
  let from = -1;
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    if (nodes[i].classList?.contains('msg') && nodes[i].classList.contains('user')) {
      from = i;
      break;
    }
  }
  if (from < 0) return;
  for (let i = from; i < nodes.length; i += 1) nodes[i].remove();
}

/** Put the caret in the message box — new chats and restored drafts both want this. */
function focusComposer() {
  try {
    els.box.focus({ preventScroll: true });
  } catch {
    try {
      els.box.focus();
    } catch {
      /* phone browsers may refuse focus without a tap */
    }
  }
}

/** Put a stopped prompt back in the box, ready to edit and send again. */
function fillComposer({ text = '', imageParts = [] } = {}) {
  els.box.value = text;
  state.attachments = (imageParts || [])
    .map((part) => {
      const mimeType = part.mimeType || part.mime || 'image/png';
      const data = part.data || '';
      const url = part.url || (data ? `data:${mimeType};base64,${data}` : '');
      if (!data && !url) return null;
      return { mimeType, data, url, name: part.name || 'image' };
    })
    .filter(Boolean);
  renderAttachments();
  autosize();
  saveDraft();
  focusComposer();
}

/** After replay, put the latest unreplied interrupt back in the box. */
function applyPendingRestore() {
  const payload = state.pendingRestore;
  state.pendingRestore = null;
  if (payload && (payload.text || payload.imageParts?.length)) fillComposer(payload);
}

function render(rec) {
  if (typeof rec.seq === 'number') state.lastSeq = Math.max(state.lastSeq, rec.seq);
  state.now = rec.ts || Date.now();
  if (rec.kind !== 'tool_call' && rec.kind !== 'tool_update') flushBundle();

  switch (rec.kind) {
    case 'user_message':
      // A later real send means the restored draft from an older interrupt
      // should not land in the box after replay finishes.
      if (state.replaying && !rec.echoed && !rec.waiting) state.pendingRestore = null;
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
  noteLiveRecord(rec);
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

/** Which accordion row the rail shows: chats, projects, or neither. */
const RAIL_SECTION_KEY = 'auto.railSection';

function railSection() {
  try {
    const v = localStorage.getItem(RAIL_SECTION_KEY);
    if (v === 'projects' || v === 'none') return v;
    return 'chats';
  } catch {
    return 'chats';
  }
}

function rememberRailSection(which) {
  try {
    localStorage.setItem(
      RAIL_SECTION_KEY,
      which === 'projects' || which === 'none' ? which : 'chats',
    );
  } catch {
    /* private mode */
  }
}

/**
 * One of the two category rows. Opening one closes the other; tapping an
 * open row collapses it (both may be closed).
 */
function railAccordion(id, label, open) {
  const details = document.createElement('details');
  details.className = 'rail-section';
  details.dataset.section = id;
  details.open = open;

  const summary = document.createElement('summary');
  summary.textContent = label;
  const body = div('rail-section-body');
  details.append(summary, body);

  details.addEventListener('toggle', () => {
    // Clearing the rail fires toggle on every open <details> as it leaves the
    // tree. Those are not user collapses — believing them wrote "none" into
    // storage, so the next paint always came back with both rows shut.
    if (!details.isConnected) return;
    if (details.open) {
      rememberRailSection(id);
      for (const other of els.rail.querySelectorAll('.rail-section')) {
        if (other !== details && other.open) other.open = false;
      }
      return;
    }
    const anyOpen = [...els.rail.querySelectorAll('.rail-section')].some((d) => d.open);
    if (!anyOpen) rememberRailSection('none');
  });

  return { details, body };
}

/**
 * The rail is two accordion rows — Chats and Projects — so switching category
 * is one tap, not a scroll to a buried details at the bottom. Chats still
 * reads like Cursor's history (newest first, date headings); Projects is the
 * folders Cursor knows, for starting somewhere new or older desktop chats.
 */
function renderRail() {
  els.rail.innerHTML = '';
  const open = railSection();
  const items = conversations();

  const chats = railAccordion('chats', `Chats (${items.length})`, open === 'chats');
  let heading = null;
  for (const item of items) {
    const bucket = dateBucket(item.at);
    if (bucket !== heading) {
      heading = bucket;
      const head = div('rail-group');
      head.textContent = bucket;
      chats.body.appendChild(head);
    }
    chats.body.appendChild(sessionRow(item));
  }
  if (!items.length) {
    const empty = div('rail-empty');
    empty.textContent = 'No conversations yet.';
    chats.body.appendChild(empty);
  }

  const projects = state.projects.length
    ? state.projects
    : [...new Set(state.sessions.map((s) => s.folder).filter(Boolean))].map((path) => ({
        path,
        name: (path || '').split(/[\\/]/).pop(),
        open: false,
      }));
  const projectsPanel = railAccordion(
    'projects',
    `Projects (${projects.length})`,
    open === 'projects',
  );
  if (!projects.length) {
    const empty = div('rail-empty');
    empty.textContent = 'No projects yet — start a new session.';
    projectsPanel.body.appendChild(empty);
  } else {
    for (const project of projects) {
      projectsPanel.body.appendChild(projectHeader(project, 0));
      const desktop = desktopChatsBlock(project);
      if (desktop) projectsPanel.body.appendChild(desktop);
    }
  }

  els.rail.append(chats.details, projectsPanel.details);
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
    if (project.path) createSession(project.path);
  };

  // Tapping the project is the phone-sized target: go to its newest session,
  // or start one if it has none.
  actsAsButton(head, () => {
    if (!project.path) return;
    const mine = state.sessions.filter((s) => sameFolder(s.folder, project.path));
    if (mine.length) attach(mine[0].id);
    else createSession(project.path);
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
  const label = meta.status === 'busy' ? 'working' : meta.status || 'idle';
  const kind = meta.status === 'busy' ? 'busy' : meta.status === 'error' ? 'error' : 'idle';
  els.status.className = `dot ${kind}`;
  els.status.title = label;
  els.status.setAttribute('aria-label', label);
  paintNewChat();
}

/** Folder of the open chat — what a same-repo "New chat" should start in. */
function currentFolder() {
  const mine = state.sessions.find((s) => s.id === state.sessionId);
  return String(mine?.folder || els.folder.textContent || '').trim();
}

/**
 * Topbar New chat is only live when this tab is on a session that has a
 * folder. No folder means nowhere to start the next empty conversation.
 */
function paintNewChat() {
  const btn = $('new-chat');
  if (!btn) return;
  const folder = currentFolder();
  btn.disabled = !folder;
  const name = folder ? folder.split(/[/\\]/).filter(Boolean).pop() : '';
  btn.title = folder
    ? `New chat in ${name || 'this repo'}`
    : 'Open a session to start a new chat';
  btn.setAttribute('aria-label', btn.title);
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
const VIEWS_KEY = 'auto.views';

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

/** Which tool tabs were open for a chat — survives refresh and session switch. */
function rememberedViews(sessionId) {
  if (!sessionId) return null;
  try {
    const all = JSON.parse(localStorage.getItem(VIEWS_KEY) || '{}');
    return all[sessionId] || null;
  } catch {
    return null;
  }
}

function rememberViews(sessionId, snap) {
  if (!sessionId || !snap) return;
  try {
    const all = JSON.parse(localStorage.getItem(VIEWS_KEY) || '{}');
    all[sessionId] = snap;
    const keys = Object.keys(all);
    // Cap growth: drop the oldest-looking keys beyond a few dozen chats.
    if (keys.length > 40) {
      for (const k of keys.slice(0, keys.length - 40)) delete all[k];
    }
    localStorage.setItem(VIEWS_KEY, JSON.stringify(all));
  } catch {
    /* private mode */
  }
}

function attach(sessionId) {
  if (sessionId === state.sessionId) {
    setRail(false);
    return;
  }
  // Keep the chat we are leaving so switching back is instant.
  if (state.sessionId && (state.liveRecords.length || state.liveHead.length)) {
    const snap = saveCache(state.sessionId, state.liveRecords, state.liveEarlier, state.liveHead);
    if (snap) {
      scheduleDiskSave(state.sessionId, snap);
      flushDiskSave(state.sessionId);
    }
  }
  saveDraft(state.sessionId);
  setPlanSheet(false);
  state.sessionId = sessionId;
  rememberSession(sessionId);
  state.pendingEchoes = [];
  state.paintedFromCache = false;
  loadDraft(sessionId);
  setRail(false);

  // Memory is sync — paint it before the old chat can linger as the wrong one.
  const warm = memoryGet(sessionId);
  if (warm?.records?.length || warm?.head?.length) {
    paintFromCache(warm);
    setHistoryLoading(false);
    sendOp({ op: 'attach', sessionId, fromSeq: cacheAttachSeq(warm) });
    return;
  }

  state.lastSeq = 0;
  state.liveRecords = [];
  state.liveHead = [];
  state.liveEarlier = 0;
  resetChatUi();
  setHistoryLoading(true);
  // Disk may still have it (e.g. after a reload that only warmed this tab's chat).
  loadCache(sessionId).then((cached) => {
    if (state.sessionId !== sessionId) return;
    if (cached?.records?.length || cached?.head?.length) {
      paintFromCache(cached);
      setHistoryLoading(false);
      sendOp({ op: 'attach', sessionId, fromSeq: cacheAttachSeq(cached) });
      return;
    }
    sendOp({ op: 'attach', sessionId, fromSeq: 0 });
  });
}

/** Rail header + Settings Host both read from this. */
function setConn(kind, label) {
  els.conn.className = kind === 'ok' ? 'dot ok'
    : kind === 'error' ? 'dot error'
    : 'dot';
  els.conn.title = label;
  els.conn.setAttribute('aria-label', label);
  if (!els.sheet.hidden) {
    $('sheet-conn').textContent = `${label} · ${location.host}`;
  }
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  // Say what is already on screen. The host replays the moment it accepts the
  // socket, so this has to travel with the handshake rather than be asked for
  // afterwards; without it every dropped connection redraws the conversation
  // from scratch, which on a flaky phone connection is most of them.
  // A first load has no lastSeq unless the cache painted first — that used to
  // omit the session entirely, and the host then opened whichever chat was
  // active, not the one this tab had.
  const q = new URLSearchParams();
  const sessionId = state.sessionId || rememberedSession();
  if (sessionId) q.set('session', sessionId);
  if (state.sessionId && sessionId === state.sessionId && state.lastSeq) {
    q.set('fromSeq', String(state.lastSeq));
  }
  const query = q.toString();
  // A reconnect (or a cache hit) that already has the conversation on screen
  // should not cover it; a cold load has nothing else to show.
  if (!state.lastSeq) setHistoryLoading(true);
  const ws = new WebSocket(`${proto}://${location.host}/${query ? `?${query}` : ''}`);
  state.ws = ws;

  ws.onopen = () => setConn('ok', 'Connected');

  ws.onclose = () => {
    setConn('error', 'Reconnecting…');
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
      const fromCache = state.paintedFromCache;
      state.paintedFromCache = false;
      state.sessionId = msg.sessionId;
      rememberSession(msg.sessionId);
      if (fresh) {
        resetChatUi();
        state.liveRecords = [];
        state.liveHead = [];
        state.liveEarlier = 0;
      }
      renderModels(msg.catalog?.models);
      renderModes(msg.catalog?.modes);
      if (msg.projects) state.projects = msg.projects;
      if (msg.chats) state.chats = msg.chats;
      state.replaying = true;
      applyMeta(msg.meta);
      renderRail();
      // Panes first (quiet), so replayed terminal chunks have somewhere to land
      // and the remembered active tab can win after restoreViews.
      for (const t of msg.terminals || []) openPane(t, { activate: false });
      // Cache paint skipped tool tabs (host-owned panes). Restore them on the
      // first attach even when the transcript only caught up.
      if (fresh || fromCache) restoreViews(rememberedViews(msg.sessionId));
      // Opening prompt first (when the tail alone would hide it), then the
      // omission notice, then the newest stretch.
      if (fresh) {
        const omitted =
          msg.omitted != null
            ? msg.omitted
            : msg.head?.length
              ? msg.earlier
              : 0;
        if (!msg.head?.length && msg.earlier > 0) {
          const note = earlierNotice(msg.earlier);
          if (note) add(note);
        }
        paintTranscriptParts(msg.head || [], msg.head?.length ? omitted : 0, msg.records);
      } else {
        ensureOpening(msg.head || [], msg.omitted || 0);
        for (const rec of msg.records) render(rec);
      }
      state.replaying = false;
      applyPendingRestore();
      if (fresh) {
        adoptLive(
          msg.records,
          msg.head?.length ? msg.omitted || 0 : msg.earlier || 0,
          msg.head || [],
        );
      } else if (msg.records.length) {
        const merged = mergeRecords(state.liveRecords, msg.records);
        adoptLive(merged, state.liveEarlier, state.liveHead);
      } else if (state.sessionId) {
        persistLive(state.sessionId);
      }
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
        const t = $('term-toggle');
        t.disabled = true;
        t.title = 'Terminals are unavailable on this host';
      }
      decorate(els.transcript);
      scrollDown(true);
      setHistoryLoading(false);
      // Whatever was queued before you looked is still queued.
      sendOp({ op: 'queue.list', sessionId: msg.sessionId });
      // File-review bar may already be up from a finished turn.
      sendOp({ op: 'review.list', sessionId: msg.sessionId });
      if (state.focusComposer) {
        state.focusComposer = false;
        focusComposer();
      }
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
      paintNewChat();
      return;
    }

    if (msg.type === 'host.restarting') {
      setConn('', 'Restarting…');
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
        if (state.openPlanCard === card) {
          els.planBuild.disabled = true;
          els.planBuildModel.disabled = true;
          els.planOutcome.textContent = 'Building in Cursor…';
        }
        return;
      }
      for (const b of card.querySelectorAll('button, select')) {
        if (!b.classList.contains('view')) b.disabled = false;
      }
      const build = card.querySelector('.build');
      if (build) delete build.dataset.sent;
      if (outcome) outcome.textContent = msg.reason || 'could not build — try again';
      if (state.openPlanCard === card) {
        delete els.planBuild.dataset.sent;
        els.planBuild.disabled = false;
        els.planBuildModel.disabled = false;
        els.planOutcome.textContent = msg.reason || 'could not build — try again';
      }
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

    if (msg.type === 'review') {
      if (msg.sessionId && msg.sessionId !== state.sessionId) return;
      state.review = {
        actions: msg.actions || [],
        added: msg.added ?? null,
        removed: msg.removed ?? null,
      };
      if (msg.acted && msg.acted.status !== 'pressed') {
        render({
          kind: 'notice',
          text: msg.acted.reason || `Could not press ${msg.acted.name || 'that'} in Cursor.`,
        });
      }
      renderFileReview();
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

/**
 * Cursor's Keep / Undo / Redo as the last block of a finished turn.
 *
 * Lives in the transcript (and the scrub timeline), not stuck above the
 * composer. Headline is +/− from this turn's edits when Cursor reported them.
 */
function renderFileReview() {
  const actions = state.review?.actions || [];
  let stats =
    state.review?.added != null || state.review?.removed != null
      ? { added: state.review.added || 0, removed: state.review.removed || 0 }
      : null;
  if (!stats) {
    const records = [...(state.liveHead || []), ...(state.liveRecords || [])];
    stats = editStatsForTurn(records);
  }
  const headline = reviewHeadline(stats);

  if (!actions.length) {
    const card = state.reviewCard;
    if (card?.isConnected) {
      card.classList.add('resolved');
      const what = card.querySelector('.what');
      if (what) what.textContent = headline === 'Edits' ? 'Reviewed' : `${headline} · done`;
      card.querySelector('.opts').innerHTML = '<span class="outcome">done</span>';
      markScrubDirty();
    }
    return;
  }

  let card = state.reviewCard;
  if (!card || !card.isConnected) {
    card = div('file-review');
    card.innerHTML = `
      <div class="head">Review changes</div>
      <div class="what"></div>
      <div class="opts"></div>`;
    state.reviewCard = card;
    add(card);
  } else {
    // Keep it at the end of the stream when the turn just finished.
    els.transcript.appendChild(card);
  }

  card.classList.remove('resolved');
  card.querySelector('.what').textContent = headline;
  const opts = card.querySelector('.opts');
  opts.innerHTML = '';
  for (const action of actions) {
    const name = action.name || action;
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = name;
    b.className = reviewKind(name);
    b.addEventListener('click', () => {
      if (card.dataset.busy) return;
      card.dataset.busy = '1';
      for (const btn of opts.querySelectorAll('button')) btn.disabled = true;
      sendOp({ op: 'review.press', sessionId: state.sessionId, name });
    });
    opts.appendChild(b);
  }
  delete card.dataset.busy;
  markScrubDirty();
  scrollDown(nearBottom());
}

function reviewKind(name) {
  const n = String(name || '').toLowerCase();
  if (/^(undo|discard|reject|revert)\b/.test(n)) return 'deny';
  if (/^(redo|restore)\b/.test(n)) return 'allow';
  if (/^keep\b/.test(n)) return 'allow';
  return 'allow';
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

els.transcript.addEventListener('scroll', () => {
  syncToBottom();
  onTranscriptScroll();
}, { passive: true });
els.toBottom.onclick = () => {
  scrollDownSmooth();
  syncToBottom();
};
bindScrubber();

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
  const composer = els.composer;
  const vv = window.visualViewport;
  if (app && vv) {
    app.style.top = `${Math.round(vv.offsetTop)}px`;
    app.style.height = `${Math.round(vv.height)}px`;
    app.style.left = '0';
    app.style.right = '0';
    app.style.bottom = 'auto';
  }
  if (composer) composer.style.setProperty('padding-bottom', '8px', 'important');
  syncComposerHeight();
}

/**
 * The composer floats over the transcript. Measure it so the last bubble,
 * the jump button, and the scrub rail all clear the field — and so messages
 * can still scroll through the fade underneath.
 */
function syncComposerHeight() {
  const view = els.viewChat;
  const composer = els.composer;
  if (!view || !composer) return;
  const h = Math.ceil(composer.getBoundingClientRect().height);
  if (!h) return;
  const prev = view.style.getPropertyValue('--composer-height');
  const next = `${h}px`;
  if (prev === next) return;
  const stick = nearBottom();
  view.style.setProperty('--composer-height', next);
  if (stick) scrollDown(true);
}

{
  const vv = window.visualViewport;
  if (vv) {
    vv.addEventListener('resize', syncVisualViewport);
    vv.addEventListener('scroll', syncVisualViewport);
  }
  window.addEventListener('resize', syncVisualViewport);
  syncVisualViewport();
  if (els.composer && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(syncComposerHeight).observe(els.composer);
  }
  syncComposerHeight();
}

/**
 * Mark a scroller `.is-scrolling` while the finger/wheel is moving so the
 * thin overlay thumb (CSS) appears the way macOS shows bars on scroll.
 */
function bindOverlayScrollbars() {
  const timers = new WeakMap();
  document.addEventListener(
    'scroll',
    (e) => {
      const el = e.target;
      if (!(el instanceof Element)) return;
      el.classList.add('is-scrolling');
      const prev = timers.get(el);
      if (prev) clearTimeout(prev);
      timers.set(
        el,
        setTimeout(() => {
          el.classList.remove('is-scrolling');
          timers.delete(el);
        }, 800),
      );
    },
    { capture: true, passive: true },
  );
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
  // Focus now (user gesture) and again after attach lands the empty chat.
  state.focusComposer = true;
  focusComposer();
  sendOp({ op: 'session.create', folder: path });
}

/** Same-repo empty chat from the topbar — no project picker. */
$('new-chat').onclick = () => {
  const folder = currentFolder();
  if (!folder) return;
  createSession(folder);
};

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
    // A swipe that ends on a row must not attach or archive it. preventDefault
    // on touchmove often cancels that gesture's click entirely, so a bare
    // once-listener would sit until the *next* open and eat the first tap —
    // the hamburger then looked like it refused to switch chats. Bound the
    // guard to this gesture only.
    const eat = (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      clearTimeout(eatTimer);
    };
    rail.addEventListener('click', eat, { capture: true, once: true });
    const eatTimer = setTimeout(() => {
      rail.removeEventListener('click', eat, true);
    }, 400);
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
      // Match the archive × slop: a normal tap jitters a few pixels, and
      // treating that as a swipe both closes nothing and eats the row click.
      if (Math.abs(dx) < 16 && Math.abs(dy) < 16) return;
      // Vertical scroll of the list wins; swiping right has nowhere to go.
      if (dx > -10 || Math.abs(dy) >= Math.abs(dx)) {
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
  $('sheet-conn').textContent = `${els.conn.title || '…'} · ${location.host}`;
}

/** Rail brand + Settings Host both read from this. Tab title leads with the
 *  host so a glance at the browser chrome shows which machine this is. */
function applyHost(host) {
  state.host = {
    hostname: host.hostname || '',
    nick: host.nick || null,
    label: host.label || host.nick || host.hostname || '',
  };
  const el = $('host-label');
  if (el) el.textContent = state.host.label || '…';
  document.title = state.host.label ? `${state.host.label} · Auto` : 'Auto';
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

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // Innermost first: the dialogs sit over the sheet, which sits over a
  // tool view, which sits over the rail.
  if (!$('lightbox').hidden) closeLightbox();
  else if (!els.planSheet.hidden) setPlanSheet(false);
  else if (!els.usageSheet.hidden) setUsageSheet(false);
  else if (!$('newbie').hidden) setNewbie(false);
  else if (!els.sheet.hidden) setSheet(false);
  else if (workspaceIsOpen()) showChat();
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
$('plan-close').onclick = () => setPlanSheet(false);
els.planSheet.onclick = (e) => {
  if (e.target === els.planSheet) setPlanSheet(false);
};
els.planBuild.onclick = () => {
  if (!state.openPlanCard) return;
  sendPlanBuild(state.openPlanCard, els.planBuildModel);
};
els.planBuildModel.onchange = () => {
  const card = state.openPlanCard;
  const sel = card?.querySelector('.build-model');
  if (sel && [...sel.options].some((o) => o.value === els.planBuildModel.value)) {
    sel.value = els.planBuildModel.value;
  }
};

// Mobile browsers suspend sockets in the background; resync when we come back.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (state.sessionId) flushDiskSave(state.sessionId);
    return;
  }
  if (state.ws?.readyState !== 1) connect();
  if (state.sessionId) refreshUsage();
});
window.addEventListener('pagehide', () => {
  if (state.sessionId) flushDiskSave(state.sessionId);
});

paintMode();
syncSend();
paintNewChat();
initWorkspace();
onViewsChange((snap) => rememberViews(state.sessionId, snap));
initTerminals(sendOp);
initBrowser(sendOp);
bindOverlayScrollbars();
// Opening a pane from the rail should reveal it — close the drawer first.
for (const id of ['browser-toggle', 'term-toggle']) {
  const btn = $(id);
  if (!btn) continue;
  const prev = btn.onclick;
  btn.onclick = (e) => {
    if (els.app.classList.contains('rail-open')) setRail(false);
    return prev?.call(btn, e);
  };
}

/**
 * Paint any cached transcript before the socket opens, so a reload is not a
 * blank "Loading conversation…" wait for the same words that were just here.
 */
async function boot() {
  const id = rememberedSession();
  if (id) {
    try {
      const cached = await loadCache(id);
      if (cached?.records?.length || cached?.head?.length) {
        state.sessionId = id;
        paintFromCache(cached);
        setHistoryLoading(false);
      }
    } catch {
      /* cache is best-effort */
    }
  }
  connect();
}
boot();

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
      ${
        session.costCents != null
          ? `<span class="usage-hero-cost">Est. ${money(session.costCents / 100)} this chat</span>`
          : ''
      }
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