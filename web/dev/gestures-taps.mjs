// Taps as people make them on a phone: double and triple taps on what opens a sheet, a dialog, Now
// Playing, the queue or a page; taps while a list glides or while the list under the finger is
// drawn again; back pressed twice; the seek thumb let go by the system; two fingers. A gesture
// belongs to what it opened: the second tap of a double tap does nothing there, while a tap pressed
// 400 ms after the previous press still works.
//
//   node web/dev/gestures-taps.mjs <out dir> [--only name|name]
//
// Prints PASS/FAIL lines and fails=<n> (exit 1 on a failure); the same lines and the details go
// to <out dir>/gestures-taps.log.
import fs from 'node:fs';
import path from 'node:path';
import { startMock, startBrowser, touchFling, tap, doubleTap, sleep, logger } from './gesture-lib.mjs';

const outDir = path.resolve(process.argv[2] || '.');
fs.mkdirSync(outDir, { recursive: true });
const onlyAt = process.argv.indexOf('--only');
const only = onlyAt > 0 ? process.argv[onlyAt + 1].split('|') : null;
const L = logger(path.join(outDir, 'gestures-taps.log'));
let fails = 0;
function check(ok, name, detail) {
  const line = `${ok ? 'PASS' : 'FAIL'} ${name}`;
  console.log(line);
  L.log(line);
  if (detail !== undefined) L.log('     ', detail);
  if (!ok) fails++;
}

const { mock, base } = await startMock();
// Each scenario gets its own browser: a multi-touch sequence sent through DevTools can leave the
// emulated touch screen of that browser without pointer events for the next pages.
let b = null;

// ---- page helpers ----
const touch = (type, points) => b.S('Input.dispatchTouchEvent', { type, touchPoints: points });
const SNAP = `const st = mpfy.player.state; const pl = mpfy.store.lib.playlists.find((p) => p.name === 'Viaggio in macchina');
  return { path: location.pathname, plLen: pl ? pl.trackIds.length : null, liked: mpfy.store.d.likedIds.length, queue: st.items.length, index: st.index,
    track: (mpfy.player.currentTrack() || {}).title || null, playing: st.playing, pos: Math.round(mpfy.player.positionNow() * 10) / 10, shuffle: st.shuffle, repeat: st.repeat, queueId: st.queueId,
    np: document.body.classList.contains('np-open'), sources: mpfy.sources.list.length,
    layers: [...document.querySelectorAll('#layers > .layer:not(.closing)')].map((l) => { const t = l.querySelector('.dialog-title, .sheet-title, .sheet-item-title, .panel-title'); return t ? t.textContent : 'layer'; }) };`;
const snap = () => b.evaluate(SNAP);
/** Center of the idx-th element matching sel (whose text includes text), at fx of its width. */
const at = (sel, { text = null, idx = 0, fx = 0.5 } = {}) =>
  b.evaluate(`const els = [...document.querySelectorAll(${JSON.stringify(sel)})].filter((e) => ${JSON.stringify(text)} == null || e.textContent.includes(${JSON.stringify(text)}));
    const e = els[${idx}]; if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width * ${fx}), y: Math.round(r.top + r.height / 2), w: r.width, h: r.height, top: r.top };`);
const run = (js) => b.evaluate(js);

/** A clean page: storage cleared, the mock's sample data, the library loaded. */
async function fresh(route = '/', q = 'sources=2') {
  // No finger left down by the previous scenario.
  await touch('touchCancel', []).catch(() => {});
  await b.S('Page.navigate', { url: 'about:blank' });
  await sleep(200);
  await b.S('Storage.clearDataForOrigin', { origin: base, storageTypes: 'local_storage,indexeddb,service_workers,cache_storage' });
  await fetch(`${base}/__mock/reset?${q}`);
  await b.go(`${base}${route}${route.includes('?') ? '&' : '?'}nosw`, 600);
  await run(`for (let i = 0; i < 60 && !(window.mpfy && mpfy.store.loaded); i++) await new Promise((r) => setTimeout(r, 100)); return true;`);
  await sleep(400);
}
/** Goes to an app page the way a link does, then waits for nothing to be under way. */
async function goTo(route, wait = 900) {
  await run(`mpfy.navigate(${JSON.stringify(route)}); return true;`);
  await sleep(wait);
}
const playlistId = (name = 'Viaggio in macchina') => run(`return mpfy.store.lib.playlists.find((p) => p.name === ${JSON.stringify(name)}).id;`);
const bigAlbum = () => run(`return [...mpfy.store.d.albums.values()].sort((a, b) => b.trackIds.length - a.trackIds.length)[0].id;`);
/** Plays a playlist (or the biggest album) from idx and waits until the song is past 2 s. */
async function playing({ playlist = null, idx = 2 } = {}) {
  await run(`const pl = ${JSON.stringify(playlist)} && mpfy.store.lib.playlists.find((p) => p.name === ${JSON.stringify(playlist)});
    if (pl) mpfy.player.playContext({ type: 'playlist', id: pl.id, name: pl.name }, pl.trackIds, ${idx});
    else { const al = [...mpfy.store.d.albums.values()].sort((a, b) => b.trackIds.length - a.trackIds.length)[0]; mpfy.player.playContext({ type: 'album', id: al.id, name: al.name }, al.trackIds, ${idx}); }
    for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 100)); if (mpfy.player.state.playing && mpfy.player.positionNow() > 2) break; }
    return true;`);
}
async function openNowPlaying() {
  await run(`document.querySelector('.mini-main').click(); return true;`);
  await sleep(800);
}
async function openQueuePanel() {
  await openNowPlaying();
  await run(`document.querySelector('.np-queue').click(); return true;`);
  await sleep(800);
}
const toasts = () => run(`return [...document.querySelectorAll('.toast')].map((t) => t.textContent);`);
const same = (a, b2, keys) => keys.every((k) => JSON.stringify(a[k]) === JSON.stringify(b2[k]));
/**
 * A tap on p1, then a tap on p2 pressed `apart` ms after the first press (not less), each held
 * `hold` ms. p2 can be a function, asked once the first tap is done. The presses are timed here,
 * as the browser stamps them, so a page busy after the first tap does not move the second.
 * Returns the press-to-press time by the events' time stamps, the clock the page judges by.
 */
async function tapsApart(p1, p2, { apart = 400, hold = 80 } = {}) {
  await run(`window.__downs = []; if (!window.__downsOn) { window.__downsOn = true; window.addEventListener('pointerdown', (e) => window.__downs.push(e.timeStamp), true); } return true;`);
  const t0 = performance.now();
  await tap(b, p1.x, p1.y, { hold });
  const to = typeof p2 === 'function' ? await p2() : p2;
  const due = t0 + apart + 2;
  if (due - performance.now() > 25) await sleep(due - performance.now() - 25);
  while (performance.now() < due); // the last few ms by the clock: the system timer is coarse
  await tap(b, to.x, to.y, { hold });
  return run('return Math.round(window.__downs[1] - window.__downs[0]);');
}

const scenarios = [];
const scenario = (name, fn) => scenarios.push({ name, fn });

