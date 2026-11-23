// Playlists, likes and downloads under bursts: a change must not lose or double songs, whatever
// the order the requests arrive in, and what the person did must not be undone on screen.
//
// In Node, the store (web/js/store.js) against two real sources (server/app.mjs), each request
// of the link held a while where it matters:
//   refresh  a library answer that left the source before a like (or a removal) arrives after it
//            settled: the heart and the list do not go back
//   remove   "Rimuovi da questa playlist" from a list behind the source's (another device removed
//            a song; a song came in above the row): the song the row showed goes, no other; a
//            song in the list twice whose copy another device removed keeps its other copy; a
//            row whose song was swapped for another version removes that version
//   edit     an edit sent with the list it was made from: a song another device added stays, here
//            at once and on the source; a copy removed on both sides is removed once
//   swap     "Elimina" of a song that has a copy on the other source, while a song is added to a
//            playlist that holds it, twice in a row, and after another device swapped it already:
//            nothing added or moved is lost, and the copy is not put in twice
// In a phone-sized browser against the mock source (web/dev/mock-server.mjs):
//   minus    "Modifica playlist": a double or triple tap on a minus removes one song; a tap after
//            a pause, or taps 460 ms apart, remove one song each; "Fine" sends the order with the
//            list it was made from
//   menu     the sheet of a row is open while the list changes: "Rimuovi da questa playlist"
//            removes the song of that row (a song came in above; the copy of a song in the list
//            twice went; the song was swapped for its copy on the other source)
//   commit   "Fine" after another device added a song: shown at once with the edit
//   download the app's download toggle (a fake bridge): a double tap leaves the files as they were,
//            a triple tap asks once, a single tap shows at once, a slower off and on ends with
//            the files asked again once the app reported them gone
//   shelves  album and artist pages: a play report or a heart leaves the rows of cards and the
//            lists where they are (the same elements, the same sideways offset)
//
// Usage: node web/dev/gestures-data.mjs <out dir> [section ...]
//   writes <out dir>/gestures-data.log (and gestures-data-store.log from the Node part); prints
//   PASS/FAIL lines and fails=<n>; exit 1 on a failure
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const outDir = path.resolve(process.argv[2] || '.');
fs.mkdirSync(outDir, { recursive: true });
const asStore = process.argv.includes('--store');
const only = process.argv.slice(3).filter((a) => a !== '--store');
const STORE_SECTIONS = ['refresh', 'remove', 'edit', 'swap'];
const PAGE_SECTIONS = ['minus', 'menu', 'commit', 'download', 'shelves'];
const want = (s) => !only.length || only.includes(s);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
let fails = 0;
const log = (...a) => lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
function check(ok, label, detail) {
  const line = `${ok ? 'PASS' : 'FAIL'} ${label}`;
  console.log(line);
  log(line);
  if (detail !== undefined) log('     ', detail);
  if (!ok) fails++;
}
/** Runs one section when it was asked for; an error in it is a failure, and the run goes on. */
async function section(name, fn) {
  if (!want(name)) return;
  log(`== ${name}`);
  try {
    await fn();
  } catch (err) {
    check(false, `${name}: the section ran to its end (${String((err && err.stack) || err).slice(0, 400)})`);
  }
}

if (asStore) await storePart();
else await pagePart();

