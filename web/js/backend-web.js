// Web player backend: one HTMLAudioElement playing, a second one ready with what comes next. It
// plays one queue item at a time; player.js decides what comes next and names it (preload). Lock screen and Bluetooth controls go through navigator.mediaSession
// (player.js). The level a source served is read from X-MPfy-Quality with a HEAD on the same URL.
//
// An item comes with its versions (the same song on several sources), in the order to try them.
// It plays the first; on an error, or when it waits for data 4 s without moving while a version
// not tried yet is left, it loads the first untried one at the same moment of the song: the
// position minus the old version's offset plus the new one's (offsets in ms against the first
// version of the list; 0 for the same file). Only when every version was tried does the player
// hear about it, and it learns which ones were (tried).
//
// Gapless, nearly: the last PRELOAD_S of a song the next item's first version loads in the spare
// element; when that item is loaded from its start the two elements swap and it plays at once,
// with nothing to fetch or decode. Only the element playing is heard from.

const STALL_MS = 4000;
const PRELOAD_S = 30;

export function createWebBackend(h) {
  let audio = new Audio();
  audio.preload = 'auto';
  let spare = new Audio();
  spare.preload = 'auto';
  let want = null; // the next item player.js named: { id, version }
  let spareFor = null; // what the spare holds: { id, key }
  let swaps = 0;
  let loadedId = null;
  let list = []; // versions of the loaded item: [{ url, sourceId, trackId, fileHash, offsetMs }]
  let vi = 0; // the version playing
  let tried = new Set(); // keys of the versions of this item loaded so far
  let pendingSeek = null;
  let wantPlay = false;
  let lastPos = 0; // the last position the element really reached (or the one asked at load)
  let waitingSince = 0;
  // One failure shows up twice (the media 'error' event and the rejected play() promise), and a
  // late one can belong to a version we already replaced: each load reports at most one, and only
  // while it is current.
  let gen = 0;
  let failedGen = -1;

  // While a new version loads, the element says 0 until its metadata let us seek: the position
  // asked is the one to report, not a jump back to the start.
  const position = () => (pendingSeek != null ? pendingSeek : audio.currentTime);
  const time = () => h.time(position(), audio.duration);
  const on = (ev, fn) => {
    for (const el of [audio, spare]) el.addEventListener(ev, (e) => e.target === audio && fn(e));
  };
  on('timeupdate', () => {
    fillSpare();
    // Progress: the music moves (a position not yet applied, or a seek under way, is not).
    if (pendingSeek == null && !audio.seeking && audio.currentTime !== lastPos) {
      lastPos = audio.currentTime;
      waitingSince = 0;
    }
    time();
  });
  on('durationchange', time);
  on('seeked', () => {
    lastPos = audio.currentTime;
    time();
  });
  on('loadedmetadata', () => {
    if (pendingSeek != null) {
      try {
        audio.currentTime = pendingSeek;
      } catch {
        /* not seekable yet */
      }
      pendingSeek = null;
    }
    time();
  });
  on('play', () => h.state({ playing: true }));
  on('playing', () => h.state({ playing: true, buffering: false }));
  on('pause', () => {
    waitingSince = 0;
    h.state({ playing: false, buffering: false });
  });
  on('waiting', () => {
    if (!waitingSince) waitingSince = performance.now();
    h.state({ buffering: true });
  });
  on('canplay', () => h.state({ buffering: false }));
  on('ended', () => {
    waitingSince = 0;
    h.ended();
  });
  on('error', () => {
    if (!audio.getAttribute('src')) return; // we cleared the source ourselves
    failed(gen, audio.error?.message || '');
  });

  setInterval(() => {
    if (!wantPlay || !waitingSince || nextUntried() < 0) return;
    if (performance.now() - waitingSince >= STALL_MS) failed(gen, 'stall');
  }, 500);

  const keyOf = (v) => `${v.sourceId}:${v.trackId}:${v.fileHash}`;

  /** The next item into the spare element, once the song playing is in its last PRELOAD_S. */
  function fillSpare() {
    if (!want || (spareFor && spareFor.id === want.id && spareFor.key === keyOf(want.version))) return;
    const left = audio.duration - audio.currentTime;
    if (!Number.isFinite(left) || left > PRELOAD_S) return;
    spareFor = { id: want.id, key: keyOf(want.version) };
    spare.src = want.version.url;
    spare.load();
  }

  /** The spare holds this item's first version, ready to play from its start. */
  const spareReady = (id, v) => !!spareFor && spareFor.id === id && spareFor.key === keyOf(v) && spare.readyState >= 2 && !spare.error;
  /** The first version of the list not loaded yet for this item (wherever the order put it). */
  const nextUntried = () => list.findIndex((v) => !tried.has(keyOf(v)));

  /** The version at vi failed: an untried one from the same moment, or the player hears it. */
  function failed(g, message) {
    if (g !== gen || failedGen === g) return;
    failedGen = g;
    const n = nextUntried();
    if (n >= 0) {
      const old = list[vi];
      const next = list[n];
      const pos = Math.max(0, lastPos - (old.offsetMs || 0) / 1000 + (next.offsetMs || 0) / 1000);
      vi = n;
      start(pos);
      return;
    }
    h.error(message);
  }

  /** HEAD on the stream URL: the source names the level it serves (it may fall back). */
  async function askQuality(g, url) {
    try {
      const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      const level = res.ok ? res.headers.get('X-MPfy-Quality') : null;
      if (level && g === gen) h.quality?.(level.trim().toLowerCase());
    } catch {
      /* the chip just stays empty */
    }
  }

  function playSafe() {
    const g = gen;
    const p = audio.play();
    if (p) {
      p.catch((err) => {
        if (err?.name === 'AbortError' || g !== gen) return; // a newer load replaced this one
        h.state({ playing: false, buffering: false });
        if (err?.name !== 'NotAllowedError') failed(g, err?.message || '');
      });
    }
  }

  // The listener's volume times the gain of the version playing ("Volume uniforme", player.js).
  let userVol = 1;
  function applyVolume() {
    const v = list[vi];
    const g = v && typeof v.gain === 'number' && v.gain > 0 && v.gain <= 1 ? v.gain : 1;
    audio.volume = Math.min(1, Math.max(0, userVol * g));
  }

  function start(at) {
    gen++;
    const v = list[vi];
    tried.add(keyOf(v));
    lastPos = at > 0 ? at : 0;
    pendingSeek = at > 0 ? at : null;
    waitingSince = wantPlay ? performance.now() : 0;
    audio.src = v.url;
    applyVolume();
    if (wantPlay) playSafe();
    h.version?.(v);
    askQuality(gen, v.url);
  }

  return {
    native: false,
    get loadedId() {
      return loadedId;
    },
    get currentTime() {
      return position();
    },
    /** The version playing now, or null. */
    get version() {
      return list[vi] || null;
    },
    /** The versions of the loaded item tried so far (the one playing included). */
    get tried() {
      return list.filter((v) => tried.has(keyOf(v)));
    },
    load(id, versions, at, play) {
      const swap = !(at > 0) && versions.length > 0 && spareReady(id, versions[0]);
      loadedId = id;
      list = versions.slice();
      vi = 0;
      tried = new Set();
      wantPlay = !!play;
      if (!swap) return start(at);
      // The next song is ready in the spare: the two swap, the old one is let go.
      const old = audio;
      audio = spare;
      spare = old;
      spareFor = null;
      old.pause();
      old.removeAttribute('src');
      old.load();
      swaps++;
      gen++;
      const v = list[0];
      tried.add(keyOf(v));
      lastPos = 0;
      pendingSeek = null;
      waitingSince = wantPlay ? performance.now() : 0;
      applyVolume();
      if (wantPlay) playSafe();
      h.version?.(v);
      askQuality(gen, v.url);
      time();
    },
    /** The element playing (the spare is the other). */
    get element() {
      return audio;
    },
    /** How many songs started from the spare (gapless). */
    get swaps() {
      return swaps;
    },
    /** What comes after the item playing (its versions in order); null: nothing. */
    preload(id, versions) {
      want = id && versions && versions.length ? { id, version: versions[0] } : null;
      if (!want && spareFor) {
        spareFor = null;
        spare.removeAttribute('src');
        spare.load();
      }
      fillSpare();
    },
    /**
     * New order or offsets for the item playing (a source came or went, the fingerprints
     * arrived): the version playing stays, the others are tried in the new order. A version
     * playing that left the list (its source went down) stays in it, its offset taken into the
     * new list's frame by offsetOf (offsets are against the first version of a list).
     */
    setVersions(id, versions, offsetOf = null) {
      if (id !== loadedId || !list.length) return;
      const cur = list[vi];
      const i = versions.findIndex((v) => keyOf(v) === keyOf(cur));
      if (i >= 0) {
        list = versions.slice();
        vi = i;
      } else {
        list = [{ ...cur, offsetMs: offsetOf ? offsetOf(cur) : cur.offsetMs }, ...versions];
        vi = 0;
      }
      applyVolume();
    },
    play() {
      wantPlay = true;
      playSafe();
    },
    pause() {
      wantPlay = false;
      audio.pause();
    },
    seek(sec) {
      lastPos = sec;
      if (audio.readyState >= 1) audio.currentTime = sec;
      else pendingSeek = sec;
    },
    /** The volume the element plays at: the listener's times the version's gain. */
    get outputVolume() {
      return audio.volume;
    },
    setVolume(v) {
      userVol = Math.min(1, Math.max(0, v));
      applyVolume();
    },
    setRepeat() {
      /* handled by player.js on "ended" */
    },
    stop() {
      gen++;
      wantPlay = false;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      want = null;
      spareFor = null;
      spare.removeAttribute('src');
      spare.load();
      loadedId = null;
      list = [];
      tried = new Set();
    },
  };
}
