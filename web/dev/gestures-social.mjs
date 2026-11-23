// The people under fast and odd input, on a phone screen with touch (and a PC window with the mouse
// for the right column):
//   fling        a fling on the Amici list, then a tap while it glides: nothing opens; once it
//                stopped, a tap on a row opens it
//   rows         double and triple taps on a row of Amici and on "Recenti": one page, one step
//   picture      a double tap on your picture in Home: Amici once, one step
//   during       your picture, then a tap where a row of Amici lands, during the slide (the rest of
//                the gesture: nothing) and after it (a new gesture: the row opens)
//   switches     ten taps in 1 s on a switch of Impostazioni > Social: the state of the last tap,
//                the core holding the same; on "Invisibile": one dialog at most
//   typing       30 characters in 200 ms in the search: the results and the address of the last
//                text; then a short name typed as fast
//   shelf        a fling on the shelf of a person's page: it glides sideways and stays (also when
//                the people are asked again), nothing opens; a tap while it glides opens nothing
//   recents      a fling on Recenti, then a tap while it glides: nothing plays
//   column       (1366 x 768) a double click on your picture leaves the column as it was: open
//                then closed (the second click lands where the picture was, on the column now,
//                and still counts on the picture, pressing nothing of the column), never two;
//                with it open: closed then open; a triple click: open; a burst of clicks on a row
//                of the column: one page
//
//   node web/dev/gestures-social.mjs <out dir> [--only name|name]
//
// Prints PASS/FAIL lines and fails=<n> (exit 1 on a failure); the same lines and the details go
// to <out dir>/gestures-social.log.
import fs from 'node:fs';
import path from 'node:path';
import { startMock, startBrowser, touchFling, tap, doubleTap, sleep, logger } from './gesture-lib.mjs';

const outDir = path.resolve(process.argv[2] || '.');
fs.mkdirSync(outDir, { recursive: true });
const onlyAt = process.argv.indexOf('--only');
const only = onlyAt > 0 ? process.argv[onlyAt + 1].split('|') : null;
const L = logger(path.join(outDir, 'gestures-social.log'));
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
const touch = (type, points) => b.S('Input.dispatchTouchEvent', { type, touchPoints: points });
const mockState = async () => (await fetch(`${base}/__mock/state`)).json();

/** A clean page at route: storage cleared, the mock's sample data (and extra), the library loaded. */
async function fresh(route = '/', extra = '') {
  await touch('touchCancel', []).catch(() => {});
  await b.S('Page.navigate', { url: 'about:blank' });
  await sleep(200);
  await b.S('Storage.clearDataForOrigin', { origin: base, storageTypes: 'local_storage,indexeddb,service_workers,cache_storage' });
  await fetch(`${base}/__mock/reset?sources=2`);
  // The people part as it is without chats (sources at social 1): rows open a person's page.
  // gestures-chat.mjs takes the same list with chats.
  await fetch(`${base}/__mock/chat?level=1`);
  if (extra) await fetch(`${base}/__mock/social?${extra}`);
  await b.go(`${base}${route}${route.includes('?') ? '&' : '?'}nosw`, 600);
  await run(`for (let i = 0; i < 60 && !(window.mpfy && mpfy.store.loaded); i++) await new Promise((r) => setTimeout(r, 100)); return true;`);
  await sleep(500);
}
const SNAP = `return { path: location.pathname + location.search, views: document.querySelectorAll('#main > .view').length, layers: [...document.querySelectorAll('#layers > .layer:not(.closing)')].map((l) => (l.querySelector('.dialog-title') || {}).textContent || 'layer'), track: (mpfy.player.currentTrack() || {}).title || null, index: mpfy.player.state.index, hist: history.length };`;
const snap = () => run(SNAP);
/** The center of the idx-th element matching sel (whose text includes text). */
const at = (sel, { text = null, idx = 0, fy = 0.5, scroll = false } = {}) =>
  run(`const els = [...document.querySelectorAll(${JSON.stringify(sel)})].filter((e) => !e.closest('.view-leaving') && (${JSON.stringify(text)} == null || e.textContent.includes(${JSON.stringify(text)})));
    const e = els[${idx}]; if (!e) return null; if (${scroll}) { e.scrollIntoView({ block: 'center', inline: 'center' }); await new Promise((r) => setTimeout(r, 350)); }
    const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height * ${fy}) };`);
