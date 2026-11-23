// One song, many files: the same recording on several sources is one song on screen, with one
// version per source. Pure functions only (no DOM, no state), so they run anywhere:
//   - fingerprint signatures, bit error rates and the best alignment of two item arrays;
//   - grouping versions into songs (same trackId, same file, or matching signatures);
//   - quality scores and labels, the order versions are tried in, time offsets between files.

/** u32 little endian items from base64; null when it is not base64. */
export function decodeU32(b64) {
  if (typeof b64 !== 'string' || !b64) return null;
  let bin;
  try {
    bin = atob(b64);
  } catch {
    return null;
  }
  const n = bin.length >> 2;
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    out[i] = (bin.charCodeAt(o) | (bin.charCodeAt(o + 1) << 8) | (bin.charCodeAt(o + 2) << 16) | (bin.charCodeAt(o + 3) << 24)) >>> 0;
  }
  return out;
}

/** Number of set bits of a 32 bit value. */
export function popcount32(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return Math.imul(x, 0x01010101) >>> 24;
}

/**
 * The best alignment of two item arrays whose first items sit at raw positions aStart and bStart:
 * for each k in kMin..kMax, raw item r of A pairs with raw item r + k of B wherever both exist,
 * BER = differing bits / (32 x pairs). Offsets with fewer than minPairs pairs do not count.
 * Resolves { ber, k, n } with the lowest BER (on a tie the k nearest 0), or null.
 */
export function align(A, aStart, B, bStart, kMin, kMax, minPairs) {
  let best = null;
  const need = Math.max(1, minPairs);
  for (let k = kMin; k <= kMax; k++) {
    const lo = Math.max(aStart, bStart - k);
    const hi = Math.min(aStart + A.length, bStart + B.length - k);
    const n = hi - lo;
    if (n < need) continue;
    let bits = 0;
    for (let r = lo; r < hi; r++) bits += popcount32((A[r - aStart] ^ B[r + k - bStart]) >>> 0);
    const ber = bits / (32 * n);
    if (!best || ber < best.ber || (ber === best.ber && Math.abs(k) < Math.abs(best.k))) best = { ber, k, n };
  }
  return best;
}

const EPS = 1e-9;
export const SAME_SIG_BER = 0.12;
export const SAME_SIG_SECONDS = 1.5;

/** A track's signature, decoded: { d, b, s } or null. */
export function signatureOf(fp) {
  if (!fp || typeof fp !== 'object') return null;
  const s = decodeU32(fp.s);
  const d = Number(fp.d);
  if (!s || !s.length || !Number.isFinite(d)) return null;
  return { d, b: Math.max(0, Number(fp.b) || 0), s };
}

/** Two signatures at raw offsets -16..16: { ber, k, n } or null. */
export function compareSignatures(a, b) {
  if (!a || !b) return null;
  const minPairs = Math.min(32, Math.floor(0.8 * Math.min(a.s.length, b.s.length)));
  return align(a.s, a.b, b.s, b.b, -16, 16, minPairs);
}

/** Two tracks of different sources are the same song: durations within 1.5 s, BER <= 0.12. */
export function sameSong(a, b) {
  if (!a || !b || Math.abs(a.d - b.d) > SAME_SIG_SECONDS + EPS) return false;
  const r = compareSignatures(a, b);
  return !!r && r.ber <= SAME_SIG_BER + EPS;
}

/**
 * Groups versions into songs. versions: [{ sourceId, trackId, fileHash, order, sig }] where
 * order is the source's place (the principal first) and sig a decoded signature or null.
 * Edges: the same trackId, then the same fileHash, then matching signatures by BER ascending;
 * a union that would put two tracks of one source in a song is refused. Returns arrays of
 * indexes into versions, each sorted by source order.
 */
