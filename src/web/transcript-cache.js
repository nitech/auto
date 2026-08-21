/**
 * Client-side transcript cache.
 *
 * The host remains the source of truth. This keeps the last N records so a
 * reload (or switching back to a chat) can paint immediately and ask only for
 * anything newer than lastSeq — the same catch-up path a dropped socket uses.
 *
 * Memory is for session switches within this tab; IndexedDB is for a hard
 * reload. Either may be missing; both are best-effort.
 */

/** Must stay in step with the host's REPLAY_LIMIT in src/server/index.mjs. */
export const CACHE_LIMIT = 1200;

const DB_NAME = 'auto.transcripts';
const DB_VERSION = 1;
const STORE = 'sessions';
const MAX_SESSIONS = 12;

/** @type {Map<string, CacheSnap>} */
const memory = new Map();

/**
 * @typedef {{
 *   records: object[],
 *   head?: object[],
 *   lastSeq: number,
 *   earlier: number,
 *   omitted?: number,
 *   savedAt: number,
 * }} CacheSnap
 */

/** Keep only the newest `limit` records (conversation is read from its end). */
export function trimTail(records, limit = CACHE_LIMIT) {
  if (!Array.isArray(records) || records.length <= limit) {
    return Array.isArray(records) ? records : [];
  }
  return records.slice(records.length - limit);
}

/**
 * Merge two record lists by seq. Later list wins on collision.
 * Records without a seq are dropped — they cannot catch up.
 */
export function mergeRecords(base, incoming) {
  const map = new Map();
  for (const r of base || []) {
    if (r && typeof r.seq === 'number') map.set(r.seq, r);
  }
  for (const r of incoming || []) {
    if (r && typeof r.seq === 'number') map.set(r.seq, r);
  }
  return [...map.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * Append one record onto a live list, trimming the head when over the limit.
 * Returns { records, earlierDelta } so the caller can bump its "earlier" count.
 */
export function appendLive(records, rec, limit = CACHE_LIMIT) {
  const list = Array.isArray(records) ? records.slice() : [];
  if (!rec || typeof rec.seq !== 'number') return { records: list, earlierDelta: 0 };

  const last = list[list.length - 1];
  if (last && last.seq === rec.seq) {
    list[list.length - 1] = rec;
    return { records: list, earlierDelta: 0 };
  }
  if (last && last.seq > rec.seq) {
    const merged = mergeRecords(list, [rec]);
    const before = merged.length;
    const trimmed = trimTail(merged, limit);
    return { records: trimmed, earlierDelta: before - trimmed.length };
  }

  list.push(rec);
  if (list.length <= limit) return { records: list, earlierDelta: 0 };
  const overflow = list.length - limit;
  return { records: list.slice(overflow), earlierDelta: overflow };
}

/** Build a cache snapshot from a record list (and how many sit before it). */
export function makeSnap(records, earlier = 0, head = [], limit = CACHE_LIMIT) {
  const pinned = Array.isArray(head) ? head.filter((r) => r && typeof r.seq === 'number') : [];
  const headEnd = pinned.length ? pinned.at(-1).seq : 0;
  const body = (Array.isArray(records) ? records : []).filter(
    (r) => r && typeof r.seq === 'number' && r.seq > headEnd,
  );
  const before = body.length;
  const trimmed = trimTail(body, limit);
  const dropped = before - trimmed.length;
  const lastSeq = trimmed.length
    ? trimmed[trimmed.length - 1].seq
    : headEnd || 0;
  const omittedBase = Math.max(0, earlier || 0);
  return {
    head: pinned,
    records: trimmed,
    lastSeq: typeof lastSeq === 'number' ? lastSeq : 0,
    // Prefer omitted (gap after head) when we have a pinned opening.
    earlier: omittedBase + dropped,
    omitted: pinned.length ? omittedBase + dropped : 0,
    savedAt: Date.now(),
  };
}

export function memoryGet(sessionId) {
  if (!sessionId) return null;
  const snap = memory.get(sessionId);
  return snap || null;
}

export function memoryPut(sessionId, snap) {
  if (!sessionId || !snap) return;
  // Re-insert so insertion order tracks LRU.
  memory.delete(sessionId);
  memory.set(sessionId, {
    records: snap.records || [],
    head: snap.head || [],
    lastSeq: snap.lastSeq || 0,
    earlier: snap.earlier || 0,
    omitted: snap.omitted || 0,
    savedAt: snap.savedAt || Date.now(),
  });
  while (memory.size > MAX_SESSIONS) {
    const oldest = memory.keys().next().value;
    memory.delete(oldest);
  }
}

export function memoryClear(sessionId) {
  if (sessionId) memory.delete(sessionId);
  else memory.clear();
}

function idbAvailable() {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

function openDb() {
  return new Promise((resolve, reject) => {
    if (!idbAvailable()) {
      reject(new Error('indexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error || new Error('indexedDB open failed'));
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'sessionId' });
      }
    };
  });
}

function idbReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('indexedDB request failed'));
  });
}

