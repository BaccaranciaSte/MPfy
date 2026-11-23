// The player: one interface for the UI, two backends (web audio element, or the Android app).
//
// Queue model: a flat list of items { id, ci?, m? } and the index of the one playing.
//   ci  index of the item in the context's track list (ctxIds); absent for items added by hand
//   m   true for items added with "Aggiungi in coda"
// The manual items always sit right after the current one ("Prossimi in coda"); after them come
// the rest of the context ("Prossimi da: ..."). Items before the index are the history, so
// "previous" walks back through what actually played. The native backend gets this same list.
// Any jump other than one step forward carries the manual block along (carryManual), so going
// back or tapping a later track never turns the queued tracks into history.
//
// Shuffle: Fisher-Yates over the context with the current track first; turning it off
// restores the context order from the current track. Repeat: off / all / one.
//
// Versions: a queue item is a song, handed to the backend with its versions (the same song on
// several sources) in the order to try them (media.js), each with its time offset. The backend
// moves to the next version by itself (the web one in backend-web.js, the app's in its data
// source) and reports a failure only when every version failed; then the player moves on. The
// order is decided again at every track start, when a source comes or goes, and when the queue is
// rebuilt; the fingerprints that align two different files are fetched for the item playing and
// the next one. The stream URL carries ?q= with the level the quality settings ask for, decided
// when the track starts; st.quality is the level the source actually served (X-MPfy-Quality, or
// the app's state event), st.source the source of the version playing.
//
// Queue ownership (app, bridge 4): every list handed to the app carries a queueId, 16 hex made
// here and kept while the same list is edited. A queue the app got from someone else (the car, a
// resumption with no page) has an id of its own, n plus 15 hex: the first report of such an id
// makes the page take that list over (getQueue) instead of overwriting it, and its later edits
// carry that id. The page's own ids, a stale tick included, and an empty player (null) never do.

import { store } from './store.js';
import { absUrl, srcApi } from './api.js';
import { versionsFor, candidates, coverHref, versionKey, offsetBetween } from './media.js';
import { fingerprints } from './fingerprints.js';
import { bridgeVersion } from './native.js';
import { sources } from './sources.js';
import { quality } from './quality.js';
import { native } from './native.js';
import { createWebBackend } from './backend-web.js';
import { createNativeBackend } from './backend-native.js';
import { shuffleInPlace, ctxKey, debounce, lsGet, lsSet } from './util.js';
import { contextName } from './contexts.js';
import { downloads } from './downloads.js';
import { toast } from '../components/toast.js';

const LS_KEY = 'mpfy.player.v1';
const REPEAT_NEXT = { off: 'all', all: 'one', one: 'off' };
const MAX_ERROR_SKIPS = 5; // failed tracks in a row before playback stops (also never more than one pass)
const EXPECT_MS = 3000; // how long a native report may lag behind one of our commands
const PROBE_MS = 3500; // a source that does not answer its health check within this is down

const st = {
  items: [],
  index: -1,
  context: null, // { type, id, name }
  ctxIds: [],
  lastCi: -1, // context position to resume from when a manual item is playing
  shuffle: false,
  repeat: 'off',
  playing: false,
  buffering: false,
  position: 0,
  duration: 0,
  posStamp: 0, // performance.now() of the last position report, for interpolation
  volume: 1,
  source: null, // id of the source the current track comes from
  quality: null, // level served for the current track: low | normal | high | max
  queueId: null, // the list handed to the app: ours (16 hex) or one taken over from it (n...)
};

const changeListeners = new Set();
const timeListeners = new Set();
let backend = null;
let needsLoad = true; // nothing handed to the backend yet (fresh start or restored state)
let listen = { id: null, acc: 0, last: 0, reported: false }; // play reporting (>= 30 s)
let lastPositionState = 0;
let errorStreak = 0; // tracks that failed in a row; reset once a track really plays
let lastSeekAt = 0; // performance.now() of the last seek or load (a stall right after is not a rebuffer)
// The current play of a song: the versions (keys) that already failed for it.
let fo = { id: null, failed: new Set() };
const failedFor = (it) => (it && fo.id === it.id ? fo.failed : null);
const resetFailover = () => {
  fo = { id: null, failed: new Set() };
};
// What each queue item was last handed to the app with ({ src, q, url }), to tell when a
// re-evaluation (a source came back, the network changed) really changes something.
let sentInfo = new WeakMap();

// The last queue id handed to the app, the last one taken over from it, the last one found to be
// past (getQueue already held another list).
let lastSentId = null;
let adoptedId = null;
let askedId = null;
// A list taken over before the library and the source list were here: what it was handed over
// with is recorded once they are (recorded earlier it would hold no versions at all, and the
// first look at them would send the list back).
let recordDue = false;
const CTX_KINDS = ['album', 'artist', 'playlist', 'liked', 'search', 'library'];

