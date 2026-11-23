// Comments on songs, as the sources that speak the songs part (social 3) hold them. A song's
// comments are the union over its versions: for each source at 3 that holds a version, one GET
// with that source's trackIds of the song (at most 20), with the ETag it answered last (a 304
// costs no body); then the union by comment id (the first copy wins, every source that returned
// it is remembered), ONE per author (the newest), yours first, then the newest first.
//
// A song is asked when the full player opens, after 1 s on a track while it is open, and when the
// comments sheet opens; an answer is kept 60 s per song (the last 50 songs). Nothing is asked in
// the background, nothing counts or notifies.
//
// Writing is optimistic: the comment shows at the top at once; the page makes the id and the time
// (editing keeps the id of your comment and takes a new time) and posts it to each source at 3 that
// holds the song, with its first version's trackId there; it is done when one of them took it,
// else it goes and "Qualcosa non ha funzionato" says so. Your own comment is deleted everywhere it
// was returned; the owner of a source deletes someone else's there only. Deletes are optimistic
// too, and come back when every source refused them.

import { srcApi } from './api.js';
import { sources } from './sources.js';
import { store, roleOf } from './store.js';
import { profile } from './profile.js';
import { cleanNote, NOTE_MAX, newMessageId } from './chat-data.js';
import { toast } from '../components/toast.js';

export const COMMENT_MAX = NOTE_MAX;
const FRESH_MS = 60000;
const KEEP_SONGS = 50;
const MAX_IDS = 20;
const HEX32 = /^[0-9a-f]{32}$/;
const FAILED = 'Qualcosa non ha funzionato';

const songs = new Map(); // song id -> entry, oldest first
const listeners = new Set();

function emit(songId) {
  for (const fn of listeners) {
    try {
      fn(songId);
    } catch (err) {
      console.error('comments listener', err);
    }
  }
}

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/** One comment as a source answers it, or null when it is not one. */
export function normComment(c) {
  if (!c || typeof c !== 'object' || !HEX32.test(c.id || '') || !HEX32.test(c.from || '') || !Number.isFinite(Number(c.at))) return null;
  const text = str(c.text, 1200);
  if (!text) return null;
  return { id: c.id, trackId: str(c.trackId, 64), from: c.from, name: str(c.name, 80), at: Number(c.at), text };
}

/**
 * The comments of a song from its sources' answers ([{ src, list }], in source order): the union
 * by id (the first copy wins; `where` the sources that returned it), then one per author (the
 * newest; `older` the author's other copies, with their sources), yours first, then the newest
 * first. Pure: the unit checks run it.
 */
