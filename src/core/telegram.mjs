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
import { listProjects, workspaceIdFor } from './projects.mjs';
import { desktopChats } from './desktop-chats.mjs';
import { optionLetter, parseQuestionReply } from './questions.mjs';
import { classifyTool, displayLabel, foldTools, isCreatedPlan, planFields, turnCopy } from './desktop-tool-ui.mjs';
import { linkify } from '../web/markdown.js';

const LIMIT = 4096;
/** Telegram tolerates roughly one edit a second; stay well clear. */
const EDIT_MS = 1800;
/** Cursor's current modes, in the order the IDE lists them. */
const SESSION_MODES = ['agent', 'plan', 'debug', 'multitask', 'ask'];

/** Same shape the session uses for echo matching — trim and collapse space. */
const echoKey = (text) => String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();

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

const sameFolder = (a, b) =>
  String(a || '').replace(/[\\/]+$/, '').toLowerCase() ===
  String(b || '').replace(/[\\/]+$/, '').toLowerCase();

/** Keep the tail: the end of a long answer is the part you want. */
function clamp(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : `…${s.slice(s.length - max + 1)}`;
}

const ICON = {
  pending: '◦',
  in_progress: '▸',
  completed: '✓',
  failed: '✗',
  cancelled: '■',
};

/** How long a command may be before it is cut down for a phone screen. */
const TOOL_LABEL_MAX = 70;

/**
 * What a tool call did, said in one line.
 *
 * The command itself, where there is one: "run_terminal_command_v2" tells you
 * nothing, and the command line tells you everything. Newlines are folded so a
 * heredoc cannot take over the message.
 */
export function toolLabel(rec) {
  const name = String(displayLabel(rec)).replace(/\s+/g, ' ').trim();
  return name.length > TOOL_LABEL_MAX ? `${name.slice(0, TOOL_LABEL_MAX - 1)}…` : name;
}

/**
 * How a failed command ended — and only that.
 *
 * Telegram says what is running, never what it printed. Output belongs on a
 * screen with room to scroll: quoting a build log into a chat buries the reply
 * it came with, and the same message gets rewritten several times a second while
 * a command streams. The web transcript has all of it. So a failure is worth one
 * word here, the code it exited with, which is usually the whole story anyway.
 */
export function failureNote(rec) {
  const out = rec?.rawOutput;
  const code = out && typeof out === 'object' ? out.exitCode : null;
  const failed = rec?.status === 'failed' || code > 0;
  if (!failed) return null;
  return code === null || code === undefined ? 'failed' : `exit ${code}`;
}

/**
 * Render one turn into a single Telegram message: what the agent is doing on
 * top, what it is saying underneath. The tool list is reserved space, so a long
 * answer cannot push the status out of view.
 */
export function renderTurn({ text = '', tools = [], conclusion = '' } = {}) {
  const head = foldTools(tools)
    .map((t) => {
      const said = t.parts?.length
        ? t.parts.map((p) => (p.n != null ? `<b>${p.n}</b>` : esc(p.t))).join('')
        : esc(t.label);
      const line = `${ICON[t.status] || '▸'} <i>${said}</i>`;
      // One word, on the same line: a phone has better uses for its rows.
      return t.failure ? `${line} — ${esc(t.failure)}` : line;
    })
    .join('\n');
  const done = conclusion ? `<i>${esc(conclusion)}</i>` : '';
  const room = LIMIT - head.length - done.length - 8;
  const body = linkify(clamp(esc(String(text).trim()), Math.max(500, room)), '');
  return [head, body, done].filter(Boolean).join('\n\n') || '…';
}

/**
 * A question card as words on a phone.
 *
 * Options are lettered so a typed answer can name one in a word. A single
 * question is "A"; several questions keep their own numbers: "1A" is
 * unambiguous where "the second one" is not.
 */
