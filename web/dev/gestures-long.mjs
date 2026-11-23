// Long lists at the scale of a big library, on a phone screen with touch: the mock source with
// 100,000 songs, all of them liked, and a playlist of 20,000 (MOCK_TRACKS=100000). A mock that
// does not grow them by itself is put behind a small proxy here that adds them to its library
// answers (every other request passes as it is).
//   end      Libreria > Brani scrolled to its end holds at most 150 rows in the page, the last song
//            among them
//   liked    "Brani che ti piacciono" with 100,000 songs opens in under 1 s at CPU throttling 6
//   fling    Libreria > Brani flung, a tap while it glides: nothing plays or opens; a long press
//            once it stopped: one menu, one Back takes it away
//   redraw   deep in Libreria > Brani: a play report moves no frame and keeps the row under the
//            finger the same element; a song added above the screen keeps the scroll offset, the
//            page never shrinks and the song is in the list; deep in La tua libreria (albums,
//            artists, playlists: rows that stay the same elements when they move), a playlist
//            added above the screen keeps the scroll offset too (the browser moves nothing)
//   focus    Tab from the first row through 40 rows: the focus always on a row of the list in the
//            page and on screen; the focused row scrolled far away keeps the focus
//   back     back to Libreria > Brani and to "Brani che ti piacciono" left deep in them: the same
//            offset, and the rows there in the first frame of the page
//   steps    the window's steps while Libreria > Brani scrolls: p95 at most 16 ms at CPU
//            throttling 6
//   edit     "Modifica playlist" of the 20,000-song playlist: a drag across screens moves one
//            song, the arrow keys move it one place at a time with the focus on its handle
//   height   a list of 300,000 rows is 300,000 times the row height tall, its last row drawn at
//            its place
//   anchor   a list on its own (no page around it that puts its offset back), rows that stay the
//            same elements when they move: an item added above the screen keeps the scroll
//            offset (the browser's scroll anchoring does not follow the rows)
//   order    the Library page's order kept in one pass (keepOrder) equals the order of its first
//            form on 400 random lists, and the songs moved in place (moveSorted) equal a sort afresh
//   sorts    a play report with Libreria > Brani open (Recenti) and with "Brani che ti piacciono"
//            open: the lists sort nothing of 1,000 items or more and stringify no list of their
//            rows (nothing of 50,000 characters or more; the store says what moved: store.changed())
//
//   node web/dev/gestures-long.mjs <out dir> [--only name|name]
//
// Prints PASS/FAIL lines and fails=<n> (exit 1 on a failure); the same lines and the details go to
// <out dir>/gestures-long.log.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { startMock, startBrowser, tap, sleep, logger } from './gesture-lib.mjs';

const outDir = path.resolve(process.argv[2] || '.');
fs.mkdirSync(outDir, { recursive: true });
const onlyAt = process.argv.indexOf('--only');
const only = onlyAt > 0 ? process.argv[onlyAt + 1].split('|') : null;
const L = logger(path.join(outDir, 'gestures-long.log'));
let fails = 0;
function check(ok, name, detail) {
  const line = `${ok ? 'PASS' : 'FAIL'} ${name}`;
  console.log(line);
  L.log(line);
  if (detail !== undefined) L.log('     ', detail);
  if (!ok) fails++;
}

const N = 100000; // songs, and likes
const PL = 20000; // entries of the long playlist
const PL_NAME = 'Ventimila';

// ---- the big library ----
const T0 = Date.UTC(2026, 0, 1);
const idOf = (i) => `e${i.toString(16).padStart(23, '0')}`;
/** A song of the big library, shaped as the mock's own (no cover, no signature: the merge stays quick). */
function bigTrack(i) {
  const al = Math.floor(i / 12);
  const artist = `Artista ${String(al % 500).padStart(3, '0')}`;
  return {
    id: idOf(i),
    fileHash: idOf(i),
    title: `Brano ${String(i).padStart(6, '0')}`,
    artist,
    album: `Raccolta ${String(al).padStart(5, '0')}`,
    albumArtist: artist,
    trackNo: (i % 12) + 1,
    discNo: 1,
    year: 2000 + (al % 25),
    duration: 150 + (i % 211) + ((i * 7) % 10) / 10,
    format: 'wav',
    mime: 'audio/wav',
    codec: 'wav',
    sampleRate: 44100,
    bitDepth: 16,
    fakeLossless: false,
    equivKbps: null,
    size: 1000000,
    bitrate: 1411200,
    lossless: true,
    addedAt: T0 - i * 1000,
    coverId: null,
    qualities: { low: false, normal: false, high: false },
    score: 1000,
    mine: true,
    others: false,
  };
}
let bigTracks = null;
/** What the library answer lacks of the big library: N more songs, all liked, the long playlist. */
function grow(j) {
  if (Array.isArray(j.tracks) && j.tracks.length < N) {
    if (!bigTracks) bigTracks = Array.from({ length: N }, (_, i) => bigTrack(i));
    j.tracks = j.tracks.concat(bigTracks);
  }
  if (Array.isArray(j.likes) && j.likes.length < N) {
    j.likes = j.likes.concat(Array.from({ length: N }, (_, i) => ({ id: idOf(i), at: T0 - i })));
  }
  if (Array.isArray(j.playlists) && !j.playlists.some((p) => (p.trackIds || []).length >= PL)) {
    j.playlists = j.playlists.concat([{ id: 'f0f0f0f0f0f0f0f0', name: PL_NAME, description: '', trackIds: Array.from({ length: PL }, (_, i) => idOf(i)), createdAt: T0, updatedAt: T0 }]);
  }
}