// ---------------------------------------------------------------------------------------------
// Sheets: the second (and third) tap of the tap that opened the track menu runs nothing.
scenario('track-menu', async () => {
  for (const want of [222, 326, 378, 586]) {
    for (const gap of [120, 200]) {
      await fresh('/');
      await goTo(`/playlist/${await playlistId()}`);
      const pos = await run(`const m = document.getElementById('main'); const btn = document.querySelectorAll('.track-row .tr-more')[5]; const r = btn.getBoundingClientRect(); m.scrollTop += (r.top + r.height / 2) - ${want};
        await new Promise((r2) => setTimeout(r2, 400)); const q = btn.getBoundingClientRect(); return { x: Math.round(q.left + q.width / 2), y: Math.round(q.top + q.height / 2) };`);
      await sleep(400);
      const before = await snap();
      await doubleTap(b, pos.x, pos.y, { gap });
      await sleep(1000);
      const after = await snap();
      check(same(before, after, ['path', 'plLen', 'liked', 'queue', 'index']) && after.layers.length === 1, `double tap on the "..." of a song at y ${pos.y} (gap ${gap}): only its menu opens, no item runs`, { before, after, toasts: await toasts() });
    }
  }
  // Triple tap, on the row low on the screen where the menu brings "Rimuovi da questa playlist".
  await fresh('/');
  await goTo(`/playlist/${await playlistId()}`);
  const pos = await run(`const m = document.getElementById('main'); const btn = document.querySelectorAll('.track-row .tr-more')[5]; const r = btn.getBoundingClientRect(); m.scrollTop += (r.top + r.height / 2) - 586;
    await new Promise((r2) => setTimeout(r2, 400)); const q = btn.getBoundingClientRect(); return { x: Math.round(q.left + q.width / 2), y: Math.round(q.top + q.height / 2) };`);
  await sleep(400);
  const before = await snap();
  await doubleTap(b, pos.x, pos.y, { gap: 120, count: 3 });
  await sleep(1000);
  const after = await snap();
  check(same(before, after, ['path', 'plLen', 'liked', 'queue']) && after.layers.length === 1, 'triple tap on the "..." of a song: the menu stays open, the song stays in the playlist', { before, after });
  // A deliberate tap 400 ms later on one of its items does run it.
  const item = await at('#layers .layer:not(.closing) .menu-item', { text: 'Aggiungi in coda' });
  await tap(b, item.x, item.y);
  await sleep(800);
  const done = await snap();
  check(done.queue === before.queue + 1 && done.layers.length === 0, 'a later tap on "Aggiungi in coda" in that menu still adds the song', { done });
  // The menu opened by a tap, its item pressed 400 ms after the press that opened it, with a
  // normal and a longer hold: that tap counts.
  for (const hold of [80, 120]) {
    await fresh('/');
    await goTo(`/playlist/${await playlistId()}`);
    const more = await at('.track-row .tr-more', { idx: 2 });
    // Where the item comes to rest, measured on the same menu opened and closed before.
    await run(`document.querySelectorAll('.track-row .tr-more')[2].click(); return true;`);
    await sleep(800);
    const it2 = await at('#layers .layer:not(.closing) .menu-item', { text: 'Aggiungi in coda' });
    await run('history.back(); return true;');
    await sleep(900);
    const q0 = (await snap()).queue;
    const p2p = await tapsApart(more, it2, { apart: 400, hold });
    await sleep(800);
    const s = await snap();
    check(s.queue === q0 + 1 && !s.layers.length, `a menu item pressed 400 ms after the press that opened the menu (hold ${hold}) works`, { p2p, q0, s });
  }
});

// A double tap on an item that closes its sheet: the second tap does nothing on the page that the
// closing sheet uncovers.
scenario('sheet-close', async () => {
  // A double tap with a 240 ms gap, and a slow one, presses 360 ms apart with short holds, so the
  // second press comes after the closed sheet stopped catching taps.
  for (const gap of [240, 360]) {
    await fresh('/');
    await goTo(`/playlist/${await playlistId()}`);
    // The song list fills the screen under the menu, so the second tap has a song to land on.
    await run(`document.getElementById('main').scrollTop = 520; await new Promise((r) => setTimeout(r, 300)); document.querySelectorAll('.track-row .tr-more')[6].click(); return true;`);
    await sleep(800);
    const item = await at('#layers .layer:not(.closing) .menu-item', { text: 'Aggiungi in coda' });
    // What the page has under that item (the page is inert while the menu is up: not for this look).
    const under = await run(`const l = document.querySelector('#layers'); const app = document.getElementById('app'); const was = app.inert; app.inert = false; l.style.visibility = 'hidden';
      const e = document.elementFromPoint(${item.x}, ${item.y}); l.style.visibility = ''; app.inert = was; const c = e && e.closest('button, a'); return c ? (c.getAttribute('aria-label') || c.textContent.trim()) : null;`);
    const before = await snap();
    let p2p = null;
    if (gap < 300) await doubleTap(b, item.x, item.y, { gap });
    else p2p = await tapsApart(item, item, { apart: gap, hold: 40 });
    await sleep(1000);
    const after = await snap();
    const how = gap < 300 ? `gap ${gap}` : `presses ${gap} ms apart`;
    check(/^(Riproduci|Altre opzioni)/.test(under || '') && after.queue === before.queue + 1 && !after.playing && after.path === before.path && after.layers.length === 0, `double tap on "Aggiungi in coda" (${how}): added once, the second tap does nothing on the page below (${under})`, { p2p, before, after });
  }
});

// Dialogs: a double or triple tap on a row that opens a question does not answer it.
scenario('confirm-dialog', async () => {
  const miPage = async () => {
    await fresh('/');
    const id = await run(`return mpfy.sources.list.find((s) => s.name === 'Mi A2').id;`);
    await goTo(`/impostazioni/fonte/${encodeURIComponent(id)}`);
  };
  for (const [gap, count] of [[120, 2], [200, 2], [120, 3]]) {
    await miPage();
    const r = await at('button.set-row', { text: 'Rimuovi fonte', fx: 0.6 });
    await doubleTap(b, r.x, r.y, { gap, count });
    await sleep(1200);
    const s = await snap();
    check(s.sources === 2 && s.layers.length === 1 && /Rimuovere/.test(s.layers[0]), `${count === 3 ? 'triple' : 'double'} tap on "Rimuovi fonte" (gap ${gap}): the question stays open, the source stays`, s);
  }
  // At 360x640 "Cambia codice" sits under the dialog's own button.
  await b.S('Emulation.setDeviceMetricsOverride', { width: 360, height: 640, deviceScaleFactor: 3, mobile: true });
  await miPage();
  await run(`window.__rot = 0; const f = window.fetch; window.fetch = (u, o) => { if (String(u).includes('/rotate')) window.__rot++; return f(u, o); }; return true;`);
  const r = await at('button.set-row', { text: 'Cambia codice', fx: 0.6 });
  await doubleTap(b, r.x, r.y, { gap: 160 });
  await sleep(1200);
  const s = await snap();
  const rot = await run('return window.__rot;');
  check(rot === 0 && s.layers.length === 1 && /Cambiare/.test(s.layers[0]), 'double tap on "Cambia codice" at 360x640: the question stays open, the code does not change', { s, rot, toasts: await toasts() });
  await b.phone();
  // A deliberate tap on "Annulla" pressed 400 ms after the press that opened the question works.
  for (const hold of [80, 120]) {
    await miPage();
    const row = await at('button.set-row', { text: 'Rimuovi fonte', fx: 0.6 });
    // Where "Annulla" comes to rest, measured on the same question opened and closed before.
    await run(`[...document.querySelectorAll('button.set-row')].find((e) => e.textContent.includes('Rimuovi fonte')).click(); return true;`);
    await sleep(700);
    const cancel = await at('.layer-dialog:not(.closing) .btn', { text: 'Annulla' });
    await run('history.back(); return true;');
    await sleep(900);
    const p2p = await tapsApart(row, cancel, { apart: 400, hold });
    await sleep(700);
    const s2 = await snap();
    check(s2.layers.length === 0 && s2.sources === 2, `"Annulla" pressed 400 ms after the press that opened the question (hold ${hold}) closes it`, { p2p, s2 });
  }
});

