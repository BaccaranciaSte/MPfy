// Redraws under the person's hands, on a phone screen with touch (and a desktop window with the
// mouse for "Carica brani"): a store change (the play report 30 s into a song, a heart, a song
// added), a connection flip, upload progress. What is scrolled, flung, pressed or about to be
// tapped stays where it is.
//   home     Home shelves across a play report, a heart and a connection flip
//   fling    a shelf flung sideways while Home changes (elsewhere, and in that very shelf)
//   held     a finger down on Home while a shelf changes: nothing moves until it lifts
//   search   the shelves of a search result across a play report
//   album    an album page across a connection flip
//   empty    Home with an empty library: the upload button follows the connection
//   library  La tua libreria > Brani deep in it (the list draws only the rows near the screen: deep
//            means past its row 120): a play report (Recenti and Alfabetico), a song added, a
//            heart on the playlists
//   upload   "Carica brani" with the mouse while a file uploads: the footer is not redrawn, a
//            click on "Svuota elenco" with progress between press and release works
//   choice   an archive with three "maybe" songs: a double tap answers one question, a
//            deliberate tap after it still answers the next
//   menu     a song changed under a row kept on screen (Libreria > Brani, search): its menu
//            edits the song as it is now
//   focus    a desktop window with the keyboard: the focus on a Home card and on a sidebar row
//            stays on it when a play report or a heart draws them again
// Usage: node web/dev/gestures-redraw.mjs <out dir> [section ...]
//   writes <out dir>/gestures-redraw.log; prints PASS/FAIL lines and fails=<n>; exit 1 on a failure
import fs from 'node:fs';
import path from 'node:path';
import { startMock, startBrowser, sleep, touchFling, tap, doubleTap, logger } from './gesture-lib.mjs';

const outDir = path.resolve(process.argv[2] || '.');
fs.mkdirSync(outDir, { recursive: true });
const only = process.argv.slice(3);
const want = (s) => !only.length || only.includes(s);
const { log, flush } = logger(path.join(outDir, 'gestures-redraw.log'));
let fails = 0;
const check = (cond, label) => {
  const line = `${cond ? 'PASS' : 'FAIL'} ${label}`;
  log(line);
  console.log(line);
  if (!cond) fails++;
};

const { mock, base } = await startMock();
const b = await startBrowser('redraw');
log('browser', b.version, 'mock', base);
const { evaluate } = b;

const mockState = async () => (await fetch(`${base}/__mock/state`)).json();
const miId = async () => (await mockState()).servers.find((x) => x.name === 'Mi A2').id;

/** A tiny wav, different for every seed (the mock takes any audio file). */
function wav(seed, n = 3000) {
  const buf = Buffer.alloc(44 + n);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(11025, 24);
  buf.writeUInt32LE(22050, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n, 40);
  for (let i = 0; i < n; i++) buf[44 + i] = (i * (seed + 3)) & 255;
  return buf;
}
let wavSeed = 100;
/** Puts a new song on the Mi A2 behind the page's back (the page sees it at its next refresh). */
async function addSong(name) {
  const r = await fetch(`${base}/s/${await miId()}/api/upload/${encodeURIComponent(name)}`, { method: 'PUT', body: wav(wavSeed++) });
  return r.ok;
}

// Helpers in the page, once per load.
const INSTR = `
  window.__n = window.__n || 0;
  window.__tag = (el) => (el ? el.__t || (el.__t = ++window.__n) : null);
  window.__row = (title) => { const s = [...document.querySelectorAll('#main .shelf')].find((x) => x.querySelector('.shelf-head h2') && x.querySelector('.shelf-head h2').textContent === title); return s ? s.querySelector('.shelf-row') : null; };
  window.__shelves = () => [...document.querySelectorAll('#main .shelf')].map((s) => { const r = s.querySelector('.shelf-row'); const t = s.querySelector('.shelf-head h2'); return r && t ? { title: t.textContent, tag: window.__tag(r), left: Math.round(r.scrollLeft), max: r.scrollWidth - r.clientWidth } : null; }).filter(Boolean);
  if (!window.__emitsOn) { window.__emitsOn = true; window.__emits = 0; mpfy.store.subscribe(() => window.__emits++); }
  window.__rec = (fn) => { const out = []; let on = true; const t0 = performance.now(); const tick = () => { out.push([Math.round(performance.now() - t0)].concat(fn())); if (on) requestAnimationFrame(tick); }; requestAnimationFrame(tick); window.__recStop = () => { on = false; return out; }; return true; };
  return true;`;
async function open(url, wait = 1800) {
  await b.go(url, wait);
  await evaluate(INSTR);
}
const emits = () => evaluate('return window.__emits;');
/** Waits until the store emitted more than `n` times (up to `ms`), then a little more. */
async function emitted(n, ms = 6000) {
  for (let i = 0; i < ms / 50; i++) {
    if ((await emits()) > n) break;
    await sleep(50);
  }
  await sleep(250);
  return (await emits()) > n;
}
let playN = 0;
/** What the player does 30 s into a song: store.played, then the refresh it brings. */
async function playReport() {
  const e0 = await emits();
  const k = 3 + ((playN++ * 7) % 20);
  await evaluate(`const t = mpfy.store.lib.tracks[${k} % mpfy.store.lib.tracks.length]; mpfy.store.played(t.id, { type: 'library', id: null }); return true;`);
  return emitted(e0);
}
async function sourcesUp(up) {
  await fetch(`${base}/__mock/offline?on=${up ? 0 : 1}`);
  for (let i = 0; i < 80; i++) {
    await sleep(100);
    if ((await evaluate('return mpfy.sources.anyUp();')) === up) break;
  }
  await sleep(500);
  return (await evaluate('return mpfy.sources.anyUp();')) === up;
}
/** Scrolls each named shelf of the page to its offset (clamped to what it can). */
const setShelves = (offsets) =>
  evaluate(`const o = ${JSON.stringify(offsets)}; for (const k in o) { const r = window.__row(k); if (r) r.scrollLeft = Math.min(o[k], r.scrollWidth - r.clientWidth); } await new Promise((r) => setTimeout(r, 400)); return window.__shelves();`);
