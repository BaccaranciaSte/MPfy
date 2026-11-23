// Drives web/js/player.js (and the store, sources, quality and downloads modules) against a fake
// Android bridge (window.MPfyNative, bridge 3), in Node with a minimal DOM stub and a stubbed
// fetch that plays the client core with two sources: the Mi A2 (principal, owned by this person)
// and the VPS (this person is a member there).
//
// Queue checks: stale state reports after setQueue/skipTo are ignored, a native
// "previous" carries the queued block and resyncs, previous from the UI is decided in JS, a native
// error skips via setQueue, an error long after a pause does not autoplay, an edit goes with keep
// and the app's report of the song it kept at another index of the new list is taken at once.
// Sources and quality: stream URLs go to /s/<source>/api/stream/<id>?q=<level> on the connected source with
// the lowest RTT that has the track; a track only on an offline source is not queued; "Automatica"
// on Wi-Fi and on mobile data (getNetwork and the network event); quality in the state event; an
// error with itemId fails over to the other source at the same position, then skips; unrelated
// errors are ignored; __mpfyNative takes an object; downloads carry the quality and ?q=.
// Review fixes (2026-11-17): a cover whose sources are all offline asks only the service
// worker's cache (or nothing); a downloaded track is queued at its downloaded level; a failover
// asks the failing source's health and, when it is down, the next tracks avoid it; the source
// list is still polled while the page is hidden and music plays; downloads are asked only from
// connected sources, a failed one says so and is asked again later; the principal copy skips
// covers it cannot fetch, never overwrites an unrelated playlist of the same name, and refuses
// when nothing is known of the old principal; a removed source leaves its downloaded tracks.
//
// Versions (songs on several sources): the queue items carry their versions in the order to try
// them, with time offsets; the app reports an error only after every version failed, and the
// player then moves on; downloaded versions go first and play with their source offline (or no
// source at all); the merge is not rebuilt after a play or a like (the source answers tracks:
// null); deleting a version moves the person's references to the song's next id, or puts them
// back when that id is the deleted one; a member giving up a claim removes nothing on screen; a
// downloaded file replaced on its source is downloaded again and the old one removed by version;
// what a member may change follows mine and others.
//
// Usage: node web/dev/native-harness.mjs <web dir>   (prints OK/FAIL lines, exit 1 on a failure)
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const web = path.resolve(process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..'));
const noop = () => {};
const ls = new Map();
const el = () => Object.assign(Object.create(Node.prototype), { kids: [], append(...a) { this.kids.push(...a); }, appendChild: noop, remove: noop, classList: { add: noop, remove: noop, toggle: noop, contains: () => false }, style: { setProperty: noop }, setAttribute: noop, addEventListener: noop, children: [], firstElementChild: null, querySelector: () => null, querySelectorAll: () => [], dataset: {} });
// Toasts are captured: the words shown are part of what is checked.
const toasts = [];
const textOf = (e) => (typeof e === 'string' ? e : (e?.kids || []).map(textOf).join(''));
const toastRoot = { children: [], firstElementChild: null, append: (e) => toasts.push(textOf(e)) };
const docListeners = {};
const fire = (type) => (docListeners[type] || []).forEach((f) => f());
globalThis.Node = class {};
globalThis.window = globalThis;
globalThis.addEventListener = noop;
globalThis.matchMedia = () => ({ matches: false, addEventListener: noop });
globalThis.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) };
globalThis.document = { getElementById: (id) => (id === 'toasts' ? toastRoot : null), querySelector: () => null, querySelectorAll: () => [], addEventListener: (t, f) => (docListeners[t] ||= []).push(f), createElement: el, createElementNS: el, createDocumentFragment: el, body: el(), documentElement: el(), hidden: false };
globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
globalThis.location = { origin: 'http://127.0.0.1:47123', href: 'http://127.0.0.1:47123/' };

// ---- the fake bridge ----
const calls = [];
let nativeState = JSON.stringify({ type: 'state', playing: false });
let network = { type: 'wifi', metered: false };
globalThis.MPfyNative = new Proxy(
  {},
  {
    get: (_, name) => (...args) => {
      calls.push({ name, args });
      if (name === 'getState') return nativeState;
      if (name === 'getNetwork') return JSON.stringify(network);
      if (name === 'listDownloads') return JSON.stringify({ ids: [], progress: {}, items: [] });
      if (name === 'bridgeVersion') return '3';
      if (name === 'getStorage') return JSON.stringify({ downloadsBytes: 0, downloadsCount: 0, cacheBytes: 0 });
      return undefined;
    },
  }
);

