// The songs part of the full player (comments and lyrics), as people use it, on a phone screen
// with touch, against the mock source (both sources at social 3 unless a scenario says):
//   cards      the "Testo" card: the line being sung at, before and after the line times (past,
//              now, next), a tap on a line jumps there, a plain text still, another version's
//              text with the offset between the files applied, no card for an instrumental or a
//              song without; the "Commenti" card: the count and the newest two, a comment both
//              sources hold shown once, the line "Aggiungi un commento" with none; a source below
//              3 shows nothing of its own, none at 3: no card and no menu item
//   player     at the top a drag up on the cover scrolls to the cards and a drag down closes the
//              player; scrolled down, a drag down on the cover scrolls back and closes nothing
//   timing     nothing is asked before a track stayed 1 s; a burst of 10 skips in 2 s asks the
//              comments and lyrics of the last track only; a song asked less than 60 s ago is not
//              asked again
//   comments   the sheet: yours shows at the top at once (posted to every source holding the
//              song, with its trackId there), the composer goes; a long press on yours: "Modifica"
//              (sent again with its id) and "Elimina" (everywhere it was returned); as owner,
//              "Elimina" on someone else's from your source only; nothing on others'; a refused
//              post goes with "Qualcosa non ha funzionato" and its text back; a photo opens that
//              person's page
//   full       the full screen: the current line kept at a third of the height, a scroll by hand
//              stops the following for 5 s, a tap on a line jumps there, Back closes it
//   menu       the track menu: "Commenti" opens the sheet, "Aggiungi testo" with an .lrc and
//              "Togli testo" (own track rights), nothing of it on someone else's track
//   offline    the app (a fake bridge): a downloaded track's lyrics kept in IndexedDB, read from
//              there with every source out of reach, gone with the download; a copy whose source
//              is out of reach waits for that source (the sources changing meanwhile ask nothing
//              again); with no source to ask, the "Commenti" card does not say there are none
//   fling      a fling on the scrolling player, then a tap on a lyric line while it glides: no
//              jump, nothing opens; a finger on the position slider of a player that moves:
//              nothing (on a still one it seeks); a double tap on a line jumps once
//   send       a double tap on the comments' "Invia" posts once
//   sheet      a fling in the comments sheet, then a tap while it glides: no menu, no page; a long
//              press that lands on the gliding list: nothing
//
//   node web/dev/gestures-songs.mjs <out dir> [--only name|name]
//
// Prints PASS/FAIL lines and fails=<n> (exit 1 on a failure); the same lines and the details go
// to <out dir>/gestures-songs.log, with screenshots of the cards, the sheet and the full screen.
import fs from 'node:fs';
import path from 'node:path';
import { startMock, startBrowser, tap, doubleTap, sleep, logger } from './gesture-lib.mjs';

const outDir = path.resolve(process.argv[2] || '.');
fs.mkdirSync(outDir, { recursive: true });
const onlyAt = process.argv.indexOf('--only');
const only = onlyAt > 0 ? process.argv[onlyAt + 1].split('|') : null;
const L = logger(path.join(outDir, 'gestures-songs.log'));
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
const state = async () => (await fetch(`${base}/__mock/state`)).json();
const songsState = async () => (await state()).songs;
const helper = (q) => fetch(`${base}/__mock/${q}`);

/** A clean page: storage cleared, the mock's sample data (and the helpers' extras), the library loaded. */
async function fresh(route = '/', extra = [], { fake = null } = {}) {
  await touch('touchCancel', []).catch(() => {});
  await b.S('Page.navigate', { url: 'about:blank' });
  await sleep(200);
  await b.S('Storage.clearDataForOrigin', { origin: base, storageTypes: 'local_storage,indexeddb,service_workers,cache_storage' });
  await helper('reset?sources=2');
  for (const e of [].concat(extra).filter(Boolean)) await helper(e);
  if (fake) await b.S('Page.addScriptToEvaluateOnNewDocument', { source: fake });
  await b.go(`${base}${route}${route.includes('?') ? '&' : '?'}nosw`, 600);
  await run(`for (let i = 0; i < 80 && !(window.mpfy && mpfy.store.loaded && mpfy.store.lib.tracks.length && mpfy.sources.loaded); i++) await new Promise((r) => setTimeout(r, 100)); return true;`);
  await sleep(500);
  await run(`window.__seeks = []; if (!window.__seekWrapped) { window.__seekWrapped = true; const s = mpfy.player.seek; mpfy.player.seek = (x) => { window.__seeks.push(x); return s.call(mpfy.player, x); }; } return true;`);
}
/** The songs of the sample by title: { song id, versions [{ sourceId, trackId }] }. */
const song = (title) =>
  run(`const t = mpfy.store.lib.tracks.find((x) => x.title === ${JSON.stringify(title)}); if (!t) return null;
    return { id: t.id, versions: mpfy.store.versions(t.id).map((v) => ({ sourceId: v.sourceId, trackId: v.trackId })) };`);
const sourceIds = () => run(`const s = mpfy.sources.list; return { mi: s.find((x) => x.name === 'Mi A2').id, vps: s.find((x) => x.name === 'VPS prova').id };`);
/** Plays these songs (from the first) and waits until it plays. */
async function play(ids, { idx = 0, at = null, pause = false } = {}) {
  await run(`mpfy.player.playContext({ type: 'library', id: null }, ${JSON.stringify(ids)}, ${idx});
    for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 100)); if (mpfy.player.state.playing && mpfy.player.positionNow() > 0.3) break; }
    return true;`);
  if (at != null) await run(`mpfy.player.seek(${at}); return true;`);
  if (pause) await run(`mpfy.player.pause(); return true;`);
  await sleep(300);
  await run('window.__seeks = []; return true;');
}
async function openPlayer() {
  await run(`document.querySelector('.mini-main').click(); return true;`);
  await sleep(900);
}
/** Scrolls the player to its end (the cards), or to the top. */
const scrollPlayer = (to) => run(`const i = document.querySelector('.np-inner'); i.scrollTop = ${to === 'end' ? 'i.scrollHeight' : '0'}; return i.scrollTop;`);
const at = (sel, { text = null, idx = 0, fy = 0.5 } = {}) =>
  run(`const els = [...document.querySelectorAll(${JSON.stringify(sel)})].filter((e) => !e.closest('.view-leaving') && !e.closest('.closing') && (${JSON.stringify(text)} == null || e.textContent.includes(${JSON.stringify(text)})));
    const e = els[${idx}]; if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height * ${fy}) };`);