export function questionText(rec) {
  const lines = [`❓ <b>${esc(rec.title || 'Question')}</b>`];
  const questions = rec.questions || [];
  for (const [i, q] of questions.entries()) {
    const number = questions.length > 1 ? `${i + 1}. ` : '';
    lines.push('', `${number}${esc(q.prompt || '')}`);
    for (const [j, opt] of (q.options || []).entries()) {
      lines.push(`  <b>${optionLetter(i, j, questions.length)}</b> ${esc(opt.label || opt.id || '')}`);
    }
    if (q.multiple) lines.push('  <i>several answers allowed</i>');
  }
  const oneTap = questions.length === 1 && !questions[0]?.multiple;
  lines.push(
    '',
    oneTap
      ? '<i>Tap an option, or reply with a letter (A, B, …).</i>'
      : '<i>Tap options, then Submit — or reply with letters (1A 2B).</i>',
  );
  return lines.join('\n');
}

/** A Created Plan card as words on a phone. */
export function planText(rec) {
  const fields = planFields(rec);
  const lines = ['📋 <b>Created Plan</b>', `<b>${esc(fields.name)}</b>`];
  if (fields.overview) lines.push('', esc(fields.overview));
  return lines.join('\n');
}

export class TelegramBridge extends EventEmitter {
  constructor({ sessions, stateDir, auth = loadTelegramAuth(), webUrl = '', restart = null }) {
    super();
    this.sessions = sessions;
    this.auth = auth;
    this.webUrl = webUrl;
    /** Supplied by the host, since restarting is its business, not ours. */
    this.restart = restart;
    this.offsetPath = join(stateDir, 'telegram-offset.json');
    this.running = false;
    /** sessionId -> live turn render state */
    this.turns = new Map();
    /** short id -> callback payload, because callback_data is 64 bytes */
    this.callbacks = new Map();
    this.callbackSeq = 0;
    this.permMessages = new Map();
    /** askId -> Telegram message id, so the buttons can be taken off once answered */
    this.askMessages = new Map();
    /** askId -> { sessionId, questions, chosen } while a multi-pick is in progress */
    this.asks = new Map();
    /** toolCallId -> latest plan fields, so View Plan sends what we have now */
    this.plans = new Map();
    /** Recent prompts typed in this Telegram chat — skip mirroring their user_message. */
    this.ownPrompts = [];
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
      // "message is not modified" is normal when nothing changed — treat as ok
      // so callers can mark the text rendered and move on.
      if (/not modified/i.test(err.message)) return { ok: true, notModified: true };
      this.emit('log', `edit failed: ${err.message}`);
      return null;
    });
  }

  /**
   * Words we just posted into the active session from this chat.
   *
   * Telegram already shows what you typed here. The same prompt lands in the
   * transcript as a user_message (and again when Cursor echoes the bubble), so
   * without this list the bot would paste your own message back at you.
   */
  #noteOwnPrompt(text) {
    const key = echoKey(text);
    if (!key) return;
    const now = Date.now();
    this.ownPrompts = [...(this.ownPrompts || []), { key, at: now }].filter(
      (e) => now - e.at < 120_000,
    );
  }

  /** Consume one matching own-prompt, if any — later identical words from the web still show. */
  #consumeOwnPrompt(text) {
    const key = echoKey(text);
    if (!key || !this.ownPrompts?.length) return false;
    const now = Date.now();
    this.ownPrompts = this.ownPrompts.filter((e) => now - e.at < 120_000);
    const i = this.ownPrompts.findIndex((e) => e.key === key);
    if (i < 0) return false;
    this.ownPrompts.splice(i, 1);
    return true;
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

    // A lettered reply to a waiting question is an answer, not a prompt.
    const pending = this.sessions.pendingQuestion?.(id);
    const parsed = pending && !images.length ? parseQuestionReply(text, pending.questions) : null;
    if (parsed) {
      this.sessions.answerQuestion(id, { askId: pending.askId, ...parsed }).catch((err) => {
        this.send(`⚠️ ${esc(err.message)}`);
      });
      return undefined;
    }

    // Deliberately not awaited: a turn does not resolve until the agent is
    // done, and it can stop mid-way to ask for permission. Blocking here would
    // stop us reading the very button press that unblocks it. A queued send
    // resolves at once, and that is the only word a phone gets that the
    // message did not vanish — it must not also land in the transcript.
    // Remember the words so the transcript's user_message is not mirrored back.
    this.#noteOwnPrompt(text);
    Promise.resolve()
      .then(() => this.sessions.prompt(id, { text, images }))
      .then((res) => {
        if (res?.status !== 'queued') return;
        const n = res.waiting;
        this.send(
          n > 1
            ? `Queued — ${n} messages waiting for this turn to finish.`
            : 'Queued — goes in when this turn finishes.',
        );
      })
      .catch((err) => {
        // Prompt never reached the transcript — drop the echo skip so a later
        // identical send from the web is not swallowed.
        this.#consumeOwnPrompt(text);
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
            '/mode agent|plan|debug|multitask|ask',
            '/projects — projects on this machine',
            '/chats — continue a chat from the desktop app',
            '/model — pick a model',
            '/policy ask|ask-on-write|auto',
            '/status — what is running',
            '/restart — apply code changes',
            this.webUrl ? `/web — ${esc(this.webUrl)}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        );

      case '/projects': {
        const list = this.sessions.list();
        const projects = listProjects(list.map((s) => s.folder))
          .filter((p) => p.open || list.some((s) => sameFolder(s.folder, p.path)))
          .slice(0, 12);

        if (!projects.length) return this.send('No projects open in Cursor.');

        const lines = projects.map((p) => {
          const mine = list.filter((s) => sameFolder(s.folder, p.path));
          const note = [
            mine.length ? `${mine.length} session${mine.length > 1 ? 's' : ''}` : 'no sessions',
            p.open ? 'open in Cursor' : '',
          ]
            .filter(Boolean)
            .join(' · ');
          return `<b>${esc(p.name)}</b> — ${esc(note)}\n<code>${esc(p.path)}</code>`;
        });

        return this.send(`<b>Projects</b>\n${lines.join('\n')}`, {
          reply_markup: {
            inline_keyboard: projects.map((p) => [
              {
                text: p.name,
                callback_data: this.tokenFor({ kind: 'project', folder: p.path }),
              },
            ]),
          },
        });
      }

      case '/chats': {
        const folder = arg || active?.folder;
        if (!folder) return this.send('No active session, so no folder to look in.');
        const chats = desktopChats(workspaceIdFor(folder), { limit: 8 });
        if (!chats.length) {
          return this.send(`No desktop chats for <code>${esc(folder)}</code>.`);
        }
        return this.send(
          `<b>Desktop chats</b> — <code>${esc(folder)}</code>\n` +
            'Pick one to carry on here — the same chat Cursor has.\n' +
            chats
              .map(
                (c) =>
                  `• ${esc(c.title)}${c.updatedAt ? ` — ${new Date(c.updatedAt).toLocaleDateString()}` : ''}`,
              )
              .join('\n'),
          {
            reply_markup: {
              inline_keyboard: chats.map((c) => [
                {
                  text: c.title.slice(0, 40),
                  callback_data: this.tokenFor({ kind: 'continue', chatId: c.id, folder }),
                },
              ]),
            },
          },
        );
      }

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
        const meta = await this.sessions.startInIde(arg ? { folder: arg } : {});
        this.sessions.setActive(meta.id);
        const where =
          meta.kind === 'desktop'
            ? ' in the Cursor desktop app — same conversation on both ends.'
            : '.';
        return this.send(`Started <b>${esc(meta.title)}</b>${where}\n<code>${esc(meta.folder)}</code>`);
      }

      case '/stop': {
        if (!active) return this.send('No active session.');
        // A desktop chat can refuse — no window open, no debugging port — and
        // saying "Interrupted" when nothing was would be a lie.
        const stopped = await this.sessions.cancel(active.id);
        return this.send(stopped ? 'Interrupted.' : 'Nothing was interrupted — see the chat.');
      }

      case '/mode': {
        if (!active) return this.send('No active session.');
        // A Cursor chat has Cursor's own modes, which are more than three and
        // not ours to name. Ask the window what it offers.
        if (active.kind === 'desktop') return this.#pickInCursor(active, 'mode', arg);
        const wanted = arg.toLowerCase();
        if (!SESSION_MODES.includes(wanted)) {
          return this.send(
            `Mode is <b>${esc(active.mode)}</b>. Use /mode ${SESSION_MODES.join('|')}.`,
          );
        }
        await this.sessions.setMode(active.id, wanted);
        return this.send(`Mode → <b>${esc(wanted)}</b>`);
      }

      case '/model': {
        if (!active) return this.send('No active session.');
        if (active.kind === 'desktop') return this.#pickInCursor(active, 'model', arg);
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

      case '/restart':
        if (!this.restart) return this.send('Restarting is not available here.');
        await this.send('Restarting Auto…');
        this.restart({ reason: 'telegram' });
        return undefined;

      case '/web':
        return this.send(this.webUrl ? esc(this.webUrl) : 'No web URL configured.');

      default:
        return this.send(`Unknown command ${esc(name)}. /help for the list.`);
    }
  }

  /**
   * Pick a Cursor chat's model or mode from a phone.
   *
   * The list comes from the window rather than from us, because it is Cursor's
   * account that decides it — so with no name given the menu is read and offered
   * as buttons, and with one it is set outright. Both open a menu in the desktop
   * for a moment; that is the price of there being nowhere else to ask.
   */
  async #pickInCursor(active, picker, arg) {
    if (arg) {
      const done =
        picker === 'mode'
          ? await this.sessions.setMode(active.id, arg)
          : await this.sessions.setModel(active.id, arg);
      // The session records why in the transcript either way; keep this short.
      return this.send(
        done
          ? `${picker === 'mode' ? 'Mode' : 'Model'} → <b>${esc(arg)}</b>`
          : `Cursor would not set that ${picker}. See the chat for why.`,
      );
    }

    const offer = await this.sessions.desktopChoices(active.id, picker);
    if (offer.status !== 'ok') {
      return this.send(
        `Cannot read Cursor's ${picker} list: ${esc(offer.reason || offer.status)}.`,
      );
    }

    const rows = [];
    const options = offer.options.filter((o) => !/^(add models|new|edit)$/i.test(o));
    for (let i = 0; i < options.length; i += 2) {
      rows.push(
        options.slice(i, i + 2).map((label) => ({
          text: `${label === offer.was ? '● ' : ''}${label}`.slice(0, 40),
          callback_data: this.tokenFor({ kind: 'cursorPick', picker, label }),
        })),
      );
    }
    return this.send(
      `Cursor's ${picker} for this chat is <b>${esc(offer.was || 'unknown')}</b>`,
      { reply_markup: { inline_keyboard: rows } },
    );
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

    if (payload.kind === 'project') {
      // Go to the project's newest session, or open one if it has none.
      const existing = this.sessions
        .list()
        .find((s) => sameFolder(s.folder, payload.folder));
      const meta = existing || (await this.sessions.startInIde({ folder: payload.folder }));
      this.sessions.setActive(meta.id);
      await answer(`${existing ? 'Switched to' : 'Started'} ${meta.title}`);
      await this.send(
        `${existing ? 'Now on' : 'Started'} <b>${esc(meta.title)}</b>` +
          (!existing && meta.kind === 'desktop' ? ' in the Cursor desktop app' : '') +
          `\n<code>${esc(meta.folder)}</code>`,
      );
      return;
    }

    if (payload.kind === 'continue') {
      try {
        const meta = await this.sessions.attachDesktopThread({
          threadId: payload.chatId,
          folder: payload.folder,
        });
        this.sessions.setActive(meta.id);
        await answer(`Continuing ${meta.title}`);
        await this.send(
          `Continuing <b>${esc(meta.title)}</b> in the Cursor desktop app.\n` +
            'Same conversation on both ends — what you send here appears there.',
        );
      } catch (err) {
        await answer(err.message.slice(0, 190));
        await this.send(`⚠️ ${esc(err.message)}`);
      }
      return;
    }

    if (payload.kind === 'cursorPick') {
      const id = this.sessions.activeId;
      const set =
        payload.picker === 'mode'
          ? await this.sessions.setMode(id, payload.label)
          : await this.sessions.setModel(id, payload.label);
      await answer(set ? `${payload.picker}: ${payload.label}` : 'Cursor would not take that.');
      if (set) await this.send(`${payload.picker === 'mode' ? 'Mode' : 'Model'} → <b>${esc(payload.label)}</b>`);
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
      return;
    }

    if (payload.kind === 'question') {
      const id = this.sessions.activeId;
      if (!id) {
        await answer('No active session.');
        return;
      }
      if (payload.action === 'skip') {
        this.sessions.answerQuestion(id, { askId: payload.askId, skip: true }).catch((err) => {
          this.send(`⚠️ ${esc(err.message)}`);
        });
        await answer('Skip');
        return;
      }
      const held = this.asks.get(payload.askId);
      const questions = held?.questions || this.sessions.pendingQuestion?.(id)?.questions || [];
      if (payload.action === 'submit') {
        this.sessions
          .answerQuestion(id, { askId: payload.askId, selections: held?.chosen || {} })
          .catch((err) => {
            this.send(`⚠️ ${esc(err.message)}`);
          });
        await answer('Submit');
        return;
      }
      const q = questions.find((item) => item.id === payload.questionId);
      if (!q) {
        await answer('That question is gone.');
        return;
      }
      const oneTap = questions.length === 1 && !questions[0]?.multiple;
      const chosen = held?.chosen || {};
      if (q.multiple) {
        const have = new Set(chosen[q.id] || []);
        if (have.has(payload.optionId)) have.delete(payload.optionId);
        else have.add(payload.optionId);
        chosen[q.id] = [...have];
      } else {
        chosen[q.id] = [payload.optionId];
      }
      if (held) held.chosen = chosen;
      if (oneTap) {
        this.sessions
          .answerQuestion(id, { askId: payload.askId, selections: chosen })
          .catch((err) => {
            this.send(`⚠️ ${esc(err.message)}`);
          });
      }
      await answer(payload.label || 'picked');
    }

    if (payload.kind === 'plan') {
      const id = payload.sessionId || this.sessions.activeId;
      if (!id) {
        await answer('No active session.');
        return;
      }
      if (payload.action === 'view') {
        await answer('View Plan');
        await this.#sendPlanMarkdown(payload.toolCallId);
        return;
      }
      if (payload.action === 'models') {
        await answer('Build');
        await this.#sendPlanModels(id, payload.toolCallId);
        return;
      }
      this.sessions
        .buildPlan(id, { toolCallId: payload.toolCallId, model: payload.model || '' })
        .catch((err) => {
          this.send(`⚠️ ${esc(err.message)}`);
        });
      await answer(payload.label || 'Build');
    }
  }

  // ------------------------------------------------------------------- output

  #wire() {
    this.sessions.on('record', ({ sessionId, record }) => {
      // Only mirror the session Telegram is looking at; the web can watch the rest.
      if (sessionId !== this.sessions.activeId) return;
      this.onRecord(sessionId, record).catch((err) =>
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
        started: 0,
        conclusion: '',
      });
    }
    return this.turns.get(sessionId);
  }

  #compose(turn) {
    return renderTurn({
      text: turn.text,
      tools: [...turn.tools.values()],
      conclusion: turn.conclusion,
    });
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
    try {
      // Only mark rendered after Telegram accepts the text. A failed first
      // send used to set rendered anyway, so later flushes with the same body
      // early-returned and the whole turn never reached the phone.
      if (turn.messageId) {
        const edited = await this.edit(turn.messageId, text);
        if (edited) turn.rendered = text;
      } else {
        const sent = await this.send(text);
        if (sent?.message_id) {
          turn.messageId = sent.message_id;
          turn.rendered = text;
        }
      }
    } finally {
      turn.sending = false;
    }
  }

  async onRecord(sessionId, rec) {
    const turn = this.#turn(sessionId);

    switch (rec.kind) {
      case 'user_message': {
        // Already on the phone if it was typed here; web / Cursor still need a copy.
        if (this.#consumeOwnPrompt(rec.text)) break;
        const bits = [];
        if (rec.text?.trim()) bits.push(esc(rec.text));
        if (rec.images) {
          bits.push(`📷 ${rec.images} image${rec.images === 1 ? '' : 's'}`);
        }
        if (!bits.length) break;
        await this.send(bits.join('\n'));
        break;
      }

      case 'turn_start':
        turn.messageId = null;
        turn.text = '';
        turn.rendered = '';
        turn.tools.clear();
        turn.started = rec.ts || Date.now();
        turn.conclusion = '';
        break;

      case 'agent_delta':
        if (rec.replace) turn.text = rec.text || '';
        else turn.text += rec.text || '';
        this.#schedule(sessionId);
        break;

      case 'tool_call':
        if (classifyTool(rec).lane === 'hide') break;
        if (isCreatedPlan(rec)) {
          await this.#sendPlan(sessionId, rec);
          break;
        }
        turn.tools.set(rec.toolCallId || `t${turn.tools.size}`, {
          rec,
          label: toolLabel(rec),
          status: rec.status || 'in_progress',
          failure: failureNote(rec),
        });
        this.#schedule(sessionId);
        break;

      case 'tool_update': {
        const held = this.plans.get(rec.toolCallId);
        if (held && rec.rawInput) {
          held.rawInput = { ...held.rawInput, ...rec.rawInput };
          held.awaitingBuild = rec.awaitingBuild ?? held.awaitingBuild;
        }
        const tool = turn.tools.get(rec.toolCallId);
        // An MCP call is named only once it is under way; take the name late.
        if (tool && rec.title) {
          tool.rec = { ...tool.rec, title: rec.title };
          tool.label = toolLabel(tool.rec);
        }
        if (tool && rec.status) {
          tool.status = rec.status;
          // A command that broke is the one thing worth quoting on a phone.
          tool.failure = failureNote(rec) || tool.failure;
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
        {
          const durationMs =
            rec.durationMs > 0
              ? rec.durationMs
              : rec.ts && turn.started
                ? rec.ts - turn.started
                : 0;
          turn.conclusion = turnCopy({
            durationMs,
            worked: turn.tools.size > 0,
          }).label;
        }
        // A blip on the last send used to leave the phone with nothing for the
        // whole turn — retry a couple of times while the body is still here.
        for (let attempt = 0; attempt < 3; attempt++) {
          await this.#flush(sessionId);
          if (turn.rendered === this.#compose(turn)) break;
          await new Promise((r) => setTimeout(r, 400));
        }
        break;

      // A question, spelled out, with buttons for each option. A card can hold
      // several questions, so a single tap is only enough when there is one
      // question and one answer; otherwise the taps collect and Submit sends.
      case 'question': {
        const sent = await this.send(questionText(rec), {
          reply_markup: { inline_keyboard: this.#questionButtons(rec) },
        });
        if (sent?.message_id) this.askMessages.set(rec.askId, sent.message_id);
        this.asks.set(rec.askId, {
          sessionId,
          questions: rec.questions || [],
          chosen: {},
        });
        break;
      }

      case 'question_answered': {
        await this.#closeQuestion(rec);
        const chosen = Object.values(rec.selections || {}).flat().filter(Boolean);
        const typed = Object.values(rec.texts || {}).filter(Boolean);
        const said = [...chosen, ...typed].join(', ') || rec.state || 'answered';
        await this.send(`✅ Answered: ${esc(said)}`);
        break;
      }

      case 'error':
        await this.send(`⚠️ ${esc(rec.text || 'error')}`);
        break;

      case 'notice':
        // Holds are said out loud: they are the only word a phone gets that
        // its message did not vanish. Queue adds are a separate reply from
        // the prompt itself, so they do not also appear in the transcript.
        await this.send(`ℹ️ ${esc(rec.text || '')}`);
        break;

      default:
        break;
    }
  }

  /**
   * A question card as words on a phone.
   *
   * Options are lettered rather than bulleted so an answer typed back can name
   * one in a word, and each question keeps its own letters: "1A" is unambiguous
   * where "the second one" is not.
   */
  #questionButtons(rec) {
    const questions = rec.questions || [];
    const rows = [];
    for (const [i, q] of questions.entries()) {
      for (const [j, opt] of (q.options || []).entries()) {
        const letter = optionLetter(i, j, questions.length);
        const label = String(opt.label || opt.id || '');
        const text = `${letter} ${label}`.replace(/\s+/g, ' ').trim();
        rows.push([
          {
            text: text.length > 64 ? `${text.slice(0, 63)}…` : text,
            callback_data: this.tokenFor({
              kind: 'question',
              askId: rec.askId,
              questionId: q.id,
              optionId: opt.id,
              label: letter,
            }),
          },
        ]);
      }
    }
    const oneTap = questions.length === 1 && !questions[0]?.multiple;
    if (!oneTap) {
      rows.push([
        {
          text: 'Submit',
          callback_data: this.tokenFor({ kind: 'question', askId: rec.askId, action: 'submit' }),
        },
      ]);
    }
    rows.push([
      {
        text: 'Skip',
        callback_data: this.tokenFor({ kind: 'question', askId: rec.askId, action: 'skip' }),
      },
    ]);
    return rows;
  }

  async #closeQuestion(rec) {
    const messageId = this.askMessages.get(rec.askId);
    this.askMessages.delete(rec.askId);
    this.asks.delete(rec.askId);
    if (!messageId) return;
    const chosen = Object.values(rec.selections || {}).flat().filter(Boolean);
    const said = chosen.join(', ') || rec.state || 'answered';
    await this.edit(messageId, `❓ <b>Question</b> — ${esc(said)}`, { reply_markup: undefined });
  }

  async #sendPlan(sessionId, rec) {
    const fields = planFields(rec);
    this.plans.set(rec.toolCallId, { ...rec, rawInput: rec.rawInput || {}, sessionId });
    const rows = [
      [
        {
          text: 'View Plan',
          callback_data: this.tokenFor({
            kind: 'plan',
            action: 'view',
            toolCallId: rec.toolCallId,
            sessionId,
          }),
        },
      ],
    ];
    if (fields.awaitingBuild) {
      rows.push([
        {
          text: 'Build',
          callback_data: this.tokenFor({
            kind: 'plan',
            action: 'models',
            toolCallId: rec.toolCallId,
            sessionId,
          }),
        },
      ]);
    }
    await this.send(planText(rec), { reply_markup: { inline_keyboard: rows } });
  }

  async #sendPlanMarkdown(toolCallId) {
    const rec = this.plans.get(toolCallId);
    const markdown = planFields(rec || {}).markdown;
    if (!markdown) {
      await this.send('That plan has no contents yet.');
      return;
    }
    const chunks = [];
    let rest = markdown;
    while (rest.length) {
      chunks.push(rest.slice(0, LIMIT - 20));
      rest = rest.slice(LIMIT - 20);
    }
    for (const chunk of chunks) {
      await this.send(`<pre>${esc(chunk)}</pre>`);
    }
  }

  async #sendPlanModels(sessionId, toolCallId) {
    const models = this.sessions.catalog?.models || [];
    const rows = [
      [
        {
          text: 'Current model',
          callback_data: this.tokenFor({
            kind: 'plan',
            action: 'build',
            toolCallId,
            sessionId,
            label: 'Build',
          }),
        },
      ],
    ];
    for (let i = 0; i < models.length; i += 2) {
      rows.push(
        models.slice(i, i + 2).map((m) => ({
          text: m.modelId === 'default[]' ? 'Auto-select' : m.name || m.modelId,
          callback_data: this.tokenFor({
            kind: 'plan',
            action: 'build',
            toolCallId,
            sessionId,
            model: m.modelId,
            label: m.name,
          }),
        })),
      );
    }
    await this.send('Build with which model?', { reply_markup: { inline_keyboard: rows } });
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
