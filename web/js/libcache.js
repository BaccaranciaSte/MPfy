// The library cache in IndexedDB (database mpfy, store kv), in chunks, so that a change of a few
// songs rewrites the records it touched and a start reads everything in one range:
//   L1:<src>:meta        { k: 'meta', schema: 1, gen, writer, version, epoch, userVersion,
//                          userEpoch, etag, you, source, chunks: [n in order], likeChunks: [n],
//                          playlists: [ids in order] }
//   L1:<src>:t:<n>       { k: 't', n, tracks: [at most 1,000, in the source's order] }
//   L1:<src>:c           { k: 'c', track, album } the shared custom covers
//   L1:<src>:p:<id>      { k: 'p', playlist }
//   L1:<src>:l:<n>       { k: 'l', n, likes: [[id, at]] at most 5,000, oldest first }
//   L1:<src>:r           { k: 'r', recents }
//   L1:<src>:pc          { k: 'pc', covers } the playlist covers
//   L1:m:e:<a>:<b>:<n>   { k: 'e', n, edges: [[keyA, keyB, ber]], compared: [keys] } the grouping
//                        cache of sources a and b (a before b), at most 2,000 of each a chunk
// A change writes meta and every record it touched in one readwrite transaction, the writes one
// after the other. Only what a source confirmed is kept, never a change still on its way.
// Two tabs: each transaction reads meta first. When another tab wrote it since this tab last
// wrote or read it, this one stops, and in a new transaction writes its whole state in a fresh
// layout (every older record of that source deleted in the same transaction), so a layout is
// never mixed. The grouping cache of a pair is written in the transactions of its first source,
// under the same check.

import { idbTx, idbPrefix, idbGet, idbDel } from './idb.js';

const TRACKS_PER_CHUNK = 1000;
const LIKES_PER_CHUNK = 5000;
const EDGES_PER_CHUNK = 2000;

const key = {
  meta: (src) => `L1:${src}:meta`,
  t: (src, n) => `L1:${src}:t:${n}`,
  c: (src) => `L1:${src}:c`,
  p: (src, id) => `L1:${src}:p:${id}`,
  l: (src, n) => `L1:${src}:l:${n}`,
  r: (src) => `L1:${src}:r`,
  pc: (src) => `L1:${src}:pc`,
  e: (a, b, n) => `L1:m:e:${a}:${b}:${n}`,
};

/** Waits for one request of a transaction. */
const done = (rq) =>
  new Promise((resolve, reject) => {
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });

const newLayout = () => ({ chunks: [], ids: new Map(), of: new Map(), next: 0, likeChunks: [], likeIds: new Map(), likeOf: new Map(), likeNext: 0, playlists: [], edges: new Map(), broken: false });
const newEdgeLayout = () => ({ chunks: new Map(), edgeOf: new Map(), cmpOf: new Map(), next: 0, dirty: new Set(), whole: false });

/** What a change touched: the store adds to it, a write takes it. */
export const newTouched = () => ({ all: false, userAll: false, tracks: new Set(), removed: new Set(), covers: false, playlists: new Set(), likesAdded: new Set(), likesRemoved: new Set(), recents: false, plCovers: false, meta: false });

function mergeTouched(a, b) {
  a.all = a.all || b.all;
  a.userAll = a.userAll || b.userAll;
  for (const id of b.tracks) {
    a.tracks.add(id);
    a.removed.delete(id);
  }
  for (const id of b.removed) {
    a.removed.add(id);
    a.tracks.delete(id);
  }
  a.covers = a.covers || b.covers;
  for (const id of b.playlists) a.playlists.add(id);
  for (const id of b.likesAdded) {
    a.likesAdded.add(id);
    a.likesRemoved.delete(id);
  }
  for (const id of b.likesRemoved) {
    a.likesRemoved.add(id);
    a.likesAdded.delete(id);
  }
  a.recents = a.recents || b.recents;
  a.plCovers = a.plCovers || b.plCovers;
  a.meta = true;
  return a;
}

/**
 * The cache of one page. tab: this tab's id (random). Each save takes the store's state for that
 * source through state(src): { version, epoch, userVersion, userEpoch, etag, you, source, tracks
 * (Map id -> track, the source's order), trackCovers, albumCovers, playlists (Maps), likes (Map
 * id -> at, oldest first), recents, playlistCovers (Map) }, and the grouping cache of a pair
 * through pair(a, b): { edges, compared }.
 */
