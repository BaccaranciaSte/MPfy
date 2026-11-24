// The genres of the library: each family of Cerca (genres.js MACROS) with its songs and the
// genres in it, read from the genres of every version of a song (one of each); a song with none
// takes those of its album, else of its artist. The songs of a
// family or a genre are in the order "Play" follows: artist of the album, album, disc, number,
// title. Made again only after the store moved (store.changed().seq).
//
// A page id is a family ("pop") or a family and one of its genres ("pop.jpop"): keys are letters
// and digits only (genres.js genreKey), so the dot never belongs to one.

import { store } from './store.js';
import { genreOf, MACROS } from './genres.js';
import { cmpText } from './util.js';

const known = new Map(); // a genre as tagged -> genreOf() of it (null kept too)
function lookup(g) {
  let v = known.get(g);
  if (v === undefined) {
    v = genreOf(g);
    if (known.size > 20000) known.clear();
    known.set(g, v);
  }
  return v;
}

/** The genres of a song: those of each version, one of each key. */
function genresOfSong(song) {
  const out = new Map();
  const lists = Array.isArray(song.versions) && song.versions.length ? song.versions.map((v) => v.t && v.t.genres) : [song.genres];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const g of list) {
      const x = typeof g === 'string' ? lookup(g) : null;
      if (x && !out.has(x.key)) out.set(x.key, x);
    }
  }
  return out;
}

const num = (v) => (typeof v === 'number' && v > 0 ? v : 1e9);
// By the names the files sort them under (the sort tags) when they have them.
const sortOf = (t, k) => (t.sort && t.sort[k]) || null;
const artistKey = (t) => sortOf(t, 'albumArtist') || (t.albumArtist && t.albumArtist !== t.artist ? t.albumArtist : sortOf(t, 'artist')) || t.albumArtist || t.artist || '';
function inOrder(a, b) {
  return (
    cmpText(artistKey(a), artistKey(b)) ||
    cmpText(sortOf(a, 'album') || a.album || '', sortOf(b, 'album') || b.album || '') ||
    num(a.discNo) - num(b.discNo) ||
    num(a.trackNo) - num(b.trackNo) ||
    cmpText(sortOf(a, 'title') || a.title || '', sortOf(b, 'title') || b.title || '')
  );
}

let memo = null; // { seq, index }

/** { families: Map(id -> { id, name, songs, genres: Map(key -> { key, name, songs }) }) } */
export function genreIndex() {
  const seq = typeof store.changed === 'function' ? store.changed().seq : null;
  if (memo && seq !== null && memo.seq === seq) return memo.index;
  const families = new Map();
  // A song with no genre of its own takes its album's, else its artist's (what their other songs have).
  const d = store.d;
  const songs = store.lib.tracks || [];
  const own = new Map();
  const byAlbum = new Map();
  const byArtist = new Map();
  for (const song of songs) {
    const gs = genresOfSong(song);
    if (!gs.size) continue;
    own.set(song, gs);
    for (const [map, key] of [[byAlbum, d.albumOf.get(song.id)], [byArtist, d.artistOf.get(song.id)]]) {
      if (key == null) continue;
      let m = map.get(key);
      if (!m) map.set(key, (m = new Map()));
      for (const [k, g] of gs) if (!m.has(k)) m.set(k, g);
    }
  }
  for (const song of songs) {
    const gs = own.get(song) || byAlbum.get(d.albumOf.get(song.id)) || byArtist.get(d.artistOf.get(song.id));
    if (!gs || !gs.size) continue;
    const inFamily = new Set();
    for (const g of gs.values()) {
      let f = families.get(g.macro);
      if (!f) {
        f = { id: g.macro, name: MACROS.find((m) => m.id === g.macro).name, songs: [], genres: new Map() };
        families.set(g.macro, f);
      }
      if (!inFamily.has(f)) {
        inFamily.add(f);
        f.songs.push(song);
      }
      let sub = f.genres.get(g.key);
      if (!sub) {
        sub = { key: g.key, name: g.name, songs: [] };
        f.genres.set(g.key, sub);
      }
      sub.songs.push(song);
    }
  }
  for (const f of families.values()) {
    f.songs.sort(inOrder);
    for (const sub of f.genres.values()) sub.songs.sort(inOrder);
  }
  const index = { families };
  memo = { seq, index };
  return index;
}

/** The families with songs, in the order of MACROS: [{ id, name, count, trackIds }]. */
export function genreFamilies() {
  const { families } = genreIndex();
  return MACROS.filter((m) => families.has(m.id)).map((m) => {
    const f = families.get(m.id);
    return { id: f.id, name: f.name, count: f.songs.length, trackIds: f.songs.slice(0, 200).map((s) => s.id) };
  });
}

/**
 * The page of a family or of a genre: { id, title, family, genre (null on a family's page),
 * songs, genres: [{ id, name, count }] (the family's, most songs first) }, or null.
 */
export function genrePage(id) {
  const [fid, key = null] = String(id || '').split('.');
  const f = genreIndex().families.get(fid);
  if (!f) return null;
  const sub = key === null ? null : f.genres.get(key);
  if (key !== null && !sub) return null;
  const genres = [...f.genres.values()]
    .sort((a, b) => b.songs.length - a.songs.length || cmpText(a.name, b.name))
    .map((g) => ({ id: `${f.id}.${g.key}`, name: g.name, count: g.songs.length }));
  return { id: sub ? `${f.id}.${sub.key}` : f.id, title: sub ? sub.name : f.name, family: { id: f.id, name: f.name }, genre: sub ? { key: sub.key, name: sub.name } : null, songs: sub ? sub.songs : f.songs, genres };
}

export const genreHref = (id) => `/genere/${id}`;

/** The families and genres whose name holds every word of the query (normalized): [{ id, name, count, family }]. */
export function searchGenres(words, norm) {
  if (!words.length) return [];
  const out = [];
  for (const f of genreIndex().families.values()) {
    const fn = norm(f.name);
    if (words.every((w) => fn.includes(w))) out.push({ id: f.id, name: f.name, count: f.songs.length, family: null });
    for (const g of f.genres.values()) {
      if (g.name === f.name) continue;
      const gn = norm(g.name);
      const gk = g.key;
      if (words.every((w) => gn.includes(w) || gk.includes(w.replace(/[^a-z0-9]/g, '')))) out.push({ id: `${f.id}.${g.key}`, name: g.name, count: g.songs.length, family: f.name });
    }
  }
  return out.sort((a, b) => b.count - a.count).slice(0, 8);
}
