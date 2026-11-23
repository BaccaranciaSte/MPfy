// Drives the page's side of bridge 4 in Node, with a minimal DOM stub, against a fake Android app
// (window.MPfyNative answering bridgeVersion "4") and a fake client core with two sources: the
// Mi A2 (principal, owned by this person) and the VPS (this person is a member there).
//
//   - queue: every setQueue carries a queueId (16 hex, kept while the same list is edited, new for
//     a new list) and items with albumArtist, trackNo, liked, likedIds and ctx (a library context
//     kept); a state with a new n... id makes the page call getQueue and take that list over
//     without a setQueue, also at start (before the sources and the library are here, as the page
//     starts) and after the page is loaded again; nothing goes back when they arrive; its later
//     edits carry that id; the page's own previous id arriving late, an id already taken over and
//     an empty player (null) never call getQueue; a getQueue that answered nothing is asked again;
//     a song liked as two versions carries both ids;
//   - the heart: setLiked after every like change (the page's own, another device's), also under
//     the id a queue item keeps when its song's id moves; the app's 'liked' events applied to the
//     store without a request, a failure said with a toast;
//   - the car's snapshot: shape, orders, artwork, the quality settings resolved, liked ids, recent
//     from the Home contexts, every version (one on a disconnected source too), offsets from
//     signatures, sent once after 2 s of quiet and only when it changed; 20000 songs at most, 4 MB;
//   - "Cerca i dettagli in rete": the library keeps source.details, the PATCH body, the answer
//     applied, the old state back with a toast when it fails, an older answer never taken;
//   - updates: the state at start and from events, startUpdate only from "available", the toast
//     of a failure, the ring offsets.
//
// Usage: node web/dev/bridge4-harness.mjs <web dir>   (prints OK/FAIL lines, exit 1 on a failure)
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const web = path.resolve(process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..'));
const noop = () => {};
const ls = new Map();
const el = () => Object.assign(Object.create(Node.prototype), { kids: [], append(...a) { this.kids.push(...a); }, appendChild: noop, remove: noop, classList: { add: noop, remove: noop, toggle: noop, contains: () => false }, style: { setProperty: noop }, setAttribute: noop, addEventListener: noop, children: [], firstElementChild: null, querySelector: () => null, querySelectorAll: () => [], dataset: {} });
const toasts = [];
const textOf = (e) => (typeof e === 'string' ? e : (e?.kids || []).map(textOf).join(''));
const toastRoot = { children: [], firstElementChild: null, append: (e) => toasts.push(textOf(e)) };
globalThis.Node = class {};
globalThis.window = globalThis;
globalThis.addEventListener = noop;
globalThis.matchMedia = () => ({ matches: false, addEventListener: noop });
globalThis.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) };
globalThis.document = { getElementById: (id) => (id === 'toasts' ? toastRoot : null), querySelector: () => null, querySelectorAll: () => [], addEventListener: noop, createElement: el, createElementNS: el, createDocumentFragment: el, body: el(), documentElement: el(), hidden: false };
globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
globalThis.location = { origin: 'http://127.0.0.1:47123', href: 'http://127.0.0.1:47123/' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, name, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);
  if (!ok) failures++;
};

// ---- the fake app ----
const calls = [];
let nativeState = JSON.stringify({ type: 'state', playing: false, queueId: null });
let nativeQueue = null; // what getQueue answers
let getQueueFails = 0; // that many getQueue calls answer nothing (a bridge call that failed)
let update = { state: 'available', versionName: '2.1.0', progress: 0 };
globalThis.MPfyNative = new Proxy(
  {},
  {
    get: (_, name) => (...args) => {
      calls.push({ name, args });
      if (name === 'bridgeVersion') return '4';
      if (name === 'getState') return nativeState;
      if (name === 'getQueue' && getQueueFails > 0) {
        getQueueFails--;
        return undefined;
      }
      if (name === 'getQueue') return nativeQueue ? JSON.stringify(nativeQueue) : JSON.stringify({ queueId: null, index: 0, positionMs: 0, items: [] });
      if (name === 'getNetwork') return JSON.stringify({ type: 'wifi', metered: false });
      if (name === 'getUpdate') return JSON.stringify(update);
      if (name === 'listDownloads') return JSON.stringify({ ids: [], progress: {}, items: [] });
      if (name === 'getStorage') return JSON.stringify({ downloadsBytes: 0, downloadsCount: 0, cacheBytes: 0 });
      return undefined;
    },
  }
);
const count = (name) => calls.filter((c) => c.name === name).length;
const last = (name) => [...calls].reverse().find((c) => c.name === name);
const lastQueue = () => JSON.parse(last('setQueue').args[0]);
const lastLiked = () => (last('setLiked') ? JSON.parse(last('setLiked').args[0]) : null);
const native = (m) => window.__mpfyNative(JSON.stringify(m));
const state = (s) => native({ type: 'state', buffering: false, durationMs: 200000, repeat: 'off', ...s });

