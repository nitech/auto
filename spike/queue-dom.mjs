/**
 * What does Cursor's own queue look like from outside?
 *
 * A message sent into a chat mid-turn is queued by Cursor, and the IDE shows it
 * above the chat box with buttons to edit, send now and delete. To offer the
 * same thing on a phone, Auto has to read that list and press those buttons —
 * so this dumps the shape of it. Reads only: pressing anything here would act on
 * whatever is really queued.
 *
 * With `--scratch` it makes its own specimen: a new chat, a slow question, and a
 * second message on top of it, so there is a real queue to look at without
 * touching anything of yours.
 *
 * Usage: node spike/queue-dom.mjs [threadId | --scratch]
 */
import { CursorCdp } from '../src/core/cursor-cdp.mjs';

const NEW_CHAT = 'New Agent (Ctrl+N) [Alt] Replace Agent';
const SLOW =
  'Write 60 numbered lines, each a full sentence about a different number between 1 and 60. ' +
  'Do not use any tools and do not touch any files.';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const cursor = new CursorCdp();
const asked = process.argv[2];
let wanted = asked && asked !== '--scratch' ? asked : null;

if (asked === '--scratch') {
  const home = (await cursor.windows()).find((w) => w.hasComposer)?.threadId;
  await cursor.press({ threadId: home, name: NEW_CHAT });
  await wait(1500);
  wanted = (await cursor.windows()).find((w) => w.hasComposer && w.threadId !== home)?.threadId;
  console.log('scratch chat', wanted);
  console.log('asked', (await cursor.sendText({ threadId: wanted, text: SLOW })).status);
  await wait(2500);
  // Three of them: one row cannot show how rows are told apart.
  for (const word of ['pineapple', 'wheelbarrow', 'trombone']) {
    console.log(
      `queued ${word}`,
      (await cursor.sendText({ threadId: wanted, text: `Afterwards, say the word ${word}.` }))
        .status,
    );
    await wait(900);
  }
  await wait(1200);
}

if (!wanted) wanted = (await cursor.windows()).find((w) => w.hasComposer)?.threadId;
console.log('thread', wanted);

const DUMP = `(() => {
  const pane = document.querySelector('#workbench\\\\.parts\\\\.auxiliarybar') || document;
  const said = (el) => (el.textContent || '').replace(/\\s+/g, ' ').trim();

  // The list announces itself with a count: "1 Queued", "3 Queued".
  const heads = [...pane.querySelectorAll('div, span, button')].filter((el) =>
    /^\\d+\\s+Queued$/i.test(said(el)) && el.children.length <= 2,
  );

  const shapeOf = (el, depth = 0) => ({
    tag: el.tagName.toLowerCase(),
    cls: String(el.className?.baseVal ?? el.className ?? '').slice(0, 70),
    label: el.getAttribute('aria-label') || el.getAttribute('title') || null,
    role: el.getAttribute('role') || null,
    text: said(el).slice(0, 60),
    kids: depth < 3 ? [...el.children].map((k) => shapeOf(k, depth + 1)) : [...el.children].length,
  });

  const spot = (el) => {
    const { x, y, width, height } = el.getBoundingClientRect();
    return { x: Math.round(x + width / 2), y: Math.round(y + height / 2), width: Math.round(width) };
  };

  return heads.slice(0, 1).map((head) => {
    const holder = head.parentElement;
    return {
      countSays: said(head),
      headCls: String(head.className?.baseVal ?? head.className ?? '').slice(0, 70),
      holderCls: String(holder.className?.baseVal ?? holder.className ?? '').slice(0, 70),
      shape: shapeOf(holder),
      // Every child of the holder that is not the count: one per queued message,
      // if the list is built the obvious way.
      rows: [...holder.children].map((row) => ({
        text: said(row).slice(0, 50),
        icons: [...row.querySelectorAll('[class*="codicon-"]')].map((i) => ({
          name: String(i.className || '').match(/codicon-[a-z-]+/)?.[0] || '?',
          at: spot(i),
        })),
      })),
      // And the whole set of icons in the block, in case rows are not children.
      allIcons: [...holder.querySelectorAll('[class*="codicon-"]')].map((i) => ({
        name: String(i.className || '').match(/codicon-[a-z-]+/)?.[0] || '?',
        at: spot(i),
      })),
    };
  });
})()`;

const seen = await cursor.readWindow(wanted, DUMP);
console.log(JSON.stringify(seen, null, 2));
process.exit(0);
