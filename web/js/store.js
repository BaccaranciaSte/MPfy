// The library: the UNION of the libraries of all sources. The same recording on several sources
// is one song with one version per source (songs.js decides: same trackId, same file, or
// matching fingerprint signatures). A song's id is the trackId of its version on the principal,
// else on the first source in order; its metadata and album come from that version. Playlists,
// likes and recents keep the trackIds they were made with: any version's trackId resolves to its
// song (store.track, store.gid).
//
// User data (playlists, likes, recents, playlist covers, the played outbox) is the person's own
// and comes from and goes to the PRINCIPAL source. Track and album custom covers live on each
// source, shared by everyone there; the union takes them from the first source that has one.
//
// Per source the store keeps what the source CONFIRMED, at its versions and their epochs, and the
// changes made here still on their way (operations, one per request, each with the source's own
// rule). What is shown is the confirmed state with those operations laid on it, in order. A
// source's answer is a patch of the confirmed state: only what moved since the versions held,
// when the source can prove them (a whole part otherwise, and from a source of before that). The
// lists the page reads are patched in place, and the union and its indexes follow only what
// moved (merge.js). An operation leaves when the confirmed state reaches the version its answer
// named, or rolls back alone when its request fails. A library answer that comes while a change
// of that source is on its way waits for it, so a change is never laid on an answer that already
// holds it. Only the confirmed state is kept in IndexedDB, in chunks (libcache.js).
//
// A removed source takes its tracks away, except the downloaded ones ("I brani scaricati restano
// sul telefono"): those stay in the union with no source, playable from the download.

import { srcApi, errorText, versionsOf } from './api.js';
import { coverHref } from './media.js';
import { sources, localRequest, PHONE_ID } from './sources.js';
import { idbGet, idbSet } from './idb.js';
import { debounce, lsGet, lsSet } from './util.js';
import { Union, UserIndex, albumIdOf, wasOf } from './merge.js';
import { createLibCache, newTouched } from './libcache.js';
import { rebaseOrder, removalSlots, countIds } from './userops.js';
import { toast } from '../components/toast.js';

const COVER_KINDS = ['track', 'album', 'playlist'];
const ID_RE = /^[0-9a-f]{8,32}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const BULK_LIKES = 5000;
const SLICE_MS = 8;
// A union this small is made again at once (a few ms), and its few new versions compared at once:
// the page never shows it half made. A bigger one is made in slices.
const SMALL_UNION = 2000;
const FEW_TO_COMPARE = 64;

const states = new Map(); // source id -> its state (below)
const fetched = new Set(); // sources that answered in this session
const detailsSeq = new Map(); // source id -> the last "Cerca i dettagli in rete" tap
const offline = new Map(); // track id -> track of a removed source (with _src), kept while downloaded
let keepOffline = () => false; // set by downloads.js (the app only): (track) => downloaded
let offlineKey = '';
let loaded = false; // we have a library (from cache or network)
const listeners = new Set();
const arr = (v) => (Array.isArray(v) ? v : []);
const now = () => Date.now();
const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function emptyView() {
  return { version: 0, userVersion: 0, tracks: [], playlists: [], likes: [], recents: [], covers: { track: {}, album: {}, playlist: {} }, you: null, source: null };
}

function newState(id) {
  return {
    id,
    known: false, // a library came (cached or fetched)
    // what the source confirmed
    version: 0,
    epoch: null,
    userVersion: 0,
    userEpoch: null,
    etag: null,
    tracks: new Map(), // id -> track, the source's order
    trackCovers: new Map(),
    albumCovers: new Map(),
    playlists: new Map(),
    likes: new Map(), // id -> at, the oldest first
    recents: [],
    playlistCovers: new Map(),
    you: null,
    source: null,
    // what is shown: the confirmed state with the operations laid on it (libOf)
    view: emptyView(),
    vtrack: new Map(), // id -> shown track
    vpl: new Map(), // playlist id -> how many shown
    vlike: new Set(), // the ids of the shown likes
    seq: new Map(), // track id -> its place in the source (rising along view.tracks)
    seqNext: 0,
    albumIdx: null, // album id -> { n, notMine } of the shown tracks, made when first asked
    ops: [], // the operations on their way, in order
    inflight: 0, // changes sent whose answer is not in
    waiters: [],
    reqSeq: 0, // library requests sent
    fetching: null,
    again: false,
  };
}

const stateOf = (src) => {
  let S = states.get(src);
  if (!S) states.set(src, (S = newState(src)));
  return S;
};
const known = (src) => {
  const S = states.get(src);
  return S && S.known ? S : null;
};

function normCover(v) {
  const small = typeof v?.small === 'string' ? v.small : null;
  const large = typeof v?.large === 'string' ? v.large : null;
  return small || large ? { small: small || large, large: large || small } : null;
}

function normCovers(c) {
  const out = { track: {}, album: {}, playlist: {} };
  for (const kind of COVER_KINDS) {
    const m = c?.[kind];
    if (!m || typeof m !== 'object') continue;
    for (const [id, v] of Object.entries(m)) {
      const n = normCover(v);
      if (n) out[kind][id] = n;
    }
  }
  return out;
}

const normPlaylist = (p) => ({ ...p, trackIds: arr(p.trackIds), description: p.description || '' });
const okTrack = (t) => t && typeof t.id === 'string';
const okPlaylist = (p) => p && typeof p.id === 'string';
const okRecent = (r) => r && typeof r.trackId === 'string';

/** { name, named, details }: details is the owner's "Cerca i dettagli in rete", null when the source does not say. */
function normSource(s) {
  if (!s || typeof s !== 'object') return null;
  return { name: String(s.name || ''), named: !!s.named, details: typeof s.details === 'boolean' ? s.details : null };
}
const normYou = (you) => (you && typeof you === 'object' ? { profileId: typeof you.profileId === 'string' ? you.profileId : null, role: you.role === 'owner' || you.role === 'member' ? you.role : null } : null);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------------------------------
// the shown state, changed only through these steps: each notes what moved and, while an
// operation is being laid, how to take it back

let laying = null; // the operation being laid
let dirty = newDirty();
let moved = false; // the shown state moved since the last emit

function newDirty() {
  return { tracks: [], trackCovers: [], albumCovers: new Set(), whole: false, user: new Map() };
}
function userDirt(S) {
  let u = dirty.user.get(S.id);
  if (!u) dirty.user.set(S.id, (u = { playlists: new Set(), likesAdded: [], likesRemoved: [], likesAll: false, recents: false }));
  return u;
}
const undoable = (fn) => {
  moved = true;
  if (laying) laying.undo.push(fn);
};

function idxIn(S, t, k) {
  if (!S.albumIdx || !t) return;
  const id = albumIdOf(t);
  const e = S.albumIdx.get(id) || { n: 0, notMine: 0 };
  e.n += k;
  if (t.mine !== true) e.notMine += k;
  if (e.n > 0) S.albumIdx.set(id, e);
  else S.albumIdx.delete(id);
}

function setTrack(S, i, t) {
  const old = S.view.tracks[i];
  S.view.tracks[i] = t;
  if (old.id !== t.id) S.vtrack.delete(old.id);
  S.vtrack.set(t.id, t);
  idxIn(S, old, -1);
  idxIn(S, t, 1);
  dirty.tracks.push([S.id, t.id]);
  if (old.id !== t.id) dirty.tracks.push([S.id, old.id]);
  undoable(() => setTrack(S, i, old));
}
function insTrack(S, i, t) {
  S.view.tracks.splice(i, 0, t);
  S.vtrack.set(t.id, t);
  if (!S.seq.has(t.id)) S.seq.set(t.id, ++S.seqNext);
  idxIn(S, t, 1);
  dirty.tracks.push([S.id, t.id]);
  undoable(() => delTrack(S, i));
}
function delTrack(S, i) {
  const [t] = S.view.tracks.splice(i, 1);
  S.vtrack.delete(t.id);
  idxIn(S, t, -1);
  dirty.tracks.push([S.id, t.id]);
  undoable(() => insTrack(S, i, t));
}
const trackIndex = (S, id) => {
  const t = S.vtrack.get(id);
  return t ? S.view.tracks.indexOf(t) : -1;
};

function plCount(S, id, k) {
  const n = (S.vpl.get(id) || 0) + k;
  if (n > 0) S.vpl.set(id, n);
  else S.vpl.delete(id);
}
function setPl(S, i, p) {
  const old = S.view.playlists[i];
  S.view.playlists[i] = p;
  plCount(S, old.id, -1);
  plCount(S, p.id, 1);
  userDirt(S).playlists.add(p.id).add(old.id);
  undoable(() => setPl(S, i, old));
}
function insPl(S, i, p) {
  S.view.playlists.splice(i, 0, p);
  plCount(S, p.id, 1);
  userDirt(S).playlists.add(p.id);
  undoable(() => delPl(S, i));
}
function delPl(S, i) {
  const [p] = S.view.playlists.splice(i, 1);
  plCount(S, p.id, -1);
  userDirt(S).playlists.add(p.id);
  undoable(() => insPl(S, i, p));
}
const plIndex = (S, id) => S.view.playlists.findIndex((p) => p.id === id);

function insLike(S, i, like) {
  S.view.likes.splice(i, 0, like);
  S.vlike.add(like.id);
  const u = userDirt(S);
  if (i === 0) u.likesAdded.push(like.id);
  else u.likesAll = true;
  undoable(() => delLike(S, i));
}
function delLike(S, i) {
  const [like] = S.view.likes.splice(i, 1);
  S.vlike.delete(like.id);
  userDirt(S).likesRemoved.push(like.id);
  undoable(() => insLike(S, i, like));
}

function setRecents(S, list) {
  const old = S.view.recents.slice();
  S.view.recents.splice(0, S.view.recents.length, ...list);
  userDirt(S).recents = true;
  undoable(() => setRecents(S, old));
}

function setCover(S, kind, id, v) {
  const m = S.view.covers[kind];
  const old = m[id];
  if (v) m[id] = v;
  else delete m[id];
  if (kind === 'track') dirty.trackCovers.push([S.id, id]);
  else if (kind === 'album') dirty.albumCovers.add(id);
  else userDirt(S).playlists.add(id);
  undoable(() => setCover(S, kind, id, old));
}

function setField(S, f, v) {
  const old = S.view[f];
  S.view[f] = v;
  undoable(() => setField(S, f, old));
}

// ---------------------------------------------------------------------------------------------
// operations: a change on its way, laid on the confirmed state by the source's own rule