// ---- the fake client core: two sources ----
const A = 'aaaa1111'; // "Mi A2": principal, slower
const B = 'bbbb2222'; // "VPS": faster
const mk = (i) => ({ id: `t${i}`, title: `T${i}`, artist: 'A', album: 'B', duration: 200, bitrate: 256000, coverId: `cv${i}`, qualities: { low: true, normal: true, high: true } });
const tracks = Array.from({ length: 8 }, (_, i) => mk(i));
// Raw fingerprints: t8 on the VPS is another file of the same recording, 2 items later.
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
const RAW = { fa8: rawOf(8), fb8: rawOf(8, 2) };
const extra = {
  [A]: [
    { ...mk(8), album: 'C', fileHash: 'fa8', codec: 'mp3', bitrate: 320000, fp: sig(RAW.fa8, 200) },
    { ...mk(9), album: 'C', fileHash: 'h9' },
  ],
  [B]: [
    { ...mk(8), album: 'C', fileHash: 'fb8', codec: 'flac', lossless: true, bitDepth: 24, sampleRate: 96000, bitrate: 2400000, fp: sig(RAW.fb8, 200.2) },
    { ...mk(9), id: 'u9', album: 'C', fileHash: 'h9' },
  ],
};
const libOf = { [A]: [...tracks.slice(0, 6), ...extra[A]], [B]: [...tracks.slice(3), ...extra[B]].map((t) => ({ ...t })) }; // t3, t4, t5 on both
// On the VPS this person is a member: t3 is theirs and someone else's, t6, t7 and u9 only theirs.
for (const t of libOf[B]) Object.assign(t, { mine: ['t3', 't6', 't7', 'u9'].includes(t.id), others: !['t6', 't7', 'u9'].includes(t.id) });
const ver = { [A]: 1, [B]: 1 };
const uver = { [A]: 1, [B]: 1 };
const role = { [A]: 'owner', [B]: 'member' };
const legacy = { [A]: false, [B]: false }; // a source of before profiles: no you, no playlist ids
const libCalls = []; // [source, have, fresh]
const fpCalls = [];
let slowDelete = 0; // ms the source takes over a delete
const srcState = {
  [A]: { id: A, name: 'Mi A2', principal: true, connected: true, rttMs: 120, throughputKbps: 3000, lastError: null, addedAt: 1 },
  [B]: { id: B, name: 'VPS', principal: false, connected: true, rttMs: 40, throughputKbps: null, lastError: null, addedAt: 2 },
};
// User data of each source, what /api/health answers, and the covers a source can serve.
const emptyCovers = () => ({ track: {}, album: {}, playlist: {} });
const user = { [A]: { playlists: [], likes: [], covers: emptyCovers() }, [B]: { playlists: [], likes: [], covers: emptyCovers() } };
const healthStatus = { [A]: 200, [B]: 200 };
const coverOk = new Set();
let plSeq = 0;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const method = (init.method || 'GET').toUpperCase();
  const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...extra } });
  if (u === '/local/sources') return json({ sources: Object.values(srcState) });
  const m = /^\/s\/([^/]+)\/api(\/[^?]*)(\?.*)?$/.exec(u);
  if (!m) return json({});
  const [, id, p, q = ''] = m;
  if (!srcState[id]) return json({ error: 'Fonte sconosciuta' }, 404);
  if (!srcState[id].connected) return json({ error: 'Fonte non raggiungibile' }, 503);
  const ud = user[id];
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
  if (p === '/library') {
    const have = Number(new URLSearchParams(q).get('have'));
    const fresh = have === ver[id];
    libCalls.push([id, have, fresh]);
    return json({ version: ver[id], userVersion: uver[id], tracks: fresh ? null : libOf[id], playlists: ud.playlists, likes: ud.likes, recents: [], covers: fresh ? { playlist: ud.covers.playlist } : ud.covers, ...(legacy[id] ? {} : { you: { profileId: 'me', role: role[id] }, source: { name: srcState[id].name, named: true } }) }, 200, { ETag: `W/"me.${ver[id]}.${uver[id]}"` });
  }
  if (p.startsWith('/fingerprint/')) {
    const f = new URLSearchParams(q).get('f');
    fpCalls.push(`${id}:${p.slice(13)}:${f}`);
    return RAW[f] ? json({ trackId: p.slice(13), fileHash: f, d: 200, step: 0.12381, fp: b64(RAW[f]) }) : json({ error: 'x' }, 404);
  }
  const td = /^\/tracks\/([^/]+)$/.exec(p);
  if (td && method === 'DELETE') {
    if (slowDelete) await sleep(slowDelete);
    const t = libOf[id].find((x) => x.id === td[1]);
    if (!t) return json({ error: 'x' }, 404);
    if (role[id] === 'member' && t.others) {
      t.mine = false;
      ver[id]++;
      return json({ ok: true, deleted: false });
    }
    libOf[id] = libOf[id].filter((x) => x !== t);
    // The file goes: it leaves every person's data on that source.
    for (const pl of ud.playlists) pl.trackIds = pl.trackIds.filter((x) => x !== td[1]);
    ud.likes = ud.likes.filter((l) => l.id !== td[1]);
    ver[id]++;
    uver[id]++;
    return json({ ok: true, deleted: true });
  }
  if (p === '/health') return healthStatus[id] === 200 ? json({ ok: true, tracks: libOf[id].length }) : json({ error: 'x' }, healthStatus[id]);
  if (p === '/playlists' && method === 'POST') {
    if (!legacy[id] && body.id && ud.playlists.some((y) => y.id === body.id)) return json({ error: 'x', code: 'playlist_exists' }, 409);
    const pl = { id: (!legacy[id] && body.id) || `pl${++plSeq}`, name: body.name, description: body.description || '', trackIds: [], createdAt: Date.now() };
    ud.playlists.push(pl);
    uver[id]++;
    return json({ playlist: pl });
  }
  const pt = /^\/playlists\/([^/]+)\/tracks$/.exec(p);
  if (pt && method === 'POST') {
    const pl = ud.playlists.find((y) => y.id === pt[1]);
    if (!pl) return json({ error: 'x' }, 404);
    const pos = Number.isInteger(body.position) ? body.position : pl.trackIds.length;
    pl.trackIds.splice(pos, 0, ...body.trackIds);
    uver[id]++;
    return json({ playlist: pl });
  }
  let x = /^\/playlists\/([^/]+)$/.exec(p);
  if (x && method === 'PATCH') {
    const pl = ud.playlists.find((y) => y.id === x[1]);
    if (!pl) return json({ error: 'x' }, 404);
    Object.assign(pl, body);
    uver[id]++;
    return json({ playlist: pl });
  }
  x = /^\/likes\/([^/]+)$/.exec(p);
  if (x && method === 'PUT') {
    if (!ud.likes.some((l) => l.id === x[1])) ud.likes.push({ id: x[1], at: Date.now() });
    uver[id]++;
    return json({ likes: ud.likes });
  }
  if (x && method === 'DELETE') {
    ud.likes = ud.likes.filter((l) => l.id !== x[1]);
    uver[id]++;
    return json({ likes: ud.likes });
  }
  if (p === '/played' && method === 'POST') {
    uver[id]++;
    return json({ ok: true });
  }
  x = /^\/cover-for\/([^/]+)\/([^/]+)$/.exec(p);
  if (x && method === 'PUT') {
    const size = new URLSearchParams(q).get('size');
    ud.covers[x[1]][x[2]] = { ...(ud.covers[x[1]][x[2]] || {}), [size]: `${size}copy${x[2]}` };
    return json({ covers: ud.covers });
  }
  x = /^\/cover\/([^/]+)$/.exec(p);
  if (x) return coverOk.has(x[1]) ? new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200, headers: { 'Content-Type': 'image/jpeg' } }) : json({ error: 'x' }, 404);
  return json({});
};