// "Aggiungi alla playlist" with many playlists: the pick rows come to rest under the finger.
scenario('add-to-playlist', async () => {
  for (const gap of [100, 180, 260]) {
    await fresh('/');
    await run(`for (let i = 0; i < 8; i++) await mpfy.store.createPlaylist('Extra ' + (i + 1)); return true;`);
    await sleep(600);
    await goTo(`/album/${await bigAlbum()}`);
    await run(`document.querySelectorAll('.track-row .tr-more')[0].click(); return true;`);
    await sleep(800);
    const item = await at('#layers .layer:not(.closing) .menu-item', { text: 'Aggiungi alla playlist' });
    const lens = `return mpfy.store.lib.playlists.map((p) => p.name + ':' + p.trackIds.length).join(' ');`;
    const before = await run(lens);
    await doubleTap(b, item.x, item.y, { gap });
    await sleep(1400);
    const after = await run(lens);
    const s = await snap();
    check(before === after && s.layers.length === 1 && s.layers[0] === 'Aggiungi alla playlist', `double tap on "Aggiungi alla playlist" (gap ${gap}, 12 playlists): the list opens, no playlist gets the song`, { before, after, s });
  }
});

// "Aggiungi a questa playlist": the panel's "+" buttons slide under the finger.
scenario('add-tracks', async () => {
  for (const gap of [100, 200]) {
    await fresh('/');
    await goTo(`/playlist/${await playlistId()}`);
    const r = await run(`const e = document.querySelector('.add-row-btn'); e.scrollIntoView({ block: 'center' }); await new Promise((r2) => setTimeout(r2, 300)); const q = e.getBoundingClientRect(); return { x: 318, y: Math.round(q.top + q.height / 2) };`);
    await sleep(300);
    const before = await snap();
    await doubleTap(b, r.x, r.y, { gap });
    await sleep(1200);
    const after = await snap();
    check(after.plLen === before.plLen && after.layers.length === 1, `double tap on "Aggiungi a questa playlist" (gap ${gap}): the panel opens, no song is added`, { before, after });
  }
});

// Now Playing opened with a double tap on the mini player: its controls do not take the second tap.
scenario('now-playing', async () => {
  for (const [label, sel, fx, gap] of [
    ['cover', '.mini-cover', 0.5, 100],
    ['cover', '.mini-cover', 0.5, 280],
    ['title', '.mini-text', 0.3, 60],
    ['title', '.mini-text', 0.3, 200],
    ['title', '.mini-text', 0.8, 280],
  ]) {
    await fresh('/');
    await playing();
    const r = await at(sel, { fx });
    const before = await snap();
    const t0 = Date.now();
    await doubleTap(b, r.x, r.y, { gap });
    await sleep(1000);
    const after = await snap();
    const elapsed = (Date.now() - t0) / 1000;
    const posOk = after.pos >= before.pos - 0.3 && after.pos <= before.pos + elapsed + 1.5;
    check(after.np && same(before, after, ['shuffle', 'repeat', 'index', 'playing', 'queueId']) && posOk, `double tap on the mini player ${label} at x ${r.x} (gap ${gap}): Now Playing opens, nothing in it is pressed`, { before, after, elapsed });
  }
  // The seek bar tapped as the second tap of the gesture that opened Now Playing does not seek.
  await fresh('/');
  await playing();
  const m = await at('.mini-text');
  await tap(b, m.x, m.y);
  await sleep(200);
  const seek = await at('.np .seek', { fx: 0.8 });
  const before = await snap();
  await tap(b, seek.x, seek.y);
  await sleep(800);
  const after = await snap();
  check(after.pos < before.pos + 2.5, 'a tap on the seek bar 200 ms after the tap that opened Now Playing does not seek', { before, after });
  // The same tap after a pause seeks.
  await sleep(500);
  await tap(b, seek.x, seek.y);
  await sleep(800);
  const later = await snap();
  check(later.pos > after.pos + 20, 'a tap on the seek bar after a pause seeks there', { after, later });
  // And a later tap on shuffle works.
  const sh = await at('.np .transport .toggle');
  await tap(b, sh.x, sh.y);
  await sleep(600);
  check((await snap()).shuffle !== later.shuffle, 'a tap on shuffle after a pause works', await snap());
  // The queue button double tapped: the queue opens, its footer is not pressed.
  await fresh('/');
  await playing();
  await openNowPlaying();
  const qb = await at('.np-queue');
  const b2 = await snap();
  await doubleTap(b, qb.x, qb.y, { gap: 200 });
  await sleep(1000);
  const a2 = await snap();
  check(a2.layers.includes('Coda') && same(b2, a2, ['repeat', 'shuffle', 'index', 'playing']), 'double tap on "Coda": the queue opens, its controls are not pressed', { b2, a2 });
});

// Back arrows: a double tap goes back one page.
scenario('back', async () => {
  for (const gap of [100, 200]) {
    await fresh('/');
    const alId = await run(`return [...mpfy.store.d.albums.values()].find((a) => mpfy.store.d.artists.has(a.artistId)).id;`);
    await goTo(`/album/${alId}`);
    await run(`document.querySelector('.hero-meta a.meta-owner').click(); return true;`);
    await sleep(900);
    const r = await at('.back-btn');
    await doubleTap(b, r.x, r.y, { gap });
    await sleep(1000);
    const p = (await snap()).path;
    check(p === `/album/${alId}`, `double tap on the back arrow of an artist reached from an album (gap ${gap}): back on the album`, p);
    if (gap === 200) {
      await sleep(300);
      const r2 = await at('.back-btn');
      await tap(b, r2.x, r2.y);
      await sleep(900);
      check((await snap()).path === '/', 'a tap on the back arrow after a pause goes back again', (await snap()).path);
    }
  }
  // Back clicked twice before the first step landed (keyboard, script): one step.
  await fresh('/');
  const alId = await run(`return [...mpfy.store.d.albums.values()].find((a) => mpfy.store.d.artists.has(a.artistId)).id;`);
  await goTo(`/album/${alId}`);
  await run(`document.querySelector('.hero-meta a.meta-owner').click(); return true;`);
  await sleep(900);
  await run(`const bb = document.querySelector('.back-btn'); bb.click(); bb.click(); return true;`);
  await sleep(1000);
  check((await snap()).path === `/album/${alId}`, 'the back arrow pressed twice before the step back landed: one step', (await snap()).path);
  // Now Playing's chevron double tapped over an album page: Now Playing closes, the page stays.
  for (const gap of [100, 200]) {
    await fresh('/');
    const id = await bigAlbum();
    await goTo(`/album/${id}`);
    await playing();
    await openNowPlaying();
    const c = await at('.np-head .icon-btn');
    await doubleTap(b, c.x, c.y, { gap });
    await sleep(1000);
    const s = await snap();
    check(!s.np && s.path === `/album/${id}`, `double tap on the Now Playing chevron over an album (gap ${gap}): Now Playing closes, the album stays`, s);
  }
  // "Annulla" in playlist edit mode double tapped: the edit ends, the playlist stays.
  for (const gap of [100, 200]) {
    await fresh('/');
    const id = await playlistId();
    await goTo(`/playlist/${id}`);
    await run(`const m = [...document.querySelectorAll('button')].find((e) => /^Altre opzioni per Viaggio/.test(e.getAttribute('aria-label') || '')); m.click(); await new Promise((r) => setTimeout(r, 700));
      [...document.querySelectorAll('#layers .menu-item')].find((e) => e.textContent.includes('Modifica playlist')).click(); return true;`);
    await sleep(900);
    const r = await at('.topbar-edit .link-btn', { text: 'Annulla' });
    await doubleTap(b, r.x, r.y, { gap });
    await sleep(1000);
    const s = await snap();
    const editing = await run(`return !!document.querySelector('.topbar-edit');`);
    check(s.path === `/playlist/${id}` && !editing, `double tap on "Annulla" in Modifica playlist (gap ${gap}): the edit ends, the playlist stays`, { s, editing });
  }
});