/** A proxy in front of the mock that grows its library answers (the rest passes untouched). */
async function startProxy(target) {
  const t = new URL(target);
  const srv = http.createServer((req, res) => {
    const lib = req.method === 'GET' && /^\/s\/[^/]+\/api\/library(\?|$)/.test(req.url);
    // The page talks to the proxy as to the mock itself: the mock checks that a change comes from its own origin.
    const headers = { ...req.headers, host: t.host };
    if (headers.origin) headers.origin = t.origin;
    if (headers.referer) headers.referer = headers.referer.replace(/^https?:\/\/[^/]+/, t.origin);
    if (lib) delete headers['accept-encoding'];
    const up = http.request({ host: t.hostname, port: t.port, method: req.method, path: req.url, headers }, (r) => {
      if (!lib || r.statusCode !== 200) {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
        return;
      }
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        grow(j);
        const body = Buffer.from(JSON.stringify(j));
        const hd = { ...r.headers, 'content-length': String(body.length) };
        delete hd['content-encoding'];
        delete hd['transfer-encoding'];
        res.writeHead(200, hd);
        res.end(body);
      });
    });
    up.on('error', () => {
      try {
        res.writeHead(502);
        res.end();
      } catch {
        /* gone */
      }
    });
    req.pipe(up);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, base: `http://127.0.0.1:${srv.address().port}` };
}

const { mock, base: mockBase } = await startMock({ MOCK_SOURCES: '1', MOCK_TRACKS: String(N) });
const srcId = (await (await fetch(`${mockBase}/local/sources`)).json()).sources[0].id;
const probe = await (await fetch(`${mockBase}/s/${srcId}/api/library`)).json();
const bigEnough = probe.tracks.length >= N && probe.likes.length >= N && probe.playlists.some((p) => p.trackIds.length >= PL);
let proxy = null;
if (!bigEnough) proxy = await startProxy(mockBase);
const base = proxy ? proxy.base : mockBase;
L.log(`the mock gives ${probe.tracks.length} songs, ${probe.likes.length} likes, a longest playlist of ${Math.max(0, ...probe.playlists.map((p) => p.trackIds.length))}: ${proxy ? 'grown here by a proxy' : 'used as it is'}`);

// ---- the page ----
let b = null;
const run = (js) => b.evaluate(js);
const touch = (type, points) => b.S('Input.dispatchTouchEvent', { type, touchPoints: points });
const throttle = (rate) => b.S('Emulation.setCPUThrottlingRate', { rate });

// The window's steps timed: the animation frame of the long lists (vlist.js) with the style and
// layout it brings, and whether the rows drawn of Libreria > Brani changed in it (one came or went).
const HOOK = `(() => {
  const raf = window.requestAnimationFrame.bind(window);
  window.__steps = null;
  window.requestAnimationFrame = function (fn) {
    if (typeof fn !== 'function' || !/\\.step\\(\\)/.test(Function.prototype.toString.call(fn))) return raf(fn);
    return raf((ts) => {
      if (!window.__steps) return fn(ts);
      const list = document.querySelector('#main .lib-list .vlist');
      const ends = () => (list ? [list.querySelector('.track-row'), list.lastElementChild && list.lastElementChild.previousElementSibling, list.childElementCount] : []);
      const was = ends();
      const t0 = performance.now();
      fn(ts);
      void document.documentElement.offsetHeight;
      const now = ends();
      window.__steps.push([performance.now() - t0, now.some((x, i) => x !== was[i])]);
    });
  };
})();`;

/** The app at route with the big library loaded (and the Library page's filter and sort set first). */
async function load(route, { filter = 'track', sort = 'alpha' } = {}) {
  await b.go(`${base}/?nosw`, 300);
  await run(`localStorage.setItem('mpfy.lib.filter', JSON.stringify(${JSON.stringify(filter)})); localStorage.setItem('mpfy.lib.sort', JSON.stringify(${JSON.stringify(sort)})); return true;`);
  await b.go(`${base}${route}${route.includes('?') ? '&' : '?'}nosw`, 300);
  const n = await run(`for (let i = 0; i < 1800 && !(window.mpfy && mpfy.store.loaded && mpfy.store.lib.tracks.length >= ${N}); i++) await new Promise((r) => setTimeout(r, 100)); return window.mpfy ? mpfy.store.lib.tracks.length : 0;`);
  await sleep(1500);
  await run(INSTR);
  return n;
}
const INSTR = `window.__n = window.__n || 0; window.__tag = (el) => (el ? el.__t || (el.__t = ++window.__n) : null); return true;`;
const libList = `document.querySelector('#main .lib-list .vlist')`;
/** The Library page's song list: its rows drawn, the songs in it, its height. */
const libState = () =>
  run(`const box = document.querySelector('#main .lib-list'); if (!box) return null; const l = ${libList} || box; const rows = [...box.querySelectorAll('.track-row')];
    const n = rows.length && rows[0].hasAttribute('aria-setsize') ? Number(rows[0].getAttribute('aria-setsize')) : mpfy.store.lib.tracks.length;
    return { rows: rows.length, n, first: rows.length ? Number(rows[0].dataset.ci) : -1, last: rows.length ? Number(rows[rows.length - 1].dataset.ci) : -1, height: l.offsetHeight, top: Math.round(document.getElementById('main').scrollTop) };`);
/** The row at a height of the screen in the page now in #main: its index, song and element tag. */
const rowAt = (y) =>
  run(`const v = [...document.getElementById('main').children].find((k) => !k.classList.contains('view-leaving')); if (!v) return null;
    const r = [...v.querySelectorAll('.vlist > .track-row')].find((x) => { const q = x.getBoundingClientRect(); return q.top <= ${y} && q.bottom > ${y}; });
    return r ? { ci: Number(r.dataset.ci), tid: r.dataset.tid, tag: window.__tag(r), title: r.querySelector('.tr-title-text').textContent } : null;`);
