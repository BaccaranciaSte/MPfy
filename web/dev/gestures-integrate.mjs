// Gestures across the pieces of the page: going back to a page finds its rows of cards where they
// were left; a double tap on what opens a system picker ("Scegli i file", "Carica cartella", "Dal
// file del profilo") opens one, while a tap pressed 400 ms after the previous press opens another.
//
//   node web/dev/gestures-integrate.mjs <out dir> [--only name|name]
//
// Prints PASS/FAIL lines and fails=<n> (exit 1 on a failure); the same lines and the details go
// to <out dir>/gestures-integrate.log.
import fs from 'node:fs';
import path from 'node:path';
import { startMock, startBrowser, tap, doubleTap, sleep, logger } from './gesture-lib.mjs';

const outDir = path.resolve(process.argv[2] || '.');
fs.mkdirSync(outDir, { recursive: true });
const onlyAt = process.argv.indexOf('--only');
const only = onlyAt > 0 ? process.argv[onlyAt + 1].split('|') : null;
const L = logger(path.join(outDir, 'gestures-integrate.log'));
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

/** A clean page of the app at route: storage cleared, the mock's data as q says. */
async function fresh(route, q = 'sources=2') {
  await b.S('Page.navigate', { url: 'about:blank' });
  await sleep(200);
  await b.S('Storage.clearDataForOrigin', { origin: base, storageTypes: 'local_storage,indexeddb,service_workers,cache_storage' });
  await fetch(`${base}/__mock/reset?${q}`);
  await b.go(`${base}${route}${route.includes('?') ? '&' : '?'}nosw`, 600);
  await run(`for (let i = 0; i < 60 && !(window.mpfy && mpfy.store.loaded); i++) await new Promise((r) => setTimeout(r, 100)); return true;`);
  await sleep(600);
}

/** File pickers the page opens are counted, not opened: { file, dir } so far. */
const COUNT_PICKS = `window.__picks = { file: 0, dir: 0 };
  const click = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () {
    if (this.type !== 'file') return click.call(this);
    window.__picks[this.webkitdirectory ? 'dir' : 'file']++;
  };
  return true;`;
const picks = () => run('return { ...window.__picks };');

/** The center of the first button whose text includes text, under root. */
const buttonAt = (root, text) =>
  run(`const e = [...document.querySelectorAll(${JSON.stringify(`${root} button`)})].find((x) => x.textContent.includes(${JSON.stringify(text)}));
    if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };`);

/** A double tap (150 ms apart), then one tap pressed about 480 ms after the double tap's last press. */
async function doubleThenLater(at) {
  await doubleTap(b, at.x, at.y, { gap: 150, hold: 70 });
  await sleep(500);
  const afterDouble = await picks();
  await tap(b, at.x, at.y, { hold: 80 });
  await sleep(500);
  return { afterDouble, afterLater: await picks() };
}

const scenarios = [];
const scenario = (name, fn) => scenarios.push({ name, fn });

const ROW = `const row = (t) => { const s = [...document.querySelectorAll('#main .shelf')].find((x) => { const h = x.querySelector('.shelf-head h2'); return h && h.textContent === t; }); return s ? s.querySelector('.shelf-row') : null; };`;