// ---- the fake client core ----
const A = 'aaaa1111'; // Mi A2: principal, owner
const B = 'bbbb2222'; // VPS: member
const rnd32 = (seed) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
};
const rawOf = (rec, shift = 0) => {
  const r = rnd32(rec);
  const base = Array.from({ length: 900 }, () => r());
  return Uint32Array.from({ length: 900 }, (_, j) => (j >= shift ? base[j - shift] : 12345));
};
const b64 = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
const sig = (raw, d) => ({ d, b: 32, s: b64(raw.slice(32, 96)) });
const tr = (id, title, artist, album, trackNo, year, extra = {}) => ({ id, fileHash: id, title, artist, albumArtist: artist, album, trackNo, discNo: 1, year, duration: 200, bitrate: 256000, codec: 'aac', coverId: `c${album.toLowerCase()}000000000000000000`.slice(0, 24), addedAt: 1000, ...extra });
const libOf = {
  [A]: [
    tr('a1', 'Uno', 'NEA', 'Rotte', 2, 2020),
    tr('a0', 'Zero', 'NEA', 'Rotte', 1, 2020),
    tr('a2', 'Due', 'NEA', 'Rotte', 3, 2020),
    tr('n9', 'Nove', 'NEA', 'Prima', 1, 2018),
    // The same recording as the VPS's s5, another file: two items later there.
    tr('s5', 'Cinque', 'Alfa', 'Zeta', 2, 2022, { fileHash: 'fa5', codec: 'mp3', bitrate: 320000, fp: sig(rawOf(5), 200) }),
  ],
  [B]: [
    tr('b0', 'Bi', 'Alfa', 'Zeta', 1, 2022),
    tr('b5', 'Cinque', 'Alfa', 'Zeta', 2, 2022, { fileHash: 'fb5', codec: 'flac', lossless: true, bitDepth: 16, sampleRate: 44100, fp: sig(rawOf(5, 2), 200.2) }),
    tr('b7', 'Sette', 'Beta', 'Alba', 1, 2019),
  ],
};
// A custom cover of the album Alba on the VPS: its large and small images have their own ids.
const ALBA_L = 'a1b2c3d4e5f6a1b2c3d4e5f6';
const ALBA_S = 'f6e5d4c3b2a1f6e5d4c3b2a1';
let alA = null; // Alba's album id, set below
const coversOf = (id) => ({ track: {}, album: id === B ? { [alA]: { large: ALBA_L, small: ALBA_S } } : {}, playlist: {} });
const user = {
  [A]: { playlists: [{ id: 'p1', name: 'Auto', description: '', trackIds: ['b7', 'a0', 'zz'], createdAt: 1 }], likes: [{ id: 'a1', at: 100 }, { id: 's5', at: 200 }], recents: [] },
  [B]: { playlists: [], likes: [], recents: [] },
};
const ver = { [A]: 1, [B]: 1 };
const uver = { [A]: 1, [B]: 1 };
const details = { [A]: true, [B]: true };
const srcState = {
  [A]: { id: A, name: 'Mi A2', principal: true, connected: true, rttMs: 120, throughputKbps: 3000, lastError: null, addedAt: 1, role: 'owner', named: true, profiles: true },
  [B]: { id: B, name: 'VPS', principal: false, connected: true, rttMs: 40, throughputKbps: null, lastError: null, addedAt: 2, role: 'member', named: true, profiles: true },
};
const requests = []; // [method, path, body]
let patchStatus = 200;
let patchName = null; // the name the source answers a PATCH with (renamed elsewhere meanwhile)
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const method = (init.method || 'GET').toUpperCase();
  const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...extra } });
  if (u === '/local/sources') return json({ sources: Object.values(srcState) });
  const m = /^\/s\/([^/]+)\/api(\/[^?]*)(\?.*)?$/.exec(u);
  if (!m) return json({});
  const [, id, p, q = ''] = m;
  if (!srcState[id]) return json({ error: 'x' }, 404);
  if (!srcState[id].connected) return json({ error: 'x' }, 503);
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
  if (method !== 'GET') requests.push([method, `/s/${id}/api${p}`, body]);
  const ud = user[id];
  if (p === '/library') {
    const have = Number(new URLSearchParams(q).get('have'));
    const fresh = have === ver[id];
    const source = { name: srcState[id].name, named: true };
    if (details[id] !== undefined) source.details = details[id];
    return json({ version: ver[id], userVersion: uver[id], tracks: fresh ? null : libOf[id], playlists: ud.playlists, likes: ud.likes, recents: ud.recents, covers: coversOf(id), you: { profileId: 'me', role: srcState[id].role }, source }, 200, { ETag: `W/"me.${ver[id]}.${uver[id]}.${details[id]}"` });
  }
  if (p === '/admin/source' && method === 'PATCH') {
    if (patchStatus !== 200) return json({ error: 'x', code: 'internal' }, patchStatus);
    if (typeof body.details === 'boolean') details[id] = body.details;
    return json({ source: { name: patchName || srcState[id].name, named: true, details: details[id] } });
  }
  const lk = /^\/likes\/([^/]+)$/.exec(p);
  if (lk && method === 'PUT') {
    if (!ud.likes.some((l) => l.id === lk[1])) ud.likes.push({ id: lk[1], at: Date.now() });
    uver[id]++;
    return json({ likes: ud.likes });
  }
  if (lk && method === 'DELETE') {
    ud.likes = ud.likes.filter((l) => l.id !== lk[1]);
    uver[id]++;
    return json({ likes: ud.likes });
  }
  if (p === '/played') {
    uver[id]++;
    return json({ ok: true });
  }
  if (p === '/health') return json({ ok: true });
  return json({});
};

