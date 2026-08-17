/**
 * Terminal panes.
 *
 * Each pane is an xterm attached to a PTY the host owns. Output arrives as
 * ordinary transcript records, so a terminal replays on reconnect exactly like
 * the rest of the session instead of starting blank.
 *
 * Each shell is a tab under the header (see workspace.js), beside Chat and
 * Browser — not a nested tab strip of its own.
 */

import {
  clearTerminalTabs,
  closeTerminal,
  isOpen,
  onTool,
  openTerminal,
  showChat,
} from './workspace.js';

const $ = (id) => document.getElementById(id);

const els = {
  dock: $('terminals'),
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

function requestNew() {
  sendOp({ op: 'terminal.open', cols: 120, rows: 24 });
}

export function initTerminals(send) {
  sendOp = send;

  $('term-toggle').onclick = () => toggleDock();

  onTool('terminals', {
    onShow: () => {
      requestAnimationFrame(() => panes.get(activeId)?.fit());
    },
    onSelect: (id) => activatePane(id),
    onNew: () => requestNew(),
    onClose: (id) => sendOp({ op: 'terminal.close', terminalId: id }),
  });

  window.addEventListener('resize', () => panes.get(activeId)?.fit());
}

export function toggleDock(force) {
  if (force === false) {
    showChat();
    return;
  }
  if (force === true || !panes.size) {
    if (panes.size) {
      const id = activeId || [...panes.keys()].at(-1);
      openTerminal(id, panes.get(id)?.title);
      activatePane(id);
    } else requestNew();
    return;
  }
  if (isOpen('terminals')) showChat();
  else {
    const id = activeId || [...panes.keys()].at(-1);
    openTerminal(id, panes.get(id)?.title);
    activatePane(id);
  }
}

export function resetTerminals() {
  for (const p of panes.values()) p.term.dispose();
  panes.clear();
  early.clear();
  activeId = null;
  els.panes.innerHTML = '';
  clearTerminalTabs();
}

export function openPane(desc, { activate = true } = {}) {
  if (!desc || panes.has(desc.terminalId)) return;
  const id = desc.terminalId;
  const title = desc.title || 'shell';

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

  panes.set(id, { term, host, fit, title });

  for (const chunk of early.get(id) || []) term.write(chunk);
  early.delete(id);

  openTerminal(id, title, { activate });
  if (activate) activatePane(id);
  requestAnimationFrame(fit);
}

export function closePane(terminalId) {
  const pane = panes.get(terminalId);
  if (!pane) return;
  pane.term.dispose();
  pane.host.remove();
  panes.delete(terminalId);
  if (activeId === terminalId) activeId = null;
  closeTerminal(terminalId);
  const next = panes.keys().next();
  if (!next.done && activeId == null) activatePane(next.value);
}

function activatePane(id) {
  if (!panes.has(id)) return;
  activeId = id;
  for (const [key, pane] of panes) {
    pane.host.classList.toggle('active', key === id);
  }
  const pane = panes.get(id);
  if (pane) {
    requestAnimationFrame(() => {
      pane.fit();
      pane.term.focus();
    });
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