const imp = (p) => import(pathToFileURL(path.join(web, p)).href);
const { sources } = await imp('js/sources.js');
const { store } = await imp('js/store.js');
const { player } = await imp('js/player.js');
const { quality } = await imp('js/quality.js');
const { downloads } = await imp('js/downloads.js');
const { coverHref } = await imp('js/media.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, name, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);
  if (!ok) failures++;
};
const last = (name) => [...calls].reverse().find((c) => c.name === name);
const count = (name) => calls.filter((c) => c.name === name).length;
const send = (s) => window.__mpfyNative(JSON.stringify({ type: 'state', buffering: false, durationMs: 200000, repeat: 'off', ...s }));
const ids = () => player.state.items.map((x) => x.id + (x.m ? '*' : ''));
const urlOf = (item) => new URL(item.url);
const srcOfUrl = (item) => /^\/s\/([^/]+)\//.exec(urlOf(item).pathname)?.[1];
const qOfUrl = (item) => urlOf(item).searchParams.get('q');

await sources.refresh();
await store.refresh();
quality.init();
downloads.init();
player.init();
check(store.lib.tracks.length === 10, 'union of the two libraries, deduplicated (one song per recording)', `${store.lib.tracks.length} songs`);
check(JSON.stringify(store.trackSources('t4')) === JSON.stringify([A, B]), 'a shared track knows both sources', JSON.stringify(store.trackSources('t4')));

// ===== source choice and quality in the URLs =====
const all = tracks.map((t) => t.id);
const ctxLib = { type: 'library', id: null, name: 'Libreria' };
player.playContext(ctxLib, all, 0);
let sq = JSON.parse(last('setQueue').args[0]);
check(srcOfUrl(sq.items[0]) === A && urlOf(sq.items[0]).origin === 'http://127.0.0.1:47123', 'a track only on the Mi A2 streams from it (absolute URL)', sq.items[0].url);
check(srcOfUrl(sq.items[4]) === B, 'a track on both streams from the lowest RTT (VPS)', sq.items[4].url);
check(srcOfUrl(sq.items[7]) === B, 'a track only on the VPS streams from it');
check(qOfUrl(sq.items[0]) === 'max' && sq.items[0].quality === 'max', 'Wi-Fi, throughput 3000 >= 1.5 x 256 kbps: max', `${qOfUrl(sq.items[0])} / ${sq.items[0].quality}`);
check(qOfUrl(sq.items[4]) === 'max', 'Wi-Fi, throughput not measured yet: max');
send({ index: 0, playing: true, positionMs: 1000, quality: 'max' });
check(player.state.quality === 'max', 'quality from the state event', String(player.state.quality));
window.__mpfyNative({ type: 'state', index: 0, playing: true, positionMs: 1500, quality: 'normal', buffering: false, durationMs: 200000, repeat: 'off' });
check(player.state.quality === 'normal', '__mpfyNative takes an object too', String(player.state.quality));

// Mobile data: the app reports the change; throughput decides.
network = { type: 'cellular', metered: true };
window.__mpfyNative({ type: 'network' });
check(quality.networkType() === 'cellular', 'network event: re-read with getNetwork()', quality.networkType());
srcState[A].throughputKbps = 300;
await sources.refresh();
check(quality.decide(store.track('t0'), A) === 'normal', 'mobile data, 300 kbps: normal', quality.decide(store.track('t0'), A));
srcState[A].throughputKbps = 500;
await sources.refresh();
check(quality.decide(store.track('t0'), A) === 'high', 'mobile data, 500 kbps, no stall: high');
quality.noteRebuffer();
check(quality.decide(store.track('t0'), A) === 'normal', 'mobile data, 500 kbps, a stall in the last 5 minutes: normal');
srcState[A].throughputKbps = 150;
await sources.refresh();
check(quality.decide(store.track('t0'), A) === 'low', 'mobile data, 150 kbps: low');
check(quality.decide(store.track('t4'), B) === 'normal', 'mobile data, throughput unknown: normal');
quality.set('cellular', 'high');
check(quality.decide(store.track('t0'), A) === 'high', 'a fixed setting wins over Automatica');
quality.set('cellular', 'auto');

// A source goes offline: its tracks are not queued, shared ones come from the other source.
srcState[B].connected = false;
srcState[B].rttMs = null;
await sources.refresh();
await sleep(1200); // the player re-evaluates the list a second after a change of sources
player.playContext(ctxLib, all, 0);
sq = JSON.parse(last('setQueue').args[0]);
check(sq.items.map((x) => x.id).join(',') === 't0,t1,t2,t3,t4,t5', 'tracks only on the offline VPS are not queued', sq.items.map((x) => x.id).join(','));
check(srcOfUrl(sq.items[4]) === A, 'a shared track falls back to the Mi A2', sq.items[4].url);
srcState[B].connected = true;
srcState[B].rttMs = 40;
srcState[A].throughputKbps = 3000;
await sources.refresh();
network = { type: 'wifi', metered: false };
window.__mpfyNative({ type: 'network' });
await sleep(1200);

// ===== errors, by itemId =====
player.playContext(ctxLib, all, 4); // t4 from the VPS
sq = JSON.parse(last('setQueue').args[0]);
send({ index: sq.index, playing: true, positionMs: 30000 });
check(srcOfUrl(sq.items[sq.index]) === B, 'playing t4 from the VPS');
let n = count('setQueue');
window.__mpfyNative({ type: 'error', message: 'unrelated', itemId: 't0' });
check(count('setQueue') === n && player.state.items[player.state.index].id === 't4', 'an error for an item that is neither current nor next is ignored');
const t4item = sq.items[sq.index];
check(t4item.versions.map((v) => v.sourceId).join(',') === `${B},${A}` && t4item.versions.every((v) => v.offsetMs === 0 && v.fileHash === 't4') && t4item.url === t4item.versions[0].url, 'the item carries both versions: the VPS first (lower RTT), the Mi A2 next, offset 0 for the same file', JSON.stringify(t4item.versions.map((v) => [v.sourceId, v.offsetMs])));
check(new URL(t4item.versions[1].url).searchParams.get('f') === 't4', 'each version URL names its file (&f=)', t4item.versions[1].url);
send({ index: sq.index, playing: true, positionMs: 30500, sourceId: A });
check(player.state.source === A, 'the app moved to the other version by itself: the state event names its source', String(player.state.source));
send({ index: player.state.index, playing: false, positionMs: 30000 });
const iBefore = player.state.index;
window.__mpfyNative({ type: 'error', message: 'Source error', itemId: 't4' });
sq = JSON.parse(last('setQueue').args[0]);
check(count('setQueue') === n + 1 && sq.index === iBefore + 1 && sq.items[sq.index].id === 't5', 'an error after every version failed: skip to the next track', `index=${sq.index} id=${sq.items[sq.index]?.id}`);
check(toasts[toasts.length - 1] === 'Brano non disponibile', 'and the toast says so', toasts[toasts.length - 1]);
send({ index: sq.index, playing: true, positionMs: 100 });

