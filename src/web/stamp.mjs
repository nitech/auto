/**
 * Fingerprint css/js URLs in the web shell.
 *
 * iOS Home Screen apps ignore Cache-Control on a named file and keep the
 * stylesheet they first downloaded. A new `?v=` (size + mtime) is a new URL,
 * so they fetch it. The host stamps this on the way out — nothing to bump.
 */
import { statSync } from 'node:fs';

const ASSET = /(href|src)="(\/[^"?]+?\.(?:css|js))(?:\?v=[^"]*)?"/g;

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
