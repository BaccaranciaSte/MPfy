// The lyrics of the song playing, as the sources that speak the songs part (social 3) hold them.
//
// Which text: the version playing, when its track has lyrics (the library's `lyrics` flag); else
// another version's, in the order versions are tried in, with the time offset between the two
// files applied to its line times when it is known (raw fingerprints, else signatures), else
// shown as plain text. Only tracks flagged with lyrics are ever asked for.
//
// Asked when the full player opens and after 1 s on a track while it is open (now-playing.js).
// The last 50 texts stay in memory with their ETag; one younger than 60 s is used as it is, an
// older one is asked again with its ETag (a 304 costs no body).
//
// Offline: a downloaded track's lyrics are kept in IndexedDB under lyrics:<trackId> (the one
// store of the database, no version change) and go with the download; a version whose source is
// out of reach (or gone) is read from there. The copies follow the downloads once their list or
// the library changed and things settled: an O(downloads) pass, never at rest.

import { srcApi } from './api.js';
import { sources } from './sources.js';
import { store } from './store.js';
import { orderVersions } from './songs.js';
import { knownOffset } from './media.js';
import { idbGet, idbSet, idbDel, idbKeys } from './idb.js';
import { downloads } from './downloads.js';

const KEEP = 50;
const FRESH_MS = 60000;
const MAX_LINES = 2000;
const IDB_PREFIX = 'lyrics:';
const SETTLE_MS = 3000;

const mem = new Map(); // `${sourceId}:${trackId}` -> { at, etag, lyr }, oldest first (lyr null: none)
const loading = new Map();
const listeners = new Set();

