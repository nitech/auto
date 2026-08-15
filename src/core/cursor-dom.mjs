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
   * The mode dropdown, which writes the mode it is set to on itself.
   *
   * Three things in the composer carry that attribute: the bar holding both
   * pickers, an icon button with no words at all, and the dropdown itself. Taking
   * the first found meant pressing the icon button in a new chat and reporting
   * that the mode picker would not open, so the specific one is asked for first
   * and the attribute is only a fallback.
   */
  modeBox: [
    { selector: '.composer-unified-dropdown[data-mode]', attribute: 'data-mode' },
    { selector: '[data-mode]', attribute: 'data-mode' },
  ],
  /**
   * An image sitting in the chat box, waiting to go with the message.
   *
   * Cursor calls it a context pill. Counting them is how Auto knows a paste
   * landed: the clipboard can hold the right picture and the window still ignore
   * it, and a message that quietly loses its photo is worse than a refusal.
   */
  attached: ['.context-pill-image', '.image-pill-container'],
  /**
   * Cursor's own queue of messages waiting for the turn to end.
   *
   * A message sent into a busy chat is queued by Cursor, and the IDE lists it
   * above the chat box with three icon buttons: edit, send now, delete. Those
   * buttons carry no words and no labels at all, so for once they are found by
   * what they are — `codicon` names are VS Code's own icon vocabulary, not
   * Cursor's generated classes, and `trashcan` is not going to start meaning
   * something else. The rows themselves are still identified by their text.
   */
  queueCount: ['.composer-toolbar-section-header'],
  queueEdit: ['[class*="codicon-edit"]'],
  queueNow: ['[class*="codicon-arrow-up-two"]'],
  queueDrop: ['[class*="codicon-trashcan"]'],
  /** The model button, and the text inside it naming the current model. */
  modelName: ['.ui-model-picker__trigger-text'],
  modelButton: ['button[aria-haspopup="menu"]'],
  /**
   * A menu, once one is open.
   *
   * The two pickers do not agree on what a menu is: models open a proper
   * `role=menu`, modes open the same popover Cursor uses for @-mentions. Both
   * are listed, and neither is in the chat pane — they render near the root of
   * the page, so a menu is looked for in the whole document.
   */
  menu: ['[role="menu"]', '.typeahead-popover'],
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
    // The top line of a tool call: the description the agent wrote for it and a
    // summary of the command. Pointer-styled, holding no button, and prose — so
    // a phone was offered "Run the test suite" as something to approve, three
    // times in one turn, because the words start with "Run". Only the header is
    // excluded; a real approval belongs to the card's body and must survive.
    '.ui-tool-call-card__header',
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
  /^(run|run command|run anyway|accept|allow|allow once|always allow|approve|reject|deny|skip|cancel|continue|resume|move on|yes|no)\b/i;

/**
 * Words that belong to the bar offering to review file changes.
 *
 * These were in the vocabulary above and should never have been. That bar is
 * not a question: it stands there for as long as a chat has edits nobody has
 * looked at, so a phone was offered "Keep All" and "Undo All" as if answering
 * them would get a turn moving again. It would not — and "Undo All" throws away
 * work, which makes offering it by accident the worst button on the screen.
 * File changes deserve their own deliberate action, not a mystery approval.
 */
const REVIEW_WORDS = /^(keep|undo|revert|accept all|reject all|apply|discard)\b/i;

/** Past this many characters it is a sentence, not a button. */
const APPROVAL_MAX = 24;

/** Does this control look like an answer to a question Cursor is asking? */
export function isApproval(label) {
  const name = String(label || '').trim();
  if (name.length > APPROVAL_MAX || REVIEW_WORDS.test(name)) return false;
  return APPROVAL_WORDS.test(name);
}

