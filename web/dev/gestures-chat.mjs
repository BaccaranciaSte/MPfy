// The chats under fast and odd input, on a phone screen with touch (and a PC window with the mouse
// for the right column):
//   rows       a fling on Amici with chats, then a tap while it glides: nothing opens; double and
//              triple taps on a chat's row: that chat once, one history step; on "Fonti": open,
//              closed, open again, never a page
//   log        flings on the log while messages arrive: nothing jumps unless it was at the bottom;
//              two fingers on it: nothing opens, nothing moves
//   older      at the top of the log, and after a fling to it: the older ones load once, the
//              messages on screen staying where they are (the first one drawn anew)
//   cards      a tap on a card while the log glides opens nothing; once it stopped a tap opens it;
//              a double tap on a card opens one view
//   press      a long press on a bubble opens its menu; one that lands on the log while it glides
//              opens none; a double tap on "Altre opzioni": one sheet
//   send       a double tap on "Invia" and a burst of taps: one message each time; a second
//              message written while the first is still on its way: both, one request at a time,
//              in their order, each with its own id
//   emoji      a fling in the emoji panel, then a tap: one emoji; a tap while it glides: none
//   share      a double tap on a pick: one pick; a double tap on "Invia": one message per target
//   column     (1366 x 768) a burst of clicks on rows of the column: one chat in it, the page
//              under it as it was
//
//   node web/dev/gestures-chat.mjs <out dir> [--only name|name]
//
// Prints PASS/FAIL lines and fails=<n> (exit 1 on a failure); the same lines and the details go
// to <out dir>/gestures-chat.log.
import fs from 'node:fs';
import path from 'node:path';
import { startMock, startBrowser, tap, doubleTap, twoFingers, sleep, logger } from './gesture-lib.mjs';

const outDir = path.resolve(process.argv[2] || '.');
fs.mkdirSync(outDir, { recursive: true });
const onlyAt = process.argv.indexOf('--only');
const only = onlyAt > 0 ? process.argv[onlyAt + 1].split('|') : null;
const L = logger(path.join(outDir, 'gestures-chat.log'));
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
const SIS = 'a7c1e0d2b3f4051627384950a1b2c3d4';

/** A clean page at route: storage cleared, the mock's sample data (and the chat helper's extra). */
async function fresh(route = '/', extra = '') {
  await touch('touchCancel', []).catch(() => {});
  await b.S('Page.navigate', { url: 'about:blank' });
  await sleep(200);
  await b.S('Storage.clearDataForOrigin', { origin: base, storageTypes: 'local_storage,indexeddb,service_workers,cache_storage' });
  await fetch(`${base}/__mock/reset?sources=2`);
  for (const e of [].concat(extra).filter(Boolean)) await fetch(`${base}/__mock/${e}`);
  await b.go(`${base}${route}${route.includes('?') ? '&' : '?'}nosw`, 600);
  await run(`for (let i = 0; i < 60 && !(window.mpfy && mpfy.store.loaded); i++) await new Promise((r) => setTimeout(r, 100)); return true;`);
  await sleep(700);
}
const ids = async () => {
  const st = await state();
  const c = (pred) => st.chat.convs.find(pred);
  return { giulia: c((x) => x.with === SIS).id, sara: c((x) => x.with === '8a2b4c6d8e0f1a3b5c7d9e1f2a4b6c8d').id, group: c((x) => x.kind === 'group' && x.count > 0).id };
};
const SNAP = `return { path: location.pathname + location.search, views: document.querySelectorAll('#main > .view').length, layers: [...document.querySelectorAll('#layers > .layer:not(.closing)')].length, hist: history.length };`;
const snap = () => run(SNAP);
const at = (sel, { text = null, idx = 0, fy = 0.5, last = false } = {}) =>
  run(`const els = [...document.querySelectorAll(${JSON.stringify(sel)})].filter((e) => !e.closest('.view-leaving') && (${JSON.stringify(text)} == null || e.textContent.includes(${JSON.stringify(text)})));
    const e = ${last} ? els[els.length - 1] : els[${idx}]; if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height * ${fy}) };`);
