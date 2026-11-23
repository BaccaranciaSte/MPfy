// Offline downloads, only inside the Android app (Media3 DownloadService behind the bridge).
// A detail page toggle marks a whole context (playlist, album, artist, liked) as downloaded:
// tracks added to it later are downloaded too, and turning it off removes the files that
// no other downloaded context still needs.
//
// Downloads are per version: one file of a song, { trackId, fileHash, quality }. A song counts as
// downloaded when any of its versions is, and a download plays only for its own fileHash. Each
// download asks for the "Download" quality setting (default Max) from the best connected version.
// When a downloaded file was replaced on its source (a better upload, a new fileHash), the new
// file is downloaded and only then the old one removed.
//
// A request lives until the app reports the track downloaded. When the app showed it in progress
// and then dropped it without the file, the download failed: "Download non riuscito", and it is
// asked again only after RETRY_MS. One the app never took up is asked again after UNSEEN_MS.
// Songs whose sources are all out of reach are not asked for: they are when a source comes back.
//
// The toggle of a page shows each tap at once but changes the files only once the taps stop
// (TOGGLE_WAIT_MS), to the state of the last one: a double tap on a downloaded album neither
// removes nor asks for anything. A removal the app reports is followed by asking again for what
// the contexts still on need (a slower off and on ends with the files back).

import { native, nativeCall, nativeJson, onNative, bridgeVersion } from './native.js';
import { downloadVersion } from './media.js';
import { streamPath, absUrl } from './api.js';
import { contextTracks, contextExists } from './contexts.js';
import { store } from './store.js';
import { sources } from './sources.js';
import { ctxKey, parseCtxKey, lsGet, lsSet } from './util.js';
import { toast } from '../components/toast.js';

const LS_KEY = 'mpfy.downloads.contexts';
const LS_Q = 'mpfy.downloads.quality'; // trackId -> level asked (older apps do not report it)
const UNSEEN_MS = 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;
const LEVEL_RANK = { low: 1, normal: 2, high: 3, max: 4 };
const TOGGLE_WAIT_MS = 600;

let ids = new Set(); // finished downloads, by trackId
let done = null; // "trackId:fileHash" -> best level, when the app reports items (bridge v3)
let progress = {};
let reportedBytes = null; // the app may report the real size ({ bytes }); otherwise we estimate
const requested = new Map(); // trackId -> { at, seen, fileHash }: asked, not reported downloaded yet
const failedAt = new Map(); // trackId -> when its download failed
const replacing = new Map(); // trackId -> fileHash of a download whose file was replaced on its source
const contexts = new Set(lsGet(LS_KEY, []));
const askedQ = lsGet(LS_Q, {}) || {};
const listeners = new Set();
const wishes = new Map(); // context key -> { on, timer }: the toggle's state, not applied yet
let suspended = false; // a change of principal is in progress: playlist ids are moving
let doneSeq = 0; // moves when the finished downloads change

function emit() {
  for (const fn of listeners) fn();
}

const vkey = (trackId, fileHash) => `${trackId}:${fileHash}`;

/** A version (trackId, fileHash) has a finished download. */
function versionDone(trackId, fileHash) {
  if (done) return done.has(vkey(trackId, fileHash));
  return ids.has(trackId);
}

/** In progress: by trackId (older apps) or by the full key trackId:fileHash:quality. */
function inProgress(trackId) {
  if (trackId in progress) return true;
  const pre = `${trackId}:`;
  return Object.keys(progress).some((k) => k.startsWith(pre));
}

function progressValue(trackId) {
  if (trackId in progress) return progress[trackId];
  const pre = `${trackId}:`;
  const k = Object.keys(progress).find((x) => x.startsWith(pre));
  return k ? progress[k] : undefined;
}

