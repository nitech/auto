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
};

const state = {
  ws: null,
  sessionId: null,
  sessions: [],
  lastSeq: 0,
  busy: false,
  /** toolCallId -> element, so tool_update mutates the card it belongs to */
  toolCards: new Map(),
  /** requestId -> element */
  permCards: new Map(),
  stream: null,
  streamKind: null,
  lastPrompt: '',
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

function add(node, { keepStream = false } = {}) {
  if (!keepStream) {
    state.stream = null;
    state.streamKind = null;
  }
  const stick = nearBottom();
  els.transcript.appendChild(node);
  scrollDown(stick);
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
  add(div('msg user', esc(rec.text)));
}

function renderStreaming(rec) {
  const isThought = rec.kind === 'agent_thought';
  if (!state.stream || state.streamKind !== rec.kind) {
    state.streamKind = rec.kind;
    if (isThought) {
      const d = document.createElement('details');
      d.className = 'think';
      d.innerHTML = '<summary>Thinking</summary><div class="body"></div>';
      add(d, { keepStream: true });
      state.stream = d.querySelector('.body');
      state.stream.dataset.raw = '';
    } else {
      const d = div('msg agent');
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
  card.dataset.contentCount = String((rec.content || []).length);
  if (rec.toolCallId) state.toolCards.set(rec.toolCallId, card);
  add(card);
}

function renderToolUpdate(rec) {
  const card = rec.toolCallId ? state.toolCards.get(rec.toolCallId) : null;
  if (!card) return;

  const stateEl = card.querySelector('.state');
  const body = card.querySelector('.body');
  const out = rec.rawOutput;
  const failed =
    rec.status === 'failed' || (out && typeof out === 'object' && out.exitCode > 0);

  if (rec.status === 'completed' || rec.status === 'failed') {
    card.classList.add(failed ? 'failed' : 'done');
    stateEl.textContent = failed ? 'failed' : 'done';
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

  if (!out) return;

  let text = '';
  if (typeof out === 'object') {
    if (out.stdout) text += out.stdout;
    if (out.stderr) text += (text ? '\n' : '') + out.stderr;
    if (!text) text = JSON.stringify(out, null, 2);
    if (out.exitCode !== undefined && out.exitCode !== null) text += `\n[exit ${out.exitCode}]`;
  } else {
    text = String(out);
  }

  const stick = nearBottom();
  body.appendChild(div('cap', 'output'));
  const pre = document.createElement('pre');
  pre.innerHTML = `<code>${esc(text)}</code>`;
  body.appendChild(pre);
  // Failures are what you actually want to read, so open them by default.
  if (failed) card.open = true;
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
      break;
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

function renderRail() {
  els.rail.innerHTML = '';
  for (const s of state.sessions) {
    const row = div('session' + (s.id === state.sessionId ? ' active' : ''));
    const dot = div(`dot ${s.status || 'idle'}`);
    const meta = div('meta');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = s.title || 'session';
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = (s.folder || '').split(/[\\/]/).slice(-2).join('/');
    meta.append(name, sub);

    const close = document.createElement('button');
    close.className = 'close';
    close.textContent = '×';
    close.title = 'Archive session';
    close.onclick = (e) => {
      e.stopPropagation();
      sendOp({ op: 'session.archive', sessionId: s.id });
    };

    row.append(dot, meta, close);
    row.onclick = () => attach(s.id);
    els.rail.appendChild(row);
  }
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
    opt.textContent = m.name || m.modelId;
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

function setBusy(busy) {
  state.busy = busy;
  els.stop.hidden = !busy;
  els.send.disabled = busy;
}

// ------------------------------------------------------------------ socket

function sendOp(msg) {
  if (state.ws?.readyState === 1) state.ws.send(JSON.stringify(msg));
}

function attach(sessionId) {
  if (sessionId === state.sessionId) {
    els.app.classList.remove('rail-open');
    return;
  }
  state.sessionId = sessionId;
  state.lastSeq = 0;
  els.transcript.innerHTML = '';
  state.toolCards.clear();
  state.permCards.clear();
  state.stream = null;
  resetTerminals();
  els.app.classList.remove('rail-open');
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
        resetTerminals();
      }
      renderModels(msg.catalog?.models);
      applyMeta(msg.meta);
      renderRail();
      // Panes first, so replayed terminal chunks have somewhere to land.
      for (const t of msg.terminals || []) openPane(t);
      for (const rec of msg.records) render(rec);
      scrollDown(true);
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

function submit(text) {
  const body = (text ?? els.box.value).trim();
  if (!body || state.busy) return;
  state.lastPrompt = body;
  sendOp({ op: 'prompt', sessionId: state.sessionId, text: body });
  if (text === undefined) {
    els.box.value = '';
    autosize();
  }
  scrollDown(true);
}

function autosize() {
  els.box.style.height = 'auto';
  els.box.style.height = `${Math.min(els.box.scrollHeight, window.innerHeight * 0.4)}px`;
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

$('new-session').onclick = () => sendOp({ op: 'session.create' });
$('restart').onclick = () => {
  if (!confirm('Restart Auto? It waits for the current turn, then reconnects.')) return;
  sendOp({ op: 'host.restart', reason: 'web' });
};
$('rail-toggle').onclick = () => els.app.classList.toggle('rail-open');
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

initTerminals(sendOp);
initBrowser(sendOp);
connect();
