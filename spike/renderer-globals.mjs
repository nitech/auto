/**
 * What Cursor's renderer offers a caller that is already inside it.
 *
 * A dropdown that ignores a synthetic press is a dead end, so before working
 * harder at the mouse, ask what else is reachable: the `vscode` global that
 * reports the open folder may also run commands, and Cursor hangs its own
 * objects off the window too. A named command beats a menu on every count.
 *
 * Read-only: nothing is called except listing functions.
 *
 * Usage: node spike/renderer-globals.mjs [pattern]
 */
import { CursorCdp } from '../src/core/cursor-cdp.mjs';

const pattern = process.argv[2] || 'model|mode|composer|chat|agent';

const cursor = new CursorCdp();
const window = (await cursor.windows()).find((w) => w.hasComposer);
if (!window) {
  console.log('no Cursor window with a chat box');
  process.exit(1);
}

const PROBE = `((pattern) => {
  const re = new RegExp(pattern, 'i');
  const out = { globals: [], vscode: null, providers: [] };

  // Globals whose names suggest they belong to Cursor rather than the browser.
  for (const key of Object.getOwnPropertyNames(window)) {
    if (!/cursor|composer|ai|ssg|anysphere|vscode|monaco/i.test(key)) continue;
    let value;
    try { value = window[key]; } catch { continue; }
    out.globals.push({ key, type: typeof value, keys: value && typeof value === 'object' ? Object.keys(value).slice(0, 25) : null });
  }

  const describe = (obj, depth = 0) => {
    if (!obj || depth > 1) return null;
    const shape = {};
    for (const key of Object.keys(obj)) {
      let v;
      try { v = obj[key]; } catch { continue; }
      if (typeof v === 'function') shape[key] = \`fn(\${v.length})\`;
      else if (v && typeof v === 'object') shape[key] = depth < 1 ? describe(v, depth + 1) : '{…}';
      else shape[key] = typeof v === 'string' ? v.slice(0, 40) : v;
    }
    return shape;
  };

  try { out.vscode = describe(vscode); } catch (err) { out.vscode = \`no vscode global: \${err.message}\`; }

  // Anything with functions whose names match what we are after.
  for (const key of Object.getOwnPropertyNames(window)) {
    let value;
    try { value = window[key]; } catch { continue; }
    if (!value || typeof value !== 'object') continue;
    const fns = [];
    try {
      for (const name of Object.keys(value)) {
        if (typeof value[name] === 'function' && re.test(name)) fns.push(\`\${name}(\${value[name].length})\`);
      }
    } catch { continue; }
    if (fns.length) out.providers.push({ key, fns: fns.slice(0, 20) });
  }

  return out;
})(${JSON.stringify(pattern)})`;

const found = await cursor.readWindow(window.threadId, PROBE);
console.log('=== globals that look like Cursor\'s\n');
for (const g of found?.globals || []) {
  console.log(`  ${g.key} (${g.type})${g.keys ? `\n      keys: ${g.keys.join(', ')}` : ''}`);
}
console.log('\n=== the vscode global\n');
console.log(JSON.stringify(found?.vscode, null, 2)?.slice(0, 4000));
console.log(`\n=== objects with functions matching /${pattern}/i\n`);
for (const p of found?.providers || []) console.log(`  ${p.key}: ${p.fns.join(', ')}`);

process.exit(0);