const imp = (p) => import(pathToFileURL(path.join(web, p)).href);
const { sources } = await imp('js/sources.js');
const { store } = await imp('js/store.js');
const { player } = await imp('js/player.js');
const { quality } = await imp('js/quality.js');
const { downloads } = await imp('js/downloads.js');
const { updates, ringOffset, RING } = await imp('js/updates.js');
const { heart } = await imp('js/heart.js');
const { browse, buildSnapshot, snapshotTexts, MAX_TRACKS, MAX_BYTES } = await imp('js/browse.js');
const { offsetMs } = await imp('js/songs.js');
const { hashId } = await imp('js/util.js');

// A refresh already on its way when the data changed is followed by another: wait for both.
const settle = async () => {
  await store.refresh();
  await sleep(150);
  await store.refresh();
};
// Album ids as the store makes them (album artist and album), known before the library is here.
const albumId = (artist, album) => hashId(`${artist}${String.fromCharCode(0)}${album}`);
const alR = albumId('NEA', 'Rotte');
const alZ = albumId('Alfa', 'Zeta');
alA = albumId('Beta', 'Alba');

// ===== the page loaded again while the app plays a list it took over earlier =====
// (a process of its own: run by the main one below)
if (process.argv.includes('--reload')) {
  const ctx = { k: 'album', id: alZ };
  localStorage.setItem('mpfy.player.v1', JSON.stringify({ items: [{ id: 'b0', ci: 0, c: ctx }, { id: 's5', ci: 1, c: ctx }], index: 1, context: { type: 'album', id: alZ, name: 'Zeta' }, ctxIds: ['b0', 's5'], lastCi: 1, shuffle: false, repeat: 'off', position: 50, volume: 1, queueId: 'n0a1b2c3d4e5f607', adoptedId: 'n0a1b2c3d4e5f607' }));
  nativeState = JSON.stringify({ type: 'state', index: 1, playing: true, positionMs: 51000, queueId: 'n0a1b2c3d4e5f607' });
  quality.init();
  const first = sources.refresh();
  downloads.init();
  updates.init();
  player.init();
  heart.init();
  browse.init();
  await first;
  await store.init();
  await sleep(1300);
  const st = player.state;
  check(count('getQueue') === 0 && st.queueId === 'n0a1b2c3d4e5f607' && st.items.map((x) => x.id).join(',') === 'b0,s5' && st.index === 1, 'loaded again: the list taken over before is the one the app plays, nothing asked', JSON.stringify({ getQueue: count('getQueue'), id: st.queueId, index: st.index }));
  check(count('setQueue') === 0, 'loaded again: the sources and the library arrive, still no setQueue', `setQueue ${count('setQueue')}`);
  player.addToQueue(['a0']);
  check(count('setQueue') === 1 && lastQueue().queueId === 'n0a1b2c3d4e5f607', 'an edit after that: setQueue with its n... id');
  console.log(`failures=${failures}`);
  process.exit(failures ? 1 : 0);
}

// ===== a queue the app holds at start (the car set it while the page was closed) =====
nativeQueue = { queueId: 'n0a1b2c3d4e5f607', index: 1, positionMs: 42000, items: [
  { id: 'b0', title: 'Bi', artist: 'Alfa', album: 'Zeta', durationMs: 200000, ctx: { k: 'album', id: alZ } },
  { id: 's5', title: 'Cinque', artist: 'Alfa', album: 'Zeta', durationMs: 200000, ctx: { k: 'album', id: alZ } },
] };
nativeState = JSON.stringify({ type: 'state', index: 1, playing: true, positionMs: 41500, queueId: 'n0a1b2c3d4e5f607' });
// In the order the page starts: the player takes the list over before the source list and the
// library are here.
quality.init();
const sourcesFirst = sources.refresh();
downloads.init();
updates.init();
player.init();
heart.init();
browse.init();
{
  const st = player.state;
  check(count('getQueue') === 1 && count('setQueue') === 0, 'at start, an n... queueId: the page asks getQueue once and sends no setQueue', `getQueue ${count('getQueue')}, setQueue ${count('setQueue')}`);
  check(st.items.map((x) => x.id).join(',') === 'b0,s5' && st.index === 1 && Math.abs(st.position - 42) < 0.01 && st.playing === true, 'the list taken over: its items by id, its index, its position, playing', JSON.stringify({ ids: st.items.map((x) => x.id), index: st.index, pos: st.position, playing: st.playing }));
  check(st.context?.type === 'album' && st.context.id === alZ && st.queueId === 'n0a1b2c3d4e5f607', 'its context from the items\' ctx, its id kept', JSON.stringify(st.context));
}
await sourcesFirst;
await store.init();
await sleep(1300); // a source coming makes the player look at the next items again after 1 s
check(store.d.albumOf.get('a0') === alR && store.d.albumOf.get('b0') === alZ && store.d.albumOf.get('b7') === alA, 'album ids as the store makes them');
check(count('setQueue') === 0, 'the sources and the library arrive after the list was taken over: still no setQueue', `setQueue ${count('setQueue')}`);
check(calls.some((c) => c.name === 'setLiked' && JSON.parse(c.args[0]).id === 's5' && JSON.parse(c.args[0]).liked === true), 'a liked song of that list, known once the library is here: setLiked', JSON.stringify(calls.filter((c) => c.name === 'setLiked').map((c) => c.args[0])));
state({ index: 1, playing: true, positionMs: 43000, queueId: 'n0a1b2c3d4e5f607' });
check(count('getQueue') === 1, 'the same n... id again: no second getQueue');

