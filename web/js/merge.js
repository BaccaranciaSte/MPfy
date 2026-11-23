// The union of the sources' libraries, kept up to date by what changed instead of being made again:
// the songs (one per recording, with one version per source), the albums, the artists, the covers
// and the person's own indexes (likes, playlists, plays). The answer is the store's whole merge,
// field for field and in the same order (web/dev/store-scale.mjs checks it after random changes):
//   - a version is new, gone or changed: the versions joined to it (same trackId, same file, a known
//     signature edge, the same song before) are grouped again with groupVersions' own rule; every
//     other song stays the same object;
//   - each song that left or came moves its album, its artist, its cover and the covers' sources;
//     those are made again for that album and that artist only;
//   - search text is made the first time a song is searched, then kept with the song.
// A change of the sources' order, of the principal, or a whole new answer of a source makes
// everything again with the edges known (no signature is compared again), in slices.

import { VersionGraph, groupWithEdges, versionKey, scoreOf, signatureOf } from './songs.js';
import { norm, cmpText, ctxKey } from './util.js';

// ---- the album and artist ids: FNV-1a 64 bit over UTF-8, as 16 hex digits (util.js hashId's
// numbers, computed in two 32 bit halves instead of BigInt)

const idCache = new Map();
const hex8 = (x) => (x >>> 0).toString(16).padStart(8, '0');

export function fnvId(str) {
  let v = idCache.get(str);
  if (v) return v;
  let hi = 0xcbf29ce4;
  let lo = 0x84222325;
  const step = (b) => {
    lo ^= b;
    // (hi, lo) * 0x100000001b3 mod 2^64 = (hi, lo) * 0x1b3 + (lo << 40)
    const a = (lo & 0xffff) * 0x1b3;
    const c = (lo >>> 16) * 0x1b3 + (a >>> 16);
    const nlo = (((c & 0xffff) << 16) | (a & 0xffff)) >>> 0;
    hi = (Math.imul(hi, 0x1b3) + (c >>> 16) + (lo << 8)) >>> 0;
    lo = nlo;
  };
  for (let i = 0; i < str.length; i++) {
    let cp = str.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (next - 0xdc00);
        i++;
      }
    }
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd; // a lone surrogate, as TextEncoder writes it
    if (cp < 0x80) step(cp);
    else if (cp < 0x800) {
      step(0xc0 | (cp >> 6));
      step(0x80 | (cp & 63));
    } else if (cp < 0x10000) {
      step(0xe0 | (cp >> 12));
      step(0x80 | ((cp >> 6) & 63));
      step(0x80 | (cp & 63));
    } else {
      step(0xf0 | (cp >> 18));
      step(0x80 | ((cp >> 12) & 63));
      step(0x80 | ((cp >> 6) & 63));
      step(0x80 | (cp & 63));
    }
  }
  v = hex8(hi) + hex8(lo);
  idCache.set(str, v);
  return v;
}

export const albumIdOf = (t) => fnvId(`${t.albumArtist || t.artist || ''}\u0000${t.album || ''}`);

/**
 * The ids a track had before its bytes changed (a song retagged on the phone keeps its likes and
 * playlist places through them). Each resolves to the track's song unless some version anywhere
 * has that id itself.
 */
export const wasOf = (t) => (Array.isArray(t?.was) ? t.was.filter((x) => typeof x === 'string' && x) : []);
/** id is a real id of song (its own or a version's), not an alias. */
const ownId = (song, id) => song.id === id || song.versions.some((v) => v.trackId === id);

// ---- versions

const sigCache = new WeakMap(); // fp object -> decoded signature
export function sigOf(t) {
  const fp = t.fp;
  if (!fp || typeof fp !== 'object') return null;
  if (sigCache.has(fp)) return sigCache.get(fp);
  const s = signatureOf(fp);
  sigCache.set(fp, s);
  return s;
}

// A version's signature is decoded the first time it is read (most never are).
const VERSION = {
  get sig() {
    return sigOf(this.t);
  },
};

function makeVersion(sourceId, t, order, kept) {
  const v = Object.create(VERSION);
  v.sourceId = sourceId;
  v.trackId = t.id;
  v.fileHash = typeof t.fileHash === 'string' && t.fileHash ? t.fileHash : t.id;
  v.order = order;
  v.score = scoreOf(t);
  v.t = t;
  v.kept = kept;
  return v;
}

const SIG_D = (t) => {
  const fp = t.fp;
  return fp && typeof fp === 'object' && typeof fp.s === 'string' && fp.s && Number.isFinite(Number(fp.d)) ? Number(fp.d) : null;
};