// Two controls tapped one right after the other (two thumbs): shuffle, then the back arrow. Both
// act: only a second tap on the same spot is the rest of a double tap.
scenario('back-after-other', async () => {
  for (const apart of [300, 360]) {
    await fresh('/');
    const alId = await run(`return [...mpfy.store.d.albums.values()].find((a) => mpfy.store.d.artists.has(a.artistId)).id;`);
    await goTo(`/album/${alId}`);
    await run(`document.querySelector('.hero-meta a.meta-owner').click(); return true;`);
    await sleep(900);
    const sh = await at('.shuffle-toggle');
    const bb = await at('.back-btn');
    const sh0 = (await snap()).shuffle;
    const p2p = await tapsApart(sh, bb, { apart, hold: 70 });
    await sleep(1000);
    const s = await snap();
    check(s.shuffle !== sh0 && s.path === `/album/${alId}`, `shuffle, then the back arrow pressed ${apart} ms later: both act`, { p2p, shuffle: [sh0, s.shuffle], path: s.path });
  }
});

// A card or row that opens a page: the second tap does nothing on the new page.
scenario('new-page', async () => {
  for (const gap of [100, 200]) {
    await fresh('/');
    const r = await run(`const s = [...document.querySelectorAll('.shelf')].find((x) => x.querySelector('h2').textContent === 'Album'); const c = s.querySelectorAll('.card-link')[1]; c.scrollIntoView({ block: 'center', inline: 'center' });
      await new Promise((r2) => setTimeout(r2, 400)); const q = c.getBoundingClientRect(); return { x: Math.round(q.left + q.width / 2), y: Math.round(q.top + q.height * 0.3) };`);
    await sleep(300);
    await doubleTap(b, r.x, r.y, { gap });
    await sleep(1000);
    const s = await snap();
    check(/^\/album\//.test(s.path) && s.index === -1 && !s.shuffle, `double tap on an album card on Home (gap ${gap}): the album opens, nothing plays`, s);
  }
  for (const gap of [100, 200]) {
    await fresh('/');
    const r = await run(`const s = [...document.querySelectorAll('.shelf')].find((x) => x.querySelector('h2').textContent === 'Le tue playlist'); const c = [...s.querySelectorAll('.card')].find((x) => x.textContent.includes('Viaggio')) || s.querySelector('.card'); c.scrollIntoView({ block: 'center', inline: 'center' });
      await new Promise((r2) => setTimeout(r2, 400)); const q = c.querySelector('.card-link').getBoundingClientRect(); return { x: Math.round(q.left + q.width / 2), y: Math.round(q.top + q.height * 0.4) };`);
    await sleep(300);
    await doubleTap(b, r.x, r.y, { gap });
    await sleep(1000);
    const s = await snap();
    check(/^\/playlist\//.test(s.path) && s.index === -1 && !s.shuffle, `double tap on a playlist card on Home (gap ${gap}): the playlist opens, nothing is pressed on it`, s);
  }
  for (const gap of [100, 200]) {
    await fresh('/impostazioni');
    const r = await at('a.set-row', { text: 'VPS prova', fx: 0.6 });
    await doubleTap(b, r.x, r.y, { gap });
    await sleep(1000);
    const s = await snap();
    check(/^\/impostazioni\/fonte\//.test(s.path) && s.layers.length === 0, `double tap on the "VPS prova" row (gap ${gap}): its page opens, no dialog`, s);
  }
  for (const y of [540, 620]) {
    await fresh('/library');
    const r = await run(`const rows = [...document.querySelectorAll('.lib-row')]; const e = rows.find((x) => { const q = x.getBoundingClientRect(); return q.top <= ${y} && q.bottom >= ${y}; }); if (!e) return null; const q = e.getBoundingClientRect(); return { x: Math.round(q.left + q.width / 2), y: ${y}, text: e.textContent.trim().slice(0, 30) };`);
    if (!r) {
      check(false, `a library row at y ${y}`, 'no row there');
      continue;
    }
    await doubleTap(b, r.x, r.y, { gap: 150 });
    await sleep(1000);
    const s = await snap();
    check(s.path !== '/library' && s.index === -1, `double tap on the library row "${r.text}" at y ${y}: its page opens, nothing plays`, s);
  }
  // A song pressed 400 ms after the press that opened its album plays.
  for (const hold of [80, 120]) {
    await fresh('/');
    const card = `const s = [...document.querySelectorAll('.shelf')].find((x) => x.querySelector('h2').textContent === 'Album'); const c = s.querySelectorAll('.card-link')[1];`;
    // Where the song sits on that album page, measured on a visit made before.
    await run(`${card} mpfy.navigate(c.getAttribute('href')); return true;`);
    await sleep(900);
    const row = await at('.track-row .tr-main', { idx: 1, fx: 0.4 });
    await run('history.back(); return true;');
    await sleep(900);
    const r = await run(`${card} c.scrollIntoView({ block: 'center', inline: 'center' });
      await new Promise((r2) => setTimeout(r2, 400)); const q = c.getBoundingClientRect(); return { x: Math.round(q.left + q.width / 2), y: Math.round(q.top + q.height * 0.3) };`);
    await sleep(300);
    const p2p = await tapsApart(r, row, { apart: 400, hold });
    await sleep(900);
    const s = await snap();
    check(/^\/album\//.test(s.path) && s.index >= 0, `a song pressed 400 ms after the press that opened its album (hold ${hold}) plays`, { p2p, s });
  }
});

// Queue: a double tap on a song or on its X acts on that song only.
scenario('queue', async () => {
  for (const gap of [100, 200]) {
    await fresh('/');
    await playing({ playlist: 'Viaggio in macchina', idx: 0 });
    await openQueuePanel();
    const want = await run(`return document.querySelectorAll('.panel-queue .queue-row')[4].querySelector('.tr-title-text').textContent;`);
    const r = await at('.panel-queue .queue-row .tr-main', { idx: 4, fx: 0.3 });
    await doubleTap(b, r.x, r.y, { gap });
    await sleep(1000);
    const s = await snap();
    check(s.track === want, `double tap on the 4th song in "Coda" (gap ${gap}): that song plays`, { want, s });
  }
  for (const gap of [100, 200]) {
    await fresh('/');
    await playing({ playlist: 'Viaggio in macchina', idx: 0 });
    await openQueuePanel();
    const before = await snap();
    const r = await at('.panel-queue .q-remove', { idx: 2 });
    await doubleTap(b, r.x, r.y, { gap });
    await sleep(1000);
    const s = await snap();
    check(s.queue === before.queue - 1, `double tap on the X of a song in "Coda" (gap ${gap}): one song leaves the queue`, { before: before.queue, after: s.queue });
  }
  // Two taps on two songs, the second pressed 400 ms after the first: both count.
  for (const hold of [80, 120]) {
    await fresh('/');
    await playing({ playlist: 'Viaggio in macchina', idx: 0 });
    await openQueuePanel();
    const r1 = await at('.panel-queue .queue-row .tr-main', { idx: 3, fx: 0.3 });
    let want = null;
    const p2p = await tapsApart(
      r1,
      async () => {
        await sleep(60);
        want = await run(`return document.querySelectorAll('.panel-queue .queue-row')[2].querySelector('.tr-title-text').textContent;`);
        return at('.panel-queue .queue-row .tr-main', { idx: 2, fx: 0.3 });
      },
      { apart: 400, hold }
    );
    await sleep(900);
    const s = await snap();
    check(s.track === want, `another song in "Coda" pressed 400 ms after the first (hold ${hold}) plays`, { p2p, want, s });
  }
});

// The list under a still finger drawn again in another order: the tap plays nothing; drawn again
// the same way, it plays the song under it.
scenario('redrawn', async () => {
  for (const [order, label] of [['reverse', 'in another order'], ['same', 'the same way']]) {
    await fresh('/library');
    await run(`const { trackRow } = await import('/components/track-row.js');
      const tracks = mpfy.store.lib.tracks.slice(0, 10); window.__played = [];
      const list = document.createElement('div'); list.className = 'track-list';
      const draw = (ts) => list.replaceChildren(...ts.map((t) => trackRow(t, { onPlay: () => window.__played.push(t.title) })));
      window.__redraw = () => draw(${JSON.stringify(order)} === 'reverse' ? tracks.slice().reverse() : tracks);
      draw(tracks); document.querySelector('#main > .view').replaceChildren(list); document.getElementById('main').scrollTop = 0; return true;`);
    await sleep(600);
    const r = await at('.track-list .track-row .tr-main', { idx: 3, fx: 0.4 });
    const title = await run(`return document.querySelectorAll('.track-list .tr-title-text')[3].textContent;`);
    await touch('touchStart', [{ x: r.x, y: r.y, id: 1 }]);
    await sleep(40);
    await run(`window.__redraw(); return true;`);
    await sleep(40);
    await touch('touchEnd', []);
    await sleep(500);
    const played = await run('return window.__played;');
    if (order === 'reverse') check(played.length === 0, `a song list drawn again ${label} during a tap: nothing plays`, played);
    else check(played.length === 1 && played[0] === title, `a song list drawn again ${label} during a tap: the song under the finger plays`, { played, title });
  }
  // The real queue: a song removed above the pressed one during the press.
  await fresh('/');
  await playing({ playlist: 'Viaggio in macchina', idx: 0 });
  await openQueuePanel();
  const before = await snap();
  const r = await at('.panel-queue .queue-row .tr-main', { idx: 3, fx: 0.3 });
  await touch('touchStart', [{ x: r.x, y: r.y, id: 1 }]);
  await sleep(40);
  await run(`mpfy.player.removeAt([mpfy.player.state.index + 1]); return true;`);
  await sleep(40);
  await touch('touchEnd', []);
  await sleep(800);
  const s = await snap();
  check(s.index === before.index && s.track === before.track, 'a song leaves "Coda" above a row under a still finger: the tap plays nothing', { before, s });
});

// The queue reordered with a handle: a second finger does not end the drag, and a change of the
// queue during the drag still moves the dragged song.
async function queueDrag(variant) {
  const order = () => run(`const st = mpfy.player.state; return st.items.slice(st.index + 1, st.index + 8).map((it) => mpfy.store.d.tracks.get(it.id).title);`);
  const grab = () =>
    run(`const lists = document.querySelectorAll('.panel-queue .q-list'); const list = lists[lists.length - 1]; const rows = list.querySelectorAll('.queue-row');
      const hd = rows[1].querySelector('.drag-handle').getBoundingClientRect(); const title = [...document.querySelectorAll('.panel-queue .q-title')].pop().getBoundingClientRect();
      return { x: Math.round(hd.left + hd.width / 2), y: Math.round(hd.top + hd.height / 2), tx: Math.round(title.left + 20), ty: Math.round(title.top + title.height / 2), step: Math.round(rows[2].getBoundingClientRect().top - rows[1].getBoundingClientRect().top) };`);
  {
    await fresh('/');
    await playing({ playlist: 'Viaggio in macchina', idx: 0 });
    await openQueuePanel();
    const g = await grab();
    const before = await order();
    const p1 = (dy) => ({ x: g.x, y: g.y + dy, id: 1 });
    const far = g.step * 2.2;
    await touch('touchStart', [p1(0)]);
    for (let i = 1; i <= 10; i++) {
      await touch('touchMove', [p1((i * far) / 10)]);
      await sleep(30);
    }
    if (variant === 'second finger') {
      // The second finger touches the section title and lifts (CDP ends the points it is given).
      await touch('touchStart', [p1(far), { x: g.tx, y: g.ty, id: 2 }]);
      await sleep(80);
      await touch('touchEnd', [{ x: g.tx, y: g.ty, id: 2 }]);
      await sleep(150);
    } else {
      await run(`mpfy.player.removeAt([mpfy.player.state.index + 1]); return true;`);
      await sleep(150);
    }
    const mid = await run(`return !!document.querySelector('.panel-queue .queue-row.dragging');`);
    for (let i = 1; i <= 4; i++) {
      await touch('touchMove', [p1(far + i * 2)]);
      await sleep(30);
    }
    await touch('touchEnd', []);
    await sleep(700);
    const after = await order();
    // The dragged song (before[1]) is dropped on the row two below it (before[3]): it ends right after it.
    const moved = after.indexOf(before[1]) === after.indexOf(before[3]) + 1;
    if (variant === 'second finger') check(mid && moved, 'a second finger on "Coda" during a drag: the row stays under the first finger and is dropped where it was let go', { mid, before, after });
    else check(moved, 'the queue changes during a drag: the dragged song is the one that moves, next to the song it was dropped on', { before, after });
  }
}
scenario('queue-drag', () => queueDrag('second finger'));
scenario('queue-drag-change', () => queueDrag('queue change'));

// The seek thumb taken by the system (touchcancel), or let go outside the bar: the bar and the time
// follow the song again, nothing seeks.
scenario('seek', async () => {
  await fresh('/');
  await playing();
  await openNowPlaying();
  await sleep(500);
  const read = () => run(`const r = document.querySelector('.np .seek'); const d = mpfy.player.durationNow(); const p = mpfy.player.positionNow(); return { value: Number(r.value), want: Math.round((p / d) * 1000), t1: document.querySelector('.np .seek-times .time').textContent, pos: Math.round(p), playing: mpfy.player.state.playing };`);
  const g = await run(`const r = document.querySelector('.np .seek').getBoundingClientRect(); return { x0: Math.round(r.left + r.width * 0.2), x1: Math.round(r.left + r.width * 0.6), y: Math.round(r.top + r.height / 2) };`);
  const p0 = (await read()).pos;
  await touch('touchStart', [{ x: g.x0, y: g.y, id: 1 }]);
  for (let i = 1; i <= 6; i++) {
    await touch('touchMove', [{ x: g.x0 + ((g.x1 - g.x0) * i) / 6, y: g.y, id: 1 }]);
    await sleep(30);
  }
  await touch('touchCancel', []);
  await sleep(1500);
  const a = await read();
  // The thumb was dragged from 20% to 60%: no seek means the song is still before 15%.
  check(a.playing && Math.abs(a.value - a.want) <= 15 && a.want < 150, 'the seek thumb dragged and the touch cancelled by the system: the bar shows the song again, no seek', { p0, a });
  // Closed and opened again: still following.
  await run(`document.querySelector('.np-head .icon-btn').click(); return true;`);
  await sleep(700);
  await openNowPlaying();
  await sleep(1300);
  const c = await read();
  check(Math.abs(c.value - c.want) <= 15, 'Now Playing opened again after that: the bar follows the song', c);
  // Pressed with the mouse, moved off the bar and back, let go outside it: the bar follows the song.
  const m = await run(`const r = document.querySelector('.np .seek'); const d = mpfy.player.durationNow(); const x = r.getBoundingClientRect(); return { x: Math.round(x.left + (x.width * mpfy.player.positionNow()) / d), y: Math.round(x.top + x.height / 2) };`);
  await b.S('Input.dispatchMouseEvent', { type: 'mousePressed', x: m.x, y: m.y, button: 'left', clickCount: 1 });
  await b.S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: m.x + 60, y: m.y, button: 'left', buttons: 1 });
  await sleep(60);
  await b.S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: m.x, y: m.y + 120, button: 'left', buttons: 1 });
  await sleep(60);
  await b.S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: m.x, y: m.y + 120, button: 'left', clickCount: 1 });
  await sleep(1500);
  const d = await read();
  check(Math.abs(d.value - d.want) <= 15, 'the seek thumb let go outside the bar: the bar follows the song', d);
});