const ready = (sel, n = 60) => run(`for (let i = 0; i < ${n} && !document.querySelector(${JSON.stringify(sel)}); i++) await new Promise((r) => setTimeout(r, 100)); return !!document.querySelector(${JSON.stringify(sel)});`);
const card = () =>
  run(`const l = document.querySelector('.lyr-card'); const c = document.querySelector('.cm-card');
    return { lyr: l && !l.hidden ? [...l.querySelectorAll('.lyr p')].map((p) => [p.className, p.textContent, p.dataset.t ? Number(p.dataset.t) : null]) : null,
      still: !!(l && l.querySelector('.lyr.is-still')),
      cm: c && !c.hidden ? { n: c.querySelector('.n').hidden ? 0 : Number(c.querySelector('.n').textContent), minis: [...c.querySelectorAll('.cm-mini')].map((m) => m.querySelector('.cm-who b').textContent + ': ' + m.querySelector('.cm-said').textContent), empty: c.querySelector('.cm-empty')?.textContent || null } : null };`);
const layers = () => run(`return [...document.querySelectorAll('#layers > .layer:not(.closing)')].map((l) => l.querySelector('[aria-label]')?.getAttribute('aria-label') || l.className);`);
const rows = () => run(`return [...document.querySelectorAll('.cm-sheet .cm-row')].map((r) => ({ who: r.querySelector('.cm-who b')?.textContent, text: r.querySelector('.cm-text')?.textContent, pending: r.classList.contains('is-pending'), id: r.dataset.id }));`);
const composerShown = () => run(`const c = document.querySelector('.cm-sheet .composer-dock'); return !!c && !c.hidden;`);
const seeks = () => run('return window.__seeks;');
const toasts = () => run(`return [...document.querySelectorAll('.toast')].map((t) => t.textContent);`);
const pathNow = () => run('return location.pathname;');
/** Types into the comments' field (a tap to focus it, then the text as a keyboard gives it). */
async function typeComment(text) {
  await run(`const i = document.querySelector('.cm-sheet .composer-input'); i.focus(); i.value = ''; i.dispatchEvent(new Event('input')); return true;`);
  await b.S('Input.insertText', { text });
  await sleep(150);
}
/** A finger held still for ms on p (a long press), then lifted. */
async function hold(p, ms = 700) {
  await touch('touchStart', [{ x: p.x, y: p.y, id: 1 }]);
  await sleep(ms);
  await touch('touchEnd', []);
}
/** A fling whose last move and lift go out together. */
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
/** A slow drag (no fling), lifted after resting still. */
async function drag({ x, y, dy, steps = 14 }) {
  await touch('touchStart', [{ x, y, id: 1 }]);
  for (let i = 1; i <= steps; i++) {
    await sleep(16);
    await touch('touchMove', [{ x, y: y + (dy * i) / steps, id: 1 }]);
  }
  await sleep(120);
  await touch('touchEnd', []);
}
/** Records the scroll offsets of sel, and the lifts and presses, with their times. */
const watchScroll = (sel) =>
  run(`const el = document.querySelector(${JSON.stringify(sel)}); window.__sc = []; window.__ups = []; window.__downs = [];
    const w = window.__watch;
    if (w) { w.el.removeEventListener('scroll', w.onScroll, { passive: true }); window.removeEventListener('touchend', w.onUp, true); window.removeEventListener('touchstart', w.onDown, true); }
    const onScroll = () => window.__sc.push([Math.round(performance.now()), Math.round(el.scrollTop)]);
    const onUp = () => window.__ups.push(Math.round(performance.now()));
    const onDown = () => window.__downs.push(Math.round(performance.now()));
    el.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('touchend', onUp, true);
    window.addEventListener('touchstart', onDown, true);
    window.__watch = { el, onScroll, onUp, onDown };
    return true;`);
/** The tap came while the list still glided (0.2 px/ms or more right up to the press). */
const glidedUntilTap = () =>
  run(`const lift = window.__ups[0]; const press = window.__downs[1]; if (lift == null || press == null) return false;
    const moving = window.__sc.filter((e) => e[0] > lift && e[0] <= press + 5); if (moving.length < 2) return false;
    const a = moving[moving.length - 2]; const z = moving[moving.length - 1];
    return z[0] >= press - 30 && Math.abs(z[1] - a[1]) / Math.max(1, z[0] - a[0]) >= 0.2;`);

const scenarios = [];
const scenario = (name, fn) => scenarios.push({ name, fn });

