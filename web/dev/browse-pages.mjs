// The car's library in pages (bridge 7), the page's side, in Node: the page (web/js/browse.js on
// the real store) against the mock source (web/dev/mock-server.mjs) and a fake Android app that
// keeps the pages and the index as the app does (pages by slot, an index that names them in order,
// the pages it does not name dropped, getBrowsePages from what it holds).
//
//   - the layout: runs that keep their slots as songs come and go, a full page cut in two, a small
//     one joined to its neighbour, appended songs filling a new page, slots reused;
//   - every pass: the app's library (the pages in the index's order, and the index) equals the
//     whole snapshot of bridge 4 built now (buildSnapshot), field for field; no page and no index
//     is sent whose content the app already holds; the pages go before the index;
//   - only moved pages sent: a title edited deep in the list sends its page alone and no index,
//     hashing that song alone, and so does a cover of its own; a like sends the index alone and
//     hashes nothing; a song removed or added sends its page and the index; a source going
//     offline sends the pages whose versions it moved; a finished download sends the page of
//     that song alone, hashing it alone; a refresh that moves nothing sends nothing;
//   - the page loaded again (a new process) with the app holding its pages: nothing sent, then a
//     change sends its page alone; an app still reading its pages from disk is asked again;
//   - at most 20000 songs, in pages of at most 2000; bridge 7 never sends the whole snapshot.
//
// Usage: node web/dev/browse-pages.mjs <out dir> [--web <web dir>] [--fixtures <dir>]
//   Writes <out dir>/browse-pages.log (PASS/FAIL lines, also printed); exit 1 on a failure.
//   --fixtures <dir>: writes a small library's pages, index and whole snapshot there (gzipped),
//   for the app's own test (android BrowsePagesTest), and checks nothing else.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argAt = (k) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : null;
};
const WEB = path.resolve(argAt('--web') || path.join(HERE, '..'));
const outDir = path.resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : path.join(HERE, '..', '..', '.logs', 'browse-pages'));
const fixturesDir = argAt('--fixtures');
const reloadFile = argAt('--reload');
fs.mkdirSync(outDir, { recursive: true });

const noop = () => {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
let fails = 0;
const log = (...a) => {
  const s = a.join(' ');
  lines.push(s);
  console.log(s);
};
const check = (ok, name, extra = '') => {
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);
  if (!ok) fails++;
};
const finish = () => {
  log(`fails=${fails}`);
  fs.writeFileSync(path.join(outDir, reloadFile ? 'browse-pages-reload.log' : 'browse-pages.log'), `${lines.join('\n')}\n`);
  process.exit(fails ? 1 : 0);
};

// ---- the fake app: keeps what the page sends as the Android app does

const app = {
  pages: new Map(), // n -> { h, tracks }
  index: null,
  calls: [],
  useless: [], // a page or an index sent with the content the app held already
  loadingFor: 0, // getBrowsePages answers { loading: true } that many times
  asked: 0,
};
const sansStamp = (o) => {
  const { at, h, ...rest } = o;
  return JSON.stringify(rest);
};
function appPage(n, text) {
  const o = JSON.parse(text);
  const slot = Number(n);
  if (o.format !== 'mpfy-browse-page' || o.v !== 1 || o.n !== slot || !Array.isArray(o.tracks) || !o.tracks.length || o.tracks.length > 2000 || !/^[0-9a-f]{16}$/.test(o.h)) {
    app.calls.push({ name: 'badPage', n: slot });
    return;
  }
  const old = app.pages.get(slot);
  if (old && JSON.stringify(old.tracks) === JSON.stringify(o.tracks)) app.useless.push(`page ${slot}`);
  app.pages.set(slot, { h: o.h, tracks: o.tracks });
  app.calls.push({ name: 'page', n: slot });
}
function appIndex(text) {
  const o = JSON.parse(text);
  if (o.format !== 'mpfy-browse-index' || o.v !== 1 || !Array.isArray(o.pages) || !/^[0-9a-f]{16}$/.test(o.h)) {
    app.calls.push({ name: 'badIndex' });
    return;
  }
  if (app.index && sansStamp(app.index) === sansStamp(o)) app.useless.push('index');
  app.index = o;
  const named = new Set(o.pages);
  for (const n of [...app.pages.keys()]) if (!named.has(n)) app.pages.delete(n);
  app.calls.push({ name: 'index' });
}
function appHeld() {
  app.asked++;
  if (app.loadingFor > 0) {
    app.loadingFor--;
    return JSON.stringify({ loading: true });
  }
  if (!app.index) return JSON.stringify({ index: null, pages: [] });
  const pages = app.index.pages.filter((n) => app.pages.has(n)).map((n) => ({ n, h: app.pages.get(n).h, first: app.pages.get(n).tracks[0].id }));
  return JSON.stringify({ index: app.index.h, pages });
}
const appTracks = () => (app.index ? app.index.pages.flatMap((n) => app.pages.get(n)?.tracks || []) : []);
const sent = (name) => app.calls.filter((c) => c.name === name);