/** A version in the grouping: the version, its cache key, its place in global order, its song. */
class Rec {
  constructor(v, gk) {
    this.v = v;
    this.key = versionKey(v.sourceId, v.t);
    this.sourceId = v.sourceId;
    this.trackId = v.trackId;
    this.fileHash = v.fileHash;
    this.d = SIG_D(v.t);
    this.gk = gk;
    this.song = null;
  }

  get sig() {
    return sigOf(this.v.t);
  }
}

const SLOT = 4294967296; // a source's place times this, plus the version's place in its source
const vkOf = (sid, id) => `${sid}\u0000${id}`;
const sameFp = (a, b) => a === b || (!!a && !!b && a.s === b.s && Number(a.d) === Number(b.d) && Number(a.b) === Number(b.b));

function trackOrder(a, b) {
  return (a.discNo || 1) - (b.discNo || 1) || (a.trackNo || 9999) - (b.trackNo || 9999) || cmpText(a.title, b.title);
}

/** First index of a sorted array where key(item) is not below k (binary search). */
function lowerBy(arr, k, key) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(arr[mid]) < k) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * host: { order() -> source ids in order, tracksOf(sid) -> the shown tracks (in the source's
 * order), trackOf(sid, id), seqOf(sid, id) -> the track's place in its source (rising along it),
 * coversOf(sid) -> { track, album } custom covers, kept() -> tracks of removed sources still kept
 * (each with _src) }.
 */
export class Union {
  constructor(host) {
    this.host = host;
    this.graph = new VersionGraph();
    this.recs = new Map(); // sid NUL trackId -> rec
    this.songs = []; // the songs, in order (the store's lib.tracks): patched in place
    this.order = [];
    this.recsOf = new WeakMap(); // song -> its recs
    this.gkOf = new WeakMap(); // song -> its first version's place
    this.albumRecs = new Map(); // album id -> { members: songs in order, sorted: songs by track order }
    this.artistRecs = new Map(); // artist id -> { members: songs in order }
    this.contrib = new Map(); // cover id -> Map(contribution id -> { k0, k1, k2, sid })
    this.owned = new Map(); // contribution id -> the cover ids it counts in
    this.covDirty = new Set(); // cover ids whose sources are to be read again
    this.queue = []; // versions waiting to be compared, the newest first
    this.queued = new Set(); // the same, to look up
    this.aliased = new Map(); // a `was` id -> the songs whose versions carry it
    this.d = { tracks: new Map(), albums: new Map(), artists: new Map(), albumOf: new Map(), artistOf: new Map(), searchText: null, trackCover: new Map(), coverSrc: new Map() };
    this.d.searchText = searchIndex(this.d.tracks);
    this.changed = { all: false, songs: new Set(), albums: new Set(), artists: new Set(), moved: new Set() };
    this.merges = 0;
  }

  takeChanged() {
    const c = this.changed;
    this.changed = { all: false, songs: new Set(), albums: new Set(), artists: new Set(), moved: new Set() };
    return c;
  }

  // ---- everything again (a new order, a new principal, a whole new answer, the start)

