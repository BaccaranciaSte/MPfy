// The heart outside the page (the Android app, bridge 4): the media notification, the lock screen
// and the car like and unlike the song playing by themselves, on the principal. Both sides stay in
// step: every like change the page sees (its own, a rollback, another device's) goes to the app
// with setLiked, and the app's own come back as 'liked' events.

import { store } from './store.js';
import { player } from './player.js';
import { native, nativeCall, onNative, bridgeVersion } from './native.js';
import { toast } from '../components/toast.js';

// The app matches setLiked by the id an item has there: a song's id now (the car's items, its
// snapshot), or the id a queue item was queued with, which stays when the song's id moves (its
// principal changes, or the principal gets a copy of it). Each such id is told the like state of
// the song it belongs to now.
let told = null; // id -> the liked trackIds the app was last told for it

const tell = (id, likedIds) => nativeCall('setLiked', JSON.stringify({ id, liked: likedIds.length > 0, likedIds }));
const same = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

function sync() {
  if (!store.loaded) return;
  const now = store.likedGroups();
  const of = (id) => now.get(store.gid(id)) || [];
  const queued = new Set(player.state.items.map((it) => it.id));
  if (!told) {
    // The queue and the car's snapshot carry the like state when they are sent; a queue handed
    // over before the library was here may have said "not liked": its liked songs are told now.
    told = new Map(now);
    for (const id of queued) {
      const ids = of(id);
      if (!ids.length) continue;
      tell(id, ids);
      told.set(id, ids);
    }
    return;
  }
  const next = new Map();
  for (const id of new Set([...now.keys(), ...told.keys(), ...queued])) {
    const ids = of(id);
    if (!same(told.get(id) || [], ids)) tell(id, ids);
    if (ids.length) next.set(id, ids);
  }
  told = next;
}

export const heart = {
  init() {
    if (!native || bridgeVersion() < 4) return;
    store.subscribe(sync);
    sync();
    onNative('liked', (e) => {
      if (!e || typeof e.id !== 'string' || !e.id) return;
      if (e.ok === true) store.applyLiked(e.id, e.liked === true);
      // Nothing changed anywhere: what the page shows is what the heart tried to change.
      else toast(store.isLiked(e.id) ? 'Mi piace non rimosso' : 'Mi piace non salvato');
    });
  },
};