const shelves = () => evaluate('return window.__shelves();');
/** The shelves of `before` that are no longer the same element, or not at the same offset. */
function moved(before, after, { sameElement = true } = {}) {
  const out = [];
  for (const s of before) {
    const a = after.find((x) => x.title === s.title);
    if (!a) out.push(`${s.title}: gone`);
    else if (Math.abs(a.left - s.left) > 1) out.push(`${s.title}: ${s.left} -> ${a.left}`);
    else if (sameElement && a.tag !== s.tag) out.push(`${s.title}: drawn again`);
  }
  return out;
}

/** Runs one section when it was asked for; an error in it is a failure, and the run goes on. */
async function section(name, fn) {
  if (!want(name)) return;
  try {
    await fn();
  } catch (err) {
    check(false, `${name}: the section ran to its end (${String((err && err.message) || err).slice(0, 200)})`);
  }
}

await b.phone();

// ---- home ----
await section('home', async () => {
  await fetch(`${base}/__mock/reset?sources=2`);
  await open(`${base}/?nosw`);
  const set = { 'Aggiunti di recente': 600, Album: 450, 'I tuoi artisti': 300, 'Ascoltati di recente': 150, 'Le tue playlist': 150 };
  let before = await setShelves(set);
  log('home shelves', JSON.stringify(before));
  // Shelves whose content a play report does not touch stay the very same element.
  const ok1 = await playReport();
  let after = await shelves();
  log('after a play report', JSON.stringify(after));
  const keepers = before.filter((s) => s.title === 'Aggiunti di recente' || s.title === 'Album');
  check(ok1 && moved(keepers, after).length === 0, `Home, a play report (30 s into a song): "Aggiunti di recente" and "Album" are the same rows at the same offset (${moved(keepers, after).join('; ') || 'kept'})`);
  check(ok1 && moved(before, after, { sameElement: false }).length === 0, `Home, a play report: every shelf keeps its sideways offset, also one drawn again (${moved(before, after, { sameElement: false }).join('; ') || 'kept'})`);
  // A heart changes nothing Home shows: nothing is drawn again.
  before = await setShelves(set);
  const e0 = await emits();
  await evaluate(`const t = mpfy.store.lib.tracks.find((x) => !mpfy.store.d.likedSet.has(x.id)) || mpfy.store.lib.tracks[0]; window.__liked = t.id; mpfy.store.like(t.id); return true;`);
  const ok2 = await emitted(e0);
  await sleep(800);
  after = await shelves();
  check(ok2 && moved(before, after).length === 0, `Home, a heart (two store changes): no shelf drawn again or moved (${moved(before, after).join('; ') || 'kept'})`);
  await evaluate(`mpfy.store.unlike(window.__liked); return true;`);
  await sleep(800);
  // A connection flip changes nothing Home shows either.
  before = await setShelves(set);
  const down = await sourcesUp(false);
  after = await shelves();
  check(down && moved(before, after).length === 0, `Home, every source drops: no shelf drawn again or moved (${moved(before, after).join('; ') || 'kept'})`);
  before = after;
  const up = await sourcesUp(true);
  await sleep(1200);
  after = await shelves();
  check(up && moved(before, after).length === 0, `Home, the sources come back: no shelf drawn again or moved (${moved(before, after).join('; ') || 'kept'})`);
});

