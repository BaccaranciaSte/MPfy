// One long press, one menu, on a phone screen with touch. A WebView sends its own 'contextmenu'
// at the system's long press time (400 ms, 1 s or 1.5 s on Android, as the user set it), so before
// the page's own timer or after it, and some send none at all; a hook in the page plays the system:
// it sends that 'contextmenu' at that time on what the finger is held on, while it is still held,
// and after the lift a click on the same thing (as a WebView that takes the lift for a tap). For
// each surface and each of those times (400 ms, 1 s, 1.5 s, never): exactly one more layer, one
// Back takes it away, and the lift opens nothing (no page, no song).
//   bubble     a bubble in a chat; then "Elimina per tutti" on one of yours, confirmed: nothing
//              left on screen
//   comment    your comment in the comments sheet; then "Elimina": the sheet alone again
//   people     a chat's row in Amici and a source's row under "Fonti"; a click on the row a while
//              after its long press opens the chat (the press ended at its lift)
//   track      a track row of an album (the rows of a list share one listener, on the list)
//   edges      a bubble: a second finger 200 ms in, and a press the page takes for a scroll, open
//              nothing; a 'contextmenu' sent on the lift (after 300 ms and after 900 ms) one menu;
//              with a mouse each right click its own menu, and on a chat's row a left click after
//              one opens the chat
// The first four scenarios also check that what answers a long press there (every element given a
// 'contextmenu' listener, recorded as the page adds it: a row, or the list whose one listener takes
// the long presses of its rows) is not selectable, nor anything inside it but a text field:
// computed user-select none (else the WebView starts a text selection under the menu).
//
//   node web/dev/gestures-press.mjs <out dir> [--only name|name]
//
// Prints PASS/FAIL lines and fails=<n> (exit 1 on a failure); the same lines and the details go
// to <out dir>/gestures-press.log.
import fs from 'node:fs';
import path from 'node:path';
import { startMock, startBrowser, tap, sleep, logger } from './gesture-lib.mjs';

const outDir = path.resolve(process.argv[2] || '.');
fs.mkdirSync(outDir, { recursive: true });
const onlyAt = process.argv.indexOf('--only');
const only = onlyAt > 0 ? process.argv[onlyAt + 1].split('|') : null;
const L = logger(path.join(outDir, 'gestures-press.log'));
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
const helper = (q) => fetch(`${base}/__mock/${q}`);
const SIS = 'a7c1e0d2b3f4051627384950a1b2c3d4';

// The system in the page, from its first line: window.__cm.at is when its 'contextmenu' comes
// (null: never; 'lift': on the lift, as a browser that waits for it does), window.__cm.click
// whether the lift is followed by a click on what was held. A second finger, or the finger taken
// for a scroll (pointercancel), and the system sends nothing. window.__pressable holds every
// element given a 'contextmenu' listener.
const HOOK = `(() => {
  const cm = (window.__cm = { at: null, click: false, sent: 0, clicks: 0, stop: null });
  const pressable = (window.__pressable = new Set());
  const add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if (type === 'contextmenu' && this instanceof Element) pressable.add(this);
    return add.call(this, type, fn, opts);
  };
  const menuOn = (target, x, y) => {
    cm.sent++;
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, composed: true, button: 2, clientX: x, clientY: y }));
  };
  add.call(window, 'pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    if (!e.isPrimary) {
      if (cm.stop) cm.stop();
      return;
    }
    const target = e.target;
    const id = e.pointerId;
    const x = e.clientX;
    const y = e.clientY;
    let held = true;
    let timer = cm.at == null || cm.at === 'lift' ? 0 : setTimeout(() => {
      timer = 0;
      menuOn(target, x, y);
    }, cm.at);
    cm.stop = () => {
      held = false;
      clearTimeout(timer);
    };
    const end = (u) => {
      if (u.pointerId !== id) return;
      window.removeEventListener('pointerup', end, true);
      window.removeEventListener('pointercancel', end, true);
      clearTimeout(timer);
      if (cm.at === 'lift' && held && u.type === 'pointerup') menuOn(target, x, y);
      if (cm.click && u.type === 'pointerup') setTimeout(() => {
        cm.clicks++;
        target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, detail: 1, clientX: x, clientY: y }));
      }, 0);
    };
    add.call(window, 'pointerup', end, true);
    add.call(window, 'pointercancel', end, true);
  }, true);
})();`;