/** 16 hex: a list made here (never starting with n, the app's own mark). */
function newQueueId() {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** A play context as the app keeps it, { k, id } (id null for liked and library), or null. */
function wireCtx(type, id) {
  if (!CTX_KINDS.includes(type)) return null;
  return { k: type, id: type === 'liked' || type === 'library' || typeof id !== 'string' ? null : id };
}

/** A queue id the app gave a list it got from someone else, not seen here yet. */
const foreignQueue = (id) => typeof id === 'string' && id[0] === 'n' && id !== lastSentId && id !== adoptedId && id !== askedId;

// Does the listener want music right now? Our play commands and a report that it plays say yes,
// our pause commands say no. A pause done outside this page (Bluetooth, notification, unplugged
// headphones) only shows up as "not playing any more", which a failure also looks like: stoppedAt
// keeps when that happened, and a failure reported long after it is a failure while paused.
let intent = false;
let stoppedAt = 0;
const STOP_GRACE_MS = 1500;

function notePlaying(playing, buffering) {
  if (playing) {
    intent = true;
    stoppedAt = 0;
  } else if (st.playing && !buffering) {
    stoppedAt = performance.now(); // a stall while buffering is not a stop
  }
}

const wantsMusic = () => intent && !(stoppedAt && performance.now() - stoppedAt > STOP_GRACE_MS);

// Our commands reach the native player later (the bridge posts them to the Android main thread),
// so a state report already on its way still describes the player before them: after setQueue or
// skipTo it carries the index of the old list. After a command that sets the index or the repeat
// mode we wait, up to EXPECT_MS, for a report that shows it, and ignore older reports instead of
// jumping to an unrelated track and back (which also restarted the 30 s play count). After an
// edit sent with keep the app may go on with the song it plays at another index of the new list
// (it moved on before the list arrived): a report naming the song the page holds at that index
// is of the new list.
const expect = { index: null, repeat: null, keep: false, until: 0, timer: 0 };

function expectNative(field, value, keep = false) {
  expect[field] = value;
  if (field === 'index') expect.keep = keep;
  expect.until = performance.now() + EXPECT_MS;
  clearTimeout(expect.timer);
  expect.timer = setTimeout(() => {
    if (expect.index == null && expect.repeat == null) return;
    // Nothing confirmed the command in time (the player moved on by itself meanwhile, or the
    // command was lost): take the player's current word for it.
    expect.index = null;
    expect.repeat = null;
    const s = backend?.native ? backend.getState() : null;
    if (s) handlers.native(s);
  }, EXPECT_MS + 50);
}

const persistSoon = debounce(persistNow, 400);

function emitChange() {
  persistSoon();
  for (const fn of changeListeners) {
    try {
      fn(st);
    } catch (err) {
      console.error('player listener', err);
    }
  }
}

function emitTime() {
  for (const fn of timeListeners) {
    try {
      fn(st);
    } catch (err) {
      console.error('player time listener', err);
    }
  }
}

const currentItem = () => st.items[st.index] || null;
const trackOf = (it) => (it ? store.track(it.id) : null);

function durationNow() {
  if (st.duration > 0 && Number.isFinite(st.duration)) return st.duration;
  return trackOf(currentItem())?.duration || 0;
}

function positionNow() {
  let p = st.position;
  if (st.playing && !st.buffering && st.posStamp) p += (performance.now() - st.posStamp) / 1000;
  const d = durationNow();
  return d ? Math.min(p, d) : p;
}

/** A song can play now: a connected source has a version of it, or one is downloaded (app only). */
function playable(id) {
  return candidates(id).length > 0;
}

/**
 * A track failed on src. A broken file is not a dead source, so the source itself is asked: when
 * its health check fails (502-504 or no answer in PROBE_MS) api.js marks it down, the source
 * list changes and the next tracks are decided again without it (refreshUpcoming), instead of
 * each one failing there first (and waiting for the link) before its own failover.
 */
function probeSource(src) {
  if (!sources.isUp(src)) return;
  srcApi(src)
    .health({ timeout: PROBE_MS })
    .catch(() => {});
}

/** A stall while playing, not at a start or right after a seek, counts for "Automatica". */
function noteBuffering(buffering) {
  if (buffering && !st.buffering && st.playing && listen.acc > 3 && performance.now() - lastSeekAt > 3000) quality.noteRebuffer();
}

/**
 * The versions of a queue item, in the order to try them, at the level to ask (a downloaded one
 * at its own level: the app finds it by trackId:fileHash:quality).
 */
const itemInfo = (it) => versionsFor(it.id, { exclude: failedFor(it) });
const infoKey = (info) => `${info.q}|${info.versions.map((v) => `${versionKey(v)}@${v.offsetMs}`).join(',')}`;

/**
 * The app's view of one queue item: its versions, the first one's URL for older apps, its like
 * state (liked: the principal's likes by song, store.likedGroups) and the context it came from.
 */
function nativeItem(it, i, liked) {
  const t = trackOf(it) || { id: it.id, title: '', artist: '', album: '' };
  const info = itemInfo(it);
  sentInfo.set(it, info);
  if (i === st.index && !st.source) st.source = info.versions[0]?.sourceId || null;
  const cov = store.d.trackCover.get(it.id);
  const art = cov ? coverHref(cov.id, 'large', { forApp: true }) : null;
  return {
    id: it.id,
    title: t.title || '',
    artist: t.artist || '',
    album: t.album || '',
    albumArtist: t.albumArtist || t.artist || '',
    trackNo: Number.isInteger(t.trackNo) ? t.trackNo : null,
    liked: liked.has(store.gid(it.id)),
    likedIds: liked.get(store.gid(it.id)) || [],
    // Taken over from the app: its own context back unchanged; queued by hand: none.
    ctx: it.c !== undefined ? it.c : it.m || !st.context ? null : wireCtx(st.context.type, st.context.id),
    artworkUrl: art ? absUrl(art) : '',
    url: info.versions[0]?.url || '',
    quality: info.q || 'max',
    durationMs: Math.round((t.duration || 0) * 1000),
    versions: info.versions.map(({ sourceId, trackId, fileHash, url, offsetMs: off }) => ({ sourceId, trackId, fileHash, url, offsetMs: off })),
  };
}

/**
 * The item playing and the next few were decided when the list was handed over. When a source
 * comes or goes, the network changes, a track starts or the fingerprints arrive, decide them
 * again and hand the list over once more if any changed (same current item: the app keeps
 * playing it and only updates its versions; the web backend keeps the version playing).
 */
function refreshUpcoming() {
  if (!backend || needsLoad || st.index < 0) return;
  if (recordDue) {
    recordAdopted();
    return;
  }
  if (!backend.native) {
    const it = currentItem();
    if (it && backend.loadedId === it.id) {
      const info = itemInfo(it);
      if (!sentInfo.get(it) || infoKey(sentInfo.get(it)) !== infoKey(info)) {
        sentInfo.set(it, info);
        // The version playing may have left the list (its source went down): its offset is
        // taken against the new first version, the frame of every other offset of the list.
        const first = info.versions[0];
        backend.setVersions(it.id, info.versions, (x) => (first ? offsetBetween(first.v, x.v) : 0));
      }
    }
    return;
  }
  for (let i = st.index; i < Math.min(st.items.length, st.index + 4); i++) {
    const it = st.items[i];
    const prev = sentInfo.get(it);
    if (!prev || infoKey(prev) !== infoKey(itemInfo(it))) {
      syncQueue();
      return;
    }
  }
}

/** The fingerprints that align different files, for the item playing and the next one. */
function loadOffsets() {
  const its = [st.items[st.index], st.items[st.index + 1]].filter(Boolean);
  const vs = [];
  for (const it of its) {
    const list = itemInfo(it).versions;
    if (list.some((v) => v.fileHash !== list[0].fileHash)) vs.push(...list.map((v) => v.v));
  }
  if (!vs.length) return;
  fingerprints.load(vs).then((got) => {
    if (got) refreshUpcoming();
  });
}

function upcomingManual() {
  const out = [];
  for (let i = st.index + 1; i < st.items.length && st.items[i].m; i++) out.push(st.items[i]);
  return out;
}

function newListen() {
  const it = currentItem();
  listen = { id: it?.id || null, acc: 0, last: 0, reported: false };
}

function report() {
  const it = currentItem();
  if (!it || listen.reported) return;
  listen.reported = true;
  const ctx = it.m || !st.context
    ? { type: 'library', id: null }
    : { type: st.context.type, id: st.context.id ?? null };
  store.played(it.id, ctx);
}

/** Accumulates real listening time from position reports (seeks do not count). */
function trackListen(pos) {
  const it = currentItem();
  if (!it) return;
  if (listen.id !== it.id) {
    listen = { id: it.id, acc: 0, last: pos, reported: false };
    return;
  }
  const delta = pos - listen.last;
  const dur = durationNow();
  // A jump from the end back to the start is a repeat-one loop: a new play of the same track.
  if (delta < -5 && dur && listen.last >= dur - 3) {
    if (!listen.reported && listen.acc > 0) report();
    listen = { id: it.id, acc: 0, last: pos, reported: false };
    return;
  }
  listen.last = pos;
  if (st.playing && delta > 0 && delta < 3) listen.acc += delta;
  if (listen.acc >= 2) errorStreak = 0; // this one really plays: the run of failures is over
  const need = dur > 0 ? Math.min(30, Math.max(1, dur - 2)) : 30;
  if (!listen.reported && listen.acc >= need) report();
}

/**
 * Pushes the current queue to the backend after a structural change.
 *
 * Native: setQueue always carries the whole list, with the current item at `index` and the
 * current position. When that item is the one already playing (an edit of the upcoming tracks:
 * add to queue, reorder, remove, shuffle), the app is expected to keep playing it untouched and
 * replace only the items around it (Media3 replaceMediaItems / removeMediaItems / addMediaItems),
 * not to call setMediaItems + prepare, which restarts the buffer and makes a gap. That is the
 * Android side's job (android/, the bridge's setQueue); this module cannot do it alone. Such an
 * edit goes with keep: when the app moved on before it arrived (a key, the car, a song that
 * ended), the app goes on with what it plays, found in the new list, instead of going back.
 */
function syncQueue({ play, restart = false } = {}) {
  const keep = !restart && !needsLoad;
  const it = currentItem();
  if (!it) {
    if (!backend.native) backend.stop?.();
    return;
  }
  const position = restart ? 0 : positionNow();
  // While a track buffers on its way to playing, the app reports playing: false; an edit made in
  // that moment must not hand it the list paused.
  const wantPlay = play ?? (st.playing || (st.buffering && intent));
  intent = wantPlay;
  if (wantPlay) stoppedAt = 0;
  if (backend.native) {
    if (needsLoad && !wantPlay) return; // stay lazy until the user presses play
    if (!keep) st.source = null;
    if (!st.queueId) st.queueId = newQueueId();
    const liked = store.likedGroups();
    backend.setQueue(st.items.map((x, i) => nativeItem(x, i, liked)), st.index, position, wantPlay, st.queueId, keep);
    lastSentId = st.queueId;
    recordDue = false;
    expectNative('index', st.index, keep);
    backend.setRepeat(st.repeat);
    expectNative('repeat', st.repeat);
    needsLoad = false;
  } else if (restart || needsLoad || backend.loadedId !== it.id) {
    const info = itemInfo(it);
    sentInfo.set(it, info);
    st.source = info.versions[0]?.sourceId || null;
    st.quality = null;
    lastSeekAt = performance.now();
    needsLoad = false;
    if (info.versions.length) backend.load(it.id, info.versions, position, wantPlay);
    else setTimeout(() => handlers.error('nessuna fonte', it.id), 0);
  } else if (play) {
    backend.play();
  }
}

/**
 * The "Prossimi in coda" block (added manually, play first) always follows the current
 * track. Moving the index from `from` to `to` by anything but one step forward would strand it:
 * going back leaves the track we came from in front of it, jumping past it (a tap on a track under
 * "Prossimi da") turns it into history. So the block moves along and lands right after the
 * target. Going back from a track that was itself queued by hand puts it back at the head of
 * the block (it was the next thing in time). Tapping a queued track skips only the queued tracks
 * before it. Returns the target's index after the move and whether the list changed.
 */
function carryManual(from, to) {
  if (from < 0 || to === from || to === from + 1) return { index: to, changed: false };
  let end = from + 1;
  while (end < st.items.length && st.items[end].m) end++;
  if (to > from + 1 && to < end) return { index: to, changed: false };
  const start = to < from && st.items[from]?.m ? from : from + 1;
  // Nothing to carry, or going back by one with the block already right after the target.
  if (end === start || to + 1 === start) return { index: to, changed: false };
  const block = st.items.splice(start, end - start);
  if (to >= end) to -= block.length; // the target slid back by the block's length
  st.items.splice(to + 1, 0, ...block);
  return { index: to, changed: true };
}

/**
 * The app holds a list it got from someone else (the car, a resumption): the page takes it over
 * as it is, items by id with their contexts, at the app's index and position, without handing it
 * back. An id is asked about again at its next report until getQueue answers (a bridge call can
 * fail), never once the app is found holding another list. Returns whether a list was taken over.
 */
function adopt(s) {
  const q = backend.getQueue ? backend.getQueue() : null;
  const qid = q && typeof q.queueId === 'string' && q.queueId ? q.queueId : null;
  if (qid && qid !== s.queueId) askedId = s.queueId;
  const id = qid && qid[0] === 'n' ? qid : null;
  const list = id && id !== lastSentId && id !== adoptedId && Array.isArray(q.items) ? q.items.filter((x) => x && typeof x.id === 'string' && x.id) : [];
  if (!list.length) return false;
  adoptedId = id;
  const index = Number.isInteger(q.index) && q.index >= 0 && q.index < list.length ? q.index : 0;
  st.items = list.map((x, i) => ({ id: x.id, ci: i, c: x.ctx && typeof x.ctx === 'object' ? wireCtx(x.ctx.k, x.ctx.id) : null }));
  st.index = index;
  const c = st.items[index].c;
  st.context = c ? { type: c.k, id: c.id, name: c.k === 'search' ? `Ricerca: ${c.id || ''}` : contextName({ type: c.k, id: c.id }) } : null;
  st.ctxIds = st.items.map((x) => x.id);
  st.lastCi = index;
  st.position = Math.max(0, Number(q.positionMs) || 0) / 1000;
  st.duration = 0;
  st.posStamp = performance.now();
  st.quality = null;
  st.source = null;
  st.queueId = id;
  resetFailover();
  newListen();
  needsLoad = false;
  expect.index = null;
  expect.repeat = null;
  sentInfo = new WeakMap();
  recordAdopted();
  return true;
}

/**
 * What the app plays was not decided here: a list taken over counts as handed over as it is, each
 * item with what it would be handed over with now, so nothing goes back to the app until something
 * really changes (a source going, the network). Waits for the source list and a library of every
 * source (store.synced).
 */
function recordAdopted() {
  recordDue = !store.synced;
  if (recordDue) return;
  for (const it of st.items) sentInfo.set(it, itemInfo(it));
}

/** Index of the next item that can play after position `from` (wrapping when repeating), or -1. */
function nextPlayable(from) {
  const n = st.items.length;
  for (let k = 1; k < n; k++) {
    const i = from + k;
    if (i >= n && st.repeat === 'off') return -1;
    if (playable(st.items[i % n].id)) return i % n;
  }
  return -1;
}

/**
 * Moves to item i and plays it. carry = false is for skipping failed tracks: the tracks skipped
 * on the way could not play, so they go to the history even when they were queued by hand.
 */
function go(i, play = true, carry = true) {
  const moved = carry ? carryManual(st.index, i) : { index: i, changed: false };
  i = moved.index;
  st.index = i;
  const it = currentItem();
  if (it?.ci != null) st.lastCi = it.ci;
  st.position = 0;
  st.duration = trackOf(it)?.duration || 0;
  st.posStamp = performance.now();
  st.quality = null;
  resetFailover();
  newListen();
  if (backend.native && !needsLoad && !moved.changed) {
    st.source = sentInfo.get(it)?.versions[0]?.sourceId || null;
    backend.skipTo(i);
    expectNative('index', i);
    if (play) {
      intent = true;
      stoppedAt = 0;
      backend.play();
    }
  } else {
    // A reordered list must reach the app too; a track change anyway, so no extra gap.
    syncQueue({ play, restart: true });
  }
  emitChange();
  emitTime();
  updateMetadata();
  startedItem();
}

/** A new item started: the next ones are decided again, and the fingerprints come for these two. */
function startedItem() {
  refreshUpcoming();
  loadOffsets();
}

/** Web backend: what happens when a track ends or "next" is pressed. */
function advance() {
  const n = st.items.length;
  if (st.index + 1 < n) return go(st.index + 1, true);
  if (st.repeat === 'all' && n) return go(0, true);
  // End of the list with repeat off: stop on the last track, rewound.
  intent = false;
  backend.pause();
  backend.seek(0);
  st.playing = false;
  st.position = 0;
  st.posStamp = performance.now();
  newListen();
  emitChange();
  emitTime();
}

const handlers = {
  time(pos, dur) {
    trackListen(pos);
    st.position = pos;
    if (dur && Number.isFinite(dur)) st.duration = dur;
    st.posStamp = performance.now();
    emitTime();
    updatePositionState();
  },
  state({ playing, buffering }) {
    let changed = false;
    if (buffering != null) noteBuffering(buffering);
    if (playing != null) notePlaying(playing, buffering ?? st.buffering);
    if (playing != null && playing !== st.playing) {
      st.playing = playing;
      changed = true;
    }
    if (buffering != null && buffering !== st.buffering) {
      st.buffering = buffering;
      changed = true;
    }
    st.posStamp = performance.now();
    if (changed) {
      emitChange();
      updatePlaybackState();
    }
  },
  ended() {
    if (!listen.reported && listen.acc > 0) report();
    if (st.repeat === 'one') {
      newListen();
      backend.seek(0);
      backend.play();
      return;
    }
    advance();
  },
  /**
   * The current track cannot play (unreachable, corrupt, a P2P drop the backend could not ride
   * out). Move on to the next playable track instead of ending the session (in the
   * car nobody wants to touch the phone); stop after MAX_ERROR_SKIPS failures in a row, or once
   * every track of the queue failed, so a dead link cannot spin through the list forever.
   */
  error(message, itemId = null) {
    if (message) console.warn('player error', message);
    let it = currentItem();
    if (!it) return;
    if (itemId && itemId !== it.id) {
      // The app reports the item that failed. Its next item failing means the app already moved
      // on to it (the index report is still on its way); anything else is an old error.
      const nx = st.items[st.index + 1];
      if (!nx || nx.id !== itemId) return;
      const moved = carryManual(st.index, st.index + 1);
      st.index = moved.index;
      it = currentItem();
      if (it.ci != null) st.lastCi = it.ci;
      st.position = 0;
      st.duration = 0;
      st.quality = null;
      st.source = sentInfo.get(it)?.versions[0]?.sourceId || null;
      resetFailover();
      newListen();
    }
    // Whatever the backend held is broken now (the app's player sits in its error state and
    // needs a new setQueue to prepare again): the next play or skip loads afresh.
    needsLoad = true;
    // A track loaded while paused (a queue edit after a restart, say) failed: nobody asked for
    // music, so stay paused and quiet; pressing play tries again.
    const wanted = wantsMusic();
    // The app tried the versions it was given (with the older bridge only the first); the web
    // backend says which ones it tried (a new order may have left some untried). A version not
    // tried yet (more than four, that older app, a reorder) is tried from the same position.
    if (wanted) {
      if (fo.id !== it.id) fo = { id: it.id, failed: new Set() };
      const sent = sentInfo.get(it)?.versions || [];
      let gaveUp = sent;
      if (!backend.native) gaveUp = backend.loadedId === it.id ? backend.tried : [];
      else if (bridgeVersion() < 3) gaveUp = sent.slice(0, 1);
      for (const v of gaveUp) fo.failed.add(versionKey(v));
      if (gaveUp[0]) probeSource(gaveUp[0].sourceId);
      if (candidates(it.id, fo.failed).length) {
        console.warn('player: trying another version of', it.id);
        st.quality = null;
        syncQueue({ play: true });
        emitChange();
        return;
      }
    }
    errorStreak = wanted ? errorStreak + 1 : 0;
    const next = wanted && errorStreak < Math.min(MAX_ERROR_SKIPS, st.items.length) ? nextPlayable(st.index) : -1;
    if (next >= 0) {
      toast('Brano non disponibile');
      go(next, true, false); // nextPlayable stops at the first playable one: nothing playable is skipped
      return;
    }
    errorStreak = 0;
    intent = false;
    st.playing = false;
    st.buffering = false;
    st.posStamp = performance.now();
    emitChange();
    emitTime();
    updatePlaybackState();
    if (wanted) toast('Brano non disponibile');
  },
  /** State event from the Android app. */
  native(s) {
    // A list the app got elsewhere: taken over; getQueue's index and position are the newer ones.
    const adopted = foreignQueue(s.queueId) && adopt(s);
    if (adopted) s = { ...s, index: st.index, positionMs: undefined };
    if (performance.now() > expect.until) {
      expect.index = null;
      expect.repeat = null;
    }
    if (expect.index != null) {
      const kept = expect.keep && typeof s.itemId === 'string' && st.items[s.index]?.id === s.itemId;
      if (s.index !== expect.index && !kept) return; // sent before our last command: describes the old list
      expect.index = null;
    }
    if (expect.repeat != null) {
      if (s.repeat === expect.repeat) expect.repeat = null;
      else s = { ...s, repeat: undefined }; // the rest of the report is current, the mode is not yet
    }
    let changed = false;
    let resync = false;
    let upcoming = false;
    if (Number.isInteger(s.index) && s.index !== st.index && s.index >= 0 && s.index < st.items.length) {
      // The track changed natively: end of track, notification or Bluetooth next/previous.
      const dur = durationNow();
      if (dur && st.position >= dur - 2 && !listen.reported && listen.acc > 0) report();
      // A Bluetooth "previous" (or a wrap) must not strand the queued tracks either: reorder,
      // then hand the app the new list (same current track, at most one index shift).
      const moved = carryManual(st.index, s.index);
      st.index = moved.index;
      resync = moved.changed;
      const it = currentItem();
      if (it.ci != null) st.lastCi = it.ci;
      st.duration = 0;
      st.quality = null;
      st.source = sentInfo.get(it)?.versions[0]?.sourceId || null;
      resetFailover();
      newListen();
      changed = true;
      upcoming = true;
    }
    // The version the app plays now (it moves to another by itself when one fails).
    if (typeof s.sourceId === 'string' && s.sourceId && s.sourceId !== st.source) {
      st.source = s.sourceId;
      changed = true;
    }
    if (typeof s.buffering === 'boolean') noteBuffering(s.buffering);
    if (typeof s.quality === 'string' && s.quality && s.quality !== st.quality) {
      st.quality = s.quality;
      changed = true;
    }
    if (typeof s.playing === 'boolean') notePlaying(s.playing, s.buffering === true);
    if (typeof s.playing === 'boolean' && s.playing !== st.playing) {
      st.playing = s.playing;
      changed = true;
    }
    if (typeof s.buffering === 'boolean' && s.buffering !== st.buffering) {
      st.buffering = s.buffering;
      changed = true;
    }
    if (REPEAT_NEXT[s.repeat] && s.repeat !== st.repeat) {
      st.repeat = s.repeat;
      changed = true;
    }
    if (Number.isFinite(s.durationMs) && s.durationMs > 0) st.duration = s.durationMs / 1000;
    if (Number.isFinite(s.positionMs)) {
      const pos = s.positionMs / 1000;
      trackListen(pos);
      st.position = pos;
    }
    st.posStamp = performance.now();
    if (resync) syncQueue();
    else if (upcoming) refreshUpcoming(); // later tracks re-evaluate their versions and quality
    if (upcoming || adopted) loadOffsets();
    if (changed || adopted) emitChange();
    emitTime();
    if (adopted) updateMetadata();
  },
  /** Web backend: it moved to another version of the item (the one before failed). */
  version(v) {
    if (!v || v.sourceId === st.source) return;
    st.source = v.sourceId;
    st.quality = null;
    emitChange();
  },
  /** Web backend: the level the source served (X-MPfy-Quality of the stream). */
  quality(level) {
    if (!level || level === st.quality) return;
    st.quality = level;
    emitChange();
  },
};

// ---- Media Session (web backend only; the app has its own media session) ----

function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const set = (action, fn) => {
    try {
      navigator.mediaSession.setActionHandler(action, fn);
    } catch {
      /* action not supported here */
    }
  };
  set('play', () => player.play());
  set('pause', () => player.pause());
  set('previoustrack', () => player.previous());
  set('nexttrack', () => player.next());
  set('seekto', (e) => {
    if (Number.isFinite(e.seekTime)) player.seek(e.seekTime);
  });
}

