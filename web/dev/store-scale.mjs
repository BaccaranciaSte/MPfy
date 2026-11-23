// The page's library store at scale, in Node (no browser): the store (web/js/store.js) against the
// mock source (web/dev/mock-server.mjs, a big library on demand) and against real sources
// (server/app.mjs), with a fake IndexedDB that keeps transactions whole and can be cut in the
// middle. Each section runs in its own process (the store is one per page).
//   hash        the album and artist ids made in two 32 bit halves equal util.js hashId on a
//               million strings (accents, emoji, lone surrogates)
//   userops     web/js/userops.js gives the source's own rules on random lists (the rules of
//               server/users.mjs at 96a1914), and server/userops.mjs is its byte for byte copy
//   union       after every change of random histories on two and three sources with signatures
//               (songs added, removed, edited, a file replaced, a signature arriving later, a
//               member joined by a signature edge leaving, custom covers, the sources' order and
//               the principal changing, likes, playlists, plays), the union and every index equal
//               the whole merge made from scratch (the store's buildShared and buildUser of
//               96a1914, kept here as the reference), and the songs show in its order
//   budgets     20,000 songs: a one-track delta runs no whole merge and writes at most two
//               records, none of them more than one chunk; two sources holding the same 20,000
//               files are merged with fewer than 100 signature comparisons; a heart at 300,000
//               likes makes no new likes array; the time of a heart and of a play report
//   budget100k  100,000 songs and likes: a one-track delta at most 2 ms here, a heart and a play
//               report at most 1 ms here (from the answer's arrival to the page told)
//   optimistic  a rename after an add, the add refused: the song goes, the rename stays; a delta
//               of another device under a rename on its way shows; a library answer that holds a
//               change whose own answer is not in yet waits for it (the change sent before and
//               after the library request): the song shows once; a refused like goes back alone;
//               the delta that holds a settled like takes its place; an answer on a base that
//               moved meanwhile is dropped and asked again; a source of before the versions
//               (today's rule); bulk likes and their fallback
//   idb         a delta cut in the middle leaves the state before it; two tabs writing deltas in
//               turn, then an offline start equals the state; every value says what it is; the
//               cache of before the chunks is moved and dropped; a delta rewrites only the edge
//               chunks that moved; a full answer with a like listed twice keeps it once
//   real        the store against two real sources (today's answers: no delta), the union equal
//               to the whole merge after uploads, edits, deletes, likes and playlist changes
//
// Usage: node web/dev/store-scale.mjs <out dir> [section ...] [--web <web dir>]
//   --web: where the page's modules are read from (default this repo's web/; a copy of an older
//   web/ shows which checks fail there). Writes <out dir>/store-scale.log; prints PASS/FAIL lines
//   and fails=<n>; exit 1 on a failure.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const WEB = path.resolve(flag('--web') || path.join(ROOT, 'web'));
const SECTION = flag('--section');
const outDir = path.resolve(argv[0] || '.');
const ALL = ['hash', 'userops', 'union', 'budgets', 'likes', 'budget100k', 'optimistic', 'idb', 'dup', 'real'];
const wanted = argv.slice(1).length ? argv.slice(1) : ALL.filter((s) => s !== 'budget100k');
fs.mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
let fails = 0;
const log = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  lines.push(line);
  if (SECTION && !/^(PASS|FAIL) /.test(line) && !/^ {5}/.test(line)) console.log(`   ${line}`);
};
function check(ok, label, detail) {
  const line = `${ok ? 'PASS' : 'FAIL'} ${label}`;
  console.log(line);
  log(line);
  if (detail !== undefined) {
    log('     ', detail);
    // A section's process: its detail goes to the runner's log with its line.
    if (SECTION) console.log(`      ${JSON.stringify(detail)}`);
  }
  if (!ok) fails++;
}

if (!SECTION) {
  // The runner: each section in its own process, its lines kept.
  for (const s of wanted) {
    log(`== ${s}`);
    const child = spawn(process.execPath, ['--max-old-space-size=4096', fileURLToPath(import.meta.url), outDir, '--section', s, '--web', WEB], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      process.stdout.write(d);
    });
    child.stderr.on('data', (d) => (out += d));
    const code = await new Promise((r) => child.on('close', r));
    for (const line of out.split('\n')) {
      if (!line) continue;
      if (/^FAIL /.test(line)) fails++;
      log(line);
    }
    if (code !== 0 && !/FAIL /.test(out)) check(false, `${s}: the section ran to its end (exit ${code})`);
  }
  fs.writeFileSync(path.join(outDir, 'store-scale.log'), `${lines.join('\n')}\nfails=${fails}\n`);
  console.log(`fails=${fails}`);
  process.exit(fails ? 1 : 0);
}

// =================================================================================================
// the page in Node
// =================================================================================================

const noop = () => {};
function pageGlobals(origin) {
  const ls = new Map();
  const el = () => ({ append: noop, appendChild: noop, remove: noop, classList: { add: noop, remove: noop, toggle: noop, contains: () => false }, style: { setProperty: noop }, setAttribute: noop, addEventListener: noop, children: [], firstElementChild: null, querySelector: () => null, querySelectorAll: () => [], dataset: {} });
  globalThis.window = globalThis;
  globalThis.addEventListener = noop;
  globalThis.matchMedia = () => ({ matches: false, addEventListener: noop });
  globalThis.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k), key: (i) => [...ls.keys()][i] ?? null, get length() { return ls.size; } };
  globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: noop, removeEventListener: noop, createElement: el, createElementNS: el, createDocumentFragment: el, body: el(), documentElement: el(), hidden: false };
  globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
  globalThis.location = { origin, href: `${origin}/`, pathname: '/' };
}

/**
 * A fake IndexedDB: one database, one store, transactions one after the other, kept whole (their
 * writes are seen inside them and land at their end; an abort drops them). failAt(n): the next
 * readwrite transaction is cut at its n-th write. log: every transaction that landed.
 */