const ready = (sel) => run(`for (let i = 0; i < 60 && !document.querySelector(${JSON.stringify(sel)}); i++) await new Promise((r) => setTimeout(r, 100)); return !!document.querySelector(${JSON.stringify(sel)});`);
/** A fling whose last move and lift go out together (the page takes each move a frame late). */
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
/** Records the scroll offsets of sel and the lifts and presses, with their times. */
// Watched again on the same page (several tries without a reload), the listeners of the try before
// go first: each event is counted once, and __downs[1] stays the press after the fling.
const watchScroll = (sel) =>
  run(`const el = document.querySelector(${JSON.stringify(sel)}); window.__sc = []; window.__ups = []; window.__downs = [];
    const w = window.__watch;
    if (w) {
      w.el.removeEventListener('scroll', w.onScroll, { passive: true });
      window.removeEventListener('touchend', w.onUp, true);
      window.removeEventListener('touchstart', w.onDown, true);
    }
    const onScroll = () => window.__sc.push([Math.round(performance.now()), Math.round(el.scrollTop)]);
    const onUp = () => window.__ups.push(Math.round(performance.now()));
    const onDown = () => window.__downs.push(Math.round(performance.now()));
    el.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('touchend', onUp, true);
    window.addEventListener('touchstart', onDown, true);
    window.__watch = { el, onScroll, onUp, onDown };
    return true;`);
/** The tap came while the list still glided fast (0.3 px/ms or more right up to the press). */
const glidedUntilTap = () =>
  run(`const lift = window.__ups[0]; const press = window.__downs[1]; if (lift == null || press == null) return false;
    const moving = window.__sc.filter((e) => e[0] > lift && e[0] <= press + 5); if (moving.length < 2) return false;
    const a = moving[moving.length - 2]; const z = moving[moving.length - 1];
    return z[0] >= press - 20 && Math.abs(z[1] - a[1]) / Math.max(1, z[0] - a[0]) >= 0.3;`);
const restLog = () => run(`const s = document.querySelector('.chat-scroll'); let last = -1; for (let i = 0; i < 40; i++) { if (s.scrollTop === last) break; last = s.scrollTop; await new Promise((r) => setTimeout(r, 100)); } return Math.round(s.scrollTop);`);
const sheetOpen = () => run(`return [...document.querySelectorAll('#layers > .layer-sheet:not(.closing)')].length;`);

const scenarios = [];
const scenario = (name, fn) => scenarios.push({ name, fn });

scenario('rows', async () => {
  let tries = 0;
  let hits = 0;
  for (let i = 0; i < 5; i++) {
    await fresh('/amici', 'social?crowd=40');
    await ready('#main .ami-row');
    await watchScroll('#main');
    const p0 = await snap();
    await quickFling({ x: 180, y: 600, dy: -380, speed: 5000 });
    await sleep(30);
    await tap(b, 180, 420);
    await sleep(1000);
    if (!(await glidedUntilTap())) continue;
    tries++;
    const p1 = await snap();
    if (p1.path !== p0.path || p1.hist !== p0.hist) hits++;
  }
  check(tries > 0 && hits === 0, 'a tap on Amici with chats still gliding after a fling opens nothing', { tries, hits });
  const { giulia } = await ids();
  for (const count of [2, 3]) {
    await fresh('/amici');
    await ready(`#main .ami-row[href="/chat/${giulia}"]`);
    const h0 = (await snap()).hist;
    const r = await at(`#main .ami-row[href="/chat/${giulia}"]`);
    await doubleTap(b, r.x, r.y, { gap: 120, hold: 60, count });
    await sleep(1200);
    const s = await snap();
    check(s.path === `/chat/${giulia}` && s.views === 1 && s.hist === h0 + 1 && !s.layers, `${count} taps on a chat's row: that chat once, one history step (${s.path}, ${s.hist - h0})`, s);
    await run('history.back(); return true;');
    await sleep(900);
    check((await snap()).path.startsWith('/amici'), 'then the system back once: Amici');
  }
  await fresh('/amici');
  await ready('#main .ami-fonti');
  const h0 = (await snap()).hist;
  const f = await at('#main .ami-fonti');
  await doubleTap(b, f.x, f.y, { gap: 120, hold: 60 });
  await sleep(600);
  const fo = await run(`return { open: document.querySelector('#main .fonti-block').classList.contains('open'), hist: history.length, path: location.pathname };`);
  check(fo.open && fo.hist === h0 && fo.path.startsWith('/amici'), `a double tap on "Fonti": open (the second tap is the rest of the gesture), never a page (${JSON.stringify(fo)})`, fo);
});