// ---------------------------------------------------------------------------------------------
scenario('cards', async () => {
  await fresh('/');
  const luce = await song('Luce di posizione');
  await play([luce.id], { at: 2, pause: true });
  await openPlayer();
  await scrollPlayer('end');
  await sleep(500);
  let c = await card();
  check(!!c.lyr && c.lyr.map((x) => x[0]).join() === 'next,next,next' && c.lyr[0][1] === 'Lascio il molo al buio', 'before the first line: the first three wait as lines to come', c.lyr);
  await b.shot(path.join(outDir, 'songs-cards.png'));
  check(!!c.cm && c.cm.n === 6 && c.cm.minis.length === 2 && c.cm.minis[0] === "Marco: l'ascolto da una settimana \u{1F30A}" && c.cm.minis[1] === 'Giulia: in macchina di notte \u00e8 perfetta', 'the "Commenti" card: the count of both versions together, the newest two', c.cm);
  await run('mpfy.player.seek(34.5); return true;');
  await sleep(400);
  c = await card();
  check(c.lyr && c.lyr.map((x) => x[0] + ':' + x[1]).join('|') === 'past:verde a destra|now:non chiedo dove vado|next:basta che tu mi veda', 'at a line time: that line is the one sung, the one before faded, the next to come', c.lyr);
  await run('mpfy.player.seek(125); return true;');
  await sleep(400);
  c = await card();
  check(c.lyr && c.lyr.map((x) => x[0]).join() === 'past,past,now' && c.lyr[2][1].startsWith('finch'), 'after the last line: the last one stays, with the two before it', c.lyr);
  // A tap on a line jumps there.
  await run('mpfy.player.seek(20); return true;');
  await sleep(400);
  await run('window.__seeks = []; return true;');
  const line = await at('.lyr-card .lyr p.next');
  const want = (await card()).lyr.find((x) => x[0] === 'next')[2];
  await tap(b, line.x, line.y);
  await sleep(500);
  let sk = await seeks();
  check(sk.length === 1 && Math.abs(sk[0] - want / 1000) < 0.01 && (await card()).lyr.some((x) => x[0] === 'now' && x[2] === want), `a tap on a line jumps to its time (${JSON.stringify(sk)} for ${want} ms)`, sk);

  // Another version's text: "Il guardiano del faro" plays from the Mi A2, its lyrics are the VPS copy's.
  const guard = await song('Il guardiano del faro');
  await play([guard.id], { at: 30, pause: true });
  await sleep(1500);
  const off = await run(`const s = mpfy.store.versions(${JSON.stringify(guard.id)}); const p = mpfy.player.playingVersionId(); return { playing: p, versions: s.map((v) => [v.sourceId, v.trackId, v.t.lyrics || null]) };`);
  c = await card();
  const nowLine = c.lyr && c.lyr.find((x) => x[0] === 'now');
  check(!!c.lyr && !c.still && !!nowLine, 'another version has the text: its lines follow the song played', { c, off });
  await scrollPlayer('end');
  await sleep(300);
  await run('window.__seeks = []; return true;');
  const ln = await at('.lyr-card .lyr p.next');
  const lnT = (await card()).lyr.find((x) => x[0] === 'next')[2];
  await tap(b, ln.x, ln.y);
  await sleep(400);
  sk = await seeks();
  const shift = sk.length ? Math.round(lnT - sk[0] * 1000) : null;
  check(sk.length === 1 && shift != null && Math.abs(shift) >= 100 && Math.abs(shift) <= 1000, `with the offset between the two files applied (a line of the copy at ${lnT} ms is ${shift} ms away in the file played)`, { sk, lnT, off });

  // A plain text: its first 4 lines, still.
  const citta = await song('Città di sale');
  await play([citta.id], { at: 5 });
  await sleep(1500);
  const c1 = await card();
  await sleep(1500);
  const c2 = await card();
  check(c1.still && c1.lyr && c1.lyr.length === 4 && c1.lyr[0][1] === 'Strade bianche di sale' && JSON.stringify(c1.lyr) === JSON.stringify(c2.lyr), 'a plain text: its first 4 lines, still while the song plays', c1.lyr);
  // An instrumental, a song without lyrics: no card. A song without comments: the line "Aggiungi un commento".
  const cass = await song('Cassiopea');
  await play([cass.id], { at: 5 });
  await sleep(1500);
  c = await card();
  check(!c.lyr, 'an instrumental: no "Testo" card', c);
  const nebbia = await song('Nebbia');
  await play([nebbia.id], { at: 5 });
  await sleep(1500);
  c = await card();
  check(!c.lyr && c.cm && c.cm.n === 0 && c.cm.empty === 'Aggiungi un commento' && !c.cm.minis.length, 'no lyrics: no card; no comments: the head and "Aggiungi un commento"', c);
  // "Frequenze": one comment both sources hold is shown once.
  const freq = await song('Frequenze');
  await play([freq.id], { at: 5 });
  await sleep(1500);
  c = await card();
  check(c.cm && c.cm.n === 3 && c.cm.minis.filter((m) => m.startsWith('Giulia')).length <= 1, 'a comment both sources hold counts once (3 people, 4 copies)', c.cm);
  await scrollPlayer('end');
  await run(`document.querySelector('.cm-card').click(); return true;`);
  await sleep(1000);
  const r = await rows();
  check(r.length === 3 && r.filter((x) => x.text === 'questa la metto sempre').length === 1, 'in the sheet too: once', r);
  await run('history.back(); return true;');
  await sleep(600);

  // A source below 3 shows nothing of its own: "Frequenze" keeps the Mi A2's comments, its text (on the VPS) goes.
  const src = await sourceIds();
  await fresh('/', [`source?source=${src.vps}&social=2`]);
  await play([freq.id], { at: 5 });
  await openPlayer();
  await sleep(1500);
  c = await card();
  check(!c.lyr && c.cm && c.cm.n === 2, 'the VPS at social 2: its comments and its lyrics are not shown, the Mi A2 ones are', c);
  // No source at 3: no card, no menu item.
  await fresh('/', ['chat?level=2']);
  await play([luce.id], { at: 5 });
  await openPlayer();
  await sleep(1500);
  c = await card();
  await run(`document.querySelector('.np-head [aria-label="Altre opzioni per il brano"]').click(); return true;`);
  await sleep(700);
  const items = await run(`return [...document.querySelectorAll('.layer-sheet .menu-item')].map((x) => x.textContent);`);
  check(!c.lyr && !c.cm && !items.some((x) => x === 'Commenti' || x.includes('testo')), 'no source at 3: no cards, no "Commenti" and no lyrics items in the menu', { c, items });
});

