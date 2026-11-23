// Native player backend (Android app): Media3 ExoPlayer in a MediaSessionService plays the whole
// list we give it with setQueue, owns background playback, notification, lock screen, Bluetooth
// and audio focus, and reports state (index, position, playing, quality served) every 500 ms
// while playing. A playback error comes as { type: 'error', message, itemId }. With bridge 4 the
// state carries queueId: the page's own (16 hex) or one the app gave a queue set by someone else
// (the car, a resumption: n plus 15 hex), whose list getQueue() hands over.

import { nativeCall, nativeJson, onNative } from './native.js';

export function createNativeBackend(h) {
  onNative('state', (s) => h.native(s));
  onNative('error', (m) => h.error(m.message || '', typeof m.itemId === 'string' ? m.itemId : null));

  return {
    native: true,
    /**
     * items: [{ id, title, artist, album, albumArtist, trackNo, artworkUrl, url, quality,
     * durationMs, versions, liked, likedIds, ctx }] (absolute URLs, url with ?q=). When the item at
     * index has the id of the one playing, the app keeps it playing and replaces only the items
     * around it. queueId names the list (bridge 4). keep: an edit of the items around the one
     * playing; when the app moved on to another item before the list arrived, it goes on with that
     * one where the list holds it.
     */
    setQueue(items, index, positionSec, playWhenReady, queueId = null, keep = false) {
      nativeCall('setQueue', JSON.stringify({
        queueId,
        items,
        index,
        positionMs: Math.max(0, Math.round((positionSec || 0) * 1000)),
        playWhenReady: !!playWhenReady,
        keep: !!keep,
      }));
    },
    play: () => nativeCall('play'),
    pause: () => nativeCall('pause'),
    seek: (sec) => nativeCall('seekTo', String(Math.max(0, Math.round(sec * 1000)))),
    skipTo: (index) => nativeCall('skipTo', String(index)),
    next: () => nativeCall('next'),
    previous: () => nativeCall('previous'),
    setRepeat: (mode) => nativeCall('setRepeat', mode),
    setVolume() {
      /* system volume */
    },
    getState: () => nativeJson('getState'),
    /** { queueId, index, positionMs, items: [{ id, title, artist, album, durationMs, ctx }] } (bridge 4). */
    getQueue: () => nativeJson('getQueue'),
  };
}