// ---- fling ----
await section('fling', async () => {
  await fetch(`${base}/__mock/reset?sources=2`);
  await open(`${base}/?nosw`);
  const ROW = 'Aggiunti di recente';
  const setup = () =>
    evaluate(`const r = window.__row(${JSON.stringify(ROW)}); r.scrollLeft = 0; r.scrollIntoView({ block: 'center' }); await new Promise((res) => setTimeout(res, 500)); const rc = r.getBoundingClientRect(); return { y: Math.round(rc.top + 60), max: r.scrollWidth - r.clientWidth };`);
  const startRec = () => evaluate(`return window.__rec(() => { const r = window.__row(${JSON.stringify(ROW)}); return r ? [window.__tag(r), Math.round(r.scrollLeft)] : [null, null]; });`);
  const stopRec = () => evaluate('return window.__recStop();');
  const summary = (rec) => {
    const tags = [...new Set(rec.map((f) => f[1]))];
    let back = 0;
    for (let i = 1; i < rec.length; i++) if (rec[i][1] === rec[i - 1][1] && rec[i][2] < rec[i - 1][2]) back += rec[i - 1][2] - rec[i][2];
    let lastMove = 0;
    for (let i = 1; i < rec.length; i++) if (rec[i][1] === rec[i - 1][1] && rec[i][2] !== rec[i - 1][2]) lastMove = rec[i][0];
    const swap = rec.findIndex((f, i) => i && f[1] !== rec[i - 1][1]);
    return { tags: tags.length, final: rec[rec.length - 1][2], max: Math.max(...rec.map((f) => f[2] || 0)), back, lastMove, swapAt: swap > 0 ? rec[swap][0] : null, beforeSwap: swap > 0 ? rec[swap - 1][2] : null, afterSwap: swap > 0 ? rec[swap][2] : null };
  };
  // A fling is flung when the row goes well past the drag itself (240 px): the first fling of a
  // page, or one under load, sometimes stops with the finger, or glides about 500 px instead of
  // about 1300 with nothing else going on. Up to four tries, until it goes as far as `want`.
  const FLUNG = 400;
  async function fling(before, after, want = FLUNG) {
    let s = null;
    for (let k = 0; k < 4; k++) {
      const g = await setup();
      if (before) await before(k);
      const e0 = await emits();
      await startRec();
      await touchFling(b, { x: 300, y: g.y, dx: -240, speed: 5000 });
      if (after) await evaluate(after);
      await sleep(2500);
      s = summary(await stopRec());
      s.changed = (await emits()) > e0;
      s.limit = g.max;
      s.tries = k + 1;
      if (s.max >= want) break;
    }
    return s;
  }
  // A: the fling alone.
  const a = await fling();
  log('fling alone', JSON.stringify(a));
  // The others are tried again while they stop short of it (a glide cut every time still fails).
  const far = Math.max(FLUNG, Math.min(a.final, a.limit) * 0.8);
  // B: the same fling, a play report lands while it glides (Home changes, this shelf does not).
  const pid = await miId();
  const bb = await fling(
    (k) => evaluate(`await fetch('/s/${pid}/api/played', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trackId: mpfy.store.lib.tracks[${9 + k}].id, context: { type: 'library', id: null } }) }); return true;`),
    'mpfy.store.refresh(); return true;',
    far
  );
  log('fling + play report', JSON.stringify(bb));
  check(a.max >= FLUNG && bb.max >= FLUNG && bb.changed && bb.tags === 1 && bb.back === 0 && bb.final >= Math.min(a.final, bb.limit) * 0.8, `a fling on "${ROW}" while a play report changes Home: the row is not drawn again and glides on (final ${bb.final}, alone ${a.final}, rows ${bb.tags}, back ${bb.back})`);
  // C: the same fling, a song added lands while it glides: this very shelf changes. It is drawn
  // again only once the glide is over, at the offset the glide reached.
  const c = await fling((k) => addSong(`Nuova di passaggio ${k + 1}.wav`), 'mpfy.store.refresh(); return true;', far);
  log('fling + song added', JSON.stringify(c));
  check(c.changed && c.swapAt != null, `a song added while "${ROW}" glides: the shelf is drawn again with it (${c.swapAt != null ? `at +${c.swapAt} ms` : 'never'})`);
  check(c.max >= FLUNG && c.swapAt != null && c.swapAt - c.lastMove >= 100 && c.beforeSwap >= Math.min(a.final, c.limit) * 0.8 && c.back === 0, `... only after the glide stopped (drawn again at +${c.swapAt} ms, last movement at +${c.lastMove} ms, reached ${c.beforeSwap}, alone ${a.final}, back ${c.back})`);
  check(c.swapAt != null && c.beforeSwap > 0 && Math.abs(c.afterSwap - c.beforeSwap) <= 1, `... at the offset the glide reached (${c.beforeSwap} -> ${c.afterSwap})`);
});

// ---- held ----
await section('held', async () => {
  await fetch(`${base}/__mock/reset?sources=2`);
  await open(`${base}/?nosw`);
  const ROW = 'Aggiunti di recente';
  const head = await evaluate(`const r = window.__row(${JSON.stringify(ROW)}); r.scrollIntoView({ block: 'center' }); r.scrollLeft = 300; await new Promise((res) => setTimeout(res, 500)); const hd = r.parentElement.querySelector('.shelf-head h2').getBoundingClientRect(); return { x: Math.round(hd.left + 10), y: Math.round(hd.top + hd.height / 2), tag: window.__tag(r), left: Math.round(r.scrollLeft) };`);
  await addSong('Mentre tieni il dito.wav');
  const e0 = await emits();
  await b.S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: head.x, y: head.y, id: 1 }] });
  await evaluate('mpfy.store.refresh(); return true;');
  const em = await emitted(e0);
  await sleep(1000);
  const during = await evaluate(`const r = window.__row(${JSON.stringify(ROW)}); return { tag: window.__tag(r), left: Math.round(r.scrollLeft) };`);
  await b.S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(800);
  const after = await evaluate(`const r = window.__row(${JSON.stringify(ROW)}); return { tag: window.__tag(r), left: Math.round(r.scrollLeft), first: r.querySelector('.card-title').textContent };`);
  log('held', JSON.stringify({ head, during, after }));
  check(em && during.tag === head.tag && during.left === head.left, `a finger resting on Home while "${ROW}" changes: the shelf waits (${JSON.stringify(during)})`);
  check(after.tag !== head.tag && after.first === 'Mentre tieni il dito' && Math.abs(after.left - head.left) <= 1, `... the finger lifts: the shelf is drawn with the new song, at its offset (${JSON.stringify(after)})`);
});

// ---- search ----
await section('search', async () => {
  await fetch(`${base}/__mock/reset?sources=2`);
  await open(`${base}/search?q=a&nosw`);
  const before = await setShelves({ Album: 600, Artisti: 300, Playlist: 150 });
  log('search shelves', JSON.stringify(before));
  const ok = await playReport();
  const after = await shelves();
  log('after a play report', JSON.stringify(after));
  check(before.length >= 2 && before.some((s) => s.left > 0), `search "a": shelves scrolled sideways (${before.map((s) => `${s.title} ${s.left}/${s.max}`).join(', ')})`);
  check(ok && moved(before, after).length === 0, `search "a", a play report: the shelves are the same rows at the same offset (${moved(before, after).join('; ') || 'kept'})`);
});