// ---------------------------------------------------------------------------------------------
scenario('player', async () => {
  await fresh('/');
  const luce = await song('Luce di posizione');
  await play([luce.id], { at: 20 });
  await openPlayer();
  const cov = await at('.np-art');
  // At the top: a drag up on the cover scrolls to the cards.
  await drag({ x: cov.x, y: cov.y + 100, dy: -260 });
  await sleep(500);
  const st1 = await run(`return { top: document.querySelector('.np-inner').scrollTop, open: document.body.classList.contains('np-open') };`);
  check(st1.open && st1.top > 100, `at the top a drag up on the cover scrolls to the cards (${st1.top} px)`, st1);
  // Scrolled: a drag down on the cover scrolls back, the player stays.
  const cov2 = await at('.np-art', { fy: 0.85 });
  await drag({ x: cov2.x, y: Math.max(80, cov2.y - 20), dy: 240 });
  await sleep(600);
  const st2 = await run(`return { top: document.querySelector('.np-inner').scrollTop, open: document.body.classList.contains('np-open') };`);
  check(st2.open && st2.top < st1.top, `scrolled down, a drag down on the cover scrolls back and the player stays (${st1.top} -> ${st2.top})`, st2);
  await scrollPlayer('top');
  await sleep(300);
  // At the top: a drag down closes it.
  const cov3 = await at('.np-art');
  await drag({ x: cov3.x, y: cov3.y - 80, dy: 240 });
  await sleep(800);
  const st3 = await run(`return document.body.classList.contains('np-open');`);
  check(!st3, 'at the top a drag down on the cover closes the player');
});

// ---------------------------------------------------------------------------------------------
scenario('timing', async () => {
  await fresh('/');
  const names = ['Nebbia', 'Città di sale', 'Segnali lontani', 'Il guardiano del faro', 'Approdo', 'Cassiopea', 'Saline', 'Vento di terra', 'Frequenze', 'Mareggiata', 'Luce di posizione'];
  const list = [];
  for (const n of names) list.push(await song(n));
  await play(list.map((x) => x.id), { at: 3 });
  await openPlayer();
  await sleep(1500);
  // A track kept for less than a second is not asked for; once it stayed 1 s it is.
  await helper('songs?clear=1');
  await run('mpfy.player.next(); return true;');
  await sleep(500);
  const early = await songsState();
  await sleep(1100);
  const late = await songsState();
  const second = list[1];
  const askedFor = (s, x) => s.gets.filter((g) => g.tracks.some((t) => x.versions.some((v) => v.trackId === t)));
  check(askedFor(early, second).length === 0 && askedFor(late, second).length === new Set(second.versions.map((v) => v.sourceId)).size && late.lyricsGets.length === 1, `a new track: nothing asked at 0.5 s, its comments (one per source) and lyrics once it stayed 1 s (${early.gets.length} then ${late.gets.length}, lyrics ${late.lyricsGets.length})`, { early, late });
  // A burst of 10 skips in 2 s: only the last track is asked.
  await run('mpfy.player.skipTo(0); return true;');
  await sleep(1600);
  await helper('songs?clear=1');
  const next = await at('.np .transport [aria-label="Successivo"]');
  for (let i = 0; i < 10; i++) {
    await tap(b, next.x, next.y, { hold: 50 });
    await sleep(150);
  }
  const idx = await run('return mpfy.player.state.index;');
  if (idx !== 10) {
    // The taps were one gesture to the page: the skips are made by the player itself, as quickly.
    L.log('     taps moved to index', idx, '- skipping from the player instead');
    await run('mpfy.player.skipTo(0); return true;');
    await sleep(1600);
    await helper('songs?clear=1');
    for (let i = 0; i < 10; i++) {
      await run('mpfy.player.next(); return true;');
      await sleep(180);
    }
  }
  await sleep(1800);
  const s = await songsState();
  const last = list[10];
  const lastIds = new Set(last.versions.map((v) => v.trackId));
  const others = s.gets.filter((g) => !g.tracks.every((t) => lastIds.has(t)));
  check((await run('return mpfy.player.state.index;')) === 10 && others.length === 0 && s.gets.length === new Set(last.versions.map((v) => v.sourceId)).size && s.lyricsGets.length === 1 && s.lyricsGets[0].id === last.versions[0].trackId, `10 skips in 2 s: the comments and lyrics of the last track only (${s.gets.length} comment GETs, ${s.lyricsGets.length} lyrics GETs)`, { gets: s.gets, lyrics: s.lyricsGets });
  // Back to a song asked a moment ago: nothing again.
  await helper('songs?clear=1');
  const known = () => run(`const v = mpfy.store.versions(${JSON.stringify(last.id)}).find((x) => x.t.lyrics); return { known: mpfy.lyrics.known(v), held: !!mpfy.lyrics.held(v), index: mpfy.player.state.index, playing: mpfy.player.playingVersionId(), t: Date.now() };`);
  const k0 = await known();
  await run('mpfy.player.previous(); return true;');
  await sleep(1500);
  const k1 = await known();
  await run('mpfy.player.next(); return true;');
  await sleep(1500);
  const k2 = await known();
  const again = await songsState();
  check(!again.gets.some((g) => g.tracks.some((t) => lastIds.has(t))) && !again.lyricsGets.some((g) => lastIds.has(g.id)), 'a song asked less than 60 s ago is not asked again', { k0, k1, k2, gets: again.gets, lyricsGets: again.lyricsGets });
});