const ready = (sel) => run(`for (let i = 0; i < 50 && !document.querySelector(${JSON.stringify(sel)}); i++) await new Promise((r) => setTimeout(r, 100)); return !!document.querySelector(${JSON.stringify(sel)});`);
/** Taps at p1 and p2, the second pressed `apart` ms after the first. */
async function twoTaps(p1, p2, apart, hold = 60) {
  const t0 = performance.now();
  await tap(b, p1.x, p1.y, { hold });
  const due = t0 + apart;
  if (due > performance.now()) await sleep(due - performance.now());
  await tap(b, p2.x, p2.y, { hold });
}
/** Records the scroll offsets of sel (top or left) and the lifts and presses, with their times. */
const watchScroll = (sel, axis) =>
  run(`const el = document.querySelector(${JSON.stringify(sel)}); window.__sc = []; window.__ups = []; window.__downs = [];
    el.addEventListener('scroll', () => window.__sc.push([Math.round(performance.now()), Math.round(el.${axis === 'x' ? 'scrollLeft' : 'scrollTop'})]), { passive: true });
    window.addEventListener('touchend', () => window.__ups.push(Math.round(performance.now())), true);
    window.addEventListener('touchstart', () => window.__downs.push(Math.round(performance.now())), true);
    return true;`);
/**
 * A fling of (dx, dy) px at speed px/s whose last move and lift go out together: a page busy
 * drawing takes each move a frame late, and a lift that comes 40 ms after the last move reads as
 * a finger that stopped (no glide). gesture-lib's touchFling waits for every move.
 */
async function quickFling({ x, y, dx = 0, dy = 0, speed = 5000, step = 8 }) {
  const dist = Math.hypot(dx, dy);
  await touch('touchStart', [{ x, y, id: 1 }]);
  const t0 = performance.now();
  for (;;) {
    await sleep(step);
    const d = Math.min(dist, ((performance.now() - t0) / 1000) * speed);
    const p = [{ x: x + (dx / dist) * d, y: y + (dy / dist) * d, id: 1 }];
    if (d >= dist) {
      await Promise.all([touch('touchMove', p), touch('touchEnd', [])]);
      break;
    }
    await touch('touchMove', p);
  }
}
/** The tap came while the list still glided: it moved after the fling's lift and right up to the tap's press. */
// Only a glide still going fast counts (the last frame before the press moved it 0.3 px/ms or
// more, at most 20 ms before it): the slow end of a glide is a list at rest to the browser too.
const glidedUntilTap = () =>
  run(`const lift = window.__ups[0]; const press = window.__downs[1]; if (lift == null || press == null) return false;
    const moving = window.__sc.filter((e) => e[0] > lift && e[0] <= press + 5); if (moving.length < 2) return false;
    const a = moving[moving.length - 2]; const z = moving[moving.length - 1];
    return z[0] >= press - 20 && Math.abs(z[1] - a[1]) / Math.max(1, z[0] - a[0]) >= 0.3;`);

const scenarios = [];
const scenario = (name, fn) => scenarios.push({ name, fn });