/** Read a session's cached snap from disk, or null. */
export async function diskGet(sessionId) {
  if (!sessionId || !idbAvailable()) return null;
  try {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, 'readonly');
      const row = await idbReq(tx.objectStore(STORE).get(sessionId));
      if (!row || (!row.records?.length && !row.head?.length)) return null;
      return {
        records: row.records,
        head: row.head || [],
        lastSeq: row.lastSeq || 0,
        earlier: row.earlier || 0,
        omitted: row.omitted || 0,
        savedAt: row.savedAt || 0,
      };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** Persist a snap; drop the oldest sessions when over the cap. */
export async function diskPut(sessionId, snap) {
  if (!sessionId || !snap || !idbAvailable()) return;
  try {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      await idbReq(
        store.put({
          sessionId,
          records: snap.records || [],
          head: snap.head || [],
          lastSeq: snap.lastSeq || 0,
          earlier: snap.earlier || 0,
          omitted: snap.omitted || 0,
          savedAt: snap.savedAt || Date.now(),
        }),
      );
      const all = await idbReq(store.getAll());
      if (Array.isArray(all) && all.length > MAX_SESSIONS) {
        all
          .slice()
          .sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0))
          .slice(0, all.length - MAX_SESSIONS)
          .forEach((row) => store.delete(row.sessionId));
      }
      await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('aborted'));
      });
    } finally {
      db.close();
    }
  } catch {
    /* quota / private mode — memory still helps within the tab */
  }
}

export async function diskClear(sessionId) {
  if (!sessionId || !idbAvailable()) return;
  try {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(sessionId);
      await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  } catch {
    /* ignore */
  }
}

/** Memory first, then IndexedDB. Warms memory on a disk hit. */
export async function loadCache(sessionId) {
  if (!sessionId) return null;
  const warm = memoryGet(sessionId);
  if (warm?.records?.length || warm?.head?.length) return warm;
  const cold = await diskGet(sessionId);
  if (cold?.records?.length || cold?.head?.length) {
    memoryPut(sessionId, cold);
    return cold;
  }
  return null;
}

/** Write memory immediately; schedule disk (caller may also flush). */
export function saveCache(sessionId, records, earlier = 0, head = []) {
  if (!sessionId) return null;
  const snap = makeSnap(records, earlier, head);
  if (!snap.records.length && !snap.head.length) return snap;
  memoryPut(sessionId, snap);
  return snap;
}

/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const diskTimers = new Map();

export function scheduleDiskSave(sessionId, snap, delayMs = 800) {
  if (!sessionId || !(snap?.records?.length || snap?.head?.length)) return;
  const prev = diskTimers.get(sessionId);
  if (prev) clearTimeout(prev);
  diskTimers.set(
    sessionId,
    setTimeout(() => {
      diskTimers.delete(sessionId);
      diskPut(sessionId, snap);
    }, delayMs),
  );
}

/** Flush any pending disk write for a session (or all). */
export function flushDiskSave(sessionId) {
  const ids = sessionId ? [sessionId] : [...diskTimers.keys()];
  for (const id of ids) {
    const t = diskTimers.get(id);
    if (t) clearTimeout(t);
    diskTimers.delete(id);
    const snap = memoryGet(id);
    if (snap?.records?.length || snap?.head?.length) diskPut(id, snap);
  }
}