function apply(msg) {
  if (!msg) return;
  const had = ids;
  const hadDone = done;
  ids = new Set(Array.isArray(msg.ids) ? msg.ids : []);
  // An app that does not report items knows downloads by trackId only.
  done = null;
  if (Array.isArray(msg.items)) {
    done = new Map();
    for (const it of msg.items) {
      if (!it || typeof it.trackId !== 'string') continue;
      const k = vkey(it.trackId, typeof it.fileHash === 'string' ? it.fileHash : it.trackId);
      const q = typeof it.quality === 'string' ? it.quality : 'max';
      if ((LEVEL_RANK[q] || 0) > (LEVEL_RANK[done.get(k)] || 0)) done.set(k, q);
      ids.add(it.trackId);
    }
  }
  progress = msg.progress && typeof msg.progress === 'object' ? msg.progress : {};
  reportedBytes = Number.isFinite(msg.bytes) ? msg.bytes : reportedBytes;
  const now = Date.now();
  let failed = 0;
  for (const [id, r] of requested) {
    if (versionDone(id, r.fileHash)) requested.delete(id);
    else if (inProgress(id)) r.seen = true;
    else if (r.seen) {
      // In progress before, gone now, and no file: the download failed.
      requested.delete(id);
      failedAt.set(id, now);
      failed++;
    } else if (now - r.at > UNSEEN_MS) requested.delete(id); // never taken up: ask again later
  }
  // A replaced file: the old download goes once the new one is here.
  for (const [trackId, oldHash] of replacing) {
    const v = store.versions(trackId).find((x) => x.trackId === trackId);
    if (v && v.fileHash !== oldHash && versionDone(trackId, v.fileHash)) {
      replacing.delete(trackId);
      nativeCall('removeDownload', JSON.stringify([{ trackId, fileHash: oldHash }]));
    }
  }
  if (failed) toast('Download non riuscito');
  // The finished downloads changed (one more, one less, another file): the lyrics kept with them follow.
  let moved = ids.size !== had.size || (done ? done.size : -1) !== (hadDone ? hadDone.size : -1);
  if (!moved) {
    for (const t of ids) {
      if (had.has(t)) continue;
      moved = true;
      break;
    }
  }
  if (moved) doneSeq++;
  emit();
  store.offlineChanged();
  // A download went (removed here, or by the app): a context still on asks for it again. Until
  // the app reported it gone, the song counted as downloaded and was not asked for.
  for (const t of had) {
    if (!ids.has(t)) {
      downloads.sync();
      break;
    }
  }
}

/** Asked and still on its way (the app took it up, or it was asked a moment ago). */
function pending(trackId) {
  const r = requested.get(trackId);
  return !!r && (r.seen || Date.now() - r.at < UNSEEN_MS);
}

function songBusy(song) {
  const now = Date.now();
  return song.versions.some((v) => versionDone(v.trackId, v.fileHash) || inProgress(v.trackId) || pending(v.trackId) || now - (failedAt.get(v.trackId) || 0) < RETRY_MS);
}

function request(songIds) {
  const items = [];
  const now = Date.now();
  for (const id of new Set(songIds)) {
    const song = store.track(id);
    if (!song || songBusy(song)) continue;
    // Only from a source that is connected now (the app would fail on the others): none, no ask.
    const dv = downloadVersion(id);
    if (!dv) continue;
    const v = dv.v;
    requested.set(v.trackId, { at: now, seen: false, fileHash: v.fileHash });
    failedAt.delete(v.trackId);
    askedQ[v.trackId] = dv.level;
    items.push({ id: v.trackId, trackId: v.trackId, fileHash: v.fileHash, url: dv.url, quality: dv.level });
  }
  if (!items.length) return;
  lsSet(LS_Q, askedQ);
  nativeCall('download', JSON.stringify(items));
}

function neededByOthers(exceptKey) {
  const need = new Set();
  for (const key of contexts) {
    if (key === exceptKey) continue;
    const ctx = parseCtxKey(key);
    if (ctx) for (const id of contextTracks(ctx)) need.add(store.gid(id));
  }
  return need;
}

/** Removes every downloaded, running or asked version of these songs. */
function remove(songIds) {
  const list = [];
  for (const id of songIds) {
    const vs = store.versions(id);
    const tids = vs.length ? vs.map((v) => v.trackId) : [id];
    for (const t of tids) if ((ids.has(t) || inProgress(t) || requested.has(t)) && !list.includes(t)) list.push(t);
  }
  if (!list.length) return;
  for (const id of list) {
    requested.delete(id);
    replacing.delete(id);
    delete askedQ[id];
  }
  lsSet(LS_Q, askedQ);
  nativeCall('removeDownload', JSON.stringify(list));
  store.forgetOffline(list);
}

