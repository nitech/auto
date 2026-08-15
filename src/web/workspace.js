/**
 * Browser and terminals share one workspace.
 *
 * On a wide screen it docks to the right of the chat; on a phone it covers
 * the screen the way Settings does. Only one tool is shown at a time — you
 * switch with the tab bar, you do not stack three panes in one column.
 */

const $ = (id) => document.getElementById(id);

/** @type {'browser' | 'terminals' | null} */
let active = null;

const hooks = {
  browser: { onShow: null, onHide: null },
  terminals: { onShow: null, onHide: null },
};

export function initWorkspace() {
  $('workspace-hide').onclick = () => close();
  $('ws-tab-browser').onclick = () => show('browser');
  $('ws-tab-terminals').onclick = () => show('terminals');
}

/**
 * Register lifecycle hooks for a tool. `onShow` runs whenever that tool
 * becomes the visible one (including the first open); `onHide` when it
 * leaves the screen (closed or switched away).
 */
export function onTool(tool, { onShow, onHide } = {}) {
  if (!hooks[tool]) return;
  hooks[tool].onShow = onShow || null;
  hooks[tool].onHide = onHide || null;
}

export function show(tool) {
  if (tool !== 'browser' && tool !== 'terminals') return;

  const ws = $('workspace');
  const app = $('app');
  const prev = active;
  const opening = ws.hidden;

  ws.hidden = false;
  app.classList.add('workspace-open');
  app.dataset.workspace = tool;

  // A phone rail sitting over the chat would cover the workspace too.
  app.classList.remove('rail-open');
  const scrim = $('rail-scrim');
  if (scrim) scrim.hidden = true;

  $('browser').hidden = tool !== 'browser';
  $('terminals').hidden = tool !== 'terminals';

  paintTabs(tool);
  paintToggles(tool);

  if (prev && prev !== tool) hooks[prev].onHide?.();
  active = tool;
  if (prev !== tool || opening) hooks[tool].onShow?.({ opening, switched: prev && prev !== tool });
}

export function close() {
  const ws = $('workspace');
  if (ws.hidden && !active) return;
  const prev = active;
  active = null;
  ws.hidden = true;
  const app = $('app');
  app.classList.remove('workspace-open');
  delete app.dataset.workspace;
  $('browser').hidden = true;
  $('terminals').hidden = true;
  paintTabs(null);
  paintToggles(null);
  if (prev) hooks[prev].onHide?.();
}

/** Open the tool, or close the workspace if it is already showing that tool. */
export function toggle(tool) {
  if (active === tool && !$('workspace').hidden) close();
  else show(tool);
}

export function isOpen(tool) {
  if (tool) return active === tool && !$('workspace').hidden;
  return Boolean(active) && !$('workspace').hidden;
}

export function currentTool() {
  return active;
}

function paintTabs(tool) {
  for (const id of ['browser', 'terminals']) {
    const tab = $(`ws-tab-${id}`);
    if (!tab) continue;
    const on = tool === id;
    tab.classList.toggle('active', on);
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
  }
}

function paintToggles(tool) {
  for (const [id, name] of [
    ['browser-toggle', 'browser'],
    ['term-toggle', 'terminals'],
  ]) {
    const btn = $(id);
    if (!btn) continue;
    const on = tool === name;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}