scenario('log', async () => {
  const { giulia } = await ids();
  const p = { x: 180, y: 420 };
  // Higher up in the log: flings while new messages come (two before, one once it rests); nothing
  // on screen jumps. A try counts only when the flings left the log well above its bottom (within
  // 80 px of it the new messages are meant to scroll into view): up to 4 tries, each must hold.
  let tries = 0;
  let bad = 0;
  const seen = [];
  for (let i = 0; i < 4 && tries < 2; i++) {
    await fresh(`/chat/${giulia}`, `chat?bulk=${giulia}&n=150`);
    await ready('#main .chat-scroll .msg');
    await sleep(600);
    await run(`const s = document.querySelector('#main .chat-scroll'); s.scrollTop = s.scrollHeight - s.clientHeight - 1500; return true;`);
    await sleep(400);
    for (let k = 0; k < 2; k++) await fetch(`${base}/__mock/chat?say=${giulia}&from=${SIS}&text=${encodeURIComponent(`nuovo ${k + 1}`)}`);
    await quickFling({ ...p, dy: 260, speed: 3000 });
    await sleep(200);
    await quickFling({ ...p, dy: -160, speed: 1800 });
    const rest = await restLog();
    const anchor = await run(`const s = document.querySelector('#main .chat-scroll'); const top = s.getBoundingClientRect().top; const m = [...s.querySelectorAll('.msg')].find((x) => x.getBoundingClientRect().top > top + 40); window.__anchor = m.dataset.id; return { id: m.dataset.id, y: Math.round(m.getBoundingClientRect().top), gap: Math.round(s.scrollHeight - s.scrollTop - s.clientHeight) };`);
    if (anchor.gap <= 200) {
      seen.push({ rest, skipped: anchor.gap });
      continue;
    }
    tries++;
    // One more comes once the log rests: it is drawn while the log is away from its bottom.
    await fetch(`${base}/__mock/chat?say=${giulia}&from=${SIS}&text=${encodeURIComponent('nuovo 3')}`);
    await sleep(4500);
    const after = await run(`const s = document.querySelector('#main .chat-scroll'); const m = s.querySelector('.msg[data-id="' + window.__anchor + '"]'); return { y: Math.round(m.getBoundingClientRect().top), gap: Math.round(s.scrollHeight - s.scrollTop - s.clientHeight), last: [...s.querySelectorAll('.msg-text')].slice(-3).map((x) => x.textContent).join() };`);
    seen.push({ rest, anchor, after });
    if (!(after.last === 'nuovo 1,nuovo 2,nuovo 3' && Math.abs(after.y - anchor.y) <= 2 && after.gap > 80)) bad++;
  }
  check(tries > 0 && bad === 0, `flings on the log while messages arrive: they come, the messages on screen do not move (${JSON.stringify({ tries, bad })})`, seen);
  // At the bottom: the new one scrolls into view.
  await run(`const s = document.querySelector('#main .chat-scroll'); s.scrollTop = s.scrollHeight; return true;`);
  await sleep(500);
  await quickFling({ ...p, dy: -150, speed: 2000 });
  await restLog();
  await fetch(`${base}/__mock/chat?say=${giulia}&from=${SIS}&text=${encodeURIComponent('in fondo')}`);
  await sleep(4500);
  const bottom = await run(`const s = document.querySelector('#main .chat-scroll'); return { gap: Math.round(s.scrollHeight - s.scrollTop - s.clientHeight), last: [...s.querySelectorAll('.msg-text')].pop().textContent };`);
  check(bottom.last === 'in fondo' && bottom.gap <= 2, `at the bottom the new message scrolls into view (${JSON.stringify(bottom)})`, bottom);
  // Two fingers on the log: nothing opens, no menu, the log stays.
  const before = await snap();
  const top0 = await run(`return Math.round(document.querySelector('#main .chat-scroll').scrollTop);`);
  await twoFingers(b, { x: 120, y: 400 }, { x: 240, y: 520 }, { hold: 150 });
  await sleep(700);
  const two = { ...(await snap()), top: await run(`return Math.round(document.querySelector('#main .chat-scroll').scrollTop);`), sheet: await sheetOpen() };
  check(two.path === before.path && two.hist === before.hist && !two.sheet && Math.abs(two.top - top0) <= 2, `two fingers on the log: nothing opens, nothing moves (${JSON.stringify(two)})`, two);
});