  /**
   * Makes everything again from the shown libraries, with the edges known; versions whose key and
   * signature did not change keep their comparisons. trust: the comparisons read from the cache
   * at start hold for versions seen for the first time. A generator: each yield is a place to
   * stop and let the page run.
   */
  *whole({ trust = false } = {}) {
    this.merges++;
    const order = this.host.order();
    const lists = order.map((sid) => this.host.tracksOf(sid).slice());
    const kept = this.host.kept();
    yield;
    const next = new Map();
    const all = [];
    const present = new Set();
    let n = 0;
    for (let oi = 0; oi < lists.length; oi++) {
      const sid = order[oi];
      for (const t of lists[oi]) {
        const k = vkOf(sid, t.id);
        const gk = oi * SLOT + this.host.seqOf(sid, t.id);
        const old = this.recs.get(k);
        let r;
        if (old && old.v.t === t && old.v.order === oi && !old.v.kept) {
          r = old;
          r.gk = gk;
        } else r = new Rec(makeVersion(sid, t, oi, false), gk);
        next.set(k, r);
        all.push(r);
        present.add(t.id);
        if ((++n & 1023) === 0) yield;
      }
    }
    let ki = 0;
    for (const t of kept) {
      if (present.has(t.id)) continue;
      const sid = t._src || '';
      const k = vkOf(sid, t.id);
      const old = this.recs.get(k);
      const gk = order.length * SLOT + ki++;
      const r = old && old.v.t === t && old.v.kept && old.v.order === order.length ? old : new Rec(makeVersion(sid, t, order.length, true), gk);
      r.gk = gk;
      next.set(k, r);
      all.push(r);
    }
    yield;
    // The grouping cache: what left goes, what came is compared (unless the cache says it was).
    const g = this.graph;
    const reshaped = [];
    for (const [k, r] of this.recs) {
      const now = next.get(k);
      if (now === r) continue;
      if (now && now.key === r.key && sameFp(now.v.t.fp, r.v.t.fp) && g.recs.get(r.key) === r) g.replace(r, now);
      else if (g.recs.get(r.key) === r) {
        g.remove(r);
        reshaped.push(r.trackId, r.fileHash);
      }
    }
    for (const r of all) {
      if (g.recs.get(r.key) === r) continue;
      g.add(r, !trust);
      if (!trust) reshaped.push(r.trackId, r.fileHash);
    }
    // Versions that came or went reshape the trackId and fileHash groups around them: their
    // members are compared again.
    for (const k of new Set(reshaped)) {
      for (const m of [...(g.byTrack.get(k) || []), ...(g.byFile.get(k) || [])]) for (const x of g.tfComponent(m)) g.undo(x);
    }
    this.recs = next;
    this.order = order;
    yield;
    const groups = groupWithEdges(all, g.edgesAmong(all));
    yield;
    // The songs and every index, as the whole merge makes them, in new containers: the ones the
    // page reads stay as they were until this ends.
    const d = { tracks: new Map(), albums: new Map(), artists: new Map(), albumOf: new Map(), artistOf: new Map(), searchText: null, trackCover: new Map(), coverSrc: new Map() };
    d.searchText = searchIndex(d.tracks);
    this.d = d;
    this.songs = [];
    this.contrib = new Map();
    this.owned = new Map();
    this.covDirty = new Set();
    this.albumRecs = new Map();
    this.artistRecs = new Map();
    this.aliased = new Map();
    n = 0;
    for (const grp of groups) {
      const song = this._song(grp);
      this.songs.push(song);
      if ((++n & 511) === 0) yield;
    }
    for (const s of this.songs) d.tracks.set(s.id, s);
    for (const s of this.songs) for (const v of s.versions) if (!d.tracks.has(v.trackId)) d.tracks.set(v.trackId, s);
    for (const s of this.songs) for (const v of s.versions) for (const w of wasOf(v.t)) if (!d.tracks.has(w)) d.tracks.set(w, s);
    for (const s of this.songs) this._alias(s, true);
    n = 0;
    for (const s of this.songs) {
      this._enter(s, false);
      if ((++n & 511) === 0) yield;
    }
    n = 0;
    for (const id of this.albumRecs.keys()) {
      this._album(id);
      if ((++n & 255) === 0) yield;
    }
    for (const s of this.songs) this._trackCover(s);
    n = 0;
    for (const id of this.artistRecs.keys()) {
      this._artist(id);
      if ((++n & 255) === 0) yield;
    }
    this._flushCovers();
    this.queue = g.pending();
    this.queued = new Set(this.queue);
    this.changed = { all: true, songs: new Set(), albums: new Set(), artists: new Set(), moved: new Set() };
  }

  /** Runs whole() to its end now. */
  wholeNow(opts) {
    const it = this.whole(opts);
    while (!it.next().done);
  }

  // ---- what changed

  /**
   * dirty: { tracks: [[sid, id]] versions that may have changed, trackCovers: [[sid, id]] custom
   * track covers that moved, albumCovers: album ids whose custom cover moved }. compareNow: compare
   * at most this many new versions now (the rest waits for compareSome, shown apart meanwhile).
   */
  patch(dirty, { compareNow = 64 } = {}) {
    const g = this.graph;
    const seeds = new Set();
    const oldSongs = new Set();
    const touchSongs = new Set();
    const oi = new Map(this.order.map((sid, i) => [sid, i]));
    for (const [sid, id] of dirty.tracks || []) {
      if (!oi.has(sid)) continue;
      const k = vkOf(sid, id);
      const old = this.recs.get(k);
      const t = this.host.trackOf(sid, id);
      if (old && t && old.v.t === t) continue;
      let r = null;
      if (t) {
        r = new Rec(makeVersion(sid, t, oi.get(sid), false), oi.get(sid) * SLOT + this.host.seqOf(sid, id));
        this.recs.set(k, r);
        seeds.add(r);
      } else this.recs.delete(k);
      if (old) {
        if (old.song) oldSongs.add(old.song);
        const same = r && r.key === old.key && r.gk === old.gk && sameFp(r.v.t.fp, old.v.t.fp);
        if (same && g.recs.get(old.key) === old) g.replace(old, r);
        else {
          if (g.recs.get(old.key) === old) g.remove(old);
          // The group it belonged to may now meet versions it was kept from: compare them again.
          if (old.song) for (const m of this.recsOf.get(old.song)) if (m !== old) g.undo(m);
          if (r) g.add(r);
        }
        if (old.song) for (const m of this.recsOf.get(old.song)) if (m !== old) seeds.add(m);
      } else if (r) g.add(r);
      // A version that came, went or moved its file reshapes the trackId and fileHash groups
      // around it (a union refused now, or no longer): their members are compared again.
      if (r && !(old && g.recs.get(r.key) === r && r.key === old.key && sameFp(r.v.t.fp, old.v.t.fp))) {
        for (const m of g.tfComponent(r)) if (m !== r) {
          g.undo(m);
          seeds.add(m);
        }
      }
      if (old && !(r && r.key === old.key && sameFp(r.v.t.fp, old.v.t.fp))) {
        for (const k of [old.trackId, old.fileHash]) {
          for (const m of [...(g.byTrack.get(k) || []), ...(g.byFile.get(k) || [])]) {
            for (const x of g.tfComponent(m)) {
              g.undo(x);
              seeds.add(x);
            }
          }
        }
      }
    }
    // New versions compared now (a few), the rest in slices.
    const memo = new Map();
    const waiting = (w) => this.queued.has(w);
    const later = [...seeds].filter((r) => g.needs(r));
    for (const r of later.slice(compareNow)) this._wait(r);
    for (const r of later.slice(0, compareNow)) this._wait(r);
    for (const r of later.slice(0, compareNow)) {
      this.queued.delete(r);
      for (const x of g.compare(r, memo, waiting)) seeds.add(x);
    }
    for (const [sid, id] of dirty.trackCovers || []) {
      const r = this.recs.get(vkOf(sid, id));
      if (r && r.song) touchSongs.add(r.song);
    }
    this._regroup(seeds, oldSongs, touchSongs, new Set(dirty.albumCovers || []));
  }