// ---------------------------------------------------------------------------------------------
scenario('comments', async () => {
  await fresh('/');
  const src = await sourceIds();
  const luce = await song('Luce di posizione');
  await play([luce.id], { at: 10 });
  await openPlayer();
  await sleep(800);
  await scrollPlayer('end');
  await sleep(300);
  const cc = await at('.cm-card .card-head');
  await tap(b, cc.x, cc.y);
  await sleep(1000);
  let r = await rows();
  check(r.length === 6 && (await composerShown()), 'the sheet: the six comments of both versions, the composer at its foot', r);
  await b.shot(path.join(outDir, 'songs-sheet.png'));
  // Yours: at the top at once, then on both sources with their own trackIds.
  await helper('songs?postMs=700&clear=1');
  await typeComment('che bella  davvero');
  const send = await at('.cm-sheet .composer-send');
  await tap(b, send.x, send.y);
  await sleep(150);
  r = await rows();
  const shown = await composerShown();
  check(r[0] && r[0].text === 'che bella davvero' && r[0].pending && !shown, 'a new comment shows at the top at once, the composer goes', { r: r.slice(0, 2), shown });
  await sleep(1500);
  let s = await songsState();
  r = await rows();
  const byTrack = s.posts.map((p) => `${p.source}:${p.body.trackId}`).sort().join(',');
  const wantTracks = luce.versions.map((v) => `${v.sourceId}:${v.trackId}`).sort().join(',');
  check(s.posts.length === 2 && byTrack === wantTracks && new Set(s.posts.map((p) => p.body.id)).size === 1 && !r[0].pending && r.length === 7, `posted to each source holding the song, with its trackId there, one id (${byTrack})`, s.posts);
  await helper('songs?postMs=0&clear=1');
  // A long press on yours: "Modifica" and "Elimina".
  const mine = await at('.cm-sheet .cm-row .cm-text');
  await hold(mine);
  await sleep(600);
  let items = await run(`return [...document.querySelectorAll('.layer-sheet:not(.cm-sheet) .menu-item, .layer .sheet:not(.cm-sheet) .menu-item')].map((x) => x.textContent);`);
  check(items.join('|') === 'Modifica|Elimina', 'a long press on yours: "Modifica" and "Elimina"', items);
  const mod = await at('.layer .sheet:not(.cm-sheet) .menu-item', { text: 'Modifica' });
  await tap(b, mod.x, mod.y);
  await sleep(700);
  const field = await run(`return document.querySelector('.cm-sheet .composer-input').value;`);
  check((await composerShown()) && field === 'che bella davvero', '"Modifica": the composer comes back with your text', field);
  await typeComment('anzi, stupenda');
  const send2 = await at('.cm-sheet .composer-send');
  await tap(b, send2.x, send2.y);
  await sleep(1200);
  s = await songsState();
  r = await rows();
  const firstId = (await songsState()).posts.length ? s.posts[0].body.id : null;
  check(s.posts.length === 2 && s.posts.every((p) => p.body.text === 'anzi, stupenda') && r[0].text === 'anzi, stupenda' && r.filter((x) => x.text === 'anzi, stupenda').length === 1 && r.length === 7 && !(await composerShown()), 'sending replaces it: the same id again with the new text, one row', { posts: s.posts, r: r.slice(0, 2), firstId });
  // "Elimina": everywhere it was returned, the composer back.
  await helper('songs?clear=1');
  await hold(await at('.cm-sheet .cm-row .cm-text'));
  await sleep(600);
  const del = await at('.layer .sheet:not(.cm-sheet) .menu-item', { text: 'Elimina' });
  await tap(b, del.x, del.y);
  await sleep(1200);
  s = await songsState();
  r = await rows();
  check(s.deletes.length === 2 && new Set(s.deletes.map((d) => d.source)).size === 2 && r.length === 6 && !r.some((x) => x.text === 'anzi, stupenda') && (await composerShown()), 'yours deleted on every source that returned it, without asking; the composer back', s.deletes);
  // As owner of the Mi A2: "Elimina" on Marco's (from the Mi A2), deleted there only.
  await helper('songs?clear=1');
  await hold(await at('.cm-sheet .cm-row .cm-text', { text: "l'ascolto da una settimana" }));
  await sleep(600);
  items = await run(`return [...document.querySelectorAll('.layer .sheet:not(.cm-sheet) .menu-item')].map((x) => x.textContent);`);
  check(items.join('|') === 'Elimina', "as the owner of the source it came from: only \"Elimina\" on someone else's", items);
  await tap(b, ...Object.values(await at('.layer .sheet:not(.cm-sheet) .menu-item', { text: 'Elimina' })));
  await sleep(1200);
  s = await songsState();
  r = await rows();
  check(s.deletes.length === 1 && s.deletes[0].source === src.mi && !r.some((x) => x.who === 'Marco'), "someone else's comment deleted on your own source only", s.deletes);
  // Luca's comment lives on the VPS (Giulia's): a long press opens nothing.
  const lyr0 = (await layers()).length;
  await hold(await at('.cm-sheet .cm-row .cm-text', { text: "la voce all'inizio" }));
  await sleep(600);
  check((await layers()).length === lyr0, "someone else's comment on a source you do not own: a long press opens nothing", await layers());
  // A post every source refuses: it goes, the words say so, the text is back in the field.
  await helper('songs?failPosts=2&clear=1');
  await typeComment('questa non parte');
  const send3 = await at('.cm-sheet .composer-send');
  await tap(b, send3.x, send3.y);
  await sleep(1400);
  r = await rows();
  const back = await run(`return document.querySelector('.cm-sheet .composer-input').value;`);
  const t = await toasts();
  check(!r.some((x) => x.text === 'questa non parte') && back === 'questa non parte' && t.includes('Qualcosa non ha funzionato') && (await composerShown()), 'refused everywhere: the comment goes, "Qualcosa non ha funzionato", its text back in the field', { r: r.slice(0, 2), back, t });
  await helper('songs?failPosts=0');
  // A tap on a photo opens that person's page (and closes the sheet and the player).
  const photo = await at('.cm-sheet .cm-row .cm-av', { idx: 0 });
  const who = await run(`return document.querySelector('.cm-sheet .cm-row .cm-av').getAttribute('href');`);
  await tap(b, photo.x, photo.y);
  await sleep(1200);
  const p = await pathNow();
  check(!!who && p === who && (await layers()).length === 0 && !(await run(`return document.body.classList.contains('np-open');`)), `a tap on a photo opens that person's page (${p})`, { who, p });
});

