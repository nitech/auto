/**
 * Markdown for chat: small, escape-first, dependency-free.
 *
 * Agent prose is untrusted markup, so the source is HTML-escaped before any
 * pattern is applied — formatting can only come from these rules, never from
 * the text itself. Covers what agent replies actually use: fenced code,
 * Mermaid diagrams, math, GitHub callouts, tables, blockquotes, nested and
 * task lists, headings, rules, links and the usual inline emphasis. Diagrams
 * and math are plain containers here — enrich.js paints them in the browser.
 * A chat is not a book: single newlines stay breaks.
 */

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/** Inline markup. Code spans are already gone by now, so `**` inside
    backticks cannot be eaten here. */
function inline(text) {
  return linkify(
    text
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      // Underscore emphasis only at a word's edge, or snake_case would
      // italicise itself — identifiers are everywhere in agent prose.
      .replace(/(^|[\s(])_([^_\n]+?)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
      .replace(
        /\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener">$1</a>',
      )
      // Plans cite repo paths as `[file](src/…)` — not http, so leave the
      // label as code rather than raw brackets on a phone.
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<code>$1</code>'),
  );
}

/**
 * Bare http(s) URLs become links. The text is already HTML-escaped, and
 * markdown `[label](url)` has already become `<a href="…">`, so a match
 * that sits after a quote is already a link and is left alone. Trailing
 * punctuation stays outside the href, or "see https://x.com." includes the
 * period.
 *
 * `attrs` is extra attributes on the tag. The web opens a new tab;
 * Telegram's HTML mode only allows href.
 */
export function linkify(text, attrs = ' target="_blank" rel="noopener"') {
  return String(text ?? '').replace(/(^|[\s>(])(https?:\/\/[^\s<"]+)/g, (all, pre, url) => {
    let core = url;
    let trail = '';
    while (core.length > 8 && /[),.;:!?]$/.test(core)) {
      if (core.endsWith(')') && core.includes('(')) break;
      trail = core.slice(-1) + trail;
      core = core.slice(0, -1);
    }
    if (!/^https?:\/\/./i.test(core)) return all;
    return `${pre}<a href="${core}"${attrs}>${core}</a>${trail}`;
  });
}

/** A task list item wears its checkbox; the box is display-only. */
function taskBox(text) {
  const m = /^\[( |x|X)\]\s+(.*)$/.exec(text);
  if (!m) return text;
  return `<input type="checkbox" disabled${m[1] === ' ' ? '' : ' checked'}> ${m[2]}`;
}

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

function lineIndent(line) {
  return line.replace(/\t/g, '  ').match(/^ */)?.[0].length ?? 0;
}

/** Next non-empty line index, or lines.length. */
function nextNonEmpty(lines, from) {
  let i = from;
  while (i < lines.length && !lines[i].trim()) i += 1;
  return i;
}

/** Indented prose under a list marker belongs to that item, not a new block. */
function isContinuation(line, lastItem) {
  if (!lastItem || LIST_RE.test(line)) return false;
  return lineIndent(line) > lastItem.indent;
}

/** Indentation is the nesting: two spaces (or a tab) per level. */
function listBlock(lines, start) {
  const items = [];
  let i = start;
  while (i < lines.length) {
    if (!lines[i].trim()) {
      const next = nextNonEmpty(lines, i + 1);
      if (next >= lines.length) break;
      if (LIST_RE.test(lines[next]) || (items.length && isContinuation(lines[next], items.at(-1)))) {
        i = next;
        continue;
      }
      break;
    }

    const m = LIST_RE.exec(lines[i]);
    if (m) {
      items.push({
        indent: lineIndent(lines[i]),
        ol: /^\d/.test(m[2]),
        text: m[3],
      });
      i += 1;
      continue;
    }

    if (items.length && isContinuation(lines[i], items.at(-1))) {
      items[items.length - 1].text += `\n${lines[i].trim()}`;
      i += 1;
      continue;
    }

    break;
  }
  const root = { children: [], indent: -1 };
  const stack = [root];
  for (const it of items) {
    const node = { ...it, children: [] };
    while (stack.length > 1 && it.indent <= stack.at(-1).indent) stack.pop();
    stack.at(-1).children.push(node);
    stack.push(node);
  }
  return [renderList(root.children), i];
}

function renderList(nodes) {
  if (!nodes.length) return '';
  const tag = nodes[0].ol ? 'ol' : 'ul';
  const itemHtml = (text) =>
    text
      .split('\n')
      .map((line) => inline(taskBox(line)))
      .join('<br>');
  const body = nodes
    .map((n) => `<li>${itemHtml(n.text)}${renderList(n.children)}</li>`)
    .join('');
  return `<${tag}>${body}</${tag}>`;
}

/** `| a | b |` → `['a', 'b']`, whether or not the edge pipes are there. */
function splitRow(line) {
  let r = line.trim();
  if (r.startsWith('|')) r = r.slice(1);
  if (r.endsWith('|')) r = r.slice(0, -1);
  return r.split('|').map((c) => c.trim());
}

const ALERT_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i;

/** GitHub-style `> [!NOTE]` callouts become asides, not plain quotes. */
function renderAlert(quote) {
  const first = (quote[0] || '').trim();
  const m = ALERT_RE.exec(first);
  if (!m) return null;
  const kind = m[1].toLowerCase();
  const body = [m[2], ...quote.slice(1)].filter((l) => l !== '').join('\n');
  return `<aside class="callout callout-${kind}"><span class="callout-title">${m[1]}</span>${renderBlocks(body)}</aside>`;
}

/** The row of dashes that proves the line above it was a table header. */
function isTableSep(line) {
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

function renderTable(header, aligns, rows) {
  const align = (n) => (aligns[n] ? ` style="text-align:${aligns[n]}"` : '');
  const cells = (row, tag) =>
    row.map((c, n) => `<${tag}${align(n)}>${inline(c)}</${tag}>`).join('');
  const body = rows.map((r) => `<tr>${cells(r, 'td')}</tr>`).join('');
  return `<div class="table-wrap"><table><thead><tr>${cells(header, 'th')}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderBlocks(text) {
  const lines = text.split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // A fenced block set aside earlier comes back untouched by everything.
    if (/^\u0000B\d+\u0000$/.test(line.trim())) {
      out.push(line.trim());
      i += 1;
      continue;
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      // Chat is small: a # heading is a section title, not a poster.
      const lvl = Math.min(h[1].length + 2, 6);
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      i += 1;
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push('<hr>');
      i += 1;
      continue;
    }

    // The source was escaped before markup, so a quote begins with &gt;.
    if (/^\s*&gt;\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*&gt;\s?/, ''));
        i += 1;
      }
      const alert = renderAlert(quote);
      out.push(alert || `<blockquote>${renderBlocks(quote.join('\n'))}</blockquote>`);
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const header = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) =>
        c.startsWith(':') && c.endsWith(':')
          ? 'center'
          : c.endsWith(':')
            ? 'right'
            : c.startsWith(':')
              ? 'left'
              : '',
      );
      // A separator that disagrees with the header is just punctuation.
      if (header.length === aligns.length) {
        const rows = [];
        let j = i + 2;
        while (j < lines.length && lines[j].trim() && lines[j].includes('|')) {
          rows.push(splitRow(lines[j]));
          j += 1;
        }
        out.push(renderTable(header, aligns, rows));
        i = j;
        continue;
      }
    }

    if (LIST_RE.test(line)) {
      const [html, next] = listBlock(lines, i);
      out.push(html);
      i = next;
      continue;
    }

    out.push(`<p>${inline(line)}</p>`);
    i += 1;
  }

  return out.join('');
}

function fencedBlock(lang, code, blocks) {
  const body = code.replace(/\n$/, '');
  const l = String(lang || '').toLowerCase();
  if (l === 'mermaid') {
    blocks.push(`<div class="diagram diagram-mermaid">${body}</div>`);
    return;
  }
  if (l === 'math' || l === 'latex') {
    blocks.push(`<div class="math math-block">${body}</div>`);
    return;
  }
  blocks.push(`<pre><code data-lang="${lang}">${body}</code></pre>`);
}

export function renderMarkdown(src) {
  const blocks = []; // fenced code, set aside whole
  const inlines = []; // code spans, set aside so emphasis cannot reach inside
  const maths = []; // $…$ / $$…$$, set aside before inline emphasis

  let text = esc(src);

  // Fences must start a line — otherwise `` ` ```mermaid ` `` in prose opens one.
  text = text.replace(/^```([^\n`]*)\n([\s\S]*?)^```[ \t]*$/gm, (_, langLine, code) => {
    const lang = String(langLine || '').trim().split(/\s+/)[0];
    fencedBlock(lang, code, blocks);
    return `\u0000B${blocks.length - 1}\u0000`;
  });

  text = text.replace(/`([^`\n]+)`/g, (_, code) => {
    inlines.push(`<code>${code}</code>`);
    return `\u0000I${inlines.length - 1}\u0000`;
  });

  // Block math before inline — $$ must not be read as two $ spans.
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => {
    maths.push(`<div class="math math-block">${tex}</div>`);
    return `\u0000M${maths.length - 1}\u0000`;
  });
  text = text.replace(/\\\[([\s\S]+?)\\\]/g, (_, tex) => {
    maths.push(`<div class="math math-block">${tex}</div>`);
    return `\u0000M${maths.length - 1}\u0000`;
  });
  text = text.replace(/\$([^$\n]+?)\$/g, (_, tex) => {
    maths.push(`<span class="math math-inline">${tex}</span>`);
    return `\u0000M${maths.length - 1}\u0000`;
  });
  text = text.replace(/\\\(([^)]+?)\\\)/g, (_, tex) => {
    maths.push(`<span class="math math-inline">${tex}</span>`);
    return `\u0000M${maths.length - 1}\u0000`;
  });

  return renderBlocks(text)
    .replace(/\u0000I(\d+)\u0000/g, (_, n) => inlines[Number(n)])
    .replace(/\u0000M(\d+)\u0000/g, (_, n) => maths[Number(n)])
    .replace(/\u0000B(\d+)\u0000/g, (_, n) => blocks[Number(n)]);
}