// Play buttons: a double tap starts, it does not start and stop; a tap after a pause pauses.
scenario('play', async () => {
  for (const gap of [100, 200]) {
    await fresh('/');
    await goTo(`/album/${await bigAlbum()}`);
    const r = await at('.play-big');
    await doubleTap(b, r.x, r.y, { gap });
    await sleep(1500);
    const s = await snap();
    check(s.playing && s.index >= 0, `double tap on the big play button of an album (gap ${gap}): it plays`, s);
  }
  // A second tap pressed 400 ms after the first is a tap of its own and pauses; a slow double tap
  // (presses 360 ms apart: a 300 ms gap) still only plays.
  for (const [apart, hold] of [[400, 80], [400, 120], [360, 60]]) {
    await fresh('/');
    await goTo(`/album/${await bigAlbum()}`);
    const r = await at('.play-big');
    const p2p = await tapsApart(r, r, { apart, hold });
    await sleep(1500);
    const s = await snap();
    if (apart >= 400) check(!s.playing && s.index >= 0, `two taps on the big play button pressed ${apart} ms apart (hold ${hold}): the second one pauses`, { p2p, s });
    else check(s.playing && s.index >= 0, `a slow double tap on the big play button, presses ${apart} ms apart (hold ${hold}): it plays`, { p2p, s });
  }
  // The same slow double tap on a phone still busy with the first tap (the page gets the second
  // press 150 ms late): it plays.
  {
    await fresh('/');
    await goTo(`/album/${await bigAlbum()}`);
    await run(`window.__late = []; document.addEventListener('click', () => { if (window.__busy) return; window.__busy = true; setTimeout(() => { const t = performance.now(); while (performance.now() - t < 300); }, 150); }, true);
      window.addEventListener('pointerdown', (e) => window.__late.push(Math.round(performance.now() - e.timeStamp)), true); return true;`);
    const r = await at('.play-big');
    const p2p = await tapsApart(r, r, { apart: 360, hold: 60 });
    await sleep(1500);
    const s = await snap();
    const late = await run('return window.__late;');
    check(late[1] >= 100 && s.playing && s.index >= 0, 'a slow double tap on the big play button while the page is busy with the first tap: it plays', { p2p, late, s });
  }
  // A song row and a card that plays: one load per double tap.
  for (const what of ['row', 'card']) {
    await fresh('/');
    if (what === 'row') await goTo(`/album/${await bigAlbum()}`);
    await run(`window.__qids = []; mpfy.player.onChange((st) => { if (st.queueId && window.__qids[window.__qids.length - 1] !== st.queueId) window.__qids.push(st.queueId); }); return true;`);
    const p =
      what === 'row'
        ? await at('.track-row .tr-main', { idx: 1, fx: 0.4 })
        : await run(`const s = [...document.querySelectorAll('.shelf')].find((x) => x.querySelector('h2').textContent === 'Aggiunti di recente'); const c = s.querySelector('button.card-link'); c.scrollIntoView({ block: 'center', inline: 'center' });
            await new Promise((r2) => setTimeout(r2, 400)); const q = c.getBoundingClientRect(); return { x: Math.round(q.left + q.width / 2), y: Math.round(q.top + q.height * 0.3) };`);
    await sleep(300);
    await doubleTap(b, p.x, p.y, { gap: 150 });
    await sleep(1200);
    const q = await run('return window.__qids;');
    check(q.length === 1, `double tap on a song ${what === 'row' ? 'row' : 'card of "Aggiunti di recente"'}: loaded once`, q);
  }
});