function fakeIndexedDB() {
  const data = new Map();
  const log = [];
  let cutAt = 0;
  let queue = Promise.resolve();
  const inRange = (k, r) => !r || (k >= r.lower && k <= r.upper);
  const copy = (v) => (v === undefined ? undefined : structuredClone(v));
  function transaction(mode) {
    const staged = new Map();
    const rec = { mode, puts: [], deletes: [] };
    const t = { mode, oncomplete: null, onerror: null, onabort: null, error: null };
    let done = false;
    let pending = 0;
    let writes = 0;
    const cut = mode === 'readwrite' && cutAt ? cutAt : 0;
    if (cut) cutAt = 0;
    let release;
    const start = queue;
    queue = new Promise((r) => (release = r));
    const read = (k) => (staged.has(k) ? staged.get(k) : data.get(k));
    const keys = (r) => {
      const s = new Set([...data.keys()].filter((k) => inRange(k, r)));
      for (const [k, v] of staged) {
        if (!inRange(k, r)) continue;
        if (v === undefined) s.delete(k);
        else s.add(k);
      }
      return [...s].sort();
    };
    const finish = () => {
      if (done || pending) return;
      done = true;
      for (const [k, v] of staged) {
        if (v === undefined) data.delete(k);
        else data.set(k, v);
      }
      log.push(rec);
      release();
      if (t.oncomplete) t.oncomplete();
    };
    t.abort = () => {
      if (done) return;
      done = true;
      staged.clear();
      t.error = t.error || { name: 'AbortError' };
      release();
      setTimeout(() => t.onabort && t.onabort(), 0);
    };
    const request = (fn, write) => {
      const req = { result: undefined, onsuccess: null, onerror: null };
      pending++;
      start.then(() =>
        setTimeout(() => {
          pending--;
          if (done) return;
          if (write && cut && ++writes >= cut) {
            t.error = { name: 'QuotaExceededError' };
            if (req.onerror) req.onerror();
            t.abort();
            return;
          }
          req.result = fn();
          if (req.onsuccess) req.onsuccess();
          setTimeout(finish, 0);
        }, 0)
      );
      return req;
    };
    const s = {
      get: (k) => request(() => copy(read(k))),
      put: (v, k) =>
        request(() => {
          staged.set(k, copy(v));
          rec.puts.push([k, v]);
        }, true),
      delete: (k) =>
        request(() => {
          staged.set(k, undefined);
          rec.deletes.push(k);
        }, true),
      getAll: (r) => request(() => keys(r).map((k) => copy(read(k)))),
      getAllKeys: (r) => request(() => keys(r)),
    };
    t.objectStore = () => s;
    start.then(() => setTimeout(finish, 0));
    return t;
  }
  const db = { transaction: (name, mode = 'readonly') => transaction(mode), createObjectStore: noop };
  return {
    data,
    log,
    failAt: (n) => (cutAt = n),
    install() {
      globalThis.IDBKeyRange = { bound: (lower, upper) => ({ lower, upper }) };
      globalThis.indexedDB = {
        open() {
          const req = { result: db, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
          setTimeout(() => {
            if (req.onupgradeneeded) req.onupgradeneeded();
            if (req.onsuccess) req.onsuccess();
          }, 0);
          return req;
        },
      };
    },
  };
}

/** The mock source in a child process. env: MOCK_* settings. */
async function startMock(env = {}) {
  const child = spawn(process.execPath, ['--max-old-space-size=4096', path.join(ROOT, 'web/dev/mock-server.mjs')], { env: { ...process.env, MOCK_PORT: '0', MOCK_DELAY: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', (d) => log('mock:', String(d).trim()));
  const port = await new Promise((r, j) => {
    child.stdout.on('data', (d) => {
      const m = /MOCK_PORT=(\d+)/.exec(String(d));
      if (m) r(Number(m[1]));
    });
    child.on('exit', (c) => j(new Error(`mock exited ${c}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  const helper = async (p) => (await fetch(`${base}/__mock/${p}`)).text();
  const state = async () => (await fetch(`${base}/__mock/state`)).json();
  const st = await state();
  for (const s of st.servers) await helper(`source?source=${s.id}&rtt=0`);
  const api = async (src, method, p, body, again = 1) => {
    // A kept connection the mock closed meanwhile fails once: asked again.
    const r = await fetch(`${base}/s/${src}/api${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).catch((err) => (again ? null : Promise.reject(err)));
    if (!r) return api(src, method, p, body, 0);
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };
  return { child, base, port, helper, state, api, mi: st.servers[0].id, vps: st.servers[1].id, stop: () => child.kill() };
}

/**
 * The page's fetch, through the mock: hook(method, path, url) may return { before, after, fail }
 * (ms the request waits before it reaches the source and after its answer left it; fail: an
 * answer of that status instead). Every request is listed in reqs.
 */
function pageFetch(base) {
  const realFetch = globalThis.fetch;
  const net = { hook: () => null, reqs: [], arrived: null };
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(typeof input === 'string' ? input : input.url, base);
    const method = init.method || 'GET';
    const h = net.hook(method, u.pathname, u) || {};
    const entry = { method, path: u.pathname + u.search, at: Date.now() };
    net.reqs.push(entry);
    if (h.before) await sleep(h.before);
    if (h.fail) {
      if (h.after) await sleep(h.after);
      return new Response(JSON.stringify({ error: 'Errore' }), { status: h.fail, headers: { 'content-type': 'application/json' } });
    }
    const { signal, cache, ...rest } = init;
    const res = await realFetch(u.href, rest);
    let body = await res.arrayBuffer();
    if (h.edit && res.status === 200) body = new TextEncoder().encode(JSON.stringify(h.edit(JSON.parse(Buffer.from(body).toString('utf8')))));
    entry.done = Date.now();
    if (h.after) await sleep(h.after);
    if (net.arrived) net.arrived(entry);
    return new Response(res.status === 304 ? null : body, { status: res.status, headers: res.headers });
  };
  return net;
}

const imp = (p) => import(pathToFileURL(path.join(WEB, p)).href);

/** The page against the mock: globals, a fake IndexedDB, the store. */
async function page(mockEnv = {}, { idb = fakeIndexedDB(), mock = null } = {}) {
  const m = mock || (await startMock(mockEnv));
  pageGlobals(m.base);
  idb.install();
  const net = pageFetch(m.base);
  const { sources } = await imp('js/sources.js');
  const { store } = await imp('js/store.js');
  await sources.refresh();
  return { m, net, idb, sources, store };
}

/** Waits until fn() is true (or ms passed). */
async function until(fn, ms = 10000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) return false;
    await sleep(20);
  }
  return true;
}

const settle = async (store) => {
  await store.refresh();
  if (store.idle) await store.idle();
  if (store.cacheIdle) await store.cacheIdle();
};

// =================================================================================================
// the reference: the store's whole merge of 96a1914 (buildShared, buildUser), kept as it was
// =================================================================================================

function reference({ songsMod, util, libs, order, offline = [], keepOffline = () => false, principal }) {
  const { groupVersions, scoreOf, signatureOf } = songsMod;
  const { hashId, norm, cmpText, ctxKey } = util;
  const sigCache = new WeakMap();
  const sigOf = (t) => {
    const fp = t.fp;
    if (!fp || typeof fp !== 'object') return null;
    if (sigCache.has(fp)) return sigCache.get(fp);
    const s = signatureOf(fp);
    sigCache.set(fp, s);
    return s;
  };
  const makeVersion = (sourceId, t, ord, kept = false) => ({ sourceId, trackId: t.id, fileHash: typeof t.fileHash === 'string' && t.fileHash ? t.fileHash : t.id, order: ord, sig: sigOf(t), score: scoreOf(t), t, kept });
  const trackOrder = (a, b) => (a.discNo || 1) - (b.discNo || 1) || (a.trackNo || 9999) - (b.trackNo || 9999) || cmpText(a.title, b.title);
  function buildShared() {
    const versions = [];
    order.forEach((sid, oi) => {
      for (const t of libs.get(sid).tracks) versions.push(makeVersion(sid, t, oi));
    });
    const present = new Set(versions.map((v) => v.trackId));
    for (const t of offline) {
      if (present.has(t.id) || !keepOffline(t)) continue;
      versions.push(makeVersion(t._src || '', t, order.length, true));
    }
    const songs = [];
    const tracks = new Map();
    for (const g of groupVersions(versions)) {
      const vs = g.map((i) => versions[i]);
      const rep = vs[0];
      const song = { ...rep.t, id: rep.trackId, coverId: rep.t.coverId || vs.find((v) => v.t.coverId)?.t.coverId || null, versions: vs, sources: [...new Set(vs.filter((v) => !v.kept).map((v) => v.sourceId))] };
      delete song._src;
      songs.push(song);
      tracks.set(song.id, song);
    }
    for (const song of songs) for (const v of song.versions) if (!tracks.has(v.trackId)) tracks.set(v.trackId, song);
    const albums = new Map();
    const artists = new Map();
    const albumOf = new Map();
    const artistOf = new Map();
    const searchText = new Map();
    const trackCover = new Map();
    const coverSrc = new Map();
    const addSrc = (coverId, ids) => {
      if (!coverId) return;
      let s = coverSrc.get(coverId);
      if (!s) coverSrc.set(coverId, (s = []));
      for (const id of ids) if (id && !s.includes(id)) s.push(id);
    };
    const customFrom = (kind, pairs) => {
      for (const [sid, id] of pairs) {
        const c = libs.get(sid)?.covers?.[kind]?.[id];
        if (c) {
          addSrc(c.large, [sid]);
          addSrc(c.small, [sid]);
          return { id: c.large, small: c.small };
        }
      }
      return null;
    };
    for (const t of songs) {
      const albumArtist = t.albumArtist || t.artist || '';
      const alId = hashId(`${albumArtist}\u0000${t.album || ''}`);
      const arId = hashId(t.artist || '');
      albumOf.set(t.id, alId);
      artistOf.set(t.id, arId);
      for (const v of t.versions) if (!v.kept) addSrc(v.t.coverId, [v.sourceId]);
      let al = albums.get(alId);
      if (!al) {
        al = { id: alId, name: t.album || '', artist: albumArtist, artistId: hashId(albumArtist), year: null, trackIds: [], cover: null, coverId: null, addedAt: 0, duration: 0 };
        albums.set(alId, al);
      }
      al.trackIds.push(t.id);
      if (t.year && (!al.year || t.year > al.year)) al.year = t.year;
      al.addedAt = Math.max(al.addedAt, t.addedAt || 0);
      al.duration += t.duration || 0;
      let ar = artists.get(arId);
      if (!ar) {
        ar = { id: arId, name: t.artist || '', trackIds: [], albumIds: [], cover: null, coverId: null, addedAt: 0 };
        artists.set(arId, ar);
      }
      ar.trackIds.push(t.id);
      if (!ar.albumIds.includes(alId)) ar.albumIds.push(alId);
      ar.addedAt = Math.max(ar.addedAt, t.addedAt || 0);
      searchText.set(t.id, norm(`${t.title} ${t.artist} ${t.album}`));
    }
    for (const al of albums.values()) {
      al.trackIds.sort((a, b) => trackOrder(tracks.get(a), tracks.get(b)));
      const embedded = al.trackIds.map((id) => tracks.get(id).coverId).find(Boolean);
      al.cover = customFrom('album', order.map((sid) => [sid, al.id])) || (embedded ? { id: embedded, small: embedded } : null);
      al.coverId = al.cover?.small || null;
    }
    for (const t of songs) {
      const own = customFrom('track', t.versions.filter((v) => !v.kept).map((v) => [v.sourceId, v.trackId])) || albums.get(albumOf.get(t.id)).cover || (t.coverId ? { id: t.coverId, small: t.coverId } : null);
      if (own) trackCover.set(t.id, own);
    }
    for (const ar of artists.values()) {
      ar.albumIds.sort((a, b) => (albums.get(b).year || 0) - (albums.get(a).year || 0) || cmpText(albums.get(a).name, albums.get(b).name));
      ar.cover = ar.albumIds.map((id) => albums.get(id).cover).find(Boolean) || null;
      ar.coverId = ar.cover?.small || null;
    }
    return { songs, d: { tracks, albums, artists, albumOf, artistOf, searchText, trackCover, coverSrc } };
  }
  function buildUser(sh, p) {
    const gid = (id) => sh.d.tracks.get(id)?.id || null;
    const likedSet = new Set();
    const likedIds = [];
    for (const like of [...p.likes].sort((a, b) => (b.at || 0) - (a.at || 0))) {
      const g = gid(like.id);
      if (g && !likedSet.has(g)) {
        likedSet.add(g);
        likedIds.push(g);
      }
    }
    const playlists = new Map(p.playlists.map((x) => [x.id, x]));
    const playlistCover = new Map();
    const userCoverSrc = new Map();
    for (const x of p.playlists) {
      const c = p.covers?.playlist?.[x.id];
      if (!c) continue;
      playlistCover.set(x.id, { id: c.large, small: c.small });
      if (principal) {
        userCoverSrc.set(c.large, [principal]);
        userCoverSrc.set(c.small, [principal]);
      }
    }
    const lastPlayed = new Map();
    const trackLastPlayed = new Map();
    const playCount = new Map();
    for (const r of p.recents) {
      const k = ctxKey(r.context || { type: 'library' });
      if ((lastPlayed.get(k) || 0) < r.at) lastPlayed.set(k, r.at);
      const g = gid(r.trackId) || r.trackId;
      if ((trackLastPlayed.get(g) || 0) < r.at) trackLastPlayed.set(g, r.at);
      playCount.set(g, (playCount.get(g) || 0) + 1);
    }
    return { likedSet, likedIds, playlists, playlistCover, userCoverSrc, lastPlayed, trackLastPlayed, playCount };
  }
  const sh = buildShared();
  const p = principal && libs.get(principal) ? libs.get(principal) : { likes: [], playlists: [], recents: [], covers: { playlist: {} } };
  return { songs: sh.songs, d: { ...sh.d, ...buildUser(sh, p) } };
}

/** The differences between the union's state and the reference (none: []). */
function differences(songs, d, ref) {
  const out = [];
  const say = (what, a, b) => {
    if (out.length < 8) out.push(`${what}: ${JSON.stringify(a)?.slice(0, 300)} != ${JSON.stringify(b)?.slice(0, 300)}`);
  };
  const vkey = (v) => [v.sourceId, v.trackId, v.fileHash, v.order, v.score, v.kept, JSON.stringify(v.sig ? [v.sig.d, v.sig.b, [...v.sig.s]] : null)].join('|');
  const sk = (s) => {
    const { versions, ...rest } = s;
    return JSON.stringify(rest) + versions.map(vkey).join(';');
  };
  if (songs.length !== ref.songs.length) say('songs', songs.length, ref.songs.length);
  for (let i = 0; i < Math.max(songs.length, ref.songs.length); i++) {
    if (!songs[i] || !ref.songs[i] || sk(songs[i]) !== sk(ref.songs[i])) {
      say(`song ${i}`, songs[i] && sk(songs[i]), ref.songs[i] && sk(ref.songs[i]));
      break;
    }
    for (const v of songs[i].versions) if (v.t !== ref.songs[i].versions.find((x) => x.sourceId === v.sourceId && x.trackId === v.trackId)?.t) say(`version track object ${i}`, v.trackId, '');
  }
  const mapEq = (name, a, b, f = (x) => JSON.stringify(x)) => {
    if (a.size !== b.size) say(`${name} size`, a.size, b.size);
    for (const [k, v] of b) if (!a.has(k) || f(a.get(k)) !== f(v)) say(`${name} ${k}`, a.get(k), v);
  };
  mapEq('tracks', d.tracks, ref.d.tracks, (s) => s.id);
  mapEq('albums', d.albums, ref.d.albums);
  mapEq('artists', d.artists, ref.d.artists);
  mapEq('albumOf', d.albumOf, ref.d.albumOf);
  mapEq('artistOf', d.artistOf, ref.d.artistOf);
  mapEq('trackCover', d.trackCover, ref.d.trackCover);
  mapEq('coverSrc', d.coverSrc, ref.d.coverSrc);
  for (const [id, x] of ref.d.searchText) if (d.searchText.get(id) !== x) say(`searchText ${id}`, d.searchText.get(id), x);
  if (JSON.stringify([...d.likedSet].sort()) !== JSON.stringify([...ref.d.likedSet].sort())) say('likedSet', [...d.likedSet], [...ref.d.likedSet]);
  if (JSON.stringify(d.likedIds) !== JSON.stringify(ref.d.likedIds)) say('likedIds', d.likedIds, ref.d.likedIds);
  mapEq('playlists', d.playlists, ref.d.playlists);
  mapEq('playlistCover', d.playlistCover, ref.d.playlistCover);
  mapEq('userCoverSrc', d.userCoverSrc, ref.d.userCoverSrc);
  mapEq('lastPlayed', d.lastPlayed, ref.d.lastPlayed);
  mapEq('trackLastPlayed', d.trackLastPlayed, ref.d.trackLastPlayed);
  mapEq('playCount', d.playCount, ref.d.playCount);
  return out;
}

// =================================================================================================
// sections
// =================================================================================================

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sections = {
  async hash() {
    pageGlobals('http://127.0.0.1:1');
    const util = await imp('js/util.js');
    let merge;
    try {
      merge = await imp('js/merge.js');
    } catch {
      merge = null;
    }
    const rnd = mulberry(12345);
    const pools = [
      () => String.fromCharCode(32 + Math.floor(rnd() * 95)),
      () => 'àèéìíòóùúÀÈÉÌÍÒÓÙÚ\u00f1\u00e7\u00df'[Math.floor(rnd() * 21)],
      () => String.fromCharCode(0x400 + Math.floor(rnd() * 0x700)),
      () => String.fromCharCode(0x4e00 + Math.floor(rnd() * 0x5000)),
      () => String.fromCodePoint(0x1f300 + Math.floor(rnd() * 0x300)),
      () => String.fromCharCode(0xd800 + Math.floor(rnd() * 0x800)),
      () => '\u0000',
    ];
    let bad = 0;
    let first = null;
    const N = 1000000;
    const t0 = Date.now();
    for (let i = 0; i < N; i++) {
      let s = '';
      const n = Math.floor(rnd() * 24);
      for (let k = 0; k < n; k++) s += pools[Math.floor(rnd() * (rnd() < 0.7 ? 2 : pools.length))]();
      if (!merge || merge.fnvId(s) !== util.hashId(s)) {
        bad++;
        if (!first) first = s;
      }
    }
    check(!!merge && bad === 0, `the album and artist ids in two 32 bit halves equal hashId on ${N.toLocaleString('en')} strings (${Date.now() - t0} ms)`, { bad, first: first && [...first].map((c) => c.codePointAt(0).toString(16)) });
  },

  async userops() {
    pageGlobals('http://127.0.0.1:1');
    const dir = path.join(outDir, 'userops-ref');
    fs.mkdirSync(dir, { recursive: true });
    // The source's rules at 96a1914, taken out of server/users.mjs as they were.
    const src = execFileSync('git', ['show', '96a1914:server/users.mjs'], { cwd: ROOT, encoding: 'utf8' });
    const take = (name) => {
      const i = src.search(new RegExp(`^(export )?function ${name} `, 'm'));
      const j = src.indexOf('\n}\n', i);
      return src.slice(i, j + 3).replace(/^export /, '');
    };
    fs.writeFileSync(path.join(dir, 'ref.mjs'), `${['countIds', 'nearestSlot', 'removalSlots', 'rebaseOrder'].map(take).join('\n')}\nexport { nearestSlot, removalSlots, rebaseOrder }\n`);
    const ref = await import(pathToFileURL(path.join(dir, 'ref.mjs')).href);
    let mine;
    try {
      mine = await imp('js/userops.js');
    } catch {
      mine = null;
    }
    const rnd = mulberry(777);
    const list = (n, a) => Array.from({ length: n }, () => 'abcdefgh'[Math.floor(rnd() * a)]);
    let bad = 0;
    let example = null;
    for (let i = 0; i < 20000 && mine; i++) {
      const cur = list(Math.floor(rnd() * 14), 2 + Math.floor(rnd() * 6));
      const base = list(Math.floor(rnd() * 14), 4);
      const want = rnd() < 0.5 ? [...base].sort(() => rnd() - 0.5) : list(Math.floor(rnd() * 14), 4);
      const k = Math.floor(rnd() * 5);
      const indexes = Array.from({ length: k }, () => Math.floor(rnd() * 16));
      const ids = indexes.map(() => 'abcdefgh'[Math.floor(rnd() * 4)]);
      const counts = rnd() < 0.5 ? ids.map(() => 1 + Math.floor(rnd() * 3)) : null;
      const a = JSON.stringify([mine.rebaseOrder(cur, base, want), [...mine.removalSlots(cur, indexes, ids, counts)].sort(), mine.nearestSlot(cur, ids[0], indexes[0] || 0)]);
      const b = JSON.stringify([ref.rebaseOrder(cur, base, want), [...ref.removalSlots(cur, indexes, ids, counts)].sort(), ref.nearestSlot(cur, ids[0], indexes[0] || 0)]);
      if (a !== b) {
        bad++;
        example = example || { cur, base, want, indexes, ids, counts, a, b };
      }
    }
    check(!!mine && bad === 0, 'userops.js gives the source\'s own rules (rebaseOrder, removalSlots, nearestSlot of 96a1914) on 20,000 random lists', example);
    const copy = path.join(ROOT, 'server/userops.mjs');
    if (fs.existsSync(copy)) check(fs.readFileSync(copy).equals(fs.readFileSync(path.join(WEB, 'js/userops.js'))), 'server/userops.mjs is a byte for byte copy of web/js/userops.js');
    else log('server/userops.mjs not there yet: the copy is checked when it is');
  },

  async union() {
    pageGlobals('http://127.0.0.1:1');
    const util = await imp('js/util.js');
    const songsMod = await imp('js/songs.js');
    const { Union, UserIndex } = await imp('js/merge.js');
    const b64 = (u) => Buffer.from(u.buffer, u.byteOffset, u.byteLength).toString('base64');
    let total = 0;
    let firstBad = null;
    let comparisons = 0;
    const ROUNDS = 40;
    const STEPS = 60;
    for (let round = 0; round < ROUNDS && !firstBad; round++) {
      const rnd = mulberry(1000 + round);
      const pick = (a) => a[Math.floor(rnd() * a.length)];
      const hex = (n) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(rnd() * 16)]).join('');
      const recs = Array.from({ length: 40 }, () => ({ base: Uint32Array.from({ length: 96 }, () => (rnd() * 4294967296) >>> 0), d: 150 + Math.floor(rnd() * 16) / 2 }));
      const sigOf = (r, shift, noise) => {
        const out = new Uint32Array(64);
        for (let j = 0; j < 64; j++) {
          let v = r.base[32 + j - shift] ?? ((rnd() * 4294967296) >>> 0);
          for (let b = 0; b < 32; b++) if (rnd() < noise) v ^= 1 << b;
          out[j] = v >>> 0;
        }
        return { d: Math.round((r.d + shift * 0.12381) * 10) / 10, b: 32, s: b64(out) };
      };
      const track = (ri, over = {}) => {
        const id = hex(24);
        return { id, fileHash: id, title: `Brano ${ri} ${pick(['a', 'B', 'c'])}`, artist: `Artista ${ri % 4}`, album: `Album ${ri % 7}`, albumArtist: `Artista ${ri % 4}`, trackNo: 1 + (ri % 5), discNo: 1, year: 1990 + (ri % 5), duration: recs[ri].d, addedAt: 1000 + Math.floor(rnd() * 100), coverId: rnd() < 0.6 ? `cov${ri % 5}` : null, fp: rnd() < 0.85 ? sigOf(recs[ri], Math.floor(rnd() * 3), rnd() < 0.6 ? 0.02 : 0.2) : null, score: 100 + Math.floor(rnd() * 5), mine: true, ...over };
      };
      const nsrc = 2 + (round % 2);
      const SRC = ['aaaa1111', 'bbbb2222', 'cccc3333'].slice(0, nsrc);
      const libs = new Map();
      const seq = new Map();
      let seqN = 0;
      for (const sid of SRC) libs.set(sid, { tracks: [], covers: { track: {}, album: {} }, likes: [], playlists: [], recents: [] });
      const put = (sid, t) => {
        libs.get(sid).tracks.push(t);
        seq.set(`${sid}:${t.id}`, ++seqN);
      };
      for (const sid of SRC) for (let i = 0; i < 25; i++) put(sid, track(Math.floor(rnd() * recs.length)));
      // The same file on two sources, and copies of the same recording.
      put(SRC[1], { ...libs.get(SRC[0]).tracks[2] });
      put(SRC[1], { ...track(3), fileHash: libs.get(SRC[0]).tracks[4].fileHash });
      let order = [...SRC];
      const offline = [];
      const host = { order: () => order, tracksOf: (sid) => libs.get(sid).tracks, trackOf: (sid, id) => libs.get(sid).tracks.find((t) => t.id === id), seqOf: (sid, id) => seq.get(`${sid}:${id}`) || 0, coversOf: (sid) => libs.get(sid)?.covers || null, kept: () => offline };
      const u = new Union(host);
      const user = new UserIndex();
      u.wholeNow();
      while (u.compareSome(50));
      const gid = (id) => u.d.tracks.get(id)?.id || null;
      const P = () => {
        const l = libs.get(order[0]);
        return { likes: l.likes, playlists: l.playlists, recents: l.recents, covers: { playlist: l.covers.playlist || {} } };
      };
      user.whole(P(), order[0], gid);
      const compare = (label) => {
        total++;
        const ref = reference({ songsMod, util, libs, order, offline, keepOffline: () => true, principal: order[0] });
        const diff = differences(u.songs, { ...u.d, ...user }, ref);
        if (diff.length && !firstBad) firstBad = { round, label, diff };
      };
      compare('start');
      for (let step = 0; step < STEPS && !firstBad; step++) {
        const sid = pick(SRC);
        const l = libs.get(sid);
        const dirty = { tracks: [], trackCovers: [], albumCovers: [] };
        const r = rnd();
        let label = '';
        let whole = false;
        let userMoved = false;
        if (r < 0.2 && l.tracks.length) {
          const i = Math.floor(rnd() * l.tracks.length);
          const [t] = l.tracks.splice(i, 1);
          seq.delete(`${sid}:${t.id}`);
          dirty.tracks.push([sid, t.id]);
          label = 'removed';
        } else if (r < 0.4) {
          const t = rnd() < 0.3 ? { ...pick(libs.get(pick(SRC)).tracks) } : track(Math.floor(rnd() * recs.length));
          if (!t.id || l.tracks.some((x) => x.id === t.id)) continue;
          put(sid, t);
          dirty.tracks.push([sid, t.id]);
          label = 'added';
        } else if (r < 0.55 && l.tracks.length) {
          const i = Math.floor(rnd() * l.tracks.length);
          const t = { ...l.tracks[i] };
          const what = rnd();
          if (what < 0.3) t.title = `Titolo ${step}`;
          else if (what < 0.5) {
            // Another file: a new one, or the very file another source holds (it joins that song).
            const other = pick(libs.get(pick(SRC)).tracks);
            t.fileHash = rnd() < 0.5 && other ? other.fileHash : hex(24);
          }
          else if (what < 0.7) t.fp = t.fp ? null : sigOf(pick(recs), 0, 0.01);
          else if (what < 0.85) t.trackNo = Math.floor(rnd() * 9);
          else t.coverId = t.coverId ? null : `cov${step % 5}`;
          l.tracks[i] = t;
          dirty.tracks.push([sid, t.id]);
          label = 'changed';
        } else if (r < 0.62 && l.tracks.length) {
          const t = pick(l.tracks);
          if (l.covers.track[t.id]) delete l.covers.track[t.id];
          else l.covers.track[t.id] = { small: `ts${step}`, large: `tl${step}` };
          dirty.trackCovers.push([sid, t.id]);
          label = 'track cover';
        } else if (r < 0.67) {
          const t = pick(l.tracks.length ? l.tracks : [{ artist: 'x', album: 'y' }]);
          const alId = util.hashId(`${t.albumArtist || t.artist || ''}\u0000${t.album || ''}`);
          if (l.covers.album[alId]) delete l.covers.album[alId];
          else l.covers.album[alId] = { small: `as${step}`, large: `al${step}` };
          dirty.albumCovers.push(alId);
          label = 'album cover';
        } else if (r < 0.72) {
          order = rnd() < 0.5 ? [...order].reverse() : [order[1], order[0], ...order.slice(2)];
          whole = true;
          label = 'order';
        } else if (r < 0.73 && l.tracks.length) {
          // A whole answer of a source: some tracks gone, some changed, one new, a new order.
          const keep = l.tracks.filter(() => rnd() < 0.8).map((t) => (rnd() < 0.2 ? { ...t, fileHash: rnd() < 0.5 ? hex(24) : t.fileHash, title: `Intero ${step}` } : t));
          keep.push(track(Math.floor(rnd() * recs.length)));
          if (rnd() < 0.3) keep.push({ ...pick(libs.get(pick(SRC)).tracks) });
          const ids = new Set();
          l.tracks = keep.filter((t) => t && !ids.has(t.id) && ids.add(t.id));
          for (const k of [...seq.keys()]) if (k.startsWith(`${sid}:`)) seq.delete(k);
          for (const t of l.tracks) seq.set(`${sid}:${t.id}`, ++seqN);
          whole = true;
          label = 'whole answer';
        } else if (r < 0.75 && l.tracks.length) {
          // A source removed: its downloaded tracks stay, with no source.
          const t = pick(l.tracks);
          offline.push({ ...t, id: hex(24), _src: 'dddd4444' });
          whole = true;
          label = 'kept';
        } else {
          const p = libs.get(order[0]);
          const all = [...libs.values()].flatMap((x) => x.tracks);
          const w = rnd();
          let moved = null;
          if (w < 0.35 && all.length) {
            const id = pick(all).id;
            if (!p.likes.some((x) => x.id === id)) {
              p.likes.unshift({ id, at: 5000 + step * 10 + (rnd() < 0.2 ? -1000 : 0) });
              moved = [[id], []];
            }
          } else if (w < 0.5 && p.likes.length) moved = [[], [p.likes.splice(Math.floor(rnd() * p.likes.length), 1)[0].id]];
          else if (w < 0.7) {
            if (!p.playlists.length || rnd() < 0.3) p.playlists.push({ id: hex(16), name: `Lista ${step}`, trackIds: [], description: '' });
            const x = pick(p.playlists);
            p.playlists[p.playlists.indexOf(x)] = { ...x, trackIds: [...x.trackIds, ...(all.length ? [pick(all).id] : [])] };
          } else if (w < 0.8 && p.playlists.length) {
            const x = pick(p.playlists);
            p.covers.playlist = p.covers.playlist || {};
            if (p.covers.playlist[x.id]) delete p.covers.playlist[x.id];
            else p.covers.playlist[x.id] = { small: `ps${step}`, large: `pl${step}` };
          } else if (all.length) {
            p.recents = [{ trackId: pick(all).id, at: 9000 + step, context: pick([{ type: 'library', id: null }, { type: 'album', id: 'x' }]) }, ...p.recents].slice(0, 50);
          }
          userMoved = moved ? 'likes' : true;
          if (moved) user.likesMoved(P(), gid, moved[0], moved[1]);
          label = moved ? 'likes' : 'user';
        }
        if (whole) {
          u.wholeNow();
          user.whole(P(), order[0], gid);
        } else if (!userMoved) {
          u.patch(dirty);
          const c = u.takeChanged();
          if (c.songs.size) user.likesAll(P(), gid);
          user.recentsAll(P(), gid);
        } else if (userMoved !== 'likes') {
          user.whole(P(), order[0], gid);
        }
        let more = false;
        while (u.compareSome(50)) more = true;
        if (more || u.takeChanged().songs.size) {
          user.likesAll(P(), gid);
          user.recentsAll(P(), gid);
        }
        compare(`step ${step} ${label}`);
      }
      comparisons += u.graph.comparisons;
    }
    check(!firstBad, `the union and its indexes equal the whole merge after every change: ${total} states in ${ROUNDS} random histories of two and three sources`, firstBad || { comparisons });
  },
};

// The page against the mock and the real sources: the store's own sections.
Object.assign(sections, {
  async budgets() {
    // One source of 20,000 songs (the principal) and the second holding the same files.
    const { m, net, idb, store } = await page({ MOCK_TRACKS: '20000', MOCK_MIRROR: '1', MOCK_LIKES: '20000', MOCK_PLAYLIST: '0' });
    const t0 = Date.now();
    await store.init();
    if (store.idle) await store.idle();
    if (store.cacheIdle) await store.cacheIdle();
    const n = store.lib.tracks.length;
    log(`start: ${n} songs in ${Date.now() - t0} ms, comparisons ${store.comparisons}`);
    check(Number.isFinite(store.comparisons) && store.comparisons < 100 && n >= 20000 && n < 20100, `two sources holding the same 20,000 files merged with fewer than 100 signature comparisons (${store.comparisons}, ${n} songs, ${Date.now() - t0} ms)`);
    // A one-track delta: another device edits one song on the principal.
    const target = store.lib.tracks.find((s) => s.versions.some((v) => v.sourceId === m.mi) && /\b\d+$/.test(s.title));
    const merges = store.merges;
    const before = idb.log.length;
    await m.api(m.mi, 'PATCH', `/tracks/${target.id}`, { title: 'Un titolo cambiato' });
    await settle(store);
    await sleep(1200);
    if (store.cacheIdle) await store.cacheIdle();
    const txs = idb.log.slice(before).filter((t) => t.mode === 'readwrite');
    const puts = txs.flatMap((t) => t.puts);
    const biggest = Math.max(0, ...puts.map(([, v]) => (Array.isArray(v?.tracks) ? v.tracks.length : v && typeof v === 'object' ? Object.values(v).reduce((k, x) => k + (x && typeof x === 'object' && Array.isArray(x.tracks) ? x.tracks.length : 0), 0) : 0)));
    check(store.track(target.id)?.title === 'Un titolo cambiato' && store.merges === merges, `a one-track delta at 20,000 songs runs no whole merge (merges ${merges} -> ${store.merges})`);
    check(puts.length <= 2 && biggest <= 1000, `a one-track delta writes at most two IndexedDB records, none of them more than one chunk (${puts.length} records: ${puts.map(([k]) => k).join(', ')}; the biggest holds ${biggest} tracks)`);
    m.stop();
    process.exit(fails ? 1 : 0);
  },

  async budget100k() {
    const { m, net, store } = await page({ MOCK_TRACKS: '100000', MOCK_LIKES: '100000', MOCK_PLAYLIST: '0' });
    const t0 = Date.now();
    await store.init();
    if (store.idle) await store.idle();
    log(`start: ${store.lib.tracks.length} songs in ${Date.now() - t0} ms`);
    await sleep(500);
    // From the answer's arrival to the page told, over a few runs (the best of them, as a budget).
    const timeOf = async (fn, n = 5) => {
      const times = [];
      for (let i = 0; i < n; i++) {
        let tArrive = 0;
        let tEmit = 0;
        net.arrived = (e) => {
          if (e.path.includes('/library')) tArrive = performance.now();
        };
        const off = store.subscribe(() => {
          if (tArrive && !tEmit) tEmit = performance.now();
        });
        await fn(i);
        await sleep(50);
        off();
        net.arrived = null;
        if (tArrive && tEmit) times.push(tEmit - tArrive);
      }
      return times;
    };
    const ids = store.lib.tracks.slice(5000, 5010).map((s) => s.id);
    const delta = await timeOf(async (i) => {
      await m.api(m.mi, 'PATCH', `/tracks/${ids[i]}`, { title: `Titolo ${i}` });
      await store.refresh();
    });
    check(delta.length && Math.min(...delta) <= 2, `a one-track delta at 100,000 songs: at most 2 ms from the answer to the page (${delta.map((x) => x.toFixed(2)).join(', ')} ms)`);
    const plays = await timeOf(async (i) => {
      await m.api(m.mi, 'POST', '/played', { trackId: ids[i], context: { type: 'library', id: null } });
      await store.refresh();
    });
    check(plays.length && Math.min(...plays) <= 1, `a play report at 100,000 likes: at most 1 ms from the answer to the page (${plays.map((x) => x.toFixed(2)).join(', ')} ms)`);
    const hearts = [];
    const free = store.lib.tracks.filter((s) => !store.isLiked(s.id));
    for (let i = 0; i < 5; i++) {
      const t1 = performance.now();
      let t2 = 0;
      const off = store.subscribe(() => {
        if (!t2) t2 = performance.now();
      });
      const p = store.like(free[i].id);
      off();
      hearts.push(t2 - t1);
      await p;
    }
    check(Math.min(...hearts) <= 1, `a heart at 100,000 likes: shown in at most 1 ms (${hearts.map((x) => x.toFixed(2)).join(', ')} ms)`);
    m.stop();
    process.exit(fails ? 1 : 0);
  },
});

// The page and its changes on their way, the cache, real sources.
Object.assign(sections, {
  async likes() {
    // 300,000 likes (most of songs no source has): a heart patches the lists in place.
    const { m, store } = await page({ MOCK_TRACKS: '2000', MOCK_LIKES: '300000', MOCK_PLAYLIST: '0' });
    await store.init();
    if (store.idle) await store.idle();
    const likes = store.lib.likes;
    const ids = store.d.likedIds;
    const n0 = likes.length;
    const free = store.lib.tracks.filter((s) => !store.isLiked(s.id));
    const song = free[0];
    const t1 = performance.now();
    const p = store.like(song.id);
    const t2 = performance.now();
    const shown = store.isLiked(song.id);
    await p;
    await settle(store);
    // Then a few more, each timed alone (the first one also pays for the code made ready).
    const times = [];
    for (const x of free.slice(1, 6)) {
      const t3 = performance.now();
      const q = store.like(x.id);
      times.push(performance.now() - t3);
      await q;
    }
    await settle(store);
    log('hearts at 300,000 likes, ms:', times.map((x) => x.toFixed(2)).join(' '));
    check(n0 >= 300000 && shown && store.lib.likes === likes && store.d.likedIds === ids && store.lib.likes.length === n0 + 6 && store.lib.likes.some((x) => x.id === song.id), `a heart at 300,000 likes makes no new likes array (the same array, ${n0} -> ${store.lib.likes.length}; shown in ${(t2 - t1).toFixed(2)} ms, then ${times.map((x) => x.toFixed(2)).join(", ")} ms)`);
    m.stop();
    process.exit(fails ? 1 : 0);
  },

  async optimistic() {
    const { m, net, store } = await page({ MOCK_TRACKS: '0' });
    await store.init();
    await settle(store);
    const P = m.mi;
    const pl = store.lib.playlists[0];
    const listOf = (id) => store.d.playlists.get(id)?.trackIds || [];
    const outside = (id) => store.lib.tracks.find((s) => s.versions.some((v) => v.sourceId === P) && !listOf(id).includes(s.id));
    const watch = (fn) => {
      const seen = [];
      const off = store.subscribe(() => seen.push(fn()));
      return { seen, off };
    };

    // A rename after an add, the add refused: the song goes, the rename stays.
    {
      const X = outside(pl.id);
      net.hook = (method, p) => (method === 'POST' && p.endsWith(`/playlists/${pl.id}/tracks`) ? { before: 300, fail: 500 } : null);
      const a = store.addToPlaylist(pl.id, [X.id]);
      const r = store.updatePlaylist(pl.id, { name: 'Nome nuovo' });
      const both = listOf(pl.id).includes(X.id) && store.d.playlists.get(pl.id).name === 'Nome nuovo';
      await Promise.all([a, r]);
      const after = !listOf(pl.id).includes(X.id) && store.d.playlists.get(pl.id).name === 'Nome nuovo';
      net.hook = () => null;
      await settle(store);
      check(both && after && store.d.playlists.get(pl.id).name === 'Nome nuovo' && !listOf(pl.id).includes(X.id), 'a rename after an add, the add refused: the song goes, the rename stays');
    }

    // A delta of another device for a playlist with a rename on its way: it shows, under the rename.
    {
      const Y = outside(pl.id);
      net.hook = (method, p) => (method === 'PATCH' && p.endsWith(`/playlists/${pl.id}`) ? { after: 700 } : null);
      const r = store.updatePlaylist(pl.id, { name: 'Rinominata' });
      await sleep(100);
      await m.api(P, 'POST', `/playlists/${pl.id}/tracks`, { trackIds: [Y.id] });
      const f = store.refresh();
      await Promise.all([r, f]);
      net.hook = () => null;
      await settle(store);
      check(listOf(pl.id).includes(Y.id) && store.d.playlists.get(pl.id).name === 'Rinominata' && store.pendingOps(P) === 0, "another device's song shows in a playlist renamed here while the rename travelled");
    }

    // The hold rule: a library answer that holds an add whose own answer is not in yet waits for it.
    for (const when of ['before', 'after']) {
      const Z = outside(pl.id);
      const count = () => listOf(pl.id).filter((x) => x === Z.id).length;
      net.hook = (method, p) => {
        if (method === 'POST' && p.endsWith(`/playlists/${pl.id}/tracks`)) return { after: 900 };
        if (when === 'after' && method === 'GET' && p.endsWith('/library')) return { before: 300 };
        return null;
      };
      const w = watch(count);
      let add;
      let lib;
      if (when === 'before') {
        add = store.addToPlaylist(pl.id, [Z.id]);
        await sleep(150);
        lib = store.refresh();
      } else {
        lib = store.refresh();
        await sleep(50);
        add = store.addToPlaylist(pl.id, [Z.id]);
      }
      await Promise.all([add, lib]);
      net.hook = () => null;
      await settle(store);
      w.off();
      // Once shown it stays, once: never twice, never gone again.
      const from = w.seen.indexOf(1);
      const steady = from >= 0 && w.seen.slice(from).every((x) => x === 1);
      check(steady && count() === 1, `a library answer that holds an add sent ${when} it, whose own answer is not in yet, waits for it: the song shows once and stays (counts seen in turn ${w.seen.join(' ')})`);
    }

    // A refused like goes back alone; the others stay.
    {
      const [A, B] = store.lib.tracks.filter((s) => !store.isLiked(s.id));
      net.hook = (method, p) => (method === 'PUT' && p.includes(`/likes/${A.id}`) ? { before: 200, fail: 500 } : null);
      const pa = store.like(A.id);
      const pb = store.like(B.id);
      const shown = store.isLiked(A.id) && store.isLiked(B.id);
      await Promise.all([pa, pb]);
      const after = !store.isLiked(A.id) && store.isLiked(B.id);
      net.hook = () => null;
      await settle(store);
      check(shown && after && !store.isLiked(A.id) && store.isLiked(B.id), 'a refused like goes back alone, the other like stays');
      // The delta that holds a settled like takes its place: one like, none on the way.
      const C = store.lib.tracks.find((s) => !store.isLiked(s.id));
      await store.like(C.id);
      const pending = store.pendingOps(P);
      await settle(store);
      check(pending >= 1 && store.pendingOps(P) === 0 && store.lib.likes.filter((x) => x.id === store.gid(C.id)).length === 1, `the delta that holds a settled like takes its place (on the way ${pending}, then ${store.pendingOps(P)})`);
    }

    // The source started again: an operation whose answer named the epoch before it leaves at the
    // first answer asked after it settled (its change is in that answer, or was lost with the run).
    {
      const E = store.lib.tracks.find((s) => !store.isLiked(s.id));
      const F = store.lib.tracks.filter((s) => !store.isLiked(s.id))[1];
      await store.like(E.id);
      await m.helper(`source?source=${P}&restart=1`);
      await m.api(P, 'PUT', `/likes/${F.id}`);
      await settle(store);
      check(store.pendingOps(P) === 0 && store.isLiked(E.id) && store.isLiked(F.id), `a source started again: a change whose answer named the epoch before leaves at the next answer (on the way ${store.pendingOps(P)})`);
    }

    // A source of before the versions: no headers, today's rule; a library answer that left
    // before an add's answer came is asked again, so the add is never laid twice.
    {
      await m.helper(`source?source=${P}&delta=0`);
      await settle(store);
      const D = store.lib.tracks.find((s) => !store.isLiked(s.id));
      await store.like(D.id);
      const waiting = store.pendingOps(P);
      await settle(store);
      const Z = outside(pl.id);
      const count = () => listOf(pl.id).filter((x) => x === Z.id).length;
      net.hook = (method, p) => (method === 'POST' && p.endsWith(`/playlists/${pl.id}/tracks`) ? { after: 600 } : null);
      const w = watch(count);
      const add = store.addToPlaylist(pl.id, [Z.id]);
      await sleep(100);
      await Promise.all([add, store.refresh()]);
      net.hook = () => null;
      await settle(store);
      w.off();
      check(waiting === 1 && store.isLiked(D.id) && store.pendingOps(P) === 0 && Math.max(...w.seen, 0) === 1 && count() === 1, `a source of before the versions: a like stays shown until an answer asked after it, an add is never laid twice (counts ${[...new Set(w.seen)].join(', ')})`);
      await m.helper(`source?source=${P}&delta=1`);
      await settle(store);
    }

    // Many likes at once to another source, and one at a time to a source without that route.
    {
      const before = (await m.api(m.vps, 'GET', '/library?delta=1')).body.likes.length;
      net.reqs.length = 0;
      const r1 = await store.copyUserData(P, m.vps);
      const bulk = net.reqs.filter((x) => x.path.endsWith('/likes') && x.method === 'POST').length;
      const after = (await m.api(m.vps, 'GET', '/library?delta=1')).body.likes.length;
      await m.helper(`source?source=${m.vps}&delta=0`);
      const one = store.lib.tracks.find((s) => !store.isLiked(s.id));
      await store.like(one.id);
      await settle(store);
      net.reqs.length = 0;
      await store.copyUserData(P, m.vps);
      const puts = net.reqs.filter((x) => /\/likes\/[0-9a-f]{24}\?brief=1$/.test(x.path) && x.method === 'PUT').length;
      const four = net.reqs.filter((x) => x.path.endsWith('/likes') && x.method === 'POST').length;
      const last = (await m.api(m.vps, 'GET', '/library')).body.likes.length;
      check(!!r1 && bulk === 1 && after > before && four === 1 && puts >= 1 && last === after + 1, `the principal's likes copied many at once (${bulk} request for ${after - before}), and one at a time to a source without the route (404, then ${puts} PUT ?brief=1)`);
    }
    m.stop();
    process.exit(fails ? 1 : 0);
  },

  /** The cache: steps in their own processes (each a page started again), the fake IndexedDB kept in a file between them. */
  async idb() {
    const file = path.join(outDir, 'idb-steps.json');
    const mock = await startMock({ MOCK_TRACKS: '6000', MOCK_MIRROR: 'copies', MOCK_LIKES: '6000', MOCK_PLAYLIST: '0' });
    const step = async (name) => {
      const child = spawn(process.execPath, ['--max-old-space-size=4096', fileURLToPath(import.meta.url), outDir, '--section', 'idbStep', '--web', WEB, '--step', name, '--port', String(mock.port), '--file', file], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      const code = await new Promise((r) => child.on('close', r));
      for (const line of out.split('\n')) {
        if (!line) continue;
        console.log(line);
        if (/^FAIL /.test(line)) fails++;
      }
      if (code !== 0 && !/FAIL /.test(out)) check(false, `idb ${name}: the step ran to its end (exit ${code})`, out.slice(-800));
    };
    fs.rmSync(file, { force: true });
    for (const name of ['first', 'cut', 'offline-cut', 'tabs', 'offline-tabs', 'stale', 'old']) await step(name);
    mock.stop();
    process.exit(fails ? 1 : 0);
  },

  async idbStep() {
    const name = flag('--step');
    const port = Number(flag('--port'));
    const file = flag('--file');
    const base = `http://127.0.0.1:${port}`;
    const helper = async (p) => (await fetch(`${base}/__mock/${p}`)).text();
    const st = await (await fetch(`${base}/__mock/state`)).json();
    const P = st.servers[0].id;
    const V = st.servers[1].id;
    const mockApi = async (src, method, p, body) => {
      const r = await fetch(`${base}/s/${src}/api${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
      const text = await r.text();
      return text ? JSON.parse(text) : null;
    };
    const idb = fakeIndexedDB();
    if (fs.existsSync(file)) for (const [k, v] of JSON.parse(fs.readFileSync(file, 'utf8'))) idb.data.set(k, v);
    const keep = () => fs.writeFileSync(file, JSON.stringify([...idb.data]));
    const mock = { base, port, helper, mi: P, vps: V, stop: noop };
    const libTitles = async (src) => {
      const r = await mockApi(src, 'GET', '/library');
      return { version: r.version, titles: new Map(r.tracks.map((t) => [t.id, t.title])), likes: r.likes.length };
    };
    const shownTitles = (store, src) => new Map(store.libOf(src).tracks.map((t) => [t.id, t.title]));
    const sameMap = (a, b) => a.size === b.size && [...b].every(([k, v]) => a.get(k) === v);
    await helper('offline?on=0');

    if (name === 'first') {
      const { store } = await page({}, { idb, mock });
      await store.init();
      await settle(store);
      const keys = [...idb.data.keys()];
      const bad = keys.filter((k) => k.startsWith('L1:')).filter((k) => {
        const v = idb.data.get(k);
        const kind = k.startsWith('L1:m:e:') ? 'e' : /:t:\d+$/.test(k) ? 't' : /:l:\d+$/.test(k) ? 'l' : /:p:[0-9a-f]+$/.test(k) ? 'p' : k.split(':').pop();
        return !v || v.k !== kind;
      });
      const edges = keys.filter((k) => k.startsWith('L1:m:e:'));
      check(keys.some((k) => /^L1:[0-9a-f]+:t:\d+$/.test(k)) && !bad.length && edges.length >= 2, `the cache in chunks: every value says what it is (${keys.length} records, ${edges.length} edge chunks)`, bad.slice(0, 5));
      // A delta that moves no edge writes no edge chunk; one that takes a copy away writes only its chunks.
      const copy = store.libOf(V).tracks.find((t) => t.title && store.track(t.id)?.versions.length === 2 && /\d+$/.test(t.title));
      const before = idb.log.length;
      await mockApi(V, 'PATCH', `/tracks/${copy.id}`, { title: 'Copia rinominata' });
      await settle(store);
      const meta = idb.log.slice(before).flatMap((t) => t.puts.map(([k]) => k));
      check(meta.length >= 1 && !meta.some((k) => k.startsWith('L1:m:e:')), `a delta that moves no edge rewrites no edge chunk (${meta.join(', ')})`);
      const edgesBefore = new Map(edges.map((k) => [k, JSON.stringify(idb.data.get(k))]));
      const before2 = idb.log.length;
      await mockApi(V, 'DELETE', `/tracks/${copy.id}`);
      await settle(store);
      await sleep(300);
      await store.cacheIdle();
      const written = [...new Set(idb.log.slice(before2).flatMap((t) => [...t.puts.map(([k]) => k), ...t.deletes]).filter((k) => k.startsWith('L1:m:e:')))];
      const moved = [...edgesBefore].filter(([k, v]) => JSON.stringify(idb.data.get(k)) !== v).map(([k]) => k);
      check(written.length >= 1 && written.length < edges.length && written.every((k) => moved.includes(k)), `a delta that takes a copy away rewrites only the edge chunks that moved (${written.length} of ${edges.length})`, { written, moved });
      keep();
    } else if (name === 'cut') {
      const { store } = await page({}, { idb, mock });
      await store.init();
      await settle(store);
      keep();
      const t = store.libOf(P).tracks[10];
      fs.writeFileSync(`${file}.before`, JSON.stringify({ version: store.libOf(P).version, id: t.id, title: t.title }));
      idb.failAt(2);
      await mockApi(P, 'PATCH', `/tracks/${t.id}`, { title: 'Titolo interrotto' });
      await settle(store);
      check(store.track(t.id).title === 'Titolo interrotto', 'the delta shows here while its write to the cache is cut in the middle');
      keep();
    } else if (name === 'offline-cut') {
      await helper('offline?on=1');
      const was = JSON.parse(fs.readFileSync(`${file}.before`, 'utf8'));
      const { store, sources } = await page({}, { idb, mock });
      await store.init();
      const S = store.libOf(P);
      check(S && S.version === was.version && store.track(was.id)?.title === was.title, `a delta cut in the middle leaves the cache as it was before it (version ${S?.version} = ${was.version}, "${store.track(was.id)?.title}")`);
      await helper('offline?on=0');
      await sources.refresh();
      await settle(store);
      const now = await libTitles(P);
      check(sameMap(shownTitles(store, P), now.titles), 'then the source answers: its whole state is shown and kept');
      keep();
    } else if (name === 'tabs') {
      // Two tabs on one database, each writing its deltas in turn.
      const one = await page({}, { idb, mock });
      const two = { store: (await import(`${pathToFileURL(path.join(WEB, 'js/store.js')).href}?tab=2`)).store };
      await one.store.init();
      await two.store.init();
      await settle(one.store);
      await settle(two.store);
      const ids = one.store.libOf(P).tracks.slice(100, 106).map((t) => t.id);
      for (let i = 0; i < ids.length; i++) {
        await mockApi(P, 'PATCH', `/tracks/${ids[i]}`, { title: `Scheda ${i}` });
        if (i === 2) await mockApi(P, 'DELETE', `/tracks/${one.store.libOf(P).tracks[3000].id}`);
        await settle(i % 2 ? two.store : one.store);
      }
      await settle(one.store);
      await settle(two.store);
      check(one.store.cacheStats.rebuilds + two.store.cacheStats.rebuilds >= 1, `two tabs writing deltas in turn: a tab that found the other's layout wrote its whole state again (${one.store.cacheStats.rebuilds} + ${two.store.cacheStats.rebuilds} times)`);
      keep();
    } else if (name === 'offline-tabs') {
      const now = await libTitles(P);
      const full = (await mockApi(P, 'GET', '/library')).tracks.map((t) => t.id).join(',');
      await helper('offline?on=1');
      const { store } = await page({}, { idb, mock });
      await store.init();
      const shown = shownTitles(store, P);
      const order = store.libOf(P).tracks.map((t) => t.id).join(',');
      await helper('offline?on=0');
      check(sameMap(shown, now.titles) && order === full && store.libOf(P).version === now.version, `after two tabs, an offline start equals the source's state (${shown.size} tracks in its order, version ${store.libOf(P).version})`);
    } else if (name === 'stale') {
      // The list of sources comes before the cache is read: the page waits for its cache, so even
      // its first library request is on the cache's versions (a start never asks a whole answer).
      const { store, net } = await page({}, { idb, mock });
      net.hook = (method, p) => (method === 'GET' && p.endsWith('/library') ? { after: 400 } : null);
      await store.init();
      net.hook = () => null;
      await settle(store);
      const asked = net.reqs.filter((r) => r.path.startsWith(`/s/${P}/api/library`)).map((r) => r.path.replace(/^[^?]*\?/, ''));
      const now = await libTitles(P);
      check(asked.length >= 1 && asked.every((x) => /have=\d+&he=[0-9a-f]{16}/.test(x)) && sameMap(shownTitles(store, P), now.titles), `the sources listed before the cache is read: every library request is on the cache's versions, the source's state shown (${asked.length} requests)`, asked);
    } else if (name === 'old') {
      // The cache of before the chunks: read once, written in chunks, then dropped.
      const old = fakeIndexedDB();
      const lib = await mockApi(P, 'GET', '/library');
      old.data.set('shared', { [P]: { version: lib.version, tracks: lib.tracks, covers: { track: lib.covers.track, album: lib.covers.album } } });
      old.data.set('user', { [P]: { version: lib.version, userVersion: lib.userVersion, playlists: lib.playlists, likes: lib.likes, recents: lib.recents, playlistCovers: lib.covers.playlist, you: lib.you, source: lib.source, etag: null } });
      await helper('offline?on=1');
      const { store } = await page({}, { idb: old, mock });
      await store.init();
      await store.cacheIdle();
      await sleep(300);
      const shown = shownTitles(store, P);
      const moved = [...old.data.keys()].some((k) => k.startsWith(`L1:${P}:t:`)) && !old.data.has('shared') && !old.data.has('user');
      check(shown.size === lib.tracks.length && store.libOf(P).likes.length === lib.likes.length && moved, `the cache of before the chunks is read, written in chunks and dropped (${shown.size} tracks, ${store.libOf(P).likes.length} likes)`);
      await helper('offline?on=0');
    }
    process.exit(fails ? 1 : 0);
  },

  async dup() {
    const { m, net, store } = await page({ MOCK_TRACKS: '0' });
    // A whole answer that lists a like twice (a walk while it moved): kept once.
    net.hook = (method, p) =>
      method === 'GET' && p.endsWith('/library')
        ? {
            edit: (b) => {
              if (Array.isArray(b.likes) && b.likes.length > 3) b.likes.splice(3, 0, { ...b.likes[0] });
              return b;
            },
          }
        : null;
    await store.init();
    net.hook = () => null;
    const likes = store.lib.likes.map((x) => x.id);
    check(likes.length === new Set(likes).size && likes.length > 3, `a whole answer with a like listed twice keeps it once (${likes.length} likes)`);
    m.stop();
    process.exit(fails ? 1 : 0);
  },
});

// The store against real sources: today's source (96a1914, no delta) and this tree's.
Object.assign(sections, {
  async real() {
    const head = path.join(outDir, 'source-96a1914');
    if (!fs.existsSync(path.join(head, 'server', 'app.mjs'))) {
      fs.mkdirSync(head, { recursive: true });
      execFileSync('git', ['archive', '--format=tar', '-o', path.join(head, 'source.tar'), '96a1914', 'server', 'transport', 'test/helpers.mjs', 'package.json'], { cwd: ROOT });
      execFileSync('tar', ['-xf', 'source.tar'], { cwd: head });
    }
    for (const [label, root] of [['the source of 96a1914 (no delta)', head], ["this tree's source", ROOT]]) {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), outDir, '--section', 'realOne', '--web', WEB, '--server', root, '--label', label], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      const code = await new Promise((r) => child.on('close', r));
      for (const line of out.split('\n')) {
        if (!line) continue;
        console.log(line);
        if (/^FAIL /.test(line)) fails++;
      }
      if (code !== 0 && !/FAIL /.test(out)) check(false, `${label}: the run ended (exit ${code})`, out.slice(-1500));
    }
    process.exit(fails ? 1 : 0);
  },

  async realOne() {
    const root = flag('--server');
    const label = flag('--label');
    pageGlobals('http://127.0.0.1:47123');
    fakeIndexedDB().install();
    const fromRoot = (p) => import(pathToFileURL(path.join(root, p)).href);
    const { createMPfy } = await fromRoot('server/app.mjs');
    const { tmpDir, request, json, makeWav } = await fromRoot('test/helpers.mjs');
    const mk = (name) => createMPfy({ dataDir: tmpDir('mpfy-store-scale-'), port: 0, adminPort: 0, p2p: false, debounceMs: 10, ffmpeg: null, fpcalc: null, sevenZip: null, name });
    const A = 'aaaa1111';
    const B = 'bbbb2222';
    const apps = { [A]: await mk('Uno'), [B]: await mk('Due') };
    const SOURCES = [
      { id: A, name: 'Uno', principal: true, connected: true, addedAt: 1, role: 'owner', profiles: true },
      { id: B, name: 'Due', principal: false, connected: true, addedAt: 2, role: 'owner', profiles: true },
    ];
    const realFetch = globalThis.fetch;
    const reqs = [];
    globalThis.fetch = async (input, init = {}) => {
      const u = new URL(typeof input === 'string' ? input : input.url, 'http://127.0.0.1:47123');
      if (u.pathname === '/local/sources') return new Response(JSON.stringify({ sources: SOURCES }), { status: 200, headers: { 'content-type': 'application/json' } });
      const m = /^\/s\/([^/]+)(\/.*)$/.exec(u.pathname);
      if (!m || !apps[m[1]]) return new Response('{}', { status: 404 });
      const { cache, signal, ...rest } = init;
      reqs.push(`${init.method || 'GET'} ${m[1]} ${m[2]}${u.search}`);
      const res = await realFetch(`http://127.0.0.1:${apps[m[1]].ports.http}${m[2]}${u.search}`, rest);
      const body = await res.arrayBuffer();
      return new Response(res.status === 304 ? null : body, { status: res.status, headers: res.headers });
    };
    const util = await imp('js/util.js');
    const songsMod = await imp('js/songs.js');
    const { sources } = await imp('js/sources.js');
    const { store } = await imp('js/store.js');
    const call = async (src, method, p, body) => {
      const r = await request(apps[src].ports.http, method, p, body === undefined ? {} : { body });
      return r.body.length ? json(r) : null;
    };
    let freq = 300;
    const up = async (src, name) => (await call(src, 'PUT', `/api/upload/${encodeURIComponent(name)}`, makeWav({ freq: (freq += 37), seconds: 1 }))).track;
    const files = [];
    for (let i = 0; i < 12; i++) files.push(await up(A, `brano ${i}.wav`));
    for (let i = 0; i < 6; i++) await up(B, `altro ${i}.wav`);
    await sources.refresh();
    await store.init();
    await settle(store);
    let checkpoints = 0;
    let bad = null;
    const strip = (t) => {
      const { lyrics, ...rest } = t;
      return rest;
    };
    /** The store equals what a fresh start reads (each source's whole answer) and its union equals the whole merge of it. */
    const same = async (what) => {
      await settle(store);
      checkpoints++;
      for (const src of [A, B]) {
        const full = await call(src, 'GET', '/api/library');
        const shown = store.libOf(src);
        const a = JSON.stringify([shown.tracks.map(strip), shown.playlists, shown.likes.map((x) => [x.id, x.at]), shown.recents.slice(0, 50)]);
        const b = JSON.stringify([full.tracks.map(strip), full.playlists, full.likes.map((x) => [x.id, x.at]), full.recents]);
        if (a !== b && !bad) bad = { what, src, shown: a.slice(0, 400), full: b.slice(0, 400) };
      }
      const libs = new Map([A, B].map((src) => [src, store.libOf(src)]));
      const ref = reference({ songsMod, util, libs, order: [A, B], principal: A });
      const diff = differences(store.lib.tracks, store.d, ref);
      if (diff.length && !bad) bad = { what, diff };
    };
    await same('start');
    await store.like(files[0].id);
    await same('a like');
    const pl = await store.createPlaylist('Prova', '', [files[1].id, files[2].id]);
    await same('a playlist made');
    await store.addToPlaylist(pl.id, [files[3].id, files[1].id]);
    await store.removeFromPlaylist(pl.id, [{ index: 0, id: files[1].id }]);
    await same('songs added and removed');
    await store.updatePlaylist(pl.id, { name: 'Prova due', trackIds: [files[3].id, files[2].id, files[1].id], base: store.d.playlists.get(pl.id).trackIds.slice() });
    await same('a rename and a new order');
    await store.editTrack(files[4].id, { title: 'Titolo nuovo' });
    await same('a track edited');
    await call(A, 'PATCH', `/api/tracks/${files[5].id}`, { title: 'Da un altro dispositivo' });
    await call(A, 'PUT', `/api/likes/${files[6].id}`);
    await call(A, 'POST', '/api/played', { trackId: files[6].id, context: { type: 'library' } });
    await same("another device's edit, like and play");
    await store.deleteVersion(files[7].id, A);
    await same('a track deleted');
    const again = await up(A, 'brano 7.wav');
    await same(`the same name uploaded again (${again.id === files[7].id ? 'the same id' : 'another id'})`);
    await store.unlike(files[0].id);
    await store.deletePlaylist(pl.id);
    await same('an unlike and a playlist deleted');
    const libReqs = reqs.filter((r) => r.includes('/api/library'));
    check(!bad, `${label}: at ${checkpoints} checkpoints the store equals each source's whole answer, and its union the whole merge of it (${libReqs.length} library requests, ${libReqs.filter((r) => r.includes('delta=1')).length} with delta=1)`, bad || undefined);
    for (const a of Object.values(apps)) await a.close();
    process.exit(fails ? 1 : 0);
  },
});

if (!sections[SECTION]) {
  console.log(`FAIL unknown section ${SECTION}`);
  process.exit(1);
}
try {
  await sections[SECTION]();
} catch (err) {
  check(false, `${SECTION}: the section ran to its end (${String((err && err.stack) || err).slice(0, 600)})`);
}
process.exit(fails ? 1 : 0);