// ---- the page's globals (set before any module of the page is read: native.js looks for the
// app once), its fetch through the mock found later

let origin = 'http://127.0.0.1:9';
function pageGlobals() {
  const ls = new Map();
  const el = () => ({ append: noop, appendChild: noop, remove: noop, classList: { add: noop, remove: noop, toggle: noop, contains: () => false }, style: { setProperty: noop }, setAttribute: noop, addEventListener: noop, children: [], firstElementChild: null, querySelector: () => null, querySelectorAll: () => [], dataset: {} });
  globalThis.window = globalThis;
  globalThis.addEventListener = noop;
  globalThis.matchMedia = () => ({ matches: false, addEventListener: noop });
  globalThis.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k), key: (i) => [...ls.keys()][i] ?? null, get length() { return ls.size; } };
  globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: noop, removeEventListener: noop, createElement: el, createElementNS: el, createDocumentFragment: el, body: el(), documentElement: el(), hidden: false };
  globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
  globalThis.location = { get origin() { return origin; }, get href() { return `${origin}/`; }, pathname: '/' };
  globalThis.MPfyNative = new Proxy(
    {},
    {
      get: (_, name) => (...args) => {
        if (name === 'bridgeVersion') return '7';
        if (name === 'setBrowsePage') return appPage(args[0], args[1]);
        if (name === 'setBrowseIndex') return appIndex(args[0]);
        if (name === 'getBrowsePages') return appHeld();
        if (name === 'setBrowseSnapshot') return app.calls.push({ name: 'whole' });
        if (name === 'getState') return JSON.stringify({ type: 'state', playing: false });
        if (name === 'getNetwork') return JSON.stringify({ type: 'wifi', metered: false });
        if (name === 'listDownloads') return JSON.stringify({ ids: [], progress: {}, items: [] });
        if (name === 'getStorage') return JSON.stringify({ downloadsBytes: 0, downloadsCount: 0, cacheBytes: 0 });
        if (name === 'getUpdate') return JSON.stringify({ state: 'none' });
        return undefined;
      },
    }
  );
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(typeof input === 'string' ? input : input.url, origin);
    const { signal, cache, ...rest } = init;
    for (let again = 1; ; again--) {
      try {
        const res = await realFetch(u.href, rest);
        const body = await res.arrayBuffer();
        return new Response(res.status === 304 ? null : body, { status: res.status, headers: res.headers });
      } catch (err) {
        if (!again) throw err;
      }
    }
  };
}

