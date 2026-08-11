/**
 * Browser panel.
 *
 * Shows the host's Chrome as a stream of JPEG frames and sends taps, scrolls
 * and keystrokes back. Coordinates are scaled from the displayed image to the
 * real viewport, so a tap on a phone lands where you aimed it.
 */

const $ = (id) => document.getElementById(id);

const els = {
  panel: $('browser'),
  frame: $('browser-frame'),
  url: $('browser-url'),
  spinner: $('browser-spinner'),
  keys: $('browser-keys'),
};

let sendOp = () => {};
let status = { running: false, viewport: { width: 1280, height: 800 } };
let open = false;

export function initBrowser(send) {
  sendOp = send;

  $('browser-toggle').onclick = () => toggle();
  $('browser-hide').onclick = () => toggle(false);
  $('browser-back').onclick = () => sendOp({ op: 'browser.nav', action: 'back' });
  $('browser-forward').onclick = () => sendOp({ op: 'browser.nav', action: 'forward' });
  $('browser-reload').onclick = () => sendOp({ op: 'browser.nav', action: 'reload' });

  els.url.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    sendOp({ op: 'browser.navigate', url: els.url.value.trim() });
    els.url.blur();
  });

  els.frame.addEventListener('click', (e) => {
    const p = toPageCoords(e.clientX, e.clientY);
    if (p) sendOp({ op: 'browser.click', ...p });
  });

  els.frame.addEventListener(
    'wheel',
    (e) => {
      const p = toPageCoords(e.clientX, e.clientY);
      if (!p) return;
      e.preventDefault();
      sendOp({ op: 'browser.scroll', ...p, deltaX: e.deltaX, deltaY: e.deltaY });
    },
    { passive: false },
  );

  // Touch drag scrolls the page rather than the panel.
  let touch = null;
  els.frame.addEventListener(
    'touchstart',
    (e) => {
      const t = e.touches[0];
      touch = { x: t.clientX, y: t.clientY };
    },
    { passive: true },
  );
  els.frame.addEventListener(
    'touchmove',
    (e) => {
      if (!touch) return;
      const t = e.touches[0];
      const p = toPageCoords(t.clientX, t.clientY);
      if (p) {
        e.preventDefault();
        sendOp({
          op: 'browser.scroll',
          ...p,
          deltaX: touch.x - t.clientX,
          deltaY: touch.y - t.clientY,
        });
      }
      touch = { x: t.clientX, y: t.clientY };
    },
    { passive: false },
  );
  els.frame.addEventListener('touchend', () => {
    touch = null;
  });

  // A hidden input carries typing, so phone keyboards work on the page.
  els.keys.addEventListener('input', () => {
    const text = els.keys.value;
    if (text) sendOp({ op: 'browser.type', text });
    els.keys.value = '';
  });
  els.keys.addEventListener('keydown', (e) => {
    const named = ['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
    if (named.includes(e.key)) {
      e.preventDefault();
      sendOp({ op: 'browser.key', key: e.key });
    }
  });

  // The panel's size is only known after layout, and changes on rotate or
  // resize, so let the observer own the viewport rather than guessing once.
  const view = els.frame.parentElement;
  let debounce = null;
  new ResizeObserver(() => {
    if (!open) return;
    clearTimeout(debounce);
    debounce = setTimeout(requestViewport, 150);
  }).observe(view);
}

export function toggle(force) {
  open = force ?? els.panel.hidden;
  els.panel.hidden = !open;
  document.getElementById('app').classList.toggle('browser-open', open);
  if (open) {
    requestAnimationFrame(() => {
      const box = els.frame.parentElement.getBoundingClientRect();
      sendOp({
        op: 'browser.attach',
        width: Math.round(box.width) || 1280,
        height: Math.round(box.height) || 800,
      });
    });
  } else {
    sendOp({ op: 'browser.detach' });
  }
}

function requestViewport() {
  const box = els.frame.parentElement.getBoundingClientRect();
  if (box.width < 50) return;
  sendOp({ op: 'browser.viewport', width: Math.round(box.width), height: Math.round(box.height) });
}

/** Map a click on the displayed image to viewport pixels. */
function toPageCoords(clientX, clientY) {
  const img = els.frame;
  const box = img.getBoundingClientRect();
  if (!box.width || !box.height) return null;
  const vw = status.viewport?.width || box.width;
  const vh = status.viewport?.height || box.height;
  return {
    x: ((clientX - box.left) / box.width) * vw,
    y: ((clientY - box.top) / box.height) * vh,
  };
}

export function onFrame(data) {
  els.frame.src = `data:image/jpeg;base64,${data}`;
}

export function onStatus(next) {
  status = next;
  if (document.activeElement !== els.url) els.url.value = next.url || '';
  els.spinner.hidden = !next.loading;
  els.panel.classList.toggle('down', !next.running);
}

export function isOpen() {
  return open;
}