// Its later edits carry that id.
player.addToQueue(['a0']);
let sq = lastQueue();
check(count('setQueue') === 1 && sq.queueId === 'n0a1b2c3d4e5f607' && sq.index === 1 && sq.items[1].id === 's5', 'an edit of the list taken over: setQueue with its n... id, the song playing at its index', JSON.stringify({ q: sq.queueId, index: sq.index }));
check(sq.items[0].ctx?.k === 'album' && sq.items[0].ctx.id === alZ && sq.items[2].ctx === null, 'the app\'s own contexts go back unchanged, a song queued by hand has none', JSON.stringify(sq.items.map((x) => x.ctx)));
state({ index: 1, playing: false, positionMs: 44000, queueId: 'n0a1b2c3d4e5f607' });

// ===== the page's own queues =====
player.clearQueue(); // the song queued by hand above would follow into the next list
const ctxAlbum = { type: 'album', id: alR, name: 'Rotte' };
player.playContext(ctxAlbum, store.d.albums.get(alR).trackIds, 0);
sq = lastQueue();
const own1 = sq.queueId;
check(/^[0-9a-f]{16}$/.test(own1), 'a list made by the page: a queueId of 16 hex', own1);
const it0 = sq.items[0];
check(it0.id === 'a0' && it0.albumArtist === 'NEA' && it0.trackNo === 1 && it0.liked === false && Array.isArray(it0.likedIds) && it0.likedIds.length === 0, 'items carry albumArtist, trackNo, liked and likedIds', JSON.stringify({ id: it0.id, aa: it0.albumArtist, n: it0.trackNo, liked: it0.liked, ids: it0.likedIds }));
const it1 = sq.items.find((x) => x.id === 'a1');
check(it1.liked === true && it1.likedIds.join() === 'a1', 'a liked song: liked true, likedIds its liked trackIds', JSON.stringify({ liked: it1.liked, ids: it1.likedIds }));
check(sq.items.every((x) => x.ctx && x.ctx.k === 'album' && x.ctx.id === alR), 'items carry their context as { k, id }', JSON.stringify(sq.items[0].ctx));
state({ index: 0, playing: true, positionMs: 1000, queueId: own1 });
player.addToQueue(['b0']);
sq = lastQueue();
check(sq.queueId === own1, 'the same list edited (a song queued): the same queueId', sq.queueId);
check(sq.items.find((x) => x.id === 'b0').ctx === null, 'a song queued by hand: ctx null');
player.setShuffle(true);
check(lastQueue().queueId === own1, 'the same list shuffled: the same queueId');
player.setShuffle(false);
player.clearQueue();
const ctxLib = { type: 'library', id: null, name: 'Aggiunti di recente' };
player.playContext(ctxLib, ['b0', 'a2'], 0);
sq = lastQueue();
const own2 = sq.queueId;
check(own2 !== own1 && /^[0-9a-f]{16}$/.test(own2), 'a new list: a new queueId', `${own1} -> ${own2}`);
check(sq.items.every((x) => x.ctx && x.ctx.k === 'library' && x.ctx.id === null), 'a library context is kept: { k: library, id: null }', JSON.stringify(sq.items[0].ctx));

// A late state with the page's previous id: no getQueue.
let nq = count('getQueue');
state({ index: 0, playing: true, positionMs: 1200, queueId: own1 });
state({ index: 0, playing: true, positionMs: 1300, queueId: own2 });
check(count('getQueue') === nq, 'a state with the page\'s previous id after its setQueue: no getQueue');
state({ index: 0, playing: false, positionMs: 0, queueId: null });
check(count('getQueue') === nq && player.state.items.length === 2, 'queueId null (an empty player): no getQueue, the queue left alone');

// ===== the car sets a queue while the page is open =====
nativeQueue = { queueId: 'n111111111111111', index: 0, positionMs: 0, items: [
  { id: 'a1', title: 'Uno', artist: 'NEA', album: 'Rotte', durationMs: 200000, ctx: { k: 'liked', id: null } },
  { id: 's5', title: 'Cinque', artist: 'Alfa', album: 'Zeta', durationMs: 200000, ctx: { k: 'liked', id: null } },
] };
let nsq = count('setQueue');
state({ index: 0, playing: true, positionMs: 300, queueId: 'n111111111111111' });
check(count('getQueue') === nq + 1 && count('setQueue') === nsq, 'a new n... id: getQueue, and the list taken over without setQueue');
check(player.state.items.map((x) => x.id).join(',') === 'a1,s5' && player.state.context?.type === 'liked' && player.state.context.id === null, 'the car\'s liked list, its context liked', JSON.stringify(player.state.context));
state({ index: 0, playing: true, positionMs: 800, queueId: 'n111111111111111' });
check(count('getQueue') === nq + 1, 'an id already taken over: no getQueue');
// A tick of the page's own older list after the car's: never undoes it.
state({ index: 0, playing: true, positionMs: 900, queueId: own2 });
check(count('getQueue') === nq + 1 && player.state.items.map((x) => x.id).join(',') === 'a1,s5', 'a stale tick with the page\'s own id: nothing taken over, the car\'s list stays');
// The getQueue answer is newer than the state that asked: that one is taken, and the old id is
// not asked again.
nativeQueue = { ...nativeQueue, queueId: 'n333333333333333' };
state({ index: 0, playing: true, positionMs: 1000, queueId: 'n222222222222222' });
check(player.state.queueId === 'n333333333333333', 'getQueue answers a newer list than the state that asked: that one is taken', player.state.queueId);
nq = count('getQueue');
state({ index: 0, playing: true, positionMs: 1100, queueId: 'n222222222222222' });
state({ index: 0, playing: true, positionMs: 1200, queueId: 'n333333333333333' });
check(count('getQueue') === nq, 'neither the id that asked nor the one taken over asks again');
// getQueue answers nothing once (a bridge call that failed): the next report asks again.
nativeQueue = { ...nativeQueue, queueId: 'n444444444444444' };
getQueueFails = 1;
state({ index: 0, playing: true, positionMs: 1300, queueId: 'n444444444444444' });
check(count('getQueue') === nq + 1 && player.state.queueId === 'n333333333333333', 'getQueue answers nothing: no list taken over', player.state.queueId);
state({ index: 0, playing: true, positionMs: 1400, queueId: 'n444444444444444' });
check(count('getQueue') === nq + 2 && player.state.queueId === 'n444444444444444', 'the next report with that id asks again, and the list is taken over', `getQueue ${count('getQueue') - nq}, ${player.state.queueId}`);
state({ index: 0, playing: false, positionMs: 1400, queueId: 'n444444444444444' });

