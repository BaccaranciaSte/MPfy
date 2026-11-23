// What this page plays, told to the local core (PUT /local/activity { track, playing }), which
// passes it on to the people of your sources as your "now playing" and your recent plays. Only
// where the page itself is the player: in a browser on a PC, or in an app whose own player does
// not report yet (bridge below 5). From bridge 5 the Android player reports, also with the page
// closed, and the page sends nothing.
//
// A report goes when the music starts or pauses, when the track (the version playing) changes
// while it plays, and every 60 s while it plays. An empty queue says nothing. One request at a time: a newer
// report waiting replaces the one before it. The core decides what reaches the sources (nothing
// while you are invisible or in a private session).

import { player } from './player.js';
import { store } from './store.js';
import { sources, localRequest } from './sources.js';
import { bridgeVersion } from './native.js';

export const HEARTBEAT_MS = 60000;

/** The page reports only without the app's bridge, or with one older than 5 (compared as numbers). */
export const pageReports = (version) => !(Number(version) >= 5);

/**
 * The reporter itself, free of the player (the checks drive it): update(state) with
 * { track: { trackId, title, artist, album, artistPage }, playing } or null (an empty queue).
 * send(body) returns a promise; may() says whether reports go out at all right now.
 */
export function createReporter({ send, may = () => true, later = setTimeout, cancel = clearTimeout, every = HEARTBEAT_MS }) {
  let last = null; // the state last seen
  let lastSig = null;
  let beat = 0;
  let inFlight = false;
  let waiting = null;

  const sigOf = (s) => (s ? `${s.track ? s.track.trackId : ''}|${s.playing ? 1 : 0}` : '');

  async function go(body) {
    if (inFlight) {
      waiting = body;
      return;
    }
    inFlight = true;
    let next = body;
    while (next) {
      try {
        await send(next);
      } catch {
        /* the core is away: the next report covers it */
      }
      next = waiting;
      waiting = null;
    }
    inFlight = false;
  }

  function report() {
    if (!last || !may()) return;
    go({ track: last.track, playing: !!last.playing });
  }

  function arm() {
    cancel(beat);
    beat = 0;
    if (!last || !last.playing) return;
    beat = later(() => {
      beat = 0;
      report();
      arm();
    }, every);
  }

  return {
    /** The player's state now. The first one seen is where the page starts: not a change. */
    update(state, { first = false } = {}) {
      if (!state || !state.track) {
        last = null;
        lastSig = null;
        arm();
        return;
      }
      const sig = sigOf(state);
      const wasPlaying = !!last && !!last.playing;
      last = state;
      if (sig === lastSig) return;
      lastSig = sig;
      arm();
      // Paused before and after (a song loaded, not started yet): nothing anyone sees changed.
      if (first || (!state.playing && !wasPlaying)) return;
      report();
    },
    stop() {
      cancel(beat);
      beat = 0;
      last = null;
    },
  };
}

/** What the player plays now, as a report says it, or null with an empty queue. */
export function playerState() {
  const it = player.currentItem();
  const t = it ? store.track(it.id) : null;
  if (!it || !t) return null;
  const ctx = player.state.context;
  // A song only the phone holds is never reported (nothing of its files leaves the phone); the
  // phone's copy of a song a source holds too is reported as that source's version.
  const vs = store.versions(it.id);
  const others = vs.filter((v) => !sources.isLocal(v.sourceId));
  if (vs.length && !others.length) return { track: null, playing: !!player.state.playing };
  let trackId = player.playingVersionId() || it.id;
  if (vs.some((v) => v.trackId === trackId && sources.isLocal(v.sourceId)) && !others.some((v) => v.trackId === trackId)) trackId = others[0].trackId;
  return {
    track: { trackId, title: t.title || '', artist: t.artist || '', album: t.album || '', artistPage: !it.m && !!ctx && ctx.type === 'artist' },
    playing: !!player.state.playing,
  };
}

let reporter = null;

/** Starts reporting from this page when it is the one that plays (once). */
export function startActivity() {
  if (reporter || !pageReports(bridgeVersion())) return;
  reporter = createReporter({
    send: (body) => localRequest('PUT', '/local/activity', body, 10000),
    // Only on the core's own word (not the list an earlier session saved): an older core has no
    // such endpoint.
    may: () => sources.loaded && sources.social(),
  });
  reporter.update(playerState(), { first: true });
  player.onChange(() => reporter.update(playerState()));
  store.subscribe(() => reporter.update(playerState()));
}
