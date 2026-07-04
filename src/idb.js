/* IndexedDB backup mirror for localStorage (browser-only). */

import { SAVE_KEY, LB_KEY } from './logic/config.js';

/* ================================================================
   Storage mirror: localStorage is the source of truth, IndexedDB is a
   backup that survives the odd cases where an installed PWA loses its
   localStorage (iOS eviction, storage pressure). Lazy, promise-wrapped,
   and it NEVER rejects: any failure resolves null and the game stays
   localStorage-only. Inert without indexedDB (Node tests import this file).
   ================================================================ */

const idb = (() => {
  const DB_NAME = 'lizard-blockdoku'; /* shared origin: keys carry the channel */
  const STORE = 'kv';
  let dbPromise = null;
  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      try {
        if (typeof indexedDB === 'undefined') { resolve(null); return; }
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch (err) { resolve(null); }
    });
    return dbPromise;
  }
  function withStore(mode, fn) {
    return open().then((db) => new Promise((resolve) => {
      if (!db) { resolve(null); return; }
      try {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req ? req.result : null);
        tx.onerror = () => resolve(null);
        tx.onabort = () => resolve(null);
      } catch (err) { resolve(null); }
    }));
  }
  return {
    get: (key) => withStore('readonly', (s) => s.get(key)),
    put: (key, value) => withStore('readwrite', (s) => s.put(value, key)),
    del: (key) => withStore('readwrite', (s) => s.delete(key)),
  };
})();

const MIRROR_KEYS = [SAVE_KEY, LB_KEY, LB_KEY + '-cache'];

/* Boot fallback: fill any localStorage gap from the IDB backup. */
async function preloadFromIdb() {
  for (const key of MIRROR_KEYS) {
    try {
      if (localStorage.getItem(key) !== null) continue;
      const v = await idb.get(key);
      if (typeof v === 'string' && localStorage.getItem(key) === null) {
        localStorage.setItem(key, v);
      }
    } catch (err) { /* localStorage-only mode; play on */ }
  }
}

/* Boot catch-up: the last fire-and-forget put of a session can die with the
   page, so re-mirror everything present at every boot. */
function mirrorAllToIdb() {
  for (const key of MIRROR_KEYS) {
    try {
      const v = localStorage.getItem(key);
      if (v !== null) idb.put(key, v);
    } catch (err) { /* ignore */ }
  }
}

export { idb, MIRROR_KEYS, preloadFromIdb, mirrorAllToIdb };