scenario('fling', async () => {
  let tries = 0;
  let hits = 0;
  let opened = 0;
  for (let i = 0; i < 5; i++) {
    await fresh('/amici', 'crowd=40');
    await ready('#main .ami-row');
    await watchScroll('#main', 'y');
    const p0 = await snap();
    await quickFling({ x: 180, y: 600, dy: -380, speed: 5000 });
    await sleep(30);
    await tap(b, 180, 420);
    await sleep(1000);
    if (!(await glidedUntilTap())) continue;
    tries++;
    const p1 = await snap();
    if (p1.path !== p0.path || p1.hist !== p0.hist) {
      hits++;
      continue;
    }
    const r = await run(`const r = [...document.querySelectorAll('#main .ami-row')].find((x) => { const q = x.getBoundingClientRect(); return q.top > 120 && q.bottom < 600; }); const q = r.getBoundingClientRect(); return { x: Math.round(q.left + q.width / 2), y: Math.round(q.top + q.height / 2) };`);
    await tap(b, r.x, r.y);
    await sleep(900);
    if (/^\/persona\//.test((await snap()).path)) opened++;
  }
  check(tries > 0 && hits === 0, 'a tap on the Amici list still gliding after a fling opens nothing', { tries, hits });
  check(tries > 0 && opened === tries, 'once the list stopped, a tap on a row opens its page', { tries, opened });
});

scenario('rows', async () => {
  for (const count of [2, 3]) {
    for (const gap of [90, 180]) {
      await fresh('/amici');
      await ready('#main .ami-row');
      const h0 = (await snap()).hist;
      const r = await at('#main .ami-row', { text: 'Sara' });
      await doubleTap(b, r.x, r.y, { gap, hold: 60, count });
      await sleep(900);
      const s = await snap();
      check(/^\/persona\//.test(s.path) && s.views === 1 && s.hist === h0 + 1, `${count} taps on a row of Amici (gap ${gap}): her page, one history step (${s.path}, ${s.hist - h0})`, s);
      await run('history.back(); return true;');
      await sleep(800);
      check((await snap()).path.startsWith('/amici'), `then the system back once: Amici`);
    }
  }
  await fresh('/amici');
  const h0 = (await snap()).hist;
  const rec = await at('#main .me-row', { text: 'Recenti' });
  await doubleTap(b, rec.x, rec.y, { gap: 120, hold: 60 });
  await sleep(900);
  const s = await snap();
  check(s.path === '/recenti' && s.hist === h0 + 1, `a double tap on "Recenti": one page, one step (${s.path})`, s);
});

scenario('picture', async () => {
  for (const count of [2, 3]) {
    await fresh('/');
    const h0 = (await snap()).hist;
    const p = await at('.home-top .avatar-btn');
    await doubleTap(b, p.x, p.y, { gap: 120, hold: 60, count });
    await sleep(900);
    const s = await snap();
    check(s.path === '/amici' && s.views === 1 && s.hist === h0 + 1, `${count} taps on your picture: Amici once (${s.path}, ${s.hist - h0} step)`, s);
    await run('history.back(); return true;');
    await sleep(800);
    check((await snap()).path.startsWith('/') && !(await snap()).path.startsWith('/amici'), 'then the system back once: Home');
  }
});

scenario('during', async () => {
  for (const apart of [150, 700]) {
    await fresh('/');
    await run(`for (let i = 0; i < 50 && !(mpfy.social.people || []).length; i++) await new Promise((r) => setTimeout(r, 100)); return true;`);
    const p = await at('.home-top .avatar-btn');
    // Where the third row lands on Amici: under you, "Recenti", "Impostazioni" and two rows.
    const row = { x: 180, y: 520 };
    await twoTaps(p, row, apart);
    await sleep(1000);
    const s = await snap();
    if (apart < 400) check(s.path === '/amici' && s.views === 1, `your picture, then a tap where a row lands ${apart} ms later (during the slide): the rest of the gesture, Amici stays (${s.path})`, s);
    else check(/^\/persona\//.test(s.path) && s.views === 1, `your picture, then a tap on a row ${apart} ms later: a new gesture, the row opens (${s.path})`, s);
  }
});

scenario('switches', async () => {
  await fresh('/impostazioni');
  await ready('.social-section');
  await run(`document.querySelector('.social-section').scrollIntoView({ block: 'center' }); return true;`);
  await sleep(400);
  const now = await at('.social-section .social-now');
  const before = await run(`return document.querySelector('.social-section .social-now').getAttribute('aria-checked');`);
  await doubleTap(b, now.x, now.y, { gap: 40, hold: 60, count: 10 });
  await sleep(1500);
  const after = await run(`return document.querySelector('.social-section .social-now').getAttribute('aria-checked');`);
  const st = await mockState();
  const s = await snap();
  check(after === before && String(st.social.privacy.showNow) === after && s.layers.length === 0 && st.social.patches.length <= 1, `ten taps in 1 s on "Mostra cosa ascolto": the state of the last tap, the core holding it, no dialog (${before} -> ${after}, ${st.social.patches.length} requests)`, { st: st.social.privacy, patches: st.social.patches.length });
  const rec = await at('.social-section .social-recent');
  await doubleTap(b, rec.x, rec.y, { gap: 40, hold: 60, count: 9 });
  await sleep(1500);
  const r2 = await run(`return document.querySelector('.social-section .social-recent').getAttribute('aria-checked');`);
  const st2 = await mockState();
  check(r2 === 'false' && st2.social.privacy.showRecent === false && st2.social.patches.length - st.social.patches.length === 1, `nine taps on "Mostra i miei ascolti recenti": off, as the last tap left it, the core too, one request (${r2})`, st2.social.privacy);
  const inv = await at('.social-section .social-invisible');
  await doubleTap(b, inv.x, inv.y, { gap: 40, hold: 60, count: 10 });
  await sleep(800);
  const d = await snap();
  const st3 = await mockState();
  check(d.layers.length === 1 && d.layers[0] === 'Diventare invisibile?' && st3.social.privacy.invisible === false, `ten taps on "Invisibile": one dialog, nothing changed yet (${JSON.stringify(d.layers)})`, d);
  await run(`[...document.querySelectorAll('.layer-dialog:not(.closing) .btn')].find((x) => x.textContent === 'Annulla').click(); return true;`);
  await sleep(700);
  check((await snap()).layers.length === 0 && (await run(`return document.querySelector('.social-section .social-invisible').getAttribute('aria-checked');`)) === 'false', '"Annulla": no dialog, still visible');
});

scenario('typing', async () => {
  await fresh('/amici?q=');
  await ready('.bar-search input');
  await run(`document.querySelector('.bar-search input').focus(); return true;`);
  const long = 'zqzqzqzqzqzqzqzqzqzqzqzqzqzqzq';
  const t0 = performance.now();
  for (const ch of long) await b.S('Input.insertText', { text: ch });
  const took = performance.now() - t0;
  await sleep(600);
  const r = await run(`return { q: new URLSearchParams(location.search).get('q'), rows: document.querySelectorAll('#main .ami-row').length, none: (document.querySelector('#main .ami-none') || {}).textContent || '', value: document.querySelector('.bar-search input').value };`);
  check(r.value === long && r.q === long && r.rows === 0 && r.none === `Nessun risultato per "${long}"`, `30 characters in ${Math.round(took)} ms: the address and the results of the last text`, r);
  await run(`const i = document.querySelector('.bar-search input'); i.select(); return true;`);
  for (const ch of 'giu') await b.S('Input.insertText', { text: ch });
  await sleep(600);
  const r2 = await run(`return { q: new URLSearchParams(location.search).get('q'), rows: [...document.querySelectorAll('#main .ami-row')].map((x) => x.querySelector('.ami-name').textContent) };`);
  check(r2.q === 'giu' && r2.rows.join() === 'Giulia,Giulia', `then "giu" as fast: both Giulia (${JSON.stringify(r2)})`, r2);
});

/** Giulia's page with a long shelf: she played an album of every artist lately. */
async function longShelf() {
  await fresh('/');
  for (const ai of [0, 1, 4, 5, 6, 8, 9, 10, 11]) await fetch(`${base}/__mock/social?now=a7c1e0d2b3f4051627384950a1b2c3d4&track=${ai},0`);
  await b.go(`${base}/persona/a7c1e0d2b3f4051627384950a1b2c3d4?nosw`, 900);
  await ready('#main .detail-person .shelf .card');
  await run(`document.querySelector('#main .detail-person .shelf').scrollIntoView({ block: 'center' }); return true;`);
  await sleep(600);
}

scenario('shelf', async () => {
  await longShelf();
  const n = await run(`return document.querySelectorAll('#main .detail-person .shelf .card').length;`);
  const p0 = await snap();
  const c = await at('#main .detail-person .shelf-row', { fy: 0.35 });
  await touchFling(b, { x: c.x + 100, y: c.y, dx: -260, speed: 5000 });
  await sleep(1500);
  const left = await run(`return Math.round(document.querySelector('#main .detail-person .shelf-row').scrollLeft);`);
  await run('await mpfy.social.refresh(); return true;'); // the people asked again: the shelf stays where it was left
  await sleep(800);
  const left2 = await run(`return Math.round(document.querySelector('#main .detail-person .shelf-row').scrollLeft);`);
  const p1 = await snap();
  check(n === 10 && left > 50 && left2 === left && p1.path === p0.path, `a fling on the shelf of her page (${n} cards): it glides sideways and stays (${left} px, then ${left2}), nothing opens`, { n, left, left2, path: p1.path });
  let tries = 0;
  let hits = 0;
  for (let i = 0; i < 4; i++) {
    await longShelf();
    await watchScroll('#main .detail-person .shelf-row', 'x');
    const q0 = await snap();
    const d = await at('#main .detail-person .shelf-row', { fy: 0.35 });
    await quickFling({ x: d.x + 100, y: d.y, dx: -260, speed: 5000 });
    await sleep(20);
    await tap(b, d.x, d.y);
    await sleep(1200);
    if (!(await glidedUntilTap())) continue;
    tries++;
    if ((await snap()).path !== q0.path) hits++;
  }
  check(tries > 0 && hits === 0, 'a tap on her shelf still gliding opens nothing', { tries, hits });
});

scenario('recents', async () => {
  let tries = 0;
  let hits = 0;
  for (let i = 0; i < 5; i++) {
    // A cold start right on Recenti (nothing saved yet): its plays come once the core named the
    // principal, not the library's 50 for good.
    await fresh('/recenti', 'history=150&step=120');
    await ready('#main .view-recents .track-row');
    await sleep(1500);
    if (i === 0) {
      // Each day's plays are a windowed list as tall as all its rows: the plays, from the heights.
      const n = await run(`const H = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--vrow-track'));
        return [...document.querySelectorAll('#main .view-recents .vlist')].reduce((s, l) => s + Math.round(l.offsetHeight / H), 0);`);
      check(n === 100, `Recenti opened at a cold start: the principal's first 100 plays (${n} rows)`, n);
    }
    // Its covers in first (scrolled through once): a page still busy loading them takes the
    // fling's moves late, and a fling released after a pause does not glide.
    await run(`const m = document.getElementById('main'); for (const y of [800, 1600, 2400, 0]) { m.scrollTop = y; await new Promise((r) => setTimeout(r, 400)); } return true;`);
    await sleep(800);
    await watchScroll('#main', 'y');
    const p0 = await snap();
    await quickFling({ x: 180, y: 640, dy: -460, speed: 6000 });
    await sleep(30);
    await tap(b, 140, 420);
    await sleep(1200);
    const glided = await glidedUntilTap();
    if (!glided) continue;
    tries++;
    const p1 = await snap();
    if (p1.track !== p0.track || p1.index !== p0.index || p1.path !== p0.path) hits++;
  }
  check(tries > 0 && hits === 0, 'a tap on Recenti still gliding after a fling plays nothing', { tries, hits });
});

scenario('column', async () => {
  await b.S('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
  await b.S('Emulation.setTouchEmulationEnabled', { enabled: false });
  await fresh('/');
  const click = async (p, count = 1) => {
    await b.S('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: count });
    await b.S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: count });
  };
  const col = () => run(`const a = [...document.querySelectorAll('.friends-side')]; const b = document.querySelector('.home-top .avatar-btn'); return { n: a.length, shown: a.filter((x) => !x.hidden).length, cols: getComputedStyle(document.getElementById('app')).gridTemplateColumns.split(' ').length, open: !!b && b.classList.contains('is-open'), path: location.pathname, search: !!document.querySelector('.friends-side .bar-search'), layers: document.querySelectorAll('.layer:not(.closing)').length };`);
  const p = await at('.home-top .avatar-btn');
  const double = async (x) => {
    await click(x, 1);
    await sleep(120);
    await click(x, 2);
    await sleep(900);
  };
  await double(p);
  const c1 = await col();
  // Open, then closed by the second click: it lands where the picture was (the column now) and
  // counts on the picture; nothing of the column is pressed. One column, as it was.
  check(c1.n === 1 && c1.shown === 0 && c1.cols === 2 && !c1.open && !c1.search && !c1.layers && c1.path === '/', `a double click on your picture: open then closed, as it was, never two columns (${JSON.stringify(c1)})`, c1);
  await click(p, 1);
  await sleep(900);
  const o1 = await col();
  check(o1.n === 1 && o1.shown === 1 && o1.cols === 3 && o1.open && !o1.search, `then one click: open (${JSON.stringify(o1)})`, o1);
  const q = await at('.home-top .avatar-btn');
  await double(q);
  const c0 = await col();
  // Closed, then open again by the second click (where the picture was, the main area now).
  check(c0.n === 1 && c0.shown === 1 && c0.cols === 3 && c0.open && !c0.search && !c0.layers && c0.path === '/', `a double click on it while open: closed then open, as it was, nothing else (${JSON.stringify(c0)})`, c0);
  await click(q, 1);
  await sleep(900);
  const o0 = await col();
  check(o0.n === 1 && o0.shown === 0 && o0.cols === 2 && !o0.open && o0.path === '/', `then one click: closed (${JSON.stringify(o0)})`, o0);
  await click(p, 1);
  await sleep(120);
  await click(p, 2);
  await sleep(120);
  await click(p, 3);
  await sleep(900);
  const c2 = await col();
  check(c2.n === 1 && c2.shown === 1 && c2.cols === 3 && c2.open && !c2.search, `a triple click: open, closed, open, one column (${JSON.stringify(c2)})`, c2);
  await sleep(500);
  await ready('.friends-side .ami-row');
  const r = await at('.friends-side .ami-row', { text: 'Marco' });
  const h0 = (await snap()).hist;
  for (let i = 0; i < 3; i++) {
    await click(r, i + 1);
    await sleep(80);
  }
  await sleep(900);
  const s = await snap();
  const c3 = await col();
  check(/^\/persona\//.test(s.path) && s.views === 1 && s.hist === h0 + 1 && c3.shown === 1, `a burst of clicks on a row of the column: one page in the main area, one step, the column stays (${s.path})`, { s, c3 });
});

const errors = [];
try {
  for (const s of scenarios) {
    if (only && !only.includes(s.name)) continue;
    L.log(`\n== ${s.name}`);
    b = await startBrowser(`social-${s.name}`);
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