/**
 * Downloaded versions whose file was replaced on their source: the new file is asked for, the
 * old download is removed when it arrived (apply).
 */
function followReplaced() {
  if (!done) return;
  const asks = [];
  for (const k of done.keys()) {
    const i = k.indexOf(':');
    const trackId = k.slice(0, i);
    const fileHash = k.slice(i + 1);
    const v = store.versions(trackId).find((x) => x.trackId === trackId && !x.kept);
    if (!v || v.fileHash === fileHash || versionDone(trackId, v.fileHash)) continue;
    if (store.versions(trackId).some((x) => x.trackId === trackId && x.fileHash === fileHash)) continue; // another source still has that file
    replacing.set(trackId, fileHash);
    asks.push(trackId);
  }
  if (!asks.length) return;
  // The song counts as downloaded through the old file: ask for the new one directly.
  const items = [];
  const now = Date.now();
  for (const trackId of asks) {
    const v = store.versions(trackId).find((x) => x.trackId === trackId && !x.kept);
    if (!v || !sources.isUp(v.sourceId) || inProgress(trackId) || pending(trackId)) continue;
    const q = done.get(vkey(trackId, replacing.get(trackId))) || 'max';
    const url = absUrl(streamPath(v.sourceId, trackId, q, v.fileHash));
    requested.set(trackId, { at: now, seen: false, fileHash: v.fileHash });
    items.push({ id: trackId, trackId, fileHash: v.fileHash, url, quality: q });
  }
  if (items.length) nativeCall('download', JSON.stringify(items));
}

/** Size of one downloaded track: the file itself for Max, else the Opus bitrate times length. */
const KBPS = { low: 48, normal: 96, high: 160 };
function estimate(id) {
  const t = store.track(id);
  if (!t) return 0;
  const q = askedQ[id] || 'max';
  if (q === 'max' || !KBPS[q]) return Number(t.size) || ((Number(t.bitrate) || 256000) / 8) * (t.duration || 0);
  return (KBPS[q] * 1000 / 8) * (t.duration || 0);
}

