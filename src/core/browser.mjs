/**
 * Browser host.
 *
 * Runs a real Chrome on this machine and exposes it as something you can drive
 * from a phone: frames stream out as JPEG via CDP screencast, taps and
 * keystrokes come back as input events. It is deliberately built on raw CDP
 * over the `ws` we already depend on rather than a driver library.
 *
 * The profile is persistent (`state/browser-profile`), so sites you log into
 * stay logged in — which is the point of running the browser on your own
 * machine instead of in a container.
 */
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';

const CHROME_CANDIDATES = [
  `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

export function findChrome() {
  if (process.env.AUTO_BROWSER_PATH && existsSync(process.env.AUTO_BROWSER_PATH)) {
    return process.env.AUTO_BROWSER_PATH;
  }
  return CHROME_CANDIDATES.find((p) => p && existsSync(p)) || null;
}

/** Address-bar behaviour: a URL is opened, anything else is searched. */
export function normalizeUrl(input) {
  const text = String(input ?? '').trim();
  if (!text) return 'about:blank';
  if (/^[a-z][\w+.-]*:\/\//i.test(text) || /^about:/i.test(text)) return text;
  if (/^localhost(:\d+)?([/?#].*)?$/i.test(text)) return `http://${text}`;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/.test(text)) return `https://${text}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(text)}`;
}

