// Minimal key-value store on IndexedDB (falls back to localStorage), used to cache the library
// so the app opens instantly and keeps working when the sources are out of reach.

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('mpfy', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('indexedDB blocked'));
    });
  }
  return dbPromise;
}

function tx(mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction('kv', mode);
        const req = fn(t.objectStore('kv'));
        t.oncomplete = () => resolve(req?.result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

export async function idbGet(key) {
  try {
    return await tx('readonly', (s) => s.get(key));
  } catch {
    try {
      const v = localStorage.getItem(`mpfy.kv.${key}`);
      return v ? JSON.parse(v) : undefined;
    } catch {
      return undefined;
    }
  }
}

export async function idbSet(key, value) {
  try {
    await tx('readwrite', (s) => s.put(value, key));
  } catch {
    try {
      localStorage.setItem(`mpfy.kv.${key}`, JSON.stringify(value));
    } catch {
      /* no persistent storage available: the cache is only an optimization */
    }
  }
}

/** The keys that start with prefix (the store's own key order: one range read, no values). */
export async function idbKeys(prefix) {
  try {
    const keys = await tx('readonly', (s) => s.getAllKeys(IDBKeyRange.bound(prefix, `${prefix}\uffff`)));
    return Array.isArray(keys) ? keys.map(String) : [];
  } catch {
    try {
      const out = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(`mpfy.kv.${prefix}`)) out.push(k.slice('mpfy.kv.'.length));
      }
      return out;
    } catch {
      return [];
    }
  }
}

export async function idbDel(key) {
  try {
    await tx('readwrite', (s) => s.delete(key));
  } catch {
    try {
      localStorage.removeItem(`mpfy.kv.${key}`);
    } catch {
      /* nothing to remove */
    }
  }
}

/**
 * A transaction on the store: { t, s } (the IDBTransaction and its object store), in mode
 * 'readonly' or 'readwrite'. Where IndexedDB cannot be opened, one over localStorage with the same
 * calls (get, put, delete, getAll and getAllKeys over a key range, abort, oncomplete, onabort,
 * onerror): its writes are kept until it completes, and an abort drops them. A value that does
 * not fit there is left out (the cache is only an optimization).
 */
export async function idbTx(mode) {
  try {
    const db = await openDb();
    const t = db.transaction('kv', mode);
    return { t, s: t.objectStore('kv') };
  } catch {
    return lsTx();
  }
}

/** The key range of every key that starts with prefix. */
export const idbPrefix = (prefix) => (typeof IDBKeyRange !== 'undefined' ? IDBKeyRange.bound(prefix, `${prefix}\uffff`) : { lower: prefix, upper: `${prefix}\uffff` });

function lsTx() {
  const P = 'mpfy.kv.';
  const writes = new Map(); // key -> value, or undefined for a delete
  let open = 0;
  let done = false;
  const t = { oncomplete: null, onabort: null, onerror: null, error: null };
  const inRange = (k, r) => !r || (k >= r.lower && k <= r.upper);
  const read = (k) => {
    if (writes.has(k)) return writes.get(k);
    try {
      const v = localStorage.getItem(P + k);
      return v ? JSON.parse(v) : undefined;
    } catch {
      return undefined;
    }
  };
  const keys = (r) => {
    const out = new Set();
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(P) && inRange(k.slice(P.length), r)) out.add(k.slice(P.length));
      }
    } catch {
      /* nothing readable */
    }
    for (const [k, v] of writes) {
      if (!inRange(k, r)) continue;
      if (v === undefined) out.delete(k);
      else out.add(k);
    }
    return [...out].sort();
  };
  const finish = () => {
    if (done || open > 0) return;
    done = true;
    for (const [k, v] of writes) {
      try {
        if (v === undefined) localStorage.removeItem(P + k);
        else localStorage.setItem(P + k, JSON.stringify(v));
      } catch {
        /* does not fit: left out */
      }
    }
    if (t.oncomplete) t.oncomplete();
  };
  const request = (fn) => {
    const req = { result: undefined, onsuccess: null, onerror: null };
    open++;
    Promise.resolve().then(() => {
      if (done) return;
      req.result = fn();
      open--;
      if (req.onsuccess) req.onsuccess();
      setTimeout(finish, 0);
    });
    return req;
  };
  t.abort = () => {
    if (done) return;
    done = true;
    writes.clear();
    if (t.onabort) t.onabort();
  };
  const s = {
    get: (k) => request(() => read(k)),
    put: (v, k) => request(() => writes.set(k, v)),
    delete: (k) => request(() => writes.set(k, undefined)),
    getAll: (r) => request(() => keys(r).map(read)),
    getAllKeys: (r) => request(() => keys(r)),
  };
  setTimeout(finish, 0);
  return { t, s };
}