export function groupVersions(versions) {
  const n = versions.length;
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const srcs = versions.map((v) => new Set([v.sourceId]));
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a, b) => {
    let ra = find(a);
    let rb = find(b);
    if (ra === rb) return true;
    if (srcs[ra].size < srcs[rb].size) [ra, rb] = [rb, ra];
    for (const s of srcs[rb]) if (srcs[ra].has(s)) return false;
    for (const s of srcs[rb]) srcs[ra].add(s);
    parent[rb] = ra;
    srcs[rb] = null;
    return true;
  };
  const sameKey = (key) => {
    const m = new Map();
    versions.forEach((v, i) => {
      const k = key(v);
      if (!k) return;
      const l = m.get(k);
      if (l) l.push(i);
      else m.set(k, [i]);
    });
    for (const l of m.values()) for (let j = 1; j < l.length; j++) union(l[0], l[j]);
  };
  sameKey((v) => v.trackId);
  sameKey((v) => v.fileHash);

  // Signatures: pairs of different sources, by duration, within 1.5 s.
  const idx = [];
  for (let i = 0; i < n; i++) if (versions[i].sig) idx.push(i);
  idx.sort((a, b) => versions[a].sig.d - versions[b].sig.d);
  const edges = [];
  for (let x = 0; x < idx.length; x++) {
    const i = idx[x];
    const si = versions[i].sig;
    for (let y = x + 1; y < idx.length; y++) {
      const j = idx[y];
      const sj = versions[j].sig;
      if (sj.d - si.d > SAME_SIG_SECONDS + EPS) break;
      if (versions[i].sourceId === versions[j].sourceId || find(i) === find(j)) continue;
      const r = compareSignatures(si, sj);
      if (r && r.ber <= SAME_SIG_BER + EPS) edges.push({ i, j, ber: r.ber });
    }
  }
  edges.sort((a, b) => a.ber - b.ber || a.i - b.i || a.j - b.j);
  for (const e of edges) union(e.i, e.j);

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(i);
    else groups.set(r, [i]);
  }
  const byOrder = (a, b) => (versions[a].order ?? 1e9) - (versions[b].order ?? 1e9) || a - b;
  return [...groups.values()].map((g) => g.sort(byOrder)).sort((a, b) => a[0] - b[0]);
}

// ---------------------------------------------------------------------------------------------
// the grouping, kept between changes
//
// The same answer as groupVersions, without comparing again what was compared: the signature
// edges (pairs that are the same song, with their BER) are kept by the versions' keys, and which
// versions were compared with which source. A version is compared only with the versions of OTHER
// sources whose durations are within the window, and only with those that could still join it:
// after the trackId and fileHash unions, a version whose group already holds a version of source
// t never joins one of t (the union would be refused), and a version of t whose group already
// holds one of this version's source never joins it either.

/** The key a version is known by in the grouping cache: its file on its source, and its duration. */
export const versionKey = (sourceId, t) => `${sourceId}:${t.id}:${typeof t.fileHash === 'string' && t.fileHash ? t.fileHash : t.id}:${t.duration}`;
/** The key of a pair of sources (the two ids in order). */
export const pairKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);
const sourceOfKey = (key) => key.slice(0, key.indexOf(':'));

/**
 * The BER compareSignatures gives two signatures when it is within the bar of sameSong, else
 * null. An offset whose differing bits pass the bar stops there; one that stays within it is
 * counted whole, so the best BER is the same number.
 */
export function matchBer(a, b) {
  const A = a.s;
  const B = b.s;
  const need = Math.max(1, Math.min(32, Math.floor(0.8 * Math.min(A.length, B.length))));
  let best = null;
  for (let k = -16; k <= 16; k++) {
    const lo = Math.max(a.b, b.b - k);
    const hi = Math.min(a.b + A.length, b.b + B.length - k);
    const n = hi - lo;
    if (n < need) continue;
    const bar = (SAME_SIG_BER + EPS) * 32 * n;
    let bits = 0;
    let r = lo;
    for (; r < hi; r++) {
      bits += popcount32((A[r - a.b] ^ B[r + k - b.b]) >>> 0);
      if (bits > bar) break;
    }
    if (r < hi) continue;
    const ber = bits / (32 * n);
    if (best === null || ber < best) best = ber;
  }
  return best;
}

/**
 * groupVersions of some versions, with their signature edges already known. recs: in global order
 * (a source's place, then the version's place in its source), each { sourceId, trackId, fileHash,
 * d } (d: the signature's duration, or null); edges: [{ a, b, ber }] between recs. The unions are
 * groupVersions' own, in its order: same trackId, same fileHash, then the edges by BER, then by
 * the place of the first one in duration order. Returns the groups as arrays of recs in global
 * order, the groups in the order of their first rec.
 */
