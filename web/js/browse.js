// The car's library (the Android app): a snapshot of the merged library that the app keeps on
// disk, so Android Auto can browse, search and play with the page closed. Built from the songs,
// the principal's own data and the quality settings, sent 2 s after the last change.
//
// Bridge 4 to 6: one snapshot (setBrowseSnapshot), sent only when it differs from the last one
// sent (compared without its time stamp, which only the text sent carries). At most 20000 songs
// and 4 MB: the rest is left out.
//
// Bridge 7: the songs in pages of at most 2000 (setBrowsePage) and one index with the quality,
// the order of the pages, the albums, artists, playlists, liked songs and recents
// (setBrowseIndex). Pages and index carry a hash of their content and only those whose hash moved
// are sent, the pages first. A page is a run of songs in library order that keeps its slot
// number while songs come and go around it, so a song added or removed moves one page; a page
// past 2000 songs is cut in two, a small one joins its neighbour. The hash of each song is kept
// between sends (never its text): a change makes again only the songs it moved, and a page is
// written out only to be sent. At its first send the page asks the app what it holds
// (getBrowsePages) and goes on from there, so a page loaded again sends nothing that did not move.
//
// Each song lists every version it has (every source, connected or not, kept downloads too):
// first the ones playable now in the order mobile data would try them, then the others by score.
// A source offline today still plays from the car when it comes back.

import { store } from './store.js';
import { sources } from './sources.js';
import { quality } from './quality.js';
import { downloads } from './downloads.js';
import { native, nativeCall, nativeJson, bridgeVersion } from './native.js';
import { candidates, awayNow } from './media.js';
import { orderVersions, signatureOffset, offsetMs, byConnection } from './songs.js';
import { artistTrackIds, contextTracks, homeContexts } from './contexts.js';
import { cmpText, debounce } from './util.js';

export const MAX_TRACKS = 20000;
export const MAX_BYTES = 4 * 1024 * 1024;
/** The first bridge that takes the snapshot in pages. */
export const PAGED_BRIDGE = 7;
/** Songs in a page at most. */
export const PAGE_SONGS = 2000;
// Songs the pages carry. It goes to 100000 only once the app has been measured on the phone with
// that many: parsed off its main thread in under 10 s, and its heap growth known.
export const MAX_PAGED_TRACKS = 20000;
const QUIET_MS = 2000;
const SLICE_MS = 8; // work between two yields while the pages are made
const HELD_TRIES = 10; // times the app may say it is still reading its pages from disk
const utf8 = new TextEncoder();

/** The two streaming settings, Automatica as it decides with nothing measured (Wi-Fi max, mobile data high). */
export function snapshotQuality(s = quality.settings) {
  return { wifi: s.wifi === 'auto' ? 'max' : s.wifi, cellular: s.cellular === 'auto' ? 'high' : s.cellular };
}

/** [source, large cover id, small cover id] of a cover ({ id, small }), or null when no source has it. */
function artOf(cov) {
  if (!cov) return null;
  const src = store.coverSources(cov.id)[0];
  return src ? [src, cov.id, cov.small || cov.id] : null;
}

/** Every version of a song: the playable ones in the order of the level, then the rest by score. */
function versionsOf(song, level) {
  const now = orderVersions(candidates(song.id), level, (sid) => sources.get(sid));
  const rest = song.versions.filter((v) => !now.includes(v)).sort((a, b) => b.score - a.score);
  const all = [...now, ...rest];
  const first = all[0];
  return all.map((v) => {
    let o = 0;
    if (first && v.fileHash !== first.fileHash) {
      const k = signatureOffset(first.sig, v.sig);
      if (k != null) o = offsetMs(k);
    }
    // Its original on a memory card that is away: the car puts it with the sources that are down.
    return awayNow(v) ? { s: v.sourceId, tr: v.trackId, f: v.fileHash, o, a: 1 } : { s: v.sourceId, tr: v.trackId, f: v.fileHash, o };
  });
}