// The app moved on to the next item and that one fails before its index report arrives.
send({ index: player.state.index, playing: true, positionMs: 5000 });
n = count('setQueue');
const nextId = player.state.items[player.state.index + 1].id; // t6, only on the VPS
window.__mpfyNative({ type: 'error', message: 'Source error', itemId: nextId });
sq = JSON.parse(last('setQueue').args[0]);
check(player.state.items[player.state.index].id !== 't5' && count('setQueue') === n + 1, 'an error of the next item: the player follows the app forward', `now ${player.state.items[player.state.index].id}`);
send({ index: sq.index, playing: true, positionMs: 100 });

// ===== downloads carry the download quality =====
quality.set('download', 'high');
const albumId = store.d.albumOf.get('t0');
downloads.setContext({ type: 'album', id: albumId }, true);
const dl = JSON.parse(last('download')?.args[0] || '[]');
check(dl.length === 8 && dl.every((x) => x.quality === 'high' && new URL(x.url).searchParams.get('q') === 'high'), 'download items: { id, url ?q=high, quality: high }', `${dl.length} items`);
check(dl.find((x) => x.id === 't7') && srcOfUrl(dl.find((x) => x.id === 't7')) === B, 'a download comes from a source that has the track');
quality.set('download', 'max');

// ===== the queue =====
// 1. Play the context from t3; queue t6, t7 (manual).
player.playContext(ctxLib, all, 3);
sq = JSON.parse(last('setQueue').args[0]);
check(sq.index === 3 && sq.playWhenReady === true, 'playContext sends setQueue at index 3');
send({ index: 3, playing: true, positionMs: 1000 });
player.addToQueue(['t6', 't7']);
const kept0 = (() => {
  const q = player.manualRange();
  return player.state.items.slice(q.start, q.end).map((x) => x.id).join(',');
})();
check(kept0.endsWith('t6,t7'), 'queued block right after current', ids().join(','));

// 2. Shuffle on moves the current track to index 0; a tick from before carries 3.
player.setShuffle(true);
sq = JSON.parse(last('setQueue').args[0]);
check(sq.index === 0 && player.state.index === 0, 'shuffle on: setQueue index 0');
const before = player.state.index;
send({ index: 3, playing: true, positionMs: 1500 }); // stale: old list
check(player.state.index === before, 'stale tick with the old index is ignored', `index=${player.state.index}`);
send({ index: 0, playing: true, positionMs: 1600 }); // the player caught up
send({ index: 1, playing: true, positionMs: 100 }); // a real track change afterwards
check(player.state.index === 1, 'after the confirming tick, a real native change is accepted');
player.setShuffle(false);
sq = JSON.parse(last('setQueue').args[0]);
send({ index: sq.index, playing: true, positionMs: 200 });

// 3. Bluetooth previous (native moves back one by itself) carries the queued block.
player.playContext(ctxLib, all, 4);
sq = JSON.parse(last('setQueue').args[0]);
send({ index: sq.index, playing: true, positionMs: 300 });
const lastMan = () => {
  const q = player.manualRange();
  return player.state.items.slice(q.start, q.end).map((x) => x.id).join(',');
};
const kept = lastMan();
player.addToQueue(['t1', 't2']);
send({ index: player.state.index, playing: true, positionMs: 400 });
const blockA = lastMan();
check(blockA === (kept ? kept + ',' : '') + 't1,t2', 'queued block after t4', ids().join(','));
let nSetQueue = count('setQueue');
send({ index: player.state.index - 1, playing: true, positionMs: 0 });
check(player.state.items[player.state.index].id === 't3', 'native previous accepted (now t3)');
check(lastMan() === blockA, 'queued block carried right after t3', ids().join(','));
check(player.state.items[player.manualRange().end].id === 't4', 'the track we came from (t4) follows the block');
check(count('setQueue') === nSetQueue + 1, 'reordered list handed to the app once');
sq = JSON.parse(last('setQueue').args[0]);
check(sq.index === player.state.index && sq.items[sq.index].id === 't3', 'resync keeps the current track (t3) at its index');
send({ index: sq.index, playing: true, positionMs: 500 });

// 4. UI previous with the native backend: decided in JS (position < 3 s goes back, carries).
const nPrev = count('previous');
const blockC = lastMan();
player.previous();
check(count('previous') === nPrev, 'UI previous does not call native previous');
check(player.state.items[player.state.index].id === 't2', 'UI previous goes back one (t2)');
check(lastMan() === blockC, 'UI previous keeps the queued block ahead', ids().join(','));
sq = JSON.parse(last('setQueue').args[0]);
check(sq.index === player.state.index && sq.playWhenReady === true, 'reordered list sent as the track change');
send({ index: sq.index, playing: true, positionMs: 5000 });
const nSkip = count('skipTo');
player.previous();
check(count('skipTo') === nSkip && last('seekTo').args[0] === '0', 'after 3 s previous restarts the track');

// 5. An error long after a pause done outside the page (Bluetooth): stays paused.
send({ index: player.state.index, playing: true, positionMs: 3000 });
send({ index: player.state.index, playing: false, positionMs: 3000 });
await sleep(1700);
const nq2 = count('setQueue');
window.__mpfyNative(JSON.stringify({ type: 'error', message: 'late', itemId: player.state.items[player.state.index].id }));
check(count('setQueue') === nq2 && player.state.playing === false, 'error while paused: no failover, no skip, no autoplay');

// ===== review fixes (2026-11-17) =====
const setSw = (on) => Object.defineProperty(navigator, 'serviceWorker', { value: on ? { controller: {} } : undefined, configurable: true });
const setUp = async (id, up) => {
  srcState[id].connected = up;
  srcState[id].rttMs = up ? (id === A ? 120 : 40) : null;
  await sources.refresh();
};

