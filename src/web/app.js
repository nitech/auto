/**
 * Auto v2 web client.
 *
 * A projection of the host's transcript: it attaches to a session, replays
 * from a sequence number, and renders records as they stream. It holds no
 * authoritative state, so a reload or a dropped connection costs nothing.
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
import { initBrowser, onFrame, onStatus } from './browser.js';

const $ = (id) => document.getElementById(id);

const els = {
  app: $('app'),
  rail: $('session-list'),
  transcript: $('transcript'),
  box: $('box'),
  send: $('send'),
  stop: $('stop'),
  title: $('session-title'),
  folder: $('session-folder'),
  status: $('status'),
  mode: $('mode'),
  model: $('model'),
  policy: $('policy'),
  conn: $('conn'),
  connLabel: $('conn-label'),
  sheet: $('sheet'),
  toBottom: $('to-bottom'),
  attachments: $('attachments'),
  file: $('file'),
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
  /** requestId -> element */
  permCards: new Map(),
  stream: null,
  streamKind: null,
  /** the thinking block being written to, so it can be folded when it ends */
  thinking: null,
  lastPrompt: '',
  /** images waiting to go with the next prompt: {mimeType, data, url} */
  attachments: [],
};

// ------------------------------------------------------------------ helpers

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Small, deliberately conservative markdown. Input is escaped before markup. */
function markdown(src) {
  const blocks = [];
  let text = esc(src).replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(`<pre><code data-lang="${lang}">${code.replace(/\n$/, '')}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });

  text = text
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  const lines = text.split('\n');
  const out = [];
  let list = null;

  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };

  for (const line of lines) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+\.\s+(.*)$/.exec(line);

    if (h) {
      closeList();
      const lvl = Math.min(h[1].length + 2, 6);
      out.push(`<h${lvl}>${h[2]}</h${lvl}>`);
    } else if (ul) {
      if (list !== 'ul') {
        closeList();
        out.push('<ul>');
        list = 'ul';
      }
      out.push(`<li>${ul[1]}</li>`);
    } else if (ol) {
      if (list !== 'ol') {
        closeList();
        out.push('<ol>');
        list = 'ol';
      }
      out.push(`<li>${ol[1]}</li>`);
    } else if (!line.trim()) {
      closeList();
    } else {
      closeList();
      out.push(`<p>${line}</p>`);
    }
  }
  closeList();

  return out.join('').replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
}

function nearBottom() {
  const t = els.transcript;
  return t.scrollHeight - t.scrollTop - t.clientHeight < 160;
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
 * which lands here too.
 */
function closeThinking() {
  if (!state.thinking) return;
  state.thinking.open = false;
  state.thinking = null;
}

function add(node, { keepStream = false } = {}) {
  if (!keepStream) {
    closeThinking();
    state.stream = null;
    state.streamKind = null;
  }
  const stick = nearBottom();
  els.transcript.appendChild(node);
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
  const node = div('msg user', esc(rec.text));
  if (rec.images) {
    const cap = div('cap');
    cap.textContent = `${rec.images} image${rec.images === 1 ? '' : 's'} attached`;
    node.append(cap);
  }
  add(node);
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
      add(d, { keepStream: true });
      state.thinking = d;
      state.stream = d.querySelector('.body');
      state.stream.dataset.raw = '';
    } else {
      const d = div('msg agent');
      closeThinking();
      add(d, { keepStream: true });
      state.stream = d;
      state.stream.dataset.raw = '';
    }
  }
  const stick = nearBottom();
  state.stream.dataset.raw += rec.text || '';
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
      // Full size in a new tab: phone screens crop a desktop screenshot hard.
      img.onclick = () => window.open(img.src, '_blank');
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
  const input = rec.rawInput || {};
  return (
    input.command ||
    input.path ||
    input.file_path ||
    input.query ||
    rec.title ||
    rec.toolKind ||
    'tool'
  );
}

function renderToolCall(rec) {
  const card = document.createElement('details');
  card.className = 'tool';
  card.innerHTML = `
    <summary>
      <span class="kind">${esc(rec.toolKind || 'tool')}</span>
      <span class="label"></span>
      <span class="state">running…</span>
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
  } else if (rec.toolKind === 'execute') {
    // A command that is still going is the one thing worth watching, so its
    // output is shown as it arrives instead of behind a tap.
    card.classList.add('running');
  }
  showOutput(card, rec.rawOutput, failed);
}

