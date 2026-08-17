/**
 * Chat / Browser / Terminal tabs under the header.
 *
 * Chat is always first and cannot be closed. Opening the browser or a shell
 * adds a tab; × closes that tool and returns to Chat when it was the active
 * one. The strip scrolls sideways when tabs outgrow the bar, and hides
 * entirely while only Chat is open.
 */

const $ = (id) => document.getElementById(id);

/** @type {'chat' | 'browser' | string} string = terminal id */
let active = 'chat';
let browserOpen = false;
/** @type {Map<string, { title: string }>} */
const terminals = new Map();

const hooks = {
  browser: { onShow: null, onHide: null },
  terminals: {
    onShow: null,
    onHide: null,
    onSelect: null,
    onNew: null,
    onClose: null,
  },
};

export function initWorkspace() {
  paint();
  showPanels();
}

/**
 * Register lifecycle hooks for a tool.
 * Terminals may also supply `onSelect(id)`, `onNew()`, and `onClose(id)`.
 */
export function onTool(tool, next = {}) {
  if (!hooks[tool]) return;
  Object.assign(hooks[tool], next);
}

export function showChat() {
  select('chat');
}

export function openBrowser() {
  browserOpen = true;
  select('browser');
  notify();
}

export function closeBrowser() {
  if (!browserOpen) return;
  browserOpen = false;
  if (active === 'browser') select('chat');
  else {
    paint();
    paintToggles();
  }
  notify();
}

/** Icon: open or focus the browser; if already viewing it, go back to Chat. */
export function toggleBrowser() {
  if (active === 'browser') showChat();
  else openBrowser();
}

/**
 * @param {string} id
 * @param {string} [title]
 * @param {{ activate?: boolean }} [opts]  activate defaults true; false while
 *   restoring several panes so the remembered tab can win afterwards.
 */
export function openTerminal(id, title, { activate = true } = {}) {
  if (!id) return;
  const first = terminals.size === 0;
  terminals.set(id, { title: title || 'shell' });
  if (activate) select(id);
  else {
    paint();
    paintToggles();
  }
  if (first) hooks.terminals.onShow?.({ opening: true });
  notify();
}

export function closeTerminal(id) {
  if (!terminals.has(id)) return;
  terminals.delete(id);
  const wasActive = active === id;
  if (terminals.size === 0) hooks.terminals.onHide?.();
  if (wasActive) {
    const next = terminals.keys().next();
    if (!next.done) select(next.value);
    else select('chat');
  } else {
    paint();
    paintToggles();
  }
  notify();
}

export function selectTerminal(id) {
  if (!terminals.has(id)) return;
  select(id);
}

export function renameTerminal(id, title) {
  const t = terminals.get(id);
  if (!t) return;
  t.title = title || t.title;
  paint();
}

export function resetTools() {
  const hadBrowser = browserOpen;
  const hadTerms = terminals.size > 0;
  browserOpen = false;
  terminals.clear();
  if (hadBrowser && active === 'browser') hooks.browser.onHide?.();
  if (hadTerms) hooks.terminals.onHide?.();
  active = 'chat';
  paint();
  paintToggles();
  showPanels();
  notify();
}

/** Drop every terminal tab; leave the browser tab alone. */
export function clearTerminalTabs() {
  if (!terminals.size) return;
  const wasTerm = terminals.has(active);
  terminals.clear();
  hooks.terminals.onHide?.();
  if (wasTerm) select('chat');
  else paint();
  paintToggles();
  notify();
}

/** What this tab had open — enough to put the strip back after a reload. */
export function snapshot() {
  return {
    browser: browserOpen,
    active:
      active === 'chat' || active === 'browser' || terminals.has(active) ? active : 'chat',
  };
}

/**
 * Re-open the browser tab and select Chat / Browser / a live shell after
 * attach has already registered the host's terminals.
 * @param {{ browser?: boolean, active?: string } | null | undefined} snap
 */
export function restoreViews(snap) {
  browserOpen = Boolean(snap?.browser);
  let want = snap?.active || 'chat';
  if (want === 'browser' && !browserOpen) want = 'chat';
  if (want !== 'chat' && want !== 'browser' && !terminals.has(want)) want = 'chat';
  // Avoid a no-op select short-circuit before panels/paint catch up.
  if (active === want) {
    showPanels();
    paint();
    paintToggles();
    if (want === 'browser') hooks.browser.onShow?.({ opening: true });
    if (want !== 'chat' && want !== 'browser') hooks.terminals.onSelect?.(want);
  } else {
    select(want);
  }
  notify();
}

/** Persist hook — app.js writes this per session to localStorage. */
let changeHook = null;
export function onViewsChange(fn) {
  changeHook = fn || null;
}