function layOne(S, op) {
  op.undo = [];
  laying = op;
  try {
    op.lay(S);
  } catch (err) {
    console.error('store operation', err);
  } finally {
    laying = null;
  }
}
function unlayAll(S) {
  laying = null;
  for (let i = S.ops.length - 1; i >= 0; i--) {
    const u = S.ops[i].undo || [];
    for (let j = u.length - 1; j >= 0; j--) u[j]();
    S.ops[i].undo = [];
  }
}
function layAll(S) {
  for (const op of S.ops) layOne(S, op);
}
/** Takes away the operations pred names (and lays the others again). */
function dropOps(S, pred) {
  if (!S.ops.some(pred)) return false;
  unlayAll(S);
  S.ops = S.ops.filter((o) => !pred(o));
  layAll(S);
  return true;
}
function addOp(S, op) {
  op.settled = false;
  op.hdr = null;
  op.settledAt = 0;
  S.ops.push(op);
  layOne(S, op);
}
/** Its answer came: the versions it named (or none), and the library requests sent so far. */
function settle(S, op, hdr) {
  op.settled = true;
  op.hdr = hdr;
  op.settledAt = S.reqSeq;
  if (S.ops.includes(op) && reached(S, op)) dropOps(S, (o) => o === op);
}
/** The confirmed state holds what the operation's answer said. */
function reached(S, op) {
  const h = op.hdr;
  if (!h) return false;
  if (h.ue && (S.userEpoch !== h.ue || S.userVersion < h.uv)) return false;
  if (h.e && (S.epoch !== h.e || S.version < h.v)) return false;
  return true;
}
/**
 * After an answer to library request q: an operation leaves when the confirmed state reached its
 * versions; when it named none (a source of before them), at the first answer to a request sent
 * after it settled; when it did and the epoch is another one (the source restarted), also then.
 */
function dropSettled(S, q) {
  return dropOps(S, (o) => {
    if (!o.settled) return false;
    if (reached(S, o)) return true;
    if (q <= o.settledAt) return false;
    if (!o.hdr) return true;
    return (!!o.hdr.ue && o.hdr.ue !== S.userEpoch) || (!!o.hdr.e && o.hdr.e !== S.epoch);
  });
}

