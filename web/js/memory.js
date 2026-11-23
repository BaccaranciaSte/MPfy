// "Memoria": what this device keeps, never anything on a source. In the app: the downloads and
// the cache (the app's stream cache plus the covers the service worker keeps); in a browser only
// the covers. The service worker answers { type: 'cover-cache-size' } with { bytes, entries } and
// { type: 'clear-covers' } by dropping them.

import { native, nativeJson, nativeCall, onNative, bridgeVersion } from './native.js';
import { downloads } from './downloads.js';

const COVERS = 'mpfy-covers-v1';
let storage = null; // { downloadsBytes, downloadsCount, cacheBytes } from the app
let covers = { bytes: 0, entries: 0 };
const listeners = new Set();

function emit() {
  for (const fn of listeners) {
    try {
      fn();
    } catch (err) {
      console.error('memory listener', err);
    }
  }
}

function setStorage(m) {
  if (!m || typeof m !== 'object') return;
  storage = {
    downloadsBytes: Number(m.downloadsBytes) || 0,
    downloadsCount: Number(m.downloadsCount) || 0,
    cacheBytes: Number(m.cacheBytes) || 0,
  };
}

/** Asks the service worker; without one, null. */
function askWorker(msg, ms = 3000) {
  const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker?.controller : null;
  if (!sw || typeof MessageChannel === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const t = setTimeout(() => resolve(null), ms);
    ch.port1.onmessage = (e) => {
      clearTimeout(t);
      resolve(e.data || null);
    };
    sw.postMessage(msg, [ch.port2]);
  });
}

/** The covers cache read from the page itself (no service worker in control). */
async function coversHere() {
  if (typeof caches === 'undefined' || !(await caches.has(COVERS))) return { bytes: 0, entries: 0 };
  const c = await caches.open(COVERS);
  const keys = await c.keys();
  let bytes = 0;
  for (const k of keys) {
    const r = await c.match(k);
    bytes += Number(r?.headers.get('X-MPfy-Bytes')) || Number(r?.headers.get('Content-Length')) || 0;
  }
  return { bytes, entries: keys.length };
}

export const memory = {
  /** Downloads exist here (the app). */
  get hasDownloads() {
    return !!native;
  },
  get downloadsBytes() {
    return storage ? storage.downloadsBytes : downloads.space().bytes;
  },
  get downloadsCount() {
    return storage ? storage.downloadsCount : downloads.count;
  },
  /** The app's stream cache plus the covers. */
  get cacheBytes() {
    return (storage?.cacheBytes || 0) + covers.bytes;
  },
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  async refresh() {
    if (bridgeVersion() >= 3) setStorage(nativeJson('getStorage'));
    try {
      const r = (await askWorker({ type: 'cover-cache-size' })) || (await coversHere());
      covers = { bytes: Number(r?.bytes) || 0, entries: Number(r?.entries) || 0 };
    } catch {
      /* the size stays as it was */
    }
    emit();
  },
  /** "Elimina download": every download on this device (the sources keep the songs). */
  async clearDownloads() {
    downloads.clearAll();
    await memory.refresh();
  },
  /** "Svuota cache": the stream cache (but the songs playing now and next) and the covers. */
  async clearCache() {
    if (bridgeVersion() >= 3) nativeCall('clearCache');
    const r = await askWorker({ type: 'clear-covers' });
    if (!r && typeof caches !== 'undefined') await caches.delete(COVERS).catch(() => false);
    await memory.refresh();
  },
};

onNative('storage', (m) => {
  setStorage(m);
  emit();
});
downloads.subscribe(() => {
  if (!storage) emit();
});