const layers = () => run(`return document.querySelectorAll('#layers > .layer:not(.closing)').length;`);
const look = () => run(`return { path: location.pathname, layers: document.querySelectorAll('#layers > .layer:not(.closing)').length, index: mpfy.player.state.index, playing: mpfy.player.state.playing };`);
/** Scrolls #main so that the row of index i of the Library page's list is at height y of the screen. */
const scrollToRow = (i, y = 400) =>
  run(`const m = document.getElementById('main'); const l = ${libList}; const H = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--vrow-track'));
    const top = l.getBoundingClientRect().top - m.getBoundingClientRect().top + m.scrollTop; m.scrollTop = top + ${i} * H - (${y} - m.getBoundingClientRect().top) + H / 2;
    await new Promise((r) => setTimeout(r, 500)); return Math.round(m.scrollTop);`);

const scenarios = [];
const scenario = (name, fn) => scenarios.push({ name, fn });

scenario('end', async () => {
  const n = await load('/library');
  for (let i = 0; i < 30; i++) {
    await run(`const m = document.getElementById('main'); m.scrollTop = m.scrollHeight; return true;`);
    await sleep(300);
    const s = await libState();
    if (s && s.last >= n - 1) break;
  }
  await sleep(500);
  const s = await libState();
  check(!!s && s.rows <= 150 && s.last === n - 1 && s.n === n, `Libreria > Brani scrolled to its end: at most 150 rows in the page, the last song among them (${JSON.stringify(s)}, ${n} songs)`, s);
});

scenario('liked', async () => {
  await load('/library');
  const n = await run('return mpfy.store.d.likedIds.length;');
  await throttle(6);
  const r = await run(`const t0 = performance.now(); mpfy.navigate('/liked');
    for (let i = 0; i < 600; i++) { await new Promise((x) => requestAnimationFrame(x)); const v = document.querySelector('#main > .detail-liked:not(.view-leaving)'); if (v && v.querySelector('.vlist .track-row, .track-list .track-row')) break; }
    const t = performance.now() - t0; const v = document.querySelector('#main > .detail-liked'); return { ms: Math.round(t), rows: v ? v.querySelectorAll('.track-row').length : 0 };`);
  await throttle(1);
  await sleep(800);
  check(n >= N && r.rows > 0 && r.ms < 1000, `"Brani che ti piacciono" with ${n} songs opens in under 1 s at CPU throttling 6 (${r.ms} ms to its first frame with rows, ${r.rows} rows in the page)`, r);
});

scenario('fling', async () => {
  await load('/library', { sort: 'recent' });
  await scrollToRow(30000);
  const watch = () =>
    run(`const el = document.getElementById('main'); window.__sc = []; window.__ups = []; window.__downs = [];
      if (!window.__scOn) { window.__scOn = true; el.addEventListener('scroll', () => window.__sc && window.__sc.push([Math.round(performance.now()), Math.round(el.scrollTop)]), { passive: true });
      window.addEventListener('touchend', () => window.__ups && window.__ups.push(Math.round(performance.now())), true);
      window.addEventListener('touchstart', () => window.__downs && window.__downs.push(Math.round(performance.now())), true); }
      return true;`);
  const glided = () =>
    run(`const lift = window.__ups[0]; const press = window.__downs[1]; if (lift == null || press == null) return false;
      const moving = window.__sc.filter((e) => e[0] > lift && e[0] <= press + 5); if (moving.length < 2) return false;
      const a = moving[moving.length - 2]; const z = moving[moving.length - 1];
      return z[0] >= press - 20 && Math.abs(z[1] - a[1]) / Math.max(1, z[0] - a[0]) >= 0.3;`);
  let tries = 0;
  let hits = 0;
  for (let i = 0; i < 6 && tries < 2; i++) {
    await sleep(800);
    await watch();
    const p0 = await look();
    // A fling whose last move and lift go out together, then a tap 30 ms later.
    const x = 180;
    const y = 640;
    const dist = 460;
    await touch('touchStart', [{ x, y, id: 1 }]);
    const t0 = performance.now();
    for (;;) {
      await sleep(8);
      const d = Math.min(dist, ((performance.now() - t0) / 1000) * 6000);
      const p = [{ x, y: y - d, id: 1 }];
      if (d >= dist) {
        await Promise.all([touch('touchMove', p), touch('touchEnd', [])]);
        break;
      }
      await touch('touchMove', p);
    }
    await sleep(30);
    await tap(b, 140, 420);
    await sleep(1200);
    if (!(await glided())) continue;
    tries++;
    const p1 = await look();
    if (p1.path !== p0.path || p1.layers !== p0.layers || p1.index !== p0.index) hits++;
  }
  check(tries > 0 && hits === 0, `Libreria > Brani deep in ${N} songs, flung: a tap while it glides plays and opens nothing (${tries} taps on a gliding list, ${hits} did something)`, { tries, hits });
  // At rest: a finger held on a row opens its menu once, one Back takes it away.
  await sleep(1500);
  const r = await rowAt(420);
  const l0 = await layers();
  const s0 = await look();
  await touch('touchStart', [{ x: 120, y: 420, id: 1 }]);
  await sleep(900);
  await touch('touchEnd', []);
  await sleep(900);
  const opened = (await layers()) - l0;
  const items = await run(`const ls = [...document.querySelectorAll('#layers > .layer:not(.closing)')]; const t = ls[ls.length - 1]; return t ? [...t.querySelectorAll('.menu-item')].map((x) => x.textContent) : [];`);
  await run('history.back(); return true;');
  await sleep(900);
  const left = (await layers()) - l0;
  const s1 = await look();
  check(!!r && opened === 1 && left === 0 && items.some((x) => /Mi piace/.test(x)) && s1.path === s0.path && s1.index === s0.index, `then at rest, a long press on "${r && r.title}": one menu, one Back takes it away, nothing plays (${JSON.stringify({ opened, left, first: items[0] })})`, { opened, left, items });
});