// =================================================================================================
// The store in Node against two real sources
// =================================================================================================
async function storePart() {
  const noop = () => {};
  const ls = new Map();
  const el = () => ({ append: noop, appendChild: noop, remove: noop, classList: { add: noop, remove: noop, toggle: noop, contains: () => false }, style: { setProperty: noop }, setAttribute: noop, addEventListener: noop, children: [], firstElementChild: null, querySelector: () => null, querySelectorAll: () => [], dataset: {} });
  globalThis.window = globalThis;
  globalThis.addEventListener = noop;
  globalThis.matchMedia = () => ({ matches: false, addEventListener: noop });
  globalThis.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) };
  globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: noop, createElement: el, createElementNS: el, createDocumentFragment: el, body: el(), documentElement: el(), hidden: false };
  globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
  globalThis.location = { origin: 'http://127.0.0.1:47123', href: 'http://127.0.0.1:47123/', pathname: '/' };

  const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
  const { createMPfy } = await imp('server/app.mjs');
  const { tmpDir, rmDir, request, json, makeWav } = await imp('test/helpers.mjs');

  const dirs = [];
  const mk = async (name) => {
    const dataDir = tmpDir('mpfy-gestures-data-');
    dirs.push(dataDir);
    return createMPfy({ dataDir, port: 0, adminPort: 0, p2p: false, debounceMs: 10, ffmpeg: null, fpcalc: null, sevenZip: null, name });
  };
  const A = 'aaaa1111';
  const B = 'bbbb2222';
  const apps = { [A]: await mk('Uno'), [B]: await mk('Due') };
  const SOURCES = [
    { id: A, name: 'Uno', principal: true, connected: true, addedAt: 1, role: 'owner', profiles: true },
    { id: B, name: 'Due', principal: false, connected: true, addedAt: 2, role: 'owner', profiles: true },
  ];

  // The client core in front of the two sources: (src, method, path) -> { before, after } ms of
  // link time around the source's answer (after: the answer left the source, not here yet).
  let hook = () => null;
  const reqLog = [];
  const t0 = Date.now();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(typeof input === 'string' ? input : input.url, 'http://127.0.0.1:47123');
    if (u.pathname === '/local/sources') return new Response(JSON.stringify({ sources: SOURCES }), { status: 200, headers: { 'content-type': 'application/json' } });
    const m = /^\/s\/([^/]+)(\/.*)$/.exec(u.pathname);
    if (!m || !apps[m[1]]) return new Response('{}', { status: 404 });
    const method = init.method || 'GET';
    const h = hook(m[1], method, m[2]) || {};
    const { cache, signal, ...rest } = init;
    if (h.before) await sleep(h.before);
    reqLog.push({ at: Date.now() - t0, src: m[1], method, path: m[2], body: typeof init.body === 'string' ? init.body : null });
    const res = await realFetch(`http://127.0.0.1:${apps[m[1]].ports.http}${m[2]}${u.search}`, rest);
    const body = await res.arrayBuffer();
    if (h.after) await sleep(h.after);
    return new Response(res.status === 304 ? null : body, { status: res.status, headers: res.headers });
  };

  const { sources } = await imp('web/js/sources.js');
  const { store } = await imp('web/js/store.js');

  // Another device, straight to a source.
  const call = async (src, method, p, body) => {
    const r = await request(apps[src].ports.http, method, p, body === undefined ? {} : { body });
    return r.body.length ? json(r) : null;
  };
  const srcList = async (src, id) => (await call(src, 'GET', '/api/library')).playlists.find((p) => p.id === id).trackIds;
  const storeList = (id) => store.d.playlists.get(id)?.trackIds.slice() || null;
  let freq = 300;
  const up = async (src, name) => (await call(src, 'PUT', '/api/upload/' + encodeURIComponent(name), makeWav({ freq: (freq += 37), seconds: 1 }))).track;
  /** A copy on B of a track of A: the same file, one song with two versions. */
  async function copyOnB(t, name) {
    const y = await up(B, name);
    apps[B].library.setTrack({ ...apps[B].library.getTrack(y.id), fileHash: t.fileHash, title: t.title, artist: t.artist, album: t.album });
    return apps[B].library.getTrack(y.id);
  }

  // Tracks: six plain songs on A, and three songs of A with a copy on B.
  const plain = [];
  for (const n of ['t', 'u', 'v', 'w', 'z', 'k']) plain.push(await up(A, `${n}.wav`));
  const [T, U, V, W, Z, K] = plain;
  const X = await up(A, 'x.wav');
  const P = await up(A, 'p.wav');
  const R = await up(A, 'r.wav');
  const Y = await copyOnB(X, 'y.wav');
  const Q = await copyOnB(P, 'q.wav');
  const S = await copyOnB(R, 's.wav');
  // Three more songs of A with a copy on B: g (h), e (f), m (n).
  const G = await up(A, 'g.wav');
  const E = await up(A, 'e.wav');
  const M = await up(A, 'm.wav');
  const H = await copyOnB(G, 'h.wav');
  const F = await copyOnB(E, 'f.wav');
  const N = await copyOnB(M, 'n.wav');
  const names = new Map([[T, 't'], [U, 'u'], [V, 'v'], [W, 'w'], [Z, 'z'], [K, 'k'], [X, 'x'], [P, 'p'], [R, 'r'], [Y, 'y'], [Q, 'q'], [S, 's'], [G, 'g'], [H, 'h'], [E, 'e'], [F, 'f'], [M, 'm'], [N, 'n']].map(([t, n]) => [t.id, n]));
  const nm = (ids) => (ids ? ids.map((i) => names.get(i) || i.slice(0, 4)).join(',') : 'none');

  await sources.refresh();
  await store.init();
  log('songs in the store:', store.lib.tracks.length, 'versions of x:', store.versions(X.id).map((v) => v.sourceId).join(' '));
  const settle = () => sleep(1200);
  const touch = () => call(A, 'POST', '/api/played', { trackId: K.id, context: { type: 'library' } }); // the next library GET has a body

  await section('refresh', async () => {
    // A like tapped while a library answer from before it is still on its way.
    await touch();
    hook = (src, method, p) => (method === 'GET' && p.startsWith('/api/library') ? { after: 900 } : { after: 40 });
    const seen = [];
    let last = null;
    const start = Date.now();
    const timer = setInterval(() => {
      const v = store.isLiked(T.id);
      if (v !== last) seen.push(`${Date.now() - start}ms liked=${v}`);
      last = v;
    }, 10);
    store.refresh();
    await sleep(60);
    seen.push(`${Date.now() - start}ms like`);
    const ok = await store.like(T.id);
    seen.push(`${Date.now() - start}ms like resolved ${!!ok}`);
    await sleep(3000);
    clearInterval(timer);
    hook = () => null;
    const states = seen.filter((s) => /liked=/.test(s));
    const firstTrue = states.findIndex((s) => /liked=true/.test(s));
    const back = firstTrue >= 0 && states.slice(firstTrue).some((s) => /liked=false/.test(s));
    const srcLiked = (await call(A, 'GET', '/api/library')).likes.some((l) => l.id === T.id);
    check(firstTrue >= 0 && !back && store.isLiked(T.id) && srcLiked, `a heart tapped while an older library answer travels: it never goes back off (${seen.join(' | ')}; source liked ${srcLiked})`);

    // A removal while an older answer travels: the song does not come back.
    const pl = await store.createPlaylist('Rinfresco', '', [T.id, U.id, V.id, W.id]);
    await settle();
    await touch();
    hook = (src, method, p) => (method === 'GET' && p.startsWith('/api/library') ? { after: 900 } : { after: 40 });
    const views = [];
    let lastView = null;
    const t1 = Date.now();
    const timer2 = setInterval(() => {
      const v = nm(storeList(pl.id));
      if (v !== lastView) views.push(`${Date.now() - t1}ms ${v}`);
      lastView = v;
    }, 10);
    store.refresh();
    await sleep(60);
    await store.removeFromPlaylist(pl.id, [{ index: 1, id: U.id }]);
    await sleep(3000);
    clearInterval(timer2);
    hook = () => null;
    const hasU = (v) => v.split(' ')[1].split(',').includes('u');
    const gone = views.findIndex((v) => !hasU(v));
    const cameBack = gone >= 0 && views.slice(gone).some(hasU);
    const srcNow = nm(await srcList(A, pl.id));
    check(gone >= 0 && !cameBack && srcNow === 't,v,w' && nm(storeList(pl.id)) === 't,v,w', `a song removed while an older library answer travels: it does not come back (${views.join(' | ')}; source ${srcNow})`);
  });

  await section('remove', async () => {
    // Two devices see [t,u,v,w]; the other one removes t; this one, not refreshed, removes v.
    const pl = await store.createPlaylist('Due telefoni', '', [T.id, U.id, V.id, W.id]);
    await settle();
    await call(A, 'DELETE', `/api/playlists/${pl.id}/tracks`, { indexes: [0] });
    const before = nm(storeList(pl.id));
    const ok = await store.removeFromPlaylist(pl.id, [{ index: 2, id: V.id }]);
    await settle();
    let srcNow = nm(await srcList(A, pl.id));
    check(!!ok && before === 't,u,v,w' && srcNow === 'u,w' && nm(storeList(pl.id)) === 'u,w', `another device removed t; this one (still showing ${before}) removes v: the source keeps u,w (${srcNow}; here ${nm(storeList(pl.id))})`);

    // The page drew [t,u,v,w]; a song came in at the top since (the store has it): the row of u
    // (drawn at 1) removes u, not t.
    const pl2 = await store.createPlaylist('Disegnata', '', [T.id, U.id, V.id, W.id]);
    await settle();
    await call(A, 'POST', `/api/playlists/${pl2.id}/tracks`, { trackIds: [Z.id], position: 0 });
    await store.refresh();
    const shown = nm(storeList(pl2.id));
    await store.removeFromPlaylist(pl2.id, [{ index: 1, id: U.id }]);
    const right = nm(storeList(pl2.id));
    await settle();
    srcNow = nm(await srcList(A, pl2.id));
    check(shown === 'z,t,u,v,w' && right === 'z,t,v,w' && srcNow === 'z,t,v,w', `the row of u drawn at 1, a song added above it since: u goes, t stays (here at once ${right}, source ${srcNow})`);

    // u again (a row left on screen): it is already out, nothing else goes and nothing is sent.
    const n = reqLog.length;
    const again = await store.removeFromPlaylist(pl2.id, [{ index: 1, id: U.id }]);
    await settle();
    const sent = reqLog.slice(n).filter((r) => r.method === 'DELETE').length;
    srcNow = nm(await srcList(A, pl2.id));
    check(!!again && sent === 0 && srcNow === 'z,t,v,w', `a song no longer in the list: nothing removed, nothing sent (${sent} sent, source ${srcNow})`);

    // A song twice. Both devices see [t,u,t]; the other one removes the first t; this one, not
    // refreshed, removes the first t too: the other copy stays.
    const dup = await store.createPlaylist('Doppio', '', [T.id, U.id, T.id]);
    await settle();
    await call(A, 'DELETE', `/api/playlists/${dup.id}/tracks`, { indexes: [0] });
    const seenDup = nm(storeList(dup.id));
    await store.removeFromPlaylist(dup.id, [{ index: 0, id: T.id }]);
    await settle();
    srcNow = nm(await srcList(A, dup.id));
    check(seenDup === 't,u,t' && srcNow === 'u,t' && nm(storeList(dup.id)) === 'u,t', `[t,u,t]: another device removed the first t; this one (still showing ${seenDup}) removes the first t too: the other copy stays (source ${srcNow}, here ${nm(storeList(dup.id))})`);

    // The page drew [t,u,t]; a refresh brought [u,t] since (the first t removed elsewhere): the row
    // of the first t, still on screen, removes nothing.
    const dup2 = await store.createPlaylist('Disegno doppio', '', [T.id, U.id, T.id]);
    await settle();
    const drawn2 = store.d.playlists.get(dup2.id).trackIds;
    const songOf = (t) => store.versions(t.id).map((v) => v.trackId); // as the page passes them
    const songT = songOf(T);
    await call(A, 'DELETE', `/api/playlists/${dup2.id}/tracks`, { indexes: [0] });
    await store.refresh();
    const n2 = reqLog.length;
    await store.removeFromPlaylist(dup2.id, [{ index: 0, id: T.id, list: drawn2, song: songT }]);
    await settle();
    const sent2 = reqLog.slice(n2).filter((r) => r.method === 'DELETE').length;
    srcNow = nm(await srcList(A, dup2.id));
    check(srcNow === 'u,t' && nm(storeList(dup2.id)) === 'u,t' && sent2 === 0, `the page drew [t,u,t], the list is [u,t] since: the row of the first t removes nothing (${sent2} sent, source ${srcNow}, here ${nm(storeList(dup2.id))})`);

    // Two versions of one song, [e,f,u]; the other device removed e; the row of e, drawn before,
    // removes nothing: f is a copy of its own.
    const two = await store.createPlaylist('Due versioni', '', [E.id, F.id, U.id]);
    await settle();
    const drawn3 = store.d.playlists.get(two.id).trackIds;
    const songE = songOf(E);
    await call(A, 'DELETE', `/api/playlists/${two.id}/tracks`, { indexes: [0] });
    await store.refresh();
    await store.removeFromPlaylist(two.id, [{ index: 0, id: E.id, list: drawn3, song: songE }]);
    await settle();
    srcNow = nm(await srcList(A, two.id));
    check(srcNow === 'f,u' && nm(storeList(two.id)) === 'f,u', `[e,f,u], f another version of e: e removed elsewhere, the row of e drawn before removes nothing (source ${srcNow}, here ${nm(storeList(two.id))})`);

    // The page drew [m,u]; "Elimina" of m here swapped it for its copy n since: the row of m removes n.
    const sw = await store.createPlaylist('Scambiata', '', [M.id, U.id]);
    await settle();
    const drawn4 = store.d.playlists.get(sw.id).trackIds;
    const songM = songOf(M);
    await store.deleteVersion(M.id, A);
    await settle();
    const swapped = nm(storeList(sw.id));
    await store.removeFromPlaylist(sw.id, [{ index: 0, id: M.id, list: drawn4, song: songM }]);
    await settle();
    srcNow = nm(await srcList(A, sw.id));
    check(swapped === 'n,u' && srcNow === 'u' && nm(storeList(sw.id)) === 'u', `the page drew [m,u], m swapped here for its copy n since (${swapped}): the row of m removes n (song drawn as ${songM.length} versions; source ${srcNow}, here ${nm(storeList(sw.id))})`);
  });

  await section('edit', async () => {
    // The edit began on [t,u,v]; another device then added w; the edit moves v to the top.
    const pl = await store.createPlaylist('Riordino', '', [T.id, U.id, V.id]);
    await settle();
    await call(A, 'POST', `/api/playlists/${pl.id}/tracks`, { trackIds: [W.id] });
    const ok = await store.updatePlaylist(pl.id, { trackIds: [V.id, T.id, U.id], base: [T.id, U.id, V.id] });
    await settle();
    let srcNow = nm(await srcList(A, pl.id));
    check(!!ok && srcNow === 'v,t,u,w' && nm(storeList(pl.id)) === 'v,t,u,w', `an edit made from [t,u,v] after another device added w: w stays (source ${srcNow}, here ${nm(storeList(pl.id))})`);

    // The edit began on [v,t,u,w]; the store has since seen z added elsewhere: the edit shows with z at once.
    await call(A, 'POST', `/api/playlists/${pl.id}/tracks`, { trackIds: [Z.id] });
    await store.refresh();
    const p = store.updatePlaylist(pl.id, { trackIds: [W.id, V.id, T.id, U.id], base: [V.id, T.id, U.id, W.id] });
    const atOnce = nm(storeList(pl.id));
    await p;
    await settle();
    srcNow = nm(await srcList(A, pl.id));
    check(atOnce === 'w,v,t,u,z' && srcNow === 'w,v,t,u,z', `an edit made before z came, z known here: shown at once with z (${atOnce}), the source the same (${srcNow})`);

    // Both devices see [t,u,t]; the other one removes the first t; this one's edit, made from
    // [t,u,t], removes the first t too: the other copy stays.
    const ed = await store.createPlaylist('Doppia modifica', '', [T.id, U.id, T.id]);
    await settle();
    await call(A, 'DELETE', `/api/playlists/${ed.id}/tracks`, { indexes: [0] });
    await store.updatePlaylist(ed.id, { trackIds: [U.id, T.id], base: [T.id, U.id, T.id] });
    await settle();
    srcNow = nm(await srcList(A, ed.id));
    check(srcNow === 'u,t' && nm(storeList(ed.id)) === 'u,t', `[t,u,t]: the first t removed elsewhere and by an edit made here from [t,u,t]: the other copy stays (source ${srcNow}, here ${nm(storeList(ed.id))})`);

    // The same, this one having learned [u,t] before its edit went: shown at once as u,t.
    const ed2 = await store.createPlaylist('Doppia modifica 2', '', [T.id, U.id, T.id]);
    await settle();
    await call(A, 'DELETE', `/api/playlists/${ed2.id}/tracks`, { indexes: [0] });
    await store.refresh();
    const pe = store.updatePlaylist(ed2.id, { trackIds: [U.id, T.id], base: [T.id, U.id, T.id] });
    const atOnce2 = nm(storeList(ed2.id));
    await pe;
    await settle();
    srcNow = nm(await srcList(A, ed2.id));
    check(atOnce2 === 'u,t' && srcNow === 'u,t' && nm(storeList(ed2.id)) === 'u,t', `[u,t] known here, an edit made from [t,u,t] removes the first t: shown at once as ${atOnce2}, the source ${srcNow}`);
  });

  await section('swap', async () => {
    // "Elimina" x on Uno (the song stays through y on Due) while v is added to a playlist with x.
    const one = await store.createPlaylist('Uno', '', [X.id, U.id]);
    const two = await store.createPlaylist('Due', '', [U.id, X.id]);
    await settle();
    hook = (src, method) => (method === 'PATCH' ? { after: 400 } : null);
    const del = store.deleteVersion(X.id, A);
    await sleep(100);
    const added = await store.addToPlaylist(two.id, [V.id]);
    const r = await del;
    await sleep(1500);
    hook = () => null;
    const s1 = nm(await srcList(A, one.id));
    const s2 = nm(await srcList(A, two.id));
    check(!!added && r && r.deleted && s1 === 'y,u' && s2 === 'u,y,v' && nm(storeList(two.id)) === 'u,y,v', `"Elimina" of x (copy y on Due) while v is added to "Due": v stays, x becomes y (Uno ${s1}, Due ${s2}, here ${nm(storeList(two.id))})`);

    // "Elimina" of p, then of r 150 ms later: both playlists end with the copies, nothing lost.
    const first = await store.createPlaylist('Prima', '', [P.id, W.id]);
    const both = await store.createPlaylist('Due brani', '', [P.id, U.id, R.id]);
    await settle();
    hook = (src, method) => (method === 'PATCH' ? { after: 400 } : null);
    const d1 = store.deleteVersion(P.id, A);
    await sleep(150);
    const d2 = store.deleteVersion(R.id, A);
    await Promise.all([d1, d2]);
    await sleep(1500);
    hook = () => null;
    const f = nm(await srcList(A, first.id));
    const bb = nm(await srcList(A, both.id));
    check(f === 'q,w' && bb === 'q,u,s' && nm(storeList(both.id)) === 'q,u,s', `"Elimina" of p then of r 150 ms later (copies q and s on Due): Prima ${f}, Due brani ${bb} (want q,w and q,u,s; here ${nm(storeList(both.id))})`);

    // The other device already swapped g for its copy h in [g,u]; this one, not refreshed, runs
    // "Elimina" of g on Uno too: h once.
    const sc = await store.createPlaylist('Scambio', '', [G.id, U.id]);
    await settle();
    await call(A, 'PATCH', `/api/playlists/${sc.id}`, { trackIds: [H.id, U.id], base: [G.id, U.id] });
    const shownSc = nm(storeList(sc.id));
    const rr = await store.deleteVersion(G.id, A);
    await sleep(1500);
    const sSc = nm(await srcList(A, sc.id));
    check(shownSc === 'g,u' && !!rr && rr.deleted && sSc === 'h,u' && nm(storeList(sc.id)) === 'h,u', `g already swapped for h elsewhere; "Elimina" of g here (showing ${shownSc}): h once (source ${sSc}, here ${nm(storeList(sc.id))})`);
  });

  log('requests:', reqLog.length);
  fs.writeFileSync(path.join(outDir, 'gestures-data-store.log'), lines.join('\n') + '\n');
  console.log(`fails=${fails}`);
  for (const a of Object.values(apps)) await a.close();
  for (const d of dirs) rmDir(d);
  process.exit(fails ? 1 : 0);
}

