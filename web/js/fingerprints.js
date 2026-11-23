// Raw fingerprints of files, to align two files of one song to the item: asked only for the item
// playing and the next one, cached by fileHash in memory and in IndexedDB (the newest few
// hundred), so a song played again needs nothing from its sources.

import { srcApi } from './api.js';
import { sources } from './sources.js';
import { idbGet, idbSet, idbDel } from './idb.js';
import { decodeU32 } from './songs.js';

const MEM_MAX = 64;
const STORED_MAX = 400;
const mem = new Map(); // fileHash -> Uint32Array, or null when the source has none
const loading = new Map();

function remember(key, items) {
  mem.delete(key);
  mem.set(key, items);
  if (mem.size > MEM_MAX) mem.delete(mem.keys().next().value);
}

async function store(key, b64) {
  await idbSet(`fp:${key}`, b64);
  const index = ((await idbGet('fp-index')) || []).filter((k) => k !== key);
  index.push(key);
  for (const old of index.splice(0, Math.max(0, index.length - STORED_MAX))) await idbDel(`fp:${old}`);
  await idbSet('fp-index', index);
}

async function loadOne(v) {
  const key = v.fileHash;
  try {
    const kept = await idbGet(`fp:${key}`);
    if (typeof kept === 'string') {
      remember(key, decodeU32(kept));
      return true;
    }
  } catch {
    /* not stored */
  }
  if (v.kept || !sources.isUp(v.sourceId)) return false;
  try {
    const r = await srcApi(v.sourceId).fingerprint(v.trackId, v.fileHash);
    const items = decodeU32(r?.fp);
    if (!items || !items.length) {
      remember(key, null);
      return false;
    }
    remember(key, items);
    store(key, r.fp).catch(() => {});
    return true;
  } catch (err) {
    if (err?.status === 404) remember(key, null); // none on that source, or the file changed
    return false;
  }
}

export const fingerprints = {
  /** The raw items of a file, when already here. */
  cached: (fileHash) => mem.get(fileHash) || null,
  /** Loads the fingerprints of these versions. Resolves true when at least one arrived. */
  async load(versions) {
    const results = await Promise.all(
      versions.map((v) => {
        if (!v || mem.has(v.fileHash)) return false;
        let p = loading.get(v.fileHash);
        if (!p) {
          p = loadOne(v).finally(() => loading.delete(v.fileHash));
          loading.set(v.fileHash, p);
        }
        return p;
      })
    );
    return results.some(Boolean);
  },
};