function updateMetadata() {
  if (!backend || backend.native || !('mediaSession' in navigator)) return;
  const t = trackOf(currentItem());
  if (!t) {
    navigator.mediaSession.metadata = null;
    return;
  }
  const cov = store.d.trackCover.get(t.id);
  const art = cov ? coverHref(cov.id, 'large') : null;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title,
      artist: t.artist,
      album: t.album,
      artwork: art ? [{ src: absUrl(art), sizes: '640x640' }] : [],
    });
  } catch {
    /* MediaMetadata missing */
  }
}

function updatePlaybackState() {
  if (!backend || backend.native || !('mediaSession' in navigator)) return;
  navigator.mediaSession.playbackState = st.playing ? 'playing' : 'paused';
}

function updatePositionState() {
  if (!backend || backend.native || !('mediaSession' in navigator)) return;
  const nowMs = performance.now();
  if (nowMs - lastPositionState < 1000) return;
  lastPositionState = nowMs;
  const d = durationNow();
  if (!d || !navigator.mediaSession.setPositionState) return;
  try {
    navigator.mediaSession.setPositionState({ duration: d, playbackRate: 1, position: Math.min(positionNow(), d) });
  } catch {
    /* invalid state while loading */
  }
}

// ---- persistence (restored paused on reload) ----