export function groupWithEdges(recs, edges) {
  const n = recs.length;
  const at = new Map();
  recs.forEach((r, i) => at.set(r, i));
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const srcs = recs.map((r) => new Set([r.sourceId]));
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a, b) => {
    let ra = find(a);
    let rb = find(b);
    if (ra === rb) return;
    if (srcs[ra].size < srcs[rb].size) [ra, rb] = [rb, ra];
    for (const s of srcs[rb]) if (srcs[ra].has(s)) return;
    for (const s of srcs[rb]) srcs[ra].add(s);
    parent[rb] = ra;
    srcs[rb] = null;
  };
  const sameKey = (key) => {
    const m = new Map();
    for (let i = 0; i < n; i++) {
      const k = key(recs[i]);
      if (!k) continue;
      const first = m.get(k);
      if (first === undefined) m.set(k, i);
      else union(first, i);
    }
  };
  sameKey((r) => r.trackId);
  sameKey((r) => r.fileHash);
  const list = [];
  for (const e of edges) {
    let i = at.get(e.a);
    let j = at.get(e.b);
    if (i === undefined || j === undefined) continue;
    const di = recs[i].d;
    const dj = recs[j].d;
    if (dj < di || (dj === di && j < i)) [i, j] = [j, i];
    list.push({ i, j, ber: e.ber });
  }
  list.sort((x, y) => x.ber - y.ber || x.i - y.i || x.j - y.j);
  for (const e of list) union(e.i, e.j);
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(recs[i]);
    else groups.set(r, [recs[i]]);
  }
  return [...groups.values()];
}

/**
 * The versions present, the signature edges known among them and which versions were compared
 * with which source. A rec: { key, sourceId, trackId, fileHash, d, gk, sig } where gk is its
 * place in global order, d its signature's duration (null without one) and sig its decoded
 * signature (read only when it is compared).
 */
export class VersionGraph {
  constructor() {
    this.recs = new Map(); // key -> rec
    this.byTrack = new Map(); // trackId -> Set of recs
    this.byFile = new Map(); // fileHash -> Set of recs
    this.bySource = new Map(); // sourceId -> recs with a signature, by duration
    this.adj = new Map(); // key -> Map(other key -> ber): the edges known, by either end
    this.done = new Map(); // pair key -> Set of the keys compared with the pair's other source
    this.journal = new Map(); // pair key -> { edges: Map(edge id -> [a, b, ber] | null), done: Map(key -> true | false) }
    this.comparisons = 0;
  }

  /** What moved in a pair's cache since it was last taken (to save only those chunks). */
  _note(pk) {
    let j = this.journal.get(pk);
    if (!j) this.journal.set(pk, (j = { edges: new Map(), done: new Map() }));
    return j;
  }

  /** Edges and compared keys saved before (a pair's cache read at start): the versions need not exist yet. */
  load(a, b, edges, compared) {
    const pk = pairKey(a, b);
    let set = this.done.get(pk);
    if (!set) this.done.set(pk, (set = new Set()));
    for (const k of compared) set.add(k);
    for (const [ka, kb, ber] of edges) this._link(ka, kb, ber);
  }

  _link(ka, kb, ber) {
    let m = this.adj.get(ka);
    if (!m) this.adj.set(ka, (m = new Map()));
    m.set(kb, ber);
    let o = this.adj.get(kb);
    if (!o) this.adj.set(kb, (o = new Map()));
    o.set(ka, ber);
  }

  _edgeId(ka, kb) {
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  }

  addEdge(a, b, ber) {
    this._link(a.key, b.key, ber);
    const [x, y] = a.key < b.key ? [a.key, b.key] : [b.key, a.key];
    this._note(pairKey(a.sourceId, b.sourceId)).edges.set(`${x}|${y}`, [x, y, ber]);
  }

  isDone(rec, t) {
    const s = this.done.get(pairKey(rec.sourceId, t));
    return !!s && s.has(rec.key);
  }

  _setDone(rec, t, on) {
    const pk = pairKey(rec.sourceId, t);
    let s = this.done.get(pk);
    if (!s) this.done.set(pk, (s = new Set()));
    if (on ? s.has(rec.key) : !s.has(rec.key)) return;
    if (on) s.add(rec.key);
    else s.delete(rec.key);
    this._note(pk).done.set(rec.key, on);
  }