/** A clean page at route: storage cleared, the mock's sample data (and the helpers' extras). */
async function fresh(route = '/', extra = [], storage = null) {
  await touch('touchCancel', []).catch(() => {});
  await b.S('Page.navigate', { url: 'about:blank' });
  await sleep(200);
  await b.S('Storage.clearDataForOrigin', { origin: base, storageTypes: 'local_storage,indexeddb,service_workers,cache_storage' });
  await helper('reset?sources=2');
  for (const e of [].concat(extra).filter(Boolean)) await helper(e);
  if (storage) {
    // Kept on the device before the page starts (the "Fonti" block open).
    await b.go(`${base}/?nosw`, 300);
    await run(`${Object.entries(storage).map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join(' ')} return true;`);
  }
  await b.go(`${base}${route}${route.includes('?') ? '&' : '?'}nosw`, 600);
  await run(`for (let i = 0; i < 80 && !(window.mpfy && mpfy.store.loaded && mpfy.store.lib.tracks.length); i++) await new Promise((r) => setTimeout(r, 100)); return true;`);
  await sleep(700);
}
const ready = (sel, n = 60) => run(`for (let i = 0; i < ${n} && !document.querySelector(${JSON.stringify(sel)}); i++) await new Promise((r) => setTimeout(r, 100)); return !!document.querySelector(${JSON.stringify(sel)});`);
const at = (sel, { text = null, idx = 0 } = {}) =>
  run(`const els = [...document.querySelectorAll(${JSON.stringify(sel)})].filter((e) => !e.closest('.view-leaving') && !e.closest('.closing') && (${JSON.stringify(text)} == null || e.textContent.includes(${JSON.stringify(text)})));
    const e = els[${idx} < 0 ? els.length + ${idx} : ${idx}]; if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };`);
/** The element brought to the middle of its list, at rest (a press right after a scroll is not a long press). */
async function place(sel, opts = {}) {
  await run(`const els = [...document.querySelectorAll(${JSON.stringify(sel)})].filter((e) => !e.closest('.view-leaving') && !e.closest('.closing')); const e = els[${opts.idx ?? 0} < 0 ? els.length + ${opts.idx ?? 0} : ${opts.idx ?? 0}]; if (e) e.scrollIntoView({ block: 'center' }); return !!e;`);
  await sleep(500);
  return at(sel, opts);
}
const layers = () => run(`return document.querySelectorAll('#layers > .layer:not(.closing)').length;`);
const topItems = () => run(`const ls = [...document.querySelectorAll('#layers > .layer:not(.closing)')]; const t = ls[ls.length - 1]; return t ? [...t.querySelectorAll('.menu-item')].map((x) => x.textContent) : [];`);
const look = () => run(`return { path: location.pathname, layers: document.querySelectorAll('#layers > .layer:not(.closing)').length, played: !!(mpfy.player.state.playing || mpfy.player.state.index >= 0), sent: window.__cm.sent, clicks: window.__cm.clicks };`);
/** Back until only `n` layers are left (after a failure, so the next case starts clean). */
async function backTo(n) {
  for (let i = 0; i < 5 && (await layers()) > n; i++) {
    await run('history.back(); return true;');
    await sleep(600);
  }
}

/**
 * What answers a long press on the page now, and everything inside it but a text field: user-select
 * none. rows: elements that must each be inside one of them (the rows of a list).
 */