// ---- album ----
await section('album', async () => {
  await fetch(`${base}/__mock/reset?sources=2`);
  await open(`${base}/?nosw`);
  const href = await evaluate(`const a = [...document.querySelectorAll('#main a.card-link')].find((x) => /^\\/album\\//.test(x.getAttribute('href'))); return a.getAttribute('href');`);
  await open(`${base}${href}?nosw`);
  const t0 = await evaluate(`return window.__tag(document.querySelector('#main > .view').firstElementChild);`);
  const e0 = await emits();
  const down = await sourcesUp(false);
  const t1 = await evaluate(`return window.__tag(document.querySelector('#main > .view').firstElementChild);`);
  const e1 = await emits();
  log('album', JSON.stringify({ href, t0, t1, e0, e1 }));
  check(down && e1 === e0 && t1 === t0, `an album page, every source drops (no store change): the page is not drawn again (${t0 === t1 ? 'kept' : 'drawn again'}, store changes ${e1 - e0})`);
  await sourcesUp(true);
});

// ---- empty ----
await section('empty', async () => {
  // An empty library: a host with no music of its own (with MOCK_PHONE=1 the phone's songs stay).
  await fetch(`${base}/__mock/reset?sources=1&phone=0`);
  const st = await mockState();
  const mi = st.servers.find((x) => x.name === 'Mi A2');
  const ids = (await (await fetch(`${base}/s/${mi.id}/api/library`)).json()).tracks.map((t) => t.id);
  for (const id of ids) await fetch(`${base}/s/${mi.id}/api/tracks/${encodeURIComponent(id)}`, { method: 'DELETE' });
  await open(`${base}/?nosw`);
  const btn = () => evaluate(`const e = document.querySelector('#main .empty'); return e ? !!e.querySelector('button') : null;`);
  const b0 = await btn();
  const down = await sourcesUp(false);
  const b1 = await btn();
  const up = await sourcesUp(true);
  const b2 = await btn();
  log('empty', JSON.stringify({ deleted: ids.length, b0, b1, b2, down, up }));
  check(b0 === true && down && b1 === false && up && b2 === true, `Home with an empty library: "Carica brani" shows online, goes with the sources and comes back with them (${b0}, ${b1}, ${b2})`);
  await fetch(`${base}/__mock/reset?sources=2`);
});