function notify() {
  changeHook?.(snapshot());
}

/** True when a tool view (not Chat) is showing. */
export function isOpen(tool) {
  if (tool === 'browser') return active === 'browser';
  if (tool === 'terminals') return terminals.has(active);
  if (tool) return active === tool;
  return active !== 'chat';
}

export function currentTool() {
  if (active === 'chat') return null;
  if (active === 'browser') return 'browser';
  return 'terminals';
}

export function hasOpenTools() {
  return browserOpen || terminals.size > 0;
}

/** Leave the tool view (tabs stay open). */
export function close() {
  showChat();
}

/** @deprecated Prefer toggleBrowser / openTerminal. */
export function show(tool) {
  if (tool === 'browser') openBrowser();
  else if (tool === 'terminals') {
    if (terminals.size) select([...terminals.keys()].at(-1));
    else hooks.terminals.onNew?.();
  }
}

/** @deprecated */
export function toggle(tool) {
  if (tool === 'browser') toggleBrowser();
  else if (tool === 'terminals') {
    if (terminals.has(active)) showChat();
    else if (terminals.size) select([...terminals.keys()].at(-1));
    else hooks.terminals.onNew?.();
  }
}

function select(view) {
  const prev = active;
  if (prev === view) {
    paint();
    paintToggles();
    notify();
    return;
  }

  if (prev === 'browser') hooks.browser.onHide?.();

  active = view;
  showPanels();
  paint();
  paintToggles();

  if (view === 'browser') hooks.browser.onShow?.({ opening: true });
  if (view !== 'chat' && view !== 'browser' && terminals.has(view)) {
    hooks.terminals.onSelect?.(view);
  }
  notify();
}

function showPanels() {
  const chat = active === 'chat';
  const browser = active === 'browser';
  const term = !chat && !browser;

  $('view-chat').hidden = !chat;
  $('browser').hidden = !browser;
  $('terminals').hidden = !term;

  const app = $('app');
  if (chat) {
    app.classList.remove('tool-view');
    delete app.dataset.view;
  } else {
    app.classList.add('tool-view');
    app.dataset.view = browser ? 'browser' : 'terminals';
  }
}

function paint() {
  const bar = $('view-tabs');
  if (!bar) return;

  const showBar = browserOpen || terminals.size > 0;
  bar.hidden = !showBar;
  if (!showBar) {
    bar.innerHTML = '';
    return;
  }

  const bits = [];
  bits.push(tabHtml('chat', 'Chat', { closable: false, on: active === 'chat' }));
  if (browserOpen) {
    bits.push(tabHtml('browser', 'Browser', { closable: true, on: active === 'browser' }));
  }
  for (const [id, meta] of terminals) {
    bits.push(
      tabHtml(`term:${id}`, meta.title || 'shell', {
        closable: true,
        on: active === id,
        terminalId: id,
      }),
    );
  }
  bar.innerHTML = bits.join('');

  bar.querySelectorAll('.view-tab').forEach((el) => {
    el.addEventListener('click', (e) => {
      const closeBtn = e.target.closest('.view-tab-x');
      const key = el.dataset.tab;
      if (closeBtn) {
        e.preventDefault();
        e.stopPropagation();
        if (key === 'browser') closeBrowser();
        else if (el.dataset.terminalId) hooks.terminals.onClose?.(el.dataset.terminalId);
        return;
      }
      if (key === 'chat') showChat();
      else if (key === 'browser') openBrowser();
      else if (el.dataset.terminalId) select(el.dataset.terminalId);
    });
  });

  bar.querySelector('.view-tab.active')?.scrollIntoView({
    inline: 'nearest',
    block: 'nearest',
  });
}

function tabHtml(key, label, { closable, on, terminalId } = {}) {
  const tid = terminalId ? ` data-terminal-id="${escapeAttr(terminalId)}"` : '';
  const x = closable
    ? `<span class="view-tab-x" title="Close" aria-label="Close">×</span>`
    : '';
  return `<button type="button" class="view-tab${on ? ' active' : ''}" role="tab"
    data-tab="${escapeAttr(key)}"${tid}
    aria-selected="${on ? 'true' : 'false'}">
    <span class="view-tab-label">${escapeHtml(label)}</span>${x}
  </button>`;
}

function paintToggles() {
  const browserBtn = $('browser-toggle');
  if (browserBtn) {
    const on = active === 'browser';
    browserBtn.classList.toggle('active', on);
    browserBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  const termBtn = $('term-toggle');
  if (termBtn) {
    const on = terminals.has(active);
    termBtn.classList.toggle('active', on);
    termBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}