// ===== the heart =====
await sleep(50);
let nl = count('setLiked');
await store.like('a2');
let lk = lastLiked();
check(count('setLiked') === nl + 1 && lk?.id === 'a2' && lk.liked === true && lk.likedIds.join() === 'a2', 'a like on the page: setLiked { id, liked: true, likedIds }', JSON.stringify(lk));
nl = count('setLiked');
await store.unlike('a2');
lk = lastLiked();
check(count('setLiked') === nl + 1 && lk?.id === 'a2' && lk.liked === false && lk.likedIds.length === 0, 'an unlike on the page: setLiked { liked: false, likedIds: [] }', JSON.stringify(lk));
// A like made on another device arrives with the library.
user[A].likes.push({ id: 'b0', at: 300 });
uver[A]++;
nl = count('setLiked');
await store.refresh();
lk = lastLiked();
check(count('setLiked') === nl + 1 && lk?.id === 'b0' && lk.liked === true, 'a like made elsewhere, seen at a refresh: setLiked too', JSON.stringify(lk));
// A song liked as two versions: unlike from the car takes both away.
user[A].likes.push({ id: 'b5', at: 250 });
uver[A]++;
await store.refresh();
const s5 = store.gid('b5');
check(JSON.stringify(store.likedGroups().get(s5)) === JSON.stringify(['b5', 's5']), 'likedIds of a song liked as two versions: both, newest first', JSON.stringify(store.likedGroups().get(s5)));
// What the app's heart unlikes, one DELETE per id: the queue item carries both.
player.playContext({ type: 'album', id: alZ, name: 'Zeta' }, store.d.albums.get(alZ).trackIds, 0);
const q5 = lastQueue().items.find((x) => store.gid(x.id) === s5);
check(!!q5 && q5.liked === true && JSON.stringify(q5.likedIds) === JSON.stringify(['b5', 's5']), 'a queue item of a song liked as two versions: likedIds both, newest first', JSON.stringify(q5 && { liked: q5.liked, ids: q5.likedIds }));
// The app liked or unliked by itself: applied without a request.
const nReq = requests.filter(([m]) => m !== 'POST').length;
native({ type: 'liked', id: 'a0', liked: true, likedIds: ['a0'], ok: true });
check(store.isLiked('a0') && requests.filter(([m]) => m !== 'POST').length === nReq, 'a liked event ok: the store shows it at once, with no request', String(store.isLiked('a0')));
native({ type: 'liked', id: s5, liked: false, likedIds: [], ok: true });
check(!store.isLiked(s5) && !store.libOf(A).likes.some((x) => x.id === 'b5' || x.id === 's5'), 'an unlike event ok: every liked version of the song goes', JSON.stringify(store.libOf(A).likes.map((x) => x.id)));
const nT = toasts.length;
native({ type: 'liked', id: 'a2', liked: false, likedIds: [], ok: false });
check(toasts.length === nT + 1 && toasts[toasts.length - 1] === 'Mi piace non salvato', 'a like that failed in the app: "Mi piace non salvato"', toasts[toasts.length - 1]);
native({ type: 'liked', id: 'a1', liked: true, likedIds: ['a1'], ok: false });
check(toasts[toasts.length - 1] === 'Mi piace non rimosso' && store.isLiked('a1'), 'an unlike that failed in the app: "Mi piace non rimosso", still liked', toasts[toasts.length - 1]);
await sleep(600);
// The library came back from the principal: the app's like is there (the fake core never got a
// request, so it puts the server's state back: the like goes, and the app is told).
user[A].likes.push({ id: 'a0', at: Date.now() });
uver[A]++;
await store.refresh();
check(store.isLiked('a0'), 'after the refresh the app\'s like is still shown');