// 1. Covers whose sources are all offline never reach the core (it would hold a connection 6 s).
check(coverHref('cv7') === `/s/${B}/api/cover/cv7?size=small`, 'a cover of a connected source: a plain URL', String(coverHref('cv7')));
await setUp(B, false);
check(coverHref('cv7') === null, 'its only source offline, no service worker: no URL (the placeholder)', String(coverHref('cv7')));
setSw(true);
check(coverHref('cv7') === `/s/${B}/api/cover/cv7?size=small&cached=1`, 'its only source offline: the service worker\'s cached copy only (&cached=1)', String(coverHref('cv7')));
check(coverHref('cv7', 'large', { forApp: true }) === `/s/${B}/api/cover/cv7?size=large`, 'artwork for the app stays a plain URL', String(coverHref('cv7', 'large', { forApp: true })));
check(coverHref('cv3') === `/s/${A}/api/cover/cv3?size=small`, 'a cover the connected Mi A2 also has comes from it', String(coverHref('cv3')));
setSw(false);
await setUp(B, true);
await sleep(1200);

// 2. A downloaded track is queued at the level it was downloaded at (the app's cache key).
const albumCtx = { type: 'album', id: store.d.albumOf.get('t0') };
downloads.setContext(albumCtx, false);
window.__mpfyNative({ type: 'downloads', ids: [], progress: {} });
quality.set('download', 'max');
downloads.setContext(albumCtx, true);
window.__mpfyNative({ type: 'downloads', ids: ['t0'], progress: {} });
network = { type: 'cellular', metered: true };
window.__mpfyNative({ type: 'network' });
srcState[A].throughputKbps = 500;
await sources.refresh();
player.playContext(ctxLib, all, 0);
sq = JSON.parse(last('setQueue').args[0]);
const d0 = sq.items.find((x) => x.id === 't0');
const d1 = sq.items.find((x) => x.id === 't1');
check(d0.quality === 'max' && qOfUrl(d0) === 'max', 'mobile data, Automatica: a track downloaded in Max is queued as max (quality and ?q=)', `${d0.quality} / ${qOfUrl(d0)}`);
const auto1 = quality.decide(store.track('t1'), A); // normal: a stall was noted a moment ago
check(auto1 !== 'max' && d1.quality === auto1 && qOfUrl(d1) === auto1, 'the same queue: a track not downloaded streams at the Automatica level', `${d1.quality} / ${qOfUrl(d1)} (Automatica: ${auto1})`);
send({ index: sq.index, playing: true, positionMs: 1000 });
network = { type: 'wifi', metered: false };
window.__mpfyNative({ type: 'network' });
srcState[A].throughputKbps = 3000;
await sources.refresh();
await sleep(1200);

// 3. A failover on a source whose server is down (its link still up): the next tracks avoid it.
healthStatus[B] = 503;
player.clearQueue(); // the tracks queued by hand earlier would sit right after t4
player.playContext(ctxLib, all, 4);
sq = JSON.parse(last('setQueue').args[0]);
send({ index: sq.index, playing: true, positionMs: 20000 });
check(srcOfUrl(sq.items[sq.index]) === B && srcOfUrl(sq.items[sq.index + 1]) === B, 't4 and then t5 from the VPS (lowest RTT)');
window.__mpfyNative({ type: 'error', message: 'Source error', itemId: 't4' });
await sleep(1400); // the health check answers, the list is decided again a second after the change
sq = JSON.parse(last('setQueue').args[0]);
check(!sources.isUp(B), 'the failing source answers its health check with an error: marked down');
check(sq.items[sq.index].id === 't5' && srcOfUrl(sq.items[sq.index]) === A && sq.items[sq.index].versions.length === 1, 'after the failover the next track (t5) comes from the Mi A2 only', sq.items[sq.index]?.url);
healthStatus[B] = 200;
send({ index: sq.index, playing: false, positionMs: 21000 });

// 4. The page hidden (screen off): the source list is polled while music plays, not otherwise.
sources.start(); // registers its visibilitychange listener (the harness polled through refresh())
await sleep(100);
document.hidden = true;
fire('visibilitychange');
send({ index: player.state.index, playing: true, positionMs: 22000 });
await sleep(20);
check(sources.polling === true, 'page hidden, music playing: the source list is still polled');
send({ index: player.state.index, playing: false, positionMs: 22000 });
await sleep(20);
check(sources.polling === false, 'page hidden, paused: no polling');
document.hidden = false;
fire('visibilitychange');
sources.markUp(B); // its server answers again (a request that works clears the mark)
await sources.refresh();

// A "down" mark ends when the core sees the link come back, and when it runs out it is noticed.
await setUp(B, false);
sources.markDown(B); // a request failed on it meanwhile
await setUp(B, true);
check(sources.isUp(B), 'the core reports the link back: the down mark goes at once');
sources.markDown(B); // its server failed while the link stayed up
let emitted = 0;
const offEmit = sources.subscribe(() => emitted++);
const realNow0 = Date.now;
Date.now = () => realNow0() + 11000;
await sources.refresh();
Date.now = realNow0;
offEmit();
check(emitted > 0 && sources.isUp(B), 'a down mark that ran out is told to the listeners at the next poll', `emitted ${emitted}, up ${sources.isUp(B)}`);
await sleep(1200);

// 5. Downloads: only from connected sources; a failed one says so and is asked again later.
downloads.setContext(albumCtx, false);
window.__mpfyNative({ type: 'downloads', ids: [], progress: {} });
await setUp(B, false);
let nDl = count('download');
downloads.setContext(albumCtx, true);
const req1 = JSON.parse(last('download').args[0]).map((x) => x.id);
check(count('download') === nDl + 1 && req1.join(',') === 't0,t1,t2,t3,t4,t5', 'tracks only on the offline VPS are not asked for', req1.join(','));
nDl = count('download');
await setUp(B, true);
await sleep(50);
const req2 = count('download') === nDl + 1 ? JSON.parse(last('download').args[0]).map((x) => x.id) : [];
check(req2.join(',') === 't6,t7', 'the VPS back: its tracks are asked for at once', req2.join(','));
window.__mpfyNative({ type: 'downloads', ids: [], progress: { t6: 10 } });
const nToasts = toasts.length;
window.__mpfyNative({ type: 'downloads', ids: [], progress: {} });
check(toasts.slice(nToasts).includes('Download non riuscito'), 'the app drops a download it had started: "Download non riuscito"', toasts.slice(nToasts).join(' | '));
nDl = count('download');
downloads.sync();
check(count('download') === nDl, 'a failed download is not asked again at once');
const realNow = Date.now;
Date.now = () => realNow() + 6 * 60 * 1000;
downloads.sync();
Date.now = realNow;
const req3 = count('download') === nDl + 1 ? JSON.parse(last('download').args[0]).map((x) => x.id) : [];
check(req3.includes('t6') && req3.includes('t7') && req3.includes('t0'), 'minutes later the failed one and those never taken up are asked again', req3.join(','));

