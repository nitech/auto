/**
 * What Cursor's own window looks like from the inside.
 *
 * Driving the IDE through its debug port means reaching into a user interface
 * nobody promised to keep stable, so every assumption about it lives here and
 * nowhere else. When a Cursor update moves something, this is the only file
 * that should need to change, and `spike/cdp-probe.mjs --discover` is how to
 * find out what it moved to — the selectors below were derived that way, not
 * copied from anywhere.
 *
 * Each name is a list, tried in order, so a rename can be survived by adding
 * the new form in front of the old one rather than by replacing it.
 *
 * The scripts here are strings because they are evaluated inside Cursor's
 * renderer, where nothing of ours exists: they can call no helper of ours and
 * must carry everything they need with them.
 */

export const SELECTORS = {
  /** The panel the chat lives in — the right-hand sidebar. */
  chatPane: ['#workbench\\.parts\\.auxiliarybar'],
  /** The chat box: a rich text editor, not an input. */
  composer: [
    "div.aislash-editor-input[contenteditable='true']",
    "[data-composer-id] div[contenteditable='true']",
    "div[contenteditable='true'].aislash-editor-input",
  ],
  /** Where the id of the chat on screen is written, and under which name. */
  thread: [{ selector: '[data-composer-id]', attribute: 'data-composer-id' }],
  /** One per message on screen, holding its bubble id, role and kind. */
  message: ['[data-message-id]'],
  /** The stop button beside the chat box, as an icon rather than a word. */
  stopIcon: ['span.codicon-debug-stop', '[aria-label="Stop"]'],
  /** A chat's tab, which names the chat it belongs to. */
  tab: [{ selector: '[data-resource-name]', attribute: 'data-resource-name' }],
  /**
   * Things that look pressable and are not controls.
   *
   * Cursor styles message text with a pointer cursor, so a message that happens
   * to begin "Run this command…" reads exactly like a Run button. One did, and
   * Auto asked to approve it — so the words in a conversation are ruled out
   * before anything is read as a control.
   */
  notControls: [
    '.composer-human-message',
    '.aislash-editor-input-readonly',
    '.ui-markdown',
    '.ui-shell-tool-call__output',
  ],
};

/**
 * Stopping a turn, by the shortcut Cursor prints on its own Stop button.
 *
 * Discovered rather than assumed: the button reads "Stop Ctrl+Shift+⌫". A
 * keystroke is a better way to ask than a click, because it goes through the
 * same path as a person's keyboard and does not depend on finding a widget.
 */
export const STOP_TURN_KEY = { key: 'Backspace', code: 'Backspace', keyCode: 8, modifiers: 2 | 8 };

/**
 * Words on a control that mean Cursor is waiting for a person.
 *
 * Cursor's own settings decide whether it ever asks — with everything set to
 * run automatically it never will. So this vocabulary is a net cast wide on
 * purpose, and whatever it catches is reported with the exact wording seen, so
 * the first real approval teaches us the words we actually needed.
 */
const APPROVAL_WORDS =
  /^(run|run command|run anyway|accept|accept all|apply|allow|allow once|always allow|approve|reject|reject all|deny|skip|cancel|continue|resume|keep|undo|move on|yes|no)\b/i;

/** Past this many characters it is a sentence, not a button. */
const APPROVAL_MAX = 24;

/** Does this control look like an answer to a question Cursor is asking? */
export function isApproval(label) {
  const name = String(label || '').trim();
  return name.length <= APPROVAL_MAX && APPROVAL_WORDS.test(name);
}

const list = (names) => JSON.stringify(names);

/**
 * Helpers every script needs: the chat panel, and the chat box within it.
 *
 * The box is looked for inside the panel first so a stray editor elsewhere in
 * the window cannot be mistaken for it.
 */