// ===== the car's snapshot =====
// One send at start (2 s after the library), nothing more while nothing changes.
await sleep(2300);
const nS = count('setBrowseSnapshot');
check(nS >= 1, 'the snapshot is sent once the library is here', String(nS));
let snap = JSON.parse(last('setBrowseSnapshot').args[0]);
const keys = Object.keys(snap).join(',');
check(keys === 'format,v,at,quality,tracks,albums,artists,playlists,liked,recent' && snap.format === 'mpfy-browse' && snap.v === 1 && Number.isFinite(snap.at), 'shape: format, v, at, quality, tracks, albums, artists, playlists, liked, recent', keys);
check(JSON.stringify(snap.quality) === '{"wifi":"max","cellular":"high"}', 'quality: Automatica as Wi-Fi max and mobile data high', JSON.stringify(snap.quality));
const tA0 = snap.tracks.find((t) => t.id === 'a0');
check(tA0 && tA0.t === 'Zero' && tA0.a === 'NEA' && tA0.aa === 'NEA' && tA0.al === alR && tA0.n === 1 && tA0.d === 200000 && JSON.stringify(Object.keys(tA0)) === '["id","t","a","aa","al","n","d","art","v"]', 'a track: id, t, a, aa, al, n, d, art, v', JSON.stringify(tA0));
check(snap.tracks.length === store.lib.tracks.length, 'every song is there', `${snap.tracks.length} of ${store.lib.tracks.length}`);
// art: [the first source with the large image, large id, small id]
const crotte = 'crotte000000000000000000';
const artOf = (list, pick) => JSON.stringify(list.find(pick)?.art);
check(JSON.stringify(tA0.art) === JSON.stringify([A, crotte, crotte]), 'art of a track with an embedded cover: its source, the cover id twice', JSON.stringify(tA0.art));
check(artOf(snap.albums, (x) => x.n === 'Rotte') === JSON.stringify([A, crotte, crotte]), 'art of an album with an embedded cover', artOf(snap.albums, (x) => x.n === 'Rotte'));
check(artOf(snap.albums, (x) => x.n === 'Alba') === JSON.stringify([B, ALBA_L, ALBA_S]), 'art of an album with a custom cover on the VPS: the VPS, the large id, the small id', artOf(snap.albums, (x) => x.n === 'Alba'));
check(artOf(snap.tracks, (x) => x.id === 'b7') === JSON.stringify([B, ALBA_L, ALBA_S]), 'its track takes the album cover', artOf(snap.tracks, (x) => x.id === 'b7'));
check(artOf(snap.artists, (x) => x.n === 'NEA') === JSON.stringify([A, crotte, crotte]), 'art of an artist: the cover of its newest album', artOf(snap.artists, (x) => x.n === 'NEA'));
check(JSON.stringify(snap.playlists[0]?.art) === JSON.stringify([B, ALBA_L, ALBA_S]), 'art of a playlist with no cover of its own: its first song\'s', JSON.stringify(snap.playlists[0]?.art));
check(snap.albums.map((x) => x.n).join(',') === 'Alba,Prima,Rotte,Zeta', 'albums by name', snap.albums.map((x) => x.n).join(','));
check(snap.albums.find((x) => x.n === 'Rotte').tr.join(',') === 'a0,a1,a2' && snap.albums.find((x) => x.n === 'Rotte').y === 2020 && snap.albums.find((x) => x.n === 'Rotte').a === 'NEA', 'an album: its tracks in track order, its year and artist', JSON.stringify(snap.albums.find((x) => x.n === 'Rotte')));
check(snap.artists.map((x) => x.n).join(',') === 'Alfa,Beta,NEA', 'artists by name', snap.artists.map((x) => x.n).join(','));
check(snap.artists.find((x) => x.n === 'NEA').tr.join(',') === 'a0,a1,a2,n9', 'an artist: its albums newest first, then track order', snap.artists.find((x) => x.n === 'NEA').tr.join(','));
check(snap.playlists.length === 1 && snap.playlists[0].n === 'Auto' && snap.playlists[0].tr.join(',') === 'b7,a0', 'a playlist: in its own order, songs the library does not know left out', JSON.stringify(snap.playlists[0]));
check(snap.liked.map((x) => x.id).join(',') === store.d.likedIds.join(',') && snap.liked[0].id === 'a0', 'liked: newest first', snap.liked.map((x) => x.id).join(','));
check(snap.liked.find((x) => x.id === 'a1').ids.join() === 'a1', 'liked: each with its liked trackIds');
check(JSON.stringify(snap.liked.find((x) => x.id === store.gid('s5'))?.ids) === JSON.stringify(['b5', 's5']), 'liked: a song liked as two versions has both ids, newest first', JSON.stringify(snap.liked.find((x) => x.id === store.gid('s5'))));
const s5t = snap.tracks.find((t) => t.id === store.gid('s5'));
check(s5t && s5t.v.length === 2 && s5t.v.map((v) => v.s).sort().join() === [A, B].sort().join(), 'a song on both sources: both versions in v', JSON.stringify(s5t?.v));
const first5 = s5t.v[0];
const other5 = s5t.v[1];
check(first5.o === 0 && Math.abs(other5.o) === offsetMs(2), 'the other file\'s offset from the signatures (2 items: 248 ms)', JSON.stringify(s5t.v));
// recent: the Home contexts (none played yet: liked, the playlist, then the newest albums)
check(snap.recent[0].k === 'liked' && snap.recent[0].id === '' && snap.recent[1].k === 'playlist' && snap.recent[1].id === 'p1', 'recent: the Home contexts, liked with an empty id', JSON.stringify(snap.recent.slice(0, 3)));

