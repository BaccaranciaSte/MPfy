// Page changes under fast and odd input, on a phone screen with touch (and a desktop window with
// the mouse for the sidebar). Going deeper the new page slides in, back slides it out, a tab
// crossfades (web/js/swap.js); a burst of navigations must never leave two pages, a blank, or a
// page transparent or moved:
//   card-back   a card tapped and the system back pressed at once (and a little later)
//   tile        double and triple taps on a Home tile and on a card: one page, one step
//   back-twice  the system back pressed twice during a change; the back arrow double tapped
//   tabs        a tab tapped during a slide (the page cut short still fades out); tabs tapped in a
//               burst; back during a crossfade
//   fling       a fling and two fingers on the page while it changes
//   leaving     a tap on the page sliding away (back) does nothing, there or on the one under it
//   scroll      back to a page finds it where it was left, after a change interrupted too
//   frozen      the page left fades where it was: scrolled, its rows sideways, sliding only right
//   motion      the motions themselves: deeper slides in, back slides out, a tab only fades, each
//               ends within 400 ms; with reduced motion nothing moves sideways
//   desktop     the sidebar clicked in a burst with the mouse (1366 x 768)
//   people      your picture to Amici (it slides in), a person's page and Recenti the same way, a
//               double tap on a row one page, a row and the system back at once, the back arrow of
//               a person's page double tapped one step, the search opened and left in a burst
//   chats       a chat slides in; a double tap on a chat's row one page; a row and the system back
//               at once; the chat's back arrow double tapped one step; a shared playlist from its
//               card and back; a shared card on Home; "Scrivi a"; "Persone bloccate" and its back
//               arrow
// After every burst: exactly one page in #main, opaque, in place, no animation left on it, and it is
// the page of the address. During it, every frame: one or two pages, never more, never none, and
// their opacities add up to a full page (one fades in as much as the other fades out).
//
//   node web/dev/gestures-pages.mjs <out dir> [--only name|name]
//
// Prints PASS/FAIL lines and fails=<n> (exit 1 on a failure); the same lines and the details go to
// <out dir>/gestures-pages.log.
import fs from 'node:fs';
import path from 'node:path';
import { startMock, startBrowser, touchFling, tap, doubleTap, twoFingers, sleep, logger } from './gesture-lib.mjs';

const outDir = path.resolve(process.argv[2] || '.');
fs.mkdirSync(outDir, { recursive: true });
const onlyAt = process.argv.indexOf('--only');
const only = onlyAt > 0 ? process.argv[onlyAt + 1].split('|') : null;
const L = logger(path.join(outDir, 'gestures-pages.log'));
let fails = 0;
function check(ok, name, detail) {
  const line = `${ok ? 'PASS' : 'FAIL'} ${name}`;
  console.log(line);
  L.log(line);
  if (detail !== undefined) L.log('     ', detail);
  if (!ok) fails++;
}

const { mock, base } = await startMock();
let b = null;
const run = (js) => b.evaluate(js);