// ---------------------------------------------------------------------------------------------
scenario('full', async () => {
  await fresh('/');
  const luce = await song('Luce di posizione');
  await play([luce.id], { at: 20 });
  await openPlayer();
  await scrollPlayer('end');
  await sleep(400);
  const head = await at('.lyr-card .card-head');
  await tap(b, head.x, head.y);
  await sleep(1000);
  check(await ready('.lyrics-full.open', 20), 'a tap on the card (not on a line): the lyrics full screen');
  await b.shot(path.join(outDir, 'songs-full.png'));
  const third = () =>
    run(`const box = document.querySelector('.lf-lines'); const p = box.querySelector('p.now'); if (!p) return null;
      return { off: Math.round(p.getBoundingClientRect().top - box.getBoundingClientRect().top), third: Math.round(box.clientHeight / 3), top: Math.round(box.scrollTop), text: p.textContent };`);
  await run('mpfy.player.seek(101); return true;');
  await sleep(1200);
  const f1 = await third();
  check(f1 && f1.text === 'ogni barca un filo' && Math.abs(f1.off - f1.third) < 40, `following: the current line at about a third of the height (${f1 && f1.off} of ${f1 && f1.third})`, f1);
  // A scroll by hand: the following waits 5 s.
  const box = await at('.lf-lines');
  await drag({ x: box.x, y: box.y, dy: 220 });
  await sleep(300);
  const held = await third();
  await run('mpfy.player.seek(112); return true;');
  await sleep(1500);
  const during = await third();
  check(held && during && Math.abs(during.top - held.top) <= 2 && during.text === 'tienimi nella rotta', `after a scroll by hand the lines stay where the finger left them (${held && held.top} -> ${during && during.top})`, { held, during });
  await sleep(4500);
  const after = await third();
  check(after && Math.abs(after.off - after.third) < 40, `5 s later the following takes over again (${after && after.off} of ${after && after.third})`, after);
  // A tap on a line jumps there.
  await run('window.__seeks = []; return true;');
  const l2 = await at('.lf-lines p', { text: 'ogni faro ha un nome' });
  await tap(b, l2.x, l2.y);
  await sleep(500);
  const sk = await seeks();
  check(sk.length === 1 && Math.abs(sk[0] - 91.5) < 0.01, `a tap on a line jumps to it (${JSON.stringify(sk)})`, sk);
  // Back closes it, the player stays.
  await run('history.back(); return true;');
  await sleep(800);
  const st = await run(`return { full: !!document.querySelector('.lyrics-full'), np: document.body.classList.contains('np-open') };`);
  check(!st.full && st.np, 'Back closes the full screen, the player stays', st);
});

// ---------------------------------------------------------------------------------------------
scenario('menu', async () => {
  await fresh('/');
  const lrcFile = path.join(outDir, 'prova.lrc');
  fs.writeFileSync(lrcFile, '[ar:Nessuno]\n[00:02.00]Riga inventata per la prova\n[00:06.50]una seconda riga inventata\n[00:11.00]e una terza\n');
  try {
    await b.S('Page.setInterceptFileChooserDialog', { enabled: true });
  } catch {
    /* an older engine: the input takes the file anyway */
  }
  const nebbia = await song('Nebbia');
  await play([nebbia.id], { at: 1 });
  await openPlayer();
  const menu = async () => {
    const m = await at('.np-head [aria-label="Altre opzioni per il brano"]');
    await tap(b, m.x, m.y);
    await sleep(700);
    return run(`return [...document.querySelectorAll('.layer-sheet .menu-item')].map((x) => x.textContent);`);
  };
  let items = await menu();
  check(items.includes('Commenti') && items.includes('Aggiungi testo') && !items.includes('Togli testo'), 'the track menu of your song without lyrics: "Commenti" and "Aggiungi testo"', items);
  await helper('songs?clear=1');
  const add = await at('.layer-sheet .menu-item', { text: 'Aggiungi testo' });
  await tap(b, add.x, add.y);
  await sleep(800);
  const doc = await b.S('Runtime.evaluate', { expression: `document.querySelector('input[type=file][accept=".lrc,text/plain"]')` });
  if (doc.result && doc.result.objectId) await b.S('DOM.setFileInputFiles', { files: [lrcFile], objectId: doc.result.objectId });
  await sleep(1800);
  let s = await songsState();
  const c = await card();
  const putIds = s.lyricsPuts.map((x) => x.id).sort().join(',');
  check(putIds === nebbia.versions.map((v) => v.trackId).sort().join(',') && s.lyricsPuts.every((x) => !x.beside && /^text\/plain/.test(x.type)) && !!c.lyr && c.lyr.some((x) => x[1] === 'Riga inventata per la prova'), '"Aggiungi testo" with an .lrc: put on each of your versions of the song, the card follows it', { puts: s.lyricsPuts, c });
  items = await menu();
  check(items.includes('Togli testo') && !items.includes('Aggiungi testo'), 'now the menu offers "Togli testo"', items);
  await helper('songs?clear=1');
  const rm = await at('.layer-sheet .menu-item', { text: 'Togli testo' });
  await tap(b, rm.x, rm.y);
  await sleep(1500);
  s = await songsState();
  check(s.lyricsDeletes.map((x) => x.id).sort().join(',') === putIds && !(await card()).lyr, '"Togli testo": deleted from each of your versions, the card goes', s.lyricsDeletes);
  // "Commenti" from the menu opens the sheet.
  await menu();
  const cm = await at('.layer-sheet .menu-item', { text: 'Commenti' });
  await tap(b, cm.x, cm.y);
  await sleep(900);
  check(await ready('.cm-sheet', 10), '"Commenti" in the track menu opens the sheet');
  await run('history.back(); return true;');
  await sleep(600);
  // Someone else's track (Giulia's, on her VPS): no lyrics items.
  const ancora = await song('Àncora');
  await play([ancora.id], { at: 1 });
  await sleep(600);
  items = await menu();
  check(items.includes('Commenti') && !items.some((x) => x.includes('testo')), "someone else's track: \"Commenti\", no lyrics items", items);
});