/** A song as the car reads it. */
function trackOf(t, d, level) {
  return {
    id: t.id,
    t: t.title || '',
    a: t.artist || '',
    aa: t.albumArtist || t.artist || '',
    al: d.albumOf.get(t.id) || '',
    n: Number.isInteger(t.trackNo) ? t.trackNo : null,
    d: Math.round((Number(t.duration) || 0) * 1000),
    art: artOf(d.trackCover.get(t.id)),
    v: versionsOf(t, level),
  };
}

// The groups, each keeping only the songs `only` lets through.

function albumsOf(d, only) {
  const albums = [];
  for (const al of [...d.albums.values()].sort((a, b) => cmpText(a.name, b.name))) {
    const tr = only(al.trackIds);
    if (tr.length) albums.push({ id: al.id, n: al.name, a: al.artist, y: al.year || null, art: artOf(al.cover), tr });
  }
  return albums;
}

function artistsOf(d, only) {
  const artists = [];
  for (const ar of [...d.artists.values()].sort((a, b) => cmpText(a.name, b.name))) {
    const tr = only(artistTrackIds(ar.id));
    if (tr.length) artists.push({ id: ar.id, n: ar.name, art: artOf(ar.cover), tr });
  }
  return artists;
}

function playlistsOf(d, only) {
  return store.lib.playlists.map((pl) => {
    const tr = only(contextTracks({ type: 'playlist', id: pl.id }));
    const own = d.playlistCover.get(pl.id);
    return { id: pl.id, n: pl.name, art: artOf(own || (tr.length ? d.trackCover.get(tr[0]) : null)), tr };
  });
}

function likedOf(d, only) {
  const groups = store.likedGroups();
  return only(d.likedIds).map((id) => ({ id, ids: groups.get(id) || [id] }));
}

const recentOf = () => homeContexts(20).map((c) => ({ k: c.type, id: c.id || '' }));

/** The snapshot without its time stamp, the first `limit` songs of the library. */
export function buildSnapshot(limit = MAX_TRACKS) {
  const d = store.d;
  const q = snapshotQuality();
  const songs = store.lib.tracks.slice(0, limit);
  const kept = new Set(songs.map((t) => t.id));
  const only = (ids) => ids.filter((id) => kept.has(id));
  const tracks = songs.map((t) => trackOf(t, d, q.cellular));
  return { format: 'mpfy-browse', v: 1, quality: q, tracks, albums: albumsOf(d, only), artists: artistsOf(d, only), playlists: playlistsOf(d, only), liked: likedOf(d, only), recent: recentOf() };
}

/** The snapshot as text, without and with its time stamp, within the size limit. */
export function snapshotTexts(at = Date.now()) {
  let limit = MAX_TRACKS;
  for (let tries = 0; ; tries++) {
    const snap = buildSnapshot(limit);
    const { format, v, ...rest } = snap;
    const sent = JSON.stringify({ format, v, at, ...rest });
    const bytes = utf8.encode(sent).length;
    if (bytes <= MAX_BYTES || !snap.tracks.length || tries >= 6) return { key: JSON.stringify(snap), text: sent, tracks: snap.tracks.length, bytes };
    limit = Math.max(0, Math.floor((snap.tracks.length * MAX_BYTES * 0.97) / bytes));
  }
}

let lastKey = null;

function send() {
  if (!store.loaded) return; // an empty start would replace the car's good copy
  const { key, text, bytes } = snapshotTexts();
  if (key === lastKey || bytes > MAX_BYTES) return;
  lastKey = key;
  nativeCall('setBrowseSnapshot', text);
}

// ---- bridge 7: pages and an index

const hex8 = (x) => (x >>> 0).toString(16).padStart(8, '0');
const fmix = (h) => {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return h ^ (h >>> 16);
};

/** A 64 bit hash in two 32 bit lanes (FNV-1a with two multipliers), written as 16 hex digits. */
export class Hash {
  constructor() {
    this.a = 0x811c9dc5 | 0;
    this.b = 0x050c5d1f | 0;
  }

