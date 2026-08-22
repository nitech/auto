/**
 * Fingerprint css/js URLs in the web shell.
 *
 * iOS Home Screen apps ignore Cache-Control on a named file and keep the
 * stylesheet they first downloaded. A new `?v=` (size + mtime) is a new URL,
 * so they fetch it. The host stamps this on the way out — nothing to bump.
 *
 * Icon URLs are deliberately *not* stamped. WebKit picks a site's icon from
 * the plain declared path, and a query string is a way to be skipped — every
 * site whose icon iOS renders full-bleed declares it clean.
 */
import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = dirname(fileURLToPath(import.meta.url));
const WEB_BUILD = /\.(?:m?js|css)$/;

const ASSET = /(href|src)="(\/(?:vendor\/)?[^"?]+?\.(?:css|js))(?:\?v=[^"]*)?"/g;

export function fileTag(absPath) {
  const st = statSync(absPath);
  return `${st.size.toString(36)}-${Math.round(st.mtimeMs).toString(36)}`;
}

/**
 * @param {string} html
 * @param {(urlPath: string) => string} tagFor
 */
export function stampHtml(html, tagFor) {
  return html.replace(ASSET, (_m, attr, path) => `${attr}="${path}?v=${tagFor(path)}"`);
}

/**
 * Fingerprint of every first-party web asset. Any change under `src/web`
 * is a new build so the PWA can tell its running shell is behind the host.
 *
 * @param {(urlPath: string) => string} tagFor
 */
export function webBuildId(tagFor) {
  const tags = [];
  for (const name of readdirSync(WEB).sort()) {
    if (WEB_BUILD.test(name)) tags.push(`${name}:${tagFor(`/${name}`)}`);
  }
  return createHash('sha1').update(tags.join('\n')).digest('base64url').slice(0, 12);
}

/** Stamp the build id the client compares against `/api/health` and `hello`. */
export function stampBuild(html, build) {
  if (html.includes('name="auto-build"')) {
    return html.replace(/(<meta name="auto-build" content=")[^"]*(")/, `$1${build}$2`);
  }
  return html.replace('</head>', `  <meta name="auto-build" content="${build}" />\n</head>`);
}
