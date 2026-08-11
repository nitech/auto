/**
 * The machine's projects, as Cursor itself sees them.
 *
 * Auto should not invent its own idea of "your projects" — it is a remote
 * control, so the list has to be the desktop's list. Cursor keeps two useful
 * records: the windows open right now, and every workspace ever opened.
 *
 * Nothing here talks to the agent; it is all local state, so it is cheap
 * enough to re-read whenever someone asks.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const APPDATA = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
const CURSOR_USER = join(APPDATA, 'Cursor', 'User');
const GLOBAL_STORAGE = join(CURSOR_USER, 'globalStorage', 'storage.json');
const WORKSPACE_STORAGE = join(CURSOR_USER, 'workspaceStorage');
const CURSOR_PROJECTS = join(homedir(), '.cursor', 'projects');

/** `file:///d%3A/Sevenfold/auto` → `D:\Sevenfold\auto` */
export function fromFileUri(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file:///')) return null;
  let p = decodeURIComponent(uri.slice(8));
  if (/^[A-Za-z]:/.test(p)) {
    p = p[0].toUpperCase() + p.slice(1);
    return p.replace(/\//g, '\\').replace(/\\+$/, '');
  }
  return `/${p}`;
}

/**
 * Cursor stores a project's agent history under a directory named after its
 * path with the separators flattened. Encoding is one-way — `setto-agent` and
 * `setto\agent` collide — so always go path → slug, never the reverse.
 */
export function projectSlug(path) {
  return String(path)
    .replace(/^([A-Za-z]):/, '$1')
    .replace(/[\\/]+/g, '-')
    .replace(/-+$/, '');
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Folders open in a Cursor window right now, including multi-root ones. */
function openFolders() {
  const store = readJson(GLOBAL_STORAGE);
  const backup = store?.backupWorkspaces;
  const out = [];

  for (const f of backup?.folders || []) {
    const p = fromFileUri(f.folderUri);
    if (p) out.push(p);
  }

  // A .code-workspace lists its own roots; the window shows all of them.
  for (const w of backup?.workspaces || []) {
    const configPath = fromFileUri(w.configURIPath);
    if (!configPath || !existsSync(configPath)) continue;
    const config = readJson(configPath);
    const root = configPath.replace(/[\\/][^\\/]+$/, '');
    for (const folder of config?.folders || []) {
      if (!folder?.path) continue;
      const abs = /^[A-Za-z]:|^[\\/]/.test(folder.path)
        ? folder.path
        : join(root, folder.path);
      out.push(abs.replace(/\//g, '\\').replace(/\\+$/, ''));
    }
  }
  return out;
}

/** Every workspace the IDE remembers, newest first. */
function recentFolders() {
  let dirs = [];
  try {
    dirs = readdirSync(WORKSPACE_STORAGE, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return [];
  }

  const seen = [];
  for (const dir of dirs) {
    const full = join(WORKSPACE_STORAGE, dir.name);
    const meta = readJson(join(full, 'workspace.json'));
    const path = fromFileUri(meta?.folder);
    if (!path) continue;
    let usedAt = 0;
    try {
      usedAt = statSync(full).mtimeMs;
    } catch {
      /* keep 0 */
    }
    seen.push({ path, usedAt });
  }
  return seen.sort((a, b) => b.usedAt - a.usedAt);
}

/**
 * How many past desktop chats Cursor has recorded for a folder. Each chat is
 * a directory named after its id, holding `<id>.jsonl` and any subagent runs.
 */
export function desktopChatCount(path) {
  const dir = join(CURSOR_PROJECTS, projectSlug(path), 'agent-transcripts');
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  } catch {
    return 0;
  }
}

const isTemp = (p) => /[\\/]AppData[\\/]Local[\\/]Temp[\\/]/i.test(p);
const key = (p) => p.toLowerCase().replace(/[\\/]+$/, '');

/**
 * The project list: folders open right now first, then everything else the
 * IDE remembers. Folders that no longer exist are dropped — a remote control
 * should not offer buttons that cannot work.
 *
 * @param {string[]} [extraPaths] folders Auto knows about from its own
 *   sessions, so a project stays listed even if the IDE has forgotten it.
 */
export function listProjects(extraPaths = []) {
  const open = new Set(openFolders().filter(Boolean).map(key));
  const byKey = new Map();

  const add = (path, usedAt = 0) => {
    if (!path || isTemp(path) || !existsSync(path)) return;
    const k = key(path);
    const existing = byKey.get(k);
    if (existing) {
      existing.usedAt = Math.max(existing.usedAt, usedAt);
      return;
    }
    byKey.set(k, {
      path,
      name: basename(path) || path,
      open: open.has(k),
      usedAt,
      desktopChats: desktopChatCount(path),
    });
  };

  for (const p of openFolders()) add(p, Date.now());
  for (const { path, usedAt } of recentFolders()) add(path, usedAt);
  for (const p of extraPaths) add(p);

  return [...byKey.values()].sort((a, b) => {
    if (a.open !== b.open) return a.open ? -1 : 1;
    return b.usedAt - a.usedAt;
  });
}