/** Does this control act on file changes rather than answer a question? */
export function isFileReview(label) {
  return REVIEW_WORDS.test(String(label || '').trim());
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
  let folders = [];
  try {
    const cfg = vscode.context.configuration();
    workspace = cfg?.workspace?.uri?.path || cfg?.workspace?.uri?.fsPath || null;
    const roots = cfg?.workspaceFolders || cfg?.folders || cfg?.workspace?.folders || [];
    if (Array.isArray(roots)) {
      folders = roots
        .map((f) => f?.uri?.path || f?.uri?.fsPath || f?.path || null)
        .filter(Boolean);
    }
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
    folders,
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

/** How many images are waiting in the chat box to be sent. */
export const ATTACHED = `(() => {
${HELPERS}
  const box = __box();
  // The pills sit beside the box, not in it, so look at what holds both.
  const around = box?.closest('div[class*="composer"], form, section') || __pane();
  const found = new Set();
  for (const selector of ${list(SELECTORS.attached)}) {
    for (const el of around.querySelectorAll(selector)) {
      // One pill is built from several elements; count the outermost.
      if (![...found].some((kept) => kept.contains(el))) found.add(el);
    }
  }
  return found.size;
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
        inMessage: Boolean(el.closest('[data-message-id]')),
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
    controls: found.map(({ label, text, where, disabled, inMessage }) => ({
      label,
      text,
      where,
      disabled,
      inMessage,
    })),
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
 * Start a new chat in this window, by the control Cursor labels New Agent.
 *
 * The words on it include the shortcut and an Alt-action ("New Agent (Ctrl+N)
 * [Alt] Replace Agent"), so it is found by the name it begins with rather than
 * by an exact match — asking for the whole string would break the moment the
 * hint changed. It is a workbench action, not a React button, so it is pressed
 * with a mouse the way a tab is.
 */
export const NEW_AGENT = `(() => {
${HELPERS}
  const pane = __pane();
  for (const el of pane.querySelectorAll('[aria-label], [title]')) {
    const name = String(el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
    if (!/^New Agent\\b/i.test(name)) continue;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    __mouse(el);
    return { pressed: true, name };
  }
  return { pressed: false, reason: 'no New Agent control' };
})()`;

/**
 * Where a picker is, so that it can be pressed with a real mouse.
 *
 * Neither dropdown opens for a dispatched click — they act on input the window
 * believes came from a mouse — so what is wanted here is not the element but the
 * point it occupies. See `CursorWindow.mouseAt`.
 *
 * @param {'model'|'mode'} which
 */
export const pickerAt = (which) => `(() => {
${HELPERS}
  const pane = __pane();
  let el = null;
  if (${JSON.stringify(which)} === 'mode') {
    for (const { selector, attribute } of ${list(SELECTORS.modeBox)}) {
      // Of the things carrying the attribute, the dropdown is the one whose
      // words are the mode itself; the bar around it also says the model, and
      // the icon button beside it says nothing.
      const boxes = [...pane.querySelectorAll(selector)].filter((candidate) => {
        const said = __text(candidate).replace(/\\s+/g, ' ').toLowerCase();
        return said && said === (candidate.getAttribute(attribute) || '').toLowerCase();
      });
      // A custom mode is named something the attribute does not say, so fall
      // back to whichever of them says the least — never the bar.
      const box =
        boxes[0] ||
        [...pane.querySelectorAll(selector)]
          .filter((candidate) => __text(candidate))
          .sort((a, b) => __text(a).length - __text(b).length)[0];
      if (!box) continue;
      // The dropdown holds both pickers. Take the side without the model in it.
      const modelBit = ${list(SELECTORS.modelName)}
        .map((s) => box.querySelector(s))
        .find(Boolean);
      el =
        [...box.children].find((kid) => !modelBit || !kid.contains(modelBit)) || box;
      break;
    }
  } else {
    for (const s of ${list(SELECTORS.modelName)}) {
      const found = pane.querySelector(s);
      if (found) {
        el = found.closest('button') || found;
        break;
      }
    }
    if (!el) {
      for (const s of ${list(SELECTORS.modelButton)}) {
        const found = [...pane.querySelectorAll(s)].pop();
        if (found) {
          el = found;
          break;
        }
      }
    }
  }
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return {
    label: __text(el).replace(/\\s+/g, ' ').slice(0, 60),
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
})()`;

/**
 * What the open menu offers, and where each of those things is.
 *
 * An item is named by the words belonging to it and not to its children. A model
 * row is written as its name with badges inside it — "Opus 5" holding a "High" —
 * so reading whole subtrees produced names no menu ever showed, like "Opus 5
 * HighEdit", and made "Auto" ambiguous with the wrapper repeating it. Taking
 * only an element's own text gives the row its name, each badge its own, and
 * every one of them a place to be pressed, which is what choosing a variant
 * needs. The keystroke printed next to a row is not an item.
 */
export const MENU_ITEMS = `(() => {
  const clean = (s) =>
    String(s ?? '')
      // The model menu pads its badges with zero-width spaces.
      .replace(/[\\u200b\\u200c\\u200d\\ufeff]/g, '')
      .replace(/\\s+/g, ' ')
      .trim();
  const shortcut = /^(Ctrl|Alt|Shift|Cmd|⌘|⌥|⇧)[+\\-]?/i;

  const menus = ${list(SELECTORS.menu)}
    .flatMap((s) => [...document.querySelectorAll(s)])
    .filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });

  const items = [];
  for (const menu of menus) {
    for (const el of menu.querySelectorAll('*')) {
      const own = [...el.childNodes]
        .filter((node) => node.nodeType === 3)
        .map((node) => node.textContent)
        .join(' ');
      const label = clean(own);
      if (!label || label.length > 60 || shortcut.test(label)) continue;
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      // The same words in the same place are one item however many elements
      // Cursor built it from.
      if (items.some((kept) => kept.label === label && Math.abs(kept.y - y) < 2)) continue;
      const state =
        el.getAttribute('aria-checked') ??
        el.getAttribute('aria-selected') ??
        el.closest('[aria-checked],[aria-selected]')?.getAttribute('aria-checked') ??
        null;
      items.push({ label, x, y, current: state === 'true' });
    }
  }
  return { open: menus.length, items };
})()`;

/**
 * The messages Cursor is holding until the turn ends.
 *
 * The count and the rows live in separate blocks under one parent, so the header
 * is found by its words — "3 Queued" — and the rows by having a delete button of
 * their own. Walking out from that button to the first ancestor with words gives
 * the row, which is the message and its three buttons and nothing else.
 *
 * A row scrolled out of its little list has no place on screen and cannot be
 * pressed, so it is reported as hidden rather than as a row with nowhere to
 * press: the count says how many are really waiting.
 */
export const QUEUE = `(() => {
${HELPERS}
  const pane = __pane();
  const clean = (s) => String(s ?? '').replace(/\\s+/g, ' ').trim();

  let head = null;
  for (const selector of ${list(SELECTORS.queueCount)}) {
    head = [...pane.querySelectorAll(selector)].find((el) => /^\\d+\\s+queued$/i.test(clean(el.textContent)));
    if (head) break;
  }
  if (!head) return { waiting: 0, items: [], hidden: 0 };

  const waiting = Number(clean(head.textContent).match(/^(\\d+)/)?.[1] || 0);
  // The count and the rows are cousins, not siblings: how deeply Cursor nests
  // either is its own business, so climb until one ancestor holds both.
  const rowsIn = (el) => el.querySelector(${list(SELECTORS.queueDrop)}.join(','));
  let block = head;
  for (let up = 0; up < 6 && block.parentElement && !rowsIn(block); up += 1) {
    block = block.parentElement;
  }
  const spot = (el) => {
    const { x, y, width, height } = el.getBoundingClientRect();
    if (!width || !height) return null;
    return { x: Math.round(x + width / 2), y: Math.round(y + height / 2) };
  };

  const items = [];
  let hidden = 0;
  for (const drop of block.querySelectorAll(${list(SELECTORS.queueDrop)}.join(','))) {
    let row = drop;
    for (let up = 0; up < 6 && row.parentElement; up += 1) {
      row = row.parentElement;
      if (clean(row.textContent)) break;
    }
    const text = clean(row.textContent);
    const at = {
      drop: spot(drop),
      now: spot(row.querySelector(${list(SELECTORS.queueNow)}.join(','))),
      edit: spot(row.querySelector(${list(SELECTORS.queueEdit)}.join(','))),
    };
    if (!text || !at.drop) {
      hidden += 1;
      continue;
    }
    items.push({ text, at, y: at.drop.y });
  }

  items.sort((a, b) => a.y - b.y);
  return { waiting, items: items.map(({ text, at }) => ({ text, at })), hidden };
})()`;

/**
 * Press one of a queued message's own buttons.
 *
 * The row is found by the words in it rather than by its position in the list,
 * because between reading the queue on a phone and pressing anything the turn
 * may have ended and taken the first message with it — and pressing the delete
 * button of whatever moved into that position would throw away the wrong
 * message. If those words are no longer queued, nothing is pressed.
 *
 * @param {string} text  the queued message to act on
 * @param {'drop'|'now'|'edit'} which
 */
export const queueAct = (text, which) => `(() => {
${HELPERS}
  const pane = __pane();
  const clean = (s) => String(s ?? '').replace(/\\s+/g, ' ').trim();
  const wanted = clean(${JSON.stringify(String(text))});
  const icons = {
    drop: ${list(SELECTORS.queueDrop)},
    now: ${list(SELECTORS.queueNow)},
    edit: ${list(SELECTORS.queueEdit)},
  }[${JSON.stringify(String(which))}];
  if (!icons) return { pressed: false, reason: 'no such button' };

  for (const drop of pane.querySelectorAll(${list(SELECTORS.queueDrop)}.join(','))) {
    let row = drop;
    for (let up = 0; up < 6 && row.parentElement; up += 1) {
      row = row.parentElement;
      if (clean(row.textContent)) break;
    }
    if (clean(row.textContent) !== wanted) continue;
    const icon = row.querySelector(icons.join(','));
    if (!icon) return { pressed: false, reason: 'that row has no such button' };
    // The button is the thing around the icon; the icon itself is decoration.
    const button = icon.closest('button, [role="button"], [class*="icon-button"]') || icon;
    button.click();
    const { x, y, width, height } = icon.getBoundingClientRect();
    return { pressed: true, at: { x: Math.round(x + width / 2), y: Math.round(y + height / 2) } };
  }
  return { pressed: false, reason: 'that message is no longer queued' };
})()`;

/**
 * Answer a question card in the chat, by the options a person picked.
 *
 * Locates rather than clicks: the rows ignore a dispatched click the same way
 * the model picker does, so the caller presses where they sit with a real mouse.
 * They are often not buttons — lettered pointer-cursor rows, sometimes a sibling
 * of the `ask_question` bubble rather than inside it — which is why searching
 * only for `role=radio` inside `[data-message-id]` missed "Red".
 *
 * @param {object} opts
 * @param {string} opts.askId
 * @param {string[]} [opts.labels]
 * @param {string[]} [opts.texts]
 * @param {boolean} [opts.skip]
 */
export const answerCard = ({ askId, labels = [], indexes = [], texts = [], skip = false }) => `(() => {
${HELPERS}
${PRESSABLE}
  const pane = __pane();
  const clean = (s) => String(s ?? '').replace(/\\s+/g, ' ').trim();
  const wanted = ${JSON.stringify(String(askId || ''))};
  const labels = ${JSON.stringify((labels || []).map(String))};
  const indexes = ${JSON.stringify((indexes || []).map((n) => Number(n)))};
  const texts = ${JSON.stringify((texts || []).map(String))};
  const skip = ${JSON.stringify(Boolean(skip))};
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const spot = (el) => {
    const { x, y, width, height } = el.getBoundingClientRect();
    if (!width || !height) return null;
    return { x: Math.round(x + width / 2), y: Math.round(y + height / 2) };
  };
  const same = (needle, name) => {
    const want = clean(needle).toLowerCase();
    const have = clean(name).toLowerCase();
    if (!want || !have) return false;
    if (have === want || have.startsWith(want) || want.startsWith(have + ' ')) return true;
    if (have.length >= 12 && want.startsWith(have)) return true;
    const stripped = have.replace(/^(?:[a-z]|\\d+)[.)]?\\s+/, '');
    if (stripped === have) return false;
    if (stripped === want || stripped.startsWith(want) || want.startsWith(stripped + ' ')) return true;
    return stripped.length >= 12 && want.startsWith(stripped);
  };
  const isSubmit = (name) => /^(skip|continue|submit)\\b/i.test(clean(name));
  const named = (c) => c.label || c.text;

  // Bring the bubble on screen so a virtualized card actually exists to press.
  let card = null;
  for (const el of pane.querySelectorAll('[data-message-id], [data-find-bubble-ids], [data-tool-call-id]')) {
    const ids = [
      el.getAttribute('data-message-id'),
      el.getAttribute('data-find-bubble-ids'),
      el.getAttribute('data-tool-call-id'),
    ].filter(Boolean);
    if (ids.some((id) => id === wanted || String(id).includes(wanted))) card = el;
  }
  if (!card) {
    const needle = labels[0] || '';
    if (needle) {
      const holders = [...pane.querySelectorAll('div,span,p,li,label,button')].filter((el) => {
        const t = clean(el.textContent);
        return same(needle, t) && ![...el.children].some((k) => same(needle, clean(k.textContent)));
      });
      card = holders.at(-1)?.closest('[data-message-id], [data-find-bubble-ids]') || holders.at(-1);
    }
  }
  if (card) card.scrollIntoView({ block: 'nearest', inline: 'nearest' });

  const matchesControl = (c, word) =>
    same(word, named(c)) || same(word, c.label) || same(word, c.text);

  const locate = (word) => {
    const all = __pressable().filter((c) => !c.disabled);
    const submitBtn = all.filter((c) => isSubmit(named(c))).at(-1);
    const submitTop = submitBtn?.el.getBoundingClientRect().top ?? Infinity;
    const hits = all.filter((c) => matchesControl(c, word) && !isSubmit(named(c)));
    const above = hits.filter((c) => c.el.getBoundingClientRect().top < submitTop);
    const target = (above.length ? above : hits).at(-1);
    const at = target ? spot(target.el) : null;
    return at ? { name: named(target), at } : null;
  };

  const locateNth = (n) => {
    if (!Number.isInteger(n) || n < 0) return null;
    const all = __pressable().filter((c) => !c.disabled && !isSubmit(named(c)));
    const submitBtn = __pressable().filter((c) => isSubmit(named(c))).at(-1);
    const submitTop = submitBtn?.el.getBoundingClientRect().top ?? Infinity;
    const rows = all
      .filter((c) => c.el.getBoundingClientRect().top < submitTop)
      .sort((a, b) => a.el.getBoundingClientRect().top - b.el.getBoundingClientRect().top);
    const target = rows[n];
    const at = target ? spot(target.el) : null;
    return at ? { name: named(target), at } : null;
  };

  const locateSubmit = (word) => {
    const target = __pressable()
      .filter((c) => !c.disabled && same(word, named(c)))
      .at(-1);
    const at = target ? spot(target.el) : null;
    return at ? { name: named(target), at } : null;
  };

  return (async () => {
    await pause(80);
    const offered = __pressable();
    if (
      !card &&
      !offered.some((c) => isSubmit(named(c)) || labels.some((l) => matchesControl(c, l)))
    ) {
      return { pressed: false, reason: 'the question is not on screen' };
    }

    if (skip) {
      const hit = locateSubmit('Skip');
      return hit
        ? { pressed: true, selected: [], submitted: 'Skip', at: hit.at, press: [hit.at] }
        : { pressed: false, reason: 'no Skip control on the card' };
    }

    const selected = [];
    const press = [];
    for (const [i, label] of labels.entries()) {
      const hit = locate(label) || locateNth(indexes[i] ?? i);
      if (!hit) return { pressed: false, reason: 'no option says ' + JSON.stringify(label), selected };
      selected.push(label);
      press.push(hit.at);
    }

    const scope = card || pane;
    for (const [i, text] of texts.entries()) {
      const box = [...scope.querySelectorAll('textarea, input[type="text"]')][i];
      if (!box || !text) continue;
      box.focus();
      box.value = text;
      box.dispatchEvent(new Event('input', { bubbles: true }));
      box.dispatchEvent(new Event('change', { bubbles: true }));
    }

    const hit = locateSubmit('Continue') || locateSubmit('Submit');
    if (!hit) return { pressed: false, reason: 'no Continue control on the card', selected };
    press.push(hit.at);
    return { pressed: true, selected, submitted: hit.name, at: hit.at, press };
  })();
})()`;

/**
 * Find Cursor's Created Plan card and press View Plan or Build on it.
 *
 * The card is the bubble `create_plan` drew. Auto already knows its id, so this
 * finds that bubble — a Build in another chat cannot be the one that runs.
 * "Build Ctrl+⏎" is named Build once the shortcut is stripped, the same way
 * Stop is. The chevron beside it is a menu, and menus only open for a real
 * mouse, so locating it is enough: the caller presses where it sits.
 *
 * @param {object} opts
 * @param {string} opts.bubbleId
 * @param {'locate'|'view'|'build'} [opts.action]
 */
export const planCard = ({ bubbleId, action = 'locate' }) => `(() => {
${HELPERS}
  const pane = __pane();
  const clean = (s) => String(s ?? '').replace(/\\s+/g, ' ').trim();
  const wanted = ${JSON.stringify(String(bubbleId || ''))};
  const action = ${JSON.stringify(String(action || 'locate'))};
  const spot = (el, { right } = {}) => {
    const { x, y, width, height } = el.getBoundingClientRect();
    if (!width || !height) return null;
    return {
      x: Math.round(x + (right ? width - 10 : width / 2)),
      y: Math.round(y + height / 2),
    };
  };
  const named = (el) => {
    const label = clean(el.getAttribute('aria-label') || el.getAttribute('title'));
    const text = clean(el.textContent).replace(/(Ctrl|Alt|Shift|⌘|⌥)[^\\s]*$/i, '').trim();
    return label || text;
  };

  let card = null;
  for (const s of ${list(SELECTORS.message)}) {
    for (const el of pane.querySelectorAll(s)) {
      if (el.getAttribute('data-message-id') === wanted) card = el;
    }
    if (card) break;
  }
  if (!card) {
    const holders = [...pane.querySelectorAll('div,span,p,h1,h2,h3,button')].filter(
      (el) => /^Created Plan$/i.test(clean(el.textContent)) &&
        ![...el.children].some((k) => /^Created Plan$/i.test(clean(k.textContent))),
    );
    card = holders.at(-1)?.closest(${JSON.stringify(SELECTORS.message[0])}) || holders.at(-1);
  }
  if (!card) return { found: false, pressed: false, reason: 'the plan is not on screen' };
  card.scrollIntoView({ block: 'nearest', inline: 'nearest' });

  const buttons = [...card.querySelectorAll('button, [role="button"]')].filter((el) => {
    const rect = el.getBoundingClientRect();
    return rect.width && rect.height;
  });
  const view = buttons.find((el) => /^view plan\\b/i.test(named(el)));
  const build = [...buttons].reverse().find((el) => /^build\\b/i.test(named(el)));
  const menu =
    (build &&
      [...(build.parentElement?.querySelectorAll('button, [role="button"]') || [])].find(
        (el) =>
          el !== build &&
          (el.getAttribute('aria-haspopup') ||
            /model|menu|more/i.test(named(el)) ||
            !named(el)),
      )) ||
    null;

  const at = {
    viewAt: view ? spot(view) : null,
    buildAt: build ? spot(build) : null,
    menuAt: menu ? spot(menu) : build ? spot(build, { right: true }) : null,
  };

  const press = (el, name) => {
    if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') {
      return { found: true, pressed: false, reason: 'no ' + name + ' control on the card', ...at };
    }
    el.click();
    return { found: true, pressed: true, name, at: spot(el), ...at };
  };

  if (action === 'view') return press(view, 'View Plan');
  if (action === 'build') return press(build, 'Build');
  return { found: true, pressed: false, ...at };
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

/** Does this window's folder list include this repo? */
export function showsFolder(facts, folder) {
  if (samePath(facts?.workspace, folder)) return true;
  return (facts?.folders || []).some((f) => samePath(f, folder));
}