function emit() {
  for (const fn of listeners) {
    try {
      fn();
    } catch (err) {
      console.error('lyrics listener', err);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// pure pieces (the unit checks run them)

/** A source's answer (or a kept copy) as { kind: 'synced', lines } or { kind: 'plain', text }, or null. */
export function normLyrics(d) {
  if (!d || typeof d !== 'object') return null;
  if (d.kind === 'synced' && Array.isArray(d.lines)) {
    const lines = [];
    for (const l of d.lines) {
      if (lines.length >= MAX_LINES) break;
      const t = Number(l && l.t);
      if (!Number.isFinite(t) || t < 0) continue;
      lines.push({ t: Math.round(t), text: typeof l.text === 'string' ? l.text.slice(0, 2000) : '' });
    }
    // The source sorts them; a stable sort keeps a copy from elsewhere right too.
    lines.sort((a, b) => a.t - b.t);
    return lines.length ? { kind: 'synced', lines } : null;
  }
  if (d.kind === 'plain' && typeof d.text === 'string' && d.text.trim()) return { kind: 'plain', text: d.text.slice(0, 65536) };
  return null;
}

/** The current line: the last whose time is at or before ms; -1 before the first. */
export function currentLine(lines, ms) {
  let lo = 0;
  let hi = lines.length - 1;
  let at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= ms) {
      at = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return at;
}

/** The three lines of the card around line i: [first, end). Before the first line, the first three. */
export function cardWindow(n, i) {
  if (n <= 3) return [0, n];
  const first = i < 0 ? 0 : Math.min(Math.max(0, i - 1), n - 3);
  return [first, first + 3];
}

/** past, now or next of line k when line i is the current one. */
export const lineClass = (k, i) => (k < i ? 'past' : k === i ? 'now' : 'next');

/** The lines of a plain text (a synced one shown still: its lines' texts). */
export function plainLines(lyr) {
  if (!lyr) return [];
  if (lyr.kind === 'synced') return lyr.lines.map((l) => l.text);
  return lyr.text.replace(/\r\n?/g, '\n').split('\n');
}

/** The first n lines with words in them (the card of a plain text). */
export function firstLines(lyr, n = 4) {
  return plainLines(lyr).filter((l) => l.trim()).slice(0, n);
}

/** A text with at least one LRC time tag ([mm:ss], [mm:ss.x] ...) is kept as synced lyrics. */
export const looksSynced = (text) => /\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/.test(String(text || ''));

// ---------------------------------------------------------------------------------------------

const flagged = (v) => !!v && (v.t.lyrics === 'synced' || v.t.lyrics === 'plain');
// The phone's own music answers its lyrics (from the files' tags) with no songs part.
const atThree = (src) => sources.isLocal(src) || (sources.get(src)?.social || 0) >= 3;
/** Asked from its source now: at 3, connected, not a removed source's kept track. */
const reachable = (v) => !v.kept && atThree(v.sourceId) && sources.isUp(v.sourceId);
const keyOf = (v) => `${v.sourceId}:${v.trackId}`;

function remember(key, entry) {
  mem.delete(key);
  mem.set(key, entry);
  while (mem.size > KEEP) mem.delete(mem.keys().next().value);
}

/** Some version of the song has lyrics (no card, no full screen without). */
export function songHasLyrics(songId) {
  return store.loaded && telling(songId).some(flagged);
}

/** A song's versions whose lyrics count: the phone's copy of a file a reachable real source holds says nothing (that source decides). */
function telling(songId) {
  const all = store.versions(songId);
  return all.filter((x) => !sources.isLocal(x.sourceId) || !all.some((y) => y !== x && !sources.isLocal(y.sourceId) && y.fileHash === x.fileHash && reachable(y)));
}

/**
 * Where the song's lyrics come from: { v, off } with v the version whose text is shown and off the
 * offset from the version playing to it (null: unknown, the text shows still). null without any.
 */
export function lyricsSource(songId, playingTrackId) {
  if (!store.loaded) return null;
  const vs = telling(songId);
  const playing = vs.find((x) => x.trackId === playingTrackId) || vs[0] || null;
  if (flagged(playing)) return { v: playing, off: 0 };
  const others = vs.filter((x) => x !== playing && flagged(x));
  if (!others.length) return null;
  const order = orderVersions(others, 'max', (id) => sources.get(id));
  // A version that can be read now (asked, or kept offline) comes before one that cannot.
  const v = order.find((x) => reachable(x) || kept.has(x.trackId)) || order[0];
  return { v, off: knownOffset(playing, v) };
}

async function fetchOne(v) {
  const key = keyOf(v);
  const held = mem.get(key);
  let lyr = held ? held.lyr : null;
  let etag = held ? held.etag : null;
  let fromNet = false;
  if (reachable(v)) {
    try {
      const r = await srcApi(v.sourceId).lyrics(v.trackId, held && held.lyr ? held.etag : null);
      if (!r.notModified) {
        lyr = normLyrics(r.data);
        etag = r.etag || null;
      }
      fromNet = true;
    } catch (err) {
      if (err?.status === 404) {
        lyr = null;
        etag = null;
        fromNet = true;
      }
    }
  }
  if (!fromNet) {
    // Out of reach, or the request failed: the copy kept with a download, if any.
    const copy = await idbGet(IDB_PREFIX + v.trackId).catch(() => undefined);
    const k = normLyrics(copy);
    if (k) {
      lyr = k;
      etag = (copy && copy.etag) || null;
    }
  }
  remember(key, { at: fromNet ? Date.now() : 0, etag, lyr });
  // A kept copy follows the source: a newer text replaces it.
  if (fromNet && kept.has(v.trackId) && lyr && (!held || held.etag !== etag)) idbSet(IDB_PREFIX + v.trackId, { ...lyr, etag }).catch(() => {});
  return lyr;
}

export const lyrics = {
  /** The text held for a version (nothing is asked), or null. */
  held: (v) => (v ? mem.get(keyOf(v))?.lyr || null : null),
  /** It was asked at least once (an answer of none included). */
  known: (v) => !!v && mem.has(keyOf(v)),
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  /** Asks for a version's text unless one younger than 60 s is held. Resolves the text or null. */
  load(v) {
    if (!flagged(v)) return Promise.resolve(null);
    const key = keyOf(v);
    const held = mem.get(key);
    if (held && held.at && Date.now() - held.at < FRESH_MS) return Promise.resolve(held.lyr);
    let p = loading.get(key);
    if (!p) {
      p = fetchOne(v)
        .catch(() => null)
        .finally(() => {
          loading.delete(key);
          emit();
        });
      loading.set(key, p);
    }
    return p;
  },
  /** The text of these tracks changed here ("Aggiungi testo", "Togli testo"): asked again next time. */
  forget(trackIds) {
    for (const key of [...mem.keys()]) if (trackIds.includes(key.slice(key.indexOf(':') + 1))) mem.delete(key);
    emit();
  },
  /** The copies kept offline now (for the checks). */
  get keptIds() {
    return [...kept];
  },
  /** How many times the copies were brought in step with the downloads (for the checks). */
  get syncs() {
    return syncs;
  },
  /** Follow the downloads (the app only). */
  init() {
    if (!downloads.available) return;
    let seenDone = -1;
    // The songs moved since the last check (store.changed(): the list keeps its identity between
    // whole merges, so a patch is seen through what it moved).
    let songsMoved = true;
    store.subscribe(() => {
      const c = store.changed();
      if (c.all || c.songs.size) songsMoved = true;
    });
    const check = () => {
      if (downloads.doneSeq === seenDone && !songsMoved) return;
      seenDone = downloads.doneSeq;
      songsMoved = false;
      clearTimeout(syncTimer);
      syncTimer = setTimeout(syncKept, SETTLE_MS);
    };
    downloads.subscribe(check);
    store.subscribe(check);
    sources.subscribe(() => {
      // A source that was out of reach with a copy to give came back: it is asked now. Nothing
      // else of the sources (their times, their speed, every few seconds) asks anything again.
      if (![...missing].some((id) => atThree(id) && sources.isUp(id))) return;
      missing.clear();
      clearTimeout(syncTimer);
      syncTimer = setTimeout(syncKept, SETTLE_MS);
    });
    check();
  },
  /** Brings the kept copies in step with the downloads now (the checks call it). */
  sync: () => syncKept(),
};

// ---------------------------------------------------------------------------------------------
// the copies kept with the downloads

const kept = new Set(); // trackIds with a copy in IndexedDB
let keptRead = false;
let syncTimer = 0;
let syncing = null;
let syncs = 0;
const missing = new Set(); // the sources out of reach that hold a copy still to keep

async function syncKept() {
  if (syncing) {
    await syncing;
    return syncKept();
  }
  syncing = (async () => {
    syncs++;
    if (!keptRead) {
      for (const k of await idbKeys(IDB_PREFIX)) kept.add(k.slice(IDB_PREFIX.length));
      keptRead = true;
    }
    if (!store.loaded) return;
    const want = new Map(); // trackId -> version
    const known = new Set(); // downloaded trackIds the library knows
    for (const tid of downloads.doneIds) {
      const v = store.versions(tid).find((x) => x.trackId === tid);
      if (!v) continue;
      known.add(tid);
      if (flagged(v)) want.set(tid, v);
    }
    // Gone with the download, or the track no longer has lyrics.
    for (const tid of [...kept]) {
      if (want.has(tid)) continue;
      if (downloads.doneIds.has(tid) && !known.has(tid)) continue; // the library does not know it now: keep it
      kept.delete(tid);
      await idbDel(IDB_PREFIX + tid).catch(() => {});
    }
    missing.clear();
    for (const [tid, v] of want) {
      if (kept.has(tid)) continue;
      // Already here (the song was just playing): kept as it is, nothing asked.
      const m = mem.get(keyOf(v));
      if (m && m.lyr && m.at) {
        await idbSet(IDB_PREFIX + tid, { ...m.lyr, etag: m.etag }).catch(() => {});
        kept.add(tid);
        continue;
      }
      if (!reachable(v)) {
        // A removed source's track is never asked; a source out of reach, once it is back.
        if (!v.kept) missing.add(v.sourceId);
        continue;
      }
      try {
        const r = await srcApi(v.sourceId).lyrics(v.trackId);
        const lyr = normLyrics(r.data);
        if (!lyr) continue;
        await idbSet(IDB_PREFIX + tid, { ...lyr, etag: r.etag || null });
        kept.add(tid);
        remember(keyOf(v), { at: Date.now(), etag: r.etag || null, lyr });
      } catch (err) {
        // It went out of reach meanwhile: asked once it is back (a refusal waits for the next change).
        if (err?.status !== 404 && !reachable(v)) missing.add(v.sourceId);
      }
    }
  })().finally(() => {
    syncing = null;
  });
  return syncing;
}
