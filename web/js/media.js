// Which source serves what: a cover from a connected source that has it, and for a song the
// versions to try, in order, at the level the settings (or "Automatica") ask for.
//
// A song's candidates are its versions on connected sources, plus every version with a finished
// download whatever its source's state (a download plays offline). The level comes from the
// quality settings; "Automatica" looks at the best known throughput among the candidates'
// sources. Then (songs.js) the versions good enough for the level first, by connection, the rest
// by score; downloaded versions go first of all; at most 4. Each version carries its time offset
// against the first one, so a switch lands on the same moment of the song.

import { store } from './store.js';
import { sources } from './sources.js';
import { quality } from './quality.js';
import { downloads } from './downloads.js';
import { fingerprints } from './fingerprints.js';
import { coverPath, streamPath, absUrl } from './api.js';
import { orderVersions, offsetMs, rawOffset, signatureOffset } from './songs.js';

/** The service worker controls this page, so it can answer a cover from its cache. */
const swControls = () => typeof navigator !== 'undefined' && !!navigator.serviceWorker?.controller;

/**
 * URL of a cover. Covers are immutable by id, so any source that has it gives the same bytes
 * (and the service worker caches them by id, whichever source served them).
 *
 * When no source that has it is connected (or the core has not said yet which ones are), the URL
 * asks the service worker for its cached copy only (&cached=1, a miss answers 504 at once), and
 * without a service worker there is no URL at all. A request to the core would wait for the
 * link (6 s) and hold one of the browser's few connections to 127.0.0.1:47123 meanwhile: a list
 * of such covers starved /local/sources and every stream behind them. The covers that could not
 * show are drawn again when a source comes back (cover.js).
 *
 * forApp: the URL is for the Android app's player (artwork), which fetches outside the page and
 * its service worker: always a plain URL. via: the sources to ask for a cover your libraries do not
 * know (a playlist someone shared in a chat, whose cover lives where that playlist does).
 */
export function coverHref(coverId, size = 'small', { forApp = false, via = null } = {}) {
  if (!coverId) return null;
  const known = store.coverSources(coverId);
  const ids = known.length || !Array.isArray(via) ? known : via;
  const up = sources.loaded ? sources.best(ids) : null;
  if (up) return coverPath(up, coverId, size);
  const src = ids[0] || sources.principal()?.id;
  if (!src) return null;
  if (forApp) return coverPath(src, coverId, size);
  return swControls() ? `${coverPath(src, coverId, size)}&cached=1` : null;
}

const info = (sid) => sources.get(sid);
const LEVEL_RANK = { low: 1, normal: 2, high: 3, max: 4 };
export const versionKey = (v) => `${v.sourceId}:${v.trackId}:${v.fileHash}`;

/**
 * A version whose original is on a memory card that is away from its source, with no ready
 * level there: nothing of it can play now (the source answers "Brano non disponibile ora").
 */
export const awayNow = (v) => v.t?.away === true && !(v.t.qualities && (v.t.qualities.low || v.t.qualities.normal || v.t.qualities.high));

/** Versions of a song that can play now. exclude: version keys that already failed. */
export function candidates(id, exclude = null) {
  return store.versions(id).filter((v) => !exclude?.has(versionKey(v)) && ((!v.kept && !awayNow(v) && sources.isUp(v.sourceId)) || downloads.hasVersion(v)));
}

/** True when some connected source has the song (downloads are checked by the caller). */
export const reachable = (id) => store.versions(id).some((v) => !v.kept && !awayNow(v) && sources.isUp(v.sourceId));

/**
 * Offset in ms of `v` against `first` (a moment at x in first is at x + offset in v): raw
 * fingerprints when both are here, else signatures; null when neither tells.
 */
export function knownOffset(first, v) {
  if (!first || !v) return null;
  if (first === v || first.fileHash === v.fileHash) return 0;
  const a = fingerprints.cached(first.fileHash);
  const b = fingerprints.cached(v.fileHash);
  let k = a && b ? rawOffset(a, b) : null;
  if (k == null) k = signatureOffset(first.sig, v.sig);
  return k == null ? null : offsetMs(k);
}

/** Offset in ms of `v` against `first`, 0 when it is not known (a switch then starts at the same second). */
export const offsetBetween = (first, v) => knownOffset(first, v) ?? 0;

/**
 * The versions of a song to try, in order: { level, q, versions: [{ sourceId, trackId, fileHash,
 * url, offsetMs, v }] }. q is the level asked in every URL: the download's own level when the
 * first version is downloaded, else the decided level.
 */
export function versionsFor(id, { purpose = 'stream', exclude = null, max = 4 } = {}) {
  const cands = candidates(id, exclude);
  if (!cands.length) return { level: null, q: null, versions: [] };
  const best = cands.reduce((m, v) => (v.score > m.score ? v : m), cands[0]);
  const level = quality.decide(best.t, cands.filter((v) => !v.kept).map((v) => v.sourceId), purpose);
  const ordered = orderVersions(cands, level, info);
  // The phone's own file first (read where it lies, the original), then the downloads, then the rest.
  const mine = ordered.filter((v) => sources.isLocal(v.sourceId));
  const rest = ordered.filter((v) => !sources.isLocal(v.sourceId));
  const dl = rest.filter((v) => downloads.hasVersion(v)).sort((a, b) => (LEVEL_RANK[downloads.levelOfVersion(b)] || 0) - (LEVEL_RANK[downloads.levelOfVersion(a)] || 0));
  const list = [...mine, ...dl, ...rest.filter((v) => !downloads.hasVersion(v))].slice(0, max);
  const first = list[0];
  // A phone version first keeps the decided level: a fall back to a source after a local failure
  // streams at the person's setting, not at max.
  const q = (!mine.length && downloads.hasVersion(first) && downloads.levelOfVersion(first)) || level;
  return {
    level,
    q,
    versions: list.map((v) => ({
      sourceId: v.sourceId,
      trackId: v.trackId,
      fileHash: v.fileHash,
      url: absUrl(streamPath(v.sourceId, v.trackId, q, v.fileHash)),
      offsetMs: offsetBetween(first, v),
      v,
    })),
  };
}

/**
 * Where a song's download comes from: the first version on a connected source, at the download
 * level. None for a song the phone holds itself (nothing to download).
 */
export function downloadVersion(id) {
  const vs = store.versions(id);
  if (vs.some((v) => sources.isLocal(v.sourceId))) return null;
  const cands = vs.filter((v) => !v.kept && sources.isUp(v.sourceId));
  if (!cands.length) return null;
  const best = cands.reduce((m, v) => (v.score > m.score ? v : m), cands[0]);
  const level = quality.decide(best.t, cands.map((v) => v.sourceId), 'download');
  const v = orderVersions(cands, level, info)[0];
  return { v, level, url: absUrl(streamPath(v.sourceId, v.trackId, level, v.fileHash)) };
}
