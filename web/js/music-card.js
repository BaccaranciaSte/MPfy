// What a music card shared in a chat is in your library, and what its taps do (the chat's cards
// and Home's "Condivisi con te" alike):
//   a track     the song of its trackId in your library, else the one song of the same title and
//               artist; a tap opens its album, play plays it alone
//   an album    the album of the same id (artist and name); a tap opens it, play plays it
//   a playlist  read whole from a source where it lives (chat.js); a tap opens the shared view (your
//               own playlist: its page), play plays the tracks your library has
// Nothing found: "Nessun brano disponibile". The cover: from your library (a playlist: the mosaic
// of the first 4 covers found in the copy read last, else the cover its card names, from the
// sources), else a grey one.
//
// A shared playlist may hold thousands of tracks: what your library has of a copy is worked out
// once per copy and per library (songsOfCopy), never at each drawing.

import { store } from './store.js';
import { player } from './player.js';
import { navigate } from './router.js';
import { songOf } from './theirs.js';
import { contextTracks } from './contexts.js';
import { specs } from '../components/cover.js';
import { toast } from '../components/toast.js';
import { readSharedPlaylist, playlistCopyNow } from './chat.js';
import { cleanNote, cutPoints } from './chat-data.js';

const NONE = 'Nessun brano disponibile';

/** The song a track card names in your library, or null. */
export const cardSong = (card) => (card.kind === 'track' ? songOf({ trackId: card.id, title: card.title, artist: card.sub }) : null);

/** The album an album card names in your library, or null. */
export const cardAlbum = (card) => (card.kind === 'album' && store.d ? store.d.albums.get(card.id) || null : null);

/** Your own playlist of that id, when the card is yours and it is still in your library. */
const ownPlaylist = (card, mine) => (card.kind === 'playlist' && mine && store.d ? store.d.playlists.get(card.id) || null : null);

/** The songs of your library among trackIds (each once, in order). */
export function songsOf(trackIds) {
  const out = [];
  const seen = new Set();
  for (const tid of trackIds || []) {
    const s = store.track(tid);
    if (!s || seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s.id);
  }
  return out;
}

// What the library has of a copy, and its mosaic: worked out again only for another copy or another
// library (store.d is a new object after every change of the library).
const ofCopy = new WeakMap(); // copy -> { d, ids, spec }

function copyInfo(copy) {
  const d = store.d;
  const had = ofCopy.get(copy);
  if (had && had.d === d) return had;
  const ids = songsOf(copy.trackIds);
  const info = { d, ids, spec: specs.playlist({ id: null, trackIds: ids }) };
  ofCopy.set(copy, info);
  return info;
}

/** The songs of your library a copy of a shared playlist brings (each once, in its order). */
export const songsOfCopy = (copy) => (copy && store.d ? copyInfo(copy).ids : []);

/** The cover of a card now: { spec } as cover.js draws it (a grey one when nothing is found). */
export function cardCover(card, at = {}) {
  const mine = !!at.mine;
  if (!store.loaded || !store.d) return { kind: 'ph', icon: card.kind === 'album' ? 'album' : 'note' };
  if (card.kind === 'track') {
    const s = cardSong(card);
    return s ? specs.track(s) : { kind: 'ph', icon: 'note' };
  }
  if (card.kind === 'album') {
    const al = cardAlbum(card);
    return al ? specs.album(al) : { kind: 'ph', icon: 'album' };
  }
  const own = ownPlaylist(card, mine);
  if (own) return specs.playlist(own);
  const copy = at ? playlistCopyNow(at.cid, at.messageId) : null;
  if (copy) {
    const { spec } = copyInfo(copy);
    if (spec.kind !== 'ph') return spec;
  }
  // Its own cover lives where the playlist does: asked there when your libraries do not know it.
  return card.cover ? { kind: 'img', id: card.cover, small: card.cover, via: card.sources || [] } : { kind: 'ph', icon: 'playlist' };
}

/** Where a card points: { cid, messageId, from, mine } of the message that carries it. */
export function openCard(card, at) {
  if (card.kind === 'track') {
    const s = cardSong(card);
    const al = s && store.d.albumOf.get(s.id);
    if (al) navigate(`/album/${al}`);
    else toast(NONE);
    return;
  }
  if (card.kind === 'album') {
    if (cardAlbum(card)) navigate(`/album/${card.id}`);
    else toast(NONE);
    return;
  }
  if (ownPlaylist(card, at.mine)) navigate(`/playlist/${card.id}`);
  else {
    opened.set(`${at.cid}:${at.messageId}`, { card, from: at.from });
    navigate(`/condivisa/${at.cid}/${at.messageId}`);
  }
}

// The cards whose shared view was opened in this session: the view shows their name at once.
const opened = new Map();
/** { card, from } of the shared playlist of that message, as the card that opened it said. */
export const openedCard = (cid, messageId) => opened.get(`${cid}:${messageId}`) || null;

/** The songs of your library a card brings (a playlist is read from its source first). */
export async function cardTracks(card, at) {
  if (card.kind === 'track') {
    const s = cardSong(card);
    return s ? [s.id] : [];
  }
  if (card.kind === 'album') return cardAlbum(card) ? contextTracks({ type: 'album', id: card.id }) : [];
  const own = ownPlaylist(card, at.mine);
  if (own) return contextTracks({ type: 'playlist', id: own.id });
  const r = await readSharedPlaylist(at.cid, at.messageId);
  return r && r.playlist ? songsOfCopy(r.playlist) : [];
}

/** Play: a track alone, an album, the tracks of a playlist your library has. */
export async function playCard(card, at) {
  const ids = await cardTracks(card, at);
  if (!ids.length) {
    toast(NONE);
    return;
  }
  if (card.kind === 'album') player.playContext({ type: 'album', id: card.id, name: card.title }, ids, 0);
  else if (card.kind === 'playlist') player.playContext({ type: 'library', id: null, name: card.title }, ids, 0);
  else player.playContext({ type: 'library', id: null }, ids, 0);
}

/** "Aggiungi in coda". */
export async function queueCard(card, at) {
  const ids = await cardTracks(card, at);
  if (!ids.length) {
    toast(NONE);
    return;
  }
  player.addToQueue(ids);
  toast('Aggiunto in coda');
}

// A title or a sub as a card carries it: one line of at most 200 characters (a longer tag would
// make the whole message refused).
const cardLine = (s) => cutPoints(cleanNote(s), 200);

/** A card made from what you share: a track (its first version), an album or a playlist. */
export function cardOfTrack(t) {
  const v = store.versions(t.id)[0];
  return { kind: 'track', id: (v && v.trackId) || t.id, title: cardLine(t.title), sub: cardLine(t.artist) };
}

export const cardOfAlbum = (al) => ({ kind: 'album', id: al.id, title: cardLine(al.name), sub: cardLine(al.artist) });

/**
 * A playlist: its id, name, track count, the sources where it lives and its cover (its own, else its
 * first track's), never its tracks: they are read from those sources when someone opens it.
 */
export function cardOfPlaylist(pl) {
  const d = store.d;
  const own = d.playlistCover.get(pl.id);
  let first = null;
  for (const tid of pl.trackIds || []) {
    const s = store.track(tid);
    if (s && d.trackCover.get(s.id)) {
      first = s;
      break;
    }
  }
  const cover = own ? own.small : first ? d.trackCover.get(first.id).small : null;
  const card = { kind: 'playlist', id: pl.id, title: cardLine(pl.name), sub: '', n: (pl.trackIds || []).length, sources: store.playlistSources(pl.id) };
  if (cover) card.cover = cover;
  return card;
}