// ---------------------------------------------------------------------------------------------
scenario('offline', async () => {
  const fake = `(() => { window.__calls = []; window.MPfyNative = new Proxy({}, { get: (_, name) => (...args) => { window.__calls.push(name); switch (name) { case 'bridgeVersion': return '4'; case 'getState': return JSON.stringify({ playing: false }); case 'getNetwork': return JSON.stringify({ type: 'wifi', metered: false }); case 'listDownloads': return localStorage.getItem('__fakeDownloads') || JSON.stringify({ ids: [], progress: {}, items: [] }); case 'getStorage': return JSON.stringify({}); case 'getUpdate': return JSON.stringify({ state: 'none' }); default: return undefined; } } }); })();`;
  await fresh('/', [], { fake });
  const luce = await song('Luce di posizione');
  const tid = luce.versions.find((v) => v.trackId === luce.id).trackId;
  const keys = () =>
    run(`return await new Promise((res) => { const rq = indexedDB.open('mpfy', 1); rq.onsuccess = () => { const t = rq.result.transaction('kv', 'readonly').objectStore('kv').getAllKeys(); t.onsuccess = () => res(t.result.filter((k) => String(k).startsWith('lyrics:'))); t.onerror = () => res(null); }; rq.onerror = () => res(null); });`);
  const dl = (ids) => run(`const m = { type: 'downloads', ids: ${JSON.stringify(ids)}, progress: {}, items: ${JSON.stringify(ids)}.map((id) => ({ trackId: id, fileHash: id, quality: 'max' })) }; localStorage.setItem('__fakeDownloads', JSON.stringify(m)); window.__mpfyNative(m); return true;`);
  await dl([tid]);
  await sleep(4500);
  const k1 = await keys();
  check(Array.isArray(k1) && k1.includes(`lyrics:${tid}`), `a downloaded track with lyrics: its text kept in IndexedDB (${JSON.stringify(k1)})`, k1);
  // A download whose source is out of reach: its copy waits for that source, and nothing else of
  // the sources (their times change every few seconds) brings the copies in step again meanwhile.
  const src = await sourceIds();
  const far = (await song('Il guardiano del faro')).versions.find((v) => v.sourceId === src.vps).trackId;
  await helper(`offline?source=${src.vps}&on=1`);
  await sleep(4500);
  await dl([tid, far]);
  await sleep(4500);
  const s0 = await run('return mpfy.lyrics.syncs;');
  for (const rtt of [90, 150, 60]) {
    await helper(`source?source=${src.mi}&rtt=${rtt}`);
    await sleep(4500);
  }
  const s1 = await run('return mpfy.lyrics.syncs;');
  const kFar = await keys();
  check(s1 === s0 && Array.isArray(kFar) && !kFar.includes(`lyrics:${far}`), `a copy whose source is out of reach waits: the sources changing meanwhile ask nothing again (${s1 - s0} passes)`, { s0, s1, kFar });
  await helper(`offline?source=${src.vps}&on=0`);
  await sleep(9000);
  const kBack = await keys();
  const s2 = await run('return mpfy.lyrics.syncs;');
  check(Array.isArray(kBack) && kBack.includes(`lyrics:${far}`) && s2 - s1 >= 1, `its source back: the copy is kept (${s2 - s1} passes)`, { s1, s2, kBack });
  // Every source out of reach, the page loaded again: the player reads them from there.
  await run(`mpfy.player.playContext({ type: 'library', id: null }, [${JSON.stringify(luce.id)}], 0); return true;`);
  await sleep(800);
  await helper('offline?on=1');
  await b.go(`${base}/?nosw`, 1500);
  await run(`for (let i = 0; i < 80 && !(window.mpfy && mpfy.store.loaded && mpfy.store.lib.tracks.length); i++) await new Promise((r) => setTimeout(r, 100)); return true;`);
  await sleep(800);
  await helper('songs?clear=1');
  const mini = await ready('.mini-main', 30);
  if (mini) await openPlayer();
  await sleep(1500);
  const c = await card();
  check(mini && !!c.lyr && c.lyr.some((x) => x[1] === 'Lascio il molo al buio'), 'offline: the player shows the lyrics kept with the download', c);
  check(!!c.cm && c.cm.empty === null && c.cm.n === 0, 'offline: the "Commenti" card does not say there are none when no source could be asked', c.cm);
  await helper('offline?on=0');
  // The download goes: so does the copy.
  await dl([]);
  await sleep(4500);
  const k2 = await keys();
  check(Array.isArray(k2) && !k2.includes(`lyrics:${tid}`), `the download removed: its lyrics too (${JSON.stringify(k2)})`, k2);
});