scenario('older', async () => {
  const { giulia } = await ids();
  // 127 messages, the newest 50 shown. At the very top the 50 before them load; the first message
  // shown now has older ones of its day before it, so its bubble is drawn anew (its run and its day
  // label change): the place is kept by that message all the same, and one page comes, not two.
  await fresh(`/chat/${giulia}`, `chat?bulk=${giulia}&n=120`);
  await ready('#main .chat-scroll .msg');
  await sleep(600);
  const r = await run(`const s = document.querySelector('#main .chat-scroll'); const n0 = s.querySelectorAll('.msg').length; const m = [...s.querySelectorAll('.msg')][5]; s.scrollTop = 0;
    await new Promise((r) => setTimeout(r, 50)); const before = m.dataset.id; const y0 = s.querySelector('.msg[data-id="' + before + '"]').getBoundingClientRect().top;
    await new Promise((r) => setTimeout(r, 2500)); return { n0, n: s.querySelectorAll('.msg').length, moved: Math.round(s.querySelector('.msg[data-id="' + before + '"]').getBoundingClientRect().top - y0), top: Math.round(s.scrollTop) };`);
  check(r.n0 === 50 && r.n === 100 && Math.abs(r.moved) <= 2 && r.top > 400, `at the top of the log the 50 older ones load once, the messages on screen stay where they are (${JSON.stringify(r)})`, r);
  // A fling up to the top while the older ones come: one page at a time, each once it is drawn.
  await fresh(`/chat/${giulia}`, `chat?bulk=${giulia}&n=120`);
  await ready('#main .chat-scroll .msg');
  await sleep(600);
  await run(`document.querySelector('#main .chat-scroll').scrollTop = 900; return true;`);
  await sleep(300);
  await quickFling({ x: 180, y: 300, dy: 500, speed: 4000 });
  const rest = await restLog();
  await sleep(2500);
  const f = await run(`const s = document.querySelector('#main .chat-scroll'); return { rest: ${rest}, n: s.querySelectorAll('.msg').length, top: Math.round(s.scrollTop) };`);
  check(f.n === 100 && f.top > 400, `a fling to the top: one older page, the log left where it was (${JSON.stringify(f)})`, f);
});