async function startMock(env) {
  const child = spawn(process.execPath, ['--max-old-space-size=4096', path.join(WEB, 'dev', 'mock-server.mjs')], { env: { ...process.env, MOCK_PORT: '0', MOCK_DELAY: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', (d) => log('mock:', String(d).trim()));
  const port = await new Promise((r, j) => {
    child.stdout.on('data', (d) => {
      const m = /MOCK_PORT=(\d+)/.exec(String(d));
      if (m) r(Number(m[1]));
    });
    child.on('exit', (c) => j(new Error(`mock exited ${c}`)));
  });
  return mockAt(port, child);
}

async function mockAt(port, child = null) {
  const base = `http://127.0.0.1:${port}`;
  origin = base;
  const helper = async (p) => (await fetch(`${base}/__mock/${p}`)).text();
  const st = await (await fetch(`${base}/__mock/state`)).json();
  const api = async (src, method, p, body) => {
    const r = await fetch(`${base}/s/${src}/api${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };
  return { port, base, helper, api, mi: st.servers[0].id, vps: st.servers[1].id, stop: () => child?.kill() };
}

const imp = (p) => import(pathToFileURL(path.join(WEB, p)).href);

/** The page started as app.js starts it, with the parts the car's library reads. */
async function startPage() {
  const mods = {
    sources: (await imp('js/sources.js')).sources,
    store: (await imp('js/store.js')).store,
    quality: (await imp('js/quality.js')).quality,
    downloads: (await imp('js/downloads.js')).downloads,
    browseMod: await imp('js/browse.js'),
  };
  mods.quality.init();
  const first = mods.sources.refresh();
  mods.downloads.init();
  mods.browseMod.browse.init();
  await first;
  await mods.store.init();
  return mods;
}

/** The library answers of both sources were read again and the car's quiet time passed. */
async function settle(mods, ms = 2600) {
  await mods.store.refresh();
  if (mods.store.idle) await mods.store.idle();
  await sleep(150);
  await mods.store.refresh();
  if (mods.store.idle) await mods.store.idle();
  await sleep(ms);
  // A pass may still be on its way (it yields between pages): until nothing more comes.
  for (let n = -1; app.calls.length !== n; ) {
    n = app.calls.length;
    await sleep(300);
  }
}

/** The app's library equals the whole snapshot built now, and nothing was sent twice. */
function sameAsWhole(mods, name) {
  const whole = mods.browseMod.buildSnapshot(mods.browseMod.MAX_PAGED_TRACKS);
  const got = appTracks();
  const ix = app.index || {};
  const groups = ['quality', 'albums', 'artists', 'playlists', 'liked', 'recent'];
  const diff = groups.filter((k) => JSON.stringify(ix[k]) !== JSON.stringify(whole[k]));
  let firstBad = -1;
  for (let i = 0; i < Math.max(got.length, whole.tracks.length); i++) {
    if (JSON.stringify(got[i]) !== JSON.stringify(whole.tracks[i])) {
      firstBad = i;
      break;
    }
  }
  check(firstBad < 0 && !diff.length, `${name}: the app's pages and index equal the whole snapshot built now`, `${got.length} songs held, ${whole.tracks.length} in the library${firstBad >= 0 ? `, first different at ${firstBad}` : ''}${diff.length ? `, groups differ: ${diff.join(',')}` : ''}`);
  check(!app.useless.length, `${name}: nothing sent that the app held already`, app.useless.join(', '));
  app.useless.length = 0;
}

/** What one change sends: { pages: [slots], index: count, hashed }. */
async function step(mods, change, ms) {
  const c0 = app.calls.length;
  const hashed = () => mods.browseMod.pagedStats?.hashed ?? NaN;
  const h0 = hashed();
  await change();
  await settle(mods, ms);
  const calls = app.calls.slice(c0);
  return { pages: calls.filter((c) => c.name === 'page').map((c) => c.n), index: calls.filter((c) => c.name === 'index').length, hashed: hashed() - h0, calls };
}

const slotOf = (id) => {
  for (const n of app.index.pages) if (app.pages.get(n)?.tracks.some((t) => t.id === id)) return n;
  return null;
};

// =================================================================================================
// the layout, alone

async function layoutChecks() {
  const { layOut } = await imp('js/browse.js');
  if (typeof layOut !== 'function') return check(false, 'the pages are laid out (layOut)');
  const ids = (from, to) => Array.from({ length: to - from }, (_, i) => `s${from + i}`);
  const shape = (runs) => runs.map((r) => `${r.n}:${r.to - r.from}`).join(' ');
  const prevOf = (runs, list) => runs.map((r) => ({ n: r.n, first: list[r.from] }));
  let list = ids(0, 9000);
  let runs = layOut(list, []);
  check(shape(runs) === '0:2000 1:2000 2:2000 3:2000 4:1000', 'from nothing: pages of 2000 in order, the rest in the last', shape(runs));
  // A song added at the end fills the last page.
  list = [...list, 's9000'];
  runs = layOut(list, prevOf(runs, list));
  check(shape(runs) === '0:2000 1:2000 2:2000 3:2000 4:1001', 'a song added at the end: the last page grows', shape(runs));
  // Added in the middle of a full page: it is cut in two, the second half takes a new slot.
  let prev = prevOf(runs, list);
  list = [...list.slice(0, 3000), 'x1', ...list.slice(3000)];
  runs = layOut(list, prev);
  check(shape(runs) === '0:2000 1:1001 5:1000 2:2000 3:2000 4:1001', 'a song added to a full page: cut in two, the second half in a new slot', shape(runs));
  // Then one more there: only that page moves.
  prev = prevOf(runs, list);
  list = [...list.slice(0, 2500), 'x2', ...list.slice(2500)];
  runs = layOut(list, prev);
  check(shape(runs) === '0:2000 1:1002 5:1000 2:2000 3:2000 4:1001', 'one more in a page with room: that page alone', shape(runs));
  // A song removed: its page alone.
  prev = prevOf(runs, list);
  list = list.filter((x) => x !== 's7000');
  runs = layOut(list, prev);
  check(shape(runs) === '0:2000 1:1002 5:1000 2:2000 3:1999 4:1001', 'a song removed: its page alone', shape(runs));
  // The first song of a page removed: the rest of that page joins the page before, which is
  // cut in two; the page before keeps its songs, so it is not sent again.
  list = ids(0, 6000);
  runs = layOut(list, []);
  prev = prevOf(runs, list);
  list = list.filter((x) => x !== 's2000');
  runs = layOut(list, prev);
  check(shape(runs) === '0:2000 1:1999 2:2000' && list[runs[1].from] === 's2001', 'the first song of a page removed: the others stay in their slot, the page before untouched', shape(runs));
  // Small pages join a neighbour.
  list = ids(0, 3000);
  runs = layOut(list, [{ n: 0, first: 's0' }, { n: 1, first: 's1000' }, { n: 2, first: 's1100' }, { n: 3, first: 's2000' }]);
  check(shape(runs) === '0:1100 2:900 3:1000', 'a page of 100 joins the page before it (they fit), keeping the longer one\'s slot', shape(runs));
  // A song before the first page joins it.
  list = ['new', ...ids(0, 3000)];
  runs = layOut(list, [{ n: 4, first: 's0' }, { n: 7, first: 's2000' }]);
  check(shape(runs) === '4:2001 7:1000' || shape(runs) === '4:1001 0:1000 7:1000', 'a song before the first page goes into it', shape(runs));
  // Slots reused: the smallest free.
  list = ids(0, 6000);
  runs = layOut(list, [{ n: 9, first: 's0' }]);
  check(shape(runs) === '9:2000 0:2000 1:2000', 'new pages take the smallest free slots', shape(runs));
  // Everything reordered: still pages of at most 2000, every song once.
  list = ids(0, 9000).reverse();
  runs = layOut(list, prevOf(layOut(ids(0, 9000), []), ids(0, 9000)));
  const covered = runs.reduce((a, r) => a + r.to - r.from, 0);
  const contiguous = runs.every((r, i) => (i === 0 ? r.from === 0 : r.from === runs[i - 1].to));
  check(covered === 9000 && contiguous && runs.every((r) => r.to - r.from <= 2000 && r.to > r.from) && new Set(runs.map((r) => r.n)).size === runs.length, 'the order turned around: runs in order, each at most 2000, slots distinct', shape(runs));
  check(layOut([], [{ n: 0, first: 's0' }]).length === 0, 'no songs: no pages');
  // Many small pages: they join until a page is full.
  list = ids(0, 4000);
  const many = Array.from({ length: 40 }, (_, i) => ({ n: i, first: `s${i * 100}` }));
  runs = layOut(list, many);
  check(shape(runs) === '0:2000 20:2000', 'many small pages join their neighbours until a page is full', shape(runs));
}

// =================================================================================================
// the page against the mock

async function pageChecks() {
  const m = await startMock({ MOCK_TRACKS: '15000', MOCK_LIKES: '300', MOCK_PLAYLIST: '200' });
  try {
    // The VPS answers faster: a song on both plays from it first while it is up.
    await m.helper(`source?source=${m.mi}&rtt=120`);
    await m.helper(`source?source=${m.vps}&rtt=40`);
    // The app reads its pages from disk for a while: the page waits for it.
    app.loadingFor = 2;
    const mods = await startPage();
    const { browseMod, store } = mods;
    await sleep(2600);
    check(sent('page').length === 0 && app.asked >= 1, 'the app still reading its pages: nothing sent yet, asked again later', `asked ${app.asked}`);
    for (let i = 0; i < 200 && !sent('index').length; i++) await sleep(100);
    await settle(mods, 300);
    const total = store.lib.tracks.length;
    const nPages = Math.ceil(Math.min(total, browseMod.MAX_PAGED_TRACKS) / 2000);
    check(sent('page').length === nPages && sent('index').length === 1, `first send: ${nPages} pages and one index`, `${sent('page').length} pages, ${sent('index').length} index, ${total} songs`);
    const firstIndexAt = app.calls.findIndex((c) => c.name === 'index');
    check(app.calls.slice(0, firstIndexAt).filter((c) => c.name === 'page').length === nPages, 'the pages go before the index');
    check(sent('whole').length === 0 && sent('badPage').length === 0 && sent('badIndex').length === 0, 'bridge 7: no whole snapshot, every page and index with its shape');
    check([...app.pages.values()].every((p) => p.tracks.length <= 2000), 'pages of at most 2000 songs');
    sameAsWhole(mods, 'at start');

    // Nothing moved: nothing sent.
    let r = await step(mods, async () => {});
    check(r.pages.length === 0 && r.index === 0 && r.hashed === 0, 'a refresh that moves nothing: nothing sent, nothing hashed', JSON.stringify(r));

    // A title edited deep in the list: its page alone, no index, that song alone hashed.
    const lib = (await m.api(m.mi, 'GET', '/library')).body;
    const deep = lib.tracks[9100];
    const slot = slotOf(store.gid(deep.id));
    r = await step(mods, () => m.api(m.mi, 'PATCH', `/tracks/${deep.id}`, { title: 'Titolo cambiato' }));
    check(r.pages.length === 1 && r.pages[0] === slot && r.index === 0, 'a title edited: its page alone, no index', `${JSON.stringify(r.pages)} (its page ${slot}), index ${r.index}`);
    check(r.hashed >= 1 && r.hashed <= 3, 'a title edited: that song hashed again, not the library', `hashed ${r.hashed}`);
    sameAsWhole(mods, 'after a title edit');

    // A like: the index alone, nothing hashed.
    const likedNow = new Set((lib.likes || []).map((l) => l.id));
    const toLike = lib.tracks.slice().reverse().find((t) => !likedNow.has(t.id));
    r = await step(mods, () => m.api(m.mi, 'PUT', `/likes/${toLike.id}?brief=1`));
    check(r.pages.length === 0 && r.index === 1 && r.hashed === 0, 'a like: the index alone, nothing hashed', JSON.stringify({ pages: r.pages, index: r.index, hashed: r.hashed }));
    sameAsWhole(mods, 'after a like');

    // A song removed: its page and the index.
    const gone = lib.tracks[5000];
    const goneSlot = slotOf(store.gid(gone.id));
    r = await step(mods, () => m.api(m.mi, 'DELETE', `/tracks/${gone.id}`));
    check(r.pages.length === 1 && r.pages[0] === goneSlot && r.index === 1, 'a song removed: its page and the index', `${JSON.stringify(r.pages)} (its page ${goneSlot}), index ${r.index}`);
    check(r.hashed <= 3, 'a song removed: no song hashed again but those it moved', `hashed ${r.hashed}`);
    sameAsWhole(mods, 'after a removal');

    // A song added (after the Mi A2's songs, before the VPS's own): one page and the index.
    r = await step(mods, () => m.helper(`grow?source=${m.mi}&tracks=1`));
    check(r.pages.length === 1 && r.index === 1, 'a song added: one page and the index', JSON.stringify({ pages: r.pages, index: r.index, hashed: r.hashed }));
    check(r.hashed >= 1 && r.hashed <= 3, 'a song added: that song hashed, not the library', `hashed ${r.hashed}`);
    sameAsWhole(mods, 'after an upload');

    // A song's own cover: its page alone (the song stays the object it was; only the cover moved).
    const covered = lib.tracks[12000];
    const coveredSlot = slotOf(store.gid(covered.id));
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    r = await step(mods, () => fetch(`${m.base}/s/${m.mi}/api/cover-for/track/${covered.id}`, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: png }).then((x) => x.text()));
    check(r.pages.length === 1 && r.pages[0] === coveredSlot, "a song's own cover: its page alone", JSON.stringify({ pages: r.pages, slot: coveredSlot, index: r.index, hashed: r.hashed }));
    check(r.hashed >= 1 && r.hashed <= 3, "a song's own cover: that song hashed again, not the library", `hashed ${r.hashed}`);
    sameAsWhole(mods, 'after a cover');

    // The VPS offline: the pages whose songs' versions it moved, nothing else.
    const before = new Map([...app.pages].map(([n, p]) => [n, JSON.stringify(p.tracks)]));
    r = await step(mods, () => m.helper(`offline?source=${m.vps}&on=1`).then(() => mods.sources.refresh()));
    const movedSlots = [...app.pages].filter(([n, p]) => before.get(n) !== JSON.stringify(p.tracks)).map(([n]) => n);
    check(r.pages.length >= 1 && r.pages.length < nPages && r.pages.slice().sort().join() === movedSlots.slice().sort().join(), 'the VPS offline: the pages it moved are sent, the others not', `sent ${JSON.stringify(r.pages)} of ${nPages}`);
    sameAsWhole(mods, 'the VPS offline');
    r = await step(mods, () => m.helper(`offline?source=${m.vps}&on=0`).then(() => mods.sources.refresh()));
    sameAsWhole(mods, 'the VPS back');

    // A finished download moves the order of that song's versions alone: its page alone. At Max
    // the best file goes first; with the Mi A2 offline its better file is not playable until it
    // is downloaded.
    r = await step(mods, () => mods.quality.set('cellular', 'max'));
    sameAsWhole(mods, 'mobile data at Max');
    r = await step(mods, () => m.helper(`offline?source=${m.mi}&on=1`).then(() => mods.sources.refresh()));
    sameAsWhole(mods, 'the Mi A2 offline');
    const two = store.lib.tracks.find((t) => {
      const vs = store.versions(t.id);
      const a = vs.find((v) => v.sourceId === m.mi);
      const b = vs.find((v) => v.sourceId === m.vps);
      return a && b && a.fileHash !== b.fileHash && a.score > b.score;
    });
    if (!two) check(false, 'a song on both sources with a better file on the Mi A2');
    else {
      const mine = store.versions(two.id).find((v) => v.sourceId === m.mi);
      const was = JSON.stringify(browseMod.buildSnapshot(browseMod.MAX_PAGED_TRACKS).tracks.find((t) => t.id === two.id));
      const dlSlot = slotOf(two.id);
      r = await step(mods, () => window.__mpfyNative(JSON.stringify({ type: 'downloads', ids: [mine.trackId], progress: {}, items: [{ trackId: mine.trackId, fileHash: mine.fileHash, quality: 'max' }] })));
      const now = JSON.stringify(browseMod.buildSnapshot(browseMod.MAX_PAGED_TRACKS).tracks.find((t) => t.id === two.id));
      check(was !== now, "a finished download changes the order of that song's versions", `${was} -> ${now}`);
      check(r.pages.length === 1 && r.pages[0] === dlSlot && r.index === 0, "a finished download: that song's page alone", JSON.stringify({ pages: r.pages, slot: dlSlot, index: r.index }));
      check(r.hashed >= 1 && r.hashed <= 3, 'a finished download: that song hashed again, not the library', `hashed ${r.hashed}`);
      sameAsWhole(mods, 'after a download');
    }
    r = await step(mods, () => m.helper(`offline?source=${m.mi}&on=0`).then(() => mods.sources.refresh()));
    r = await step(mods, () => mods.quality.set('cellular', 'auto'));
    sameAsWhole(mods, 'the Mi A2 back, Automatica');

    // The page loaded again: the app holds its pages, nothing goes; then a change, its page alone.
    const state = path.join(outDir, 'reload-app.json');
    fs.writeFileSync(state, JSON.stringify({ port: m.port, index: app.index, pages: [...app.pages] }));
    const child = await new Promise((resolve) => {
      const c = spawn(process.execPath, ['--max-old-space-size=4096', fileURLToPath(import.meta.url), outDir, '--web', WEB, '--reload', state], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      c.stdout.on('data', (d) => (out += d));
      c.stderr.on('data', (d) => (out += d));
      c.on('exit', (code) => resolve({ code, out }));
    });
    for (const l of child.out.trim().split('\n')) log(`  reload: ${l}`);
    check(child.code === 0, 'the page loaded again: its checks pass');

    // More than 20000 songs: the first 20000, in pages of at most 2000.
    r = await step(mods, () => m.helper(`grow?source=${m.mi}&tracks=6000`), 4000);
    check(appTracks().length === browseMod.MAX_PAGED_TRACKS && store.lib.tracks.length > browseMod.MAX_PAGED_TRACKS, 'a library of more than 20000 songs: 20000 in the pages', `${appTracks().length} held of ${store.lib.tracks.length}`);
    check([...app.pages.values()].every((p) => p.tracks.length <= 2000), 'still pages of at most 2000');
    sameAsWhole(mods, 'past the cap');
    check(browseMod.MAX_PAGED_TRACKS === 20000 && browseMod.PAGE_SONGS === 2000 && browseMod.PAGED_BRIDGE === 7, 'the caps: 20000 songs in pages of 2000, from bridge 7');
  } finally {
    m.stop();
  }
}

/** In the page loaded again (a process of its own): the app holds the pages of the first one. */
async function reloadChecks() {
  const st = JSON.parse(fs.readFileSync(reloadFile, 'utf8'));
  app.index = st.index;
  for (const [n, p] of st.pages) app.pages.set(n, p);
  const m = await mockAt(st.port);
  const mods = await startPage();
  await sleep(2600);
  for (let i = 0; i < 100 && app.asked === 0; i++) await sleep(100);
  await settle(mods, 600);
  check(app.asked === 1, 'loaded again: the app asked once what it holds', `asked ${app.asked}`);
  check(sent('page').length === 0 && sent('index').length === 0, 'loaded again: nothing sent, the app holds it all', JSON.stringify(app.calls));
  sameAsWhole(mods, 'loaded again');
  const lib = (await m.api(m.mi, 'GET', '/library')).body;
  const t = lib.tracks[3000];
  const slot = slotOf(mods.store.gid(t.id));
  const r = await step(mods, () => m.api(m.mi, 'PATCH', `/tracks/${t.id}`, { title: 'Dopo il ritorno' }));
  check(r.pages.length === 1 && r.pages[0] === slot && r.index === 0, 'loaded again, a title edited: its page alone', JSON.stringify({ pages: r.pages, slot, index: r.index }));
  sameAsWhole(mods, 'loaded again, after an edit');
}

/** A small library's texts, for the app's own test. */
async function writeFixtures() {
  const m = await startMock({ MOCK_TRACKS: '2100', MOCK_LIKES: '40', MOCK_PLAYLIST: '30' });
  try {
    await m.helper(`source?source=${m.mi}&rtt=0`);
    await m.helper(`source?source=${m.vps}&rtt=0`);
    const mods = await startPage();
    for (let i = 0; i < 300 && !sent('index').length; i++) await sleep(100);
    await settle(mods, 300);
    sameAsWhole(mods, 'fixtures');
    fs.mkdirSync(fixturesDir, { recursive: true });
    for (const f of fs.readdirSync(fixturesDir)) if (/\.json\.gz$/.test(f)) fs.unlinkSync(path.join(fixturesDir, f));
    const gz = (name, text) => fs.writeFileSync(path.join(fixturesDir, `${name}.json.gz`), zlib.gzipSync(Buffer.from(text, 'utf8'), { level: 9 }));
    // The texts exactly as sent, written again from what the app kept.
    for (const [n, p] of app.pages) gz(`page-${n}`, JSON.stringify({ format: 'mpfy-browse-page', v: 1, n, h: p.h, tracks: p.tracks }));
    gz('index', JSON.stringify(app.index));
    gz('whole', mods.browseMod.snapshotTexts().text);
    check(app.index.pages.length > 1, `fixtures written: ${app.index.pages.length} pages, ${appTracks().length} songs`);
  } finally {
    m.stop();
  }
}

pageGlobals();
try {
  if (reloadFile) await reloadChecks();
  else if (fixturesDir) await writeFixtures();
  else {
    await layoutChecks();
    await pageChecks();
  }
} catch (err) {
  check(false, 'no error', String(err?.stack || err));
}
finish();