  /** Compares up to ms milliseconds of versions not compared yet (the newest first); true when some remain. */
  compareSome(ms = 8) {
    const g = this.graph;
    const t0 = now();
    const memo = new Map();
    const seeds = new Set();
    let i = 0;
    const waiting = (w) => this.queued.has(w);
    while (this.queue.length) {
      const r = this.queue.shift();
      this.queued.delete(r);
      if (this.recs.get(vkOf(r.sourceId, r.trackId)) !== r || !g.needs(r)) continue;
      for (const x of g.compare(r, memo, waiting)) seeds.add(x);
      if ((++i & 7) === 0 && now() - t0 > ms) break;
    }
    if (seeds.size) this._regroup(seeds, new Set(), new Set(), new Set());
    return this.queue.length > 0;
  }

  _wait(r) {
    if (this.queued.has(r)) return;
    this.queued.add(r);
    this.queue.push(r);
  }

  /** Versions are still waiting to be compared (they show apart until then). */
  get comparing() {
    return this.queue.length > 0;
  }

  _regroup(seeds, oldSongs, touchSongs, albumCovers) {
    const g = this.graph;
    // Everything joined to what moved, and every song any of it was in.
    const comp = new Set();
    const queue = [...seeds];
    while (queue.length) {
      const r = queue.pop();
      if (comp.has(r) || this.recs.get(vkOf(r.sourceId, r.trackId)) !== r) continue;
      comp.add(r);
      for (const x of g.neighbors(r)) if (!comp.has(x)) queue.push(x);
      if (r.song) {
        oldSongs.add(r.song);
        for (const m of this.recsOf.get(r.song)) if (!comp.has(m)) queue.push(m);
      }
    }
    for (const s of oldSongs) for (const m of this.recsOf.get(s)) if (this.recs.get(vkOf(m.sourceId, m.trackId)) === m && !comp.has(m)) comp.add(m);
    const list = [...comp].sort((a, b) => a.gk - b.gk);
    const groups = groupWithEdges(list, g.edgesAmong(list));
    // A song whose versions are the same records in the same order stays the same object.
    const keep = new Set();
    const fresh = [];
    for (const grp of groups) {
      const old = grp[0].song;
      const prev = old && this.recsOf.get(old);
      if (prev && oldSongs.has(old) && prev.length === grp.length && prev.every((x, i) => x === grp[i])) keep.add(old);
      else fresh.push(grp);
    }
    const leaving = [...oldSongs].filter((s) => !keep.has(s));
    // trackIds whose song id may move: every one of a song that leaves (read again after).
    const was = new Map();
    for (const s of leaving) {
      for (const v of s.versions) {
        was.set(v.trackId, s.id);
        for (const w of wasOf(v.t)) if (this.d.tracks.get(w) === s) was.set(w, s.id);
      }
    }
    const albums = new Set(albumCovers);
    const artists = new Set();
    for (const s of leaving) this._leave(s, albums, artists);
    const came = fresh.map((grp) => this._song(grp));
    for (const s of came) this._place(s);
    for (const s of came) for (const v of s.versions) if (was.get(v.trackId) !== s.id) this.changed.moved.add(v.trackId);
    for (const s of came) for (const v of s.versions) for (const w of wasOf(v.t)) if (this.d.tracks.get(w) === s && was.get(w) !== s.id) this.changed.moved.add(w);
    for (const [id, sid] of was) if (this.d.tracks.get(id)?.id !== sid) this.changed.moved.add(id);
    for (const s of came) this._enter(s, true, albums, artists);
    for (const s of touchSongs) if (this.recsOf.get(s) && !leaving.includes(s)) this.changed.songs.add(s.id);
    const covers = new Set([...came, ...[...touchSongs].filter((s) => !leaving.includes(s))]);
    for (const id of albums) {
      const ar = this.albumRecs.get(id);
      if (ar) for (const s of ar.members) covers.add(s);
      this._album(id);
      const a = this.d.albums.get(id);
      if (a) for (const s of this.albumRecs.get(id).members) artists.add(this.d.artistOf.get(s.id));
    }
    for (const s of covers) if (this.recsOf.get(s)) this._trackCover(s);
    for (const id of artists) if (id) this._artist(id);
    this._flushCovers();
  }