async function unselectable(label, want, rows = null) {
  const s = await run(`const kinds = new Set(); const bad = []; let n = 0;
    const sel = (el) => { const cs = getComputedStyle(el); return cs.userSelect || cs.webkitUserSelect; };
    for (const el of window.__pressable) {
      if (!el.isConnected) continue;
      n++;
      kinds.add(el.classList[0]);
      for (const x of [el, ...el.querySelectorAll('*')]) {
        if (x.matches('input, textarea, [contenteditable]')) continue;
        const v = sel(x);
        if (v !== 'none') bad.push((x.classList[0] || x.tagName) + ' in ' + el.classList[0] + ': ' + v);
      }
    }
    const rows = ${JSON.stringify(rows)} ? [...document.querySelectorAll(${JSON.stringify(rows)})] : [];
    const out = rows.filter((r) => ![...window.__pressable].some((el) => el.isConnected && el.contains(r))).length;
    return { n, kinds: [...kinds], bad: [...new Set(bad)].slice(0, 12), rows: rows.length, out };`);
  check(s.n > 0 && want.every((k) => s.kinds.includes(k)) && !s.bad.length && (!rows || (s.rows > 0 && !s.out)), `${label}: what answers a long press here is not selectable, nor anything in it (${JSON.stringify(s)})`, s);
}

const TIMES = [400, 1000, 1500, null];
const when = (t) => (t == null ? 'no contextmenu' : `contextmenu at ${t} ms`);

/**
 * A finger held on sel (the system's 'contextmenu' at t, then the lift and its click), for each
 * time: one more layer (its first item `first`), one Back takes it away, the lift opens nothing.
 */
async function pressEach(label, sel, { first, idx = 0 }) {
  for (const t of TIMES) {
    const base0 = await layers();
    const p = await place(sel, { idx });
    if (!p) {
      check(false, `${label}, ${when(t)}: one menu, one Back clears it, the lift opens nothing (not on the page)`);
      continue;
    }
    const s0 = await look();
    await run(`Object.assign(window.__cm, { at: ${t}, click: true }); return true;`);
    await touch('touchStart', [{ x: p.x, y: p.y, id: 1 }]);
    await sleep(t == null ? 900 : t + 400);
    await touch('touchEnd', []);
    await sleep(800);
    await run(`Object.assign(window.__cm, { at: null, click: false }); return true;`);
    const s1 = await look();
    const items = await topItems();
    await run('history.back(); return true;');
    await sleep(800);
    const s2 = await look();
    const r = { opened: s1.layers - base0, left: s2.layers - base0, first: items[0] || null, path: [s0.path, s1.path, s2.path], played: s1.played, sent: s1.sent - s0.sent, clicks: s1.clicks - s0.clicks };
    const ok = r.opened === 1 && r.left === 0 && (first instanceof RegExp ? first.test(r.first || '') : r.first === first) && s1.path === s0.path && s2.path === s0.path && !s1.played && r.sent === (t == null ? 0 : 1) && r.clicks === 1;
    check(ok, `${label}, ${when(t)}: one menu, one Back clears it, the lift opens nothing (${JSON.stringify(r)})`, r);
    await backTo(base0);
  }
}

const scenarios = [];
const scenario = (name, fn) => scenarios.push({ name, fn });