// Now Playing opened and back pressed in the same frame: it does not stay on screen without a layer.
scenario('np-back', async () => {
  let stuck = 0;
  for (let i = 0; i < 4; i++) {
    await fresh('/');
    await playing();
    const s = await run(`const cbs = []; const raf = window.requestAnimationFrame; window.requestAnimationFrame = (f) => { cbs.push(f); return 0; };
      try { document.querySelector('.mini-main').click(); } finally { window.requestAnimationFrame = raf; }
      await new Promise((r) => { window.addEventListener('popstate', r, { once: true }); history.back(); });
      for (const f of cbs) f(performance.now());
      await new Promise((r) => setTimeout(r, 500));
      return { open: document.querySelector('.np').classList.contains('open'), layers: mpfy.hasLayers() };`);
    if (s.open && !s.layers) stuck++;
  }
  check(stuck === 0, 'Now Playing opened and back in the same frame: it does not stay on screen without a way to close it', { stuck });
});

// Drag down to close Now Playing: a pinch or a sideways flick does not close it.
scenario('pinch', async () => {
  await fresh('/');
  await playing();
  await openNowPlaying();
  const c = await at('.np-art');
  await touch('touchStart', [{ x: c.x - 20, y: c.y - 20, id: 1 }]);
  await touch('touchStart', [{ x: c.x - 20, y: c.y - 20, id: 1 }, { x: c.x + 20, y: c.y + 20, id: 2 }]);
  for (let i = 1; i <= 8; i++) {
    await touch('touchMove', [{ x: c.x - 20 - i * 6, y: c.y - 20 - i * 8, id: 1 }, { x: c.x + 20 + i * 6, y: c.y + 20 + i * 16, id: 2 }]);
    await sleep(20);
  }
  await touch('touchEnd', []);
  await sleep(700);
  check((await snap()).np, 'a pinch on the Now Playing cover does not close it', await snap());
});
// The same pinch with the upper finger on the header and the lower one on the cover (two parts
// that each drag Now Playing down), put down upper finger first, or lower finger first. One
// browser each: after a two finger sequence the emulated touch screen sends no pointer events.
async function pinchSplit(first) {
  await fresh('/');
  await playing();
  await openNowPlaying();
  const lab = await at('.np-from-label');
  const art = await at('.np-art');
  const up = { x: lab.x, y: lab.y, id: 1 };
  const low = { x: art.x + 20, y: art.y + 20, id: 2 };
  const under = await run(`const e = document.elementFromPoint(${up.x}, ${up.y}); return e && e.closest('.np-head') ? 'np-head' : e ? e.className : null;`);
  const at0 = first === 'header' ? up : low;
  await touch('touchStart', [at0]);
  await sleep(30);
  await touch('touchStart', [up, low]);
  for (let i = 1; i <= 8; i++) {
    await touch('touchMove', [{ x: up.x - i * 4, y: up.y - i * 2, id: 1 }, { x: low.x + i * 6, y: low.y + i * 16, id: 2 }]);
    await sleep(20);
  }
  await touch('touchEnd', []);
  await sleep(700);
  const s = await snap();
  check(under === 'np-head' && s.np, `a pinch with one finger on the Now Playing header and one on the cover, the ${first} finger down first, does not close it`, { under, s });
}
scenario('pinch-split', () => pinchSplit('header'));
scenario('pinch-split-low', () => pinchSplit('cover'));
scenario('flick-dismiss', async () => {
  await fresh('/');
  await playing();
  await openNowPlaying();
  const c = await at('.np-art');
  // Fast, as a flick is (the events in one burst): 40 px down this fast is past the speed that
  // closes it on a drag down.
  for (const dx of [-200, 200]) {
    const x0 = c.x - dx / 2;
    const y0 = c.y - 20;
    const sent = [touch('touchStart', [{ x: x0, y: y0, id: 1 }])];
    for (const f of [0.25, 0.5, 0.75, 1]) sent.push(touch('touchMove', [{ x: x0 + dx * f, y: y0 + 40 * f, id: 1 }]));
    sent.push(touch('touchEnd', []));
    await Promise.all(sent);
    await sleep(700);
    check((await snap()).np, `a fast sideways flick (${dx} px, 40 px down) on the cover does not close Now Playing`, await snap());
  }
  await touchFling(b, { x: c.x, y: c.y - 60, dy: 200, speed: 2000 });
  await sleep(700);
  check(!(await snap()).np, 'a flick down on the cover closes Now Playing', await snap());
});