function renderToolUpdate(rec) {
  const card = rec.toolCallId ? state.toolCards.get(rec.toolCallId) : null;
  if (!card) return;

  const stateEl = card.querySelector('.state');
  const body = card.querySelector('.body');
  const out = rec.rawOutput;
  const failed =
    rec.status === 'failed' || (out && typeof out === 'object' && out.exitCode > 0);

  // A name that only turns up once the call is under way, as an MCP call's does.
  if (rec.title) card.querySelector('.label').textContent = rec.title;

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

/**
 * Put what a tool printed under its card.
 *
 * Replaced rather than added to: a command reports as it goes, each time with
 * everything it has printed so far, so appending gave the same output three and
 * four times over on a phone.
 */
function showOutput(card, out, failed) {
  const text = outputText(out);
  if (!text) return;
  const body = card.querySelector('.body');

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

function renderPlan(rec) {
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

  switch (rec.kind) {
    case 'user_message':
      if (!rec.echoed) renderUser(rec);
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
      add(div('turn-divider'));
      // Streamed replies rewrite their own markup as they arrive, so their
      // code blocks only get a copy button once the turn stops moving.
      decorate(els.transcript);
      break;
    case 'notice': {
      const el = div('notice');
      el.textContent = rec.text || '';
      add(el);
      break;
    }
    case 'session_start':
    case 'session_info':
    case 'commands':
    case 'turn_start':
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
    close.className = 'close';
    close.textContent = '×';
    close.title = 'Archive session';
    close.onclick = (e) => {
      e.stopPropagation();
      sendOp({ op: 'session.archive', sessionId: item.id });
    };
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
    if (open.has(c.id)) continue;
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
 * The model list comes from the agent, not from us — 33 entries whose ids
 * carry their options. Keep the id as the value and show the friendly name.
 */
function renderModels(models) {
  if (!models?.length || els.model.dataset.filled === String(models.length)) return;
  els.model.innerHTML = '';
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.modelId;
    // The agent's automatic pick is called "Auto", which reads as this app.
    opt.textContent = m.modelId === 'default[]' ? 'Auto-select (Cursor picks)' : m.name || m.modelId;
    els.model.append(opt);
  }
  els.model.dataset.filled = String(models.length);
}

function applyMeta(meta) {
  if (!meta) return;
  els.title.textContent = meta.title || 'session';
  els.folder.textContent = meta.folder || '';
  els.mode.value = meta.mode || 'agent';
  els.policy.value = meta.policy || 'ask';
  // A session that has never run has no model yet; leave the picker as-is.
  if (meta.model && els.model.options.length) els.model.value = meta.model;
  setBusy(meta.status === 'busy');
  els.status.textContent = meta.status || 'idle';
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
  state.busy = busy;
  els.stop.hidden = !busy;
  els.send.title = busy ? 'Add to the queue' : 'Send';
  els.send.setAttribute('aria-label', els.send.title);
  els.send.classList.toggle('queueing', busy);
  els.box.placeholder = busy ? 'Add to the queue…' : 'Message the agent…';
  syncSend();
}

/** Send is only live when there is something to send. */
function syncSend() {
  els.send.disabled = !(els.box.value.trim() || state.attachments.length);
}

// ------------------------------------------------------------------ socket

function sendOp(msg) {
  if (state.ws?.readyState === 1) state.ws.send(JSON.stringify(msg));
}

function attach(sessionId) {
  if (sessionId === state.sessionId) {
    setRail(false);
    return;
  }
  state.sessionId = sessionId;
  state.lastSeq = 0;
  els.transcript.innerHTML = '';
  state.toolCards.clear();
  state.permCards.clear();
  state.stream = null;
  state.thinking = null;
  resetTerminals();
  setRail(false);
  sendOp({ op: 'attach', sessionId, fromSeq: 0 });
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}`);
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
      renderRail();
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
      const fresh = msg.sessionId !== state.sessionId || msg.records[0]?.seq === 1;
      state.sessionId = msg.sessionId;
      if (fresh) {
        els.transcript.innerHTML = '';
        state.toolCards.clear();
        state.permCards.clear();
        state.stream = null;
        state.thinking = null;
        resetTerminals();
      }
      renderModels(msg.catalog?.models);
      if (msg.projects) state.projects = msg.projects;
      if (msg.chats) state.chats = msg.chats;
      applyMeta(msg.meta);
      renderRail();
      // Panes first, so replayed terminal chunks have somewhere to land.
      for (const t of msg.terminals || []) openPane(t);
      for (const rec of msg.records) render(rec);
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
      return;
    }

    if (msg.type === 'desktopChats') {
      renderDesktopChats(msg.folder, msg.chats || []);
      return;
    }

    if (msg.type === 'projects') {
      state.projects = msg.projects || [];
      renderRail();
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
      const mine = state.sessions.find((s) => s.id === state.sessionId);
      if (mine?.model) els.model.value = mine.model;
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

    if (msg.type === 'error') {
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
    const drop = document.createElement('button');
    drop.type = 'button';
    drop.textContent = '×';
    drop.title = 'Remove';
    drop.setAttribute('aria-label', 'Remove image');
    drop.onclick = () => {
      state.attachments.splice(i, 1);
      renderAttachments();
    };
    box.append(img, drop);
    els.attachments.append(box);
  });
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
  const images = state.attachments.map(({ mimeType, data }) => ({ mimeType, data }));
  // A turn already running is no reason to refuse: the host queues it.
  if (!body && !images.length) return;
  state.lastPrompt = body;
  sendOp({ op: 'prompt', sessionId: state.sessionId, text: body, images });
  state.attachments = [];
  renderAttachments();
  if (text === undefined) {
    els.box.value = '';
    autosize();
  }
  scrollDown(true);
}

function autosize() {
  els.box.style.height = 'auto';
  els.box.style.height = `${Math.min(els.box.scrollHeight, window.innerHeight * 0.4)}px`;
  syncSend();
}

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

$('new-session').onclick = () => sendOp({ op: 'session.create' });
$('restart').onclick = () => {
  if (!confirm('Restart Auto? It waits for the current turn, then reconnects.')) return;
  sendOp({ op: 'host.restart', reason: 'web' });
};
/**
 * Open or close the session rail. On a narrow screen it slides over the page,
 * covering the button that opened it — so closing has to be possible from the
 * rail itself, from the page beside it, and from the keyboard.
 */
function setRail(open) {
  els.app.classList.toggle('rail-open', open);
  $('rail-scrim').hidden = !open;
  // Cursor may have moved on since you last looked.
  if (open) sendOp({ op: 'desktop.recent' });
}

$('rail-toggle').onclick = () => setRail(!els.app.classList.contains('rail-open'));
$('rail-close').onclick = () => setRail(false);
$('rail-scrim').onclick = () => setRail(false);

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
 * Everything that is not the conversation. The mode, model and policy pickers
 * are moved in and out of it rather than duplicated, so a narrow screen loses
 * no control the wide one has — which is how the approval policy used to go
 * missing on a phone, the one place it matters most.
 */
const compact = window.matchMedia('(max-width: 900px)');

function placeControls() {
  const inSheet = compact.matches;
  const host = inSheet ? $('sheet-controls') : $('topbar-controls');
  host.append(els.mode, els.model, els.policy);
  // Whichever holder is left empty should not keep its gap.
  $('sheet-controls').hidden = !inSheet;
}

function setSheet(open) {
  els.sheet.hidden = !open;
  if (!open) return;
  $('rename').value = state.sessionId ? els.title.textContent : '';
  $('sheet-folder').textContent = els.folder.textContent;
  $('sheet-conn').textContent = `${els.connLabel.textContent} · ${location.host}`;
}

compact.addEventListener('change', placeControls);
placeControls();
applyTheme();

$('sheet-open').onclick = () => setSheet(true);
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

$('sheet-sync').onclick = () => sendOp({ op: 'sessions.sync' });
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
  // Innermost first: the sheet sits over the rail.
  if (!els.sheet.hidden) setSheet(false);
  else if (els.app.classList.contains('rail-open')) setRail(false);
});

els.mode.onchange = () =>
  sendOp({ op: 'session.mode', sessionId: state.sessionId, modeId: els.mode.value });
els.model.onchange = () =>
  sendOp({ op: 'session.model', sessionId: state.sessionId, modelId: els.model.value });
els.policy.onchange = () =>
  sendOp({ op: 'session.policy', sessionId: state.sessionId, policy: els.policy.value });

// Mobile browsers suspend sockets in the background; resync when we come back.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.ws?.readyState !== 1) connect();
});

syncSend();
initTerminals(sendOp);
initBrowser(sendOp);
connect();
