/**
 * Locate the Cursor Agent CLI.
 *
 * The `cursor-agent` / `agent` entry points on Windows are PowerShell shims
 * that re-exec a bundled node. We resolve past them to the real
 * `node.exe index.js` so nothing sits between us and the agent's stdio on the
 * protocol path.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const VERSION_DIR_RE = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/;

/** Sortable integer for a version directory name, or null if unrecognised. */
function versionRank(name) {
  const m = VERSION_DIR_RE.exec(name);
  if (!m) return null;
  const [, y, mo, d] = m;
  return Number(`${y}${mo.padStart(2, '0')}${d.padStart(2, '0')}`);
}

/** Base install directory for the Cursor Agent CLI. */
export function agentHome() {
  if (process.env.CURSOR_AGENT_HOME) return process.env.CURSOR_AGENT_HOME;
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || '', 'cursor-agent');
  }
  return join(process.env.HOME || '', '.local', 'share', 'cursor-agent');
}

/**
 * @returns {{ command: string, args: string[], shell: boolean, via: string }}
 * @throws if no usable CLI is found.
 */
export function resolveCursorAgent() {
  const base = agentHome();
  const versions = join(base, 'versions');

  if (existsSync(versions)) {
    // Note: on Windows this directory is hidden; readdirSync sees it fine.
    const ranked = readdirSync(versions)
      .map((name) => ({ name, rank: versionRank(name) }))
      .filter((v) => v.rank !== null)
      .sort((a, b) => a.rank - b.rank);

    for (const { name } of ranked.reverse()) {
      const nodeBin = join(versions, name, process.platform === 'win32' ? 'node.exe' : 'node');
      const index = join(versions, name, 'index.js');
      if (existsSync(nodeBin) && existsSync(index)) {
        return { command: nodeBin, args: [index], shell: false, via: name };
      }
    }
  }

  const shim = join(base, process.platform === 'win32' ? 'cursor-agent.cmd' : 'cursor-agent');
  if (existsSync(shim)) {
    return { command: shim, args: [], shell: process.platform === 'win32', via: 'shim' };
  }

  throw new Error(
    `Cursor Agent CLI not found under ${base}. Install it with:\n` +
      `  irm 'https://cursor.com/install?win32=true' | iex\n` +
      `then run: cursor-agent login`,
  );
}
