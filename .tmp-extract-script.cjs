const fs = require('fs');
const src = fs.readFileSync('scripts/debug-server.mjs', 'utf8');
const start = src.indexOf('const HTML');
const tickStart = src.indexOf('`', start);
let i = tickStart + 1, end = -1;
while (i < src.length) {
  if (src[i] === '\\') { i += 2; continue; }
  if (src[i] === '`') { end = i; break; }
  i++;
}
if (end === -1) { console.error('no closing tick found'); process.exit(2); }
const html = src.slice(tickStart + 1, end);
const scripts = [];
const re = /<script>([\s\S]*?)<\/script>/g;
let m;
while ((m = re.exec(html))) scripts.push(m[1]);
fs.writeFileSync('.tmp-page-script.js', scripts.join('\n;\n'));
console.log('scripts found:', scripts.length, 'html len:', html.length);
