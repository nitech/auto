/**
 * Line diff for the diff blocks ACP attaches to edit tool calls.
 *
 * A plain LCS is fine for the sizes involved, but it is quadratic, so very
 * large edits fall back to a summary instead of hanging the tab.
 */

const MAX_CELLS = 4_000_000;

/**
 * @returns {Array<{ type: 'ctx'|'add'|'del', text: string }>}
 */
/** Empty text is zero lines, and a trailing newline is not a final blank line. */
function toLines(text) {
  const s = String(text ?? '');
  if (!s) return [];
  return s.replace(/\n$/, '').split('\n');
}

export function lineDiff(oldText, newText) {
  const a = toLines(oldText);
  const b = toLines(newText);

  if (a.length * b.length > MAX_CELLS) {
    return [
      { type: 'del', text: `… ${a.length} lines replaced` },
      { type: 'add', text: `… with ${b.length} lines` },
    ];
  }

  // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:]
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: 'ctx', text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ type: 'del', text: a[i++] });
    } else {
      out.push({ type: 'add', text: b[j++] });
    }
  }
  while (i < a.length) out.push({ type: 'del', text: a[i++] });
  while (j < b.length) out.push({ type: 'add', text: b[j++] });

  return out;
}

/** Drop long stretches of unchanged lines, keeping `pad` lines of context. */
export function collapseContext(rows, pad = 3) {
  const keep = new Array(rows.length).fill(false);
  rows.forEach((r, idx) => {
    if (r.type === 'ctx') return;
    for (let k = Math.max(0, idx - pad); k <= Math.min(rows.length - 1, idx + pad); k++) {
      keep[k] = true;
    }
  });

  const out = [];
  let skipped = 0;
  rows.forEach((r, idx) => {
    if (keep[idx]) {
      if (skipped) {
        out.push({ type: 'gap', text: `⋯ ${skipped} unchanged line${skipped === 1 ? '' : 's'}` });
        skipped = 0;
      }
      out.push(r);
    } else {
      skipped++;
    }
  });
  if (skipped) out.push({ type: 'gap', text: `⋯ ${skipped} unchanged lines` });
  return out;
}

export function diffStats(rows) {
  let added = 0;
  let removed = 0;
  for (const r of rows) {
    if (r.type === 'add') added++;
    else if (r.type === 'del') removed++;
  }
  return { added, removed };
}