// A play: the album goes first in recent, the snapshot is sent once, 2 s after the last change.
user[A].recents.push({ trackId: 'b7', context: { type: 'album', id: store.d.albumOf.get('b7') }, at: Date.now() });
uver[A]++;
let n0 = count('setBrowseSnapshot');
await store.refresh();
await sleep(800);
user[A].recents.push({ trackId: 'a0', context: { type: 'album', id: alR }, at: Date.now() + 1 });
uver[A]++;
await store.refresh();
await sleep(1000);
check(count('setBrowseSnapshot') === n0, 'changes 0.8 s apart: nothing sent before 2 s of quiet');
await sleep(1400);
check(count('setBrowseSnapshot') === n0 + 1, 'then sent once', String(count('setBrowseSnapshot') - n0));
snap = JSON.parse(last('setBrowseSnapshot').args[0]);
check(snap.recent[0].k === 'album' && snap.recent[0].id === alR && snap.recent[1].id === store.d.albumOf.get('b7'), 'recent: the albums just played first', JSON.stringify(snap.recent.slice(0, 2)));
// A refresh that changes nothing the snapshot holds: built again, differs only in at, not sent.
n0 = count('setBrowseSnapshot');
uver[A]++;
await store.refresh();
await sleep(2300);
check(count('setBrowseSnapshot') === n0, 'a change that leaves the snapshot the same: not sent again (it differs only in at)');
const t1 = snapshotTexts(1);
const t2 = snapshotTexts(2);
check(t1.key === t2.key && t1.text !== t2.text && JSON.parse(t1.text).at === 1, 'two builds differing only in at: the same text to compare, at only in the text sent');
// The quality settings: a fixed choice goes as it is.
n0 = count('setBrowseSnapshot');
quality.set('wifi', 'normal');
quality.set('cellular', 'low');
await sleep(2300);
snap = JSON.parse(last('setBrowseSnapshot').args[0]);
check(count('setBrowseSnapshot') === n0 + 1 && JSON.stringify(snap.quality) === '{"wifi":"normal","cellular":"low"}', 'quality: a fixed choice goes as it is', JSON.stringify(snap.quality));
quality.set('wifi', 'auto');
quality.set('cellular', 'auto');
// The VPS offline: its versions stay, after the playable one.
srcState[B].connected = false;
await sources.refresh();
await sleep(2300);
snap = JSON.parse(last('setBrowseSnapshot').args[0]);
const s5off = snap.tracks.find((t) => t.id === store.gid('s5'));
const b0off = snap.tracks.find((t) => t.id === 'b0');
check(s5off.v.length === 2 && s5off.v[0].s === A && s5off.v[1].s === B, 'the VPS offline: its version stays in v, after the one playable now', JSON.stringify(s5off.v));
check(b0off && b0off.v.length === 1 && b0off.v[0].s === B && b0off.v[0].tr === 'b0', 'a song only on the disconnected VPS is still there, with its version', JSON.stringify(b0off?.v));
srcState[B].connected = true;
await sources.refresh();
// The caps: 20000 songs, 4 MB.
check(MAX_TRACKS === 20000 && MAX_BYTES === 4 * 1024 * 1024, 'the caps: 20000 songs, 4 MB');
const small = buildSnapshot(2);
check(small.tracks.length === 2 && small.albums.every((al) => al.tr.every((id) => small.tracks.some((t) => t.id === id))), 'cut at a limit: the rest left out everywhere', JSON.stringify(small.albums.map((x) => x.tr)));
{
  const big = Array.from({ length: 20001 }, (_, i) => ({ id: `x${i.toString(16).padStart(6, '0')}`, fileHash: `x${i}`, title: 'T', artist: 'A', album: 'L', trackNo: 1, duration: 100, codec: 'mp3', bitrate: 128000 }));
  const saved = libOf[A];
  libOf[A] = big;
  ver[A]++;
  await settle();
  const r = snapshotTexts();
  check(store.lib.tracks.length > 20000 && r.tracks === 20000 && r.bytes <= MAX_BYTES, 'a library of more than 20000 songs: 20000 in the snapshot, under 4 MB', `${store.lib.tracks.length} songs, ${r.tracks} sent, ${r.bytes} bytes`);
  libOf[A] = big.slice(0, 3000).map((t) => ({ ...t, title: 'T'.repeat(1600) }));
  ver[A]++;
  await settle();
  const r2 = snapshotTexts();
  check(r2.bytes <= MAX_BYTES && r2.tracks > 0 && r2.tracks < 3000, 'long titles past 4 MB: fewer songs, under 4 MB', `${r2.tracks} songs, ${r2.bytes} bytes`);
  libOf[A] = saved;
  ver[A]++;
  await settle();
}