export function unionComments(answers, me = null) {
  const byId = new Map();
  for (const { src, list } of answers) {
    for (const c of list) {
      const had = byId.get(c.id);
      if (had) {
        if (!had.where.includes(src)) had.where.push(src);
        continue;
      }
      byId.set(c.id, { ...c, where: [src], older: [] });
    }
  }
  const byAuthor = new Map();
  for (const c of byId.values()) {
    const had = byAuthor.get(c.from);
    if (!had) byAuthor.set(c.from, c);
    else if (c.at > had.at || (c.at === had.at && c.id > had.id)) {
      c.older.push(...had.older, { id: had.id, where: had.where });
      had.older = [];
      byAuthor.set(c.from, c);
    } else had.older.push({ id: c.id, where: c.where });
  }
  const mine = (c) => (me && c.from === me ? 1 : 0);
  return [...byAuthor.values()].sort((a, b) => mine(b) - mine(a) || b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** The sources a song's comments live on: at social 3, with the song's trackIds there, in source order. */
function placesOf(songId) {
  if (!store.loaded) return [];
  const out = new Map();
  for (const v of store.versions(songId)) {
    if (v.kept || (sources.get(v.sourceId)?.social || 0) < 3) continue;
    let ids = out.get(v.sourceId);
    if (!ids) out.set(v.sourceId, (ids = []));
    if (ids.length < MAX_IDS && !ids.includes(v.trackId)) ids.push(v.trackId);
  }
  const order = sources.ordered().map((s) => s.id);
  return [...out.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([src, ids]) => ({ src, ids }));
}

const myId = () => (profile.data && profile.data.id) || null;

function entryOf(songId, create = true) {
  let e = songs.get(songId);
  if (e) {
    songs.delete(songId);
    songs.set(songId, e);
    return e;
  }
  if (!create) return null;
  e = { at: 0, loaded: false, inflight: null, bySrc: new Map(), post: null, hidden: new Set(), view: null };
  songs.set(songId, e);
  while (songs.size > KEEP_SONGS) {
    const [oldId, old] = songs.entries().next().value;
    if (old.inflight || old.post) break;
    songs.delete(oldId);
  }
  return e;
}

/** What the screen shows: the union, without what is being deleted, with the comment being written on top. */
function viewOf(e, songId) {
  if (e.view) return e.view;
  const places = new Set(placesOf(songId).map((p) => p.src));
  const answers = [];
  for (const [src, a] of e.bySrc) if (places.has(src)) answers.push({ src, list: a.list });
  const me = myId();
  let list = unionComments(answers, me).filter((c) => !e.hidden.has(c.id));
  if (e.post) list = [e.post, ...list.filter((c) => c.from !== me)];
  e.view = list;
  return list;
}

function changed(songId, e) {
  e.view = null;
  emit(songId);
}

/** Asks the song's sources that are up. Resolves how many of them answered. */
async function fetchSong(songId, e) {
  const places = placesOf(songId).filter((p) => sources.isUp(p.src));
  let answered = 0;
  await Promise.all(
    places.map(async ({ src, ids }) => {
      const key = ids.join(',');
      const held = e.bySrc.get(src);
      try {
        const r = await srcApi(src).comments(ids, held && held.key === key ? held.etag : null);
        answered++;
        if (r.notModified && held) return;
        const list = (Array.isArray(r.data?.comments) ? r.data.comments : []).map(normComment).filter(Boolean);
        e.bySrc.set(src, { key, etag: r.notModified ? null : r.etag, list });
      } catch {
        /* that source's last answer stays (or none): the next opening asks again */
      }
    })
  );
  return answered;
}

export const comments = {
  /** Some source at 3 holds this song: the "Commenti" card and the menu item exist. */
  possible: (songId) => placesOf(songId).length > 0,
  /** { list, loaded }: what is held for the song now (nothing is asked). */
  of(songId) {
    const e = songs.get(songId);
    if (!e) return { list: [], loaded: false };
    return { list: viewOf(e, songId), loaded: e.loaded };
  },
  /** Your comment on the song, or null. */
  mine(songId) {
    const me = myId();
    return (me && comments.of(songId).list.find((c) => c.from === me)) || null;
  },
  /** The owner of a source that returned it may delete someone else's comment there. */
  mayModerate: (c) => !!c && c.from !== myId() && c.where.some((s) => roleOf(s) === 'owner'),
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  /**
   * Asks the song's sources, unless the answer held is younger than 60 s (force: ask anyway).
   * One request per source at a time; a second call while it runs gets the same promise.
   */
  load(songId, { force = false } = {}) {
    if (!songId || !comments.possible(songId)) return Promise.resolve();
    const e = entryOf(songId);
    if (e.inflight) return e.inflight;
    if (!force && e.loaded && Date.now() - e.at < FRESH_MS) return Promise.resolve();
    e.inflight = fetchSong(songId, e)
      .then((answered) => {
        // Known only once a source answered: with every one out of reach the card does not say
        // there is nothing, and the next opening asks again.
        if (!answered) return;
        e.at = Date.now();
        e.loaded = true;
      })
      .catch(() => {})
      .finally(() => {
        e.inflight = null;
        changed(songId, e);
      });
    return e.inflight;
  },

  /**
   * Writes your comment (a new one, or yours edited). Resolves true when a source took it, false
   * otherwise (the comment then goes, with a toast). One write per song at a time.
   */
  async post(songId, raw) {
    const text = cleanNote(raw);
    const me = myId();
    if (!text || !me) return false;
    const e = entryOf(songId);
    if (e.post) return false;
    const places = placesOf(songId).filter((p) => sources.isUp(p.src));
    const own = comments.mine(songId);
    const c = { id: own ? own.id : newMessageId(), trackId: '', from: me, name: profile.name || '', at: Date.now(), text, where: [], older: [], local: true };
    e.post = c;
    changed(songId, e);
    const took = [];
    await Promise.all(
      places.map(async ({ src, ids }) => {
        // Yours edited goes to the track it lives on there (its id belongs to it); a new one to the first version's.
        const had = e.bySrc.get(src);
        const there = had && had.list.find((x) => x.id === c.id);
        try {
          const r = await srcApi(src).postComment({ id: c.id, trackId: there && ids.includes(there.trackId) ? there.trackId : ids[0], at: c.at, text });
          const kept = normComment(r?.comment);
          if (!kept) return;
          took.push(src);
          const held = e.bySrc.get(src) || { key: ids.join(','), etag: null, list: [] };
          // The source keeps one per author per track: the one it kept replaces yours there.
          const list = held.list.filter((x) => !(x.from === me && (x.trackId === kept.trackId || x.id === kept.id)));
          e.bySrc.set(src, { ...held, etag: null, list: [kept, ...list] });
        } catch {
          /* another source may take it */
        }
      })
    );
    e.post = null;
    if (took.length) {
      // What else of yours was on the sources that did not take it shows no more than the new one.
      e.loaded = true;
      e.at = Date.now();
    } else toast(FAILED);
    changed(songId, e);
    return took.length > 0;
  },

  /**
   * Deletes a comment: yours everywhere it was returned (with your older copies), someone else's
   * only on the sources you own that returned it. Resolves true when it went somewhere.
   */
  async remove(songId, c) {
    if (!c) return false;
    const e = entryOf(songId);
    const me = myId();
    const own = c.from === me;
    const targets = [];
    const add = (id, where) => {
      for (const src of where) if (!targets.some((t) => t.id === id && t.src === src) && (own || roleOf(src) === 'owner')) targets.push({ id, src });
    };
    add(c.id, c.where);
    if (own) for (const o of c.older || []) add(o.id, o.where);
    if (!targets.length) return false;
    const ids = new Set(targets.map((t) => t.id));
    for (const id of ids) e.hidden.add(id);
    changed(songId, e);
    let gone = 0;
    await Promise.all(
      targets.map(async ({ id, src }) => {
        try {
          await srcApi(src).deleteComment(id);
          gone++;
        } catch (err) {
          if (err?.status !== 404) return;
          gone++; // already gone there
        }
        const held = e.bySrc.get(src);
        if (held) e.bySrc.set(src, { ...held, etag: null, list: held.list.filter((x) => x.id !== id) });
      })
    );
    for (const id of ids) e.hidden.delete(id);
    if (!gone) toast(FAILED);
    changed(songId, e);
    return gone > 0;
  },

  /** Forgets every answer held (a test, or the profile changed). */
  reset() {
    songs.clear();
  },
};
