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
import { chatCountsByWorkspace } from './desktop-chats.mjs';

const APPDATA = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
const CURSOR_USER = join(APPDATA, 'Cursor', 'User');
const GLOBAL_STORAGE = join(CURSOR_USER, 'globalStorage', 'storage.json');
const WORKSPACE_STORAGE = join(CURSOR_USER, 'workspaceStorage');

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

/**
 * Every workspace the IDE remembers, newest first. The directory name is the
 * workspace id the desktop files its chats under, so carry it along.
 */
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
    seen.push({ path, usedAt, workspaceId: dir.name });
  }
  return seen.sort((a, b) => b.usedAt - a.usedAt);
}

/** The desktop's workspace id for a folder, if it has ever opened it. */
export function workspaceIdFor(path) {
  const k = key(path);
  return recentFolders().find((w) => key(w.path) === k)?.workspaceId || null;
}

/**
 * Which folder each workspace id belongs to — the other direction, for
 * turning the desktop's chats back into projects you recognise.
 *
 * @returns {Map<string, string>} workspace id → folder path
 */
export function foldersByWorkspaceId() {
  const out = new Map();
  for (const { path, workspaceId } of recentFolders()) {
    if (workspaceId && !out.has(workspaceId)) out.set(workspaceId, path);
  }
  return out;
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
  const counts = chatCountsByWorkspace();
  const byKey = new Map();

  const add = (path, usedAt = 0, workspaceId = null) => {
    if (!path || isTemp(path) || !existsSync(path)) return;
    const k = key(path);
    const existing = byKey.get(k);
    if (existing) {
      existing.usedAt = Math.max(existing.usedAt, usedAt);
      if (!existing.workspaceId && workspaceId) {
        existing.workspaceId = workspaceId;
        existing.desktopChats = counts.get(workspaceId) || 0;
      }
      return;
    }
    byKey.set(k, {
      path,
      name: basename(path) || path,
      open: open.has(k),
      usedAt,
      workspaceId,
      desktopChats: workspaceId ? counts.get(workspaceId) || 0 : 0,
    });
  };

  for (const p of openFolders()) add(p, Date.now());
  for (const { path, usedAt, workspaceId } of recentFolders()) add(path, usedAt, workspaceId);
  for (const p of extraPaths) add(p);

  return [...byKey.values()].sort((a, b) => {
    if (a.open !== b.open) return a.open ? -1 : 1;
    return b.usedAt - a.usedAt;
  });
}