  /** Not compared any more with any source (it changed, or its group lost a member). */
  undo(rec) {
    for (const [pk, s] of this.done) {
      if (!s.has(rec.key)) continue;
      s.delete(rec.key);
      this._note(pk).done.set(rec.key, false);
    }
  }

  add(rec, fresh = true) {
    this.recs.set(rec.key, rec);
    const put = (map, k) => {
      let s = map.get(k);
      if (!s) map.set(k, (s = new Set()));
      s.add(rec);
    };
    put(this.byTrack, rec.trackId);
    put(this.byFile, rec.fileHash);
    if (rec.d !== null) {
      let arr = this.bySource.get(rec.sourceId);
      if (!arr) this.bySource.set(rec.sourceId, (arr = []));
      arr.splice(this._lower(arr, rec.d), 0, rec);
    }
    if (fresh) this.undo(rec);
  }

  /** It leaves: its compared marks and its edges go with it (they are made again if it comes back). */
  remove(rec) {
    if (this.recs.get(rec.key) !== rec) return;
    this.recs.delete(rec.key);
    const drop = (map, k) => {
      const s = map.get(k);
      if (!s) return;
      s.delete(rec);
      if (!s.size) map.delete(k);
    };
    drop(this.byTrack, rec.trackId);
    drop(this.byFile, rec.fileHash);
    if (rec.d !== null) {
      const arr = this.bySource.get(rec.sourceId);
      const i = arr ? arr.indexOf(rec) : -1;
      if (i >= 0) arr.splice(i, 1);
      if (arr && !arr.length) this.bySource.delete(rec.sourceId);
    }
    this.undo(rec);
    const m = this.adj.get(rec.key);
    if (m) {
      for (const other of m.keys()) {
        const o = this.adj.get(other);
        if (o) {
          o.delete(rec.key);
          if (!o.size) this.adj.delete(other);
        }
        const [x, y] = rec.key < other ? [rec.key, other] : [other, rec.key];
        this._note(pairKey(rec.sourceId, sourceOfKey(other))).edges.set(`${x}|${y}`, null);
      }
      this.adj.delete(rec.key);
    }
  }