export const downloads = {
  available: !!native,
  /** A song (any of its versions) is downloaded. */
  has(id) {
    const vs = store.versions(id);
    if (!vs.length) return ids.has(id);
    return vs.some((v) => versionDone(v.trackId, v.fileHash));
  },
  hasVersion: (v) => !!v && versionDone(v.trackId, v.fileHash),
  /** The best level a version was downloaded at, or null. */
  levelOfVersion(v) {
    if (!v || !versionDone(v.trackId, v.fileHash)) return null;
    return done ? done.get(vkey(v.trackId, v.fileHash)) || 'max' : askedQ[v.trackId] || 'max';
  },
  /** The level a song plays offline at (its downloaded version's), or null. */
  levelOf(id) {
    const v = store.versions(id).find((x) => versionDone(x.trackId, x.fileHash));
    return v ? downloads.levelOfVersion(v) : ids.has(id) ? askedQ[id] || 'max' : null;
  },
  /** For a removed source's kept tracks: a version of this track is downloaded. */
  keeps: (t) => versionDone(t.id, typeof t.fileHash === 'string' && t.fileHash ? t.fileHash : t.id),
  get count() {
    return ids.size;
  },
  /** The trackIds with a finished download (read only). */
  get doneIds() {
    return ids;
  },
  /** Moves each time the finished downloads change. */
  get doneSeq() {
    return doneSeq;
  },
  /** { bytes, estimated }: what the downloads take on the phone (older apps). */
  space() {
    if (reportedBytes != null) return { bytes: reportedBytes, estimated: false };
    let bytes = 0;
    for (const id of ids) bytes += estimate(id);
    return { bytes, estimated: true };
  },
  /** 0..100 while downloading, undefined otherwise. */
  progressOf(id) {
    if (downloads.has(id)) return undefined;
    const vs = store.versions(id);
    for (const t of vs.length ? vs.map((v) => v.trackId) : [id]) {
      const p = progressValue(t);
      if (p !== undefined) return p;
    }
    return undefined;
  },
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  init() {
    if (!native) return;
    // Tracks of a removed source stay while they are downloaded.
    store.keepOffline((t) => downloads.keeps(t));
    apply(nativeJson('listDownloads'));
    onNative('downloads', apply, { replay: true });
    // Keep downloaded contexts complete as the library changes, and when a source comes back
    // (its tracks were not asked for while it was out of reach).
    store.subscribe(() => this.sync());
    let upKey = '';
    sources.subscribe(() => {
      const k = sources.music().filter((s) => sources.isUp(s.id)).map((s) => s.id).join(',');
      if (k === upKey) return;
      upKey = k;
      this.sync();
    });
  },

  /** The context is downloaded, or its toggle was just turned on. */
  isContextOn(ctx) {
    const key = ctxKey(ctx);
    const w = wishes.get(key);
    return w ? w.on : contexts.has(key);
  },

  /**
   * A tap on a page's download toggle: the new state shows at once (isContextOn) and is applied
   * when no other tap came for TOGGLE_WAIT_MS. A run of taps that ends where it began changes
   * nothing. Returns the state shown.
   */
  toggleContext(ctx) {
    const key = ctxKey(ctx);
    const was = wishes.get(key);
    if (was) clearTimeout(was.timer);
    const on = !(was ? was.on : contexts.has(key));
    const timer = setTimeout(() => {
      wishes.delete(key);
      if (on === contexts.has(key)) {
        emit();
        return;
      }
      downloads.setContext(ctx, on);
      toast(on ? 'Download avviato' : 'Download rimosso');
    }, TOGGLE_WAIT_MS);
    wishes.set(key, { on, timer });
    emit();
    return on;
  },

  setContext(ctx, on) {
    const key = ctxKey(ctx);
    const songIds = contextTracks(ctx);
    if (on) {
      contexts.add(key);
      request(songIds);
    } else {
      contexts.delete(key);
      const need = neededByOthers(key);
      remove(songIds.filter((id) => !need.has(store.gid(id))));
    }
    lsSet(LS_KEY, [...contexts]);
    emit();
  },

  /** "Elimina download": every file and every downloaded context. */
  clearAll() {
    const all = [...new Set([...ids, ...Object.keys(progress).map((k) => k.split(':')[0]), ...requested.keys()])];
    for (const w of wishes.values()) clearTimeout(w.timer);
    wishes.clear();
    contexts.clear();
    lsSet(LS_KEY, []);
    requested.clear();
    replacing.clear();
    for (const id of all) delete askedQ[id];
    lsSet(LS_Q, askedQ);
    if (bridgeVersion() >= 3) nativeCall('clearDownloads');
    else if (all.length) nativeCall('removeDownload', JSON.stringify(all));
    if (all.length) store.forgetOffline(all);
    emit();
  },

  /** While the principal changes, a playlist missing for a moment must not lose its downloads. */
  suspend(on) {
    suspended = !!on;
    if (!suspended) this.sync();
  },

  /** After a change of principal the playlists got new ids there: keep their download marks. */
  remapPlaylists(idMap) {
    let changed = false;
    for (const key of [...contexts]) {
      const ctx = parseCtxKey(key);
      if (ctx?.type === 'playlist' && idMap[ctx.id] && idMap[ctx.id] !== ctx.id) {
        contexts.delete(key);
        contexts.add(ctxKey({ type: 'playlist', id: idMap[ctx.id] }));
        changed = true;
      }
    }
    if (changed) {
      lsSet(LS_KEY, [...contexts]);
      emit();
    }
  },

  /** Downloads what is missing from the downloaded contexts; forgets contexts that are gone. */
  sync() {
    if (!native || !store.synced || suspended) return;
    let changed = false;
    for (const key of [...contexts]) {
      const ctx = parseCtxKey(key);
      if (!ctx || !contextExists(ctx)) {
        contexts.delete(key);
        changed = true;
        continue;
      }
      request(contextTracks(ctx));
    }
    followReplaced();
    if (changed) lsSet(LS_KEY, [...contexts]);
  },
};