// ===== "Cerca i dettagli in rete" =====
await sleep(200);
check(store.libOf(A).source?.details === true, 'the library keeps source.details', JSON.stringify(store.libOf(A).source));
details[B] = 'yes';
ver[B]++;
await store.refresh();
check(store.libOf(B).source?.details === null, 'a details that is not a boolean: null');
details[B] = undefined;
ver[B]++;
await store.refresh();
check(store.libOf(B).source?.details === null, 'a source that does not say (older): null');
// The source answers with its name of now (renamed elsewhere meanwhile): what it answers shows.
patchName = 'Mi A2 di casa';
const p = store.setSourceDetails(A, false);
check(store.libOf(A).source.details === false && store.libOf(A).source.name === 'Mi A2', 'the switch: shown at once');
check(await p, 'and the source took it');
const patch = requests.filter(([m, u]) => m === 'PATCH' && u === `/s/${A}/api/admin/source`).pop();
check(JSON.stringify(patch?.[2]) === '{"details":false}', 'the PATCH body: { details: false }', JSON.stringify(patch?.[2]));
check(store.libOf(A).source.details === false && store.libOf(A).source.name === 'Mi A2 di casa', 'the answer\'s source applied', JSON.stringify(store.libOf(A).source));
patchName = null;
await sleep(500);
patchStatus = 500;
const nT2 = toasts.length;
const p2 = store.setSourceDetails(A, true);
check(store.libOf(A).source.details === true, 'turned on again: shown at once');
check((await p2) === false && store.libOf(A).source.details === false, 'the source refuses: the old state is back');
check(toasts.length === nT2 + 1 && toasts[toasts.length - 1] === 'Qualcosa non ha funzionato', 'and "Qualcosa non ha funzionato"', toasts[toasts.length - 1]);
patchStatus = 200;
// A second tap before the first answer: the first answer never turns the switch back.
{
  const seen = [];
  const off = store.subscribe(() => seen.push(store.libOf(A).source.details));
  const t1 = store.setSourceDetails(A, true);
  const t2 = store.setSourceDetails(A, false);
  await Promise.all([t1, t2]);
  off();
  const after = seen.slice(seen.indexOf(false));
  check(seen[0] === true && after.length > 0 && after.every((x) => x === false) && store.libOf(A).source.details === false, 'two taps before the first answer: on, then off, and off it stays', JSON.stringify(seen));
}
await sleep(500);

// ===== updates =====
check(updates.state.state === 'available' && updates.state.versionName === '2.1.0', 'the update state at start (getUpdate)', JSON.stringify(updates.state));
updates.start();
check(count('startUpdate') === 1, 'available: a tap starts it');
native({ type: 'update', state: 'downloading', versionName: '2.1.0', progress: 0.42 });
check(updates.state.state === 'downloading' && updates.state.progress === 0.42, 'downloading 0.42 from the event');
updates.start();
native({ type: 'update', state: 'installing', versionName: '2.1.0', progress: 1 });
updates.start();
check(count('startUpdate') === 1, 'downloading or installing: a tap does nothing');
const nT3 = toasts.length;
native({ type: 'update', state: 'available', versionName: '2.1.0', progress: 0, failed: true });
check(updates.state.state === 'available' && toasts.length === nT3 + 1 && toasts[toasts.length - 1] === 'Aggiornamento non riuscito', 'a failure: back to available, "Aggiornamento non riuscito"', toasts[toasts.length - 1]);
native({ type: 'update', state: 'none', versionName: '', progress: 0 });
check(updates.state.state === 'none', 'none from the event');
check(RING === 57.81 && ringOffset(0) === 57.81 && ringOffset(0.42) === 33.53 && ringOffset(1) === 0, 'ring offsets: 57.81, 33.53, 0 for 0, 0.42, 1', [ringOffset(0), ringOffset(0.42), ringOffset(1)].join());

// ===== a song whose id moves =====
// The VPS's b7 is queued and liked; then the principal gets the same file, so the song's id
// becomes the principal's a7. The queue item keeps b7, and the app knows it by that id.
player.playContext({ type: 'album', id: alA, name: 'Alba' }, ['b7'], 0);
await store.like('b7');
const toldSince = (mark) => calls.slice(mark).filter((c) => c.name === 'setLiked').map((c) => JSON.parse(c.args[0]));
let mark = calls.length;
libOf[A].push(tr('a7', 'Sette', 'Beta', 'Alba', 1, 2019, { fileHash: 'b7' }));
ver[A]++;
await settle();
let told = toldSince(mark);
check(store.gid('b7') === 'a7' && player.state.items.some((x) => x.id === 'b7'), 'the song is a7 now, the queue item still b7', store.gid('b7'));
check(!told.some((x) => x.id === 'b7' && !x.liked) && told.some((x) => x.id === 'a7' && x.liked), 'its id moved: the new id told liked, the queue item under the old one never told "not liked"', JSON.stringify(told));
mark = calls.length;
await store.unlike('a7');
told = toldSince(mark);
check(told.some((x) => x.id === 'b7' && !x.liked && x.likedIds.length === 0) && told.some((x) => x.id === 'a7' && !x.liked), 'an unlike: told under the new id and under the queue item\'s', JSON.stringify(told));
mark = calls.length;
await store.like('a7');
told = toldSince(mark);
check(told.some((x) => x.id === 'b7' && x.liked && JSON.stringify(x.likedIds) === '["a7"]') && told.some((x) => x.id === 'a7' && x.liked), 'a like again: told under both ids too', JSON.stringify(told));

// The page loaded again, in a process of its own.
{
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), web, '--reload'], { encoding: 'utf8', timeout: 120000 });
  const lines = (r.stdout || '').split('\n').filter((l) => /^(OK|FAIL)/.test(l));
  for (const l of lines) console.log(l);
  failures += lines.filter((l) => l.startsWith('FAIL')).length;
  check(r.status === 0 && lines.length === 3, 'the reload run finished', `exit ${r.status}, ${lines.length} checks${r.stderr ? ', ' + r.stderr.trim().split('\n').pop() : ''}`);
}

console.log(`failures=${failures}`);
process.exit(failures ? 1 : 0);
