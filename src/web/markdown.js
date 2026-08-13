/**
 * Markdown for chat: small, escape-first, dependency-free.
 *
 * Agent prose is untrusted markup, so the source is HTML-escaped before any
 * pattern is applied — formatting can only come from these rules, never from
 * the text itself. Covers what agent replies actually use: fenced code,
 * tables, blockquotes, nested and task lists, headings, rules, links and the
 * usual inline emphasis. A chat is not a book: single newlines stay breaks.
 */

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/** Inline markup. Code spans are already gone by now, so `**` inside
    backticks cannot be eaten here. */
function inline(text) {
  return (
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
  );
}

/** A task list item wears its checkbox; the box is display-only. */
function taskBox(text) {
  const m = /^\[( |x|X)\]\s+(.*)$/.exec(text);
  if (!m) return text;
  return `<input type="checkbox" disabled${m[1] === ' ' ? '' : ' checked'}> ${m[2]}`;
}

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

/** Indentation is the nesting: two spaces (or a tab) per level. */
function listBlock(lines, start) {
  const items = [];
  let i = start;
  while (i < lines.length) {
    const m = LIST_RE.exec(lines[i]);
    if (!m) break;
    items.push({
      indent: m[1].replace(/\t/g, '  ').length,
      ol: /^\d/.test(m[2]),
      text: m[3],
    });
    i += 1;
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
  const body = nodes
    .map((n) => `<li>${inline(taskBox(n.text))}${renderList(n.children)}</li>`)
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
  return `<table><thead><tr>${cells(header, 'th')}</tr></thead><tbody>${body}</tbody></table>`;
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
      out.push(`<blockquote>${renderBlocks(quote.join('\n'))}</blockquote>`);
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

export function renderMarkdown(src) {
  const blocks = []; // fenced code, set aside whole
  const inlines = []; // code spans, set aside so emphasis cannot reach inside

  let text = esc(src);

  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(`<pre><code data-lang="${lang}">${code.replace(/\n$/, '')}</code></pre>`);
    return `\u0000B${blocks.length - 1}\u0000`;
  });

  text = text.replace(/`([^`\n]+)`/g, (_, code) => {
    inlines.push(`<code>${code}</code>`);
    return `\u0000I${inlines.length - 1}\u0000`;
  });

  return renderBlocks(text)
    .replace(/\u0000I(\d+)\u0000/g, (_, n) => inlines[Number(n)])
    .replace(/\u0000B(\d+)\u0000/g, (_, n) => blocks[Number(n)]);
}
