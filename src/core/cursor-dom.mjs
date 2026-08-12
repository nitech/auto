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
};

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