// Now Playing closed with its chevron over Home, then a tap 150 ms after the lift on a Home tile it
// uncovers while sliding away: the tap belongs to the gesture that closed it and opens nothing; the
// same tap pressed 400 ms after the press on the chevron opens the tile. (After a flick down Chrome
// itself drops such a tap.)
scenario('np-close', async () => {
  for (const [wait, hold] of [[150, 80], [400, 80], [400, 120]]) {
    await fresh('/');
    await playing();
    const tile = await at('.tile-link', { idx: 0, fx: 0.3 });
    await openNowPlaying();
    const c = await at('.np-head .icon-btn');
    let p2p = null;
    if (wait < 400) {
      await tap(b, c.x, c.y);
      await sleep(wait);
      await tap(b, tile.x, tile.y);
    } else p2p = await tapsApart(c, tile, { apart: wait, hold });
    await sleep(900);
    const s = await snap();
    if (wait < 400) check(!s.np && s.path === '/', `a tap ${wait} ms after the tap on the chevron that closed Now Playing, on a Home tile: nothing opens`, s);
    else check(!s.np && s.path !== '/', `a Home tile pressed ${wait} ms after the press on the chevron that closed Now Playing (hold ${hold}): it opens`, { p2p, s });
  }
});

// The app's folder picker: a double tap on "Carica cartella" asks for one picker.
scenario('pick-folder', async () => {
  const fake = `(() => { window.__calls = []; window.MPfyNative = new Proxy({}, { get: (_, name) => (...args) => { window.__calls.push([name, ...args]);
    switch (name) { case 'bridgeVersion': return '3'; case 'getStorage': return JSON.stringify({ downloadsBytes: 0, downloadsCount: 0, cacheBytes: 0 });
      case 'getProfileFile': return JSON.stringify({ fileName: 'Bacca.mpfy', folder: 'Documents/MPfy', state: 'ok' }); case 'listDownloads': return JSON.stringify({ ids: [], progress: {}, items: [] });
      case 'getNetwork': return JSON.stringify({ type: 'wifi', metered: false }); case 'getState': return JSON.stringify({ playing: false }); case 'pickFolder': return 'f00df00df00df00d';
      default: return undefined; } } }); })();`;
  const { identifier } = await b.S('Page.addScriptToEvaluateOnNewDocument', { source: fake });
  try {
    await fresh('/');
    await run(`document.querySelector('.home-top [aria-label="Carica brani"]').click(); return true;`);
    await sleep(900);
    const r = await at('.up-picks .btn', { text: 'Carica cartella' });
    await doubleTap(b, r.x, r.y, { gap: 150 });
    await sleep(500);
    const n1 = await run(`return window.__calls.filter((c) => c[0] === 'pickFolder').length;`);
    check(n1 === 1, 'double tap on "Carica cartella" in the app: one folder picker', n1);
    await run(`window.__mpfyNative({ type: 'folder', requestId: 'f00df00df00df00d', state: 'cancelled' }); return true;`);
    await sleep(300);
    await tap(b, r.x, r.y);
    await sleep(500);
    const n2 = await run(`return window.__calls.filter((c) => c[0] === 'pickFolder').length;`);
    check(n2 === 2, 'the picker answered (cancelled): a new tap opens it again', n2);
  } finally {
    await b.S('Page.removeScriptToEvaluateOnNewDocument', { identifier });
  }
});