function persistNow() {
  lsSet(LS_KEY, {
    items: st.items,
    index: st.index,
    context: st.context,
    ctxIds: st.ctxIds,
    lastCi: st.lastCi,
    shuffle: st.shuffle,
    repeat: st.repeat,
    position: positionNow(),
    volume: st.volume,
    queueId: st.queueId,
    adoptedId,
  });
}

function restore() {
  const s = lsGet(LS_KEY, null);
  if (!s || !Array.isArray(s.items)) return;
  st.items = s.items.filter((it) => it && typeof it.id === 'string');
  st.index = Number.isInteger(s.index) && s.index < st.items.length ? s.index : st.items.length ? 0 : -1;
  st.context = s.context && typeof s.context.type === 'string' ? s.context : null;
  st.ctxIds = Array.isArray(s.ctxIds) ? s.ctxIds.filter((x) => typeof x === 'string') : [];
  st.lastCi = Number.isInteger(s.lastCi) ? s.lastCi : -1;
  st.shuffle = !!s.shuffle;
  st.repeat = REPEAT_NEXT[s.repeat] ? s.repeat : 'off';
  st.position = Number(s.position) > 0 ? Number(s.position) : 0;
  st.volume = Number.isFinite(s.volume) ? Math.min(1, Math.max(0, s.volume)) : 1;
  st.playing = false;
  st.duration = 0;
  st.queueId = typeof s.queueId === 'string' && s.queueId ? s.queueId : null;
  lastSentId = st.queueId;
  adoptedId = typeof s.adoptedId === 'string' ? s.adoptedId : null;
}