  _lower(arr, d) {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].d < d) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Every present rec joined to rec by trackIds and fileHashes, rec included. */
  tfComponent(rec) {
    const comp = new Set([rec]);
    const queue = [rec];
    while (queue.length) {
      const r = queue.pop();
      for (const s of [this.byTrack.get(r.trackId), this.byFile.get(r.fileHash)]) {
        if (!s) continue;
        for (const x of s) {
          if (comp.has(x)) continue;
          comp.add(x);
          queue.push(x);
        }
      }
    }
    return comp;
  }

  /** The sources of rec's group after the trackId and fileHash unions (groupVersions' own, refusals included). */
  tfSources(rec, memo) {
    const hit = memo && memo.get(rec);
    if (hit) return hit;
    const comp = this.tfComponent(rec);
    if (comp.size === 1) {
      const one = new Set([rec.sourceId]);
      if (memo) memo.set(rec, one);
      return one;
    }
    const list = [...comp].sort((x, y) => x.gk - y.gk);
    for (const g of groupWithEdges(list, [])) {
      const srcs = new Set(g.map((x) => x.sourceId));
      if (memo) for (const x of g) memo.set(x, srcs);
      if (g.includes(rec) && !memo) return srcs;
    }
    return memo.get(rec);
  }

  /** The versions with a signature not yet compared with every other source, the newest first. */
  pending() {
    const out = [];
    for (const arr of this.bySource.values()) for (const r of arr) if (this.needs(r)) out.push(r);
    return out.sort((x, y) => (y.gk % 4294967296) - (x.gk % 4294967296) || y.gk - x.gk);
  }

  needs(rec) {
    if (rec.d === null) return false;
    for (const t of this.bySource.keys()) if (t !== rec.sourceId && !this.isDone(rec, t)) return true;
    return false;
  }

  /**
   * Compares rec with the window of every source it was not compared with. waiting(w): w is
   * queued to be compared itself (a pair with it is made then). Returns the recs that got an edge
   * (rec among them when any did).
   */
  compare(rec, memo = new Map(), waiting = () => false) {
    const got = [];
    if (rec.d === null || this.recs.get(rec.key) !== rec) return got;
    const mine = this.tfSources(rec, memo);
    for (const [t, arr] of this.bySource) {
      if (t === rec.sourceId || this.isDone(rec, t)) continue;
      if (!mine.has(t)) {
        const sig = rec.sig;
        const lo = rec.d - SAME_SIG_SECONDS - EPS;
        const hi = rec.d + SAME_SIG_SECONDS + EPS;
        for (let i = this._lower(arr, lo); i < arr.length && arr[i].d <= hi; i++) {
          const w = arr[i];
          // A partner waiting for its own turn, not compared with this source yet, meets rec then.
          if ((waiting(w) && !this.isDone(w, rec.sourceId)) || this.tfSources(w, memo).has(rec.sourceId)) continue;
          if (!sig || !w.sig) continue;
          this.comparisons++;
          const ber = matchBer(sig, w.sig);
          if (ber === null) continue;
          this.addEdge(rec, w, ber);
          got.push(w);
        }
      }
      this._setDone(rec, t, true);
    }
    if (got.length) got.push(rec);
    return got;
  }

  /** The present recs joined to rec by a trackId, a fileHash or a known edge. */
  neighbors(rec) {
    const out = [];
    for (const s of [this.byTrack.get(rec.trackId), this.byFile.get(rec.fileHash)]) if (s) for (const x of s) if (x !== rec) out.push(x);
    const m = this.adj.get(rec.key);
    if (m) {
      for (const k of m.keys()) {
        const x = this.recs.get(k);
        if (x) out.push(x);
      }
    }
    return out;
  }

  /** The known edges among these recs, for groupWithEdges. */
  edgesAmong(recs) {
    const inside = new Set(recs);
    const out = [];
    for (const r of recs) {
      const m = this.adj.get(r.key);
      if (!m) continue;
      for (const [k, ber] of m) {
        if (k <= r.key) continue;
        const x = this.recs.get(k);
        if (x && inside.has(x)) out.push({ a: r, b: x, ber });
      }
    }
    return out;
  }

  /** What moved per pair of sources since the last call: { pk: { edges, done } }; the journal is emptied. */
  takeJournal() {
    const j = this.journal;
    this.journal = new Map();
    return j;
  }

  /** Every edge and compared key of a pair (a whole rewrite of its cache). */
  pairState(a, b) {
    const pk = pairKey(a, b);
    const edges = [];
    for (const [k, m] of this.adj) {
      const s = sourceOfKey(k);
      if (s !== a && s !== b) continue;
      for (const [o, ber] of m) {
        if (o <= k) continue;
        const so = sourceOfKey(o);
        if ((s === a && so === b) || (s === b && so === a)) edges.push([k, o, ber]);
      }
    }
    return { edges, compared: [...(this.done.get(pk) || [])] };
  }
}

// ---------------------------------------------------------------------------------------------
// quality

const FACTOR = { mp3: 1, aac: 1.3, vorbis: 1.3, opus: 1.6 };
const FORMAT_CODEC = { mp3: 'mp3', m4a: 'aac', mp4: 'aac', aac: 'aac', ogg: 'vorbis', oga: 'vorbis', opus: 'opus', flac: 'flac', wav: 'wav', wave: 'wav' };

/** mp3 | aac | vorbis | opus | flac | alac | wav (from the format when the source does not say). */
export function codecOf(t) {
  const c = typeof t?.codec === 'string' ? t.codec.toLowerCase() : '';
  if (c) return c;
  const f = String(t?.format || '').toLowerCase();
  if ((f === 'm4a' || f === 'mp4') && t?.lossless) return 'alac';
  return FORMAT_CODEC[f] || f || 'audio';
}

const kbpsOf = (t) => {
  if (Number(t?.bitrate) > 0) return t.bitrate / 1000;
  if (Number(t?.size) > 0 && Number(t?.duration) > 0) return (t.size * 8) / t.duration / 1000;
  return 0;
};

/** The class the source measured from the spectrum (an mp3 bitrate), or 0 when there is none. */
const equivOf = (t) => (Number(t?.equivKbps) > 0 ? Number(t.equivKbps) : 0);

