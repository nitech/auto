/**
 * Telegram control surface.
 *
 * The same host, the same sessions, a different window. Telegram cannot stream,
 * so a turn is one message that gets edited as the agent works: tool lines
 * appear and tick off, prose fills in underneath. Approvals arrive as inline
 * buttons, which is the whole point — you can unblock a run from a phone.
 *
 * Credentials come from TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID, or the
 * auth.json the notify skill already writes.
 */
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const LIMIT = 4096;
/** Telegram tolerates roughly one edit a second; stay well clear. */
const EDIT_MS = 1800;

export function loadTelegramAuth() {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (token && chatId) return { token, chatId: Number(chatId) || chatId };

  const candidates = [
    join(homedir(), '.cursor', 'skills', 'telegram-notify', 'auth.json'),
    join(homedir(), '.claude', 'skills', 'telegram-notify', 'auth.json'),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const data = JSON.parse(readFileSync(p, 'utf8'));
      if (data.token && data.chatId != null) return { token: data.token, chatId: data.chatId };
    } catch {
      /* unreadable, try the next */
    }
  }
  return null;
}

export async function tgApi(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(70_000),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method}: ${data.description || 'failed'}`);
  return data.result;
}

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Keep the tail: the end of a long answer is the part you want. */
function clamp(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : `…${s.slice(s.length - max + 1)}`;
}

const ICON = { pending: '◦', in_progress: '▸', completed: '✓', failed: '✗' };

/**
 * Render one turn into a single Telegram message: what the agent is doing on
 * top, what it is saying underneath. The tool list is reserved space, so a long
 * answer cannot push the status out of view.
 */
export function renderTurn({ text = '', tools = [] } = {}) {
  const head = tools.map((t) => `${ICON[t.status] || '▸'} <i>${esc(t.label)}</i>`).join('\n');
  const body = esc(String(text).trim());
  const room = LIMIT - head.length - 8;
  return [head, clamp(body, Math.max(500, room))].filter(Boolean).join('\n\n') || '…';
}

export class TelegramBridge extends EventEmitter {
  constructor({ sessions, stateDir, auth = loadTelegramAuth(), webUrl = '' }) {
    super();
    this.sessions = sessions;
    this.auth = auth;
    this.webUrl = webUrl;
    this.offsetPath = join(stateDir, 'telegram-offset.json');
    this.running = false;
    /** sessionId -> live turn render state */
    this.turns = new Map();
    /** short id -> callback payload, because callback_data is 64 bytes */
    this.callbacks = new Map();
    this.callbackSeq = 0;
    this.permMessages = new Map();
  }

  get enabled() {
    return Boolean(this.auth?.token && this.auth?.chatId);
  }

  // ------------------------------------------------------------------ plumbing

  #loadOffset() {
    try {
      return Number(JSON.parse(readFileSync(this.offsetPath, 'utf8')).offset) || 0;
    } catch {
      return 0;
    }
  }

  #saveOffset(offset) {
    mkdirSync(dirname(this.offsetPath), { recursive: true });
    writeFileSync(this.offsetPath, JSON.stringify({ offset }));
  }

  /** Register a button payload and return its callback_data (limited to 64 bytes). */
  tokenFor(payload) {
    const id = `c${++this.callbackSeq}`;
    this.callbacks.set(id, payload);
    // Old buttons stop working eventually; that is better than growing forever.
    if (this.callbacks.size > 400) {
      const oldest = this.callbacks.keys().next().value;
      this.callbacks.delete(oldest);
    }
    return id;
  }

  send(text, extra = {}) {
    return tgApi(this.auth.token, 'sendMessage', {
      chat_id: this.auth.chatId,
      text: clamp(text, LIMIT),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    }).catch((err) => {
      this.emit('log', `send failed: ${err.message}`);
      return null;
    });
  }

  edit(messageId, text, extra = {}) {
    return tgApi(this.auth.token, 'editMessageText', {
      chat_id: this.auth.chatId,
      message_id: messageId,
      text: clamp(text, LIMIT),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    }).catch((err) => {
      // "message is not modified" is normal when nothing changed.
      if (!/not modified/i.test(err.message)) this.emit('log', `edit failed: ${err.message}`);
      return null;
    });
  }

  // ------------------------------------------------------------------ lifecycle

  start() {
    if (!this.enabled || this.running) return this;
    this.running = true;
    this.#wire();
    this.#poll();
    this.emit('log', `polling as chat ${this.auth.chatId}`);
    return this;
  }

  stop() {
    this.running = false;
  }

  async #poll() {
    let offset = this.#loadOffset();
    while (this.running) {
      try {
        const updates = await tgApi(this.auth.token, 'getUpdates', {
          offset,
          timeout: 50,
          allowed_updates: ['message', 'edited_message', 'callback_query'],
        });
        for (const update of updates) {
          offset = update.update_id + 1;
          this.#saveOffset(offset);
          try {
            await this.handleUpdate(update);
          } catch (err) {
            this.emit('log', `update failed: ${err.message}`);
            await this.send(`⚠️ ${esc(err.message)}`);
          }
        }
      } catch (err) {
        if (!this.running) return;
        this.emit('log', `poll error: ${err.message}`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  // -------------------------------------------------------------------- input

  /**
   * Handle one update. Must return promptly: the poll loop is single-file, and
   * anything slow here delays every later update — including the button press
   * that releases a turn stuck on a permission request.
   */
  async handleUpdate(update) {
    if (update.callback_query) return this.#onCallback(update.callback_query);

    const msg = update.message || update.edited_message;
    if (!msg) return undefined;
    if (String(msg.chat?.id) !== String(this.auth.chatId)) return undefined;

    const text = (msg.text || msg.caption || '').trim();
    const images = [];

    if (Array.isArray(msg.photo) && msg.photo.length) {
      const best = msg.photo[msg.photo.length - 1];
      const data = await this.#downloadBase64(best.file_id);
      if (data) images.push({ mimeType: 'image/jpeg', data });
    }

    if (text.startsWith('/')) return this.#command(text);
    if (!text && !images.length) return undefined;

    const id = this.sessions.activeId;
    if (!id) return this.send('No active session. /new to start one.');

    // Deliberately not awaited: a turn does not resolve until the agent is
    // done, and it can stop mid-way to ask for permission. Blocking here would
    // stop us reading the very button press that unblocks it.
    this.sessions.prompt(id, { text, images }).catch((err) => {
      const busy = /already working/i.test(err.message);
      this.send(busy ? 'Still working — /stop to interrupt.' : `⚠️ ${esc(err.message)}`);
    });
    return undefined;
  }

  async #downloadBase64(fileId) {
    try {
      const file = await tgApi(this.auth.token, 'getFile', { file_id: fileId });
      const res = await fetch(
        `https://api.telegram.org/file/bot${this.auth.token}/${file.file_path}`,
      );
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer()).toString('base64');
    } catch (err) {
      this.emit('log', `image download failed: ${err.message}`);
      return null;
    }
  }

  async #command(raw) {
    const [cmd, ...rest] = raw.split(/\s+/);
    const arg = rest.join(' ').trim();
    const name = cmd.replace(/@.*$/, '').toLowerCase();
    const active = this.sessions.get(this.sessions.activeId);

    switch (name) {
      case '/start':
      case '/help':
        return this.send(
          [
            '<b>Auto</b> — remote control for the agent.',
            '',
            'Send any message to prompt the active session.',
            '',
            '/sessions — list and switch',
            '/new [folder] — start a session',
            '/stop — interrupt the current turn',
            '/mode agent|plan|ask',
            '/model — pick a model',
            '/policy ask|ask-on-write|auto',
            '/status — what is running',
            this.webUrl ? `/web — ${esc(this.webUrl)}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        );

      case '/sessions': {
        const list = this.sessions.list();
        if (!list.length) return this.send('No sessions. /new to start one.');
        return this.send(
          `<b>Sessions</b>\n${list
            .map((s) => `${s.active ? '●' : '○'} ${esc(s.title)} — <code>${esc(s.folder)}</code>`)
            .join('\n')}`,
          {
            reply_markup: {
              inline_keyboard: list.map((s) => [
                {
                  text: `${s.active ? '● ' : ''}${s.title}`,
                  callback_data: this.tokenFor({ kind: 'switch', sessionId: s.id }),
                },
              ]),
            },
          },
        );
      }

      case '/new': {
        const meta = this.sessions.create(arg ? { folder: arg } : {});
        this.sessions.setActive(meta.id);
        return this.send(`Started <b>${esc(meta.title)}</b>\n<code>${esc(meta.folder)}</code>`);
      }

      case '/stop':
        if (!active) return this.send('No active session.');
        await this.sessions.cancel(active.id);
        return this.send('Interrupted.');

      case '/mode':
        if (!active) return this.send('No active session.');
        if (!['agent', 'plan', 'ask'].includes(arg)) {
          return this.send(`Mode is <b>${esc(active.mode)}</b>. Use /mode agent|plan|ask.`);
        }
        await this.sessions.setMode(active.id, arg);
        return this.send(`Mode → <b>${esc(arg)}</b>`);

      case '/model': {
        if (!active) return this.send('No active session.');
        const models = this.sessions.catalog?.models || [];
        if (!models.length) {
          // Starting the agent takes a moment; do not hold up the poll loop.
          this.sessions.ensureLive(active.id).catch(() => {});
          return this.send('Fetching the model list — send /model again in a moment.');
        }

        if (arg) {
          const wanted = arg.toLowerCase();
          const hit =
            models.find((m) => m.name?.toLowerCase() === wanted) ||
            models.find((m) => m.name?.toLowerCase().includes(wanted));
          if (!hit) return this.send(`No model matching <b>${esc(arg)}</b>. Try /model.`);
          await this.sessions.setModel(active.id, hit.modelId);
          return this.send(`Model → <b>${esc(hit.name)}</b>`);
        }

        // Two per row: 33 models is a long list on a phone.
        const rows = [];
        for (let i = 0; i < models.length; i += 2) {
          rows.push(
            models.slice(i, i + 2).map((m) => ({
              text: `${m.modelId === active.model ? '● ' : ''}${m.name || m.modelId}`,
              callback_data: this.tokenFor({ kind: 'model', modelId: m.modelId, label: m.name }),
            })),
          );
        }
        return this.send(
          `Model is <b>${esc(active.modelName || active.model || 'unset')}</b>`,
          { reply_markup: { inline_keyboard: rows } },
        );
      }

      case '/policy':
        if (!active) return this.send('No active session.');
        if (!['ask', 'ask-on-write', 'auto'].includes(arg)) {
          return this.send(
            `Approvals are <b>${esc(active.policy)}</b>. Use /policy ask|ask-on-write|auto.`,
          );
        }
        this.sessions.setPolicy(active.id, arg);
        return this.send(`Approvals → <b>${esc(arg)}</b>`);

      case '/status': {
        if (!active) return this.send('No active session.');
        const pending = this.sessions.permissions.list(active.id).length;
        return this.send(
          [
            `<b>${esc(active.title)}</b> — ${esc(active.status)}`,
            `<code>${esc(active.folder)}</code>`,
            `mode ${esc(active.mode)} · approvals ${esc(active.policy)}` +
              (active.modelName ? ` · ${esc(active.modelName)}` : ''),
            pending ? `${pending} waiting for approval` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        );
      }

      case '/web':
        return this.send(this.webUrl ? esc(this.webUrl) : 'No web URL configured.');

      default:
        return this.send(`Unknown command ${esc(name)}. /help for the list.`);
    }
  }

  /** Toast shown on the tapped button. Overridable so tests stay offline. */
  answerCallback(queryId, text) {
    return tgApi(this.auth.token, 'answerCallbackQuery', {
      callback_query_id: queryId,
      text,
    }).catch(() => {});
  }

  async #onCallback(query) {
    const payload = this.callbacks.get(query.data);
    const answer = (text) => this.answerCallback(query.id, text);

    if (!payload) {
      await answer('That button has expired.');
      return;
    }

    if (payload.kind === 'switch') {
      this.sessions.setActive(payload.sessionId);
      const meta = this.sessions.get(payload.sessionId);
      await answer(`Switched to ${meta?.title || 'session'}`);
      await this.send(`Now on <b>${esc(meta?.title)}</b>\n<code>${esc(meta?.folder)}</code>`);
      return;
    }

    if (payload.kind === 'model') {
      const id = this.sessions.activeId;
      try {
        await this.sessions.setModel(id, payload.modelId);
        await answer(`Model: ${payload.label}`);
        await this.send(`Model → <b>${esc(payload.label)}</b>`);
      } catch (err) {
        await answer(err.message.slice(0, 190));
      }
      return;
    }

    if (payload.kind === 'permission') {
      const done = this.sessions.permissions.resolve(payload.requestId, payload.optionId, {
        by: 'telegram',
      });
      await answer(done ? payload.label : 'Already answered.');
    }
  }

  // ------------------------------------------------------------------- output

  #wire() {
    this.sessions.on('record', ({ sessionId, record }) => {
      // Only mirror the session Telegram is looking at; the web can watch the rest.
      if (sessionId !== this.sessions.activeId) return;
      this.#onRecord(sessionId, record).catch((err) =>
        this.emit('log', `render failed: ${err.message}`),
      );
    });
  }

  #turn(sessionId) {
    if (!this.turns.has(sessionId)) {
      this.turns.set(sessionId, {
        messageId: null,
        text: '',
        tools: new Map(),
        timer: null,
        sending: false,
        rendered: '',
      });
    }
    return this.turns.get(sessionId);
  }

  #compose(turn) {
    return renderTurn({ text: turn.text, tools: [...turn.tools.values()] });
  }

  #schedule(sessionId) {
    const turn = this.#turn(sessionId);
    if (turn.timer || turn.sending) return;
    turn.timer = setTimeout(() => {
      turn.timer = null;
      this.#flush(sessionId).catch(() => {});
    }, EDIT_MS);
  }

  async #flush(sessionId) {
    const turn = this.#turn(sessionId);
    const text = this.#compose(turn);
    if (text === turn.rendered) return;
    turn.sending = true;
    turn.rendered = text;
    try {
      if (turn.messageId) await this.edit(turn.messageId, text);
      else {
        const sent = await this.send(text);
        turn.messageId = sent?.message_id || null;
      }
    } finally {
      turn.sending = false;
    }
  }

  async #onRecord(sessionId, rec) {
    const turn = this.#turn(sessionId);

    switch (rec.kind) {
      case 'turn_start':
        turn.messageId = null;
        turn.text = '';
        turn.rendered = '';
        turn.tools.clear();
        break;

      case 'agent_delta':
        turn.text += rec.text || '';
        this.#schedule(sessionId);
        break;

      case 'tool_call':
        turn.tools.set(rec.toolCallId || `t${turn.tools.size}`, {
          label: rec.title || rec.toolKind || 'tool',
          status: rec.status || 'in_progress',
        });
        this.#schedule(sessionId);
        break;

      case 'tool_update': {
        const tool = turn.tools.get(rec.toolCallId);
        if (tool && rec.status) {
          tool.status = rec.status;
          this.#schedule(sessionId);
        }
        break;
      }

      case 'permission_request':
        await this.#askPermission(rec);
        break;

      case 'permission_resolved':
        await this.#closePermission(rec);
        break;

      case 'turn_end':
        if (turn.timer) {
          clearTimeout(turn.timer);
          turn.timer = null;
        }
        // Let an in-flight edit land before the final one overwrites it.
        while (turn.sending) await new Promise((r) => setTimeout(r, 100));
        await this.#flush(sessionId);
        break;

      case 'error':
        await this.send(`⚠️ ${esc(rec.text || 'error')}`);
        break;

      default:
        break;
    }
  }

  async #askPermission(rec) {
    const title = rec.toolCall?.title || rec.toolCall?.kind || 'this action';
    const buttons = (rec.options || []).map((opt) => [
      {
        text: opt.name || opt.optionId,
        callback_data: this.tokenFor({
          kind: 'permission',
          requestId: rec.requestId,
          optionId: opt.optionId,
          label: opt.name || opt.optionId,
        }),
      },
    ]);

    const sent = await this.send(`🔐 <b>Permission needed</b>\n${esc(title)}`, {
      reply_markup: { inline_keyboard: buttons },
    });
    if (sent?.message_id) this.permMessages.set(rec.requestId, sent.message_id);
  }

  async #closePermission(rec) {
    const messageId = this.permMessages.get(rec.requestId);
    if (!messageId) return;
    this.permMessages.delete(rec.requestId);
    const how = rec.cancelled
      ? 'cancelled'
      : `${rec.optionId || 'answered'}${rec.automatic ? ' (policy)' : ''}`;
    await this.edit(messageId, `🔐 <b>Permission</b> — ${esc(how)}`, { reply_markup: undefined });
  }
}