/** Drops queue items whose track left the library (deleted). The playing one stays. */
function prune() {
  if (!store.loaded || !store.synced || !st.items.length) return;
  const d = store.d;
  const cur = currentItem();
  let keep = st.items.filter((it) => it === cur || d.tracks.has(it.id));
  if (cur && !d.tracks.has(cur.id) && !st.playing) {
    // The current track was deleted while paused: move on to the next one.
    const pos = keep.indexOf(cur);
    keep = keep.filter((it) => it !== cur);
    st.items = keep;
    st.index = keep.length ? Math.min(pos, keep.length - 1) : -1;
    st.position = 0;
    needsLoad = true;
    newListen();
    emitChange();
    updateMetadata();
    return;
  }
  if (keep.length === st.items.length) return;
  st.items = keep;
  st.index = keep.indexOf(cur);
  syncQueue();
  emitChange();
}

export const player = {
  get state() {
    return st;
  },
  get isNative() {
    return !!backend?.native;
  },
  currentItem,
  currentTrack: () => trackOf(currentItem()),
  /**
   * The trackId of the version playing now (each source has its own id for the same song): the
   * one the web backend loaded, else the song's version on the source it comes from, else its
   * first. Null with an empty queue.
   */
  playingVersionId() {
    const it = currentItem();
    if (!it) return null;
    const v = backend && !backend.native && backend.loadedId === it.id ? backend.version : null;
    if (v && v.trackId) return v.trackId;
    const vs = store.versions(it.id);
    const here = vs.find((x) => x.sourceId === st.source) || vs[0];
    return (here && here.trackId) || it.id;
  },
  positionNow,
  durationNow,
  onChange(fn) {
    changeListeners.add(fn);
    return () => changeListeners.delete(fn);
  },
  onTime(fn) {
    timeListeners.add(fn);
    return () => timeListeners.delete(fn);
  },

  init() {
    restore();
    backend = native ? createNativeBackend(handlers) : createWebBackend(handlers);
    if (backend.native) {
      // After a WebView reload the service may still be playing our list: adopt its state. A list
      // it got from someone else meanwhile (the car) is taken over.
      const s = backend.getState();
      if (s && foreignQueue(s.queueId) && adopt(s)) handlers.native({ ...s, index: st.index, positionMs: undefined });
      else if (s && st.items.length && Number.isInteger(s.index) && s.index >= 0 && s.index < st.items.length && (s.playing || s.positionMs > 0)) {
        needsLoad = false;
        // A list taken over before the reload, still the one the app plays: as it holds it.
        if (s.queueId && s.queueId === adoptedId) recordAdopted();
        handlers.native(s);
      }
    } else {
      backend.setVolume(st.volume);
      setupMediaSession();
    }
    const recordSoon = () => {
      if (recordDue) recordAdopted();
    };
    store.subscribe(recordSoon);
    store.subscribe(prune);
    // A source came or went, the network or the quality settings changed: the next tracks may
    // now come from elsewhere or at another level (native: the list handed to the app).
    // Only a source coming or going counts here: the RTT and throughput move at every poll, and
    // re-deciding on them would hand the app a new list every few seconds near a threshold.
    const reevaluate = debounce(refreshUpcoming, 1000);
    let upKey = '';
    sources.subscribe(() => {
      recordSoon();
      const k = sources.music().filter((s) => sources.isUp(s.id)).map((s) => s.id).join(',');
      if (k === upKey) return;
      upKey = k;
      reevaluate();
    });
    quality.subscribe(reevaluate);
    // While music plays with the screen off (the page hidden), keep learning which sources are
    // up, more slowly: the app plays the list handed to it, and that list must avoid a dead one.
    changeListeners.add(() => sources.setBackgroundPolling(st.playing || (st.buffering && intent)));
    window.addEventListener('pagehide', persistNow);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) persistNow();
    });
    setInterval(() => {
      if (st.playing) persistNow();
    }, 5000);
    emitChange();
    emitTime();
    updateMetadata();
  },

  /** Plays a context (its track ids in order) starting from position startCi (or the top). */
  playContext(ctx, trackIds, startCi = null) {
    const ids = trackIds.filter((id) => store.track(id));
    if (!ids.length) return;
    if (startCi != null) {
      // Map the position to the filtered list (duplicates keep their own position).
      const exists = !!store.track(trackIds[startCi]);
      startCi = exists ? trackIds.slice(0, startCi).filter((id) => store.track(id)).length : -1;
    }
    if (startCi != null && startCi >= 0 && !playable(ids[startCi])) {
      toast('Brano non disponibile');
      return;
    }
    let items = ids.map((id, ci) => ({ id, ci })).filter((it) => playable(it.id));
    if (!items.length) {
      toast('Nessun brano disponibile');
      return;
    }
    const manual = upcomingManual();
    let first = startCi != null && startCi >= 0 ? items.find((it) => it.ci === startCi) : null;
    let index;
    if (st.shuffle) {
      if (!first) first = items[Math.floor(Math.random() * items.length)];
      const rest = shuffleInPlace(items.filter((it) => it !== first));
      items = [first, ...rest];
      index = 0;
    } else {
      if (!first) first = items[0];
      index = items.indexOf(first);
    }
    items.splice(index + 1, 0, ...manual);
    st.items = items;
    st.index = index;
    st.context = { type: ctx.type, id: ctx.id ?? null, name: ctx.name || '' };
    st.ctxIds = ids;
    st.lastCi = first.ci;
    st.queueId = newQueueId();
    st.position = 0;
    st.duration = trackOf(first)?.duration || 0;
    st.posStamp = performance.now();
    st.quality = null;
    resetFailover();
    newListen();
    syncQueue({ play: true, restart: true });
    emitChange();
    emitTime();
    updateMetadata();
    loadOffsets();
  },

  isContext(ctx) {
    return !!st.context && st.index >= 0 && ctxKey(st.context) === ctxKey(ctx);
  },

  play() {
    if (!currentItem()) return;
    intent = true;
    stoppedAt = 0;
    if (needsLoad) syncQueue({ play: true });
    else backend.play();
  },
  pause() {
    intent = false;
    if (!needsLoad) backend.pause();
  },
  toggle() {
    if (st.playing) player.pause();
    else player.play();
  },

  next() {
    if (!st.items.length) return;
    if (backend.native && !needsLoad) backend.next();
    else advance();
  },

  /**
   * Restarts the track after 3 s, otherwise goes back one (wrapping with repeat all). Decided
   * here for both backends, like the app's own seekToPrevious would, so that going back carries
   * the queued tracks along (go) in one step instead of a native skip followed by a fix-up.
   * Previous from Bluetooth or the notification still goes natively; handlers.native carries then.
   */
  previous() {
    if (!st.items.length) return;
    if (positionNow() > 3 || (st.index === 0 && st.repeat !== 'all')) {
      player.seek(0);
      return;
    }
    go(st.index > 0 ? st.index - 1 : st.items.length - 1, true);
  },

  skipTo(i) {
    if (i < 0 || i >= st.items.length) return;
    go(i, true);
  },

  seek(sec) {
    const d = durationNow();
    st.position = Math.max(0, d ? Math.min(sec, d) : sec);
    st.posStamp = performance.now();
    lastSeekAt = performance.now();
    if (listen.id) listen.last = st.position;
    if (!needsLoad) backend.seek(st.position);
    emitTime();
    updatePositionState();
  },

  setShuffle(on) {
    on = !!on;
    if (on === st.shuffle) return;
    st.shuffle = on;
    const cur = currentItem();
    if (cur && st.context && st.ctxIds.length) {
      const manual = upcomingManual();
      // The same filter as playContext (offline only downloaded tracks can be queued), plus the
      // current track's own slot, which stays even if it would not pass (it is already playing).
      const all = st.ctxIds
        .map((id, ci) => ({ id, ci }))
        .filter((it) => (cur.ci != null && it.ci === cur.ci) || (store.track(it.id) && playable(it.id)));
      if (on) {
        const rest = shuffleInPlace(all.filter((it) => it.ci !== cur.ci));
        st.items = [cur, ...manual, ...rest];
        st.index = 0;
      } else if (cur.ci != null) {
        const at = all.findIndex((it) => it.ci === cur.ci);
        st.items = [...all.slice(0, at), cur, ...manual, ...all.slice(at + 1)];
        st.index = at;
      } else {
        const at = all.findIndex((it) => it.ci > st.lastCi);
        const cut = at < 0 ? all.length : at;
        st.items = [...all.slice(0, cut), cur, ...manual, ...all.slice(cut)];
        st.index = cut;
      }
      syncQueue();
    }
    emitChange();
  },

  toggleShuffle() {
    player.setShuffle(!st.shuffle);
  },

  cycleRepeat() {
    st.repeat = REPEAT_NEXT[st.repeat] || 'off';
    if (!needsLoad) {
      backend.setRepeat(st.repeat);
      if (backend.native) expectNative('repeat', st.repeat);
    }
    emitChange();
  },

  /** "Aggiungi in coda": after the current track and the tracks already queued by hand. */
  addToQueue(trackIds) {
    const add = trackIds.filter((id) => store.track(id)).map((id) => ({ id, m: true }));
    if (!add.length) return;
    if (!currentItem()) {
      st.items = add;
      st.index = 0;
      st.context = null;
      st.ctxIds = [];
      st.position = 0;
      st.queueId = newQueueId();
      needsLoad = true;
      newListen();
      emitChange();
      updateMetadata();
      return;
    }
    let pos = st.index + 1;
    while (pos < st.items.length && st.items[pos].m) pos++;
    st.items.splice(pos, 0, ...add);
    syncQueue();
    emitChange();
  },

  /** Removes queue items by absolute index (never the current one). */
  removeAt(indexes) {
    const sorted = [...new Set(indexes)].filter((i) => i !== st.index && i >= 0 && i < st.items.length).sort((a, b) => b - a);
    if (!sorted.length) return;
    for (const i of sorted) {
      st.items.splice(i, 1);
      if (i < st.index) st.index--;
    }
    syncQueue();
    emitChange();
  },

  /** Moves an upcoming item from one absolute index to another. */
  move(from, to) {
    if (from === to || from <= st.index || to <= st.index) return;
    const [it] = st.items.splice(from, 1);
    st.items.splice(to, 0, it);
    syncQueue();
    emitChange();
  },

  clearQueue() {
    const start = st.index + 1;
    let end = start;
    while (end < st.items.length && st.items[end].m) end++;
    if (end === start) return;
    st.items.splice(start, end - start);
    syncQueue();
    emitChange();
  },

  /** Absolute index range [start, end) of the "Prossimi in coda" block. */
  manualRange() {
    const start = st.index + 1;
    let end = start;
    while (end < st.items.length && st.items[end].m) end++;
    return { start, end };
  },

  /** After a change of principal the playlists got new ids there: keep "playing from" right. */
  remapPlaylists(idMap) {
    if (st.context?.type === 'playlist' && idMap[st.context.id]) {
      st.context = { ...st.context, id: idMap[st.context.id] };
      emitChange();
    }
  },

  setVolume(v) {
    st.volume = Math.min(1, Math.max(0, v));
    backend.setVolume(st.volume);
    persistSoon();
    emitTime();
  },
};