  // ---- songs

  _song(grp) {
    const vs = grp.map((r) => r.v);
    const rep = vs[0];
    const song = {
      ...rep.t,
      id: rep.trackId,
      coverId: rep.t.coverId || vs.find((v) => v.t.coverId)?.t.coverId || null,
      versions: vs,
      sources: [...new Set(vs.filter((v) => !v.kept).map((v) => v.sourceId))],
    };
    delete song._src;
    for (const r of grp) r.song = song;
    this.recsOf.set(song, grp);
    this.gkOf.set(song, grp[0].gk);
    return song;
  }

  _place(song) {
    const gk = this.gkOf.get(song);
    this.songs.splice(lowerBy(this.songs, gk, (s) => this.gkOf.get(s)), 0, song);
    const d = this.d;
    d.tracks.set(song.id, song);
    for (const v of song.versions) d.tracks.set(v.trackId, song);
    for (const v of song.versions) {
      for (const w of wasOf(v.t)) {
        const cur = d.tracks.get(w);
        // Never over a real id; between two songs carrying it, the first in order (the whole merge's).
        if (!cur || (cur !== song && !ownId(cur, w) && this.gkOf.get(song) < this.gkOf.get(cur))) d.tracks.set(w, song);
      }
    }
    this._alias(song, true);
  }

  /** Notes (or forgets) the `was` ids a song's versions carry. */
  _alias(song, on) {
    for (const v of song.versions) {
      for (const w of wasOf(v.t)) {
        let set = this.aliased.get(w);
        if (on) {
          if (!set) this.aliased.set(w, (set = new Set()));
          set.add(song);
        } else if (set) {
          set.delete(song);
          if (!set.size) this.aliased.delete(w);
        }
      }
    }
  }

  _leave(song, albums, artists) {
    const d = this.d;
    const gk = this.gkOf.get(song);
    const i = lowerBy(this.songs, gk, (s) => this.gkOf.get(s));
    if (this.songs[i] === song) this.songs.splice(i, 1);
    this._alias(song, false);
    for (const id of [song.id, ...song.versions.flatMap((v) => [v.trackId, ...wasOf(v.t)])]) {
      if (d.tracks.get(id) !== song) continue;
      d.tracks.delete(id);
      // Another song carries the id as an alias: it resolves there, the first of them in order
      // as the whole merge has it.
      let next = null;
      for (const s of this.aliased.get(id) || []) if (!next || this.gkOf.get(s) < this.gkOf.get(next)) next = s;
      if (next) d.tracks.set(id, next);
    }
    const alId = d.albumOf.get(song.id);
    const arId = d.artistOf.get(song.id);
    const al = this.albumRecs.get(alId);
    const out = (list) => {
      const i = list.indexOf(song);
      if (i >= 0) list.splice(i, 1);
    };
    if (al) {
      out(al.members);
      out(al.sorted);
      albums.add(alId);
    }
    const ar = this.artistRecs.get(arId);
    if (ar) {
      out(ar.members);
      artists.add(arId);
    }
    d.albumOf.delete(song.id);
    d.artistOf.delete(song.id);
    d.trackCover.delete(song.id);
    song.versions.forEach((v, i) => this._uncount(`0|${song.id}|${i}`, v.t.coverId));
    this._setContrib(`2|${song.id}`, null);
    for (const r of this.recsOf.get(song)) if (r.song === song) r.song = null;
    this.recsOf.delete(song);
    this.changed.songs.add(song.id);
  }

