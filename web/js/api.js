// HTTP API of the sources, always through the local client core: a request for source <id> goes
// to /s/<id>/api/..., on the same origin (127.0.0.1:47123 in the app and in client-node, the mock
// server during development). The core answers 503 "Fonte non raggiungibile" when that source's
// P2P link is down. Errors carry the source's `code` (and its body, for the fields that come with
// some codes); the UI picks its own words for them (words.js).

import { sources } from './sources.js';
import { wordsFor, GENERIC } from './words.js';

export class ApiError extends Error {
  constructor(message, status, src = null) {
    super(message);
    this.status = status;
    this.src = src;
    this.code = null;
    this.data = null;
  }
}

const enc = encodeURIComponent;
const base = (src) => `/s/${enc(src)}/api`;

// The versions a source says a change of it took (its X-MPfy-* headers), by answer.
const versions = new WeakMap();
const HEX16 = /^[0-9a-f]{16}$/;

/**
 * The versions an answer of a change carries: { uv, ue } (the person's part), { v, e } (the shared
 * part), both, or null (a source of before them, or an answer with neither). An array of answers
 * (one change sent as several requests): the highest of each.
 */
export function versionsOf(data) {
  if (Array.isArray(data)) {
    let out = null;
    for (const x of data) {
      const h = versionsOf(x);
      if (!h) continue;
      out = out || {};
      if (h.ue && (!out.ue || h.uv > out.uv)) Object.assign(out, { uv: h.uv, ue: h.ue });
      if (h.e && (!out.e || h.v > out.v)) Object.assign(out, { v: h.v, e: h.e });
    }
    return out;
  }
  return (data && typeof data === 'object' && versions.get(data)) || null;
}

function readVersions(res) {
  const num = (k) => {
    const x = res.headers.get(k);
    return x !== null && /^\d{1,16}$/.test(x) ? Number(x) : null;
  };
  const hex = (k) => {
    const x = res.headers.get(k);
    return x !== null && HEX16.test(x) ? x : null;
  };
  const uv = num('X-MPfy-User-Version');
  const ue = hex('X-MPfy-User-Epoch');
  const v = num('X-MPfy-Version');
  const e = hex('X-MPfy-Epoch');
  if ((uv === null || !ue) && (v === null || !e)) return null;
  return { ...(uv !== null && ue ? { uv, ue } : {}), ...(v !== null && e ? { v, e } : {}) };
}

/**
 * The words for a failure: known codes and cases in the listener's words, everything else the
 * caller's short fallback. Never a status code or the raw text of a server error. An unreachable
 * source is "Fonte non raggiungibile", never its name: which source is down shows only in
 * Impostazioni. A full disk names the source: it is about where the files went.
 */
export function errorText(err, fallback = GENERIC) {
  const s = err?.status;
  // The phone's own music is never named in an error: its words say no source.
  const name = err?.src && !sources.isLocal(err.src) ? sources.name(err.src) : null;
  const w = wordsFor(err?.code, name);
  if (w) return w;
  if (s === 507 || /ENOSPC|spazio esaurito|disco pieno/i.test(err?.raw || '')) return name ? `Spazio esaurito su ${name}` : 'Spazio esaurito';
  if (s === 0 || s === 502 || s === 503 || s === 504) return 'Fonte non raggiungibile';
  if (s === 413) return 'File troppo grande';
  if (s === 415) return 'Formato non supportato';
  return fallback;
}

async function request(src, method, path, body, { timeout = 15000, headers = {}, raw = false } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const init = { method, headers: { ...headers }, cache: 'no-store', signal: ctrl.signal };
  if (body instanceof Blob) {
    if (!init.headers['Content-Type']) init.headers['Content-Type'] = body.type || 'application/octet-stream';
    init.body = body;
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(base(src) + path, init);
  } catch (err) {
    if (err?.name === 'AbortError') sources.markDown(src);
    throw new ApiError('Fonte non raggiungibile', 0, src);
  } finally {
    clearTimeout(timer);
  }
  // The core answers 502/503/504 when the link to that source is down.
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    sources.markDown(src);
    throw new ApiError('Fonte non raggiungibile', res.status, src);
  }
  sources.markUp(src);
  if (res.status === 304) return { notModified: true, res };
  if (raw && res.ok) return { res };
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty or non JSON body */
  }
  if (!res.ok) {
    // The server's own text stays out of sight; errorText() picks the words.
    const e = new ApiError(GENERIC, res.status, src);
    e.raw = typeof data?.error === 'string' ? data.error : '';
    e.code = typeof data?.code === 'string' ? data.code : null;
    e.data = data && typeof data === 'object' ? data : null;
    throw e;
  }
  if (data && typeof data === 'object') {
    const h = readVersions(res);
    if (h) versions.set(data, h);
  }
  return { data, res };
}