// 6. The principal copy: covers it cannot fetch are skipped; same-name playlists are not merged.
user[A].playlists = [{ id: 'pa1', name: 'La mia playlist n. 1', description: '', trackIds: ['t0', 't1'], createdAt: 1 }];
user[A].likes = [{ id: 't0', at: 1 }];
user[A].covers.playlist.pa1 = { small: 'cs1', large: 'cl1' };
user[B].playlists = [{ id: 'pb1', name: 'La mia playlist n. 1', description: '', trackIds: ['t7'], createdAt: 1 }];
await store.refresh();
const tryCopy = async (from, to) => {
  try {
    return { r: await store.copyUserData(from, to) };
  } catch (err) {
    return { err };
  }
};
const c1 = await tryCopy(A, B);
const copyId = c1.r?.idMap?.pa1;
check(!c1.err && c1.r.skippedCovers === 1, 'a playlist cover the old principal cannot serve is skipped, the copy goes on', c1.err ? String(c1.err.message) : JSON.stringify(c1.r));
check(user[B].playlists.find((x) => x.id === 'pb1')?.trackIds.join(',') === 't7', 'an unrelated playlist with the same default name on the VPS is left alone', JSON.stringify(user[B].playlists));
check(copyId === 'pa1' && user[B].playlists.find((x) => x.id === copyId)?.trackIds.join(',') === 't0,t1', 'the playlist arrives as its own copy, under its own id', JSON.stringify(user[B].playlists));
const c2 = await tryCopy(A, B);
check(!c2.err && c2.r.idMap.pa1 === copyId && user[B].playlists.length === 2, 'copying again updates that same copy (no duplicate)', JSON.stringify(user[B].playlists.map((x) => x.id)));
await setUp(A, false);
coverOk.add('cl1');
coverOk.add('cs1');
const c3 = await tryCopy(A, B);
check(!c3.err && c3.r.idMap.pa1 === copyId && c3.r.skippedCovers === 1, 'the old principal offline: the copy finishes from its last known library, covers skipped', c3.err ? String(c3.err.message) : JSON.stringify(c3.r));
const c4 = await tryCopy('cccc3333', B);
check(c4.err?.status === 503, 'nothing known of the old principal: the copy refuses instead of copying nothing', c4.err ? `status ${c4.err.status}` : 'no error');
await setUp(A, true);
await sleep(1200);
// A source of before profiles ignores the id asked: the copy made there before is updated, back
// and forth, never a new one at each change of principal.
{
  legacy[B] = true;
  const name = 'Solo mia';
  user[A].playlists.push({ id: 'pa2', name, description: '', trackIds: ['t3'], createdAt: 2 });
  await store.refresh();
  const l1 = await tryCopy(A, B);
  const onB = () => user[B].playlists.filter((x) => x.name === name);
  const first = onB().map((x) => x.id);
  user[A].playlists.find((x) => x.id === 'pa2').trackIds = ['t3', 't4'];
  const l2 = await tryCopy(A, B);
  check(!l1.err && !l2.err && first.length === 1 && onB().length === 1 && onB()[0].id === first[0] && onB()[0].trackIds.join(',') === 't3,t4', 'a source without profiles: copying again updates the copy made there before (no duplicate)', JSON.stringify(user[B].playlists.map((x) => `${x.id}:${x.name}`)));
  legacy[B] = false;
  const keepA = new Set(user[A].playlists.map((x) => x.id));
  const back = await tryCopy(B, A);
  check(!back.err && user[A].playlists.filter((x) => x.name === name).length === 1 && !user[A].playlists.some((x) => x.id === first[0]) && back.r.idMap[first[0]] === 'pa2', 'and copying it back updates the original, not a new playlist under the other id', JSON.stringify(user[A].playlists.map((x) => x.id + ':' + x.name)));
  user[A].playlists = user[A].playlists.filter((x) => keepA.has(x.id) && x.id !== 'pa2');
  user[B].playlists = user[B].playlists.filter((x) => x.name !== name);
  await store.refresh();
}

// 7. A removed source: its downloaded tracks stay (no source), the others go.
window.__mpfyNative({ type: 'downloads', ids: ['t0', 't7'], progress: {} });
const vps = srcState[B];
delete srcState[B];
await sources.refresh();
await store.refresh();
check(!!store.track('t7') && store.trackSources('t7').length === 0, 'the VPS removed: its downloaded track t7 stays, with no source', JSON.stringify(store.trackSources('t7')));
check(!store.track('t6'), 'its track not downloaded goes');
player.playContext(ctxLib, store.lib.tracks.map((t) => t.id), 0);
sq = JSON.parse(last('setQueue').args[0]);
check(sq.items.some((x) => x.id === 't7'), 'the kept track can be played (from the download)', sq.items.map((x) => x.id).join(','));
send({ index: sq.index, playing: true, positionMs: 100 });
downloads.setContext(albumCtx, false);
check(!store.track('t7'), 'its download removed: the kept track goes too');
srcState[B] = vps;


// ===== songs on several sources =====
await sources.refresh();
await store.refresh();
await setUp(A, true);
await setUp(B, true);
await sleep(1200);
send({ index: player.state.index, playing: false, positionMs: 100 });

// 1. A like and a play bring back the user part only: the merge stays as it was.
{
  const m0 = store.merges;
  const n0 = libCalls.length;
  await store.like('t1');
  await sleep(500);
  const calls1 = libCalls.slice(n0);
  check(store.isLiked('t1') && store.merges === m0 && calls1.length > 0 && calls1.every(([, have, fresh]) => have > 0 && fresh), 'a like: the libraries come back with tracks: null, the merge is not rebuilt', `merges ${m0} -> ${store.merges}, ${JSON.stringify(calls1)}`);
  store.played('t1', { type: 'library', id: null });
  await sleep(500);
  check(store.merges === m0, 'a play: the merge is not rebuilt either', `merges ${store.merges}`);
  ver[A]++; // a track changed on the Mi A2
  await store.refresh();
  check(store.merges === m0 + 1, 'a change of the shared library: the merge runs once', `merges ${store.merges}`);
}