export function createLibCache({ state, pair, tab = Math.random().toString(36).slice(2, 12) }) {
  const layouts = new Map(); // src -> layout of its records
  const gens = new Map(); // src -> the gen this tab last wrote or read
  const waiting = new Map(); // src -> touched, waiting for the write in progress
  const writing = new Map(); // src -> the write in progress
  const stats = { transactions: 0, puts: 0, deletes: 0, aborts: 0, rebuilds: 0 };

  const layoutOf = (src) => {
    let L = layouts.get(src);
    if (!L) layouts.set(src, (L = newLayout()));
    return L;
  };

  // ---- the layout follows the state

  /** Tracks and likes laid again from scratch, in chunks in order; every old chunk number freed. */
  function relayTracks(L, st) {
    L.chunks = [];
    L.ids = new Map();
    L.of = new Map();
    L.next = 0;
    let cur = null;
    for (const id of st.tracks.keys()) {
      if (!cur || cur.length >= TRACKS_PER_CHUNK) {
        const n = L.next++;
        L.chunks.push(n);
        L.ids.set(n, (cur = []));
      }
      cur.push(id);
      L.of.set(id, L.chunks[L.chunks.length - 1]);
    }
  }

  function relayLikes(L, st) {
    L.likeChunks = [];
    L.likeIds = new Map();
    L.likeOf = new Map();
    L.likeNext = 0;
    let cur = null;
    for (const id of st.likes.keys()) {
      if (!cur || cur.length >= LIKES_PER_CHUNK) {
        const n = L.likeNext++;
        L.likeChunks.push(n);
        L.likeIds.set(n, (cur = []));
      }
      cur.push(id);
      L.likeOf.set(id, L.likeChunks[L.likeChunks.length - 1]);
    }
  }

  /**
   * Chunked list: an id added goes into the last chunk until it is full; one removed leaves its
   * chunk, and two neighbours under half a chunk together become one. Returns the chunks to
   * write and the chunks to delete.
   */
  function patchChunks(order, ids, of, nextRef, added, removed, size) {
    const dirty = new Set();
    const gone = new Set();
    for (const id of removed) {
      const n = of.get(id);
      if (n === undefined) continue;
      of.delete(id);
      const list = ids.get(n);
      const i = list.indexOf(id);
      if (i >= 0) list.splice(i, 1);
      dirty.add(n);
    }
    for (const id of added) {
      if (of.has(id)) {
        dirty.add(of.get(id));
        continue;
      }
      let n = order[order.length - 1];
      if (n === undefined || ids.get(n).length >= size) {
        n = nextRef.next++;
        order.push(n);
        ids.set(n, []);
      }
      ids.get(n).push(id);
      of.set(id, n);
      dirty.add(n);
    }
    for (let i = 0; i < order.length; i++) {
      const n = order[i];
      if (!dirty.has(n)) continue;
      const list = ids.get(n);
      const m = order[i + 1];
      if (m !== undefined && list.length + ids.get(m).length < size / 2) {
        for (const id of ids.get(m)) {
          list.push(id);
          of.set(id, n);
        }
        ids.delete(m);
        order.splice(i + 1, 1);
        dirty.delete(m);
        gone.add(m);
        i--;
        continue;
      }
      if (!list.length) {
        ids.delete(n);
        order.splice(i, 1);
        dirty.delete(n);
        gone.add(n);
        i--;
      }
    }
    return { dirty, gone };
  }

  const metaOf = (st, L, gen) => ({
    k: 'meta',
    schema: 1,
    gen,
    writer: tab,
    version: st.version,
    epoch: st.epoch,
    userVersion: st.userVersion,
    userEpoch: st.userEpoch,
    etag: st.etag,
    you: st.you,
    source: st.source,
    chunks: L.chunks.slice(),
    likeChunks: L.likeChunks.slice(),
    playlists: L.playlists.slice(),
  });
  const tChunk = (st, L, n) => ({ k: 't', n, tracks: L.ids.get(n).map((id) => st.tracks.get(id)).filter(Boolean) });
  const lChunk = (st, L, n) => ({ k: 'l', n, likes: L.likeIds.get(n).filter((id) => st.likes.has(id)).map((id) => [id, st.likes.get(id)]) });
  const obj = (m) => {
    const o = {};
    for (const [k, v] of m) o[k] = v;
    return o;
  };
  const coversRec = (st) => ({ k: 'c', track: obj(st.trackCovers), album: obj(st.albumCovers) });

  /** The records a change touched, as [key, value] (value undefined: delete), taken now from the state. */
  function deltaOps(src, st, L, t) {
    const ops = [];
    if (t.all) {
      const old = new Set(L.chunks);
      relayTracks(L, st);
      for (const n of L.chunks) {
        old.delete(n);
        ops.push([key.t(src, n), tChunk(st, L, n)]);
      }
      for (const n of old) ops.push([key.t(src, n), undefined]);
      ops.push([key.c(src), coversRec(st)]);
    } else {
      const ref = { next: L.next };
      const { dirty, gone } = patchChunks(L.chunks, L.ids, L.of, ref, t.tracks, t.removed, TRACKS_PER_CHUNK);
      L.next = ref.next;
      for (const n of dirty) ops.push([key.t(src, n), tChunk(st, L, n)]);
      for (const n of gone) ops.push([key.t(src, n), undefined]);
      if (t.covers) ops.push([key.c(src), coversRec(st)]);
    }
    if (t.userAll) {
      const old = new Set(L.likeChunks);
      relayLikes(L, st);
      for (const n of L.likeChunks) {
        old.delete(n);
        ops.push([key.l(src, n), lChunk(st, L, n)]);
      }
      for (const n of old) ops.push([key.l(src, n), undefined]);
      const before = new Set(L.playlists);
      L.playlists = [...st.playlists.keys()];
      for (const [id, p] of st.playlists) {
        before.delete(id);
        ops.push([key.p(src, id), { k: 'p', playlist: p }]);
      }
      for (const id of before) ops.push([key.p(src, id), undefined]);
      ops.push([key.r(src), { k: 'r', recents: st.recents }]);
      ops.push([key.pc(src), { k: 'pc', covers: obj(st.playlistCovers) }]);
    } else {
      const ref = { next: L.likeNext };
      const { dirty, gone } = patchChunks(L.likeChunks, L.likeIds, L.likeOf, ref, t.likesAdded, t.likesRemoved, LIKES_PER_CHUNK);
      L.likeNext = ref.next;
      for (const n of dirty) ops.push([key.l(src, n), lChunk(st, L, n)]);
      for (const n of gone) ops.push([key.l(src, n), undefined]);
      if (t.playlists.size) {
        L.playlists = [...st.playlists.keys()];
        for (const id of t.playlists) ops.push([key.p(src, id), st.playlists.has(id) ? { k: 'p', playlist: st.playlists.get(id) } : undefined]);
      }
      if (t.recents) ops.push([key.r(src), { k: 'r', recents: st.recents }]);
      if (t.plCovers) ops.push([key.pc(src), { k: 'pc', covers: obj(st.playlistCovers) }]);
    }
    for (const [b, E] of L.edges) {
      if (E.whole) continue;
      for (const n of E.dirty) {
        const c = E.chunks.get(n);
        ops.push([key.e(src, b, n), c ? { k: 'e', n, edges: [...c.edges.values()], compared: [...c.compared] } : undefined]);
      }
      E.dirty.clear();
    }
    return ops;
  }

  /** Every record of a source from the state now, in a fresh layout (and its pairs' grouping caches). */
  function wholeOps(src, st, L) {
    relayTracks(L, st);
    relayLikes(L, st);
    L.playlists = [...st.playlists.keys()];
    const ops = [];
    for (const n of L.chunks) ops.push([key.t(src, n), tChunk(st, L, n)]);
    ops.push([key.c(src), coversRec(st)]);
    for (const [id, p] of st.playlists) ops.push([key.p(src, id), { k: 'p', playlist: p }]);
    for (const n of L.likeChunks) ops.push([key.l(src, n), lChunk(st, L, n)]);
    ops.push([key.r(src), { k: 'r', recents: st.recents }]);
    ops.push([key.pc(src), { k: 'pc', covers: obj(st.playlistCovers) }]);
    for (const b of L.edges.keys()) {
      const E = newEdgeLayout();
      L.edges.set(b, E);
      const ps = pair(src, b);
      if (!ps) continue;
      for (const e of ps.edges) addEdge(E, `${e[0]}|${e[1]}`, e);
      for (const k of ps.compared) addCompared(E, k);
      for (const n of E.dirty) {
        const c = E.chunks.get(n);
        ops.push([key.e(src, b, n), { k: 'e', n, edges: [...c.edges.values()], compared: [...c.compared] }]);
      }
      E.dirty.clear();
    }
    return ops;
  }

  // ---- the grouping cache of a pair

  function chunkWithRoom(E, kind) {
    let last = null;
    for (const [n, c] of E.chunks) if (!last || n > last.n) last = { n, c };
    if (last && (kind === 'e' ? last.c.edges.size : last.c.compared.size) < EDGES_PER_CHUNK) return last.n;
    const n = E.next++;
    E.chunks.set(n, { edges: new Map(), compared: new Set() });
    return n;
  }
  function addEdge(E, id, e) {
    let n = E.edgeOf.get(id);
    if (n === undefined) {
      n = chunkWithRoom(E, 'e');
      E.edgeOf.set(id, n);
    }
    E.chunks.get(n).edges.set(id, e);
    E.dirty.add(n);
  }
  function addCompared(E, k) {
    if (E.cmpOf.has(k)) return;
    const n = chunkWithRoom(E, 'c');
    E.cmpOf.set(k, n);
    E.chunks.get(n).compared.add(k);
    E.dirty.add(n);
  }
  function dropFrom(E, map, id, field) {
    const n = map.get(id);
    if (n === undefined) return;
    map.delete(id);
    const c = E.chunks.get(n);
    c[field].delete(id);
    if (!c.edges.size && !c.compared.size) E.chunks.delete(n);
    E.dirty.add(n);
  }

  // ---- writes

  async function write(src, t) {
    const st = state(src);
    if (!st) return;
    const L = layoutOf(src);
    stats.transactions++;
    const ops = L.broken ? null : deltaOps(src, st, L, t);
    // meta as the records written: the state may move on while the transaction opens.
    const meta0 = ops ? metaOf(st, L, 0) : null;
    let rebuild = !ops;
    if (ops) {
      try {
        const { t: tx, s } = await idbTx('readwrite');
        rebuild = await new Promise((resolve) => {
          let conflict = false;
          tx.oncomplete = () => resolve(false);
          tx.onabort = () => resolve(conflict || 'failed');
          tx.onerror = () => {};
          const rq = s.get(key.meta(src));
          rq.onsuccess = () => {
            const meta = rq.result;
            if (meta && meta.writer !== tab && meta.gen !== gens.get(src)) {
              // Another tab wrote this source since: its layout is not this one's.
              conflict = true;
              stats.aborts++;
              tx.abort();
              return;
            }
            const gen = (meta?.gen || 0) + 1;
            const next = (i) => {
              if (i === ops.length) {
                const m = s.put({ ...meta0, gen }, key.meta(src));
                m.onsuccess = () => gens.set(src, gen);
                stats.puts++;
                return;
              }
              const [k, v] = ops[i];
              const w = v === undefined ? s.delete(k) : s.put(v, k);
              if (v === undefined) stats.deletes++;
              else stats.puts++;
              w.onsuccess = () => next(i + 1);
            };
            next(0);
          };
        });
      } catch {
        rebuild = 'failed';
      }
      if (rebuild === 'failed') {
        // Cut off in the middle: what is on disk is the state before it; the next write lays it all again.
        L.broken = true;
        return;
      }
    }
    if (rebuild) await writeWhole(src);
  }

  /** Every record of the source again, in a fresh layout, every older one deleted, in one transaction. */
  async function writeWhole(src) {
    const st = state(src);
    if (!st) return;
    stats.transactions++;
    stats.rebuilds++;
    try {
      const { t: tx, s } = await idbTx('readwrite');
      await new Promise((resolve) => {
        tx.oncomplete = resolve;
        tx.onabort = resolve;
        tx.onerror = () => {};
        const rq = s.get(key.meta(src));
        rq.onsuccess = () => {
          const meta = rq.result;
          const kr = s.getAllKeys(idbPrefix(`L1:${src}:`));
          kr.onsuccess = () => {
            const ek = s.getAllKeys(idbPrefix(`L1:m:e:${src}:`));
            ek.onsuccess = () => {
              const L = newLayout();
              L.edges = layoutOf(src).edges;
              layouts.set(src, L);
              const ops = wholeOps(src, state(src), L);
              const keep = new Set(ops.map((o) => o[0]));
              for (const k of [...kr.result, ...ek.result].map(String)) if (!keep.has(k) && k !== key.meta(src)) ops.push([k, undefined]);
              const gen = (meta?.gen || 0) + 1;
              const next = (i) => {
                if (i === ops.length) {
                  const m = s.put(metaOf(state(src), L, gen), key.meta(src));
                  m.onsuccess = () => gens.set(src, gen);
                  stats.puts++;
                  return;
                }
                const [k, v] = ops[i];
                const w = v === undefined ? s.delete(k) : s.put(v, k);
                if (v === undefined) stats.deletes++;
                else stats.puts++;
                w.onsuccess = () => next(i + 1);
              };
              next(0);
            };
          };
        };
      });
    } catch {
      layoutOf(src).broken = true;
    }
  }

  function save(src, t) {
    const w = waiting.get(src);
    if (w) mergeTouched(w, t);
    else waiting.set(src, mergeTouched(newTouched(), t));
    if (writing.get(src)) return writing.get(src);
    const run = (async () => {
      try {
        while (waiting.has(src)) {
          const next = waiting.get(src);
          waiting.delete(src);
          await write(src, next);
        }
      } finally {
        writing.delete(src);
      }
    })();
    writing.set(src, run);
    return run;
  }

  return {
    stats,
    tab,
    save,

    /** Every write asked so far is on disk (or given up). */
    async idle() {
      while (writing.size) await Promise.all([...writing.values()]);
    },

    /**
     * What moved in the grouping cache (the graph's journal: pair key -> { edges, done }). Each
     * pair is written with its first source, which is saved when it is one of srcs.
     */
    noteEdges(journal, srcs) {
      const known = new Set(srcs);
      const touched = new Set();
      for (const [pk, j] of journal) {
        const [a, b] = pk.split(':');
        if (!known.has(a) || !known.has(b)) continue;
        const L = layoutOf(a);
        let E = L.edges.get(b);
        if (!E) L.edges.set(b, (E = newEdgeLayout()));
        for (const [id, e] of j.edges) {
          if (e) addEdge(E, id, e);
          else dropFrom(E, E.edgeOf, id, 'edges');
        }
        for (const [k, on] of j.done) {
          if (on) addCompared(E, k);
          else dropFrom(E, E.cmpOf, k, 'compared');
        }
        if (E.dirty.size) touched.add(a);
      }
      for (const a of touched) save(a, newTouched());
    },

    /**
     * Everything kept: { sources: Map src -> { meta, tracks, covers: { track, album }, playlists,
     * likes: [[id, at]] oldest first, recents, playlistCovers }, pairs: [{ a, b, edges, compared }],
     * old: { shared, user } (the cache of before the chunks, when there are no L1 records yet) }.
     * A source with a chunk missing is left out (and laid again whole at its next write).
     */
    async load() {
      const out = { sources: new Map(), pairs: [], old: null };
      let keys = [];
      let vals = [];
      try {
        const { s } = await idbTx('readonly');
        [keys, vals] = await Promise.all([done(s.getAllKeys(idbPrefix('L1:'))), done(s.getAll(idbPrefix('L1:')))]);
      } catch {
        return out;
      }
      if (!keys.length) {
        const shared = await idbGet('shared');
        const user = await idbGet('user');
        const libs = shared ? null : await idbGet('libs');
        if ((shared && typeof shared === 'object') || (libs && typeof libs === 'object')) out.old = { shared, user, libs };
        return out;
      }
      const bySrc = new Map();
      const pairs = new Map();
      keys.forEach((k, i) => {
        const key0 = String(k);
        const v = vals[i];
        if (!v || typeof v !== 'object') return;
        if (key0.startsWith('L1:m:e:')) {
          const [, , , a, b] = key0.split(':');
          const pk = `${a}:${b}`;
          if (!pairs.has(pk)) pairs.set(pk, { a, b, chunks: [] });
          if (v.k === 'e') pairs.get(pk).chunks.push(v);
          return;
        }
        const src = key0.split(':')[1];
        if (!bySrc.has(src)) bySrc.set(src, { meta: null, t: new Map(), l: new Map(), p: new Map(), c: null, r: null, pc: null });
        const x = bySrc.get(src);
        if (v.k === 'meta') x.meta = v;
        else if (v.k === 't') x.t.set(v.n, v);
        else if (v.k === 'l') x.l.set(v.n, v);
        else if (v.k === 'p' && v.playlist) x.p.set(v.playlist.id, v.playlist);
        else if (v.k === 'c') x.c = v;
        else if (v.k === 'r') x.r = v;
        else if (v.k === 'pc') x.pc = v;
      });
      for (const [src, x] of bySrc) {
        const m = x.meta;
        const L = layoutOf(src);
        if (!m || m.schema !== 1 || !Array.isArray(m.chunks) || m.chunks.some((n) => !x.t.has(n)) || (m.likeChunks || []).some((n) => !x.l.has(n)) || (m.playlists || []).some((id) => !x.p.has(id))) {
          L.broken = true;
          continue;
        }
        const tracks = [];
        for (const n of m.chunks) {
          const ids = [];
          for (const t of x.t.get(n).tracks) {
            tracks.push(t);
            ids.push(t.id);
            L.of.set(t.id, n);
          }
          L.ids.set(n, ids);
        }
        L.chunks = m.chunks.slice();
        L.next = Math.max(0, ...m.chunks) + 1;
        const likes = [];
        for (const n of m.likeChunks || []) {
          const ids = [];
          for (const [id, at] of x.l.get(n).likes) {
            likes.push([id, at]);
            ids.push(id);
            L.likeOf.set(id, n);
          }
          L.likeIds.set(n, ids);
        }
        L.likeChunks = (m.likeChunks || []).slice();
        L.likeNext = Math.max(0, ...L.likeChunks) + 1;
        L.playlists = (m.playlists || []).slice();
        gens.set(src, m.gen);
        out.sources.set(src, {
          meta: m,
          tracks,
          covers: { track: x.c?.track || {}, album: x.c?.album || {} },
          playlists: L.playlists.map((id) => x.p.get(id)),
          likes,
          recents: Array.isArray(x.r?.recents) ? x.r.recents : [],
          playlistCovers: x.pc?.covers || {},
        });
      }
      for (const { a, b, chunks } of pairs.values()) {
        if (!out.sources.has(a) || !out.sources.has(b)) continue;
        const E = newEdgeLayout();
        const edges = [];
        const compared = [];
        for (const c of chunks) {
          const ce = { edges: new Map(), compared: new Set() };
          for (const e of c.edges || []) {
            const id = `${e[0]}|${e[1]}`;
            ce.edges.set(id, e);
            E.edgeOf.set(id, c.n);
            edges.push(e);
          }
          for (const k of c.compared || []) {
            ce.compared.add(k);
            E.cmpOf.set(k, c.n);
            compared.push(k);
          }
          E.chunks.set(c.n, ce);
          E.next = Math.max(E.next, c.n + 1);
        }
        layoutOf(a).edges.set(b, E);
        out.pairs.push({ a, b, edges, compared });
      }
      return out;
    },

    /** The cache of before the chunks goes, once its content was written in chunks. */
    async dropOld() {
      for (const k of ['shared', 'user', 'libs']) await idbDel(k);
    },

    /** A source no longer paired: its records and the grouping caches with it go. */
    async forget(src) {
      layouts.delete(src);
      gens.delete(src);
      for (const L of layouts.values()) L.edges.delete(src);
      try {
        const { t: tx, s } = await idbTx('readwrite');
        await new Promise((resolve) => {
          tx.oncomplete = resolve;
          tx.onabort = resolve;
          tx.onerror = () => {};
          const a = s.getAllKeys(idbPrefix(`L1:${src}:`));
          a.onsuccess = () => {
            const b = s.getAllKeys(idbPrefix('L1:m:e:'));
            b.onsuccess = () => {
              const mine = b.result.map(String).filter((k) => {
                const p = k.split(':');
                return p[3] === src || p[4] === src;
              });
              const list = [...a.result.map(String), ...mine];
              const next = (i) => {
                if (i >= list.length) return;
                s.delete(list[i]).onsuccess = () => next(i + 1);
              };
              next(0);
            };
          };
        });
      } catch {
        /* nothing to forget */
      }
    },
  };
}
