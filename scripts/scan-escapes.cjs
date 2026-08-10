const fs = require('fs');
const src = fs.readFileSync('scripts/debug-server.mjs', 'utf8').split('\n');
let inTpl = false;
for (let i = 0; i < src.length; i++) {
  const line = src[i];
  if (line.includes('const HTML = `')) inTpl = true;
  if (!inTpl) continue;
  // backslash followed by something that is NOT ` $ or \  → mangled by the template literal
  const matches = line.match(/\\[^`$\\]/g);
  if (matches) console.log((i + 1) + ': ' + JSON.stringify(matches) + '  | ' + line.trim().slice(0, 120));
  if (i > 600 && line.trim() === '`;') break;
}
