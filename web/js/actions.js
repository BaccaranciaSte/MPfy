// Play actions shared by cards, tiles, detail pages and menus.

import { player } from './player.js';
import { contextTracks, contextName } from './contexts.js';
import { ctxKey } from './util.js';
import { repeatTap } from './dom.js';
import { toast } from '../components/toast.js';

/** Plays a whole context (playlist, album, artist, liked) from the top, or from startCi. */
export function playCtx(ctx, startCi = null) {
  const ids = contextTracks(ctx);
  if (!ids.length) {
    toast('Nessun brano da riprodurre');
    return;
  }
  player.playContext({ ...ctx, name: contextName(ctx) }, ids, startCi);
}

/**
 * The big play button: pause/resume when this context is playing, otherwise start it. The second
 * tap of a double tap does not stop what the first one started (a tap after a pause does).
 */
export function togglePlayCtx(ctx) {
  if (repeatTap(`play|${ctxKey(ctx)}`)) return;
  if (player.isContext(ctx)) player.toggle();
  else playCtx(ctx);
}

export function queueCtx(ctx) {
  const ids = contextTracks(ctx);
  if (!ids.length) return;
  player.addToQueue(ids);
  toast('Aggiunto in coda');
}