  num(x) {
    this.a = Math.imul(this.a ^ x, 0x01000193);
    this.b = Math.imul(this.b ^ x, 0x5bd1e995);
    this.b ^= this.b >>> 15;
    return this;
  }

  text(s) {
    for (let i = 0; i < s.length; i++) this.num(s.charCodeAt(i));
    return this.num(s.length);
  }

  hex() {
    return hex8(fmix(this.a)) + hex8(fmix(this.b ^ this.a));
  }
}

/**
 * The pages of a song list: runs of songs in order, { n, from, to } (to excluded), n being the
 * page's slot. prev: the pages as laid out last, [{ n, first }] in order. A run starts at a song
 * that started a page before, and keeps that page's slot (the songs ahead of the first such song
 * join that first run); a run longer than size is cut (the last run in pages of size, so songs
 * added at the end fill a new page; any other run evenly); a run under a quarter of size joins
 * its neighbour when the two fit in one page, keeping the slot of the longer. Runs cut off take
 * the smallest slot numbers no run keeps. A layout with more pages than one per half page, plus
 * one, is made again from nothing.
 */
export function layOut(ids, prev, size = PAGE_SONGS) {
  if (!ids.length) return [];
  const startOf = new Map();
  for (const p of prev) startOf.set(p.first, p.n);
  let runs = [];
  for (let i = 0; i < ids.length; i++) {
    const n = startOf.get(ids[i]);
    if (n !== undefined) runs.push({ n, from: i, to: 0 });
  }
  if (!runs.length) runs.push({ n: null, from: 0, to: 0 });
  runs[0].from = 0;
  for (let k = 0; k < runs.length; k++) runs[k].to = k + 1 < runs.length ? runs[k + 1].from : ids.length;
  const cut = [];
  runs.forEach((r, k) => {
    const len = r.to - r.from;
    if (len <= size) {
      cut.push(r);
      return;
    }
    const step = k === runs.length - 1 ? size : Math.ceil(len / Math.ceil(len / size));
    for (let f = r.from; f < r.to; f += step) cut.push({ n: f === r.from ? r.n : null, from: f, to: Math.min(r.to, f + step) });
  });
  runs = [];
  for (const r of cut) {
    const p = runs[runs.length - 1];
    const lr = r.to - r.from;
    const lp = p ? p.to - p.from : 0;
    if (p && (lr < size / 4 || lp < size / 4) && lr + lp <= size) {
      p.n = lr > lp ? (r.n ?? p.n) : (p.n ?? r.n);
      p.to = r.to;
    } else runs.push({ n: r.n, from: r.from, to: r.to });
  }
  if (runs.length > Math.ceil(ids.length / (size / 2)) + 1) return layOut(ids, [], size);
  const used = new Set(runs.filter((r) => r.n !== null).map((r) => r.n));
  let free = 0;
  for (const r of runs) {
    if (r.n !== null) continue;
    while (used.has(free)) free++;
    r.n = free;
    used.add(free);
  }
  return runs;
}

// What the app holds as far as this page knows: { index: hash or null, pages: Map(n -> hash),
// layout: [{ n, first }] }; null until the app was asked.
let held = null;
let heldTries = 0;
// Each song's hash, as { s: the song object it was made from, a, b }, by song id; made in `ctx`.
const entries = new Map();
let entriesCtx = '';
const moved = new Set(); // songs whose hash is to be made again
let movedAll = true;
let lastSeq = 0;
let doneSeen = null; // the finished downloads at the last pass
// The index's groups as sent last ({ text, a, b }), made again only when what they hold moved.
const parts = { albums: null, artists: null, playlists: null, liked: null };
const partsMoved = { albums: true, artists: true, playlists: true, liked: true };
let pagedSoon = null;
let busy = false;
let again = false;

/** For the checks: songs hashed, pages and indexes sent, passes. */
export const pagedStats = { hashed: 0, pages: 0, indexes: 0, passes: 0 };