// ---- library ----
await section('library', async () => {
  await fetch(`${base}/__mock/reset?sources=2`);
  await open(`${base}/?nosw`, 800); // a page of the app first: its storage takes the list's filter
  const mi = await miId();
  let added = 0;
  for (let i = 0; i < 70; i++) {
    const r = await fetch(`${base}/s/${mi}/api/upload/${encodeURIComponent(`Prova ${String(i + 1).padStart(2, '0')}.wav`)}`, { method: 'PUT', body: wav(i + 1) });
    if (r.ok) added++;
  }
  log('songs added for the library', added);
  const FRAME = `const m = document.getElementById('main'); const el = document.elementFromPoint(180, 420); const row = el && el.closest('.track-row, .lib-row'); return [Math.round(m.scrollTop), m.scrollHeight, row ? window.__tag(row) : null, row ? (row.querySelector('.tr-title-text, .lib-name') || {}).textContent : null];`;
  // Deep: the last row drawn past index 120, then the row of index 100 under the finger. The list
  // holds every song (aria-setsize), the page only the rows near the screen.
  const deep = async () => {
    await evaluate(`const m = document.getElementById('main'); const last = () => { const r = [...document.querySelectorAll('.lib-list .track-row')].pop(); return r ? Number(r.dataset.ci) : -1; };
      for (let i = 0; i < 40 && last() <= 120; i++) { m.scrollTop += 600; await new Promise((r) => setTimeout(r, 60)); } return true;`);
    return evaluate(`const m = document.getElementById('main'); const target = document.querySelector('.lib-list .track-row[data-ci="100"]'); m.scrollTop += target.getBoundingClientRect().top - 420 + 10; await new Promise((r) => setTimeout(r, 600));
      const one = document.querySelector('.lib-list .track-row'); return { rows: one ? Number(one.getAttribute('aria-setsize')) : 0, drawn: document.querySelectorAll('.lib-list .track-row').length, top: Math.round(m.scrollTop), height: m.scrollHeight };`);
  };
  // Every frame: [ms, scrollTop, page height, row under the finger, its title].
  const frames = async (act) => {
    await evaluate(`return window.__rec(() => { ${FRAME} });`);
    await act();
    await sleep(1200);
    return evaluate('return window.__recStop();');
  };
  const sameFrames = (rec) => {
    const f0 = rec[0];
    const odd = rec.filter((f) => f[1] !== f0[1] || f[2] < f0[2] || f[3] !== f0[3] || f[4] !== f0[4]);
    return { odd: odd.length, first: f0.slice(1), oddOnes: odd.slice(0, 3) };
  };
  for (const sort of ['recent', 'alpha']) {
    await evaluate(`localStorage.setItem('mpfy.lib.filter', JSON.stringify('track')); localStorage.setItem('mpfy.lib.sort', JSON.stringify(${JSON.stringify(sort)})); return true;`);
    await open(`${base}/library?nosw`, 2200);
    const d = await deep();
    log(`library ${sort} deep`, JSON.stringify(d));
    // The song played is the last one drawn: in Recenti it would go to the top, moving every row
    // above where it was.
    const e0 = await emits();
    const rec = await frames(async () => {
      await evaluate(`const rows = [...document.querySelectorAll('.lib-list .track-row')]; mpfy.store.played(rows[rows.length - 1].dataset.tid, { type: 'library', id: null }); return true;`);
      await emitted(e0);
    });
    const s = sameFrames(rec);
    log(`library ${sort} play report frames`, JSON.stringify(s));
    check(d.rows > 100 && (await emits()) > e0 && s.odd === 0, `Libreria > Brani (${sort === 'recent' ? 'Recenti' : 'Alfabetico'}), deep in ${d.rows}+ rows, a play report: the list is not drawn again, no frame moves, shrinks or changes the row under the finger (${s.odd} odd frames ${JSON.stringify(s.oddOnes)})`);
  }
  // A real change of the list (a song added): the list takes it (one more song, the rows drawn
  // know it), but no frame at a wrong place. The row under the finger may rightly stay the same element.
  const size = () => evaluate(`const r = document.querySelector('.lib-list .track-row'); return r ? Number(r.getAttribute('aria-setsize')) : 0;`);
  const n0 = await size();
  await addSong('Zeta nuova.wav');
  const e1 = await emits();
  const rec2 = await frames(async () => {
    await evaluate('mpfy.store.refresh(); return true;');
    await emitted(e1);
  });
  const s2 = rec2.filter((f) => f[1] !== rec2[0][1] || f[2] < rec2[0][2]);
  const n1 = await size();
  const redrawn = n1 === n0 + 1 && rec2[rec2.length - 1][2] > rec2[0][2];
  const has = await evaluate(`const m = document.getElementById('main'); for (let i = 0; i < 20; i++) { m.scrollTop = m.scrollHeight; await new Promise((r) => setTimeout(r, 100)); } return [...document.querySelectorAll('.lib-list .track-row .tr-title-text')].some((x) => x.textContent === 'Zeta nuova');`);
  log('library song added frames', JSON.stringify({ first: rec2[0], last: rec2[rec2.length - 1], odd: s2.slice(0, 3), n0, n1, has }));
  check(redrawn && has && s2.length === 0, `Libreria > Brani (Alfabetico), deep in the list, a song added: the list takes it (${n0} -> ${n1} songs, the page ${rec2[0][2]} -> ${rec2[rec2.length - 1][2]} px), and no frame jumps or shrinks (${s2.length} odd frames ${JSON.stringify(s2.slice(0, 3))}, the song at the end ${has})`);
  // Playlists: a heart changes the count of "Brani che ti piacciono" only.
  await evaluate(`localStorage.setItem('mpfy.lib.filter', JSON.stringify(null)); localStorage.setItem('mpfy.lib.sort', JSON.stringify('recent')); return true;`);
  await open(`${base}/library?nosw`, 2200);
  const rowsBefore = await evaluate(`return [...document.querySelectorAll('.lib-list .lib-row')].map((r) => window.__tag(r));`);
  const subBefore = await evaluate(`return document.querySelector('.lib-list .lib-row .lib-sub').textContent;`);
  const e2 = await emits();
  await evaluate(`const t = mpfy.store.lib.tracks.find((x) => !mpfy.store.d.likedSet.has(x.id)); window.__liked = t.id; mpfy.store.like(t.id); return true;`);
  await emitted(e2);
  await sleep(600);
  const rowsAfter = await evaluate(`return [...document.querySelectorAll('.lib-list .lib-row')].map((r) => window.__tag(r));`);
  const subAfter = await evaluate(`return document.querySelector('.lib-list .lib-row .lib-sub').textContent;`);
  const others = rowsBefore.slice(1).filter((t, i) => rowsAfter[i + 1] !== t).length;
  log('library heart', JSON.stringify({ subBefore, subAfter, others, n: rowsBefore.length }));
  check(subBefore !== subAfter && others === 0, `La tua libreria, a heart: "Brani che ti piacciono" shows the new count (${subBefore} -> ${subAfter}), the other ${rowsBefore.length - 1} rows stay as they are (${others} drawn again)`);
  await evaluate(`mpfy.store.unlike(window.__liked); localStorage.removeItem('mpfy.lib.filter'); localStorage.removeItem('mpfy.lib.sort'); return true;`);
  await sleep(500);
});