const json = (p) => p.then((r) => r.data);

/** The API of one source. */
export function srcApi(src) {
  const r = (method, path, body, opts) => request(src, method, path, body, opts);
  return {
    /**
     * held: what is held of this source, { have, he, uv, ue } (the shared version and its epoch,
     * the person's version and its epoch; any may be missing), or null for nothing. The answer
     * says only what moved since those versions when the source can prove them (a source of
     * before that answers as it always did: tracks null when `have` is current).
     */
    async library(etag, held = null) {
      const h = typeof held === 'number' ? { have: held } : held || {};
      const q = ['delta=1'];
      if (h.have) q.push(`have=${enc(String(h.have))}`);
      if (h.he) q.push(`he=${enc(h.he)}`);
      if (h.uv) q.push(`uv=${enc(String(h.uv))}`);
      if (h.ue) q.push(`ue=${enc(h.ue)}`);
      const x = await r('GET', `/library?${q.join('&')}`, undefined, { headers: etag ? { 'If-None-Match': etag } : {}, timeout: 25000 });
      if (x.notModified) return { notModified: true };
      return { data: x.data, etag: x.res.headers.get('ETag') };
    },
    health: ({ timeout = 8000 } = {}) => json(r('GET', '/health', undefined, { timeout })),
    profile: () => json(r('GET', '/profile', undefined, { timeout: 10000 })),
    renameSource: (name) => json(r('PATCH', '/admin/source', { name })),
    /** { details } (the owner's switch); resolves { source: { name, named, details } }. */
    patchSource: (body) => json(r('PATCH', '/admin/source', body)),
    patchTrack: (id, patch) => json(r('PATCH', `/tracks/${enc(id)}`, patch)),
    /** Resolves { ok, deleted } (a source without profiles answers { ok } only: the file went). */
    deleteTrack: (id) => json(r('DELETE', `/tracks/${enc(id)}`)),
    createPlaylist: (name, description = '', id = null) => json(r('POST', '/playlists', id ? { id, name, description } : { name, description })),
    patchPlaylist: (id, patch) => json(r('PATCH', `/playlists/${enc(id)}`, patch)),
    addToPlaylist: (id, trackIds, position) =>
      json(r('POST', `/playlists/${enc(id)}/tracks`, position == null ? { trackIds } : { trackIds, position })),
    /** ids: the trackId seen at each position, counts: how many copies of it the list had; the source checks both against its list. */
    removeFromPlaylist: (id, indexes, ids = null, counts = null) =>
      json(r('DELETE', `/playlists/${enc(id)}/tracks`, ids ? (counts ? { indexes, ids, counts } : { indexes, ids }) : { indexes })),
    deletePlaylist: (id) => json(r('DELETE', `/playlists/${enc(id)}`)),
    /** Resolves { ok } (a source of before brief answers { likes }: nobody reads it). */
    like: (trackId) => json(r('PUT', `/likes/${enc(trackId)}?brief=1`)),
    unlike: (trackId) => json(r('DELETE', `/likes/${enc(trackId)}?brief=1`)),
    /** Many at once: the removes, then the adds in order. Resolves { ok, added, removed }; a source without it answers 404. */
    likeMany: (add, remove = []) => json(r('POST', '/likes', { add, remove }, { timeout: 60000 })),
    /** at (ms) keeps the real time of a play made offline (honoured within 30 days). */
    played: (trackId, context, at) => json(r('POST', '/played', at ? { trackId, context, at } : { trackId, context })),
    /** The person's own plays older than `before` (null: the newest), newest first: { recents: [{ trackId, at, context }], more }. */
    recents: (before = null, limit = 100) => json(r('GET', `/recents?${before ? `before=${enc(String(before))}&` : ''}limit=${limit}`, undefined, { timeout: 15000 })),
    /** Custom cover: size 'large' first, then 'small'. Resolves { covers }. */
    coverFor: (kind, id, size, blob) =>
      json(r('PUT', `/cover-for/${enc(kind)}/${enc(id)}?size=${size}`, blob, { headers: { 'Content-Type': 'image/jpeg' }, timeout: 60000 })),
    resetCover: (kind, id) => json(r('DELETE', `/cover-for/${enc(kind)}/${enc(id)}`)),
    adminCode: () => json(r('GET', '/admin/code')),
    rotateCode: () => json(r('POST', '/admin/code/rotate')),
    storage: () => json(r('GET', '/admin/storage')),
    setStorage: (body) => json(r('PUT', '/admin/storage', body)),
    clients: () => json(r('GET', '/admin/clients')),
    removeClient: (publicKey) => json(r('DELETE', `/admin/clients/${enc(publicKey)}`)),
    // uploads in chunks, the "maybe" choice, archives
    createSession: (meta) => r('POST', '/uploads', meta, { timeout: 30000 }).then((x) => ({ ...x.data, status: x.res.status })),
    session: (id, { timeout = 15000 } = {}) => json(r('GET', `/uploads/${enc(id)}`, undefined, { timeout })),
    sessions: () => json(r('GET', '/uploads')),
    cancelSession: (id) => json(r('DELETE', `/uploads/${enc(id)}`)),
    choose: (pendingId, keep) => json(r('POST', `/pending/${enc(pendingId)}`, { keep }, { timeout: 120000 })),
    archive: (id) => json(r('GET', `/archives/${enc(id)}`)),
    fingerprint: (trackId, fileHash) => json(r('GET', `/fingerprint/${enc(trackId)}?f=${enc(fileHash)}`, undefined, { timeout: 15000 })),
    // the songs part (sources at social 3): comments and lyrics
    /** The comments of these trackIds (1 to 20); etag: the one held, a 304 then resolves { notModified }. */
    async comments(trackIds, etag = null) {
      const x = await r('GET', `/comments?tracks=${trackIds.map(enc).join(',')}`, undefined, { headers: etag ? { 'If-None-Match': etag } : {}, timeout: 10000 });
      if (x.notModified) return { notModified: true };
      return { data: x.data, etag: x.res.headers.get('ETag') };
    },
    /** { id, trackId, at, text } -> { comment }, the one the source kept. */
    postComment: (body) => json(r('POST', '/comments', body, { timeout: 10000 })),
    deleteComment: (id) => json(r('DELETE', `/comments/${enc(id)}`, undefined, { timeout: 10000 })),
    /** A track's lyrics; etag: the one held, a 304 then resolves { notModified }. */
    async lyrics(trackId, etag = null) {
      const x = await r('GET', `/lyrics/${enc(trackId)}`, undefined, { headers: etag ? { 'If-None-Match': etag } : {}, timeout: 10000 });
      if (x.notModified) return { notModified: true };
      return { data: x.data, etag: x.res.headers.get('ETag') };
    },
    /** The text of an .lrc or a plain text; beside: kept only when the track has no synced lyrics. */
    putLyrics: (trackId, text, beside = false) =>
      json(r('PUT', `/lyrics/${enc(trackId)}${beside ? '?beside=1' : ''}`, new Blob([text], { type: 'text/plain; charset=utf-8' }), { timeout: 20000 })),
    deleteLyrics: (trackId) => json(r('DELETE', `/lyrics/${enc(trackId)}`, undefined, { timeout: 10000 })),
  };
}

/** Stream of one version of a track at a quality level (low | normal | high | max). */
export const streamPath = (src, id, q = 'max', fileHash = null) => `${base(src)}/stream/${enc(id)}?q=${enc(q)}${fileHash ? `&f=${enc(fileHash)}` : ''}`;
/** A cover from one source; lists and grids use 'small', headers and Now Playing 'large'. */
export const coverPath = (src, coverId, size = 'small') => `${base(src)}/cover/${enc(coverId)}?size=${size}`;
export const uploadPath = (src, filename) => `${base(src)}/upload/${enc(filename)}`;
export const chunkPath = (src, sessionId, offset) => `${base(src)}/uploads/${enc(sessionId)}?offset=${offset}`;
/** Absolute URL on this origin (the native player needs http://127.0.0.1:47123/...). */
export const absUrl = (path) => new URL(path, location.origin).href;