// 2. Versions of t8: the FLAC on the VPS and an mp3 on the Mi A2 (another file, 2 items earlier).
{
  quality.set('wifi', 'max');
  player.playContext(ctxLib, ['t8', 't0'], 0);
  sq = JSON.parse(last('setQueue').args[0]);
  const it = sq.items[0];
  quality.set('wifi', 'auto');
  check(it.versions.map((v) => `${v.sourceId}:${v.fileHash}`).join(',') === `${B}:fb8,${A}:fa8` && it.quality === 'max', 'Max: the FLAC first (best score), then the mp3', JSON.stringify(it.versions.map((v) => [v.sourceId, v.fileHash])));
  check(it.versions[0].offsetMs === 0 && it.versions[1].offsetMs === -248, 'offsets: the mp3 starts 2 items earlier than the first version (from the signatures)', JSON.stringify(it.versions.map((v) => v.offsetMs)));
  send({ index: sq.index, playing: true, positionMs: 1000 });
  await sleep(100);
  check(fpCalls.includes(`${B}:t8:fb8`) && fpCalls.includes(`${A}:t8:fa8`), 'the raw fingerprints of the item playing are fetched', fpCalls.join(','));
  const n0 = fpCalls.length;
  player.playContext(ctxLib, ['t8', 't0'], 0);
  await sleep(50);
  check(fpCalls.length === n0, 'and cached: the same item again asks nothing', `${fpCalls.length - n0} more`);
  // The mp3 is downloaded: it goes first, at its own level.
  window.__mpfyNative({ type: 'downloads', ids: ['t8'], progress: {}, items: [{ trackId: 't8', fileHash: 'fa8', quality: 'low' }] });
  player.playContext(ctxLib, ['t8', 't0'], 0);
  sq = JSON.parse(last('setQueue').args[0]);
  const d = sq.items[0];
  check(d.versions.map((v) => v.fileHash).join(',') === 'fa8,fb8' && d.quality === 'low' && new URL(d.url).searchParams.get('q') === 'low', 'app items: the downloaded version first, asked at its own level', JSON.stringify([d.versions.map((v) => v.fileHash), d.quality]));
  check(d.versions[1].offsetMs === 248, 'offsets follow the new first version', JSON.stringify(d.versions.map((v) => v.offsetMs)));
  send({ index: sq.index, playing: true, positionMs: 1000 });
  await setUp(A, false);
  await sleep(1200);
  player.playContext(ctxLib, ['t8', 't0'], 0);
  sq = JSON.parse(last('setQueue').args[0]);
  check(sq.items[0].id === 't8' && sq.items[0].versions[0].fileHash === 'fa8' && sq.items[0].versions[0].sourceId === A && sq.items.length === 1, 'its source offline: the downloaded version stays in the item, first (t0 is not queued)', JSON.stringify(sq.items.map((x) => [x.id, x.versions.map((v) => v.sourceId)])));
  send({ index: sq.index, playing: true, positionMs: 1000 });
  await setUp(B, false);
  await sleep(1200);
  player.playContext(ctxLib, ['t8', 't0'], 0);
  sq = JSON.parse(last('setQueue').args[0]);
  check(sq.items.length === 1 && sq.items[0].id === 't8' && sq.items[0].versions.length === 1 && sq.items[0].versions[0].fileHash === 'fa8', 'no source connected at all: the item still plays its download', JSON.stringify(sq.items.map((x) => [x.id, x.versions.length])));
  send({ index: sq.index, playing: false, positionMs: 1000 });
  window.__mpfyNative({ type: 'downloads', ids: [], progress: {}, items: [] });
  await setUp(A, true);
  await setUp(B, true);
  await sleep(1200);
}

// 3. A downloaded file replaced on its source: the new one is downloaded, then the old one goes.
{
  window.__mpfyNative({ type: 'downloads', ids: ['t2'], progress: {}, items: [{ trackId: 't2', fileHash: 'old2', quality: 'max' }] });
  const nd = count('download');
  downloads.sync();
  const asked = count('download') > nd ? JSON.parse(last('download').args[0]) : [];
  const t2 = asked.find((x) => x.trackId === 't2');
  check(!!t2 && t2.fileHash === 't2' && t2.id === 't2' && new URL(t2.url).searchParams.get('f') === 't2', 'a downloaded file whose fileHash changed: the new file is asked for', JSON.stringify(asked));
  const nr = count('removeDownload');
  window.__mpfyNative({ type: 'downloads', ids: ['t2'], progress: {}, items: [{ trackId: 't2', fileHash: 'old2', quality: 'max' }, { trackId: 't2', fileHash: 't2', quality: 'max' }] });
  const rm = count('removeDownload') > nr ? JSON.parse(last('removeDownload').args[0]) : null;
  check(JSON.stringify(rm) === JSON.stringify([{ trackId: 't2', fileHash: 'old2' }]), 'once it is here, the old one is removed by version ({ trackId, fileHash })', JSON.stringify(rm));
  window.__mpfyNative({ type: 'downloads', ids: ['t2'], progress: {}, items: [{ trackId: 't2', fileHash: 't2', quality: 'max' }] });
  check(downloads.has('t2') && downloads.hasVersion({ trackId: 't2', fileHash: 't2' }), 'the new download is kept');
  window.__mpfyNative({ type: 'downloads', ids: [], progress: {}, items: [] });
}