// =================================================================================================
// Gestures in a phone-sized browser against the mock source
// =================================================================================================
async function pagePart() {
  const storeWanted = STORE_SECTIONS.filter(want);
  if (storeWanted.length) {
    // The store part runs in its own process: it needs a fake window and its own fetch.
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), outDir, '--store', ...storeWanted], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const code = await new Promise((r) => child.on('close', r));
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      if (/^(PASS|FAIL) /.test(line)) {
        console.log(line);
        log(line);
        if (line.startsWith('FAIL')) fails++;
      } else if (!/^fails=/.test(line)) log('store:', line);
    }
    if (code !== 0 && !/FAIL /.test(out)) check(false, `the store part ran to its end (exit ${code})`);
  }
  const pageWanted = PAGE_SECTIONS.filter(want);
  if (pageWanted.length) await pages();
  fs.writeFileSync(path.join(outDir, 'gestures-data.log'), lines.join('\n') + '\n');
  console.log(`fails=${fails}`);
  process.exit(fails ? 1 : 0);
}

async function pages() {
  const { startMock, startBrowser, tap, doubleTap } = await import(pathToFileURL(path.join(HERE, 'gesture-lib.mjs')).href);
  const { mock, base } = await startMock();
  let b = null;
  const run = (js) => b.evaluate(js);
  const mockState = async () => (await fetch(`${base}/__mock/state`)).json();
  const mi = async () => (await mockState()).servers.find((x) => x.name === 'Mi A2');
  const miList = async (name) => (await mi()).playlistData.find((p) => p.name === name).trackIds;
  const titleOf = async (id) => {
    for (const s of (await mockState()).servers) {
      const t = s.trackList.find((x) => x.id === id);
      if (t) return t.title;
    }
    return id.slice(0, 6);
  };

  // In the page: element tags, the playlist and like requests (and a way to hold some back).
  const INSTR = `
    window.__n = window.__n || 0;
    window.__tag = (el) => (el ? el.__t || (el.__t = ++window.__n) : null);
    window.__row = (title) => { const s = [...document.querySelectorAll('#main .shelf')].find((x) => x.querySelector('.shelf-head h2') && x.querySelector('.shelf-head h2').textContent === title); return s ? s.querySelector('.shelf-row') : null; };
    if (!window.__reqOn) {
      window.__reqOn = true; window.__reqs = []; window.__hold = null;
      const f = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        const method = (init && init.method) || 'GET';
        if (/\\/api\\/(playlists|likes)/.test(url)) window.__reqs.push({ method, url, body: init && typeof init.body === 'string' ? init.body : null });
        if (window.__hold && window.__hold.test(method + ' ' + url)) await new Promise((r) => setTimeout(r, 1500));
        return f(input, init);
      };
    }
    if (!window.__emitsOn) { window.__emitsOn = true; window.__emits = 0; mpfy.store.subscribe(() => window.__emits++); }
    return true;`;
  /** A clean page in a new browser: storage cleared, the mock's sample data, the library loaded. */
  async function fresh(route, { fake = null } = {}) {
    if (b) b.close();
    b = await startBrowser('data');
    await b.phone();
    await fetch(`${base}/__mock/reset?sources=2`);
    let id = null;
    if (fake) id = (await b.S('Page.addScriptToEvaluateOnNewDocument', { source: fake })).identifier;
    await b.go(`${base}${route}${route.includes('?') ? '&' : '?'}nosw`, 600);
    await run(`for (let i = 0; i < 80 && !(window.mpfy && mpfy.store.loaded && mpfy.store.lib.tracks.length); i++) await new Promise((r) => setTimeout(r, 100)); return true;`);
    await sleep(500);
    await run(INSTR);
    return id;
  }
  async function goTo(route) {
    await run(`mpfy.navigate(${JSON.stringify(route)}); return true;`);
    await sleep(900);
    await run(INSTR);
  }
  const plId = (name) => run(`return mpfy.store.lib.playlists.find((p) => p.name === ${JSON.stringify(name)}).id;`);
  /** Center of the idx-th element matching sel whose text includes text. */
  const at = (sel, { text = null, idx = 0 } = {}) =>
    run(`const els = [...document.querySelectorAll(${JSON.stringify(sel)})].filter((e) => ${JSON.stringify(text)} == null || e.textContent.includes(${JSON.stringify(text)}));
      const e = els[${idx}]; if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };`);
  const editTitles = () => run(`return [...document.querySelectorAll('.edit-list .edit-row .tr-title-text')].map((e) => e.textContent);`);
  async function openEdit(name) {
    await run(`document.querySelector('.actions [aria-label=${JSON.stringify(`Altre opzioni per ${name}`)}]').click(); return true;`);
    await sleep(700);
    await run(`[...document.querySelectorAll('.layer-sheet .menu-item')].find((b) => b.textContent.includes('Modifica playlist')).click(); return true;`);
    await sleep(900);
  }
  const reqs = () => run(`return window.__reqs;`);

  try {
    await section('minus', async () => {
      await fresh('/');
      const id = await plId('Viaggio in macchina');
      await goTo(`/playlist/${id}`);
      await openEdit('Viaggio in macchina');
      const orig = await miList('Viaggio in macchina');
      const names = await editTitles();
      log('edit rows', names.length, names.join(' | '));
      const expect = names.slice();
      const step = async (label, k, gaps, removes) => {
        const before = await editTitles();
        const c = await at('.edit-list .edit-remove', { idx: k });
        for (let i = 0; i < gaps.length + 1; i++) {
          if (i) await sleep(gaps[i - 1]);
          await tap(b, c.x, c.y, { hold: 60 });
        }
        await sleep(600);
        const after = await editTitles();
        const left = after.slice();
        const gone = before.filter((t) => {
          const i = left.indexOf(t);
          if (i < 0) return true;
          left.splice(i, 1);
          return false;
        });
        for (let r = 0; r < removes; r++) expect.splice(k, 1);
        check(after.length === before.length - removes && after.join('|') === expect.join('|'), `${label}: ${removes} song${removes > 1 ? 's' : ''} removed (${before.length} -> ${after.length}; gone: ${gone.join(', ') || 'none'})`);
      };
      await step('double tap on the minus of row 4, 150 ms apart', 4, [150], 1);
      await step('double tap on the minus of row 6, 220 ms apart', 6, [220], 1);
      await step('triple tap on the minus of row 2, 150 ms apart', 2, [150, 150], 1);
      await step('a tap on the minus of row 3, then another 450 ms after it lifted', 3, [450], 2);
      // Deliberate taps 460 ms apart, press to press, each held 130 ms (330 ms from a lift to the
      // next press): each one removes a song.
      {
        const before = await editTitles();
        const c = await at('.edit-list .edit-remove', { idx: 1 });
        for (let i = 0; i < 3; i++) {
          const t0 = Date.now();
          await tap(b, c.x, c.y, { hold: 130 });
          if (i < 2) await sleep(Math.max(0, 460 - (Date.now() - t0)));
        }
        await sleep(600);
        const after = await editTitles();
        for (let r = 0; r < 3; r++) expect.splice(1, 1);
        check(after.length === before.length - 3 && after.join('|') === expect.join('|'), `three taps on the minus of row 1, 460 ms apart and held 130 ms: 3 songs removed (${before.length} -> ${after.length})`);
      }
      // "Fine": the order goes with the list the edit began on.
      await run(`[...document.querySelectorAll('.topbar-edit button')].find((x) => x.textContent === 'Fine').click(); return true;`);
      await sleep(1500);
      const patch = (await reqs()).filter((r) => r.method === 'PATCH').pop();
      const body = patch && JSON.parse(patch.body);
      const now = await miList('Viaggio in macchina');
      const nowTitles = [];
      for (const t of now) nowTitles.push(await titleOf(t));
      check(!!body && JSON.stringify(body.base) === JSON.stringify(orig) && body.trackIds.length === orig.length - (names.length - expect.length), `"Fine": the order is sent with the list the edit began on (base ${body && body.base ? body.base.length : 'none'} songs, order ${body ? body.trackIds.length : 'none'})`);
      check(nowTitles.join('|') === expect.join('|'), `"Fine": the source has the ${expect.length} songs left in the edit (${nowTitles.length})`, nowTitles);
    });

    await section('menu', async () => {
      await fresh('/');
      const id = await plId('Viaggio in macchina');
      await goTo(`/playlist/${id}`);
      const rows = await run(`return [...document.querySelectorAll('.track-list .track-row')].map((r) => r.querySelector('.tr-title-text').textContent);`);
      const k = 3;
      const shown = rows[k];
      const neighbour = rows[k - 1];
      const before = await miList('Viaggio in macchina');
      // The sheet of row 4 is opened with a tap.
      const more = await at('.track-list .track-row .tr-more', { idx: k });
      await tap(b, more.x, more.y);
      await sleep(700);
      // Meanwhile another device puts a song at the top, and this one learns it (a refresh).
      const mid = (await mi()).id;
      const extra = (await mi()).trackList.find((t) => !before.includes(t.id));
      await fetch(`${base}/s/${mid}/api/playlists/${id}/tracks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trackIds: [extra.id], position: 0 }) });
      await run(`await mpfy.store.refresh(); return true;`);
      await sleep(500);
      const item = await at('.layer-sheet .menu-item', { text: 'Rimuovi da questa playlist' });
      await tap(b, item.x, item.y);
      await sleep(1500);
      const after = await miList('Viaggio in macchina');
      const count = (list, t) => list.filter((x) => x === t).length;
      const shownId = before[k];
      const neighbourId = before[k - 1];
      check(count(after, shownId) === count(before, shownId) - 1 && count(after, neighbourId) === count(before, neighbourId) && after.length === before.length, `the sheet of "${shown}" open while a song came in above: "Rimuovi" removes "${shown}", "${neighbour}" stays (${before.length} + 1 -> ${after.length})`);

      // A song twice: the sheet of its first copy is open while another device removes that
      // copy, and this one learns it: "Rimuovi" leaves the other copy.
      await fresh('/');
      const id2 = await plId('Viaggio in macchina');
      const mid2 = (await mi()).id;
      const orig = await miList('Viaggio in macchina');
      const twice = orig[2];
      await fetch(`${base}/s/${mid2}/api/playlists/${id2}/tracks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trackIds: [twice], position: 0 }) });
      await run(`await mpfy.store.refresh(); return true;`);
      await goTo(`/playlist/${id2}`);
      const first = await run(`return document.querySelector('.track-list .track-row .tr-title-text').textContent;`);
      const more0 = await at('.track-list .track-row .tr-more', { idx: 0 });
      await tap(b, more0.x, more0.y);
      await sleep(700);
      await fetch(`${base}/s/${mid2}/api/playlists/${id2}/tracks`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ indexes: [0] }) });
      await run(`await mpfy.store.refresh(); return true;`);
      await sleep(500);
      const item2 = await at('.layer-sheet .menu-item', { text: 'Rimuovi da questa playlist' });
      await tap(b, item2.x, item2.y);
      await sleep(1500);
      const after2 = await miList('Viaggio in macchina');
      check(!!item2 && JSON.stringify(after2) === JSON.stringify(orig), `"${first}" twice, the sheet of its first copy open while another device removed that copy: "Rimuovi" leaves the other one (${count(after2, twice)} left, ${orig.length} -> ${after2.length} songs)`);

      // A song with a copy on the other source: the sheet of its row is open while another device
      // swaps it in the list for the copy and deletes it here; "Rimuovi" removes the copy.
      await fresh('/');
      const id3 = await plId('Viaggio in macchina');
      const mi3 = await mi();
      const pair = await run(`const p = mpfy.store.principalId;
        const s = [...new Set(mpfy.store.d.tracks.values())].find((x) => x.versions.length === 2 && x.versions.some((v) => v.sourceId === p) && x.versions.some((v) => v.sourceId !== p));
        return s ? { m: s.versions.find((v) => v.sourceId === p).trackId, n: s.versions.find((v) => v.sourceId !== p).trackId, title: s.title } : null;`);
      const orig3 = await miList('Viaggio in macchina');
      const post = (url, method, body) => fetch(`${base}/s/${mi3.id}${url}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      if (pair) {
        await post(`/api/playlists/${id3}/tracks`, 'POST', { trackIds: [pair.m], position: 0 });
        await run(`await mpfy.store.refresh(); return true;`);
        await goTo(`/playlist/${id3}`);
        const more3 = await at('.track-list .track-row .tr-more', { idx: 0 });
        await tap(b, more3.x, more3.y);
        await sleep(700);
        await post(`/api/playlists/${id3}`, 'PATCH', { trackIds: [pair.n, ...orig3] });
        await post(`/api/tracks/${pair.m}`, 'DELETE');
        await run(`await mpfy.store.refresh(); return true;`);
        await sleep(500);
      }
      const item3 = pair ? await at('.layer-sheet .menu-item', { text: 'Rimuovi da questa playlist' }) : null;
      if (item3) {
        await tap(b, item3.x, item3.y);
        await sleep(1500);
      }
      const after3 = await miList('Viaggio in macchina');
      check(!!item3 && JSON.stringify(after3) === JSON.stringify(orig3), `the sheet of "${pair && pair.title}" open while another device swapped it for its copy and deleted it: "Rimuovi" removes the copy (${orig3.length} + 1 -> ${after3.length} songs, copy ${pair && after3.includes(pair.n) ? 'still there' : 'gone'})`);
    });

    await section('commit', async () => {
      await fresh('/');
      const id = await plId('Mattine lente');
      await goTo(`/playlist/${id}`);
      await openEdit('Mattine lente');
      const orig = await miList('Mattine lente');
      // One song removed in the edit.
      const c = await at('.edit-list .edit-remove', { idx: 1 });
      await tap(b, c.x, c.y);
      await sleep(600);
      // Meanwhile another device adds a song, and this one learns it.
      const mid = (await mi()).id;
      const extra = (await mi()).trackList.find((t) => !orig.includes(t.id));
      await fetch(`${base}/s/${mid}/api/playlists/${id}/tracks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trackIds: [extra.id] }) });
      await run(`await mpfy.store.refresh(); return true;`);
      await sleep(300);
      // "Fine", with the PATCH held on the link for a while.
      await run(`window.__hold = /^PATCH .*\\/api\\/playlists\\//; [...document.querySelectorAll('.topbar-edit button')].find((x) => x.textContent === 'Fine').click(); return true;`);
      await sleep(400);
      const here = await run(`return mpfy.store.d.playlists.get(${JSON.stringify(id)}).trackIds;`);
      const rows = await run(`return [...document.querySelectorAll('.track-list .track-row')].map((r) => r.dataset.tid);`);
      const want = [orig[0], ...orig.slice(2), extra.id];
      const patch = (await reqs()).filter((r) => r.method === 'PATCH').pop();
      const body = patch && JSON.parse(patch.body);
      check(JSON.stringify(here) === JSON.stringify(want), `"Fine" after another device added "${extra.title}": the edit shows at once with it (${here.length} songs, want ${want.length})`, { here, want });
      check(rows.includes(extra.id), `... and the page draws it (${rows.length} rows)`);
      check(!!body && JSON.stringify(body.base) === JSON.stringify(orig) && JSON.stringify(body.trackIds) === JSON.stringify([orig[0], ...orig.slice(2)]), `... and the order is sent with the list the edit began on`, body);
      await run(`window.__hold = null; return true;`);
      await sleep(1600);
    });

    await section('download', async () => {
      // The app's bridge, faked: what it holds as downloaded lives in localStorage across reloads.
      const fake = `(() => {
        const st = JSON.parse(localStorage.getItem('fake.dl') || '{"items":[]}');
        window.__fakeDl = st;
        window.__calls = [];
        const report = () => JSON.stringify({ type: 'downloads', ids: st.items.map((i) => i.trackId), progress: {}, items: st.items });
        window.__report = () => window.__mpfyNative(report());
        window.MPfyNative = new Proxy({}, { get: (_, name) => {
          if (typeof name !== 'string' || name === 'then' || name === 'toJSON') return undefined;
          return (...args) => {
            window.__calls.push([name, ...args]);
            switch (name) {
              case 'bridgeVersion': return '3';
              case 'getStorage': return JSON.stringify({ downloadsBytes: 0, downloadsCount: 0, cacheBytes: 0 });
              case 'listDownloads': return report();
              case 'getNetwork': return JSON.stringify({ type: 'wifi', metered: false });
              case 'getState': return JSON.stringify({ playing: false });
              default: return undefined;
            }
          };
        } });
      })();`;
      const id = await fresh('/', { fake });
      // Two albums: the first downloaded (the app has its files), the second not.
      const albums = await run(`const al = [...mpfy.store.d.albums.values()].filter((a) => a.trackIds.length >= 3).slice(0, 2);
        return al.map((a) => ({ id: a.id, name: a.name, items: a.trackIds.map((t) => { const v = mpfy.store.versions(t).find((x) => !x.kept); return { trackId: v.trackId, fileHash: v.fileHash, quality: 'max' }; }) }));`);
      const [on, off] = albums;
      await run(`localStorage.setItem('fake.dl', JSON.stringify({ items: ${JSON.stringify(on.items)} })); localStorage.setItem('mpfy.downloads.contexts', JSON.stringify(['album:${on.id}'])); return true;`);
      await b.go(`${base}/album/${on.id}?nosw`, 1500);
      await run(INSTR);
      const toggle = () => at('.actions .dl-toggle');
      const state = () => run(`const b = document.querySelector('.actions .dl-toggle'); return { on: !!b && b.classList.contains('is-on'), ctx: JSON.parse(localStorage.getItem('mpfy.downloads.contexts') || '[]'), dl: window.__calls.filter((c) => c[0] === 'download').length, rm: window.__calls.filter((c) => c[0] === 'removeDownload').length, toasts: [...document.querySelectorAll('#toasts .toast-text')].map((t) => t.textContent) };`);
      const ready = await state();
      check(ready.on && ready.ctx.includes(`album:${on.id}`), `"${on.name}" is downloaded: its toggle shows it`, ready);

      // A double tap on a downloaded album: the files stay, nothing removed or asked.
      let t = await toggle();
      await doubleTap(b, t.x, t.y, { gap: 150 });
      await sleep(1400);
      let s = await state();
      check(s.on && s.rm === 0 && s.dl === 0 && s.ctx.includes(`album:${on.id}`), `double tap on the download toggle of a downloaded album: still downloaded, nothing removed or asked (${s.rm} removals, ${s.dl} asks)`, s);

      // A slower off and on (900 ms apart): the files asked again once the app reports them gone.
      t = await toggle();
      await tap(b, t.x, t.y);
      await sleep(900);
      const mid = await state();
      await tap(b, t.x, t.y);
      await sleep(900);
      const beforeReport = await state();
      await run(`window.__fakeDl.items = []; localStorage.setItem('fake.dl', JSON.stringify(window.__fakeDl)); window.__report(); return true;`);
      await sleep(600);
      s = await state();
      const asked = await run(`const c = window.__calls.filter((x) => x[0] === 'download').pop(); return c ? JSON.parse(c[1]).map((i) => i.trackId) : [];`);
      check(mid.rm === 1 && beforeReport.on && s.dl === 1 && on.items.every((i) => asked.includes(i.trackId)), `off, then on 900 ms later: once the app reports the files gone they are asked again (${mid.rm} removal, asks before the report ${beforeReport.dl}, after ${s.dl}, ${asked.length} songs)`, { mid, beforeReport, s });

      // The album that is not downloaded.
      await goTo(`/album/${off.id}`);
      await run(`window.__calls.length = 0; return true;`);
      t = await toggle();
      await doubleTap(b, t.x, t.y, { gap: 150 });
      await sleep(1400);
      s = await state();
      check(!s.on && s.dl === 0 && s.rm === 0 && !s.ctx.includes(`album:${off.id}`), `double tap on the toggle of an album not downloaded: nothing asked, still off (${s.dl} asks, ${s.rm} removals)`, s);
      t = await toggle();
      await doubleTap(b, t.x, t.y, { gap: 150, count: 3 });
      await sleep(1400);
      s = await state();
      check(s.on && s.dl === 1 && s.rm === 0 && s.ctx.includes(`album:${off.id}`), `triple tap: downloaded, asked once (${s.dl} asks, ${s.rm} removals)`, s);
      // A single tap shows at once, and changes the files once the taps stopped.
      t = await toggle();
      await run(`window.__calls.length = 0; return true;`);
      await tap(b, t.x, t.y);
      await sleep(120);
      const quick = await state();
      await sleep(1000);
      s = await state();
      check(!quick.on && s.rm === 1 && !s.on && s.toasts.includes('Download rimosso'), `a single tap: the toggle shows it at once (${quick.on ? 'on' : 'off'} after 120 ms), the files go after it (${s.rm} removal, "${s.toasts.join(', ')}")`, { quick, s });
      await b.S('Page.removeScriptToEvaluateOnNewDocument', { identifier: id });
    });

    await section('shelves', async () => {
      await fresh('/');
      // Lumen Marino gets four more albums on the Mi A2, so its rows of albums scroll sideways.
      const st = await mi();
      const fari = st.trackList.filter((t) => t.album === 'Fari nella nebbia').slice(0, 4);
      for (let i = 0; i < fari.length; i++) {
        await fetch(`${base}/s/${st.id}/api/tracks/${fari[i].id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ album: `Fari ${i + 1}` }) });
      }
      await run(`await mpfy.store.refresh(); return true;`);
      await sleep(600);
      const albumId = await run(`return [...mpfy.store.d.albums.values()].find((a) => a.name === 'Città di sale').id;`);
      const artistId = await run(`return [...mpfy.store.d.artists.values()].find((a) => a.name === 'Lumen Marino').id;`);
      const shelfState = (title) => run(`const r = window.__row(${JSON.stringify(title)}); const l = document.querySelector('#main .track-list'); return r ? { tag: window.__tag(r), left: Math.round(r.scrollLeft), max: r.scrollWidth - r.clientWidth, list: window.__tag(l), hero: window.__tag(document.querySelector('#main .hero')) } : null;`);
      const scroll = (title, x) => run(`const r = window.__row(${JSON.stringify(title)}); r.scrollLeft = Math.min(${x}, r.scrollWidth - r.clientWidth); await new Promise((res) => setTimeout(res, 400)); return Math.round(r.scrollLeft);`);
      let playN = 0;
      const emitted = async (n) => {
        for (let i = 0; i < 120; i++) {
          if ((await run('return window.__emits;')) > n) break;
          await sleep(50);
        }
        await sleep(400);
        return (await run('return window.__emits;')) > n;
      };
      const playReport = async () => {
        const e0 = await run('return window.__emits;');
        await run(`const t = mpfy.store.lib.tracks[${(playN++ * 7) % 20}]; mpfy.store.played(t.id, { type: 'library', id: null }); return true;`);
        return emitted(e0);
      };
      const heart = async () => {
        const e0 = await run('return window.__emits;');
        await run(`const t = mpfy.store.lib.tracks.find((x) => !mpfy.store.d.likedSet.has(x.id)); mpfy.store.like(t.id); return true;`);
        return emitted(e0);
      };
      const same = (a, z) => !!a && !!z && a.tag === z.tag && Math.abs(a.left - z.left) <= 1;
      for (const [route, title] of [[`/album/${albumId}`, 'Altro di Lumen Marino'], [`/artist/${artistId}`, 'Album']]) {
        await goTo(route);
        const left = await scroll(title, 300);
        const a = await shelfState(title);
        const ok1 = await playReport();
        const z1 = await shelfState(title);
        check(left > 0 && ok1 && same(a, z1) && a.hero === z1.hero, `${route.split('/')[1]} page, "${title}" scrolled to ${left}: a play report leaves the row where it is (${JSON.stringify(a)} -> ${JSON.stringify(z1)})`);
        const ok2 = await heart();
        const z2 = await shelfState(title);
        check(ok2 && same(a, z2), `${route.split('/')[1]} page: a heart leaves the row where it is (${JSON.stringify(z2)})`);
        if (route.startsWith('/album')) check(a.list === z2.list, `album page: its list of songs is not drawn again for them (${a.list} -> ${z2.list})`);
      }
      // A change of what the page shows: the header is drawn again with it, the songs stay.
      const id = await plId('Viaggio in macchina');
      await goTo(`/playlist/${id}`);
      const before = await run(`return { list: window.__tag(document.querySelector('#main .track-list')), title: document.querySelector('#main .hero-title').textContent };`);
      await run(`await mpfy.store.updatePlaylist(${JSON.stringify(id)}, { name: 'Viaggio lungo' }); return true;`);
      await sleep(800);
      const after = await run(`return { list: window.__tag(document.querySelector('#main .track-list')), title: document.querySelector('#main .hero-title').textContent, bar: document.querySelector('#main .topbar-title').textContent };`);
      check(after.title === 'Viaggio lungo' && after.bar === 'Viaggio lungo' && after.list === before.list, `a playlist renamed: the header shows the new name, the list of songs stays the same element (${JSON.stringify(before)} -> ${JSON.stringify(after)})`);
    });
  } finally {
    if (b) b.close();
    mock.kill();
  }
}
