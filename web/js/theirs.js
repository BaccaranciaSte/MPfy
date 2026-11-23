// Someone else's music in your library. What a person plays or played names the trackId of the
// version they heard, on their source: here it is the song of that trackId when your library has
// it (any version of it), else the one song whose title and artist both match (accents, case and
// spaces aside), else nothing. Played alone, as a single track of the library.

import { store } from './store.js';
import { player } from './player.js';
import { norm } from './util.js';
import { toast } from '../components/toast.js';

const flat = (s) => norm(s).replace(/\s+/g, ' ');
const keyOf = (title, artist) => `${flat(title)}\u0000${flat(artist)}`;

let index = null;
// Made again on first use after the songs moved (the list keeps its identity between whole merges).
store.subscribe(() => {
  const c = store.changed();
  if (c.all || c.songs.size) index = null;
});
/** title and artist -> the one song with them (null when two songs share them). */
function byText() {
  if (index) return index;
  index = new Map();
  for (const t of store.lib.tracks) {
    const k = keyOf(t.title, t.artist);
    index.set(k, index.has(k) ? null : t.id);
  }
  return index;
}

/** The song of your library for { trackId, title, artist }, or null. */
export function songOf(t) {
  if (!t || !store.loaded || !store.d) return null;
  const s = store.track(t.trackId);
  if (s) return s;
  const id = byText().get(keyOf(t.title, t.artist));
  return id ? store.track(id) || null : null;
}

/** Plays it alone; "Nessun brano disponibile" when your library has no such song. */
export function playTheirs(t) {
  const s = songOf(t);
  if (!s) {
    toast('Nessun brano disponibile');
    return false;
  }
  player.playContext({ type: 'library', id: null }, [s.id], 0);
  return true;
}