scenario('bubble', async () => {
  const st = await state();
  const giulia = st.chat.convs.find((x) => x.with === SIS).id;
  await fresh(`/chat/${giulia}`);
  await ready('#main .msg.theirs .bubble');
  await ready('#main .msg.mine .bubble');
  await sleep(500);
  await unselectable('a chat', ['bubble']);
  await pressEach('a bubble', '#main .msg.theirs .bubble:not(.has-card):not(.has-quote) .msg-text', { first: 'Rispondi', idx: -1 });
  // One of yours, "Elimina per tutti", confirmed: the menu went with it, nothing is left over.
  await helper('chat?clear=1');
  const base0 = await layers();
  const mine = await place('#main .msg.mine .bubble:not(.has-card):not(.has-quote) .msg-text', { idx: -1 });
  const id = await run(`const m = [...document.querySelectorAll('#main .msg.mine .bubble:not(.has-card):not(.has-quote)')].pop().closest('.msg'); return m.dataset.id;`);
  await run(`Object.assign(window.__cm, { at: 400, click: false }); return true;`);
  await touch('touchStart', [{ x: mine.x, y: mine.y, id: 1 }]);
  await sleep(800);
  await touch('touchEnd', []);
  await sleep(800);
  await run(`window.__cm.at = null; return true;`);
  const opened = (await layers()) - base0;
  const del = await at('#layers > .layer:not(.closing) .menu-item', { text: 'Elimina per tutti', idx: -1 });
  if (del) await tap(b, del.x, del.y);
  await sleep(900);
  const ok = await at('#layers > .layer:not(.closing) .dialog .btn-danger', { idx: -1 });
  if (ok) await tap(b, ok.x, ok.y);
  await sleep(1200);
  const left = (await layers()) - base0;
  const deletes = ((await state()).chat.deletes || []).length;
  check(opened === 1 && !!del && !!ok && left === 0, `"Elimina per tutti" on yours, confirmed: nothing left on screen (${JSON.stringify({ opened, left, deletes, id })})`, { opened, left, deletes });
  await backTo(base0);
});

scenario('comment', async () => {
  await fresh('/');
  const st = await state();
  const me = st.profile.id;
  const luce = await run(`const t = mpfy.store.lib.tracks.find((x) => x.title === 'Luce di posizione'); return { id: t.id, versions: mpfy.store.versions(t.id).map((v) => ({ sourceId: v.sourceId, trackId: v.trackId })) };`);
  const mi = await run(`return mpfy.sources.list.find((x) => x.name === 'Mi A2').id;`);
  const tid = luce.versions.find((v) => v.sourceId === mi).trackId;
  await helper(`songs?say=${tid}&source=${mi}&from=${me}&text=${encodeURIComponent('il mio commento')}`);
  await run(`mpfy.player.playContext({ type: 'library', id: null }, ${JSON.stringify([luce.id])}, 0);
    for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 100)); if (mpfy.player.state.playing && mpfy.player.positionNow() > 0.3) break; }
    mpfy.player.pause(); return true;`);
  await sleep(300);
  await run(`document.querySelector('.mini-main').click(); return true;`);
  await sleep(900);
  await run(`const i = document.querySelector('.np-inner'); i.scrollTop = i.scrollHeight; return true;`);
  await sleep(400);
  await run(`document.querySelector('.cm-card').click(); return true;`);
  await ready('.cm-sheet .cm-row');
  await sleep(800);
  const base0 = await layers();
  await unselectable('the comments', ['cm-row']);
  const mineSel = '.cm-sheet .cm-row .cm-text';
  const idx = await run(`return [...document.querySelectorAll(${JSON.stringify(mineSel)})].findIndex((x) => x.textContent === 'il mio commento');`);
  check(idx >= 0, `your comment is in the sheet (${idx})`);
  // The player was paused: "played" stays as it was (the lift starts nothing), so look at the path and layers only.
  for (const t of TIMES) {
    const p = await place(mineSel, { idx });
    await run(`Object.assign(window.__cm, { at: ${t}, click: true }); return true;`);
    const path0 = await run('return location.pathname;');
    await touch('touchStart', [{ x: p.x, y: p.y, id: 1 }]);
    await sleep(t == null ? 900 : t + 400);
    await touch('touchEnd', []);
    await sleep(800);
    await run(`Object.assign(window.__cm, { at: null, click: false }); return true;`);
    const opened = (await layers()) - base0;
    const items = await topItems();
    await run('history.back(); return true;');
    await sleep(800);
    const left = (await layers()) - base0;
    const path1 = await run('return location.pathname;');
    check(opened === 1 && left === 0 && items.join('|') === 'Modifica|Elimina' && path1 === path0, `your comment, ${when(t)}: one menu, one Back clears it, the lift opens nothing (${JSON.stringify({ opened, left, items })})`, { opened, left, items, path0, path1 });
    await backTo(base0);
  }
  // "Elimina": the menu goes, the comments sheet stays alone.
  await helper('songs?clear=1');
  const p = await place(mineSel, { idx });
  await run(`Object.assign(window.__cm, { at: 400, click: false }); return true;`);
  await touch('touchStart', [{ x: p.x, y: p.y, id: 1 }]);
  await sleep(800);
  await touch('touchEnd', []);
  await sleep(800);
  await run(`window.__cm.at = null; return true;`);
  const opened = (await layers()) - base0;
  const del = await at('#layers > .layer:not(.closing) .menu-item', { text: 'Elimina', idx: -1 });
  if (del) await tap(b, del.x, del.y);
  await sleep(1200);
  const left = (await layers()) - base0;
  const gone = await run(`return ![...document.querySelectorAll(${JSON.stringify(mineSel)})].some((x) => x.textContent === 'il mio commento');`);
  const deletes = (await state()).songs.deletes.length;
  check(opened === 1 && !!del && left === 0 && gone, `"Elimina" on your comment: the menu goes, the comments sheet alone again (${JSON.stringify({ opened, left, gone, deletes })})`, { opened, left, gone, deletes });
  await backTo(base0);
});

