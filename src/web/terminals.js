/**
 * Terminal panes.
 *
 * Each pane is an xterm attached to a PTY the host owns. Output arrives as
 * ordinary transcript records, so a terminal replays on reconnect exactly like
 * the rest of the session instead of starting blank.
 */

const $ = (id) => document.getElementById(id);

const els = {
  dock: $('terminals'),
  tabs: $('term-tabs'),
  panes: $('term-panes'),
};

const panes = new Map();
/** Chunks that arrive before their pane exists (replay ordering). */
const early = new Map();
let activeId = null;
let sendOp = () => {};

/**
 * The terminal is a canvas, so it cannot inherit the page's colours — it has
 * to be told them. Reading the same tokens the stylesheet uses keeps it in
 * step with the theme instead of pinning it to one palette.
 */
function xtermTheme() {
  const css = getComputedStyle(document.documentElement);
  const pick = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  return {
    background: pick('--bg', '#0b0d12'),
    foreground: pick('--text', '#d7dce5'),
    cursor: pick('--accent', '#7aa2f7'),
    selectionBackground: pick('--bg-3', '#171b24'),
  };
}

/** Repaint every open pane after a theme change. */
export function retheme() {
  const theme = xtermTheme();
  for (const p of panes.values()) p.term.options.theme = theme;
}

export function initTerminals(send) {
  sendOp = send;

  $('term-toggle').onclick = () => toggleDock();
  $('term-hide').onclick = () => toggleDock(false);
  $('term-new').onclick = () => sendOp({ op: 'terminal.open', cols: 120, rows: 24 });

  window.addEventListener('resize', () => panes.get(activeId)?.fit());
}

export function toggleDock(force) {
  const show = force ?? els.dock.hidden;
  els.dock.hidden = !show;
  document.getElementById('app').classList.toggle('terms-open', show);
  if (show) {
    if (!panes.size) sendOp({ op: 'terminal.open', cols: 120, rows: 24 });
    requestAnimationFrame(() => panes.get(activeId)?.fit());
  }
}

export function resetTerminals() {
  for (const p of panes.values()) p.term.dispose();
  panes.clear();
  early.clear();
  activeId = null;
  els.tabs.innerHTML = '';
  els.panes.innerHTML = '';
  els.dock.hidden = true;
  document.getElementById('app').classList.remove('terms-open');
}

export function openPane(desc) {
  if (!desc || panes.has(desc.terminalId)) return;
  const id = desc.terminalId;

  const tab = document.createElement('button');
  tab.className = 'term-tab';
  tab.innerHTML = '<span class="t"></span><span class="x">×</span>';
  tab.querySelector('.t').textContent = desc.title || 'shell';
  tab.onclick = (e) => {
    if (e.target.classList.contains('x')) sendOp({ op: 'terminal.close', terminalId: id });
    else activate(id);
  };
  els.tabs.appendChild(tab);

  const host = document.createElement('div');
  host.className = 'term-pane';
  els.panes.appendChild(host);

  const term = new window.Terminal({
    fontFamily: 'ui-monospace, Consolas, "Cascadia Mono", monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
    theme: xtermTheme(),
  });
  const fitAddon = new window.FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(host);

  const fit = () => {
    try {
      fitAddon.fit();
      sendOp({ op: 'terminal.resize', terminalId: id, cols: term.cols, rows: term.rows });
    } catch {
      /* pane not visible yet */
    }
  };

  term.onData((data) => sendOp({ op: 'terminal.input', terminalId: id, data }));

  panes.set(id, { term, host, tab, fit });

  for (const chunk of early.get(id) || []) term.write(chunk);
  early.delete(id);

  activate(id);
  els.dock.hidden = false;
  document.getElementById('app').classList.add('terms-open');
  requestAnimationFrame(fit);
}

export function closePane(terminalId) {
  const pane = panes.get(terminalId);
  if (!pane) return;
  pane.term.dispose();
  pane.host.remove();
  pane.tab.remove();
  panes.delete(terminalId);
  if (activeId === terminalId) {
    activeId = null;
    const next = panes.keys().next();
    if (!next.done) activate(next.value);
    else toggleDock(false);
  }
}

function activate(id) {
  activeId = id;
  for (const [key, pane] of panes) {
    const on = key === id;
    pane.host.classList.toggle('active', on);
    pane.tab.classList.toggle('active', on);
  }
  const pane = panes.get(id);
  if (pane) {
    pane.fit();
    pane.term.focus();
  }
}

/** Feed a transcript `terminal_chunk` record into its pane. */
export function writeChunk(rec) {
  const id = rec.terminalId;
  if (!id) return;
  const text = rec.text ?? (rec.exitStatus ? `\r\n[exit ${rec.exitStatus.exitCode}]\r\n` : '');
  if (!text) return;
  const pane = panes.get(id);
  if (pane) pane.term.write(text);
  else {
    if (!early.has(id)) early.set(id, []);
    early.get(id).push(text);
  }
}