scenario('shelf-back', async () => {
  await fresh('/');
  const before = await run(`${ROW} const r = row('Aggiunti di recente'); const a = row('Album'); if (!r || !a) return null;
    r.scrollIntoView({ block: 'center' }); r.scrollLeft = 600; a.scrollLeft = 300;
    await new Promise((x) => setTimeout(x, 400));
    const link = [...a.querySelectorAll('a.card-link')].find((l) => { const q = l.getBoundingClientRect(); return q.left > 0 && q.right < innerWidth; }) || a.querySelector('a.card-link');
    link.scrollIntoView({ block: 'center', inline: 'nearest' });
    await new Promise((x) => setTimeout(x, 400));
    const q = link.getBoundingClientRect();
    return { added: Math.round(r.scrollLeft), album: Math.round(a.scrollLeft), top: Math.round(document.getElementById('main').scrollTop), x: Math.round(q.left + q.width / 2), y: Math.round(q.top + q.height / 2) };`);
  L.log('before', JSON.stringify(before));
  if (!before) {
    check(false, 'Home shows "Aggiunti di recente" and "Album"');
    return;
  }
  await tap(b, before.x, before.y, { hold: 80 });
  await sleep(1200);
  const opened = await run('return location.pathname;');
  // Back with the page's own arrow, as a person goes back.
  const back = await run(`const e = document.querySelector('#main .back-btn'); if (!e) return null; const q = e.getBoundingClientRect(); return { x: Math.round(q.left + q.width / 2), y: Math.round(q.top + q.height / 2) };`);
  if (back) await tap(b, back.x, back.y, { hold: 80 });
  await sleep(1500);
  const after = await run(`${ROW} const r = row('Aggiunti di recente'); const a = row('Album'); return { path: location.pathname, added: r ? Math.round(r.scrollLeft) : null, album: a ? Math.round(a.scrollLeft) : null, top: Math.round(document.getElementById('main').scrollTop) };`);
  L.log('opened', opened, 'after back', JSON.stringify(after));
  check(
    /^\/album\//.test(opened) && after.path === '/' && Math.abs(after.added - before.added) <= 2 && Math.abs(after.album - before.album) <= 2 && Math.abs(after.top - before.top) <= 2,
    `an album opened from a Home row and back with the arrow: every row where it was left (Aggiunti di recente ${before.added} -> ${after.added}, Album ${before.album} -> ${after.album}, page ${before.top} -> ${after.top})`
  );
  // Home reached again by the bottom bar is a new visit: its rows start at their first card.
  await run(`${ROW} row('Aggiunti di recente').scrollLeft = 500; return true;`);
  await run(`document.querySelector('#bottom a[href="/library"]').click(); return true;`);
  await sleep(1000);
  await run(`document.querySelector('#bottom a[href="/"]').click(); return true;`);
  await sleep(1200);
  const again = await run(`${ROW} const r = row('Aggiunti di recente'); return { path: location.pathname, added: r ? Math.round(r.scrollLeft) : null, top: Math.round(document.getElementById('main').scrollTop) };`);
  L.log('home again', JSON.stringify(again));
  check(again.path === '/' && again.added === 0 && again.top === 0, `Home opened again from the bottom bar: its rows and the page start from the top (${JSON.stringify(again)})`);
});

scenario('pick-files', async () => {
  await fresh('/');
  await run(COUNT_PICKS);
  await run(`document.querySelector('.home-top [aria-label="Carica brani"]').click(); return true;`);
  await sleep(1000);
  const pick = await buttonAt('.layer', 'Scegli i file');
  if (!pick) {
    check(false, '"Carica brani" shows "Scegli i file"');
    return;
  }
  const r = await doubleThenLater(pick);
  L.log('Scegli i file', JSON.stringify(r));
  check(r.afterDouble.file === 1, `a double tap on "Scegli i file" opens one picker (${r.afterDouble.file})`);
  check(r.afterLater.file === 2, `a tap pressed after a pause opens it again (${r.afterLater.file})`);
  const folder = await buttonAt('.layer', 'Carica cartella');
  if (!folder) {
    check(false, '"Carica brani" shows "Carica cartella"');
    return;
  }
  const f = await doubleThenLater(folder);
  L.log('Carica cartella', JSON.stringify(f));
  check(f.afterDouble.dir === 1, `a double tap on "Carica cartella" opens one folder picker (${f.afterDouble.dir})`);
  check(f.afterLater.dir === 2, `a tap pressed after a pause opens it again (${f.afterLater.dir})`);
});

scenario('profile-file', async () => {
  await fresh('/', 'sources=0&profile=0');
  await run(COUNT_PICKS);
  const rec = await buttonAt('.welcome', 'Recupera profilo');
  if (!rec) {
    check(false, 'the welcome shows "Recupera profilo"');
    return;
  }
  await tap(b, rec.x, rec.y, { hold: 80 });
  await sleep(900);
  const from = await buttonAt('.welcome', 'Dal file del profilo');
  if (!from) {
    check(false, '"Recupera profilo" shows "Dal file del profilo"');
    return;
  }
  const r = await doubleThenLater(from);
  L.log('Dal file del profilo', JSON.stringify(r));
  check(r.afterDouble.file === 1, `a double tap on "Dal file del profilo" opens one picker (${r.afterDouble.file})`);
  check(r.afterLater.file === 2, `a tap pressed after a pause opens it again (${r.afterLater.file})`);
});

const errors = [];
try {
  for (const s of scenarios) {
    if (only && !only.includes(s.name)) continue;
    L.log(`\n== ${s.name}`);
    b = await startBrowser(`integrate-${s.name}`);
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