const HELPERS = `
  const __pane = () =>
    ${list(SELECTORS.chatPane)}.map((s) => document.querySelector(s)).find(Boolean) || document;
  const __box = () => {
    const pane = __pane();
    for (const s of ${list(SELECTORS.composer)}) {
      const el = pane.querySelector(s) || document.querySelector(s);
      if (el) return el;
    }
    return null;
  };
  const __text = (el) => (el?.textContent || '').trim();

  /**
   * Press something that wants a mouse rather than a click.
   *
   * Cursor's chat is React and answers a plain click, but the editor tabs are
   * the workbench's own and act on the button going down. Sending the whole
   * sequence satisfies both without having to know which is which.
   */
  const __mouse = (el) => {
    const rect = el.getBoundingClientRect();
    const at = {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 0,
      buttons: 1,
      clientX: Math.round(rect.left + rect.width / 2),
      clientY: Math.round(rect.top + rect.height / 2),
    };
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const Ctor = type.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ctor(type, type === 'pointerup' || type === 'mouseup' ? { ...at, buttons: 0 } : at));
    }
  };
`;

/**
 * Everything Auto needs to know about a window in one look: which repo it has
 * open, which chat it is showing, what is on screen, and whether its chat box
 * is ready to be typed into.
 *
 * `threadId` is deliberately null when the window shows more than one chat id.
 * A wrong answer here would type someone's message into the wrong
 * conversation, so ambiguity is reported rather than resolved by guessing.
 */
export const FACTS = `(() => {
${HELPERS}
  let workspace = null;
  try {
    workspace = vscode.context.configuration().workspace?.uri?.path || null;
  } catch {
    workspace = null;
  }

  const pane = __pane();
  const ids = new Set();
  for (const { selector, attribute } of ${list(SELECTORS.thread)}) {
    for (const el of pane.querySelectorAll(selector)) {
      const id = el.getAttribute(attribute);
      if (id) ids.add(id);
    }
  }

  const rows = [];
  for (const s of ${list(SELECTORS.message)}) {
    for (const el of pane.querySelectorAll(s)) {
      rows.push({
        id: el.getAttribute('data-message-id'),
        role: el.getAttribute('data-message-role'),
        kind: el.getAttribute('data-message-kind'),
      });
    }
    if (rows.length) break;
  }

  const box = __box();
  return {
    title: document.title,
    workspace,
    threadId: ids.size === 1 ? [...ids][0] : null,
    threadIdsSeen: ids.size,
    rows: rows.slice(-12),
    hasComposer: Boolean(box),
    composerText: __text(box),
  };
})()`;

/** Put the caret in the chat box, and say whether it went there. */
export const FOCUS_COMPOSER = `(() => {
${HELPERS}
  const box = __box();
  if (!box) return false;
  box.focus();
  return document.activeElement === box || box.contains(document.activeElement);
})()`;

/** What the chat box holds now. */
export const COMPOSER_TEXT = `(() => {
${HELPERS}
  return __text(__box());
})()`;

/**
 * Finding the things a person could press.
 *
 * Cursor builds its chat from generated class names, so what a control *is*
 * cannot be relied on — but what it *says* can, because that is what the user
 * reads too. So controls are found by being pressable and named by their words.
 *
 * Deciding what counts as one control takes three rules, each learned from the
 * real thing. A real button is a control; anything inside it is part of it, not
 * a control of its own. An element merely styled as pressable counts only if it
 * holds no button, so a toolbar does not swallow the buttons it contains. And
 * where such elements nest and say the same words — as Cursor's Stop control
 * does, three layers deep — the outermost is the one to press.
 */
