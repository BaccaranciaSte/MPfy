// Play contexts ({ type, id }): playlist, album, artist, liked, library, search.
// Resolves a context to its tracks, its name and its page; the contexts Home shows first.

import { store } from './store.js';
import { ctxKey } from './util.js';

export const LIKED_NAME = 'Brani che ti piacciono';
export const LIBRARY_NAME = 'La tua libreria';

/** Every track of an artist, newest album first, in album order. */
export function artistTrackIds(artistId) {
  const d = store.d;
  const ar = d.artists.get(artistId);
  if (!ar) return [];
  const out = [];
  for (const alId of ar.albumIds) {
    for (const id of d.albums.get(alId).trackIds) if (d.artistOf.get(id) === artistId) out.push(id);
  }
  return out;
}

export function contextTracks(ctx) {
  const d = store.d;
  switch (ctx?.type) {
    case 'playlist':
      // A playlist keeps the trackIds it was made with; each plays as its song.
      return (d.playlists.get(ctx.id)?.trackIds || []).filter((id) => d.tracks.has(id)).map((id) => d.tracks.get(id).id);
    case 'album':
      return (d.albums.get(ctx.id)?.trackIds || []).slice();
    case 'artist':
      return artistTrackIds(ctx.id);
    case 'liked':
      return d.likedIds.slice();
    default:
      return [];
  }
}

export function contextName(ctx) {
  const d = store.d;
  switch (ctx?.type) {
    case 'playlist':
      return d.playlists.get(ctx.id)?.name || ctx.name || 'Playlist';
    case 'album':
      return d.albums.get(ctx.id)?.name || ctx.name || 'Album';
    case 'artist':
      return d.artists.get(ctx.id)?.name || ctx.name || 'Artista';
    case 'liked':
      return LIKED_NAME;
    case 'search':
      return ctx.name || 'Ricerca';
    default:
      return ctx?.name || LIBRARY_NAME;
  }
}

export function contextHref(ctx) {
  switch (ctx?.type) {
    case 'playlist':
    case 'album':
    case 'artist':
      return `/${ctx.type}/${encodeURIComponent(ctx.id)}`;
    case 'liked':
      return '/liked';
    case 'search':
      return ctx.id ? `/search?q=${encodeURIComponent(ctx.id)}` : '/search';
    default:
      return '/library';
  }
}

/** Whether a context still exists (a deleted playlist does not). */
export function contextExists(ctx) {
  const d = store.d;
  switch (ctx?.type) {
    case 'playlist':
      return d.playlists.has(ctx.id);
    case 'album':
      return d.albums.has(ctx.id);
    case 'artist':
      return d.artists.has(ctx.id);
    case 'liked':
      return true;
    default:
      return false;
  }
}

/** Contexts played recently, newest first. Library and search plays count as their album. */
export function recentContexts() {
  const d = store.d;
  const seen = new Set();
  const out = [];
  const recents = [...store.lib.recents].sort((a, b) => (b.at || 0) - (a.at || 0));
  for (const r of recents) {
    let ctx = r.context && r.context.type ? { type: r.context.type, id: r.context.id ?? null } : null;
    if (!ctx || !['playlist', 'album', 'artist', 'liked'].includes(ctx.type)) {
      const alId = d.albumOf.get(r.trackId);
      ctx = alId ? { type: 'album', id: alId } : null;
    }
    if (!ctx) continue;
    const key = ctxKey(ctx);
    if (seen.has(key)) continue;
    seen.add(key);
    if (contextExists(ctx)) out.push(ctx);
  }
  return out;
}

/** The contexts of the Home tiles, up to limit: played recently, then liked, playlists, the newest albums. */
export function homeContexts(limit) {
  const d = store.d;
  const out = [];
  const used = new Set();
  const push = (ctx) => {
    if (out.length >= limit) return;
    const k = ctxKey(ctx);
    if (used.has(k)) return;
    used.add(k);
    out.push(ctx);
  };
  recentContexts().forEach(push);
  if (d.likedIds.length) push({ type: 'liked', id: null });
  for (const pl of store.lib.playlists) push({ type: 'playlist', id: pl.id });
  for (const al of [...d.albums.values()].sort((a, b) => b.addedAt - a.addedAt)) push({ type: 'album', id: al.id });
  return out;
}