scenario('cards', async () => {
  const { giulia } = await ids();
  let tries = 0;
  let hits = 0;
  let opened = 0;
  for (let i = 0; i < 5; i++) {
    await fresh(`/chat/${giulia}`, [`chat?bulk=${giulia}&n=60`]);
    await ready('#main .mcard');
    await sleep(500);
    // The track card near the bottom of the screen, the log flung down under it.
    await run(`const s = document.querySelector('#main .chat-scroll'); s.scrollTop = s.scrollHeight; return true;`);
    await sleep(300);
    await watchScroll('#main .chat-scroll');
    const p0 = await snap();
    await quickFling({ x: 180, y: 300, dy: 300, speed: 4000 });
    await sleep(20);
    const c = await at('#main .mcard .mcard-link', { last: true });
    await tap(b, c.x, c.y);
    await sleep(900);
    if (!(await glidedUntilTap())) continue;
    tries++;
    const p1 = await snap();
    if (p1.path !== p0.path || p1.hist !== p0.hist) {
      hits++;
      continue;
    }
    await restLog();
    await run(`const c = [...document.querySelectorAll('#main .mcard .mcard-link')].pop(); c.scrollIntoView({ block: 'center' }); return true;`);
    await sleep(500);
    const c2 = await at('#main .mcard .mcard-link', { text: null, last: true });
    await tap(b, c2.x, c2.y);
    await sleep(1200);
    if ((await snap()).path !== p0.path) opened++;
  }
  check(tries > 0 && hits === 0, 'a tap on a card while the log glides opens nothing', { tries, hits });
  check(tries > 0 && opened === tries, 'once the log stopped, a tap on the card opens it', { tries, opened });
  for (const count of [2, 3]) {
    await fresh(`/chat/${giulia}`);
    await ready('#main .mcard');
    await sleep(500);
    const h0 = (await snap()).hist;
    const c = await at('#main .mcard .mcard-link', { last: true });
    await doubleTap(b, c.x, c.y, { gap: 110, hold: 60, count });
    await sleep(1200);
    const s = await snap();
    check(/^\/album\//.test(s.path) && s.views === 1 && s.hist === h0 + 1, `${count} taps on a card: one view, one step (${s.path}, ${s.hist - h0})`, s);
  }
});

scenario('press', async () => {
  const { giulia } = await ids();
  await fresh(`/chat/${giulia}`, `chat?bulk=${giulia}&n=80`);
  await ready('#main .msg.theirs .bubble');
  await sleep(500);
  // A long press at rest: the bubble's menu.
  const bub = await at('#main .msg.theirs .bubble', { last: true });
  await touch('touchStart', [{ x: bub.x, y: bub.y, id: 1 }]);
  await sleep(900);
  await touch('touchEnd', []);
  await sleep(700);
  const items = await run(`return [...document.querySelectorAll('#layers > .layer-sheet:not(.closing) .menu-item')].map((x) => x.textContent);`);
  check(items[0] === 'Rispondi', `a long press on a bubble: its menu (${items.join(', ')})`, items);
  await run('history.back(); return true;');
  await sleep(700);
  // A long press that lands on the log while it glides: no menu. The press must come while the log
  // still moves (glidedUntilTap): on a busy machine the round trips after the fling can let it stop
  // first, so up to 12 flings, until 3 presses landed on a glide.
  let tries = 0;
  let menus = 0;
  for (let i = 0; i < 12 && tries < 3; i++) {
    await run(`const s = document.querySelector('#main .chat-scroll'); s.scrollTop = s.scrollHeight; return true;`);
    await sleep(400);
    await watchScroll('#main .chat-scroll');
    await quickFling({ x: 180, y: 300, dy: 300, speed: 4000 });
    await sleep(20);
    const t0 = performance.now();
    const spot = await run(`const s = document.querySelector('#main .chat-scroll').getBoundingClientRect(); const b = [...document.querySelectorAll('#main .msg .bubble')].find((x) => { const r = x.getBoundingClientRect(); return r.top > s.top + 80 && r.bottom < s.bottom - 80; }); const r = (b || document.querySelector('#main .chat-scroll')).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };`);
    await touch('touchStart', [{ x: spot.x, y: spot.y, id: 1 }]);
    await sleep(900);
    await touch('touchEnd', []);
    await sleep(600);
    L.log('press try', JSON.stringify({ n: await run('return window.__sc.length;'), ups: await run('return window.__ups;'), downs: await run('return window.__downs;'), last: await run('return window.__sc.slice(-3);') }));
    if (!(await glidedUntilTap())) {
      while (await sheetOpen()) {
        await run('history.back(); return true;');
        await sleep(600);
      }
      continue;
    }
    tries++;
    if (await sheetOpen()) {
      menus++;
      await run('history.back(); return true;');
      await sleep(600);
    }
    L.log('press during glide', Math.round(performance.now() - t0));
  }
  check(tries > 0 && menus === 0, 'a long press that lands on the log while it glides opens no menu', { tries, menus });
  // A double tap on "Altre opzioni": one sheet; a double tap on its item: one more step.
  const more = await at('#main .chat-more');
  await doubleTap(b, more.x, more.y, { gap: 120, hold: 60 });
  await sleep(800);
  // One layer in the history: its entry is the only one above the page's.
  const s1 = { sheets: await sheetOpen(), depth: await run('return history.state && history.state.ov;') };
  const sil = await at('#layers .layer-sheet:not(.closing) .menu-item', { text: 'Silenzia' });
  await doubleTap(b, sil.x, sil.y, { gap: 120, hold: 60 });
  await sleep(900);
  const s2 = { sheets: await sheetOpen(), title: await run(`const t = document.querySelector('#layers > .layer-sheet:not(.closing) .sheet-title'); return t && t.textContent;`) };
  check(s1.sheets === 1 && s1.depth === 1 && s2.sheets === 1 && s2.title === 'Silenzia', `a double tap on "Altre opzioni": one sheet; on "Silenzia": one sheet of choices (${JSON.stringify({ s1, s2 })})`, { s1, s2 });
});

scenario('send', async () => {
  const { giulia } = await ids();
  await fresh(`/chat/${giulia}`, 'chat?clear=1');
  await ready('#main .composer textarea');
  const type = (t) => run(`const i = document.querySelector('#main .composer textarea'); i.value = ${JSON.stringify(t)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
  const send = await at('#main .composer-send');
  const posts = async (text) => (await state()).chat.posts.filter((p) => p.body.text === text);
  await type('due tocchi');
  await doubleTap(b, send.x, send.y, { gap: 100, hold: 50 });
  await sleep(1200);
  await type('tre tocchi');
  await doubleTap(b, send.x, send.y, { gap: 70, hold: 40, count: 3 });
  await sleep(1200);
  const p2 = await posts('due tocchi');
  const p3 = await posts('tre tocchi');
  check(p2.length === 1 && p3.length === 1, `a double and a triple tap on "Invia": one message each (${p2.length}, ${p3.length})`);
  // Written while the first is on its way (a slow source): both go, one at a time, in order.
  await fetch(`${base}/__mock/chat?postMs=5000&clear=1`);
  await type('primo');
  await tap(b, send.x, send.y);
  await sleep(300);
  await type('secondo');
  await tap(b, send.x, send.y);
  await sleep(700);
  const shown = await run(`return [...document.querySelectorAll('#main .msg.mine.is-pending .msg-text')].map((x) => x.textContent);`);
  await sleep(13000);
  const st = (await state()).chat.posts;
  const order = st.map((p) => p.body.text);
  const end = await run(`return [...document.querySelectorAll('#main .msg.mine .msg-text')].slice(-2).map((x) => x.textContent + (x.closest('.msg').classList.contains('is-pending') ? '/pending' : ''));`);
  check(shown.join() === 'primo,secondo' && order.join() === 'primo,secondo' && st[1].at - st[0].at >= 3500 && st[0].body.id !== st[1].body.id && end.join() === 'primo,secondo', `a second message while the first is on its way: both show at once, one request at a time in their order, each its own id (${JSON.stringify({ shown, order, apart: st.length > 1 ? st[1].at - st[0].at : null, end })})`, { shown, order, end });
});

scenario('emoji', async () => {
  const { giulia } = await ids();
  await fresh(`/chat/${giulia}`);
  await ready('#main .composer-emoji');
  const e = await at('#main .composer-emoji');
  await tap(b, e.x, e.y);
  await sleep(900);
  await ready('.emoji-panel .emoji-cell');
  await watchScroll('.emoji-panel .emoji-scroll');
  const value = () => run(`return document.querySelector('#main .composer textarea').value;`);
  const panel = await at('.emoji-panel .emoji-scroll', { fy: 0.6 });
  await quickFling({ x: panel.x, y: panel.y + 40, dy: -220, speed: 4000 });
  await sleep(20);
  await tap(b, panel.x, panel.y);
  await sleep(600);
  const glided = await glidedUntilTap();
  const during = await value();
  await run(`const s = document.querySelector('.emoji-panel .emoji-scroll'); let last = -1; for (let i = 0; i < 40; i++) { if (s.scrollTop === last) break; last = s.scrollTop; await new Promise((r) => setTimeout(r, 100)); } return true;`);
  const c = await at('.emoji-panel .emoji-cell', { idx: 2 });
  const cy = await run(`const s = document.querySelector('.emoji-panel .emoji-scroll').getBoundingClientRect(); const cells = [...document.querySelectorAll('.emoji-panel .emoji-cell')].filter((x) => { const r = x.getBoundingClientRect(); return r.top > s.top + 4 && r.bottom < s.bottom - 4; }); const r = cells[5].getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), e: cells[5].dataset.e };`);
  await tap(b, cy.x, cy.y);
  await sleep(500);
  const after = await value();
  check(!glided || during === '', `a tap in the emoji panel while it glides inserts nothing (${JSON.stringify(during)})`, { glided, during });
  check(after === during + cy.e && !!c, `then, at rest, a tap inserts one emoji (${JSON.stringify(during)} -> ${JSON.stringify(after)})`, { during, after });
  await doubleTap(b, cy.x, cy.y, { gap: 120, hold: 50 });
  await sleep(500);
  check((await value()) === after + cy.e + cy.e, 'a double tap on an emoji: two of it (each tap is one)', await value());
  // The emoji button (moved up with the panel) double tapped: closed, the rest of the gesture nothing.
  const e2 = await at('#main .composer-emoji');
  await doubleTap(b, e2.x, e2.y, { gap: 120, hold: 60 });
  await sleep(700);
  const open = await run(`return !!document.querySelector('.emoji-panel');`);
  check(open === false, `a double tap on the emoji button: one change (it was open: closed; the rest of the gesture does nothing) (${open})`, open);
});

scenario('share', async () => {
  await fresh('/');
  const albumId = await run(`return [...mpfy.store.d.albums.values()].find((a) => a.name === 'Frequenze').id;`);
  await b.go(`${base}/album/${albumId}?nosw`, 1500);
  await run(`document.querySelector('#main .track-row .tr-more').click(); return true;`);
  await sleep(700);
  await run(`[...document.querySelectorAll('.layer-sheet .menu-item')].find((x) => x.textContent === 'Condividi con...').click(); return true;`);
  await sleep(1000);
  await ready('.share-sheet .pick-row');
  const sara = await at('.share-sheet .pick-row[aria-label="Sara"]');
  await doubleTap(b, sara.x, sara.y, { gap: 120, hold: 60 });
  await sleep(300);
  const marco = await at('.share-sheet .pick-row[aria-label="Marco"]');
  await tap(b, marco.x, marco.y);
  await sleep(300);
  const picked = await run(`return [...document.querySelectorAll('.share-sheet .pick-row[aria-pressed="true"]')].map((x) => x.getAttribute('aria-label'));`);
  check(picked.join() === 'Marco,Sara', `a double tap on a pick: one pick (${picked.join()})`, picked);
  await fetch(`${base}/__mock/chat?clear=1`);
  const send = await at('.share-sheet .share-send .btn');
  await doubleTap(b, send.x, send.y, { gap: 100, hold: 50 });
  await sleep(2000);
  const posts = (await state()).chat.posts;
  check(posts.length === 2 && new Set(posts.map((p) => p.cid)).size === 2 && new Set(posts.map((p) => p.body.id)).size === 2 && !(await sheetOpen()), `a double tap on "Invia": one message per target (${posts.length})`, posts.map((p) => p.cid));
});

scenario('column', async () => {
  await b.S('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
  await b.S('Emulation.setTouchEmulationEnabled', { enabled: false });
  await fresh('/');
  await run(`localStorage.setItem('mpfy.friends.side', '1'); return true;`);
  await b.go(`${base}/?nosw`, 1500);
  await ready('.friends-side .ami-row[data-chat]');
  const click = async (p, count = 1) => {
    await b.S('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: count });
    await b.S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: count });
  };
  const rows = await run(`return [...document.querySelectorAll('.friends-side .ami-row[data-chat]')].slice(0, 3).map((r) => { const q = r.getBoundingClientRect(); return { x: Math.round(q.left + q.width / 2), y: Math.round(q.top + q.height / 2), chat: r.dataset.chat, label: r.getAttribute('aria-label') }; });`);
  const h0 = (await snap()).hist;
  for (let i = 0; i < 4; i++) {
    await click(rows[i % rows.length], i + 1);
    await sleep(70);
  }
  await sleep(1200);
  const s = await snap();
  const c = await run(`const a = document.querySelector('.friends-side'); return { chats: a.querySelectorAll('.side-chat').length, label: a.getAttribute('aria-label'), open: window.mpfy.friendsSide.chat };`);
  check(c.chats === 1 && c.open === rows[0].chat && /^\/(\?nosw)?$/.test(s.path) && s.hist === h0 && s.views === 1, `a burst of clicks on rows of the column: one chat, the first one clicked, the page under it as it was (${JSON.stringify({ c, s })})`, { c, s, rows });
});

const errors = [];
try {
  for (const s of scenarios) {
    if (only && !only.includes(s.name)) continue;
    L.log(`\n== ${s.name}`);
    b = await startBrowser(`chat-${s.name}`);
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