// ---- upload ----
await section('upload', async () => {
  await fetch(`${base}/__mock/reset?sources=2`);
  await b.S('Network.enable');
  await b.S('Emulation.setTouchEmulationEnabled', { enabled: false });
  await b.S('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
  await b.S('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await open(`${base}/?nosw`);
  const WAVJS = `
    const wav = (n, seed) => { const a = new Uint8Array(44 + n), dv = new DataView(a.buffer); const w = (o, s) => [...s].forEach((ch, i) => (a[o + i] = ch.charCodeAt(0)));
      w(0, 'RIFF'); dv.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
      dv.setUint32(24, 11025, true); dv.setUint32(28, 22050, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n, true);
      for (let i = 0; i < n; i++) a[44 + i] = (i * seed) & 255; return a; };
    const jpg = () => new Promise((r) => { const c = document.createElement('canvas'); c.width = 200; c.height = 200; const g = c.getContext('2d'); g.fillStyle = '#3060c0'; g.fillRect(0, 0, 200, 200); c.toBlob(r, 'image/jpeg', 0.9); });
    const { uploads } = await import('/js/upload.js');`;
  await evaluate(`${WAVJS} uploads.add([new File([wav(4410, 7)], 'Prova copertina.wav', { type: 'audio/wav' }), new File([await jpg()], 'cover.jpg', { type: 'image/jpeg' })]); return true;`);
  await sleep(2000);
  await evaluate(`document.querySelector('.home-top [aria-label="Carica brani"]').click(); return true;`);
  await sleep(1200);
  const before = await evaluate(`return { rows: document.querySelectorAll('.up-row').length, offers: document.querySelectorAll('.up-offer').length, footer: [...document.querySelectorAll('.up-footer button')].map((x) => x.textContent) };`);
  log('upload sheet', JSON.stringify(before));
  await b.S('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: 40000 });
  await evaluate(`${WAVJS} uploads.add([new File([wav(3000000, 3)], 'Lento.wav', { type: 'audio/wav' })]);
    window.__foot = 0; new MutationObserver((l) => (window.__foot += l.length)).observe(document.querySelector('.up-footer'), { childList: true, subtree: true });
    window.__prog = 0; new MutationObserver((l) => (window.__prog += l.length)).observe(document.querySelector('.up-list'), { subtree: true, attributes: true, characterData: true, childList: true });
    return true;`);
  await sleep(1500);
  const rate = await evaluate(`const f = window.__foot, p = window.__prog; await new Promise((r) => setTimeout(r, 1000)); return { footer: window.__foot - f, progress: window.__prog - p, state: [...document.querySelectorAll('.up-row')].pop().querySelector('.up-state').textContent, buttons: [...document.querySelectorAll('.up-footer button')].map((x) => x.textContent) };`);
  log('while uploading', JSON.stringify(rate));
  check(rate.progress > 0 && rate.footer === 0, `"Carica brani" while a file uploads: progress moves (${rate.progress} changes/s, ${rate.state}), the footer is not drawn again (${rate.footer} changes/s)`);
  // A mouse press on "Svuota elenco", progress in between, release.
  const p = await evaluate(`const e = [...document.querySelectorAll('.up-footer button')].find((x) => x.textContent.includes('Svuota elenco')); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };`);
  let clicked = false;
  if (p) {
    await b.S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    await b.S('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    const p0 = await evaluate('return window.__prog;');
    for (let i = 0; i < 40 && (await evaluate('return window.__prog;')) === p0; i++) await sleep(25);
    const between = (await evaluate('return window.__prog;')) > p0;
    await sleep(30);
    await b.S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await sleep(600);
    const rows = await evaluate(`return [...document.querySelectorAll('.up-row .up-name')].map((x) => x.textContent);`);
    clicked = !rows.includes('Prova copertina.wav');
    log('svuota', JSON.stringify({ p, between, rows }));
    check(between && clicked, `a mouse click on "Svuota elenco" with progress between press and release: the finished row goes (${JSON.stringify(rows)})`);
  } else check(false, '"Svuota elenco" in the footer');
  await b.S('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await evaluate(`const { uploads } = await import('/js/upload.js'); for (const j of uploads.jobs) uploads.cancel(j); return true;`).catch(() => {});
  await sleep(500);
  await b.phone();
});

// ---- choice ----
await section('choice', async () => {
  await b.phone();
  await fetch(`${base}/__mock/reset?sources=2`);
  await open(`${base}/?nosw`);
  const ZIPJS = `
    const crcT = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const zip = (entries) => {
      const parts = []; const cent = []; let off = 0;
      for (const e of entries) {
        const name = new TextEncoder().encode(e.name); const c = crc(e.bytes);
        const lh = new Uint8Array(30 + name.length); const dv = new DataView(lh.buffer);
        dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint32(14, c, true); dv.setUint32(18, e.bytes.length, true); dv.setUint32(22, e.bytes.length, true); dv.setUint16(26, name.length, true); lh.set(name, 30);
        const ch = new Uint8Array(46 + name.length); const cv = new DataView(ch.buffer);
        cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint32(16, c, true); cv.setUint32(20, e.bytes.length, true); cv.setUint32(24, e.bytes.length, true); cv.setUint16(28, name.length, true); cv.setUint32(42, off, true); ch.set(name, 46);
        parts.push(lh, e.bytes); cent.push(ch); off += lh.length + e.bytes.length;
      }
      const size = cent.reduce((n, c) => n + c.length, 0);
      const end = new Uint8Array(22); const ev = new DataView(end.buffer);
      ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true); ev.setUint32(12, size, true); ev.setUint32(16, off, true);
      return new Blob([...parts, ...cent, end]);
    };
    const wav = (n, seed) => { const b = new Uint8Array(44 + n), dv = new DataView(b.buffer); const w = (o, s) => [...s].forEach((c, i) => (b[o + i] = c.charCodeAt(0))); w(0, 'RIFF'); dv.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, 11025, true); dv.setUint32(28, 22050, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n, true); for (let i = 0; i < n; i++) b[44 + i] = (i * seed) & 255; return b; };`;
  await evaluate(`document.querySelector('.home-top [aria-label="Carica brani"]').click(); return true;`);
  await sleep(1000);
  await evaluate(`${ZIPJS}
    const { uploads } = await import('/js/upload.js');
    uploads.add([new File([zip([{ name: 'Nebbia [forse].wav', bytes: wav(5000, 3) }, { name: 'Approdo [forse].wav', bytes: wav(5200, 5) }, { name: 'Saline [forse].wav', bytes: wav(5400, 7) }])], 'Tre forse.zip', { type: 'application/zip' })]);
    return true;`);
  const question = async (not) => {
    for (let i = 0; i < 120; i++) {
      const q = await evaluate(`const t = document.querySelector('.up-choice-title'); const btn = [...document.querySelectorAll('.up-choice .btn')].find((x) => /migliore/.test(x.textContent)); if (!t || !btn || btn.disabled) return null; const r = btn.getBoundingClientRect(); const { uploads } = await import('/js/upload.js'); const j = uploads.jobs.find((x) => x.archive); return { q: t.textContent, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), pending: j && j.archive.pending ? j.archive.pending.length : null };`);
      if (q && q.q !== not) return q;
      await sleep(100);
    }
    return null;
  };
  const q1 = await question();
  log('first question', JSON.stringify(q1));
  if (!q1) check(false, 'the archive asks its first "maybe"');
  else {
    await doubleTap(b, q1.x, q1.y, { gap: 150, hold: 50 });
    await sleep(1500);
    const q2 = await question();
    log('after a double tap', JSON.stringify(q2));
    check(q1.pending === 3 && q2 && q2.pending === 2 && q2.q === 'Sembra lo stesso brano di Approdo', `an archive with three "maybe" songs, a double tap on "Tieni la versione migliore": one answer, the next question shows (${q1.pending} -> ${q2 && q2.pending}, ${q2 && q2.q})`);
    if (q2) {
      // A deliberate tap on the question just shown, 450 ms after it appeared, answers it.
      await tap(b, q2.x, q2.y, { hold: 60 });
      const q3 = await question(q2.q);
      await sleep(450);
      if (q3) await tap(b, q3.x, q3.y, { hold: 60 });
      await sleep(1500);
      const end = await evaluate(`const { uploads } = await import('/js/upload.js'); const j = uploads.jobs.find((x) => x.archive); return { state: j.state, pending: j.archive.pending.length, title: (document.querySelector('.up-choice-title') || {}).textContent || null };`);
      log('deliberate taps', JSON.stringify({ q3, end }));
      check(q3 && q3.q === 'Sembra lo stesso brano di Saline' && end.pending === 0 && end.state === 'archived', `... single taps after it answer the next questions, one 450 ms after its question appeared (${q3 && q3.q}; then ${JSON.stringify(end)})`);
    }
  }
});

// ---- menu ----
await section('menu', async () => {
  await b.phone();
  await fetch(`${base}/__mock/reset?sources=2`);
  await open(`${base}/?nosw`, 800);
  await evaluate(`localStorage.setItem('mpfy.lib.filter', JSON.stringify('track')); localStorage.setItem('mpfy.lib.sort', JSON.stringify('alpha')); return true;`);
  const song = await evaluate(`const t = [...mpfy.store.lib.tracks].sort((a, b) => a.title.localeCompare(b.title))[2]; return { id: t.id, title: t.title, artist: t.artist, album: t.album };`);
  const sel = JSON.stringify(`.track-row[data-tid="${song.id}"]`);
  // "..." on the row, then "Modifica informazioni": the fields of the form.
  const openForm = () =>
    evaluate(`const row = document.querySelector(${sel}); if (!row) return { err: 'no row' };
      row.querySelector('.tr-more').click(); await new Promise((r) => setTimeout(r, 700));
      const item = [...document.querySelectorAll('.sheet button')].find((x) => /Modifica informazioni/.test(x.textContent));
      if (!item) return { err: 'no item' };
      item.click(); await new Promise((r) => setTimeout(r, 900));
      return { fields: [...document.querySelectorAll('.dialog-fields input')].map((x) => x.value) };`);
  const save = (album) =>
    evaluate(`const inputs = [...document.querySelectorAll('.dialog-fields input')]; inputs[2].value = ${JSON.stringify(album)}; inputs[2].dispatchEvent(new Event('input', { bubbles: true }));
      [...document.querySelectorAll('.dialog button')].find((x) => x.textContent.trim() === 'Salva').click(); await new Promise((r) => setTimeout(r, 1500)); return true;`);
  const albumNow = () => evaluate(`return mpfy.store.track(${JSON.stringify(song.id)}).album;`);
  for (const where of ['library', 'search']) {
    await open(where === 'library' ? `${base}/library?nosw` : `${base}/search?q=${encodeURIComponent(song.artist)}&nosw`, 2000);
    const first = await albumNow();
    const tag0 = await evaluate(`return window.__tag(document.querySelector(${sel}));`);
    const e0 = await emits();
    const other = `Altro album ${where}`;
    await evaluate(`await mpfy.store.editTrack(${JSON.stringify(song.id)}, { album: ${JSON.stringify(other)} }); return true;`);
    await emitted(e0);
    await sleep(600);
    const kept = (await evaluate(`return window.__tag(document.querySelector(${sel}));`)) === tag0;
    const f = await openForm();
    // The person puts the first album back from that form.
    if (f.fields) await save(first);
    const back = await albumNow();
    log(`menu ${where}`, JSON.stringify({ song, first, other, kept, form: f, back }));
    check(f.fields && f.fields[2] === other && back === first, `${where === 'library' ? 'Libreria > Brani' : `search "${song.artist}"`}, the album of "${song.title}" changed under a row kept on screen: its "Modifica informazioni" shows the new album (${f.fields ? f.fields[2] : f.err}) and putting "${first}" back reaches the store (${back}; row kept ${kept})`);
  }
  await evaluate(`localStorage.removeItem('mpfy.lib.filter'); localStorage.removeItem('mpfy.lib.sort'); return true;`);
});

// ---- focus ----
await section('focus', async () => {
  await fetch(`${base}/__mock/reset?sources=2`);
  await b.S('Emulation.setTouchEmulationEnabled', { enabled: false });
  await b.S('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
  await open(`${base}/?nosw`);
  const ROW = 'I tuoi artisti';
  // The keyboard focus on the last card; a play report of that artist's song moves the card first.
  const f0 = await evaluate(`const r = window.__row(${JSON.stringify(ROW)}); const links = [...r.querySelectorAll('a.card-link')]; const l = links[links.length - 1]; l.focus(); await new Promise((x) => setTimeout(x, 300));
    return { tag: window.__tag(r), href: l.getAttribute('href'), label: l.getAttribute('aria-label'), focused: document.activeElement === l, left: Math.round(r.scrollLeft), n: links.length };`);
  const e0 = await emits();
  await evaluate(`const ar = mpfy.store.d.artists.get(decodeURIComponent(${JSON.stringify(f0.href)}.split('/').pop())); mpfy.store.played(ar.trackIds[0], { type: 'artist', id: ar.id }); return true;`);
  const ok = await emitted(e0);
  await sleep(600);
  const f1 = await evaluate(`const r = window.__row(${JSON.stringify(ROW)}); const a = document.activeElement; return { tag: window.__tag(r), href: a && a.getAttribute('href'), body: a === document.body, inRow: !!(a && r.contains(a)), at: [...r.querySelectorAll('a.card-link')].indexOf(a), left: Math.round(r.scrollLeft) };`);
  log('focus home', JSON.stringify({ f0, f1 }));
  check(ok && f0.focused && f1.tag !== f0.tag && f1.inRow && f1.href === f0.href && Math.abs(f1.left - f0.left) <= 1, `Home, the keyboard focus on "${f0.label}" in "${ROW}", a play report moves that card from last to first: the focus stays on it in the shelf drawn again, which does not move (${f1.body ? 'focus lost' : `${f1.href}, card ${f1.at + 1} of ${f0.n}`}, ${f0.left} -> ${f1.left})`);
  // The sidebar list: the focus on an artist row low in it, a play report moves it to the top.
  const s0 = await evaluate(`const rows = [...document.querySelectorAll('#sidebar .lib-row')]; const l = rows.filter((x) => /^\\/artist\\//.test(x.getAttribute('href'))).pop(); l.focus(); await new Promise((x) => setTimeout(x, 300));
    return { href: l.getAttribute('href'), at: rows.indexOf(l), n: rows.length, focused: document.activeElement === l, tag: window.__tag(l) };`);
  const e1 = await emits();
  await evaluate(`const ar = mpfy.store.d.artists.get(decodeURIComponent(${JSON.stringify(s0.href)}.split('/').pop())); mpfy.store.played(ar.trackIds[0], { type: 'artist', id: ar.id }); return true;`);
  const ok2 = await emitted(e1);
  await sleep(600);
  // The row moves up (a windowed list moves the row's own element, or draws it again): the focus
  // stays on it.
  const s1 = await evaluate(`const rows = [...document.querySelectorAll('#sidebar .lib-row')]; const a = document.activeElement; const same = rows.find((x) => x.getAttribute('href') === ${JSON.stringify(s0.href)}); return { href: a && a.getAttribute('href'), body: a === document.body, inList: !!(a && a.closest('#sidebar .lib-list')), at: rows.indexOf(same), on: a === same };`);
  log('focus sidebar', JSON.stringify({ s0, s1 }));
  check(ok2 && s0.focused && s1.on && s1.at < s0.at && s1.inList && s1.href === s0.href, `the sidebar list, the keyboard focus on ${s0.href} (row ${s0.at + 1} of ${s0.n}), a play report moves it to row ${s1.at + 1}: the focus stays on it (${s1.body ? 'focus lost' : s1.href})`);
  // The focus on "Brani che ti piacciono", a heart: that row alone is drawn again with its count.
  const p0 = await evaluate(`const l = document.querySelector('#sidebar .lib-row[href="/liked"]'); l.focus(); await new Promise((x) => setTimeout(x, 300)); return { focused: document.activeElement === l, tag: window.__tag(l), sub: l.querySelector('.lib-sub').textContent };`);
  const e2 = await emits();
  await evaluate(`const t = mpfy.store.lib.tracks.find((x) => !mpfy.store.d.likedSet.has(x.id)); window.__liked = t.id; mpfy.store.like(t.id); return true;`);
  const ok3 = await emitted(e2);
  await sleep(600);
  const p1 = await evaluate(`const l = document.querySelector('#sidebar .lib-row[href="/liked"]'); const a = document.activeElement; return { tag: window.__tag(l), sub: l.querySelector('.lib-sub').textContent, on: a === l, body: a === document.body };`);
  log('focus liked', JSON.stringify({ p0, p1 }));
  check(ok3 && p0.focused && p1.tag !== p0.tag && p1.sub !== p0.sub && p1.on, `the sidebar list, the keyboard focus on "Brani che ti piacciono", a heart draws that row again (${p0.sub} -> ${p1.sub}): the focus stays on it (${p1.on ? 'kept' : p1.body ? 'focus lost' : 'elsewhere'})`);
  await evaluate(`mpfy.store.unlike(window.__liked); return true;`);
  await sleep(500);
  await b.phone();
});

log('page errors', JSON.stringify(b.errors));
check(!b.errors.length, `no page errors (${b.errors.length})`);
log(`fails=${fails}`);
console.log(`fails=${fails}`);
flush();
b.close();
mock.kill();
process.exit(fails ? 1 : 0);