scenario('redraw', async () => {
  await load('/library', { sort: 'recent' });
  await scrollToRow(50000);
  const FRAME = `const m = document.getElementById('main'); const el = document.elementFromPoint(180, 420); const row = el && el.closest('.track-row'); return [Math.round(m.scrollTop), m.scrollHeight, row ? window.__tag(row) : null, row ? row.dataset.tid : null];`;
  const frames = async (act) => {
    await run(`window.__fr = []; let on = true; const tick = () => { window.__fr.push((() => { ${FRAME} })()); if (on) requestAnimationFrame(tick); }; requestAnimationFrame(tick); window.__frStop = () => { on = false; return window.__fr; }; return true;`);
    await act();
    await sleep(1500);
    return run('return window.__frStop();');
  };
  const emits = () => run('return window.__emits || 0;');
  await run(`if (!window.__emitsOn) { window.__emitsOn = true; window.__emits = 0; mpfy.store.subscribe(() => window.__emits++); } return true;`);
  // A play report of the song under the finger (a song of the source: one the proxy added is not
  // on it, and the source refuses its play): in Recenti it would go to the top of a list sorted afresh.
  const e0 = await emits();
  const rec = await frames(async () => {
    await run(`const el = document.elementFromPoint(180, 420).closest('.track-row'); const own = (id) => !/^e0{6}/.test(id);
      const id = own(el.dataset.tid) ? el.dataset.tid : mpfy.store.lib.tracks.find((t) => own(t.id)).id; mpfy.store.played(id, { type: 'library', id: null }); return true;`);
    for (let i = 0; i < 200 && (await emits()) === e0; i++) await sleep(50);
  });
  const odd = rec.filter((f) => f[0] !== rec[0][0] || f[1] !== rec[0][1] || f[2] !== rec[0][2] || f[3] !== rec[0][3]);
  const e1 = await emits();
  check(e1 > e0 && rec.length > 10 && !!rec[0][2] && odd.length === 0, `Libreria > Brani (Recenti) deep in ${N} songs, a play report: no frame moves, the row under the finger stays the same element (${rec.length} frames, ${e1 - e0} emits, ${odd.length} odd ${JSON.stringify(odd.slice(0, 3))})`, { first: rec[0], odd: odd.slice(0, 5) });
  // A song added above the screen (Alfabetico: it goes right after the song it follows).
  await load('/library', { sort: 'alpha' });
  await scrollToRow(25000);
  const prevTitle = await run(`const r = ${libList}.querySelector('.track-row[data-ci="25000"]'); return r ? r.querySelector('.tr-title-text').textContent : null;`);
  await scrollToRow(50000);
  const s0 = await libState();
  const name = `${prevTitle} bis`;
  const wav = Buffer.alloc(44 + 3000);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + 3000, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(11025, 24);
  wav.writeUInt32LE(22050, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(3000, 40);
  for (let i = 0; i < 3000; i++) wav[44 + i] = (i * 13) & 255;
  const up = await fetch(`${mockBase}/s/${srcId}/api/upload/${encodeURIComponent(`${name}.wav`)}`, { method: 'PUT', body: wav });
  const e2 = await emits();
  const rec2 = await frames(async () => {
    await run('mpfy.store.refresh(); return true;');
    for (let i = 0; i < 200 && (await emits()) === e2; i++) await sleep(100);
    await sleep(800);
  });
  const s1 = await libState();
  const moved = rec2.filter((f) => f[0] !== rec2[0][0] || f[1] < rec2[0][1]);
  const at = await run(`const t = mpfy.store.lib.tracks.find((x) => x.title === ${JSON.stringify(name)}); return t ? t.id : null;`);
  check(up.ok && !!at && moved.length === 0 && s1.n === s0.n + 1 && s1.top === s0.top && s1.height > s0.height, `Libreria > Brani (Alfabetico) deep in it, "${name}" added above the screen: the scroll offset stays, no frame shrinks the page, the list holds one more song (${JSON.stringify({ before: s0, after: s1, moved: moved.slice(0, 3) })})`, { s0, s1, moved: moved.slice(0, 5) });
  // The song is in the list where the sort puts it: right after the one it follows.
  await scrollToRow(25001);
  const near = await run(`const l = ${libList}; return [...l.querySelectorAll('.track-row')].map((r) => [Number(r.dataset.ci), r.querySelector('.tr-title-text').textContent]).filter((x) => x[0] >= 24999 && x[0] <= 25002);`);
  check(near.some((x) => x[1] === name) && near.findIndex((x) => x[1] === name) === near.findIndex((x) => x[1] === prevTitle) + 1, `... and drawn right after "${prevTitle}" (${JSON.stringify(near)})`, near);
  // La tua libreria (Alfabetico): its rows keep their elements when an item above them comes in, so
  // the rows on screen move down by one row and the browser must not scroll to follow them.
  await load('/library', { filter: null, sort: 'alpha' });
  const coll = `document.querySelector('#main .lib-list .vlist')`;
  const collAt = (y) => run(`const r = [...${coll}.children].find((x) => { const q = x.getBoundingClientRect(); return x.classList.contains('lib-row') && q.top <= ${y} && q.bottom > ${y}; }); return r ? { i: Number(r.dataset.i), tag: window.__tag(r), name: r.querySelector('.lib-name').textContent } : null;`);
  const collN = await run(`const r = ${coll}.querySelector('.lib-row'); return r ? Number(r.getAttribute('aria-setsize')) : 0;`);
  const mid = Math.floor(collN / 2);
  const H2 = await run(`return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--vrow-lib'));`);
  const scrollColl = (i) => run(`const m = document.getElementById('main'); const l = ${coll}; const top = l.getBoundingClientRect().top - m.getBoundingClientRect().top + m.scrollTop; m.scrollTop = top + ${i} * ${H2} - 300; await new Promise((r) => setTimeout(r, 600)); return Math.round(m.scrollTop);`);
  await scrollColl(Math.floor(mid / 2));
  const above = await run(`const r = ${coll}.querySelector('.lib-row[data-i="${Math.floor(mid / 2)}"]'); return r ? r.querySelector('.lib-name').textContent : null;`);
  await scrollColl(mid);
  const c0 = await collAt(420);
  const t0 = await run(`return { top: Math.round(document.getElementById('main').scrollTop), h: document.getElementById('main').scrollHeight };`);
  const e3 = await emits();
  const plName = `${above} bis`;
  await run(`mpfy.store.createPlaylist(${JSON.stringify(plName)}); return true;`);
  for (let i = 0; i < 200 && (await emits()) === e3; i++) await sleep(50);
  await sleep(1500);
  const c1 = await collAt(420);
  const t1 = await run(`return { top: Math.round(document.getElementById('main').scrollTop), h: document.getElementById('main').scrollHeight };`);
  const n1 = await run(`const r = ${coll}.querySelector('.lib-row'); return r ? Number(r.getAttribute('aria-setsize')) : 0;`);
  check(!!c0 && !!c1 && n1 === collN + 1 && t1.top === t0.top && t1.h === t0.h + H2 && c1.i === c0.i && c1.tag !== c0.tag, `La tua libreria (Alfabetico) deep in its ${collN} rows, the playlist "${plName}" added above the screen: the scroll offset stays (${t0.top} -> ${t1.top}), the page one row taller, the row that was under the finger one row lower (${JSON.stringify({ c0, c1, n1 })})`, { c0, c1, t0, t1 });
});

scenario('focus', async () => {
  await load('/library');
  await run(`const r = ${libList}.querySelector('.track-row .tr-main'); r.focus(); return true;`);
  const seen = [];
  let bad = 0;
  for (let i = 0; i < 80; i++) {
    await b.S('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await b.S('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await sleep(60);
    const f = await run(`const a = document.activeElement; const row = a && a.closest('.track-row'); const l = ${libList}; const m = document.getElementById('main').getBoundingClientRect(); const r = a.getBoundingClientRect();
      return { ci: row ? Number(row.dataset.ci) : null, inList: !!row && !!l && l.contains(row), conn: a.isConnected, view: r.top >= m.top - 1 && r.bottom <= m.bottom + 1, what: a.className };`);
    seen.push(f.ci);
    if (!f.inList || !f.conn || !f.view) bad++;
  }
  const reached = Math.max(...seen.filter((x) => x != null));
  check(bad === 0 && reached >= 40, `Libreria > Brani, Tab from the first row 80 times: the focus always on a row of the list, in the page and on screen, up to row ${reached + 1} (${bad} times not)`, { seen: seen.join(','), bad });
  // The focused row scrolled far away stays in the page with the focus.
  const f0 = await run(`const a = document.activeElement; window.__focused = a; const m = document.getElementById('main'); m.scrollTop += 60000; await new Promise((r) => setTimeout(r, 800)); return { same: document.activeElement === a, conn: a.isConnected, ci: Number(a.closest('.track-row').dataset.ci), top: Math.round(m.scrollTop) };`);
  const mid = await rowAt(400);
  check(f0.same && f0.conn && !!mid && mid.ci > f0.ci + 100, `the focused row (${f0.ci + 1}) left far behind by a scroll (row ${mid && mid.ci + 1} on screen): it keeps the focus, still in the page (${JSON.stringify(f0)})`, f0);
});

scenario('back', async () => {
  // Libreria > Brani left deep in it, an album, back.
  await load('/library');
  for (const where of ['library', 'liked']) {
    if (where === 'liked') {
      await run(`mpfy.navigate('/liked'); return true;`);
      await sleep(1500);
      await run(INSTR);
      await run(`const m = document.getElementById('main'); m.scrollTop = 60 * 40000; await new Promise((r) => setTimeout(r, 600)); return true;`);
    } else await scrollToRow(40000);
    await sleep(400);
    const before = await rowAt(400);
    const top0 = await run(`return Math.round(document.getElementById('main').scrollTop);`);
    const album = await run(`return [...mpfy.store.d.albums.values()][0].id;`);
    await run(`mpfy.navigate('/album/' + encodeURIComponent(${JSON.stringify(album)})); return true;`);
    await sleep(1200);
    // The first frame of the page coming back: the rows at the middle of the screen in it.
    const cls = where === 'library' ? 'view-library' : 'detail-liked';
    await run(`window.__first = null; const m = document.getElementById('main');
      const mo = new MutationObserver(() => { const v = [...m.children].find((k) => k.classList.contains(${JSON.stringify(cls)}) && !k.classList.contains('view-leaving'));
        if (!v || window.__first) return; mo.disconnect();
        requestAnimationFrame(() => { const mr = m.getBoundingClientRect(); const rows = [...v.querySelectorAll('.vlist > .track-row')]; const mid = mr.top + mr.height / 2;
          const r = rows.find((x) => { const q = x.getBoundingClientRect(); return q.top <= mid && q.bottom > mid; });
          window.__first = { top: Math.round(m.scrollTop), rows: rows.length, ci: r ? Number(r.dataset.ci) : null }; }); });
      mo.observe(m, { childList: true }); history.back(); return true;`);
    await sleep(1500);
    const first = await run('return window.__first;');
    await run(INSTR);
    const after = await rowAt(400);
    const top1 = await run(`return Math.round(document.getElementById('main').scrollTop);`);
    const label = where === 'library' ? 'Libreria > Brani' : '"Brani che ti piacciono"';
    check(!!before && !!after && Math.abs(top1 - top0) <= 1 && after.tid === before.tid, `${label} left at row ${before && before.ci + 1}, an album, back: the same offset and the same song there (${top0} -> ${top1}, ${before && before.title} -> ${after && after.title})`, { before, after, top0, top1 });
    check(!!first && first.rows > 0 && first.ci != null && Math.abs(first.ci - before.ci) <= 8, `... and its first frame already shows the rows there (${JSON.stringify(first)})`, first);
  }
});

scenario('steps', async () => {
  await load('/library');
  // Three runs of 160 frames from three places: the best p95 counts (the PC runs other work too, and
  // a frame it took is not the list's), every run is logged.
  const runs = [];
  for (const from of [0, 1200000, 2400000]) {
    await run(`document.getElementById('main').scrollTop = ${from}; await new Promise((r) => setTimeout(r, 600)); return true;`);
    // The garbage of loading 100,000 songs collected first: its collection is not the list's cost.
    await b.S('HeapProfiler.collectGarbage').catch(() => {});
    await sleep(300);
    await throttle(6);
    await run(`window.__steps = []; const m = document.getElementById('main');
      for (let i = 0; i < 160; i++) { await new Promise((r) => requestAnimationFrame(r)); m.scrollTop += 90; }
      await new Promise((r) => setTimeout(r, 300)); return true;`);
    await throttle(1);
    const steps = await run('const s = window.__steps; window.__steps = null; return s;');
    const moved = steps.filter((x) => x[1]).map((x) => x[0]).sort((x, y) => x - y);
    const p95 = moved.length ? moved[Math.min(moved.length - 1, Math.floor(moved.length * 0.95))] : Infinity;
    const median = moved.length ? moved[Math.floor(moved.length / 2)] : Infinity;
    runs.push({ from, n: moved.length, median: Math.round(median * 10) / 10, p95: Math.round(p95 * 10) / 10, all: moved.map((x) => Math.round(x * 10) / 10).join(',') });
  }
  const best = runs.reduce((x, y) => (y.p95 < x.p95 ? y : x));
  check(best.n >= 20 && best.p95 <= 16, `Libreria > Brani scrolled 160 frames at CPU throttling 6: the window's steps take ${best.median} ms (median), ${best.p95} ms (p95), at most 16 (${best.n} steps; the three runs' p95 ${runs.map((r) => r.p95).join(', ')})`, runs);
});

scenario('edit', async () => {
  await load('/library');
  const plId = await run(`return mpfy.store.lib.playlists.find((p) => p.trackIds.length >= ${PL}).id;`);
  await run(`mpfy.navigate('/playlist/' + ${JSON.stringify(plId)}); return true;`);
  await sleep(2000);
  const name = await run(`return mpfy.store.d.playlists.get(${JSON.stringify(plId)}).name;`);
  await run(`document.querySelector('.actions [aria-label=' + JSON.stringify('Altre opzioni per ' + ${JSON.stringify(name)}) + ']').click(); await new Promise((r) => setTimeout(r, 700));
    [...document.querySelectorAll('.layer-sheet .menu-item')].find((x) => x.textContent.includes('Modifica playlist')).click(); await new Promise((r) => setTimeout(r, 1500)); return true;`);
  const orig = await run(`return mpfy.store.d.playlists.get(${JSON.stringify(plId)}).trackIds.map((id) => mpfy.store.track(id)).filter(Boolean).map((t) => t.title);`);
  const drawn = () => run(`return [...document.querySelectorAll('#main .edit-list > .edit-row')].map((r) => [Number(r.dataset.i), r.querySelector('.tr-title-text').textContent]);`);
  const rows0 = await drawn();
  /** The drawn rows against the list `want` (titles by index). */
  const matches = (rows, want) => rows.length > 0 && rows.every(([i, t]) => want[i] === t);
  // The handle of row 3 dragged to the bottom edge and held there: the list scrolls by itself.
  // The row dragged is followed by its element (a title may come twice in a list).
  const h = await run(`const r = [...document.querySelectorAll('#main .edit-list > .edit-row')].find((x) => x.dataset.i === '3'); window.__dragged = r; const q = r.querySelector('.drag-handle').getBoundingClientRect(); return { x: Math.round(q.left + q.width / 2), y: Math.round(q.top + q.height / 2), title: r.querySelector('.tr-title-text').textContent };`);
  const bottom = await run(`return Math.round(document.getElementById('main').getBoundingClientRect().bottom);`);
  await touch('touchStart', [{ x: h.x, y: h.y, id: 1 }]);
  for (let y = h.y; y < bottom - 6; y += 24) {
    await touch('touchMove', [{ x: h.x, y, id: 1 }]);
    await sleep(16);
  }
  await touch('touchMove', [{ x: h.x, y: bottom - 6, id: 1 }]);
  await sleep(3000);
  await touch('touchEnd', []);
  await sleep(900);
  const st = await run(`const r = window.__dragged; return { i: r && r.isConnected ? Number(r.dataset.i) : null, top: Math.round(document.getElementById('main').scrollTop) };`);
  const want = orig.slice();
  if (st.i != null) {
    want.splice(3, 1);
    want.splice(st.i, 0, h.title);
  }
  const rows1 = await drawn();
  check(orig.length >= PL && rows0.length > 0 && rows0.length <= 150 && st.i != null && st.i > 3 + 20 && matches(rows1, want), `"Modifica playlist" of ${orig.length} songs (${rows0.length} rows in the page): "${h.title}" dragged down across screens to place ${st.i}: that song alone moved (${rows1.length} rows checked, scrolled to ${st.top})`, { st, rows1: rows1.slice(0, 6) });
  // The arrow keys on its handle: one place each, the focus kept on it.
  await run(`window.__dragged.querySelector('.drag-handle').focus(); return true;`);
  const key = async (k) => {
    await b.S('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: k === 'ArrowDown' ? 40 : 38 });
    await b.S('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: k === 'ArrowDown' ? 40 : 38 });
    await sleep(250);
    return run(`const a = document.activeElement; const r = a && a.closest('.edit-row'); return { handle: !!a && a.classList.contains('drag-handle'), title: r ? r.querySelector('.tr-title-text').textContent : null, i: r ? Number(r.dataset.i) : null };`);
  };
  const k1 = await key('ArrowDown');
  const k2 = await key('ArrowDown');
  const k3 = await key('ArrowDown');
  const k4 = await key('ArrowUp');
  const want2 = want.slice();
  want2.splice(st.i, 1);
  want2.splice(st.i + 2, 0, h.title);
  const rows2 = await drawn();
  const ks = [k1, k2, k3, k4];
  check(ks.every((k) => k.handle && k.title === h.title) && ks.map((k) => k.i).join(',') === [st.i + 1, st.i + 2, st.i + 3, st.i + 2].join(',') && matches(rows2, want2), `... then ArrowDown three times and ArrowUp once on its handle: one place each (${ks.map((k) => k.i).join(', ')}), the focus on its handle, the rest in place`, { ks, rows2: rows2.slice(0, 6) });
  await run('history.back(); return true;');
  await sleep(800);
});

scenario('height', async () => {
  await load('/library');
  const r = await run(`const { vlist } = await import('/js/vlist.js');
    const box = document.createElement('div'); box.style.cssText = 'position: fixed; left: 0; top: 0; width: 360px; height: 600px; overflow: auto; z-index: 99; background: #000;';
    document.body.append(box);
    const items = Array.from({ length: 300000 }, (_, i) => i);
    const v = vlist({ scroller: box, items, keyOf: (i) => i, sigOf: (i) => String(i), renderRow: (i) => { const d = document.createElement('div'); d.className = 'track-row'; d.textContent = 'riga ' + i; return d; } });
    box.append(v.el); v.mounted();
    const H = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--vrow-track'));
    const tall = v.el.offsetHeight;
    box.scrollTop = box.scrollHeight; await new Promise((x) => setTimeout(x, 300));
    const last = v.el.querySelector('[aria-posinset="300000"]');
    const out = { H, tall, want: 300000 * H, last: last ? last.offsetTop - v.el.offsetTop : null, rows: v.el.querySelectorAll('.track-row').length, scroll: box.scrollHeight };
    v.destroy(); box.remove(); return out;`);
  check(r.tall === r.want && r.last === 299999 * r.H && r.rows <= 60, `a list of 300,000 rows: ${r.tall} px tall (300,000 x ${r.H} = ${r.want}), its last row drawn at ${r.last} once scrolled to the end, ${r.rows} rows in the page`, r);
});

scenario('anchor', async () => {
  await load('/library');
  const r = await run(`const { vlist } = await import('/js/vlist.js');
    const box = document.createElement('div'); box.style.cssText = 'position: fixed; left: 0; top: 0; width: 360px; height: 600px; overflow: auto; z-index: 99; background: #000;';
    document.body.append(box);
    let items = Array.from({ length: 5000 }, (_, i) => 'riga ' + i);
    const v = vlist({ scroller: box, items, keyOf: (x) => x, sigOf: (x) => x, renderRow: (x) => { const d = document.createElement('div'); d.className = 'track-row'; d.textContent = x; return d; } });
    box.append(v.el); v.mounted();
    const frames = (n) => new Promise((ok) => { const f = () => (n-- > 0 ? requestAnimationFrame(f) : ok()); f(); });
    box.scrollTop = 2500 * 60; await new Promise((x) => setTimeout(x, 400));
    const at = () => { const b = box.getBoundingClientRect(); const e = document.elementFromPoint(b.left + 100, b.top + 300); return e && e.closest('.track-row') ? e.closest('.track-row').textContent : null; };
    const top0 = box.scrollTop; const under0 = at();
    items = items.slice(0, 1000).concat(['riga nuova'], items.slice(1000)); v.update(items);
    await frames(3); await new Promise((x) => setTimeout(x, 200));
    const out = { top0, top1: box.scrollTop, under0, under1: at(), tall: v.el.offsetHeight };
    v.destroy(); box.remove(); return out;`);
  check(r.top1 === r.top0 && r.tall === 5001 * 60 && !!r.under0 && r.under1 !== r.under0, `a list on its own, deep in 5,000 rows, an item added above the screen: the scroll offset stays (${r.top0} -> ${r.top1}), the rows under the finger move down by one (${r.under0} -> ${r.under1})`, r);
});

scenario('order', async () => {
  await load('/library');
  const r = await run(`const { keepOrder, moveSorted } = await import('/components/library-list.js');
    // The first form of keepOrder: the rows drawn sorted by their place, each new one before the
    // first drawn row that follows it in the list.
    const ref = (list, keyOf, was) => {
      const olds = list.filter((e) => was.has(keyOf(e))).sort((a, b) => was.get(keyOf(a)) - was.get(keyOf(b)));
      if (olds.length === list.length) return olds;
      const before = new Map(); const tail = []; let next = null;
      for (let i = list.length - 1; i >= 0; i--) { const e = list[i]; if (was.has(keyOf(e))) next = e; else if (next) { if (!before.has(next)) before.set(next, []); before.get(next).unshift(e); } else tail.unshift(e); }
      const out = []; for (const e of olds) { const b = before.get(e); if (b) out.push(...b); out.push(e); } return out.concat(tail);
    };
    let seed = 7; const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    let bad = 0; let badMove = 0;
    for (let round = 0; round < 400; round++) {
      const n = 1 + rnd(60);
      const all = Array.from({ length: n + 20 }, (_, i) => ({ id: 'k' + i, title: 'T' + String(1000 + rnd(9000)) + '-' + i }));
      const drawn = all.filter(() => rnd(3) > 0).slice(0, n);
      for (let i = drawn.length - 1; i > 0; i--) { const j = rnd(i + 1); [drawn[i], drawn[j]] = [drawn[j], drawn[i]]; }
      const was = new Map(drawn.map((e, i) => [e.id, i]));
      const list = all.filter(() => rnd(4) > 0);
      for (let i = list.length - 1; i > 0; i--) { const j = rnd(i + 1); [list[i], list[j]] = [list[j], list[i]]; }
      const a = keepOrder(list, (e) => e.id, was).out.map((e) => e.id).join(',');
      const b = ref(list, (e) => e.id, was).map((e) => e.id).join(',');
      if (a !== b) bad++;
      // Songs sorted by title, some of them changed: moved in place, or sorted afresh.
      const cmp = (x, y) => (x.title < y.title ? -1 : x.title > y.title ? 1 : 0);
      const now = new Map(all.map((e) => [e.id, e]));
      const sorted = all.slice().sort(cmp);
      const moved = new Set();
      for (const e of all) if (rnd(5) === 0) { moved.add(e.id); if (rnd(3)) now.set(e.id, { id: e.id, title: 'T' + String(1000 + rnd(9000)) + '-' + e.id }); else now.delete(e.id); }
      const m = moveSorted(sorted, moved, (id) => now.get(id) || null, cmp).map((e) => e.title).join(',');
      const f = [...now.values()].sort(cmp).map((e) => e.title).join(',');
      if (m !== f) badMove++;
    }
    return { bad, badMove };`);
  check(r.bad === 0 && r.badMove === 0, `the Library page's order kept in one pass equals its first form on 400 random lists (${r.bad} differ), the songs moved in place equal a sort afresh (${r.badMove} differ)`, r);
});

scenario('sorts', async () => {
  // Every sort of 1,000 items or more and every JSON.stringify of 50,000 characters or more (the
  // rows of a list) while it runs, with where it came from.
  const watch = `window.__big = []; const sort0 = Array.prototype.sort; const str0 = JSON.stringify; window.__unwatch = () => { Array.prototype.sort = sort0; JSON.stringify = str0; };
    Array.prototype.sort = function (...a) { if (this.length >= 1000) window.__big.push(['sort', this.length, new Error().stack]); return sort0.apply(this, a); };
    JSON.stringify = function (v, ...a) { const out = str0.call(JSON, v, ...a); if (out && out.length >= 50000) window.__big.push(['stringify', out.length, new Error().stack]); return out; }; return true;`;
  const report = async (label, route, file, opts) => {
    await load(route, opts);
    await run(`if (!window.__emitsOn) { window.__emitsOn = true; window.__emits = 0; mpfy.store.subscribe(() => window.__emits++); } return true;`);
    await run(`const m = document.getElementById('main'); m.scrollTop = 600000; await new Promise((r) => setTimeout(r, 800)); return true;`);
    const e0 = await run('return window.__emits;');
    await run(watch);
    await run(`const own = (id) => !/^e0{6}/.test(id); mpfy.store.played(mpfy.store.lib.tracks.find((t) => own(t.id)).id, { type: 'library', id: null }); return true;`);
    for (let i = 0; i < 200 && (await run('return window.__emits;')) === e0; i++) await sleep(50);
    await sleep(1500);
    const big = await run(`window.__unwatch(); return window.__big.map((x) => [x[0], x[1], x[2].split('\\n').slice(1, 4).join(' < ')]);`);
    const e1 = await run('return window.__emits;');
    const mine = big.filter((x) => x[2].includes(file));
    check(e1 > e0 && mine.length === 0, `${label}, a play report at ${N} songs: no sort of 1,000 items or more and no stringify of its rows in ${file} (${mine.length}: ${JSON.stringify(mine.slice(0, 3))}; ${big.length} elsewhere)`, { emits: e1 - e0, big });
  };
  await report('Libreria > Brani (Recenti)', '/library', 'library-list.js', { sort: 'recent' });
  await report('"Brani che ti piacciono"', '/liked', 'detail.js', {});
});

const errors = [];
try {
  b = await startBrowser('long');
  L.log('browser', b.version);
  await b.phone();
  await b.S('Page.addScriptToEvaluateOnNewDocument', { source: HOOK });
  for (const s of scenarios) {
    if (only && !only.includes(s.name)) continue;
    L.log(`\n== ${s.name}`);
    try {
      await s.fn();
    } catch (err) {
      check(false, `${s.name}: ran to the end`, String((err && err.stack) || err));
      await throttle(1).catch(() => {});
    }
  }
  for (const e of b.errors) errors.push(e);
  check(!errors.length, 'no page errors', errors);
} finally {
  console.log(`fails=${fails}`);
  L.log(`fails=${fails}`);
  L.flush();
  if (b) b.close();
  if (proxy) proxy.srv.close();
  mock.kill();
}
process.exit(fails ? 1 : 0);