/**
 * The quality score the sources compute, also for a source that does not send it. A lossy file
 * cut lower than its bitrate says scores its class, as an mp3: no codec bonus on top.
 */
export function scoreOf(t) {
  if (Number.isFinite(t?.score)) return t.score;
  if (t?.fakeLossless === true) return equivOf(t);
  if (t?.lossless) return 1000000 + (Number(t.bitDepth) || 16) * 1000 + Math.round((Number(t.sampleRate) || 44100) / 100);
  if (equivOf(t)) return equivOf(t);
  return kbpsOf(t) * (FACTOR[codecOf(t)] || 1);
}

/** "FLAC", "FLAC 24/96", "WAV 24/44,1", "FLAC ~192", "MP3 320", "MP3 ~128", "AAC 256". */
export function qualityLabel(t) {
  const big = codecOf(t).toUpperCase();
  if (t?.fakeLossless === true) return `${big} ~${Math.round(equivOf(t))}`;
  if (t?.lossless) {
    const bd = Number(t.bitDepth) || 16;
    const sr = Number(t.sampleRate) || 44100;
    if (bd > 16 || sr > 48000) {
      const khz = Math.round(sr / 100) / 10;
      return `${big} ${bd}/${String(khz).replace('.', ',')}`;
    }
    return big;
  }
  if (equivOf(t)) return `${big} ~${Math.round(equivOf(t))}`;
  const kbps = Math.round(kbpsOf(t));
  return kbps ? `${big} ${kbps}` : big;
}

/** "Good enough" for a level: the Opus bitrate x 1.6. Max wants the best score present. */
export const LEVEL_SCORE = { low: 76.8, normal: 153.6, high: 256 };

/**
 * Connection order of two sources ({ throughputKbps, rttMs, principal, addedAt }): when both
 * throughputs are known and differ by more than 20%, the faster first; else the lower RTT; else
 * the principal; else the older one.
 */
export function byConnection(a, b) {
  const ta = Number(a?.throughputKbps) || 0;
  const tb = Number(b?.throughputKbps) || 0;
  if (ta > 0 && tb > 0 && Math.max(ta, tb) > 1.2 * Math.min(ta, tb)) return tb - ta;
  const ra = Number.isFinite(a?.rttMs) ? a.rttMs : Infinity;
  const rb = Number.isFinite(b?.rttMs) ? b.rttMs : Infinity;
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (!!a?.principal !== !!b?.principal) return a?.principal ? -1 : 1;
  return (Number(a?.addedAt) || 0) - (Number(b?.addedAt) || 0);
}

/**
 * The order versions are tried in at a level. Max: the best score first (ties by connection),
 * then the rest by score. Other levels: the versions good enough for it, by connection, then the
 * rest by score. info(sourceId) gives what byConnection needs.
 */
export function orderVersions(versions, level, info) {
  const conn = (x, y) => byConnection(info(x.sourceId), info(y.sourceId));
  const scoreDesc = (x, y) => y.score - x.score || conn(x, y);
  let good;
  if (LEVEL_SCORE[level]) good = (v) => v.score >= LEVEL_SCORE[level];
  else {
    const best = versions.reduce((m, v) => Math.max(m, v.score), -Infinity);
    good = (v) => v.score >= best;
  }
  return [...versions.filter(good).sort(conn), ...versions.filter((v) => !good(v)).sort(scoreDesc)];
}

// ---------------------------------------------------------------------------------------------
// time offsets between two files of one song

export const ITEM_MS = 123.81;
export const offsetMs = (k) => Math.round(k * ITEM_MS);
const OFFSET_BER = 0.18;

/** k such that first[i] pairs with other[i + k] (raw fingerprints), or null when they do not align. */
export function rawOffset(first, other) {
  if (!first?.length || !other?.length) return null;
  const minPairs = Math.min(80, Math.floor(0.8 * Math.min(first.length, other.length)));
  const r = align(first, 0, other, 0, -16, 16, minPairs);
  return r && r.ber <= OFFSET_BER ? r.k : null;
}

/** The raw offset k between two signatures (same convention), or null. */
export function signatureOffset(first, other) {
  const r = compareSignatures(first, other);
  return r && r.ber <= OFFSET_BER ? r.k : null;
}