// ---------------------------------------------------------------------------------------------
scenario('fling', async () => {
  await fresh('/');
  const luce = await song('Luce di posizione');
  await play([luce.id], { at: 30 });
  await openPlayer();
  await sleep(600);
  let judged = 0;
  let bad = 0;
  for (let i = 0; i < 6 && judged < 2; i++) {
    await scrollPlayer('end');
    await sleep(500);
    await run('window.__seeks = []; return true;');
    await watchScroll('.np-inner');
    const from = await at('.cm-card', { fy: 0.3 });
    await quickFling({ x: from.x, y: from.y, dy: 140, speed: 4000 });
    await sleep(15);
    const line = await at('.lyr-card .lyr p', { idx: 1 });
    if (!line) continue;
    await tap(b, line.x, line.y, { hold: 60 });
    await sleep(700);
    const glided = await glidedUntilTap();
    const sk = await seeks();
    const ls = await layers();
    const full = await run(`return !!document.querySelector('.lyrics-full');`);
    L.log('     try', i, { glided, sk, ls, full });
    if (!glided) continue;
    judged++;
    if (sk.length || ls.length || full) bad++;
    if (full) {
      await run('history.back(); return true;');
      await sleep(600);
    }
  }
  check(judged >= 1 && bad === 0, `a tap on a lyric line while the player glides: no jump, nothing opens (${judged} judged)`, { judged, bad });
  // The finger may land on the position slider as the player glides by: it moves nothing; at rest it does.
  await run('const i = document.querySelector(".np-inner"); i.scrollTop = 40; return true;');
  await sleep(500);
  const bar = await at('.np-screen .seek');
  await run('window.__seeks = []; const i = document.querySelector(".np-inner"); i.scrollTop = 39; return true;');
  await tap(b, bar.x + 60, bar.y, { hold: 60 });
  await sleep(500);
  const moving = await seeks();
  await sleep(400);
  const bar2 = await at('.np-screen .seek');
  await tap(b, bar2.x + 60, bar2.y, { hold: 60 });
  await sleep(500);
  const still = await seeks();
  check(moving.length === 0 && still.length === 1, `a finger on the slider of a moving player moves nothing; on a still one it seeks (${moving.length}, then ${still.length})`, { moving, still });
  // A double tap on a line: one jump.
  await run('mpfy.player.seek(30); return true;');
  await scrollPlayer('end');
  await sleep(800);
  await run('window.__seeks = []; return true;');
  const ln = await at('.lyr-card .lyr p.next');
  await doubleTap(b, ln.x, ln.y, { gap: 110 });
  await sleep(700);
  const sk2 = await seeks();
  check(sk2.length === 1, `a double tap on a line jumps once (${sk2.length})`, sk2);
});

// ---------------------------------------------------------------------------------------------
scenario('send', async () => {
  await fresh('/');
  const luce = await song('Luce di posizione');
  await play([luce.id], { at: 10 });
  await openPlayer();
  await scrollPlayer('end');
  await sleep(400);
  await run(`document.querySelector('.cm-card').click(); return true;`);
  await sleep(1000);
  await helper('songs?clear=1');
  await typeComment('una volta sola');
  const send = await at('.cm-sheet .composer-send');
  await doubleTap(b, send.x, send.y, { gap: 90 });
  await sleep(1500);
  const s = await songsState();
  const r = await rows();
  check(s.posts.length === 2 && new Set(s.posts.map((p) => p.body.id)).size === 1 && new Set(s.posts.map((p) => p.source)).size === 2 && r.filter((x) => x.text === 'una volta sola').length === 1, `a double tap on "Invia": one comment, posted once to each source (${s.posts.length} posts)`, s.posts);
});

// ---------------------------------------------------------------------------------------------
scenario('sheet', async () => {
  const luceTitle = 'Luce di posizione';
  await fresh('/');
  const luce = await song(luceTitle);
  const src = await sourceIds();
  const mi = luce.versions.find((v) => v.sourceId === src.mi).trackId;
  await helper(`songs?many=${mi}&source=${src.mi}&n=80`);
  await play([luce.id], { at: 10 });
  await openPlayer();
  await scrollPlayer('end');
  await sleep(400);
  await run(`document.querySelector('.cm-card').click(); return true;`);
  await sleep(1200);
  const p0 = await pathNow();
  let judged = 0;
  let bad = 0;
  for (let i = 0; i < 6 && judged < 2; i++) {
    await run(`document.querySelector('.cm-list').scrollTop = 0; return true;`);
    await sleep(400);
    await watchScroll('.cm-list');
    const list = await at('.cm-list', { fy: 0.8 });
    await quickFling({ x: list.x, y: list.y, dy: -300, speed: 6000 });
    await sleep(15);
    const row = await at('.cm-list .cm-row .cm-av', { idx: 4 });
    await tap(b, row ? row.x : list.x, row ? row.y : list.y - 100, { hold: 60 });
    await sleep(800);
    const glided = await glidedUntilTap();
    const ls = await layers();
    const p = await pathNow();
    L.log('     try', i, { glided, ls, p });
    if (!glided) continue;
    judged++;
    if (ls.length !== 1 || p !== p0) bad++;
  }
  check(judged >= 1 && bad === 0, `a tap on a row while the comments glide: no menu, no page (${judged} judged)`, { judged, bad });
  // A long press that lands on the gliding list: nothing.
  judged = 0;
  bad = 0;
  for (let i = 0; i < 6 && judged < 2; i++) {
    await run(`document.querySelector('.cm-list').scrollTop = 0; return true;`);
    await sleep(400);
    await watchScroll('.cm-list');
    const list = await at('.cm-list', { fy: 0.8 });
    await quickFling({ x: list.x, y: list.y, dy: -300, speed: 6000 });
    await sleep(15);
    await hold({ x: list.x, y: list.y - 120 }, 800);
    await sleep(500);
    const glided = await glidedUntilTap();
    const ls = await layers();
    L.log('     press try', i, { glided, ls });
    if (!glided) continue;
    judged++;
    if (ls.length !== 1) {
      bad++;
      await run('history.back(); return true;');
      await sleep(500);
    }
  }
  check(judged >= 1 && bad === 0, `a long press that lands on the gliding comments: nothing opens (${judged} judged)`, { judged, bad });
});

const errors = [];
try {
  for (const s of scenarios) {
    if (only && !only.includes(s.name)) continue;
    L.log(`\n== ${s.name}`);
    b = await startBrowser(`songs-${s.name}`);
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