  /** The song's album and artist membership and its embedded covers' sources. */
  _enter(song, incremental, albums, artists) {
    const d = this.d;
    const albumArtist = song.albumArtist || song.artist || '';
    const alId = fnvId(`${albumArtist}\u0000${song.album || ''}`);
    const arId = fnvId(song.artist || '');
    d.albumOf.set(song.id, alId);
    d.artistOf.set(song.id, arId);
    const gk = this.gkOf.get(song);
    song.versions.forEach((v, i) => {
      if (!v.kept && v.t.coverId) this._count(`0|${song.id}|${i}`, v.t.coverId, v.sourceId, 0, gk, i);
    });
    let al = this.albumRecs.get(alId);
    if (!al) {
      al = { members: [], sorted: [], name: song.album || '', artist: albumArtist };
      this.albumRecs.set(alId, al);
    }
    let ar = this.artistRecs.get(arId);
    if (!ar) {
      ar = { members: [], name: song.artist || '' };
      this.artistRecs.set(arId, ar);
    }
    if (!incremental) {
      al.members.push(song);
      ar.members.push(song);
      return;
    }
    const key = (s) => this.gkOf.get(s);
    al.members.splice(lowerBy(al.members, gk, key), 0, song);
    ar.members.splice(lowerBy(ar.members, gk, key), 0, song);
    let lo = 0;
    let hi = al.sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const o = al.sorted[mid];
      if ((trackOrder(o, song) || this.gkOf.get(o) - gk) < 0) lo = mid + 1;
      else hi = mid;
    }
    al.sorted.splice(lo, 0, song);
    this.changed.songs.add(song.id);
    albums.add(alId);
    artists.add(arId);
  }

  /** An album made again from its members: its tracks by disc, number and title, year, time, cover. */
  _album(id) {
    const d = this.d;
    const rec = this.albumRecs.get(id);
    this.changed.albums.add(id);
    if (!rec || !rec.members.length) {
      this.albumRecs.delete(id);
      d.albums.delete(id);
      this._setContrib(`1|${id}`, null);
      return;
    }
    if (!rec.sorted.length || rec.sorted.length !== rec.members.length) rec.sorted = rec.members.slice().sort((a, b) => trackOrder(a, b) || this.gkOf.get(a) - this.gkOf.get(b));
    const al = { id, name: rec.name, artist: rec.artist, artistId: fnvId(rec.artist), year: null, trackIds: rec.sorted.map((s) => s.id), cover: null, coverId: null, addedAt: 0, duration: 0 };
    for (const t of rec.members) {
      if (t.year && (!al.year || t.year > al.year)) al.year = t.year;
      al.addedAt = Math.max(al.addedAt, t.addedAt || 0);
      al.duration += t.duration || 0;
    }
    const embedded = rec.sorted.map((s) => s.coverId).find(Boolean);
    let custom = null;
    for (const sid of this.order) {
      const c = this.host.coversOf(sid)?.album?.[id];
      if (c) {
        custom = { c, sid };
        break;
      }
    }
    if (custom) this._setContrib(`1|${id}`, { ids: [custom.c.large, custom.c.small], sid: custom.sid, k0: 1, k1: this.gkOf.get(rec.members[0]), k2: 0 });
    else this._setContrib(`1|${id}`, null);
    al.cover = custom ? { id: custom.c.large, small: custom.c.small } : embedded ? { id: embedded, small: embedded } : null;
    al.coverId = al.cover?.small || null;
    d.albums.set(id, al);
  }

  _artist(id) {
    const d = this.d;
    const rec = this.artistRecs.get(id);
    this.changed.artists.add(id);
    if (!rec || !rec.members.length) {
      this.artistRecs.delete(id);
      d.artists.delete(id);
      return;
    }
    const ar = { id, name: rec.name, trackIds: [], albumIds: [], cover: null, coverId: null, addedAt: 0 };
    const seen = new Set();
    for (const t of rec.members) {
      ar.trackIds.push(t.id);
      const alId = d.albumOf.get(t.id);
      if (!seen.has(alId)) {
        seen.add(alId);
        ar.albumIds.push(alId);
      }
      ar.addedAt = Math.max(ar.addedAt, t.addedAt || 0);
    }
    ar.albumIds.sort((a, b) => (d.albums.get(b).year || 0) - (d.albums.get(a).year || 0) || cmpText(d.albums.get(a).name, d.albums.get(b).name));
    ar.cover = ar.albumIds.map((x) => d.albums.get(x).cover).find(Boolean) || null;
    ar.coverId = ar.cover?.small || null;
    d.artists.set(id, ar);
  }

  /** A song's cover: its own custom cover (first version in order that has one), else its album's, else the embedded one. */
  _trackCover(song) {
    const d = this.d;
    let custom = null;
    for (const v of song.versions) {
      if (v.kept) continue;
      const c = this.host.coversOf(v.sourceId)?.track?.[v.trackId];
      if (c) {
        custom = { c, sid: v.sourceId };
        break;
      }
    }
    this._setContrib(`2|${song.id}`, custom ? { ids: [custom.c.large, custom.c.small], sid: custom.sid, k0: 2, k1: this.gkOf.get(song), k2: 0 } : null);
    const al = d.albums.get(d.albumOf.get(song.id));
    const own = custom ? { id: custom.c.large, small: custom.c.small } : al?.cover || (song.coverId ? { id: song.coverId, small: song.coverId } : null);
    const before = d.trackCover.get(song.id);
    if (own) d.trackCover.set(song.id, own);
    else d.trackCover.delete(song.id);
    if (before !== own && (before?.id !== own?.id || before?.small !== own?.small)) this.changed.songs.add(song.id);
  }

  // ---- which sources can serve a cover, in the order the whole merge meets them

  _count(cid, coverId, sid, k0, k1, k2) {
    let m = this.contrib.get(coverId);
    if (!m) this.contrib.set(coverId, (m = new Map()));
    m.set(cid, { sid, k0, k1, k2 });
    this.covDirty.add(coverId);
  }

  _uncount(cid, coverId) {
    const m = coverId && this.contrib.get(coverId);
    if (!m || !m.delete(cid)) return;
    if (!m.size) this.contrib.delete(coverId);
    this.covDirty.add(coverId);
  }

  _flushCovers() {
    for (const id of this.covDirty) this._coverSrc(id);
    this.covDirty.clear();
  }

  /** A contribution of several cover ids (a custom cover's two sizes) by one owner, or null to take it away. */
  _setContrib(cid, c) {
    const was = this.owned;
    const before = was.get(cid);
    if (before) for (const id of before) this._uncount(cid, id);
    if (!c) {
      was.delete(cid);
      return;
    }
    const ids = [...new Set(c.ids.filter(Boolean))];
    was.set(cid, ids);
    for (const id of ids) this._count(cid, id, c.sid, c.k0, c.k1, c.k2);
  }

  _coverSrc(coverId) {
    const m = this.contrib.get(coverId);
    if (!m) {
      this.d.coverSrc.delete(coverId);
      return;
    }
    const first = new Map();
    const less = (a, b) => a.k0 - b.k0 || a.k1 - b.k1 || a.k2 - b.k2;
    for (const c of m.values()) {
      const f = first.get(c.sid);
      if (!f || less(c, f) < 0) first.set(c.sid, c);
    }
    this.d.coverSrc.set(
      coverId,
      [...first.values()].sort(less).map((c) => c.sid)
    );
  }
}