scenario('people', async () => {
  const st = await state();
  const giulia = st.chat.convs.find((x) => x.with === SIS).id;
  await fresh('/amici', [], { 'mpfy.friends.fonti': '1' });
  await ready(`#main .ami-row[href="/chat/${giulia}"]`);
  await ready('#main .fonti-groups .ami-group');
  await sleep(500);
  await unselectable('Amici', ['ami-row']);
  await pressEach("a chat's row in Amici", `#main .ami-row[href="/chat/${giulia}"]`, { first: '8 ore' });
  await pressEach('a source\'s row under "Fonti"', '#main .fonti-groups .ami-group', { first: '8 ore' });
  // The press is over at its lift: a click on the row a while later (with no press of its own, as a
  // mouse or a key gives it) opens the chat.
  await sleep(1200);
  await run(`document.querySelector('#main .ami-row[href="/chat/${giulia}"]').click(); return true;`);
  await sleep(1000);
  const after = await look();
  check(after.path === `/chat/${giulia}` && !after.layers, `a click on the row 1 s after its long press opens the chat (${JSON.stringify(after)})`, after);
});

scenario('track', async () => {
  await fresh('/');
  const albumId = await run(`return [...mpfy.store.d.albums.values()].find((a) => a.name === 'Frequenze').id;`);
  await b.go(`${base}/album/${albumId}?nosw`, 1500);
  await ready('#main .track-row');
  await sleep(500);
  await unselectable('an album', ['vlist'], '#main .track-row');
  await pressEach('a track row', '#main .track-row .tr-title-text', { first: /Mi piace$/, idx: 1 });
});