/** What moved at each emit of the store: kept until the next pass. */
function noteChanged() {
  const c = store.changed();
  if (c.all || c.seq !== lastSeq + 1) movedAll = true;
  lastSeq = c.seq;
  if (!movedAll) for (const id of c.songs) moved.add(id);
  const songs = c.all || c.songs.size > 0;
  if (songs || c.albums.size || c.artists.size) partsMoved.albums = partsMoved.artists = true;
  if (songs || c.playlists.size) partsMoved.playlists = true;
  if (songs || c.likes) partsMoved.liked = true;
}

/** The level and the sources' order and state: every song's versions are ordered by them. */
function contextKey(level) {
  const order = sources.music().slice().sort(byConnection);
  return `${level}|${order.map((s) => `${s.id}${sources.isUp(s.id) ? '+' : '-'}`).join(',')}`;
}

/** Songs whose finished downloads changed since the last pass. */
function downloadsMoved() {
  const now = downloads.doneIds;
  if (doneSeen) {
    for (const id of now) if (!doneSeen.has(id)) moved.add(store.gid(id));
    for (const id of doneSeen) if (!now.has(id)) moved.add(store.gid(id));
  }
  doneSeen = new Set(now);
}

/** What the app says it holds; false while it is still reading its pages from disk. */
function askHeld() {
  const h = nativeJson('getBrowsePages');
  if (h && h.loading === true && ++heldTries < HELD_TRIES) return false;
  held = { index: null, pages: new Map(), layout: [] };
  if (!h || h.loading === true) return true;
  if (typeof h.index === 'string') held.index = h.index;
  for (const p of Array.isArray(h.pages) ? h.pages : []) {
    if (!p || !Number.isInteger(p.n) || p.n < 0 || typeof p.h !== 'string' || typeof p.first !== 'string' || held.pages.has(p.n)) continue;
    held.pages.set(p.n, p.h);
    held.layout.push({ n: p.n, first: p.first });
  }
  return true;
}

const yieldNow = () => new Promise((r) => setTimeout(r, 0));
const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function partOf(value) {
  const text = JSON.stringify(value);
  const h = new Hash().text(text);
  return { text, a: h.a, b: h.b };
}

/** The index: its text with its time stamp, and its hash (without the time stamp). */
function indexOf(d, q, kept, pages) {
  const only = kept ? (ids) => ids.filter((id) => kept.has(id)) : (ids) => ids.filter((id) => d.tracks.get(id)?.id === id);
  if (partsMoved.albums || !parts.albums) parts.albums = partOf(albumsOf(d, only));
  if (partsMoved.artists || !parts.artists) parts.artists = partOf(artistsOf(d, only));
  if (partsMoved.playlists || !parts.playlists) parts.playlists = partOf(playlistsOf(d, only));
  if (partsMoved.liked || !parts.liked) parts.liked = partOf(likedOf(d, only));
  partsMoved.albums = partsMoved.artists = partsMoved.playlists = partsMoved.liked = false;
  const head = JSON.stringify({ quality: q, pages: pages.map((p) => p.n) }).slice(1, -1);
  const recent = JSON.stringify(recentOf());
  const h = new Hash().text(head).text(recent);
  for (const k of ['albums', 'artists', 'playlists', 'liked']) h.num(parts[k].a).num(parts[k].b);
  const hash = h.hex();
  const text = `{"format":"mpfy-browse-index","v":1,"at":${Date.now()},"h":"${hash}",${head},"albums":${parts.albums.text},"artists":${parts.artists.text},"playlists":${parts.playlists.text},"liked":${parts.liked.text},"recent":${recent}}`;
  return { hash, text };
}