const PRESSABLE = `
  const __pressable = () => {
    const pane = __pane();
    const box = __box();
    const boxTop = box ? box.getBoundingClientRect().top : Infinity;
    const clean = (s) =>
      String(s ?? '')
        .replace(/\\s+/g, ' ')
        .trim()
        // Cursor renders some labels twice over for layout; say them once.
        .replace(/(.{3,}?)\\1$/, '$1')
        .slice(0, 80);
    const isButton = (el) => el.tagName === 'BUTTON' || el.getAttribute('role') === 'button';

    const candidates = [];
    for (const el of pane.querySelectorAll('*')) {
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      if (!isButton(el)) {
        if (getComputedStyle(el).cursor !== 'pointer') continue;
        if (el.querySelector("button, [role='button']")) continue;
      }
      // What a conversation says is not something to press.
      if (el.closest(${JSON.stringify(SELECTORS.notControls.join(', '))})) continue;
      candidates.push({ el, rect });
    }

    const found = [];
    for (const { el, rect } of candidates) {
      // Part of a button, rather than a control in its own right.
      if (candidates.some(({ el: other }) => other !== el && isButton(other) && other.contains(el))) {
        continue;
      }
      const label = clean(el.getAttribute('aria-label') || el.getAttribute('title'));
      // The keybinding hint Cursor prints inside a button is not part of its name.
      const text = clean(el.textContent).replace(/(Ctrl|Alt|Shift|⌘|⌥)[^\\s]*$/i, '').trim();
      if (!label && !text) continue;
      // One of several nested layers all saying the same thing: press the outer.
      const name = label || text;
      if (
        found.some(
          (kept) => (kept.label || kept.text) === name && kept.el.contains(el),
        )
      ) {
        continue;
      }
      found.push({
        el,
        label,
        text,
        where: rect.top >= boxTop ? 'composer' : 'transcript',
        disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      });
    }
    return found;
  };
  const __named = (c) => c.label || c.text;
  const __matches = (c, want) => __named(c).toLowerCase() === String(want).toLowerCase();
`;

/** Every control on offer, and whether a turn is running. */
export const ACTIONS = `(() => {
${HELPERS}
${PRESSABLE}
  const found = __pressable();
  // Two signs of a turn in flight, because the obvious one is not general: the
  // word "Stop" belongs to the bar offering to review file changes, so a chat
  // that has edited nothing never shows it. The stop icon beside the chat box
  // is always there while the agent works.
  const stopIcon = ${list(SELECTORS.stopIcon)}.some((s) => __pane().querySelector(s));
  return {
    generating: stopIcon || found.some((c) => /^stop\\b/i.test(__named(c))),
    controls: found.map(({ label, text, where, disabled }) => ({ label, text, where, disabled })),
  };
})()`;

/**
 * Press the control with this name.
 *
 * A native click is dispatched on the element itself rather than a mouse event
 * at a position: Cursor's chat is React, which listens for clicks that bubble,
 * and a click aimed at coordinates can miss or land on a tooltip that moved.
 *
 * The last match wins. Where a name repeats it is once per message, and the
 * one being asked about is the newest — the one at the bottom of the chat.
 */
export const clickAction = (name) => `(() => {
${HELPERS}
${PRESSABLE}
  const wanted = ${JSON.stringify(String(name))};
  const matches = __pressable().filter((c) => __matches(c, wanted) && !c.disabled);
  if (!matches.length) return { clicked: false, reason: 'no control says that' };
  const target = matches[matches.length - 1];
  target.el.click();
  return { clicked: true, name: __named(target), where: target.where, of: matches.length };
})()`;

/**
 * Point the window at a chat by pressing its tab.
 *
 * Cursor keeps a tab per open chat and writes the chat's id on it, which is a
 * far better handle than the title on its face: titles repeat, change, and get
 * renamed by the agent mid-conversation. Ids do not.
 */
export const showThread = (threadId) => `(() => {
${HELPERS}
  const pane = __pane();
  const wanted = ${JSON.stringify(String(threadId))};
  for (const { selector, attribute } of ${list(SELECTORS.tab)}) {
    for (const el of pane.querySelectorAll(selector)) {
      if (el.getAttribute(attribute) !== wanted) continue;
      __mouse(el);
      return true;
    }
  }
  return false;
})()`;

/**
 * Compare two paths the way a person would.
 *
 * Cursor reports its folder as `/d:/Sevenfold/auto` while Auto holds
 * `D:\\Sevenfold\\auto`. Same folder, three differences.
 */
export function samePath(a, b) {
  const norm = (p) =>
    String(p || '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '')
      .toLowerCase();
  const left = norm(a);
  return Boolean(left) && left === norm(b);
}