function opLike(id, at) {
  return {
    kind: 'like',
    lay(S) {
      if (!S.vlike.has(id)) insLike(S, 0, { id, at });
    },
  };
}
function opUnlike(ids) {
  const set = new Set(ids);
  return {
    kind: 'unlike',
    lay(S) {
      if (![...set].some((x) => S.vlike.has(x))) return;
      for (let i = S.view.likes.length - 1; i >= 0; i--) if (set.has(S.view.likes[i].id)) delLike(S, i);
    },
  };
}
/** A change of one playlist (fields: name, description, trackIds with base) at time at. */
function opPlaylist(id, fields, at) {
  return {
    kind: 'playlist',
    lay(S) {
      const i = plIndex(S, id);
      if (i < 0) return;
      const p = S.view.playlists[i];
      const next = { ...p, updatedAt: at };
      if (fields.name !== undefined) next.name = fields.name;
      if (fields.description !== undefined) next.description = fields.description;
      if (fields.trackIds !== undefined) next.trackIds = fields.base ? rebaseOrder(p.trackIds, fields.base, fields.trackIds) : fields.trackIds.slice();
      setPl(S, i, next);
    },
  };
}
function opAdd(id, ids, position, at) {
  return {
    kind: 'add',
    lay(S) {
      const i = plIndex(S, id);
      if (i < 0) return;
      const p = S.view.playlists[i];
      const pos = position == null ? p.trackIds.length : Math.min(position, p.trackIds.length);
      setPl(S, i, { ...p, trackIds: [...p.trackIds.slice(0, pos), ...ids, ...p.trackIds.slice(pos)], updatedAt: at });
    },
  };
}
function opRemove(id, indexes, ids, counts, at) {
  return {
    kind: 'remove',
    lay(S) {
      const i = plIndex(S, id);
      if (i < 0) return;
      const p = S.view.playlists[i];
      const drop = ids ? removalSlots(p.trackIds, indexes, ids, counts) : new Set(indexes.filter((x) => x < p.trackIds.length));
      if (!drop.size) return;
      setPl(S, i, { ...p, trackIds: p.trackIds.filter((_, k) => !drop.has(k)), updatedAt: at });
    },
  };
}
function opCreate(p) {
  return {
    kind: 'create',
    lay(S) {
      if (plIndex(S, p.id) < 0) insPl(S, S.view.playlists.length, p);
    },
  };
}
function opDelete(id) {
  return {
    kind: 'delete',
    lay(S) {
      for (let i = S.view.playlists.length - 1; i >= 0; i--) if (S.view.playlists[i].id === id) delPl(S, i);
    },
  };
}
/** A track's fields (fn(track) -> the new track, or null for none). */
function opTrack(trackId, fn) {
  return {
    kind: 'track',
    fn,
    lay(S) {
      const i = trackIndex(S, trackId);
      if (i < 0) return;
      const t = this.fn(S.view.tracks[i]);
      if (t) setTrack(S, i, t);
    },
  };
}
/** The track leaves this source's library, with the person's references to it there. */
function opTrackGone(X) {
  return {
    kind: 'gone',
    lay(S) {
      const i = trackIndex(S, X);
      if (i >= 0) delTrack(S, i);
      if (S.vlike.has(X)) for (let k = S.view.likes.length - 1; k >= 0; k--) if (S.view.likes[k].id === X) delLike(S, k);
      S.view.playlists.forEach((p, k) => {
        if (p.trackIds.includes(X)) setPl(S, k, { ...p, trackIds: p.trackIds.filter((t) => t !== X) });
      });
      if (S.view.recents.some((r) => r.trackId === X)) setRecents(S, S.view.recents.filter((r) => r.trackId !== X));
    },
  };
}
/** The custom covers of the source as a change answered them (the whole map). */
function opCovers(covers) {
  return {
    kind: 'covers',
    lay(S) {
      for (const kind of COVER_KINDS) {
        const m = S.view.covers[kind];
        for (const id of Object.keys(m)) if (!covers[kind][id]) setCover(S, kind, id, undefined);
        for (const [id, v] of Object.entries(covers[kind])) if (!same(m[id], v)) setCover(S, kind, id, v);
      }
    },
  };
}
function opDetails(value) {
  return {
    kind: 'details',
    value,
    lay(S) {
      if (S.view.source) setField(S, 'source', { ...S.view.source, ...this.value });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// the union and the person's indexes

const union = new Union({
  order: () => sources.music().map((s) => s.id).filter((id) => known(id)),
  tracksOf: (sid) => states.get(sid).view.tracks,
  trackOf: (sid, id) => states.get(sid)?.vtrack.get(id),
  seqOf: (sid, id) => states.get(sid)?.seq.get(id) || 0,
  coversOf: (sid) => known(sid)?.view.covers || null,
  kept: () => [...offline.values()].filter((t) => keepOffline(t)),
});
const user = new UserIndex();
const EMPTY = emptyView();
let lib = { ...EMPTY, principal: null };
let derived = null;
let userFor; // the principal the person's indexes were made from
let job = null; // a whole union being made in slices
let jobAgain = null;
let jobWaiters = [];
let deferred = newDirty();
let comparing = null;
let changedSeq = 0;
let changing = { all: true, songs: new Set(), albums: new Set(), artists: new Set(), playlists: new Set(), likes: true, recents: true };
let changedNow = freeze(changing);
let likedMemo = null;
let likesSeq = 0;
let songsSeq = 0;

function freeze(c) {
  changedSeq++;
  return Object.freeze({ seq: changedSeq, all: c.all, songs: Object.freeze(c.songs), albums: Object.freeze(c.albums), artists: Object.freeze(c.artists), playlists: Object.freeze(c.playlists), likes: c.likes, recents: c.recents });
}
const freshChanging = () => ({ all: false, songs: new Set(), albums: new Set(), artists: new Set(), playlists: new Set(), likes: false, recents: false });

// The home of the person's data: the phone's store while the core says it holds it (no real source,
// or a move still due), else the real principal. Locale itself is never principal.
const principalId = () => (sources.phone?.home ? PHONE_ID : sources.principal()?.id || null);
const gid = (id) => derived.tracks.get(id)?.id || null;

function makeDerived() {
  derived = {
    ...union.d,
    likedSet: user.likedSet,
    likedIds: user.likedIds,
    playlists: user.playlists,
    playlistCover: user.playlistCover,
    userCoverSrc: user.userCoverSrc,
    lastPlayed: user.lastPlayed,
    trackLastPlayed: user.trackLastPlayed,
    playCount: user.playCount,
  };
}

function makeLib() {
  const p = principalId();
  const P = (p && known(p)) || null;
  const v = P ? P.view : EMPTY;
  lib = { version: P ? P.version : 0, tracks: union.songs, playlists: v.playlists, likes: v.likes, recents: v.recents, covers: v.covers, principal: p };
}

function emit() {
  moved = false;
  changedNow = freeze(changing);
  changing = freshChanging();
  for (const fn of listeners) {
    try {
      fn();
    } catch (err) {
      console.error('store listener', err);
    }
  }
}

/** What the person's indexes need after the union moved: the likes and plays read through the song ids. */
function userAfterUnion(c) {
  const p = principalId();
  const P = p && known(p);
  if (!P) return;
  // Only a liked trackId whose song id moved moves the liked songs.
  let likes = false;
  for (const id of c.moved) {
    if (user.likeIds.has(id)) {
      likes = true;
      break;
    }
  }
  if (likes) {
    user.likesAll(P.view, gid);
    changing.likes = true;
    likesSeq++;
  }
  user.recentsAll(P.view, gid);
}

/** The person's indexes follow what moved in the principal's shown library. */
function userFlush() {
  const p = principalId();
  const P = p && known(p);
  const u = p ? dirty.user.get(p) : null;
  dirty.user.clear();
  if (userFor !== p || !P) {
    // Another principal (or the first, or none yet): the person's indexes made again.
    const other = userFor !== p;
    userFor = p;
    user.whole(P ? P.view : EMPTY, p, gid);
    if (other || u) {
      changing.likes = true;
      changing.recents = true;
      changing.all = true;
      likesSeq++;
    }
    return;
  }
  if (!u) return;
  if (u.likesAll) user.likesAll(P.view, gid);
  else if (u.likesAdded.length || u.likesRemoved.length) {
    // A like taken back and given again in one step cancels out where it can.
    const seen = new Map();
    for (const id of u.likesRemoved) seen.set(id, (seen.get(id) || 0) - 1);
    for (const id of u.likesAdded) seen.set(id, (seen.get(id) || 0) + 1);
    const added = [];
    const removed = [];
    for (const [id, n] of seen) {
      if (n > 0) added.push(id);
      else if (n < 0) removed.push(id);
    }
    if (added.length > 1 || seen.size !== added.length + removed.length) user.likesAll(P.view, gid);
    else user.likesMoved(P.view, gid, added, removed);
  }
  if (u.likesAll || u.likesAdded.length || u.likesRemoved.length) {
    changing.likes = true;
    likesSeq++;
  }
  if (u.playlists.size) {
    user.playlistsMoved(P.view, u.playlists);
    for (const id of u.playlists) changing.playlists.add(id);
  }
  if (u.recents) {
    user.recentsAll(P.view, gid);
    changing.recents = true;
  }
}

function takeUnionChanges() {
  const c = union.takeChanged();
  if (c.all) changing.all = true;
  for (const id of c.songs) changing.songs.add(id);
  for (const id of c.albums) changing.albums.add(id);
  for (const id of c.artists) changing.artists.add(id);
  if (c.all || c.songs.size) songsSeq++;
  return c;
}

/** What moved since the last flush reaches the union, the indexes and the page. */
function flush() {
  const d = dirty;
  dirty = newDirty();
  dirty.user = d.user;
  if (d.whole && !job && unionSize() <= SMALL_UNION) {
    union.wholeNow();
    finishWhole();
  } else if (d.whole || job) {
    for (const x of d.tracks) deferred.tracks.push(x);
    for (const x of d.trackCovers) deferred.trackCovers.push(x);
    for (const x of d.albumCovers) deferred.albumCovers.add(x);
    if (d.whole) startWhole();
  } else if (d.tracks.length || d.trackCovers.length || d.albumCovers.size) {
    union.patch({ tracks: d.tracks, trackCovers: d.trackCovers, albumCovers: d.albumCovers });
    const c = takeUnionChanges();
    if (c.moved.size) userAfterUnion(c);
    noteEdges();
    if (union.comparing) compareSoon();
  }
  userFlush();
  makeLib();
  const c = changing;
  if (loaded && (moved || c.all || c.songs.size || c.albums.size || c.artists.size || c.playlists.size || c.likes || c.recents)) emit();
}

/**
 * Everything made again (a new order, a new principal, a whole answer, the start), in slices.
 * Asked again while it runs: once more after it. Asked twice in one turn: once.
 */
function startWhole(trust = false) {
  if (job) {
    if (job !== 'soon') jobAgain = jobAgain || { trust };
    return;
  }
  job = 'soon';
  setTimeout(() => runWhole(trust), 0);
}
function runWhole(trust) {
  const it = union.whole({ trust });
  job = it;
  const step = () => {
    const t0 = clock();
    let done = false;
    while (!(done = it.next().done)) if (clock() - t0 > SLICE_MS) break;
    if (!done) {
      setTimeout(step, 0);
      return;
    }
    job = null;
    finishWhole();
    userFlush();
    makeLib();
    emit();
    if (jobAgain) {
      const again = jobAgain;
      jobAgain = null;
      startWhole(again.trust);
    } else {
      const w = jobWaiters;
      jobWaiters = [];
      for (const fn of w) fn();
    }
  };
  step();
}
const unionIdle = () => (job ? new Promise((r) => jobWaiters.push(r)) : Promise.resolve());

function unionSize() {
  let n = offline.size;
  for (const S of states.values()) if (S.known) n += S.view.tracks.length;
  return n;
}

/** After the union was made again: the indexes read from it, what moved meanwhile laid on it. */
function finishWhole() {
  takeUnionChanges();
  makeDerived();
  userFor = undefined;
  const d = deferred;
  deferred = newDirty();
  if (d.tracks.length || d.trackCovers.length || d.albumCovers.size) {
    union.patch({ tracks: d.tracks, trackCovers: d.trackCovers, albumCovers: d.albumCovers });
    takeUnionChanges();
  }
  if (union.queue.length <= FEW_TO_COMPARE) {
    while (union.compareSome(1000));
    takeUnionChanges();
  }
  changing.all = true;
  loaded = true;
  noteEdges();
  if (union.comparing) compareSoon();
}

/** Versions not compared yet (a source paired, a cold cache): compared in slices, the newest first. */
function compareSoon() {
  if (comparing) return;
  comparing = setTimeout(() => {
    comparing = null;
    if (job) {
      compareSoon();
      return;
    }
    const more = union.compareSome(SLICE_MS);
    const c = takeUnionChanges();
    if (c.songs.size) {
      if (c.moved.size) userAfterUnion(c);
      makeLib();
      emit();
    }
    noteEdges();
    if (more) compareSoon();
  }, 0);
}

// ---------------------------------------------------------------------------------------------
// the cache

const cache = createLibCache({
  state: (src) => {
    const S = known(src);
    if (!S) return null;
    return { version: S.version, epoch: S.epoch, userVersion: S.userVersion, userEpoch: S.userEpoch, etag: S.etag, you: S.you, source: S.source, tracks: S.tracks, trackCovers: S.trackCovers, albumCovers: S.albumCovers, playlists: S.playlists, likes: S.likes, recents: S.recents, playlistCovers: S.playlistCovers };
  },
  pair: (a, b) => union.graph.pairState(a, b),
});
function noteEdges() {
  const j = union.graph.takeJournal();
  if (j.size) cache.noteEdges(j, [...states.keys()].filter((id) => known(id)));
}
const saveOffline = () => idbSet('offline', [...offline.values()]);

// ---------------------------------------------------------------------------------------------
// answers

const mapOf = (o) => {
  const m = new Map();
  if (o && typeof o === 'object') {
    for (const [k, v] of Object.entries(o)) {
      const n = normCover(v);
      if (n) m.set(k, n);
    }
  }
  return m;
};

/**
 * Applies a source's answer to its confirmed state and to what is shown (no operation laid):
 * every removal first, then every change and addition; a key the state does not hold goes after
 * every one it holds. Returns what to write in the cache.
 */
function applyAnswer(S, a) {
  const t = newTouched();
  const v = S.view;
  const isDelta = !!a && typeof a.delta === 'object' && a.delta !== null;
  const tr = a?.tracks;
  const keepShared = tr === null && S.known;
  if (keepShared) {
    /* the shared part held is current */
  } else if (isDelta && a.delta.shared === true && tr && typeof tr === 'object' && !Array.isArray(tr)) {
    const gone = arr(tr.removed).filter((id) => typeof id === 'string' && S.tracks.has(id));
    if (gone.length > 32) {
      // Many at once: one pass over the shown tracks.
      const out = new Set(gone);
      let w = 0;
      for (const x of v.tracks) if (!out.has(x.id)) v.tracks[w++] = x;
      v.tracks.length = w;
      S.albumIdx = null;
      moved = true;
    }
    for (const id of gone) {
      S.tracks.delete(id);
      if (gone.length > 32) {
        S.vtrack.delete(id);
        dirty.tracks.push([S.id, id]);
      } else {
        const i = trackIndex(S, id);
        if (i >= 0) delTrack(S, i);
      }
      S.seq.delete(id);
      t.removed.add(id);
    }
    for (const x of arr(tr.changed)) {
      if (!okTrack(x)) continue;
      if (S.tracks.has(x.id)) {
        S.tracks.set(x.id, x);
        const i = trackIndex(S, x.id);
        if (i >= 0) setTrack(S, i, x);
      } else {
        S.tracks.set(x.id, x);
        S.seq.set(x.id, ++S.seqNext);
        insTrack(S, v.tracks.length, x);
      }
      t.tracks.add(x.id);
    }
    for (const kind of ['track', 'album']) {
      const moved = a.covers?.[kind];
      if (!moved || typeof moved !== 'object') continue;
      const m = kind === 'track' ? S.trackCovers : S.albumCovers;
      for (const [id, x] of Object.entries(moved)) {
        const c = normCover(x);
        if (c) m.set(id, c);
        else m.delete(id);
        setCover(S, kind, id, c || undefined);
        t.covers = true;
      }
    }
  } else {
    // The whole shared part: the shown tracks follow it in place, the union is made again.
    S.tracks = new Map();
    S.seq = new Map();
    S.seqNext = 0;
    v.tracks.length = 0;
    S.vtrack.clear();
    S.albumIdx = null;
    for (const x of arr(tr)) {
      if (!okTrack(x) || S.tracks.has(x.id)) continue;
      S.tracks.set(x.id, x);
      S.seq.set(x.id, ++S.seqNext);
      v.tracks.push(x);
      S.vtrack.set(x.id, x);
    }
    const c = normCovers(a?.covers);
    S.trackCovers = new Map(Object.entries(c.track));
    S.albumCovers = new Map(Object.entries(c.album));
    for (const kind of ['track', 'album']) {
      const m = v.covers[kind];
      for (const k of Object.keys(m)) delete m[k];
      Object.assign(m, c[kind]);
    }
    dirty.whole = true;
    moved = true;
    t.all = true;
  }
  S.version = Number(a?.version) || (keepShared ? S.version : 0);
  S.epoch = isDelta && HEX16.test(a.epochs?.shared || '') ? a.epochs.shared : null;

  if (isDelta && a.delta.user === true) {
    const pl = a.playlists && typeof a.playlists === 'object' ? a.playlists : {};
    for (const id of arr(pl.removed)) {
      if (!S.playlists.delete(id)) continue;
      const i = plIndex(S, id);
      if (i >= 0) delPl(S, i);
      t.playlists.add(id);
    }
    for (const raw of arr(pl.changed)) {
      if (!okPlaylist(raw)) continue;
      const p = normPlaylist(raw);
      const i = S.playlists.has(p.id) ? plIndex(S, p.id) : -1;
      S.playlists.set(p.id, p);
      if (i >= 0) setPl(S, i, p);
      else insPl(S, v.playlists.length, p);
      t.playlists.add(p.id);
    }
    const lk = a.likes && typeof a.likes === 'object' ? a.likes : {};
    const unliked = arr(lk.removed).filter((id) => S.likes.delete(id));
    if (unliked.length > 32) {
      // Many at once: one pass over the shown likes.
      const out = new Set(unliked);
      let w = 0;
      for (const x of v.likes) if (!out.has(x.id)) v.likes[w++] = x;
      v.likes.length = w;
      for (const id of unliked) S.vlike.delete(id);
      userDirt(S).likesAll = true;
      moved = true;
    } else {
      for (const id of unliked) {
        const i = v.likes.findIndex((x) => x.id === id);
        if (i >= 0) delLike(S, i);
      }
    }
    for (const id of unliked) t.likesRemoved.add(id);
    const fresh = arr(lk.added).filter((x) => x && typeof x.id === 'string' && !S.likes.has(x.id) && S.likes.set(x.id, x.at)); // held already: dropped
    if (fresh.length > 32) {
      // Many at once: one move of the shown likes, each the newest in turn.
      v.likes.splice(0, 0, ...fresh.map((x) => ({ id: x.id, at: x.at })).reverse());
      for (const x of fresh) S.vlike.add(x.id);
      userDirt(S).likesAll = true;
      moved = true;
    } else for (const x of fresh) insLike(S, 0, { id: x.id, at: x.at });
    for (const x of fresh) t.likesAdded.add(x.id);
    if (Array.isArray(a.recents)) {
      S.recents = a.recents.filter(okRecent);
      setRecents(S, S.recents);
      t.recents = true;
    }
    const moved = a.covers?.playlist;
    if (moved && typeof moved === 'object') {
      for (const [id, x] of Object.entries(moved)) {
        const c = normCover(x);
        if (c) S.playlistCovers.set(id, c);
        else S.playlistCovers.delete(id);
        setCover(S, 'playlist', id, c || undefined);
        t.plCovers = true;
      }
    }
  } else {
    // The whole part of the person, as listed (a playlist listed twice shows twice, as it always
    // did; a like listed twice, by a walk while it moved, is kept once).
    S.playlists = new Map();
    v.playlists.length = 0;
    S.vpl.clear();
    for (const raw of arr(a?.playlists)) {
      if (!okPlaylist(raw)) continue;
      const p = normPlaylist(raw);
      S.playlists.set(p.id, p);
      v.playlists.push(p);
      plCount(S, p.id, 1);
    }
    const seen = S.vlike;
    seen.clear();
    v.likes.length = 0;
    for (const x of arr(a?.likes)) {
      if (!x || typeof x.id !== 'string' || seen.has(x.id)) continue;
      seen.add(x.id);
      v.likes.push(x);
    }
    S.likes = new Map();
    for (let i = v.likes.length - 1; i >= 0; i--) S.likes.set(v.likes[i].id, v.likes[i].at);
    S.recents = arr(a?.recents).filter(okRecent);
    v.recents.splice(0, v.recents.length, ...S.recents);
    S.playlistCovers = mapOf(a?.covers?.playlist);
    const m = v.covers.playlist;
    for (const k of Object.keys(m)) delete m[k];
    for (const [k, c] of S.playlistCovers) m[k] = c;
    const u = userDirt(S);
    u.likesAll = true;
    u.recents = true;
    for (const p of v.playlists) u.playlists.add(p.id);
    for (const k of Object.keys(m)) u.playlists.add(k);
    t.userAll = true;
    moved = true;
  }
  S.userVersion = Number(a?.userVersion) || 0;
  S.userEpoch = isDelta && HEX16.test(a.epochs?.user || '') ? a.epochs.user : null;
  S.you = normYou(a?.you);
  S.source = normSource(a?.source);
  if (!same(v.you, S.you)) setField(S, 'you', S.you);
  if (!same(v.source, S.source)) setField(S, 'source', S.source);
  v.version = S.version;
  v.userVersion = S.userVersion;
  if (!S.known) dirty.whole = true;
  S.known = true;
  return t;
}

/** One library request to src, and its answer applied (or held, dropped and asked again). */
async function fetchOnce(S) {
  const base = { have: S.known ? S.version : 0, he: S.epoch, uv: S.userVersion, ue: S.userEpoch };
  const q = ++S.reqSeq;
  let r;
  try {
    r = await srcApi(S.id).library(S.known ? S.etag : null, S.known ? base : null);
  } catch {
    return false; // unreachable: keep what we have; the banner and the dimmed rows say so
  }
  fetched.add(S.id);
  // An answer that comes while a change of this source is on its way waits for it.
  while (S.inflight > 0) await new Promise((res) => S.waiters.push(res));
  if (states.get(S.id) !== S) return false;
  // A change that settled with no versions after this request left may or may not be in it.
  if (S.ops.some((o) => o.settled && !o.hdr && q <= o.settledAt)) {
    S.again = true;
    return false;
  }
  // The state moved since the request left: its base is not the state's any more.
  if (S.known && (S.version !== base.have || S.epoch !== base.he || S.userVersion !== base.uv || S.userEpoch !== base.ue)) {
    S.again = true;
    return false;
  }
  if (r.notModified) {
    if (dropSettled(S, q)) flush();
    return false;
  }
  unlayAll(S);
  const t = applyAnswer(S, r.data);
  S.etag = r.etag || null;
  dropSettled(S, q);
  layAll(S);
  flush();
  cache.save(S.id, t);
  return true;
}

async function refreshOne(src, { force = false } = {}) {
  // A source the core reports offline would only answer 503 after a wait: keep its cached copy.
  if (!force && !sources.isUp(src)) return false;
  const S = stateOf(src);
  if (S.fetching) {
    S.again = true;
    return S.fetching;
  }
  S.fetching = (async () => {
    let any = false;
    try {
      do {
        S.again = false;
        any = (await fetchOnce(S)) || any;
      } while (S.again && states.get(src) === S);
    } finally {
      S.fetching = null;
    }
    return any;
  })();
  return S.fetching;
}

/**
 * Forgets the libraries of sources that are no longer paired, keeping their downloaded tracks.
 * Only once the core said which sources are paired: before that the list is the saved one.
 */
function dropRemoved() {
  if (!sources.loaded) return false;
  const ids = new Set(sources.music().map((s) => s.id));
  let changed = false;
  let kept = false;
  for (const id of [...states.keys()]) {
    if (ids.has(id)) continue;
    const S = states.get(id);
    for (const t of S.view.tracks) {
      if (keepOffline(t)) {
        offline.set(t.id, { ...t, _src: id });
        kept = true;
      }
    }
    states.delete(id);
    fetched.delete(id);
    if (S.known) {
      cache.forget(id);
      changed = true;
    }
  }
  if (kept) saveOffline();
  return changed;
}

/** Every source asked (a source asked already is asked once more after its answer). */
async function refresh() {
  await Promise.all(sources.music().map((s) => refreshOne(s.id)));
  if (dropRemoved() || (!loaded && !job)) {
    dirty.whole = true;
    flush();
  }
  await unionIdle();
}

const refreshSoon = debounce(refresh, 350);

function settled(S) {
  S.inflight--;
  if (!S.inflight) {
    const w = S.waiters;
    S.waiters = [];
    for (const fn of w) fn();
  }
}

/**
 * One change of one source: op (an operation, shown at once, or null) and request() (talks to
 * the source). On failure the operation goes (the rest stays laid) and a toast says why (none
 * when failMsg is null: the caller says it). Resolves the answer (true when empty) or null.
 */
async function mutate(src, op, request, failMsg) {
  if (!src) {
    toast('Nessuna fonte collegata');
    return null;
  }
  const S = stateOf(src);
  S.inflight++;
  if (op) {
    addOp(S, op);
    flush();
  }
  try {
    const res = await request();
    if (op) {
      settle(S, op, versionsOf(res));
      flush();
    }
    return res ?? true;
  } catch (err) {
    if (op && dropOps(S, (o) => o === op)) flush();
    // Something the screen allowed was refused: the generic line, and the library is read again.
    if (err?.status === 403) {
      if (failMsg !== null) toast('Qualcosa non ha funzionato');
      refreshSoon();
    } else if (failMsg !== null) toast(errorText(err, failMsg));
    return null;
  } finally {
    settled(S);
    refreshSoon();
  }
}

/** A change already made elsewhere (no request): shown until the next answer to a request sent after it. */
function noted(src, op) {
  const S = stateOf(src);
  addOp(S, op);
  op.settled = true;
  op.settledAt = S.reqSeq;
  flush();
}

// ---- play events (>= 30 s or to the end posts /api/played) ----
// Plays happen offline too (downloads in the car), so every event goes first into a small outbox
// in localStorage, stamped with its real time, and leaves it only once the principal took it:
// sent now when the principal answers, otherwise when it comes back or at the next start. The
// server honours "at" within the last 30 days, so offline plays keep their time.
const PLAYED_KEY = 'mpfy.played.outbox';
const PLAYED_MAX = 300; // about a day of listening; the oldest go first if it ever fills up
const PLAYED_MAX_AGE = 30 * 86400000;
let playedFlushing = false;

function playedOutbox() {
  const v = lsGet(PLAYED_KEY, []);
  return Array.isArray(v) ? v.filter((e) => e && typeof e.k === 'string' && typeof e.trackId === 'string') : [];
}

async function flushPlayedNow() {
  if (playedFlushing) return;
  playedFlushing = true;
  let sent = 0;
  try {
    for (;;) {
      const src = principalId();
      if (!src || !sources.isUp(src)) break;
      const head = playedOutbox()[0];
      if (!head) break;
      try {
        const at = Number(head.at) > Date.now() - PLAYED_MAX_AGE ? Number(head.at) : undefined;
        await srcApi(src).played(head.trackId, head.context, at);
        sent++;
      } catch (err) {
        // Unreachable or a server error: keep it for later. Refused for good (a 4xx): drop it,
        // or it would block the ones behind it forever.
        if (!(err?.status >= 400 && err.status < 500)) break;
      }
      // Re-read: another tab may have sent and removed it meanwhile.
      const box = playedOutbox();
      const i = box.findIndex((e) => e.k === head.k);
      if (i >= 0) {
        box.splice(i, 1);
        lsSet(PLAYED_KEY, box);
        if (playedOutbox().some((e) => e.k === head.k)) break; // storage refused the write: stop, never resend in a loop
      }
    }
  } finally {
    playedFlushing = false;
  }
  if (sent) refreshSoon(); // recents arrive with the library (its user part only)
}

// The move from the phone's store: passes before it gives up (each one 409 means a write reached
// the phone store meanwhile; the next start tries again), and the plays it carries: those of the
// last 30 days less an hour (the source honours older times only that far, measured when each
// request arrives: a play at the edge could be stored at the source's "now" and sent again).
const MOVE_PASSES = 5;
const MOVE_PLAYS_MS = PLAYED_MAX_AGE - 3600000;
const RECENTS_PAGE = 100;
const playKey = (x) => `${x.trackId}|${x.at}|${x.context?.type || ''}|${x.context?.id ?? ''}`;

/** The phone store's plays of the last 30 days to `target`, oldest first, each once. */
async function movePlays(target, onProgress) {
  const from = Date.now() - MOVE_PLAYS_MS;
  const plays = [];
  for (let before = null; ; ) {
    const r = await srcApi(PHONE_ID).recents(before, RECENTS_PAGE);
    const page = arr(r?.recents).filter((x) => okRecent(x) && Number.isFinite(x.at));
    for (const x of page) if (x.at >= from) plays.push(x);
    if (r?.more !== true || !page.length || page[page.length - 1].at < from) break;
    before = page[page.length - 1].at;
  }
  if (!plays.length) return;
  plays.sort((a, b) => a.at - b.at);
  // What the destination holds already, read back to the oldest play to send.
  const held = new Set();
  try {
    for (let before = null; ; ) {
      const r = await target.recents(before, RECENTS_PAGE);
      const page = arr(r?.recents).filter((x) => okRecent(x) && Number.isFinite(x.at));
      for (const x of page) held.add(playKey(x));
      if (r?.more !== true || !page.length || page[page.length - 1].at < plays[0].at) break;
      before = page[page.length - 1].at;
    }
  } catch (err) {
    // A source from before "Recenti" lists none: nothing to skip.
    if (!(err?.status >= 400 && err.status < 500)) throw err;
  }
  let done = 0;
  onProgress(0, plays.length, 'Recenti');
  for (const x of plays) {
    if (!held.has(playKey(x))) await target.played(x.trackId, x.context || { type: 'library', id: null }, x.at);
    onProgress(++done, plays.length, 'Recenti');
  }
}

/** Sends the outbox, one tab at a time when the browser can tell (Web Locks). */
function flushPlayed() {
  const src = principalId();
  if (!src || !sources.isUp(src) || !playedOutbox().length) return;
  if (navigator.locks?.request) {
    navigator.locks.request('mpfy-played', { ifAvailable: true }, (lock) => (lock ? flushPlayedNow() : null)).catch(() => {});
  } else {
    flushPlayedNow();
  }
}

// When a source comes back or a new one appears, fetch it; when one leaves, forget it.
// Before init() read the IndexedDB copies, nothing is asked: a library asked then would be asked
// without the versions held, and come whole.
let upBefore = new Set();
let principalBefore = null;
let homeBefore = null;
let orderBefore = '';
let phoneVBefore = null;
let cacheRead = false;
sources.subscribe(() => {
  const up = new Set(sources.music().filter((s) => sources.isUp(s.id)).map((s) => s.id));
  const back = [...up].filter((id) => !upBefore.has(id) || !known(id));
  upBefore = up;
  const p = sources.principal()?.id || null;
  const principalChanged = p !== principalBefore;
  principalBefore = p;
  // The home alone moving (the move done, a write on the phone store) makes only the person's
  // indexes again, not the union.
  const home = principalId();
  const homeChanged = home !== homeBefore;
  homeBefore = home;
  const order = sources.music().map((s) => s.id).join(',');
  const orderChanged = order !== orderBefore;
  orderBefore = order;
  if (dropRemoved() || principalChanged || (orderChanged && loaded)) {
    dirty.whole = true;
    flush();
  } else if (homeChanged) flush();
  // Locale's versions moved (a file came or went, a write on the phone store): it is asked.
  const pv = sources.phone ? sources.phone.v : null;
  const phoneMoved = pv !== phoneVBefore;
  phoneVBefore = pv;
  if (cacheRead) {
    if (back.length) refresh();
    else if (phoneMoved && pv !== null && up.has(PHONE_ID)) refreshOne(PHONE_ID);
  }
  flushPlayed();
  shadowSync();
});

// The phone's songs whose very file a real source holds: the core looks up no details or lyrics
// for them (that source's decide what shows). The page holds the union, so it tells the core: the
// whole set once in a session and whenever the core says it has none for the real sources it has
// now (phone.shadowed false), then what moved, read from the songs each emit names (no walk of
// the library but after a whole merge).
const SHADOW_MAX = 100000;
let shadowSent = null; // the set the core holds, as told in this session; null: tell it whole
let shadowKey = null; // the real sources a whole set was told for
let shadowTodo = new Set();
let shadowWhole = false;
let shadowBusy = false;

function isShadowed(id) {
  const P = known(PHONE_ID);
  if (!P || !P.vtrack.has(id)) return false;
  const song = derived.tracks.get(id);
  return !!song && song.versions.some((v) => !v.kept && v.sourceId !== PHONE_ID);
}

function shadowNote() {
  if (!sources.phone || !sources.list.length) return;
  const c = changedNow;
  if (c.all) shadowWhole = true;
  else {
    for (const id of c.songs) {
      shadowTodo.add(id);
      const song = derived.tracks.get(id);
      if (song) for (const v of song.versions) if (v.sourceId === PHONE_ID) shadowTodo.add(v.trackId);
    }
  }
  shadowSync();
}
listeners.add(shadowNote);

async function shadowSync() {
  const ph = sources.phone;
  if (shadowBusy || !ph || !sources.list.length || !sources.loaded || !cacheRead || job) return;
  const P = known(PHONE_ID);
  if (!P || !sources.list.every((s) => known(s.id))) return;
  const key = sources.list.map((s) => s.id).sort().join(',');
  let body;
  let next;
  if (shadowSent === null || (ph.shadowed === false && shadowKey !== key)) {
    next = new Set();
    for (const t of P.view.tracks) if (isShadowed(t.id)) next.add(t.id);
    body = { all: [...next].slice(0, SHADOW_MAX) };
  } else {
    const todo = shadowWhole ? [...P.view.tracks.map((t) => t.id), ...shadowSent] : [...shadowTodo];
    const add = [];
    const remove = [];
    for (const id of new Set(todo)) {
      const on = isShadowed(id);
      if (on && !shadowSent.has(id)) add.push(id);
      else if (!on && shadowSent.has(id)) remove.push(id);
    }
    shadowWhole = false;
    shadowTodo = new Set();
    if (!add.length && !remove.length) return;
    next = new Set(shadowSent);
    for (const id of remove) next.delete(id);
    for (const id of add) next.add(id);
    body = { add: add.slice(0, SHADOW_MAX), remove: remove.slice(0, SHADOW_MAX) };
  }
  shadowWhole = false;
  shadowTodo = new Set();
  shadowBusy = true;
  try {
    await localRequest('PUT', '/local/phone/shadowed', body, 15000);
    shadowSent = next;
    if (body.all) shadowKey = key;
  } catch {
    shadowSent = null; // told whole at the next change
  } finally {
    shadowBusy = false;
  }
  if (shadowSent && (shadowTodo.size || shadowWhole)) shadowSync();
}

/** The position nearest to `at` (at itself first) whose id passes `match`, not in `taken`, or -1. */
function nearestMatch(list, at, match, taken) {
  const from = Math.min(at, list.length - 1);
  for (let d = 0; from - d >= 0 || from + d < list.length; d++) {
    if (from - d >= 0 && !taken.has(from - d) && match(list[from - d])) return from - d;
    if (d > 0 && from + d < list.length && !taken.has(from + d) && match(list[from + d])) return from + d;
  }
  return -1;
}

const countIn = (list, match) => list.reduce((n, x) => n + (match(x) ? 1 : 0), 0);

/**
 * The positions of `cur` that removals of songs drawn at { index, id } take, as the page sees
 * them: for each id as many as asked, less the copies gone since `drawn` (the list the page drew,
 * when known), each the copy at its position when it is there, else the nearest one. A song still
 * not found may be here as another version of it (a version deleted meanwhile): taken only when
 * the song has more such copies than drawn had. sameSong(e, x): trackId x is another version of
 * e's song. The source then applies its own rule (userops.js removalSlots) to what is sent.
 */
function pickRemovals(cur, asked, drawn, sameSong) {
  const drop = new Set();
  const done = new Set();
  const ids = [];
  for (const e of asked) if (ids.indexOf(e.id) < 0) ids.push(e.id);
  for (const tid of ids) {
    const its = asked.filter((e) => e.id === tid);
    const isIt = (x) => x === tid;
    let left = its.length - (drawn ? Math.max(0, countIn(drawn, isIt) - countIn(cur, isIt)) : 0);
    const take = (e, at) => {
      drop.add(at);
      done.add(e);
      left--;
    };
    for (const e of its) if (left > 0 && cur[e.index] === tid && !drop.has(e.index)) take(e, e.index);
    for (const e of its) {
      if (left <= 0 || done.has(e)) continue;
      const at = nearestMatch(cur, e.index, isIt, drop);
      if (at >= 0) take(e, at);
    }
  }
  if (!drawn) return drop;
  for (const e of asked) {
    if (done.has(e)) continue;
    const other = (x) => x !== e.id && sameSong(e, x);
    const free = cur.reduce((n, x, i) => n + (!drop.has(i) && other(x) ? 1 : 0), 0);
    if (free <= countIn(drawn, other)) continue;
    const at = nearestMatch(cur, e.index, other, drop);
    if (at >= 0) drop.add(at);
  }
  return drop;
}

/** A cover's bytes, or null when no source that has it answers and no copy is cached. */
async function coverBlob(coverId, size) {
  const path = coverHref(coverId, size);
  if (!path) return null;
  try {
    const res = await fetch(path);
    return res.ok ? await res.blob() : null;
  } catch {
    return null;
  }
}

// Which playlist on one source is the copy of which on another (copyUserData), so switching the
// principal back and forth updates the same playlists. Pairs of "source:playlist" keys.
const LINKS_KEY = 'mpfy.playlist.links';
const LINKS_MAX = 2000;
const linkKey = (src, id) => `${src}:${id}`;
function linkedIn(src, id, to) {
  const k = linkKey(src, id);
  const pre = `${to}:`;
  for (const [a, b] of lsGet(LINKS_KEY, []) || []) {
    if (a === k && b.startsWith(pre)) return b.slice(pre.length);
    if (b === k && a.startsWith(pre)) return a.slice(pre.length);
  }
  return null;
}
function addLink(src, id, to, toId) {
  const a = linkKey(src, id);
  const b = linkKey(to, toId);
  const links = (lsGet(LINKS_KEY, []) || []).filter(([x, y]) => !((x === a && y.startsWith(`${to}:`)) || (y === a && x.startsWith(`${to}:`))));
  links.push([a, b]);
  lsSet(LINKS_KEY, links.slice(-LINKS_MAX));
}
const sameIds = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The song id a group will have without one of its versions: on the principal, else the first in order. */
function idWithout(song, v) {
  const rest = song.versions.filter((x) => x !== v && !x.kept);
  if (!rest.length) return null;
  const order = sources.music().map((s) => s.id);
  rest.sort((a, b) => order.indexOf(a.sourceId) - order.indexOf(b.sourceId));
  return rest[0].trackId;
}

/** owner | member | null (a source without profiles: everything is allowed, as before). */
export function roleOf(src) {
  return known(src)?.view.you?.role || sources.role(src) || null;
}

/** May the person change or delete this version (a track on one source)? */
export function allowedVersion(v) {
  if (!v || v.kept || sources.isLocal(v.sourceId)) return false;
  const role = roleOf(v.sourceId);
  return role !== 'member' || v.t.mine === true;
}

/**
 * Every trackId of a song: the id asked, the song's id, its versions' and the ids its versions had
 * before their bytes changed (`was`, a retag on the phone): an unlike takes the old like away too.
 */
function memberIds(id) {
  const song = derived.tracks.get(id);
  const out = new Set([id, song?.id || id]);
  for (const v of song?.versions || []) {
    out.add(v.trackId);
    for (const w of wasOf(v.t)) out.add(w);
  }
  return out;
}

/** The person's part of a source's answer read whole (copyUserData's destination). */
function ownOf(data) {
  return {
    playlists: arr(data?.playlists).filter(okPlaylist).map(normPlaylist),
    likes: arr(data?.likes).filter((l) => l && typeof l.id === 'string'),
    covers: normCovers({ playlist: data?.covers?.playlist }),
    you: normYou(data?.you),
  };
}

export const store = {
  get lib() {
    return lib;
  },
  get d() {
    return derived;
  },
  get loaded() {
    return loaded;
  },
  /** How many times the whole merge ran (never for a play, a like, or a delta of a few songs). */
  get merges() {
    return union.merges;
  },
  /** Signature comparisons made so far (the union keeps the ones made). */
  get comparisons() {
    return union.graph.comparisons;
  },
  /** Changes of src still on their way or not confirmed yet (for the checks). */
  pendingOps: (src) => states.get(src)?.ops.length || 0,
  /** The IndexedDB cache's counters: { transactions, puts, deletes, aborts, rebuilds }. */
  get cacheStats() {
    return cache.stats;
  },
  /** Every paired source has a library (cached or fetched) and at least one answered now. */
  get synced() {
    return sources.loaded && sources.music().every((s) => known(s.id)) && (fetched.size > 0 || !sources.music().length);
  },
  get principalId() {
    return principalId();
  },
  /** The song a trackId (any of its versions) belongs to. */
  track: (id) => derived.tracks.get(id),
  /** The song id of a trackId (itself when unknown). */
  gid: (id) => derived.tracks.get(id)?.id || id,
  /** Ids of the paired sources that have this song. */
  trackSources: (id) => derived.tracks.get(id)?.sources || [],
  /** The versions of a song, in source order. */
  versions: (id) => derived.tracks.get(id)?.versions || [],
  /** Ids of the sources that can serve this cover. */
  coverSources: (coverId) => derived.coverSrc.get(coverId) || derived.userCoverSrc.get(coverId) || [],
  /** Ids of the sources whose copy of your data holds this playlist (the principal first). */
  playlistSources(id) {
    const p = principalId();
    const out = [...states.values()].filter((S) => S.known && S.vpl.has(id)).map((S) => S.id);
    return out.sort((a, b) => (b === p ? 1 : 0) - (a === p ? 1 : 0));
  },
  /** The library of one source as last seen (cached or fetched), or null. */
  libOf: (src) => known(src)?.view || null,
  roleOf,
  /** Its library came and says nothing of profiles: a source of before profiles. */
  withoutProfiles: (src) => {
    const S = known(src);
    return !!S && !S.view.you;
  },
  allowedVersion,
  /** The versions of a song the person may change, on connected sources. */
  editableVersions: (id) => store.versions(id).filter((v) => allowedVersion(v) && sources.isUp(v.sourceId)),
  /** Some version of the song has lyrics (the library's flag, synced or plain). */
  hasLyrics: (id) => store.versions(id).some((v) => v.t.lyrics === 'synced' || v.t.lyrics === 'plain'),
  /** The versions whose lyrics the person may add or take away: theirs (as track edits), on sources that speak the songs part. */
  lyricsVersions: (id) => store.versions(id).filter((v) => allowedVersion(v) && (sources.get(v.sourceId)?.social || 0) >= 3),
  /**
   * The sources where the person may change an album's cover: every source that has the album,
   * for a member only where every track of it is theirs.
   */
  albumSources(albumId) {
    const out = [];
    for (const s of sources.ordered()) {
      const S = known(s.id);
      if (!S) continue;
      if (!S.albumIdx) {
        S.albumIdx = new Map();
        for (const t of S.view.tracks) idxIn(S, t, 1);
      }
      const e = S.albumIdx.get(albumId);
      if (!e || !e.n) continue;
      if (roleOf(s.id) === 'member' && e.notMine > 0) continue;
      out.push(s.id);
    }
    return out;
  },
  /** downloads.js: which tracks of a removed source stay (the downloaded ones). */
  keepOffline(fn) {
    keepOffline = typeof fn === 'function' ? fn : () => false;
  },
  /** The downloads changed: show or hide the kept tracks of removed sources. */
  offlineChanged() {
    if (!offline.size || !loaded) return;
    const k = [...offline.values()].filter((t) => keepOffline(t)).map((t) => t.id).join(',');
    if (k === offlineKey) return;
    offlineKey = k;
    dirty.whole = true;
    flush();
  },
  /** Their downloads were removed: forget these kept tracks for good. */
  forgetOffline(ids) {
    let changed = false;
    for (const id of ids) changed = offline.delete(id) || changed;
    if (!changed) return;
    saveOffline();
    offlineKey = [...offline.values()].filter((t) => keepOffline(t)).map((t) => t.id).join(',');
    dirty.whole = true;
    flush();
  },
  /** A custom cover exists for kind/id: playlists on the principal, tracks and albums on a source. */
  hasCustomCover(kind, id, srcs = null) {
    if (kind === 'playlist') return !!lib.covers?.playlist?.[id];
    if (kind === 'track') return store.versions(id).some((v) => (!srcs || srcs.includes(v.sourceId)) && !!known(v.sourceId)?.view.covers.track[v.trackId]);
    return (srcs || [...states.keys()]).some((sid) => !!known(sid)?.view.covers.album[id]);
  },
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  /**
   * What moved at the last emit, so a list redraws only the rows that did:
   *   { seq, all, songs, albums, artists, playlists, likes, recents }
   * seq: the emit's number, one more at every emit (a reader that last saw another seq than
   * seq - 1 missed emits and reads everything again); all: anything may have moved (the first
   * library, a whole merge, a source added, removed or moved): read everything again; songs,
   * albums, artists, playlists: read-only Sets of the ids added, removed or changed (a song's
   * fields, versions or cover; an album's or artist's members, order, year or cover; a
   * playlist's name, description, tracks or cover); likes, recents: the liked list or the plays
   * moved. The object is replaced at every emit, never changed.
   */
  changed: () => changedNow,

  async init() {
    try {
      const kept = await idbGet('offline');
      if (Array.isArray(kept)) for (const t of kept) if (t && typeof t.id === 'string' && !offline.has(t.id)) offline.set(t.id, t);
      offlineKey = [...offline.values()].filter((t) => keepOffline(t)).map((t) => t.id).join(',');
    } catch {
      /* none kept */
    }
    try {
      const c = await cache.load();
      if (c.old) {
        // The cache of before the chunks: read once, written in chunks, then dropped.
        const { shared, user: us, libs: old } = c.old;
        const each = shared && typeof shared === 'object' ? Object.entries(shared).map(([id, s]) => [id, s, null]) : Object.entries(old || {}).map(([id, x]) => [id, null, x?.lib]);
        for (const [id, s, whole] of each) {
          if (known(id)) continue;
          const u = (us && us[id]) || {};
          const data = whole || (s && Array.isArray(s.tracks) ? { version: s.version, userVersion: u.userVersion, tracks: s.tracks, playlists: u.playlists, likes: u.likes, recents: u.recents, covers: { ...s.covers, playlist: u.playlistCovers }, you: u.you, source: u.source } : null);
          if (!data) continue;
          const S = stateOf(id);
          const t = applyAnswer(S, data);
          // The ETag names both parts: only when they belong together.
          S.etag = !whole && u.version === s.version ? u.etag || null : null;
          t.all = true;
          t.userAll = true;
          cache.save(id, t);
        }
        cache.idle().then(() => cache.dropOld());
      } else {
        for (const [id, x] of c.sources) {
          if (known(id)) continue;
          const S = stateOf(id);
          const m = x.meta;
          applyAnswer(S, { version: m.version, userVersion: m.userVersion, tracks: x.tracks, playlists: x.playlists, likes: [...x.likes].reverse().map(([lid, at]) => ({ id: lid, at })), recents: x.recents, covers: { ...x.covers, playlist: x.playlistCovers }, you: m.you, source: m.source });
          S.epoch = typeof m.epoch === 'string' ? m.epoch : null;
          S.userEpoch = typeof m.userEpoch === 'string' ? m.userEpoch : null;
          S.etag = m.etag || null;
        }
        for (const p of c.pairs) union.graph.load(p.a, p.b, p.edges, p.compared);
      }
      if ([...states.values()].some((S) => S.known) || offline.size) {
        principalBefore = sources.principal()?.id || null;
        homeBefore = principalId();
        dirty = newDirty();
        startWhole(true);
        await unionIdle();
      }
    } catch (err) {
      console.error('library cache', err);
    }
    cacheRead = true;
    await refresh();
    flushPlayed(); // plays left over from an offline session
  },

  refresh,
  refreshSoon,

  isLiked: (id) => derived.likedSet.has(store.gid(id)),

  /** The principal's likes by song: song id -> the liked trackIds of its versions, newest first. */
  likedGroups() {
    const src = principalId();
    if (likedMemo && likedMemo.likes === likesSeq && likedMemo.songs === songsSeq && likedMemo.p === src) return likedMemo.m;
    const likes = [...((src && known(src)?.view.likes) || [])].sort((a, b) => (b.at || 0) - (a.at || 0));
    const m = new Map();
    for (const x of likes) {
      const song = derived.tracks.get(x.id);
      if (!song) continue;
      if (!m.has(song.id)) m.set(song.id, []);
      m.get(song.id).push(x.id);
    }
    likedMemo = { likes: likesSeq, songs: songsSeq, p: src, m };
    return m;
  },

  /**
   * A like or unlike done outside this page (the heart in the notification or the car), already
   * saved on the principal: shown at once, as the page's own would be, without a request.
   */
  applyLiked(id, liked) {
    const src = principalId();
    if (!src || !known(src)) return;
    const g = store.gid(id);
    noted(src, liked ? opLike(g, now()) : opUnlike([...memberIds(id)]));
    refreshSoon();
  },

  /** Liking a song likes its id. */
  like(id) {
    const src = principalId();
    const g = store.gid(id);
    return mutate(src, opLike(g, now()), () => srcApi(src).like(g), 'Mi piace non salvato');
  },

  /** Un-liking a song removes every liked version of it. */
  unlike(id) {
    const src = principalId();
    const members = memberIds(id);
    const ids = ((src && known(src)?.view.likes) || []).map((x) => x.id).filter((x) => members.has(x));
    if (!ids.length) ids.push(store.gid(id));
    return mutate(src, opUnlike([...members]), () => Promise.all(ids.map((x) => srcApi(src).unlike(x))), 'Mi piace non rimosso');
  },

  /** Not optimistic: the new playlist needs its server id (we navigate to it). */
  async createPlaylist(name, description = '', trackIds = []) {
    const src = principalId();
    if (!src) {
      toast('Nessuna fonte collegata');
      return null;
    }
    const S = stateOf(src);
    S.inflight++;
    try {
      const api = srcApi(src);
      const made = await api.createPlaylist(name, description);
      let { playlist } = made;
      let hdr = versionsOf(made);
      if (trackIds.length) {
        const r = await api.addToPlaylist(playlist.id, trackIds);
        if (r?.playlist) playlist = r.playlist;
        hdr = versionsOf(r) || hdr;
      }
      playlist = normPlaylist(playlist);
      const op = opCreate(playlist);
      addOp(S, op);
      settle(S, op, hdr);
      flush();
      return playlist;
    } catch (err) {
      toast(errorText(err, 'Playlist non creata'));
      return null;
    } finally {
      settled(S);
      refreshSoon();
    }
  },

  /**
   * patch: { name?, description?, trackIds?, base? }. trackIds is the full new order; with base,
   * the list it was made from, it is applied to the list as it is now, here and on the source
   * (rebaseOrder): a song added or removed meanwhile, by another device or by a request still on
   * its way, is not undone.
   */
  updatePlaylist(id, patch) {
    const src = principalId();
    const { base, ...fields } = patch;
    return mutate(src, opPlaylist(id, { ...fields, base: fields.trackIds && base ? base : null }, now()), () => srcApi(src).patchPlaylist(id, patch), 'Playlist non modificata');
  },

  addToPlaylist(id, trackIds) {
    const src = principalId();
    return mutate(src, opAdd(id, trackIds.slice(), null, now()), () => srcApi(src).addToPlaylist(id, trackIds), 'Brani non aggiunti');
  },

  /**
   * entries: positions in the list as a page drew it, each a number or { index, id, list?, song? }:
   * the trackId drawn there, the list it was drawn from and the trackIds of its song's versions
   * then. The song removed is the one drawn: at that position when it is still there, else at
   * the nearest position it has now (that trackId, else another version of the song); a song no
   * longer in the list is already out, and so is a copy of a song in the list twice that went
   * since the list was drawn. The source gets each position with the trackId now there and how
   * many copies of it the list has here, and checks them against its own list.
   */
  removeFromPlaylist(id, entries) {
    const src = principalId();
    if (!src) return mutate(src); // says there is no source
    const cur = known(src)?.view.playlists.find((p) => p.id === id)?.trackIds;
    if (!cur) return Promise.resolve(null);
    const asked = entries.filter((e) => e && typeof e === 'object');
    const drawn = asked.find((e) => Array.isArray(e.list))?.list || null;
    const sameSong = (e, x) => (Array.isArray(e.song) && e.song.indexOf(x) >= 0) || store.gid(x) === store.gid(e.id);
    const drop = pickRemovals(cur, asked, drawn, sameSong);
    for (const e of entries) if (Number.isInteger(e) && e >= 0 && e < cur.length) drop.add(e);
    if (!drop.size) return Promise.resolve(true);
    const indexes = [...drop].sort((a, b) => a - b);
    const ids = indexes.map((i) => cur[i]);
    const have = countIds(cur);
    const counts = ids.map((x) => have.get(x));
    return mutate(src, opRemove(id, indexes, ids, counts, now()), () => srcApi(src).removeFromPlaylist(id, indexes, ids, counts), 'Brano non rimosso');
  },

  deletePlaylist(id) {
    const src = principalId();
    return mutate(src, opDelete(id), () => srcApi(src).deletePlaylist(id), 'Playlist non eliminata');
  },

  /**
   * "Aggiungi testo": the text (an .lrc or plain) on every version the person may change, on a
   * connected source that speaks the songs part; it replaces whatever lyrics they had. The flag
   * shows at once (synced when the text has a time tag), and the source's answer says which it
   * kept. Resolves the trackIds that took it (null when none did).
   */
  async putLyrics(id, text, guess) {
    const targets = store.lyricsVersions(id).filter((v) => sources.isUp(v.sourceId));
    if (!targets.length) {
      toast('Fonte non raggiungibile');
      return null;
    }
    const flag = (kind) => (t) => (t.lyrics === kind ? null : { ...t, lyrics: kind });
    const took = [];
    await Promise.all(
      targets.map(async (v) => {
        const op = opTrack(v.trackId, flag(guess));
        const r = await mutate(v.sourceId, op, () => srcApi(v.sourceId).putLyrics(v.trackId, text), 'Qualcosa non ha funzionato');
        if (!r) return;
        took.push(v.trackId);
        const kind = r.kind === 'synced' || r.kind === 'plain' ? r.kind : guess;
        const S = states.get(v.sourceId);
        if (kind !== guess && S && S.ops.includes(op)) {
          unlayAll(S);
          op.fn = flag(kind);
          layAll(S);
          flush();
        }
      })
    );
    return took.length ? took : null;
  },

  /** "Togli testo": the lyrics go from every version the person may change that has them. Resolves the trackIds it went from. */
  async removeLyrics(id) {
    const targets = store.lyricsVersions(id).filter((v) => sources.isUp(v.sourceId) && (v.t.lyrics === 'synced' || v.t.lyrics === 'plain'));
    if (!targets.length) {
      toast('Fonte non raggiungibile');
      return null;
    }
    const drop = (t) => {
      if (!('lyrics' in t)) return null;
      const { lyrics, ...rest } = t;
      return rest;
    };
    const took = [];
    await Promise.all(
      targets.map(async (v) => {
        if (await mutate(v.sourceId, opTrack(v.trackId, drop), () => srcApi(v.sourceId).deleteLyrics(v.trackId), 'Qualcosa non ha funzionato')) took.push(v.trackId);
      })
    );
    return took.length ? took : null;
  },

  /**
   * patch: { title?, artist?, album? } (metadata only), applied to every version the person may
   * change on a connected source, so the copies stay alike. Resolves true when one took it.
   */
  async editTrack(id, patch) {
    const targets = store.editableVersions(id);
    if (!targets.length) {
      toast('Fonte non raggiungibile');
      return null;
    }
    const edit = (t) => {
      const n = { ...t, ...patch };
      // Keep the album grouped with the artist when the album artist simply followed it.
      if (patch.artist && (t.albumArtist === t.artist || !t.albumArtist)) n.albumArtist = patch.artist;
      return n;
    };
    const results = await Promise.all(targets.map((v) => mutate(v.sourceId, opTrack(v.trackId, edit), () => srcApi(v.sourceId).patchTrack(v.trackId, patch), 'Info non salvate')));
    return results.some(Boolean) || null;
  },

  /**
   * Deletes one version of a song (the track on source src). A member whose track others own
   * too only gives up its claim: nothing leaves the screen (that track is just no longer "mine")
   * and the call resolves { deleted: false }. Otherwise the track goes optimistically, and when
   * the song has other versions the person's playlist and like references move first to the id
   * the song will have without this one; when that id is the deleted one (the same file on
   * another source) and the delete happens on the principal, the source purges it from the
   * person's data, and it is added back once the source says the file went.
   * Resolves { deleted } or null on failure.
   */
  async deleteVersion(id, src) {
    const song = store.track(id);
    const v = song?.versions.find((x) => x.sourceId === src);
    if (!v) return null;
    const api = srcApi(src);
    const notMine = (t) => (t.mine === false ? null : { ...t, mine: false });
    if (roleOf(src) === 'member' && v.t.others) {
      const op = opTrack(v.trackId, notMine);
      const r = await mutate(src, op, () => api.deleteTrack(v.trackId), 'Brano non eliminato');
      if (!r) return null;
      if (r.deleted === true) {
        const S = stateOf(src);
        const gone = opTrackGone(v.trackId);
        addOp(S, gone);
        settle(S, gone, op.hdr);
        flush();
      }
      return { deleted: r.deleted === true };
    }

    const p = principalId();
    const X = v.trackId;
    const next = idWithout(song, v);
    let readd = null;
    if (next && next !== X && p) {
      // Move the person's references to the id the song will keep. Each playlist is read right
      // before its change and sent with the list it was read as (base), so a song added or a
      // reference moved meanwhile (another delete started right after this one) is kept.
      const ids = (known(p)?.view.playlists || []).map((x) => x.id);
      for (const plId of ids) {
        const x = known(p)?.view.playlists.find((y) => y.id === plId);
        if (!x || !x.trackIds.includes(X)) continue;
        await store.updatePlaylist(x.id, { trackIds: x.trackIds.map((t) => (t === X ? next : t)), base: x.trackIds });
      }
      if ((known(p)?.view.likes || []).some((l) => l.id === X)) {
        await mutate(p, opLike(next, now()), () => srcApi(p).like(next), null);
        await mutate(p, opUnlike([X]), () => srcApi(p).unlike(X), null);
      }
    } else if (next === X && src === p) {
      const pl = known(p)?.view;
      readd = {
        liked: (pl?.likes || []).some((l) => l.id === X),
        entries: (pl?.playlists || []).flatMap((x) => x.trackIds.map((t, i) => (t === X ? { playlistId: x.id, index: i } : null)).filter(Boolean)),
      };
    }

    const op = opTrackGone(X);
    const r = await mutate(src, op, () => api.deleteTrack(X), 'Brano non eliminato');
    if (!r) return null;
    const deleted = r.deleted !== false;
    if (!deleted) {
      // Others own it after all: it stays, no longer ours.
      const S = stateOf(src);
      const keep = opTrack(X, notMine);
      unlayAll(S);
      S.ops = S.ops.filter((o) => o !== op);
      Object.assign(keep, { settled: true, hdr: op.hdr, settledAt: op.settledAt });
      S.ops.push(keep);
      layAll(S);
      flush();
      refreshSoon();
      return { deleted: false };
    }
    if (readd && p) {
      if (readd.liked) await mutate(p, opLike(X, now()), () => srcApi(p).like(X), null);
      for (const e of readd.entries.sort((a, b) => a.index - b.index)) {
        await mutate(p, opAdd(e.playlistId, [X], e.index, now()), () => srcApi(p).addToPlaylist(e.playlistId, [X], e.index), null);
      }
    }
    return { deleted: true };
  },

  /** A custom cover changed on a source (the PUT or DELETE answered with the new covers map). */
  setCovers(src, covers) {
    if (!known(src)) return;
    noted(src, opCovers(normCovers(covers)));
    refreshSoon();
  },

  /**
   * "Cerca i dettagli in rete" on a source (its owner may). Shown at once; the source's answer is
   * then taken as it is, and a refusal puts the old state back with "Qualcosa non ha funzionato".
   * After a second tap only the answer to it is taken (an older one would flip the switch back).
   */
  async setSourceDetails(src, on) {
    const S = known(src);
    if (!S?.view.source) return false;
    const want = !!on;
    const seq = (detailsSeq.get(src) || 0) + 1;
    detailsSeq.set(src, seq);
    const op = opDetails({ details: want });
    const r = await mutate(src, op, () => srcApi(src).patchSource({ details: want }), null);
    if (!r) {
      toast('Qualcosa non ha funzionato');
      return false;
    }
    if (r?.source && typeof r.source === 'object' && detailsSeq.get(src) === seq && S.ops.includes(op)) {
      unlayAll(S);
      op.value = normSource({ ...S.view.source, ...r.source });
      layAll(S);
      flush();
    }
    return true;
  },

  /** A play event (>= 30 s or to the end). Queued in the outbox, sent when reachable. */
  played(trackId, context) {
    const ev = { k: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`, trackId, context: context || { type: 'library', id: null }, at: Date.now() };
    const box = playedOutbox();
    box.push(ev);
    if (box.length > PLAYED_MAX) box.splice(0, box.length - PLAYED_MAX);
    lsSet(PLAYED_KEY, box);
    if (!playedOutbox().some((e) => e.k === ev.k)) {
      // No storage here (blocked or full): at least one direct attempt, as without the outbox.
      const src = principalId();
      if (src) srcApi(src).played(trackId, ev.context, ev.at).then(() => refreshSoon(), () => {});
      return;
    }
    flushPlayed();
  },

  /**
   * Copies the person's data on the principal `from` (playlists, likes, playlist covers) to `to`,
   * before `to` becomes the principal. Track and album covers live on each source and stay.
   * A playlist already there is updated: under its own id, or the copy linked to it by an earlier
   * copy (a source of before profiles ignores the id asked and gives its own), or there (that
   * older source) one with the same name and the same tracks. Else it is created with its own id;
   * when that id is taken there, one with the same name and tracks is updated, else a new one is
   * made. Likes go many at a time (one at a time to a source of before that). A playlist cover
   * that cannot be fetched (`from` offline and not cached) is skipped. Throws when nothing is
   * known of `from`.
   * onProgress(done, total, label). Resolves { idMap: old playlist id -> new id, skippedCovers }.
   * memo (the move from the phone): told what this copy is about to add on `to`, BEFORE each
   * request (likes(ids), playlist(id, toId), cover(id)), so a later pass can take back on `to` what
   * the phone no longer holds; never what `to` held already.
   */
  async copyUserData(from, to, onProgress = () => {}, memo = null) {
    await refreshOne(from);
    const source = known(from)?.view;
    if (!source) throw Object.assign(new Error('Fonte non raggiungibile'), { status: 503, src: from });
    const target = srcApi(to);
    const held = known(to);
    const t = await target.library(null, held ? { have: held.version, he: held.epoch } : null);
    const dest = ownOf(t.data);
    const destLikes = new Set(dest.likes.map((x) => x.id));
    const likes = [...source.likes].sort((a, b) => (a.at || 0) - (b.at || 0)).filter((x) => ID_RE.test(x.id) && !destLikes.has(x.id));
    const coverJobs = Object.entries(source.covers.playlist || {}).map(([id, c]) => ({ id, c }));
    const total = source.playlists.length + likes.length + coverJobs.length;
    let done = 0;
    const step = (label) => onProgress(++done, total, label);
    onProgress(0, total, 'Preparazione');

    const idMap = {};
    const used = new Set();
    const playlists = [...source.playlists].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const free = (p) => !used.has(p.id);
    const sameSong = (p, pl) => p.name === pl.name && sameIds(p.trackIds, pl.trackIds);
    for (const pl of playlists) {
      let id = null;
      const linked = linkedIn(from, pl.id, to);
      const there =
        dest.playlists.find((p) => p.id === pl.id && free(p)) ||
        dest.playlists.find((p) => p.id === linked && free(p)) ||
        (!dest.you ? dest.playlists.find((p) => sameSong(p, pl) && free(p)) : null);
      if (there) {
        id = there.id;
        await target.patchPlaylist(id, { name: pl.name, description: pl.description || '', trackIds: pl.trackIds });
      } else {
        let created = null;
        memo?.playlist(pl.id, pl.id);
        try {
          created = (await target.createPlaylist(pl.name, pl.description || '', pl.id)).playlist;
        } catch (err) {
          if (err?.code !== 'playlist_exists') throw err;
        }
        if (created) {
          id = created.id;
          if (id !== pl.id) memo?.playlist(pl.id, id);
          if (pl.trackIds.length) await target.patchPlaylist(id, { trackIds: pl.trackIds });
        } else {
          const match = dest.playlists.find((p) => sameSong(p, pl) && free(p));
          if (match) {
            id = match.id;
            await target.patchPlaylist(id, { name: pl.name, description: pl.description || '', trackIds: pl.trackIds });
          } else {
            id = (await target.createPlaylist(pl.name, pl.description || '')).playlist.id;
            memo?.playlist(pl.id, id);
            if (pl.trackIds.length) await target.patchPlaylist(id, { trackIds: pl.trackIds });
          }
        }
      }
      used.add(id);
      idMap[pl.id] = id;
      addLink(from, pl.id, to, id);
      step('Playlist');
    }
    // The likes, the oldest first, each the newest when it is added: their order stays.
    let bulk = true;
    for (let i = 0; i < likes.length; ) {
      if (bulk) {
        const batch = likes.slice(i, i + BULK_LIKES).map((x) => x.id);
        memo?.likes(batch);
        try {
          await target.likeMany(batch);
        } catch (err) {
          if (err?.status !== 404) throw err;
          bulk = false;
          continue;
        }
        for (let k = 0; k < batch.length; k++) step('Mi piace');
        i += batch.length;
        continue;
      }
      memo?.likes([likes[i].id]);
      await target.like(likes[i].id);
      step('Mi piace');
      i++;
    }
    let skippedCovers = 0;
    for (const { id, c } of coverJobs) {
      const targetId = idMap[id];
      const have = targetId && dest.covers.playlist?.[targetId];
      if (targetId && !(have && have.large === c.large && have.small === c.small)) {
        const large = await coverBlob(c.large, 'large');
        const small = large && (await coverBlob(c.small, 'small'));
        if (large && small) {
          memo?.cover(id);
          await target.coverFor('playlist', targetId, 'large', large);
          await target.coverFor('playlist', targetId, 'small', small);
        } else skippedCovers++;
      }
      step('Copertine');
    }
    return { idMap, skippedCovers };
  },

  /**
   * The person's data moves from the phone's store to the real principal `to` (which holds the
   * union of both after it): passes of copyUserData (playlists under their own ids, the likes `to`
   * lacks, playlist covers), the move memo's removals, the plays of the last 30 days at their own
   * times, then the core's compare-and-set (POST /local/phone/moved with the user version and
   * epoch the pass read). A write that reached the phone store meanwhile (the notification's
   * heart, the car) makes the core answer 409: the pass runs again and only what is new goes.
   * Every step finds what an earlier pass (or a crash) made, so nothing goes twice. The memo,
   * mpfy.phoneMove.<to>, holds what the move itself added on `to`, written before each request.
   * onProgress(done, total, label). Resolves { idMap, skippedCovers }; throws when a step fails.
   */
  async movePhoneData(to, onProgress = () => {}) {
    const key = `mpfy.phoneMove.${to}`;
    const target = srcApi(to);
    for (let pass = 0; pass < MOVE_PASSES; pass++) {
      await refreshOne(PHONE_ID, { force: true });
      const P = known(PHONE_ID);
      if (!P) throw Object.assign(new Error('Fonte non raggiungibile'), { status: 503 });
      const uv = P.userVersion;
      const ue = P.userEpoch;
      const got = lsGet(key, null);
      const m = { likes: arr(got?.likes), playlists: got?.playlists && typeof got.playlists === 'object' ? got.playlists : {}, covers: arr(got?.covers) };
      const save = () => lsSet(key, m);
      const memo = {
        likes: (ids) => {
          const have = new Set(m.likes);
          for (const id of ids) if (!have.has(id)) m.likes.push(id);
          save();
        },
        playlist: (id, toId) => {
          m.playlists[id] = toId;
          save();
        },
        cover: (id) => {
          if (!m.covers.includes(id)) m.covers.push(id);
          save();
        },
      };
      const r = await store.copyUserData(PHONE_ID, to, onProgress, memo);
      // What the move added on `to` and the phone no longer holds goes from `to` too.
      const view = known(PHONE_ID)?.view || P.view;
      const likesNow = new Set(view.likes.map((x) => x.id));
      const plNow = new Set(view.playlists.map((x) => x.id));
      const gone = m.likes.filter((id) => !likesNow.has(id));
      if (gone.length) {
        try {
          await target.likeMany([], gone);
        } catch (err) {
          if (err?.status !== 404) throw err;
          for (const id of gone) await target.unlike(id);
        }
        m.likes = m.likes.filter((id) => likesNow.has(id));
        save();
      }
      for (const [id, toId] of Object.entries(m.playlists)) {
        if (plNow.has(id)) continue;
        try {
          await target.deletePlaylist(toId);
        } catch (err) {
          if (err?.status !== 404) throw err;
        }
        delete m.playlists[id];
        m.covers = m.covers.filter((x) => x !== id);
        save();
      }
      for (const id of m.covers.slice()) {
        if (!plNow.has(id) || view.covers.playlist?.[id]) continue;
        try {
          await target.resetCover('playlist', m.playlists[id] || r.idMap[id] || id);
        } catch (err) {
          if (err?.status !== 404) throw err;
        }
        m.covers = m.covers.filter((x) => x !== id);
        save();
      }
      await movePlays(target, onProgress);
      try {
        await localRequest('POST', '/local/phone/moved', { to, uv, ue }, 20000);
      } catch (err) {
        if (err?.status === 409 && err.code === 'changed') continue;
        throw err;
      }
      lsSet(key, null);
      await sources.refresh();
      await refresh();
      return r;
    }
    throw Object.assign(new Error('Qualcosa non ha funzionato'), { status: 409, code: 'changed' });
  },

  /** Every write to the library cache asked so far is done (for the checks). */
  cacheIdle: () => cache.idle(),
  /** The whole merge and the comparisons in slices are done (for the checks). */
  async idle() {
    await unionIdle();
    while (comparing || union.comparing) {
      await new Promise((r) => setTimeout(r, 5));
      await unionIdle();
    }
  },
};

// Before the first answer the indexes exist and are empty.
user.whole(EMPTY, null, () => null);
makeDerived();
makeLib();