/** A clean page of the app at route: storage cleared, the mock's sample data, the library loaded. */
async function fresh(route = '/', q = 'sources=2', chat = 1) {
  await b.S('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }).catch(() => {});
  await b.S('Page.navigate', { url: 'about:blank' });
  await sleep(200);
  await b.S('Storage.clearDataForOrigin', { origin: base, storageTypes: 'local_storage,indexeddb,service_workers,cache_storage' });
  await fetch(`${base}/__mock/reset?${q}`);
  // The pages as they were before the chats (sources at social 1), unless a scenario asks for them.
  if (chat !== 2) await fetch(`${base}/__mock/chat?level=1`);
  await b.go(`${base}${route}${route.includes('?') ? '&' : '?'}nosw`, 600);
  await run(`for (let i = 0; i < 60 && !(window.mpfy && mpfy.store.loaded); i++) await new Promise((r) => setTimeout(r, 100)); return true;`);
  await sleep(500);
  await run(FRAMES);
}

// Every frame, the pages in #main: how many, and their opacities added up.
const FRAMES = `if (!window.__framesOn) {
    window.__framesOn = true;
    window.__frames = [];
    const tick = () => {
      const m = document.getElementById('main');
      const kids = [...m.children];
      let sum = 0;
      const t = [];
      for (const k of kids) { const cs = getComputedStyle(k); sum += Number(cs.opacity); t.push(cs.transform); }
      window.__frames.push({ n: kids.length, sum: Math.round(sum * 1000) / 1000, t, z: kids.map((k) => k.style.zIndex), leaving: kids.map((k) => k.classList.contains('view-leaving')), cls: kids.map((k) => k.className), at: Math.round(performance.now()) });
      if (window.__frames.length > 4000) window.__frames.splice(0, 2000);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  return true;`;
const resetFrames = () => run('window.__frames = []; return true;');
/** What the frames since resetFrames() saw: the most and least pages, the least opacity sum. */
const frames = () =>
  run(`const f = window.__frames || []; return { count: f.length, most: Math.max(0, ...f.map((x) => x.n)), least: f.length ? Math.min(...f.map((x) => x.n)) : 0, low: f.length ? Math.min(...f.map((x) => x.sum)) : 0, two: f.filter((x) => x.n === 2).length };`);

// The page in #main as it rests, and whether it is the page of the address.
const STATE = `const m = document.getElementById('main');
  const kids = [...m.children];
  const v = kids[0];
  if (!v) return { n: 0 };
  const cs = getComputedStyle(v);
  const r = v.getBoundingClientRect();
  const mr = m.getBoundingClientRect();
  const p = location.pathname;
  const part = p.split('/');
  const d = mpfy.store.d;
  const hero = v.querySelector('.hero-title');
  let right = false;
  if (p === '/') right = v.classList.contains('view-home');
  else if (p === '/search') right = v.classList.contains('view-search');
  else if (p === '/library') right = v.classList.contains('view-library');
  else if (p === '/impostazioni') right = v.classList.contains('view-settings') && !v.classList.contains('view-profile') && (v.querySelector('.set-top-title') || {}).textContent === 'Impostazioni';
  else if (p === '/impostazioni/profilo') right = v.classList.contains('view-profile');
  else if (p === '/liked') right = v.classList.contains('detail-liked');
  else if (p === '/amici') right = v.classList.contains('view-friends') && (location.search.includes('q=') ? !!v.querySelector('.bar-search') : !!v.querySelector('.me'));
  else if (p === '/recenti') right = v.classList.contains('view-recents');
  else if (part.length === 3 && part[1] === 'persona') right = v.classList.contains('detail-person') && !!v.querySelector('.hero-title, .empty');
  else if (part.length === 3 && part[1] === 'chat') right = v.classList.contains('view-chat') && !!v.querySelector('.chat-top');
  else if (part.length === 4 && part[1] === 'condivisa') right = v.classList.contains('detail-shared') && !!v.querySelector('.hero-title, .empty');
  else if (p === '/impostazioni/bloccate') right = v.classList.contains('view-blocked');
  else if (part.length === 3 && ['album', 'artist', 'playlist'].includes(part[1])) {
    const id = decodeURIComponent(part[2]);
    const name = part[1] === 'album' ? (d.albums.get(id) || {}).name : part[1] === 'artist' ? (d.artists.get(id) || {}).name : (mpfy.store.lib.playlists.find((x) => x.id === id) || {}).name;
    right = v.classList.contains('detail-' + part[1]) && !!hero && hero.textContent === name;
  }
  return {
    n: kids.length,
    path: p,
    right,
    view: v.className,
    opacity: cs.opacity,
    transform: cs.transform,
    anims: v.getAnimations ? v.getAnimations().length : 0,
    leaving: v.classList.contains('view-leaving') || v.getAttribute('aria-hidden') === 'true',
    inline: [v.style.position, v.style.zIndex, v.style.willChange, v.style.top, v.style.height, v.style.overflow].join('|'),
    dx: Math.round(r.left - mr.left),
    dy: Math.round(r.top - (mr.top - m.scrollTop)),
    top: Math.round(m.scrollTop),
    playing: mpfy.player.state.index,
  };`;
const state = () => run(STATE);

/** The checks after a burst: one page, opaque, in place, the right one for the address. */
async function settledOk(label, { path = null, frameCheck = true } = {}) {
  await sleep(700);
  const s = await state();
  const f = frameCheck ? await frames() : null;
  const pathOk = path == null || (typeof path === 'string' ? s.path === path : path.test(s.path));
  const ok = s.n === 1 && s.right && pathOk && s.opacity === '1' && s.transform === 'none' && s.anims === 0 && !s.leaving && s.inline === '|||||' && s.dx === 0 && s.dy === 0;
  check(ok, `${label}: one page in #main, opaque and in place, the page of ${s.path}`, s);
  if (f) check(f.count > 0 && f.least >= 1 && f.most <= 2 && f.low >= 0.95, `${label}: every frame one or two pages, never a blank (${f.count} frames, ${f.least}-${f.most} pages, opacity sum at least ${f.low})`, f);
  return s;
}

/** The center of the first element matching sel (whose text includes text), scrolled into view. */
const at = (sel, { text = null, idx = 0, fy = 0.5, scroll = true } = {}) =>
  run(`const els = [...document.querySelectorAll(${JSON.stringify(sel)})].filter((e) => !e.closest('.view-leaving') && (${JSON.stringify(text)} == null || e.textContent.includes(${JSON.stringify(text)})));
    const e = els[${idx}]; if (!e) return null; if (${scroll}) e.scrollIntoView({ block: 'center', inline: 'center' });
    await new Promise((r) => setTimeout(r, ${scroll ? 350 : 0}));
    const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height * ${fy}) };`);
/** A card of a Home shelf, by the shelf's title. */
const shelfCard = (title, idx = 1) =>
  run(`const s = [...document.querySelectorAll('#main .shelf')].find((x) => x.querySelector('h2').textContent === ${JSON.stringify(title)});
    if (!s) return null; const c = s.querySelectorAll('.card-link')[${idx}]; c.scrollIntoView({ block: 'center', inline: 'center' });
    await new Promise((r) => setTimeout(r, 350)); const q = c.getBoundingClientRect(); return { x: Math.round(q.left + q.width / 2), y: Math.round(q.top + q.height * 0.3), href: c.getAttribute('href') };`);
const systemBack = () => run('history.back(); return true;');
const navTab = (href) => at(`#nav a[href="${href}"]`, { scroll: false });
/** Taps at p1 and p2, the second pressed `apart` ms after the first (each held `hold` ms). */
async function twoTaps(p1, p2, apart, hold = 60) {
  const t0 = performance.now();
  await tap(b, p1.x, p1.y, { hold });
  const due = t0 + apart;
  if (due > performance.now()) await sleep(due - performance.now());
  await tap(b, p2.x, p2.y, { hold });
}

const scenarios = [];
const scenario = (name, fn) => scenarios.push({ name, fn });

scenario('card-back', async () => {
  for (const wait of [0, 60, 140, 260]) {
    await fresh('/');
    const c = await shelfCard('Album');
    await resetFrames();
    await tap(b, c.x, c.y, { hold: 70 });
    if (wait) await sleep(wait);
    await systemBack();
    await settledOk(`an album card tapped, the system back ${wait} ms after it`, { path: '/' });
  }
  // The card, and the back arrow tapped where it appears, 150 and 450 ms after the card.
  for (const apart of [150, 450]) {
    await fresh('/');
    const c = await shelfCard('Album');
    await resetFrames();
    await twoTaps(c, { x: 22, y: 28 }, apart);
    const s = await settledOk(`an album card tapped, then the back arrow ${apart} ms later`);
    check(apart < 400 ? s.path.startsWith('/album/') : s.path === '/', `the back arrow ${apart} ms after the card: ${apart < 400 ? 'the rest of the gesture, the album stays' : 'back on Home'} (${s.path})`);
  }
});

scenario('tile', async () => {
  for (const count of [2, 3]) {
    for (const gap of [90, 180]) {
      await fresh('/');
      const t = await at('#main .tile-link', { idx: 1, scroll: false });
      await resetFrames();
      await doubleTap(b, t.x, t.y, { gap, hold: 60, count });
      const s = await settledOk(`${count === 2 ? 'a double' : 'a triple'} tap on a Home tile (gap ${gap})`);
      check(s.path !== '/' && s.playing === -1, `${count} taps on a tile (gap ${gap}): its page, nothing plays (${s.path})`, s);
      await systemBack();
      await settledOk(`then the system back once`, { path: '/' });
    }
  }
  for (const gap of [90, 180]) {
    await fresh('/');
    const c = await shelfCard('Le tue playlist', 0);
    await resetFrames();
    await doubleTap(b, c.x, c.y, { gap, hold: 60 });
    await settledOk(`a double tap on a playlist card (gap ${gap})`, { path: /^\/(playlist\/|liked)/ });
    await systemBack();
    await settledOk('then the system back once', { path: '/' });
  }
});

scenario('back-twice', async () => {
  for (const apart of [30, 90, 160]) {
    await fresh('/');
    const c = await shelfCard('Album');
    await tap(b, c.x, c.y, { hold: 70 });
    await sleep(600);
    const owner = await at('#main .hero-meta a.meta-owner');
    await tap(b, owner.x, owner.y, { hold: 70 });
    await sleep(600);
    const was = (await state()).path;
    await resetFrames();
    await systemBack();
    await sleep(apart);
    await systemBack();
    const s = await settledOk(`an artist reached from an album from Home, the system back twice ${apart} ms apart`, { path: '/' });
    check(was.startsWith('/artist/') && s.path === '/', `two system backs during a change: two steps, Home (${was} -> ${s.path})`);
  }
  for (const gap of [100, 200]) {
    await fresh('/');
    const c = await shelfCard('Album');
    await tap(b, c.x, c.y, { hold: 70 });
    await sleep(600);
    const album = (await state()).path;
    const owner = await at('#main .hero-meta a.meta-owner');
    await tap(b, owner.x, owner.y, { hold: 70 });
    await sleep(600);
    const arrow = await at('#main .back-btn', { scroll: false });
    await resetFrames();
    await doubleTap(b, arrow.x, arrow.y, { gap, hold: 60 });
    await settledOk(`the back arrow of an artist double tapped (gap ${gap}): one step`, { path: album });
  }
});

scenario('tabs', async () => {
  for (const apart of [60, 150, 260]) {
    await fresh('/');
    const c = await shelfCard('Album');
    const cerca = await navTab('/search');
    await resetFrames();
    await twoTaps(c, cerca, apart);
    await settledOk(`an album card, then "Cerca" ${apart} ms later, during the slide`, { path: '/search' });
    // The slide cut short, the album still fades out under Cerca: never a page gone at once.
    const fade = await run(`return window.__frames.filter((x) => x.n === 2 && x.leaving[0] && x.cls[0].includes('view-detail') && x.cls[1].includes('view-search')).length;`);
    check(fade >= 3, `the slide cut short by "Cerca" (${apart} ms): the album fades out under it (${fade} frames)`);
  }
  await fresh('/');
  const tabs = { home: await navTab('/'), search: await navTab('/search'), library: await navTab('/library') };
  for (const apart of [50, 110]) {
    await resetFrames();
    for (const k of ['search', 'library', 'home', 'search', 'library']) {
      await tap(b, tabs[k].x, tabs[k].y, { hold: 40 });
      await sleep(apart);
    }
    await settledOk(`five tabs tapped ${apart} ms apart`, { path: '/library' });
  }
  // Back during a crossfade, and a tab during a slide back.
  await resetFrames();
  await tap(b, tabs.search.x, tabs.search.y, { hold: 40 });
  await sleep(60);
  await systemBack();
  await settledOk('a tab, then the system back during its crossfade', { path: '/library' });
  await fresh('/');
  const c = await shelfCard('Album');
  await tap(b, c.x, c.y, { hold: 70 });
  await sleep(600);
  await resetFrames();
  await systemBack();
  await sleep(70);
  await tap(b, tabs.library.x, tabs.library.y, { hold: 40 });
  await settledOk('the system back, then a tab during the slide back', { path: '/library' });
});

scenario('fling', async () => {
  for (const wait of [20, 90]) {
    await fresh('/');
    const c = await shelfCard('Album');
    await resetFrames();
    await tap(b, c.x, c.y, { hold: 60 });
    await sleep(wait);
    await touchFling(b, { x: 180, y: 600, dy: -420, speed: 6000 });
    await settledOk(`an album card, then a fling up ${wait} ms later`, { path: /^\/album\// });
    await resetFrames();
    await systemBack();
    await sleep(wait);
    await touchFling(b, { x: 180, y: 300, dy: 380, speed: 6000 });
    await settledOk(`the system back, then a fling down ${wait} ms later`, { path: '/' });
  }
  await fresh('/');
  const c = await shelfCard('Album');
  await resetFrames();
  await tap(b, c.x, c.y, { hold: 60 });
  await sleep(40);
  await twoFingers(b, { x: 120, y: 400 }, { x: 240, y: 520 }, { hold: 150 });
  await settledOk('an album card, then two fingers on the page during the slide', { path: /^\/album\// });
});

scenario('leaving', async () => {
  for (const wait of [30, 100]) {
    await fresh('/');
    const c = await shelfCard('Album');
    await tap(b, c.x, c.y, { hold: 70 });
    await sleep(800);
    // A song row of the album, where Home has its tiles and rows under it.
    const row = await at('#main .track-row .tr-main', { idx: 0, scroll: false });
    await resetFrames();
    await systemBack();
    await sleep(wait);
    const during = await run(`return [...document.getElementById('main').children].map((k) => k.classList.contains('view-leaving'));`);
    await tap(b, row.x, row.y, { hold: 60 });
    const s = await settledOk(`the system back, then a tap ${wait} ms later on the album sliding away`, { path: '/' });
    check(during.length === 2 && s.playing === -1 && s.path === '/', `a tap on the page sliding away (${wait} ms): nothing plays, nothing opens under it (${JSON.stringify(during)}, ${s.path}, index ${s.playing})`);
  }
});

scenario('scroll', async () => {
  await fresh('/');
  await run(`document.getElementById('main').scrollTop = 520; return true;`);
  await sleep(300);
  const c = await shelfCard('I tuoi artisti', 0);
  const top = (await state()).top;
  await resetFrames();
  await tap(b, c.x, c.y, { hold: 60 });
  await sleep(600);
  await systemBack();
  const s = await settledOk('Home scrolled, an artist, back', { path: '/' });
  check(Math.abs(s.top - top) <= 2, `back on Home: where it was left (${top} -> ${s.top})`);
  // Interrupted: the card, the back at once.
  await run(`document.getElementById('main').scrollTop = 300; return true;`);
  await sleep(300);
  const c2 = await shelfCard('Album');
  const top2 = (await state()).top;
  await resetFrames();
  await tap(b, c2.x, c2.y, { hold: 60 });
  await sleep(50);
  await systemBack();
  const s2 = await settledOk('Home scrolled, a card and the system back at once', { path: '/' });
  check(Math.abs(s2.top - top2) <= 2, `back on Home during the slide: where it was left (${top2} -> ${s2.top})`);
});

// The page left stays on screen as it was while it fades: an element of it is watched every frame
// of the change, from its place before it (window.__mark, an element of the page).
const WATCH = `const el = window.__mark; const r0 = el.getBoundingClientRect(); const seen = { before: [Math.round(r0.left), Math.round(r0.top)], during: [] }; window.__seen = seen;
  const step = () => { const m = document.getElementById('main'); if (m.children.length === 2 && el.isConnected && el.closest('.view-leaving')) { const r = el.getBoundingClientRect(); seen.during.push([Math.round(r.left * 10) / 10, Math.round(r.top * 10) / 10]); }
    if (window.__seen === seen && seen.during.length < 40 && performance.now() - t0 < 1500) requestAnimationFrame(step); };
  const t0 = performance.now(); requestAnimationFrame(step); return seen.before;`;
const seen = () => run('return window.__seen;');

scenario('frozen', async () => {
  await fresh('/');
  // Home scrolled down, its "Album" row sideways: a card of that row is watched.
  await run(`const s = [...document.querySelectorAll('#main .shelf')].find((x) => x.querySelector('h2').textContent === 'Album'); const row = s.querySelector('.shelf-row'); row.scrollLeft = 260;
    window.__mark = row.querySelectorAll('.card')[2]; await new Promise((r) => setTimeout(r, 200)); return true;`);
  const at0 = await shelfCard('I tuoi artisti', 0);
  await run(WATCH);
  await tap(b, at0.x, at0.y, { hold: 60 });
  await sleep(700);
  const fwd = await seen();
  L.log('forward', JSON.stringify(fwd));
  check(fwd.during.length >= 3 && fwd.during.every(([x, y]) => Math.abs(x - fwd.before[0]) <= 1 && Math.abs(y - fwd.before[1]) <= 1), `going deeper, Home fades where it was: scrolled, its row sideways, not a pixel moved (${fwd.during.length} frames, ${JSON.stringify(fwd.before)})`, fwd);
  // The artist scrolled down: back, it slides right from where it was, never up or down.
  await run(`document.getElementById('main').scrollTop = 240; await new Promise((r) => setTimeout(r, 200)); window.__mark = [...document.querySelectorAll('#main .track-row')][2] || document.querySelector('#main .hero-title'); return true;`);
  await run(WATCH);
  await systemBack();
  await sleep(700);
  const bk = await seen();
  L.log('back', JSON.stringify(bk));
  check(bk.during.length >= 3 && bk.during.every(([x, y]) => x >= bk.before[0] - 0.5 && x <= bk.before[0] + 28.5 && Math.abs(y - bk.before[1]) <= 1) && bk.during.some(([x]) => x > bk.before[0] + 1), `back, the artist slides out to the right from where it was scrolled, never up or down (${bk.during.length} frames)`, bk);
  await settledOk('after both', { path: '/', frameCheck: false });
});

/** One navigation, its frames: the most pages, the transforms seen, how long two pages lasted. */
async function motionOf(go) {
  await resetFrames();
  const t0 = await run('return Math.round(performance.now());');
  await go();
  await sleep(700);
  return run(`const f = window.__frames.filter((x) => x.at >= ${t0});
    const two = f.filter((x) => x.n === 2);
    const xs = (i) => two.map((x) => { const t = x.t[i]; if (!t || t === 'none') return 0; const m = t.split('(')[1].split(')')[0].split(','); return Math.round(Number(m[4]) * 10) / 10; });
    return { frames: f.length, two: two.length, last: two.length ? two[two.length - 1].at - ${t0} : 0, oldX: xs(0), newX: xs(1), z: two.length ? two[0].z : null, low: f.length ? Math.min(...f.map((x) => x.sum)) : 0 };`);
}

scenario('motion', async () => {
  await fresh('/');
  const c = await shelfCard('Album');
  const fwd = await motionOf(() => run(`mpfy.navigate(${JSON.stringify(c.href)}); return true;`));
  L.log('forward', JSON.stringify(fwd));
  check(fwd.two >= 3 && fwd.newX.some((x) => x > 1 && x < 28) && Math.max(...fwd.newX) <= 28 && fwd.oldX.every((x) => x === 0) && fwd.z[1] === '2' && fwd.last <= 400, `deeper: the new page slides in from the right (at most 28 px) over the old one, within 400 ms (${fwd.two} frames, last at ${fwd.last} ms)`, fwd);
  const back = await motionOf(() => run('history.back(); return true;'));
  L.log('back', JSON.stringify(back));
  check(back.two >= 3 && back.oldX.some((x) => x > 1 && x < 28) && back.newX.every((x) => x === 0) && back.z[0] === '2' && back.last <= 400, `back: the page left slides out to the right over the one it uncovers, within 400 ms (${back.two} frames)`, back);
  const tab = await motionOf(async () => {
    const t = await navTab('/library');
    await tap(b, t.x, t.y, { hold: 40 });
  });
  L.log('tab', JSON.stringify(tab));
  check(tab.two >= 2 && tab.oldX.every((x) => x === 0) && tab.newX.every((x) => x === 0) && tab.last <= 300, `a tab: a crossfade, nothing moves sideways, within 300 ms (${tab.two} frames)`, tab);
  const tabBack = await motionOf(() => run('history.back(); return true;'));
  check(tabBack.two >= 2 && tabBack.oldX.every((x) => x === 0) && tabBack.newX.every((x) => x === 0), 'back over a tab switch: a crossfade too', tabBack);
  await b.S('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const reduced = await motionOf(() => run(`mpfy.navigate(${JSON.stringify(c.href)}); return true;`));
  L.log('reduced', JSON.stringify(reduced));
  check(reduced.oldX.every((x) => x === 0) && reduced.newX.every((x) => x === 0) && reduced.low >= 0.95, `reduced motion: a plain fade, nothing moves sideways (${reduced.two} frames)`, reduced);
  await settledOk('reduced motion: the album', { path: /^\/album\//, frameCheck: false });
  await b.S('Emulation.setEmulatedMedia', { features: [] });
});

/** The people's rows are drawn (the core answered for them). */
const rowsReady = () => run(`for (let i = 0; i < 50 && !document.querySelector('#main .ami-row'); i++) await new Promise((r) => setTimeout(r, 100)); return !!document.querySelector('#main .ami-row');`);

scenario('people', async () => {
  // Your picture: Amici slides in, and a double tap on it is one page, one step.
  for (const count of [1, 2]) {
    await fresh('/');
    const pic = await at('.home-top .avatar-btn', { scroll: false });
    await resetFrames();
    await doubleTap(b, pic.x, pic.y, { gap: 120, hold: 60, count });
    await settledOk(`${count === 1 ? 'a tap' : 'a double tap'} on your picture`, { path: '/amici' });
    await systemBack();
    await settledOk('then the system back once', { path: '/' });
  }
  const motion = await (async () => {
    await fresh('/');
    return motionOf(() => run(`mpfy.navigate('/amici'); return true;`));
  })();
  check(motion.two >= 3 && motion.newX.some((x) => x > 1 && x < 28) && motion.oldX.every((x) => x === 0) && motion.last <= 400, `Amici slides in from the right like every deeper page (${motion.two} frames)`, motion);
  // A double tap on a row: its page, one history step.
  for (const gap of [90, 180]) {
    await fresh('/amici');
    await rowsReady();
    const r = await at('#main .view-friends .ami-row', { text: 'Sara' });
    await resetFrames();
    await doubleTap(b, r.x, r.y, { gap, hold: 60 });
    await settledOk(`a double tap on a row of Amici (gap ${gap})`, { path: /^\/persona\// });
    await systemBack();
    await settledOk('then the system back once: Amici', { path: '/amici' });
  }
  // A row, and the system back at once or a little later.
  for (const wait of [0, 60, 140]) {
    await fresh('/amici');
    await rowsReady();
    const r = await at('#main .view-friends .ami-row', { text: 'Giulia' });
    await resetFrames();
    await tap(b, r.x, r.y, { hold: 70 });
    if (wait) await sleep(wait);
    await systemBack();
    await settledOk(`a row of Amici tapped, the system back ${wait} ms after it`, { path: '/amici' });
  }
  // "Recenti", then its back arrow double tapped: one step back.
  await fresh('/amici');
  const rec = await at('#main .view-friends .me-row', { text: 'Recenti' });
  await resetFrames();
  await tap(b, rec.x, rec.y, { hold: 60 });
  await settledOk('"Recenti" from Amici', { path: '/recenti' });
  const backArrow = await at('#main .view-recents .back-btn', { scroll: false });
  await sleep(400);
  await resetFrames();
  await doubleTap(b, backArrow.x, backArrow.y, { gap: 120, hold: 60 });
  await settledOk('the back arrow of Recenti double tapped: one step', { path: '/amici' });
  // A person's page: its back arrow double tapped, one step.
  await fresh('/amici');
  await rowsReady();
  const g = await at('#main .view-friends .ami-row', { text: 'Marco' });
  await tap(b, g.x, g.y, { hold: 60 });
  await settledOk('a person from Amici', { path: /^\/persona\// });
  await sleep(400);
  const pBack = await at('#main .detail-person .back-btn', { scroll: false });
  await resetFrames();
  await doubleTap(b, pBack.x, pBack.y, { gap: 120, hold: 60 });
  await settledOk("the back arrow of a person's page double tapped: one step", { path: '/amici' });
  // The search opened and left in a burst.
  await fresh('/amici');
  const find = await at('#main .view-friends .set-top .top-action', { scroll: false });
  await resetFrames();
  await tap(b, find.x, find.y, { hold: 50 });
  await sleep(60);
  await systemBack();
  await settledOk('the search opened and the system back at once', { path: '/amici' });
});

scenario('chats', async () => {
  const st = await (await fetch(`${base}/__mock/state`)).json();
  const giulia = st.chat.convs.find((c) => c.with === 'a7c1e0d2b3f4051627384950a1b2c3d4').id;
  const sara = st.chat.convs.find((c) => c.with === '8a2b4c6d8e0f1a3b5c7d9e1f2a4b6c8d').id;
  const chatRow = `#main .view-friends .ami-row[href="/chat/${giulia}"]`;
  const chatReady = () => run(`for (let i = 0; i < 50 && !document.querySelector(${JSON.stringify(chatRow)}); i++) await new Promise((r) => setTimeout(r, 100)); return !!document.querySelector(${JSON.stringify(chatRow)});`);
  // A chat slides in like every deeper page.
  await fresh('/amici', 'sources=2', 2);
  await chatReady();
  const motion = await motionOf(() => run(`mpfy.navigate('/chat/${giulia}'); return true;`));
  check(motion.two >= 3 && motion.newX.some((x) => x > 1 && x < 28) && motion.oldX.every((x) => x === 0) && motion.last <= 400, `a chat slides in from the right like every deeper page (${motion.two} frames)`, motion);
  await settledOk('the chat', { path: `/chat/${giulia}`, frameCheck: false });
  // A double tap on a chat's row: one page, one step; back once: Amici.
  for (const gap of [90, 180]) {
    await fresh('/amici', 'sources=2', 2);
    await chatReady();
    const r = await at(chatRow);
    await resetFrames();
    await doubleTap(b, r.x, r.y, { gap, hold: 60 });
    await settledOk(`a double tap on a chat's row (gap ${gap})`, { path: `/chat/${giulia}` });
    await systemBack();
    await settledOk('then the system back once: Amici', { path: '/amici' });
  }
  // A row tapped, the system back at once or a little later.
  for (const wait of [0, 80]) {
    await fresh('/amici', 'sources=2', 2);
    await chatReady();
    const r = await at(chatRow);
    await resetFrames();
    await tap(b, r.x, r.y, { hold: 70 });
    if (wait) await sleep(wait);
    await systemBack();
    await settledOk(`a chat's row tapped, the system back ${wait} ms after it`, { path: '/amici' });
  }
  // The chat's back arrow double tapped: one step.
  await fresh('/amici', 'sources=2', 2);
  await chatReady();
  const r = await at(chatRow);
  await tap(b, r.x, r.y, { hold: 60 });
  await settledOk('a chat from Amici', { path: `/chat/${giulia}` });
  await sleep(400);
  const cBack = await at('#main .view-chat .back-btn', { scroll: false });
  await resetFrames();
  await doubleTap(b, cBack.x, cBack.y, { gap: 120, hold: 60 });
  await settledOk("the chat's back arrow double tapped: one step", { path: '/amici' });
  // A shared playlist from its card in the chat, and back.
  await fresh(`/chat/${sara}`, 'sources=2', 2);
  await run(`for (let i = 0; i < 50 && !document.querySelector('#main .mcard-link'); i++) await new Promise((r) => setTimeout(r, 100)); return true;`);
  const card = await at('#main .mcard-link', { scroll: false });
  await resetFrames();
  await doubleTap(b, card.x, card.y, { gap: 120, hold: 60 });
  await settledOk('a double tap on a shared playlist card: its view, one step', { path: /^\/condivisa\// });
  await systemBack();
  await settledOk('then the system back once: the chat', { path: `/chat/${sara}` });
  // Home's "Condivisi con te": a card, a double tap, one page.
  await fresh('/', 'sources=2', 2);
  const shared = await at('#main .shelf-shared .card-link');
  await resetFrames();
  await doubleTap(b, shared.x, shared.y, { gap: 120, hold: 60 });
  await settledOk('a double tap on a shared card on Home: its album, one step', { path: /^\/album\// });
  await systemBack();
  await settledOk('then the system back once: Home', { path: '/' });
  // "Scrivi a" on a person's page, and "Persone bloccate" with its back arrow double tapped.
  await fresh('/persona/a7c1e0d2b3f4051627384950a1b2c3d4', 'sources=2', 2);
  await run(`for (let i = 0; i < 50 && !document.querySelector('#main .write-btn'); i++) await new Promise((r) => setTimeout(r, 100)); return true;`);
  const write = await at('#main .write-btn', { scroll: false });
  await resetFrames();
  await doubleTap(b, write.x, write.y, { gap: 120, hold: 60 });
  await settledOk('a double tap on "Scrivi a": the chat, one step', { path: `/chat/${giulia}` });
  await fresh('/impostazioni', 'sources=2', 2);
  const bl = await at('#main .social-blocked');
  await tap(b, bl.x, bl.y, { hold: 60 });
  await settledOk('"Persone bloccate"', { path: '/impostazioni/bloccate' });
  await sleep(400);
  const bBack = await at('#main .view-blocked .back-btn', { scroll: false });
  await resetFrames();
  await doubleTap(b, bBack.x, bBack.y, { gap: 120, hold: 60 });
  await settledOk('the back arrow of "Persone bloccate" double tapped: one step', { path: '/impostazioni' });
});

scenario('desktop', async () => {
  await b.S('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
  await b.S('Emulation.setTouchEmulationEnabled', { enabled: false });
  await fresh('/');
  const click = async (p) => {
    await b.S('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await b.S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  };
  const side = {
    search: await at('#sidebar .side-link[href="/search"]', { scroll: false }),
    settings: await at('#sidebar .side-link[href="/impostazioni"]', { scroll: false }),
    home: await at('#sidebar .side-logo', { scroll: false }),
    library: await at('#sidebar .side-lib-title', { scroll: false }),
  };
  for (const apart of [40, 120]) {
    await resetFrames();
    for (const k of ['search', 'settings', 'home', 'library', 'search']) {
      await click(side[k]);
      await sleep(apart);
    }
    await settledOk(`the sidebar clicked five times ${apart} ms apart`, { path: '/search' });
  }
  // A row of the sidebar's library, then a card of the page during its crossfade.
  await click(side.home);
  await sleep(700);
  const row = await at('#sidebar .lib-row', { idx: 1, scroll: false });
  const card = await shelfCard('Album');
  await resetFrames();
  await click(row);
  await sleep(60);
  await click(card);
  await settledOk('a sidebar row, then a click where a card was, during the crossfade');
  await resetFrames();
  await run('history.back(); return true;');
  await sleep(50);
  await run('history.back(); return true;');
  await settledOk('the browser back twice during a change');
});

const errors = [];
try {
  for (const s of scenarios) {
    if (only && !only.includes(s.name)) continue;
    L.log(`\n== ${s.name}`);
    b = await startBrowser(`pages-${s.name}`);
    L.log('browser', b.version);
    try {
      await b.phone();
      await s.fn();
    } catch (err) {
      check(false, `${s.name}: ran to the end`, String((err && err.stack) || err));
    } finally {
      for (const e of b.errors) errors.push(`${s.name}: ${e}`);
      b.close();
    }
  }
  check(!errors.length, 'no page errors', errors);
} finally {
  console.log(`fails=${fails}`);
  L.log(`fails=${fails}`);
  L.flush();
  mock.kill();
}
process.exit(fails ? 1 : 0);