// A slow source: "Mostra codice" double tapped asks once and shows one dialog; "Esporta profilo"
// double tapped downloads one file.
scenario('one-at-a-time', async () => {
  for (const gap of [100, 250]) {
    await fresh('/');
    const id = await run(`return mpfy.sources.list.find((s) => s.name === 'Mi A2').id;`);
    await fetch(`${base}/__mock/source?source=${encodeURIComponent(id)}&rtt=600`);
    await goTo(`/impostazioni/fonte/${encodeURIComponent(id)}`);
    await run(`window.__code = 0; const f = window.fetch; window.fetch = (u, o) => { if (/\\/api\\/admin\\/code$/.test(String(u))) window.__code++; return f(u, o); }; return true;`);
    const r = await at('button.set-row', { text: 'Mostra codice', fx: 0.5 });
    await doubleTap(b, r.x, r.y, { gap });
    await sleep(2500);
    const s = await snap();
    const n = await run('return window.__code;');
    check(n === 1 && s.layers.length === 1, `double tap on "Mostra codice" with a slow source (gap ${gap}): one request, one dialog`, { n, layers: s.layers });
  }
  await fresh('/impostazioni/profilo');
  await run(`window.__dl = 0; document.addEventListener('click', (e) => { if (e.target.matches && e.target.matches('a[download]')) { window.__dl++; e.preventDefault(); } }, true); return true;`);
  const r = await at('button.set-row', { text: 'Esporta profilo' });
  await doubleTap(b, r.x, r.y, { gap: 150 });
  await sleep(1500);
  const n = await run('return window.__dl;');
  check(n === 1, 'double tap on "Esporta profilo": one file', n);
});

// One source slow to answer does not hold back the same action on another source: "Mostra codice"
// and "Cambia codice" of VPS prova while Mi A2 still answers its own.
scenario('one-per-source', async () => {
  const ids = async () => {
    const all = await run(`return mpfy.sources.list.map((s) => [s.name, s.id]);`);
    return { mi: all.find((x) => x[0] === 'Mi A2')[1], vps: all.find((x) => x[0] === 'VPS prova')[1] };
  };
  const page = (id) => `/impostazioni/fonte/${encodeURIComponent(id)}`;
  const row = (text) => at('button.set-row', { text, fx: 0.5 });
  const spy = `window.__req = []; const f = window.fetch; window.fetch = (u, o) => { if (/\\/admin\\/code/.test(String(u))) window.__req.push(String(u)); return f(u, o); }; return true;`;
  {
    await fresh('/');
    const { mi, vps } = await ids();
    await run(spy);
    await goTo(page(mi));
    await fetch(`${base}/__mock/source?source=${encodeURIComponent(mi)}&rtt=12000`);
    const r = await row('Mostra codice');
    await tap(b, r.x, r.y);
    await sleep(1500);
    await goTo(page(vps), 1200);
    const r2 = await row('Mostra codice');
    await tap(b, r2.x, r2.y);
    await sleep(2000);
    const s = await snap();
    const req = await run('return window.__req;');
    check(req.some((u) => u.includes(vps)) && s.layers.some((l) => /VPS prova/.test(l)), '"Mostra codice" of VPS prova while Mi A2 still answers its own: VPS prova is asked, its code shows', { req, layers: s.layers });
  }
  {
    await fresh('/');
    const { mi, vps } = await ids();
    // This profile owns VPS prova too, so its page has "Cambia codice" as well.
    await fetch(`${base}/__mock/source?source=${encodeURIComponent(vps)}&role=owner`);
    await b.go(`${base}/?nosw`, 600);
    await run(`for (let i = 0; i < 80 && !(window.mpfy && mpfy.store.loaded && mpfy.store.roleOf(${JSON.stringify(vps)}) === 'owner'); i++) await new Promise((r) => setTimeout(r, 100)); return true;`);
    await run(spy);
    await goTo(page(mi));
    await fetch(`${base}/__mock/source?source=${encodeURIComponent(mi)}&rtt=12000`);
    const r = await row('Cambia codice');
    await tap(b, r.x, r.y);
    await sleep(800);
    const ok = await at('.layer-dialog:not(.closing) .btn', { text: 'Cambia codice' });
    await tap(b, ok.x, ok.y);
    await sleep(1200);
    await goTo(page(vps), 1200);
    const r2 = await row('Cambia codice');
    if (!r2) {
      check(false, '"Cambia codice" on the page of VPS prova', 'no such row');
      return;
    }
    await tap(b, r2.x, r2.y);
    await sleep(900);
    const s = await snap();
    check(s.layers.some((l) => /Cambiare/.test(l)), '"Cambia codice" of VPS prova while Mi A2 still changes its own: the question opens', { req: await run('return window.__req;'), layers: s.layers });
  }
});

// A tap on a shelf still gliding after a fling stops it and opens nothing; once it stopped, a tap
// opens the card. The browser drops such a tap by itself: this keeps it so (and keeps the guards
// of dom.js from eating the tap after it). A fling whose touch events reach the page late ends with
// no glide and is not a try: up to 8 flings, until 2 of them glided.
scenario('glide', async () => {
  let hits = 0;
  let tries = 0;
  let opened = 0;
  for (let i = 0; i < 8 && tries < 2; i++) {
    await fresh('/');
    await run(`const s = [...document.querySelectorAll('.shelf')].find((x) => x.querySelector('h2').textContent === 'Album'); s.scrollIntoView({ block: 'center' }); window.__row = s.querySelector('.shelf-row'); window.__row.scrollLeft = 0;
      window.__sc = []; window.__row.addEventListener('scroll', () => window.__sc.push([Math.round(performance.now()), Math.round(window.__row.scrollLeft)]), { passive: true }); return true;`);
    await sleep(500);
    const r = await run(`const q = window.__row.getBoundingClientRect(); return { x: Math.round(q.left + q.width / 2), y: Math.round(q.top + 80) };`);
    const path0 = (await snap()).path;
    await touchFling(b, { x: r.x + 100, y: r.y, dx: -250, speed: 5000 });
    await sleep(30);
    const t = await run('return Math.round(performance.now());');
    await tap(b, r.x, r.y);
    await sleep(1000);
    const sc = await run('return window.__sc;');
    // Still gliding at the tap: it moved right up to it, at 0.3 px/ms or more (the slow end of a
    // glide is the browser's to call a tap or not, as gestures-chat.mjs counts it).
    const moving = sc.filter((e) => e[0] <= t + 5);
    const a = moving[moving.length - 2];
    const z = moving[moving.length - 1];
    const gliding = !!a && z[0] >= t - 20 && Math.abs(z[1] - a[1]) / Math.max(1, z[0] - a[0]) >= 0.3;
    if (!gliding) continue;
    tries++;
    if ((await snap()).path !== path0) {
      hits++;
      continue;
    }
    // The shelf stopped: a tap on a card in view opens it.
    const c = await run(`const c = [...window.__row.querySelectorAll('.card-link')].find((x) => { const q = x.getBoundingClientRect(); return q.left >= 0 && q.right <= innerWidth; });
      const q = c.getBoundingClientRect(); return { x: Math.round(q.left + q.width / 2), y: Math.round(q.top + q.height * 0.3) };`);
    await tap(b, c.x, c.y);
    await sleep(900);
    if (/^\/album\//.test((await snap()).path)) opened++;
  }
  check(tries > 0 && hits === 0, 'a tap on a shelf still gliding after a fling opens nothing', { tries, hits });
  check(tries > 0 && opened === tries, 'once the shelf stopped, a tap on a card opens it', { tries, opened });
});

const errors = [];
try {
  for (const s of scenarios) {
    if (only && !only.includes(s.name)) continue;
    L.log(`\n== ${s.name}`);
    b = await startBrowser(`taps-${s.name}`);
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