// 4. Deleting versions.
{
  // a. t9 on the principal and u9 on the VPS (the same file): the song is t9. Deleting it on the
  //    principal moves the person's references to u9 first.
  user[A].likes = [{ id: 't9', at: 5 }];
  user[A].playlists = [{ id: 'pd1', name: 'P', description: '', trackIds: ['t0', 't9', 't1', 't9'], createdAt: 2 }];
  uver[A]++;
  await store.refresh();
  check(store.gid('u9') === 't9' && store.isLiked('u9'), 'u9 and t9 are one song, with the id of the principal\'s version');
  const r = await store.deleteVersion('t9', A);
  await sleep(500);
  check(r?.deleted === true && user[A].playlists[0].trackIds.join(',') === 't0,u9,t1,u9', 'deleting the principal\'s version: playlist entries end on the next song id, in place', user[A].playlists[0].trackIds.join(','));
  check(user[A].likes.some((l) => l.id === 'u9') && !user[A].likes.some((l) => l.id === 't9') && store.isLiked('u9'), 'and the like moved to it', JSON.stringify(user[A].likes));
  check(!!store.track('u9') && store.trackSources('u9').join(',') === B, 'the song stays, on the VPS', store.trackSources('u9').join(','));
  // b. t5 is the same trackId on both: the source purges it from the person's data, and the web
  //    puts it back once the delete answered deleted: true.
  user[A].likes = [{ id: 't5', at: 6 }];
  user[A].playlists = [{ id: 'pd2', name: 'Q', description: '', trackIds: ['t5', 't2', 't5'], createdAt: 3 }];
  uver[A]++;
  await store.refresh();
  const r2 = await store.deleteVersion('t5', A);
  await sleep(500);
  check(r2?.deleted === true && user[A].playlists[0].trackIds.join(',') === 't5,t2,t5' && user[A].likes.some((l) => l.id === 't5'), 'the same trackId on another source: likes and entries come back after deleted: true, at their old positions', JSON.stringify([user[A].playlists[0].trackIds, user[A].likes]));
  check(store.trackSources('t5').join(',') === B && store.isLiked('t5'), 'and the song plays from the VPS, still liked');
  // c. A member's own track that others own too: only the claim goes, nothing leaves the screen.
  user[A].likes = [{ id: 't3', at: 7 }];
  uver[A]++;
  await store.refresh();
  const before = [store.trackSources('t3').join(','), store.isLiked('t3'), store.lib.tracks.length].join('|');
  const nT = toasts.length;
  slowDelete = 200; // the source takes its time: the screen meanwhile is what counts
  const p3 = store.deleteVersion('t3', B);
  await sleep(60);
  const during = [store.trackSources('t3').join(','), store.isLiked('t3'), store.lib.tracks.length].join('|');
  const r3 = await p3;
  slowDelete = 0;
  await sleep(50);
  const after = [store.trackSources('t3').join(','), store.isLiked('t3'), store.lib.tracks.length].join('|');
  check(r3?.deleted === false && before === during && before === after && libOf[B].some((t) => t.id === 't3'), "a member's delete of a track others own too removes nothing on screen", `${before} -> ${during} -> ${after}`);
  check(store.libOf(B).tracks.find((t) => t.id === 't3')?.mine === false && toasts.length === nT, 'that track is no longer theirs, and no toast');
}

// 5. What a member may change: their own tracks and albums only; the owner everything.
{
  const { allowedVersion } = await imp('js/store.js');
  const vOf = (id, src) => store.versions(id).find((v) => v.sourceId === src);
  check(allowedVersion(vOf('t4', A)) && !allowedVersion(vOf('t4', B)) && allowedVersion(vOf('t6', B)), 'allowed: the owner any track, a member only a track that is theirs (mine)');
  check(store.editableVersions('t4').map((v) => v.sourceId).join(',') === A, 'an edit of a song goes to every version where it is allowed', store.editableVersions('t4').map((v) => v.sourceId).join(','));
  const albumB = store.d.albumOf.get('t0');
  check(store.albumSources(albumB).join(',') === A, 'an album cover: the owner\'s source; not the VPS, where not every track of it is theirs', store.albumSources(albumB).join(','));
  const { coverMenuItems } = await imp('components/cover-edit.js');
  const items = coverMenuItems('track', 't6').map((x) => x.label).join(',');
  check(items === 'Cambia copertina', 'cover items for a track that is theirs on the VPS', items);
}

// 6. An edit while the app moved on by itself (a key, the car, a song that ended): the edit goes
// with keep, and the app's report of the song it went on with, at that song's index in the new
// list, is taken at once instead of after EXPECT_MS.
{
  player.clearQueue();
  player.playContext(ctxLib, all, 3);
  let q = JSON.parse(last('setQueue').args[0]);
  check(q.keep === false, 'a new list goes without keep', String(q.keep));
  send({ index: q.index, itemId: q.items[q.index].id, playing: true, positionMs: 1000 });
  const cur = player.state.index;
  const next = player.state.items[cur + 1].id;
  player.addToQueue(['t0']);
  q = JSON.parse(last('setQueue').args[0]);
  check(q.keep === true && q.index === cur && q.items[cur + 1].id === 't0', 'a song queued while one plays: the edit goes with keep', JSON.stringify({ keep: q.keep, index: q.index, after: q.items[cur + 1]?.id }));
  send({ index: cur + 1, itemId: next, playing: true, positionMs: 0 });
  check(player.state.index === cur, 'after that edit, a report of the old list (its next song at the next index) is ignored', `index ${player.state.index}`);
  const n0 = count('setQueue');
  send({ index: cur + 2, itemId: next, playing: true, positionMs: 100 });
  const now = player.state.items[player.state.index];
  check(now.id === next && player.state.items[player.state.index + 1]?.id === 't0', 'the app went on with that song, kept where the new list holds it: taken at once, the queued song after it', ids().join(','));
  q = JSON.parse(last('setQueue').args[0]);
  check(count('setQueue') === n0 + 1 && q.items[q.index].id === next && q.keep === true, 'and the list goes back to the app once, with the song playing at its index', JSON.stringify({ sent: count('setQueue') - n0, at: q.items[q.index]?.id }));
  send({ index: q.index, itemId: next, playing: true, positionMs: 300 });
  // A new list: a report at another index is of the old list even when the song there matches.
  player.playContext(ctxLib, all, 1);
  q = JSON.parse(last('setQueue').args[0]);
  const other = q.index + 1;
  send({ index: other, itemId: q.items[other].id, playing: true, positionMs: 0 });
  check(player.state.index === q.index, 'after a new list, a report at another index is ignored until the app shows the new one', `index ${player.state.index}`);
  send({ index: q.index, itemId: q.items[q.index].id, playing: true, positionMs: 200 });
}

console.log(`failures=${failures}`);
process.exit(failures ? 1 : 0);