/** Minimal CDP connection: request/response plus flattened session routing. */
class Cdp extends EventEmitter {
  constructor(url) {
    super();
    this.ws = new WebSocket(url, { maxPayload: 256 * 1024 * 1024 });
    this.nextId = 1;
    this.pending = new Map();

    this.ready = new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });

    this.ws.on('message', (buf) => {
      let msg;
      try {
        msg = JSON.parse(buf.toString());
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      if (msg.method) this.emit('event', msg);
    });

    this.ws.on('close', () => this.emit('close'));
    this.ws.on('error', (err) => this.emit('error', err));
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP ${method} timed out`));
      }, 30000);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class BrowserHost extends EventEmitter {
  constructor({ stateDir, port = 9333, headless = process.env.AUTO_BROWSER_HEADLESS === '1' }) {
    super();
    this.profileDir = join(stateDir, 'browser-profile');
    this.port = port;
    this.headless = headless;
    this.proc = null;
    this.cdp = null;
    this.sessionId = null;
    this.targetId = null;
    this.streaming = false;
    this.viewport = { width: 1280, height: 800 };
    this.url = 'about:blank';
    this.title = '';
    this.loading = false;
  }

  get running() {
    return Boolean(this.cdp && this.sessionId);
  }

  get status() {
    return {
      running: this.running,
      url: this.url,
      title: this.title,
      loading: this.loading,
      streaming: this.streaming,
      viewport: this.viewport,
      headless: this.headless,
    };
  }

  async #launch() {
    const exe = findChrome();
    if (!exe) throw new Error('No Chrome or Edge found. Set AUTO_BROWSER_PATH.');
    mkdirSync(this.profileDir, { recursive: true });

    const args = [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,MediaRouter',
      `--window-size=${this.viewport.width},${this.viewport.height}`,
      'about:blank',
    ];
    if (this.headless) {
      args.unshift('--headless=new');
    } else {
      // A real window avoids the bot checks headless trips, but you should
      // never see it: park it off-screen. Minimising would stop compositing
      // and with it the screencast.
      args.unshift('--window-position=-32000,-32000');
    }

    this.proc = spawn(exe, args, { stdio: 'ignore', detached: false });
    this.proc.on('exit', () => {
      this.proc = null;
      this.#teardown('browser exited');
    });

    // Wait for the debugging endpoint to answer.
    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/json/version`, {
          signal: AbortSignal.timeout(1000),
        });
        if (res.ok) return (await res.json()).webSocketDebuggerUrl;
      } catch {
        /* not up yet */
      }
      await sleep(250);
    }
    throw new Error('Chrome did not expose its debugging port');
  }

  /** Launch if needed and attach to a page target. Safe to call repeatedly. */
  async ensure() {
    if (this.running) return this.status;
    if (this.starting) return this.starting;

    this.starting = (async () => {
      const browserWs = await this.#launch();
      this.cdp = new Cdp(browserWs);
      await this.cdp.ready;
      this.cdp.on('event', (msg) => this.#onEvent(msg));
      this.cdp.on('close', () => this.#teardown('devtools disconnected'));

      const { targetId } = await this.cdp.send('Target.createTarget', { url: 'about:blank' });
      this.targetId = targetId;
      const { sessionId } = await this.cdp.send('Target.attachToTarget', {
        targetId,
        flatten: true,
      });
      this.sessionId = sessionId;

      await this.#call('Page.enable');
      await this.#call('Runtime.enable');
      await this.#call('Emulation.setDeviceMetricsOverride', {
        width: this.viewport.width,
        height: this.viewport.height,
        deviceScaleFactor: 1,
        mobile: false,
      });

      this.emit('status', this.status);
      return this.status;
    })();

    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  #call(method, params) {
    if (!this.cdp || !this.sessionId) throw new Error('Browser is not running');
    return this.cdp.send(method, params, this.sessionId);
  }

  async #onEvent(msg) {
    switch (msg.method) {
      case 'Page.screencastFrame': {
        const { data, sessionId: ack } = msg.params;
        this.emit('frame', { data, metadata: msg.params.metadata });
        try {
          await this.#call('Page.screencastFrameAck', { sessionId: ack });
        } catch {
          /* stream stopped */
        }
        break;
      }
      case 'Page.frameNavigated':
        if (!msg.params.frame?.parentId) {
          this.url = msg.params.frame.url;
          this.emit('status', this.status);
          this.emit('navigated', { url: this.url });
        }
        break;
      case 'Page.loadEventFired':
        this.loading = false;
        this.#refreshTitle();
        break;
      case 'Page.frameStartedLoading':
        this.loading = true;
        this.emit('status', this.status);
        break;
      default:
        break;
    }
  }

  async #refreshTitle() {
    try {
      const res = await this.#call('Runtime.evaluate', {
        expression: 'document.title',
        returnByValue: true,
      });
      this.title = res?.result?.value || '';
    } catch {
      /* page went away */
    }
    this.emit('status', this.status);
  }

  #teardown(reason) {
    const wasRunning = this.running;
    this.cdp?.close();
    this.cdp = null;
    this.sessionId = null;
    this.targetId = null;
    this.streaming = false;
    if (wasRunning) this.emit('status', this.status);
    if (reason) this.emit('log', reason);
  }

  async navigate(url) {
    await this.ensure();
    const target = normalizeUrl(url);
    this.loading = true;
    this.emit('status', this.status);
    await this.#call('Page.navigate', { url: target });
    return this.status;
  }

  async back() {
    const hist = await this.#call('Page.getNavigationHistory');
    const idx = hist.currentIndex - 1;
    if (idx >= 0) {
      await this.#call('Page.navigateToHistoryEntry', { entryId: hist.entries[idx].id });
    }
  }

  async forward() {
    const hist = await this.#call('Page.getNavigationHistory');
    const idx = hist.currentIndex + 1;
    if (idx < hist.entries.length) {
      await this.#call('Page.navigateToHistoryEntry', { entryId: hist.entries[idx].id });
    }
  }

  async reload() {
    await this.#call('Page.reload');
  }

  async startScreencast({ maxWidth = 1280, quality = 60 } = {}) {
    await this.ensure();
    await this.#call('Page.startScreencast', {
      format: 'jpeg',
      quality,
      maxWidth,
      maxHeight: Math.round((maxWidth * 3) / 2),
      everyNthFrame: 1,
    });
    this.streaming = true;
    this.emit('status', this.status);
    // A still page emits no frames, so prime the view with one immediately.
    this.screenshot().catch(() => {});
  }

  async stopScreencast() {
    if (!this.running || !this.streaming) return;
    try {
      await this.#call('Page.stopScreencast');
    } catch {
      /* already stopped */
    }
    this.streaming = false;
    this.emit('status', this.status);
  }

  async screenshot() {
    await this.ensure();
    const { data } = await this.#call('Page.captureScreenshot', { format: 'jpeg', quality: 70 });
    this.emit('frame', { data, metadata: null });
    return data;
  }

  async setViewport(width, height) {
    this.viewport = {
      width: Math.max(320, Math.round(width)),
      height: Math.max(200, Math.round(height)),
    };
    if (!this.running) return;
    await this.#call('Emulation.setDeviceMetricsOverride', {
      width: this.viewport.width,
      height: this.viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    this.emit('status', this.status);
  }

  async click(x, y, { button = 'left', clickCount = 1 } = {}) {
    const base = { x: Math.round(x), y: Math.round(y), button, clickCount };
    await this.#call('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', button: 'none' });
    await this.#call('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
    await this.#call('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
  }

  async move(x, y) {
    await this.#call('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(x),
      y: Math.round(y),
      button: 'none',
    });
  }

  async scroll(x, y, deltaX, deltaY) {
    await this.#call('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: Math.round(x),
      y: Math.round(y),
      deltaX: Math.round(deltaX),
      deltaY: Math.round(deltaY),
    });
  }

  /** Type literal text, one character at a time so pages see real input. */
  async type(text) {
    for (const ch of String(text)) {
      await this.#call('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch });
      await this.#call('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    }
  }

  async key(key) {
    const named = {
      Enter: { windowsVirtualKeyCode: 13, text: '\r', code: 'Enter' },
      Backspace: { windowsVirtualKeyCode: 8, code: 'Backspace' },
      Tab: { windowsVirtualKeyCode: 9, code: 'Tab' },
      Escape: { windowsVirtualKeyCode: 27, code: 'Escape' },
      ArrowUp: { windowsVirtualKeyCode: 38, code: 'ArrowUp' },
      ArrowDown: { windowsVirtualKeyCode: 40, code: 'ArrowDown' },
      ArrowLeft: { windowsVirtualKeyCode: 37, code: 'ArrowLeft' },
      ArrowRight: { windowsVirtualKeyCode: 39, code: 'ArrowRight' },
    }[key];
    if (!named) return this.type(key);
    await this.#call('Input.dispatchKeyEvent', { type: 'keyDown', key, ...named });
    await this.#call('Input.dispatchKeyEvent', { type: 'keyUp', key, ...named });
    return undefined;
  }

  async close() {
    await this.stopScreencast();
    this.#teardown(null);
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        /* already gone */
      }
      this.proc = null;
    }
  }
}