scenario('edges', async () => {
  const st = await state();
  const giulia = st.chat.convs.find((x) => x.with === SIS).id;
  await fresh(`/chat/${giulia}`);
  await ready('#main .msg.theirs .bubble');
  await sleep(500);
  const sel = '#main .msg.theirs .bubble:not(.has-card):not(.has-quote) .msg-text';
  const base0 = await layers();
  /** A press on the last of their bubbles, `steps` the moves after the touch; how many layers it left open. */
  const held = async (label, cm, steps, wantOpened) => {
    const p = await place(sel, { idx: -1 });
    await run(`Object.assign(window.__cm, ${JSON.stringify(cm)}); return true;`);
    const s0 = await look();
    await touch('touchStart', [{ x: p.x, y: p.y, id: 1 }]);
    await steps(p);
    await sleep(800);
    await run(`Object.assign(window.__cm, { at: null, click: false }); return true;`);
    const s1 = await look();
    const opened = s1.layers - base0;
    if (opened) await run('history.back(); return true;');
    await sleep(800);
    const left = (await layers()) - base0;
    const r = { opened, left, sent: s1.sent - s0.sent, clicks: s1.clicks - s0.clicks, path: [s0.path, s1.path] };
    check(opened === wantOpened && left === 0 && s1.path === s0.path, `${label} (${JSON.stringify(r)})`, r);
    await backTo(base0);
  };
  // A second finger 200 ms in: a pinch, no menu (the system sends none either).
  await held('a second finger during a long press: no menu', { at: 400, click: true }, async (p) => {
    await sleep(200);
    await touch('touchStart', [{ x: p.x, y: p.y, id: 1 }, { x: p.x, y: p.y + 150, id: 2 }]);
    await sleep(900);
    await touch('touchEnd', []);
  }, 0);
  // The finger taken for a scroll 300 ms in (pointercancel): no menu, at no time after.
  await held('a press the page took for a scroll: no menu', { at: 1000, click: true }, async () => {
    await sleep(300);
    await touch('touchCancel', []);
    await sleep(1200);
  }, 0);
  // A browser that sends its 'contextmenu' on the lift, held shorter than the page's timer and longer.
  for (const hold of [300, 900]) {
    await held(`contextmenu on the lift after ${hold} ms: one menu`, { at: 'lift', click: true }, async () => {
      await sleep(hold);
      await touch('touchEnd', []);
    }, 1);
  }
  // A mouse: each right click its own menu, and a left click right after one opens what it is on.
  await b.S('Emulation.setTouchEmulationEnabled', { enabled: false });
  const mouse = async (type, p, button) => b.S('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button, buttons: type === 'mousePressed' ? (button === 'right' ? 2 : 1) : 0, clickCount: 1 });
  for (let i = 0; i < 2; i++) {
    const p = await place(sel, { idx: -1 });
    await mouse('mouseMoved', p, 'none');
    await mouse('mousePressed', p, 'right');
    await sleep(60);
    await mouse('mouseReleased', p, 'right');
    await sleep(700);
    const opened = (await layers()) - base0;
    const items = await topItems();
    await run('history.back(); return true;');
    await sleep(800);
    check(opened === 1 && items[0] === 'Rispondi' && (await layers()) === base0, `a right click with a mouse, the ${i ? 'second' : 'first'}: one menu (${JSON.stringify({ opened, first: items[0] })})`);
    await backTo(base0);
  }
  await b.go(`${base}/amici?nosw`, 1500);
  await ready(`#main .ami-row[href="/chat/${giulia}"]`);
  await sleep(500);
  const base1 = await layers();
  const rowSel = `#main .ami-row[href="/chat/${giulia}"]`;
  let p = await place(rowSel);
  await mouse('mouseMoved', p, 'none');
  await mouse('mousePressed', p, 'right');
  await sleep(60);
  await mouse('mouseReleased', p, 'right');
  await sleep(700);
  const opened = (await layers()) - base1;
  await run('history.back(); return true;');
  await sleep(900);
  p = await at(rowSel);
  await mouse('mousePressed', p, 'left');
  await sleep(60);
  await mouse('mouseReleased', p, 'left');
  await sleep(1000);
  const after = await look();
  check(opened === 1 && after.path === `/chat/${giulia}` && after.layers === base1, `a right click on a chat's row, then a left click on it: its menu, then the chat (${JSON.stringify({ opened, after })})`);
});

const errors = [];
try {
  for (const s of scenarios) {
    if (only && !only.includes(s.name)) continue;
    L.log(`\n== ${s.name}`);
    b = await startBrowser(`press-${s.name}`);
    L.log('browser', b.version);
    try {
      await b.phone();
      await b.S('Page.addScriptToEvaluateOnNewDocument', { source: HOOK });
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