// VersionGraph.replace: the same key and signature with another record (a version whose metadata
// changed keeps its comparisons and edges).
VersionGraph.prototype.replace = function replace(old, rec) {
  this.recs.set(rec.key, rec);
  for (const map of [this.byTrack, this.byFile]) {
    for (const k of [old.trackId, old.fileHash]) {
      const s = map.get(k);
      if (s && s.delete(old)) s.add(rec);
    }
  }
  if (old.d !== null) {
    const arr = this.bySource.get(old.sourceId);
    const i = arr ? arr.indexOf(old) : -1;
    if (i >= 0) arr[i] = rec;
  }
};

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** song id -> its search text, made the first time it is asked and kept with the song object. */
function searchIndex(tracks) {
  const texts = new WeakMap();
  const textOf = (s) => {
    let x = texts.get(s);
    if (x === undefined) {
      x = norm(`${s.title} ${s.artist} ${s.album}`);
      texts.set(s, x);
    }
    return x;
  };
  return {
    get: (id) => {
      const s = tracks.get(id);
      return s && s.id === id ? textOf(s) : undefined;
    },
    has: (id) => {
      const s = tracks.get(id);
      return !!s && s.id === id;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// the person's own indexes (from the principal's shown library)

/**
 * likedSet, likedIds (song ids, the newest like first), playlists, playlistCover, userCoverSrc,
 * lastPlayed, trackLastPlayed, playCount: the store's buildUser, kept up to date. gid(trackId) ->
 * the song id or null.
 */
export class UserIndex {
  constructor() {
    this.likedSet = new Set();
    this.likedIds = [];
    this.playlists = new Map();
    this.playlistCover = new Map();
    this.userCoverSrc = new Map();
    this.lastPlayed = new Map();
    this.trackLastPlayed = new Map();
    this.playCount = new Map();
    this.likeIds = new Set(); // trackIds liked
    this.perSong = new Map(); // song id -> likes of it
    this.maxAt = -Infinity; // no like is newer than this
    this.coverRefs = new Map(); // cover image id -> playlists using it
    this.principal = null;
  }

  /** The indexes, made again from the principal's shown library p. */
  whole(p, principal, gid) {
    this.principal = principal;
    this.likesAll(p, gid);
    this.playlists.clear();
    for (const x of p.playlists) this.playlists.set(x.id, x);
    this.playlistCover.clear();
    this.userCoverSrc.clear();
    this.coverRefs.clear();
    for (const x of p.playlists) this._cover(p, x.id);
    this.recentsAll(p, gid);
  }

  likesAll(p, gid) {
    const likes = p.likes;
    let sorted = true;
    this.maxAt = likes.length ? likes[0].at || 0 : -Infinity;
    for (let i = 1; i < likes.length; i++) {
      const at = likes[i].at || 0;
      if (at > (likes[i - 1].at || 0)) sorted = false;
      if (at > this.maxAt) this.maxAt = at;
    }
    const list = sorted ? likes : [...likes].sort((a, b) => (b.at || 0) - (a.at || 0));
    this.likedSet.clear();
    this.likedIds.length = 0;
    this.likeIds.clear();
    this.perSong.clear();
    for (const like of list) {
      this.likeIds.add(like.id);
      const g = gid(like.id);
      if (!g) continue;
      this.perSong.set(g, (this.perSong.get(g) || 0) + 1);
      if (!this.likedSet.has(g)) {
        this.likedSet.add(g);
        this.likedIds.push(g);
      }
    }
  }

  /**
   * The likes moved: added (a trackId now at the head of p.likes) and removed (trackIds gone). A
   * like newer than every other one is the first in time order whatever the order of the rest,
   * and a removal of a song's only like takes just that song out: those are made in place;
   * anything else makes the likes again.
   */
  likesMoved(p, gid, added, removed) {
    const likes = p.likes;
    const ok = added.length <= 1 && (added.length === 0 || (likes[0] && likes[0].id === added[0] && (likes[0].at || 0) >= this.maxAt));
    if (!ok) return this.likesAll(p, gid);
    if (added.length) this.maxAt = likes[0].at || 0;
    for (const id of removed) {
      if (!this.likeIds.delete(id)) continue;
      const g = gid(id);
      if (!g) continue;
      const n = (this.perSong.get(g) || 0) - 1;
      if (n > 0) return this.likesAll(p, gid);
      this.perSong.delete(g);
      this.likedSet.delete(g);
      const i = this.likedIds.indexOf(g);
      if (i >= 0) this.likedIds.splice(i, 1);
    }
    for (const id of added) {
      this.likeIds.add(id);
      const g = gid(id);
      if (!g) continue;
      this.perSong.set(g, (this.perSong.get(g) || 0) + 1);
      if (this.likedSet.has(g)) {
        const i = this.likedIds.indexOf(g);
        if (i > 0) {
          this.likedIds.splice(i, 1);
          this.likedIds.unshift(g);
        }
      } else {
        this.likedSet.add(g);
        this.likedIds.unshift(g);
      }
    }
    return undefined;
  }

  /** Playlists (and their covers) of these ids moved. */
  playlistsMoved(p, ids) {
    const at = new Map();
    p.playlists.forEach((x) => at.set(x.id, x));
    for (const id of ids) {
      const x = at.get(id);
      if (x) this.playlists.set(id, x);
      else this.playlists.delete(id);
      this._cover(p, id);
    }
  }

  _cover(p, id) {
    const before = this.playlistCover.get(id);
    const exists = this.playlists.has(id);
    const c = exists ? p.covers?.playlist?.[id] : null;
    const ids = (cov) => (cov ? [cov.id, cov.small] : []);
    if (before && c && before.id === c.large && before.small === c.small) return;
    for (const x of ids(before)) {
      const n = (this.coverRefs.get(x) || 0) - 1;
      if (n > 0) this.coverRefs.set(x, n);
      else {
        this.coverRefs.delete(x);
        this.userCoverSrc.delete(x);
      }
    }
    if (!c) {
      this.playlistCover.delete(id);
      return;
    }
    const cov = { id: c.large, small: c.small };
    this.playlistCover.set(id, cov);
    for (const x of ids(cov)) {
      this.coverRefs.set(x, (this.coverRefs.get(x) || 0) + 1);
      if (this.principal) this.userCoverSrc.set(x, [this.principal]);
    }
  }

  /** What comes from the plays (at most 50 of them): made again whole. */
  recentsAll(p, gid) {
    this.lastPlayed.clear();
    this.trackLastPlayed.clear();
    this.playCount.clear();
    for (const r of p.recents) {
      const k = ctxKey(r.context || { type: 'library' });
      if ((this.lastPlayed.get(k) || 0) < r.at) this.lastPlayed.set(k, r.at);
      const g = gid(r.trackId) || r.trackId;
      if ((this.trackLastPlayed.get(g) || 0) < r.at) this.trackLastPlayed.set(g, r.at);
      this.playCount.set(g, (this.playCount.get(g) || 0) + 1);
    }
  }
}