/** One pass: the pages whose hash moved, then the index if it moved. */
async function pagedPass() {
  if (!held && !askHeld()) {
    pagedSoon?.();
    return;
  }
  pagedStats.passes++;
  const d = store.d;
  const q = snapshotQuality();
  const ctx = contextKey(q.cellular);
  if (movedAll) {
    entries.clear();
    movedAll = false;
    moved.clear();
    partsMoved.albums = partsMoved.artists = partsMoved.playlists = partsMoved.liked = true;
  } else if (ctx !== entriesCtx) {
    // The level and the sources order the versions of a song: one with a single version reads
    // the same whatever they are.
    for (const [id, e] of entries) if (e.s.versions.length > 1) entries.delete(id);
  }
  entriesCtx = ctx;
  downloadsMoved();
  for (const id of moved) entries.delete(id);
  moved.clear();
  const all = store.lib.tracks;
  const songs = all.slice(0, MAX_PAGED_TRACKS);
  const ids = songs.map((t) => t.id);
  const pages = layOut(ids, held.layout);
  let began = clock();
  for (const p of pages) {
    const texts = new Map();
    const h = new Hash();
    for (let i = p.from; i < p.to; i++) {
      const t = songs[i];
      let e = entries.get(t.id);
      if (!e || e.s !== t) {
        const text = JSON.stringify(trackOf(t, d, q.cellular));
        const th = new Hash().text(text);
        e = { s: t, a: th.a, b: th.b };
        entries.set(t.id, e);
        texts.set(i, text);
        pagedStats.hashed++;
      }
      h.num(e.a).num(e.b);
    }
    const hash = h.num(p.to - p.from).hex();
    if (held.pages.get(p.n) !== hash) {
      const list = [];
      for (let i = p.from; i < p.to; i++) list.push(texts.get(i) ?? JSON.stringify(trackOf(songs[i], d, q.cellular)));
      nativeCall('setBrowsePage', String(p.n), `{"format":"mpfy-browse-page","v":1,"n":${p.n},"h":"${hash}","tracks":[${list.join(',')}]}`);
      held.pages.set(p.n, hash);
      pagedStats.pages++;
    }
    if (clock() - began > SLICE_MS) {
      await yieldNow();
      began = clock();
    }
  }
  // Slots no page uses now: the app drops them when the index comes.
  const slots = new Set(pages.map((p) => p.n));
  for (const n of [...held.pages.keys()]) if (!slots.has(n)) held.pages.delete(n);
  held.layout = pages.map((p) => ({ n: p.n, first: ids[p.from] }));
  // Songs that left the library leave their hashes behind.
  if (entries.size > ids.length) {
    const here = new Set(ids);
    for (const id of [...entries.keys()]) if (!here.has(id)) entries.delete(id);
  }
  const index = indexOf(d, q, songs.length < all.length ? new Set(ids) : null, pages);
  if (index.hash !== held.index) {
    nativeCall('setBrowseIndex', index.text);
    held.index = index.hash;
    pagedStats.indexes++;
  }
}

async function sendPaged() {
  if (!store.loaded) return; // an empty start would replace the car's good copy
  if (busy) {
    again = true;
    return;
  }
  busy = true;
  try {
    await pagedPass();
  } catch (err) {
    console.error('car pages', err);
  } finally {
    busy = false;
    if (again) {
      again = false;
      pagedSoon?.();
    }
  }
}

function initPaged() {
  const soon = debounce(sendPaged, QUIET_MS);
  pagedSoon = soon;
  lastSeq = store.changed().seq;
  store.subscribe(() => {
    noteChanged();
    soon();
  });
  quality.subscribe(soon);
  downloads.subscribe(soon);
  let upKey = '';
  sources.subscribe(() => {
    const k = sources.music().filter((s) => sources.isUp(s.id)).map((s) => s.id).join(',');
    if (k === upKey) return;
    upKey = k;
    soon();
  });
  soon();
}

export const browse = {
  init() {
    if (!native || bridgeVersion() < 4) return;
    if (bridgeVersion() >= PAGED_BRIDGE) return initPaged();
    const soon = debounce(send, QUIET_MS);
    store.subscribe(soon);
    quality.subscribe(soon);
    downloads.subscribe(soon);
    // Only a source coming or going: the RTT moves at every poll.
    let upKey = '';
    sources.subscribe(() => {
      const k = sources.music().filter((s) => sources.isUp(s.id)).map((s) => s.id).join(',');
      if (k === upKey) return;
      upKey = k;
      soon();
    });
    soon();
  },
};
