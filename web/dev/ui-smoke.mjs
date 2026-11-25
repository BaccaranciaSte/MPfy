// UI smoke test: starts the mock on a free port and a headless Edge (or MPFY_BROWSER) with its own
// throwaway profile, drives the real UI over the DevTools protocol at 360x800 and 1366x768, checks
// what each screen shows, horizontal overflow and console errors, and saves screenshots. Besides
// the library, menus, settings and player: the way in (welcome, name, first source, "Ho già un
// profilo", the three ways of "Recupera profilo"), the profile pages and the password recovery,
// Memoria, the naming step after every add flow (also after a slow first sync), what a member
// sees and does not, the delete dialogs, and uploads (hint, outcomes, the "maybe" choice,
// archives, a folder, a chunked upload that survives a drop). The profile photo: the letter of the
// name without one, the photo set through the crop screen in Home, Impostazioni and Profilo, the
// letter again when it is taken away or its bytes are gone, the gear on a core without profiles. The
// people: your picture opening Amici (Impostazioni with no social source), Amici and its search, a
// person's page, Recenti, Impostazioni > Social, the PC's right column and what the page reports
// as playing (never from bridge 5). The chats: Amici with the groups and "Fonti", a 1:1 and a group
// (runs, days, cards, quotes, the long press, delete, pending and failed, scrolling, read marks),
// the composer and the emoji panel, "Condividi con...", Home's shared cards and the unread dot, a
// person's "Scrivi a", blocks and "Persone bloccate", a shared playlist, the app's bridge 6 and a
// chat in the PC's column. Then the update button of an app
// with bridge 4, the owner's "Cerca i dettagli in rete" switch, the memory card row, the quality labels, and a page
// older than the app (its new version waits for the way in, a code, an add, typing, a tap). Every
// screenshot also checks that no flex container has a gap (the Mi A2's WebView has none) and
// saves the boxes of what may differ from an older UI (shot-diff.mjs compares two runs).
// Usage: node web/dev/ui-smoke.mjs <out dir>   (writes <out dir>/ui-smoke.log and ui-*.png)
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(process.argv[2]);
const BROWSER = process.env.MPFY_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.join(outDir, 'ui-smoke-profile');
const out = [];
const log = (...a) => {
  out.push(a.join(' '));
};
let fails = 0;
const check = (cond, label) => {
  log(`${cond ? 'PASS' : 'FAIL'} ${label}`);
  if (!cond) fails++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(profile, { recursive: true, force: true });
fs.mkdirSync(profile, { recursive: true });

// ---- mock ----
const mock = spawn(process.execPath, [path.join(HERE, 'mock-server.mjs')], {
  env: { ...process.env, MOCK_PORT: '0', MOCK_DELAY: '20', MOCK_OFFLINE_WAIT: '400', MOCK_PAIR_DELAY: '300' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const port = await new Promise((resolve, reject) => {
  let buf = '';
  setTimeout(() => reject(new Error('mock did not start')), 15000);
  mock.stdout.on('data', (d) => {
    buf += d;
    const m = /MOCK_PORT=(\d+)/.exec(buf);
    if (m) resolve(Number(m[1]));
  });
});
const base = `http://127.0.0.1:${port}`;
log(`mock on ${base}`);

// ---- browser ----
const browser = spawn(
  BROWSER,
  ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--disable-sync', '--disable-component-update', '--mute-audio', '--autoplay-policy=no-user-gesture-required', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: 'ignore' }
);
let wsUrl = null;
for (let i = 0; i < 100 && !wsUrl; i++) {
  await sleep(200);
  try {
    const [p] = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n');
    const v = await (await fetch(`http://127.0.0.1:${p}/json/version`)).json();
    wsUrl = v.webSocketDebuggerUrl;
    log(`browser: ${v.Browser}`);
  } catch {
    /* not up yet */
  }
}
if (!wsUrl) throw new Error('browser did not start');

const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pending = new Map();
const consoleErrors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(`${m.error.message}`));
    else resolve(m.result);
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(`exception: ${m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text}`);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push(`console.error: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') consoleErrors.push(`log: ${m.params.entry.text} ${m.params.entry.url || ''}`);
});
const cdp = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
const S = (method, params) => cdp(method, params, sessionId);
await S('Runtime.enable');
await S('Log.enable');
await S('Page.enable');

async function evaluate(expr) {
  const r = await S('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`eval: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  return r.result.value;
}
/** Navigates, waits until the app drew a view (the mock may be busy drawing covers), then wait ms. */
async function go(url, wait = 1500) {
  await S('Page.navigate', { url });
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    try {
      const r = await S('Runtime.evaluate', { expression: "!!document.querySelector('#main > .view')", returnByValue: true });
      if (r.result?.value) break;
    } catch {
      /* the page is still loading */
    }
  }
  await sleep(wait);
}
// Next to each screenshot, the boxes of what may rightly differ from an older UI: the update
// button, the details switch and the quality labels (changed), and text that follows the clock or
// the run (time: times and progress, a profile code made fresh in each run). The comparison of two
// runs (shot-diff.mjs) reads them.
const MARKED = {
  changed: ['.update-btn', '.details-switch', '.menu-info-line', '.avatar-btn', '.person-avatar', '.photo-head', '.social-section', '.lib-avatar', '.meta-owner', '.friends-side'],
  time: ['.home-top h1', '.seek-times', '.seek-row .time', '.mini-progress', '.up-state', '.up-bar', '.progress-label', '.progress-bar', '.toast', '.code-big-profile'],
};
/**
 * A screenshot of the screen as it is, and the checks every screen gets: no flex container with
 * a gap (the Mi A2's WebView, Chrome 81, has no flex gap: every layout spaces with margins).
 */
async function shot(name) {
  const { data } = await S('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDir, `ui-${name}.png`), Buffer.from(data, 'base64'));
  const info = await evaluate(`
    const gaps = [];
    for (const e of document.querySelectorAll('*')) {
      const cs = getComputedStyle(e);
      if (cs.display !== 'flex' && cs.display !== 'inline-flex') continue;
      const bad = [cs.rowGap, cs.columnGap].filter((g) => g !== 'normal' && g !== '0px');
      if (bad.length) gaps.push((typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\\s+/).join('.') : e.tagName.toLowerCase()) + ' ' + bad.join('/'));
    }
    const boxes = (sels) => sels.flatMap((s) => [...document.querySelectorAll(s)]).map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth).map((r) => [Math.floor(r.left), Math.floor(r.top), Math.ceil(r.right), Math.ceil(r.bottom)]);
    return { gaps: [...new Set(gaps)], boxes: { changed: boxes(${JSON.stringify(MARKED.changed)}), time: boxes(${JSON.stringify(MARKED.time)}) } };`);
  check(info.gaps.length === 0, `${name}: no flex container with a row-gap or column-gap${info.gaps.length ? ` (${info.gaps.slice(0, 6).join(', ')})` : ''}`);
  fs.writeFileSync(path.join(outDir, `ui-${name}.boxes.json`), JSON.stringify(info.boxes));
}
const noOverflow = () =>
  evaluate(`const m = document.getElementById('main'); return { doc: document.documentElement.scrollWidth, vw: innerWidth, main: m.scrollWidth, mainW: m.clientWidth };`);
async function overflowCheck(label) {
  const o = await noOverflow();
  check(o.doc <= o.vw && o.main <= o.mainW + 1, `${label}: no horizontal overflow (doc ${o.doc}/${o.vw}, main ${o.main}/${o.mainW})`);
}
/**
 * No scroll bars: on a phone none anywhere; on a PC with a mouse only the page and the side column
 * keep their thin one. Every scroll container is looked at (its style and the room a bar takes).
 */
async function barsCheck(label, mobile) {
  const r = await evaluate(`const out = { scrollers: 0, wrong: [] };
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if (!/(auto|scroll)/.test(cs.overflowX + ' ' + cs.overflowY)) continue;
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height || cs.display === 'none' || cs.visibility === 'hidden') continue;
      out.scrollers++;
      const kept = ${mobile ? 'false' : "el.matches('.main, .side-scroll')"};
      const room = el.offsetWidth - el.clientWidth - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth) + el.offsetHeight - el.clientHeight - parseFloat(cs.borderTopWidth) - parseFloat(cs.borderBottomWidth);
      const name = (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).join('.') : el.tagName);
      if (kept ? cs.scrollbarWidth !== 'thin' : cs.scrollbarWidth !== 'none' || room > 0) out.wrong.push(name + ' ' + cs.scrollbarWidth + ' ' + room);
    }
    return out;`);
  check(r.scrollers > 0 && r.wrong.length === 0, `${label}: ${mobile ? 'no scroll bar anywhere' : 'a thin bar only on the page and the side column'} (${r.scrollers} scrollers${r.wrong.length ? ', wrong: ' + r.wrong.join(', ') : ''})`);
}
const click = (sel, text) =>
  evaluate(`const els = [...document.querySelectorAll(${JSON.stringify(sel)})]; const el = ${text ? `els.find((e) => e.textContent.includes(${JSON.stringify(text)}))` : 'els[0]'}; if (!el) return false; el.click(); return true;`);
const text = (sel) => evaluate(`return [...document.querySelectorAll(${JSON.stringify(sel)})].map((e) => e.textContent.trim()).join(' | ');`);
/** Visible interactive elements smaller than 40 px in both directions (touch targets). */
const smallTargets = () =>
  evaluate(`return [...document.querySelectorAll('button, a[href], input, textarea, [role=radio]')].filter((e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth && (r.width < 40 && r.height < 40); }).map((e) => (e.className || e.tagName) + ' ' + Math.round(e.getBoundingClientRect().width) + 'x' + Math.round(e.getBoundingClientRect().height)).slice(0, 12);`);

const state = await (await fetch(`${base}/__mock/state`)).json();
const vps = state.servers.find((s) => s.name === 'VPS prova');
const mi = state.servers.find((s) => s.name === 'Mi A2');

async function run(vp) {
  const mobile = vp.width < 900;
  const tag = `${vp.width}x${vp.height}`;
  log(`\n== ${tag}`);
  await fetch(`${base}/__mock/reset?sources=2`);
  await freshHistory();
  await S('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile });
  await S('Emulation.setTouchEmulationEnabled', { enabled: mobile });
  await go(`${base}/?nosw`, 2500);
  // A previous run's page state (localStorage of this profile) is fine: the mock was reset.
  check((await evaluate('return document.title;')) === 'MPfy', `${tag} title MPfy`);
  check((await evaluate(`return getComputedStyle(document.documentElement).getPropertyValue('--speckle').trim().startsWith('url("data:image/png');`)) === true, `${tag} speckle tile drawn and set as --speckle`);
  check((await evaluate(`return getComputedStyle(document.body).backgroundImage.startsWith('url("data:image/png');`)) === true, `${tag} speckle tiled on the body background`);
  const tiles = await evaluate(`return document.querySelectorAll('.tile').length;`);
  check(tiles === 6, `${tag} home: ${tiles} quick tiles (union of both sources)`);
  const homeTop = await evaluate(`const b = document.querySelector('.home-top .avatar-btn'); return { photo: b ? b.getAttribute('aria-label') + '|' + b.title : null, gear: !!document.querySelector('.home-top .ic-settings') };`);
  // The sample holds unread messages: the picture says so (its title stays).
  check(homeTop.photo === 'Amici e impostazioni, messaggi non letti|Amici e impostazioni' && !homeTop.gear, `${tag} home: your picture "Amici e impostazioni" at the end of the top bar, with the unread messages, no gear (${JSON.stringify(homeTop)})`);
  await overflowCheck(`${tag} home`);
  await barsCheck(`${tag} home`, mobile);
  await shot(`${tag}-home`);

  if (mobile) {
    // A malformed percent sequence in the address: Home with the library, not a dead start.
    await go(`${base}/album/%E0%A4%A?nosw`, 2500);
    const bad = await evaluate(`return { tiles: document.querySelectorAll('.tile').length, tracks: mpfy.store.lib.tracks.length };`);
    check(bad.tiles === 6 && bad.tracks > 0, `${tag} a malformed address (/album/%E0%A4%A): Home with the library (${JSON.stringify(bad)})`);

    // Editing a playlist that holds tracks of a source not paired here (the VPS): they are kept.
    await fetch(`${base}/__mock/reset?sources=1`);
    await go(`${base}/?nosw`, 2000);
    const pl = await evaluate(`const p = mpfy.store.lib.playlists.find((x) => x.name === 'Viaggio in macchina'); return { id: p.id, ids: p.trackIds, hidden: p.trackIds.filter((t) => !mpfy.store.track(t)) };`);
    await go(`${base}/playlist/${pl.id}?nosw`, 1500);
    await click('.actions-left .icon-btn');
    await sleep(600);
    await click('.layer-sheet .menu-item', 'Modifica playlist');
    await sleep(700);
    const removed = await evaluate(`return document.querySelector('.edit-row .tr-title-text')?.textContent || '';`);
    await click('.edit-row .edit-remove');
    await sleep(200);
    await click('.topbar-edit .btn-primary');
    await sleep(1500);
    const lib = await (await fetch(`${base}/s/${mi.id}/api/library`)).json();
    const after = lib.playlists.find((x) => x.id === pl.id).trackIds;
    const firstShown = pl.ids.find((t) => !pl.hidden.includes(t));
    const expected = pl.ids.filter((t, i) => i !== pl.ids.indexOf(firstShown));
    check(pl.hidden.length > 0 && removed && after.join(',') === expected.join(','), `${tag} playlist edit with ${pl.hidden.length} tracks of an unpaired source: removing "${removed}" keeps them all, in place (${pl.ids.length} -> ${after.length})`);
    await fetch(`${base}/__mock/reset?sources=2`);
    await go(`${base}/?nosw`, 2000);
  }

  // settings
  await go(`${base}/impostazioni?nosw`, 1500);
  const st = await text('.set-section-title');
  check(st === 'Fonti musicali | Social | Qualità audio | Memoria | Informazioni', `${tag} settings sections: ${st}`);
  const person = await text('.person-card .person-name, .person-card .set-sub, .person-card .person-edit');
  const initial = await text('.person-card .avatar-initial');
  check(person === 'Bacca | Profilo | Modifica' && initial === 'B' && (await text('.person .set-title-text')) === 'Collega un altro dispositivo', `${tag} settings top: the letter, the name with "Modifica", then "Collega un altro dispositivo" (${initial}, ${person})`);
  const srcRows = await text('.set-section:nth-of-type(2) .set-row');
  check(/Mi A2Principale/.test(srcRows) && /VPS prova/.test(srcRows) && /liberi/.test(srcRows) && /Aggiungi fonte/.test(srcRows) && !/Connessa/.test(srcRows), `${tag} settings sources: ${srcRows}`);
  const dotsOf = () => evaluate(`return [...document.querySelectorAll('.set-section:nth-of-type(2) .src-dot')].map((d) => d.getAttribute('aria-label') + ':' + getComputedStyle(d).backgroundColor).join(', ');`);
  const dots = await dotsOf();
  check(dots === 'connessa:rgb(91, 156, 246), connessa:rgb(91, 156, 246)', `${tag} state dots before the names: ${dots}`);
  const author = await evaluate(`return [...document.querySelectorAll('a.author-link')].map((a) => [a.textContent, a.getAttribute('href'), a.target, a.rel].join(' '));`);
  check(author.length === 1 && author[0] === 'By Baccarancia https://baccarancia.com _blank noopener noreferrer' && !!(await evaluate(`return document.querySelector('.set-foot a.author-link') !== null;`)), `${tag} By Baccarancia once, at the bottom: ${JSON.stringify(author)}`);
  const infoRows = await evaluate(`return [...document.querySelectorAll('.set-section:last-of-type .set-row')].map((r) => r.textContent);`);
  check(infoRows.length === 2 && /^MPfyVersione \d+\.\d+\.\d+$/.test(infoRows[0]) && infoRows[1] === 'MessaggiCifrati, le fonti vedono chi scrive a chi e quando, non cosa.', `${tag} settings: the app version under Informazioni, then "Messaggi" and what the sources see: ${JSON.stringify(infoRows)}`);
  await overflowCheck(`${tag} settings`);
  await shot(`${tag}-settings`);
  log(`   small targets: ${JSON.stringify(await smallTargets())}`);

  await click('a.set-row', 'VPS prova');
  await sleep(1200);
  const srcActions = await text('.src-actions .set-title-text');
  check(srcActions === 'Imposta come principale | Mostra codice | Dispositivi collegati | Rimuovi fonte', `${tag} source page of a member: no "Rinomina fonte", no "Cambia codice" (${srcActions})`);
  check((await text('.src-actions .set-sub')).startsWith('Playlist e Mi piace su questa fonte | Per aggiungere questa fonte'), `${tag} "Mostra codice": "Per aggiungere questa fonte"`);
  const srcState = await text('.src-state');
  check(srcState === 'Connessa' && (await evaluate(`return !!document.querySelector('.src-state-row .src-dot.up');`)), `${tag} source page state: blue dot and "${srcState}"`);
  await overflowCheck(`${tag} source page`);
  await shot(`${tag}-source`);
  await click('button.set-row', 'Mostra codice');
  await sleep(900);
  const groups = await evaluate(`return document.querySelectorAll('.code-big-group').length;`);
  check(groups === 8, `${tag} Mostra codice: 8 groups of 4 (${await text('.code-big')})`);
  check((await text('.code-dialog .dialog-text')) === 'Per aggiungere questa fonte.', `${tag} the code dialog says "Per aggiungere questa fonte."`);
  const dialogW = await evaluate(`const d = document.querySelector('.layer-dialog .dialog').getBoundingClientRect(); const g = document.querySelector('.code-big').getBoundingClientRect(); return { d: Math.round(d.width), g: Math.round(g.width), left: Math.round(g.left - d.left) };`);
  check(dialogW.g < dialogW.d, `${tag} the big code fits its dialog (${JSON.stringify(dialogW)})`);
  await shot(`${tag}-code`);
  await evaluate(`history.back(); return true;`);
  await sleep(700);
  await click('button.set-row', 'Dispositivi collegati');
  await sleep(1200);
  const devs = await text('.devices-list .set-row');
  check(/Questo dispositivo/.test(devs) && /REDMAGIC/.test(devs) && !/Giulia/.test(devs) && !(await evaluate(`return !!document.querySelector('.devices-head');`)), `${tag} Dispositivi collegati of a member: its own only, no headings (${devs})`);
  check((await evaluate(`return [...document.querySelectorAll('.devices-list .set-row')].filter((r) => r.querySelector('.btn')).length;`)) === 1, `${tag} "Rimuovi" on the other device only`);
  await shot(`${tag}-devices`);
  await evaluate(`history.back(); return true;`);
  await sleep(700);

  // principal switch with the progress dialog
  if (mobile) {
    await click('button.set-row', 'Imposta come principale');
    await sleep(700);
    await click('.layer-dialog .btn-primary');
    await sleep(2500);
    await shot(`${tag}-principal-done`);
    const st2 = await (await fetch(`${base}/__mock/state`)).json();
    const vpsNow = st2.servers.find((s) => s.name === 'VPS prova');
    // The VPS's own older "Mattine lente" (other tracks) is a different playlist as far as anyone
    // can tell: it stays as it was, next to the copy (a name alone never decides, see store.js).
    const vlib = await (await fetch(`${base}/s/${vps.id}/api/library`)).json();
    const ml = vlib.playlists.filter((x) => x.name === 'Mattine lente');
    const mlOld = ml.find((x) => x.description === 'Versione vecchia sul VPS');
    const viaggio = vpsNow.playlistData.find((x) => x.name === 'Viaggio in macchina');
    const viaggioMi = st2.servers.find((x) => x.name === 'Mi A2').playlistData.find((x) => x.name === 'Viaggio in macchina');
    check(st2.paired.find((p) => p.id === vps.id).principal && !!viaggio && viaggio.id === viaggioMi?.id && ml.length === 2 && mlOld?.trackIds.length === 2, `${tag} principal switch: VPS principal, playlists copied under their own ids, its own "Mattine lente" untouched: ${vpsNow.playlists.join(', ')}`);
    check(vpsNow.likes >= 12, `${tag} principal switch: likes copied (${vpsNow.likes} on the VPS)`);
    await fetch(`${base}/__mock/reset?sources=2`);
    await evaluate(`await mpfy.sources.refresh(); await mpfy.store.refresh(); return true;`);
  }

  // quality page
  await go(`${base}/impostazioni/qualita?nosw`, 1200);
  check((await evaluate(`return document.querySelectorAll('.radio-row').length;`)) === 15, `${tag} quality page: 3 x 5 choices`);
  await evaluate(`document.querySelectorAll('[role=radiogroup]')[1].querySelectorAll('.radio-row')[1].click(); return true;`);
  check((await evaluate(`return JSON.parse(localStorage.getItem('mpfy.quality.v1')).cellular;`)) === 'low', `${tag} picking Bassa for mobile data is saved`);
  check((await text('[role=radiogroup] .radio-row.on .set-title-text')) === 'Automatica | Bassa | Max', `${tag} checked: ${await text('[role=radiogroup] .radio-row.on .set-title-text')}`);
  await overflowCheck(`${tag} quality page`);
  await shot(`${tag}-quality`);
  await evaluate(`mpfy.quality.set('cellular', 'auto'); return true;`);

  // an album on both sources: menus
  const albumId = await evaluate(`return [...mpfy.store.d.albums.values()].find((a) => a.name === 'Frequenze').id;`);
  await go(`${base}/album/${albumId}?nosw`, 1500);
  await click('.actions-left .icon-btn');
  await sleep(600);
  check(/Cambia copertina/.test(await text('.layer-sheet .menu-item')), `${tag} album menu has Cambia copertina`);
  await shot(`${tag}-album-menu`);
  await evaluate(`history.back(); return true;`);
  await sleep(600);
  await click('.track-row .tr-more');
  await sleep(600);
  const tm = await text('.layer-sheet .menu-item, .layer-sheet .menu-info');
  check(/Modifica informazioni/.test(tm) && /Cambia copertina/.test(tm) && /Disponibile su:Mi A2: WAVVPS prova: WAV/.test(tm) && /Elimina da Mi A2/.test(tm) && /Elimina da VPS prova/.test(tm), `${tag} track menu: one line per version, "Elimina da" where allowed: ${tm}`);
  await overflowCheck(`${tag} track menu`);
  await barsCheck(`${tag} track menu`, mobile);
  await shot(`${tag}-track-menu`);
  await evaluate(`history.back(); return true;`);
  await sleep(600);

  // play from the album, Now Playing with the quality chip
  await click('.track-row .tr-main');
  await sleep(2500);
  await click(mobile ? '.mini-main' : '.pb-cover-btn');
  await sleep(1200);
  const chip = await text('.np .q-chip');
  const npSrc = await text('.np .np-src');
  check(['MAX', 'ALTA', 'NORMALE', 'BASSA'].includes(chip), `${tag} Now Playing quality chip: "${chip}" from "${npSrc}"`);
  check(npSrc === 'VPS prova', `${tag} a track on both sources plays from the lower RTT one (${npSrc})`);
  const npState = await evaluate(`return { q: mpfy.player.state.quality, src: mpfy.player.state.source };`);
  log(`   player state: ${JSON.stringify(npState)}`);
  await shot(`${tag}-now-playing`);
  await evaluate(`mpfy.player.pause(); history.back(); return true;`);
  await sleep(700);

  if (mobile) {
    // An image picked with the songs is offered as the album cover; accepted, it is cropped to a
    // square, resized to 640 and 160 px and uploaded to the principal; then reset.
    await evaluate(`
      const { uploads } = await import('/js/upload.js');
      const c = document.createElement('canvas');
      c.width = 400; c.height = 300;
      const g = c.getContext('2d');
      g.fillStyle = '#3060c0'; g.fillRect(0, 0, 400, 300); g.fillStyle = '#c03030'; g.fillRect(50, 0, 300, 300);
      const jpg = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
      const n = 4410, wav = new Uint8Array(44 + n), dv = new DataView(wav.buffer);
      const w = (o, s) => [...s].forEach((ch, i) => (wav[o + i] = ch.charCodeAt(0)));
      w(0, 'RIFF'); dv.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
      dv.setUint32(24, 11025, true); dv.setUint32(28, 22050, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n, true);
      for (let i = 0; i < n; i++) wav[44 + i] = (i * 7) & 255;
      uploads.add([new File([wav], 'Prova copertina.wav', { type: 'audio/wav' }), new File([jpg], 'cover.jpg', { type: 'image/jpeg' })]);
      return true;`);
    await sleep(1500);
    await evaluate(`await mpfy.navigate('/'); return true;`); // no reload: the jobs live in this page
    await sleep(800);
    await click('.home-top [aria-label="Carica brani"]');
    await sleep(900);
    const offer = await text('.up-offer');
    check(/cover\.jpg/.test(offer) && /Album sconosciuto/.test(offer), `${tag} cover offer after the batch: ${offer}`);
    await shot(`${tag}-cover-offer`);
    await click('.up-offer .btn-primary');
    await sleep(2500);
    const cov = await evaluate(`
      const id = [...mpfy.store.d.albums.values()].find((a) => a.name === 'Album sconosciuto')?.id;
      const c = mpfy.store.lib.covers.album[id];
      if (!c) return { id, c: null };
      const size = async (cid, s) => { const b = await (await fetch('/s/' + mpfy.store.principalId + '/api/cover/' + cid + '?size=' + s)).blob(); const bm = await createImageBitmap(b); return [b.type, bm.width, bm.height]; };
      return { id, c, large: await size(c.large, 'large'), small: await size(c.small, 'small'), offers: document.querySelectorAll('.up-offer').length };`);
    check(cov.c && cov.large.join() === 'image/jpeg,640,640' && cov.small.join() === 'image/jpeg,160,160' && cov.offers === 0, `${tag} accepted: custom album cover 640 and 160 px JPEG on the principal (${JSON.stringify(cov)})`);
    const hasReset = await evaluate(`return (await import('/components/cover-edit.js')).coverMenuItems('album', ${JSON.stringify(cov.id)}).map((x) => x.label).join(', ');`);
    check(hasReset === 'Cambia copertina, Ripristina copertina', `${tag} with a custom cover the menu offers: ${hasReset}`);
    await evaluate(`await (await import('/components/cover-edit.js')).resetCover('album', ${JSON.stringify(cov.id)}); return true;`);
    await sleep(500);
    check((await evaluate(`return !mpfy.store.lib.covers.album[${JSON.stringify(cov.id)}];`)) === true, `${tag} Ripristina copertina removes it`);
    await evaluate(`history.back(); return true;`);
    await sleep(600);
    // "Elimina da <fonte>": the uploaded track goes away from the Mi A2 only.
    const del = await evaluate(`
      const t = mpfy.store.lib.tracks.find((x) => x.title === 'Prova copertina');
      const ok = (await mpfy.store.deleteVersion(t.id, t.sources[0]))?.deleted;
      await mpfy.store.refresh();
      return { ok: !!ok, gone: !mpfy.store.track(t.id) };`);
    check(del.ok && del.gone, `${tag} Elimina da Mi A2 removes the uploaded track (${JSON.stringify(del)})`);
    await evaluate(`(await import('/js/upload.js')).uploads.clearFinished(); return true;`);
  }

  // upload sheet with "Carica su"
  await go(`${base}/?nosw`, 1500);
  await click('.home-top [aria-label="Carica brani"]');
  await sleep(900);
  const target = await text('.up-target-text');
  check(/Carica su/.test(target) && /Mi A2/.test(target), `${tag} upload sheet: ${target}`);
  await click('.up-target');
  await sleep(700);
  check(/VPS prova/.test(await text('.layer-sheet .menu-item')), `${tag} "Carica su" lists the sources`);
  await shot(`${tag}-upload-target`);
  await evaluate(`history.back(); return true;`);
  await sleep(500);
  await evaluate(`history.back(); return true;`);
  await sleep(500);

  // a source offline: its own tracks dimmed, the banner stays away while another is up
  await fetch(`${base}/__mock/offline?source=${vps.id}&on=1`);
  await evaluate(`await mpfy.sources.refresh(); return true;`);
  const vAlbum = await evaluate(`return [...mpfy.store.d.albums.values()].find((a) => a.name === 'Rotte').id;`);
  await go(`${base}/album/${vAlbum}?nosw`, 2000);
  const dim = await evaluate(`const r = [...document.querySelectorAll('.track-row')]; return { all: r.length, dim: r.filter((x) => x.classList.contains('is-unavailable')).length, banner: !document.getElementById('banner').hidden };`);
  check(dim.all === 5 && dim.dim === 5 && !dim.banner, `${tag} VPS offline: its album dimmed (${dim.dim}/${dim.all}), no banner`);
  const shared = await evaluate(`return [...mpfy.store.d.albums.values()].find((a) => a.name === 'Frequenze').id;`);
  await go(`${base}/album/${shared}?nosw`, 1500);
  check((await evaluate(`return document.querySelectorAll('.track-row.is-unavailable').length;`)) === 0, `${tag} VPS offline: an album also on the Mi A2 stays playable`);
  await fetch(`${base}/__mock/offline?on=1`);
  await evaluate(`await mpfy.sources.refresh(); return true;`);
  await sleep(300);
  const banner = await evaluate(`const b = document.getElementById('banner'); return b.hidden ? '' : b.textContent;`);
  check(banner === 'Nessuna fonte raggiungibile', `${tag} every source offline: banner "${banner}"`);
  await shot(`${tag}-offline`);
  await go(`${base}/impostazioni?nosw`, 1500);
  const grey = await dotsOf();
  check(grey === 'non raggiungibile:rgb(107, 107, 107), non raggiungibile:rgb(107, 107, 107)', `${tag} offline sources: grey dots (${grey})`);
  await shot(`${tag}-settings-offline`);
  await fetch(`${base}/__mock/offline?on=0`);
  await evaluate(`await mpfy.sources.refresh(); return true;`);
  // No network at all: "Sei offline".
  await S('Network.enable');
  await S('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await sleep(500);
  const offBanner = await evaluate(`const b = document.getElementById('banner'); return b.hidden ? '' : b.textContent;`);
  check(offBanner === 'Sei offline', `${tag} no network at all: banner "${offBanner}"`);
  await S('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await sleep(300);

  // first run: welcome, then the add screen from the #aggiungi= fragment
  await fetch(`${base}/__mock/reset?sources=0&profile=1`);
  await go(`${base}/?nosw`, 2000);
  check((await text('.welcome-title')) === 'Aggiungi la prima fonte', `${tag} a profile and no source: the first source step at once, never the Welcome ("${await text('.welcome-title')}")`);
  check((await evaluate(`return getComputedStyle(document.getElementById('bottom')).display === 'none' && getComputedStyle(document.getElementById('sidebar')).display === 'none';`)) === true, `${tag} welcome hides the navigation`);
  await overflowCheck(`${tag} welcome`);
  await shot(`${tag}-welcome`);
  await go(`${base}/?nosw#aggiungi=${encodeURIComponent(mi.code.toLowerCase().replace(/-/g, ' '))}`, 2000);
  const field = await evaluate(`const t = document.querySelector('.code-input'); return t ? t.value : null;`);
  check(field === mi.code.slice(5), `${tag} #aggiungi= fills the code in groups of 4: "${field}"`);
  check((await text('.as-count')) === 'Codice completo', `${tag} the code is complete`);
  check((await evaluate('return location.hash;')) === '', `${tag} the fragment is removed from the address`);
  await overflowCheck(`${tag} add source`);
  await shot(`${tag}-add-source`);
  // typing: a partial code formats as it grows
  const clearCode = `const t = document.querySelector('.code-input'); t.focus(); t.value = ''; t.dispatchEvent(new Event('input')); return true;`;
  const readCode = `const t = document.querySelector('.code-input'); return { v: t.value, caret: t.selectionStart, n: document.querySelector('.as-count').textContent, disabled: document.querySelector('.as-form .btn-primary').disabled };`;
  await evaluate(clearCode);
  await S('Input.insertText', { text: '7k3q9xwdab' });
  await sleep(200);
  const typed = await evaluate(readCode);
  check(typed.v === '7K3Q-9XWD-AB' && typed.caret === typed.v.length && typed.disabled, `${tag} typing "7k3q9xwdab" shows "${typed.v}" (caret ${typed.caret}, ${typed.n}, button disabled ${typed.disabled})`);
  // A code whose 32 characters start with MPFY (about 1 in a million) typed one key at a time
  // after the "MPFY-" shown before the field: nothing is cut.
  await evaluate(clearCode);
  for (const ch of 'mpfy7k3q9xwdab12cdefghjkmnpqrstv') await S('Input.insertText', { text: ch });
  await sleep(200);
  const rare = await evaluate(readCode);
  check(rare.v === 'MPFY-7K3Q-9XWD-AB12-CDEF-GHJK-MNPQ-RSTV' && rare.n === 'Codice completo' && !rare.disabled, `${tag} typing a code that starts with MPFY: "${rare.v}" (${rare.n})`);
  await evaluate(`const t = document.querySelector('.code-input'); t.value = ${JSON.stringify(mi.code)}; t.dispatchEvent(new Event('input')); return true;`);
  await click('.as-form .btn-primary');
  await sleep(2500);
  check((await evaluate(`return !document.querySelector('.welcome') && document.querySelectorAll('.tile').length > 0;`)) === true, `${tag} after adding the first source: Home with its music`);
  await shot(`${tag}-after-add`);
  await fetch(`${base}/__mock/reset?sources=2`);
}

/** The service worker installs the whole shell and caches covers by id, whichever source served them. */
async function swCheck() {
  log('\n== service worker');
  await fetch(`${base}/__mock/reset?sources=2`);
  await go(`${base}/`, 3000);
  await go(`${base}/`, 3000); // the second load is controlled by the worker
  const sw = await evaluate(`
    const keys = await caches.keys();
    const shell = keys.find((k) => k.startsWith('mpfy-shell-'));
    const files = shell ? (await (await caches.open(shell)).keys()).length : 0;
    const covers = keys.includes('mpfy-covers-v1') ? (await (await caches.open('mpfy-covers-v1')).keys()).map((r) => new URL(r.url).pathname + new URL(r.url).search) : [];
    return { controlled: !!navigator.serviceWorker.controller, keys, files, covers: covers.length, sample: covers[0] || '' };`);
  // As many as sw.js lists (check.mjs keeps that list equal to the files on disk).
  const listed = /const SHELL_FILES = \[([\s\S]*?)\];/.exec(fs.readFileSync(path.join(HERE, '..', 'sw.js'), 'utf8'))[1].match(/'[^']+'/g).length;
  check(sw.controlled && sw.files === listed && sw.keys.includes('mpfy-meta-v1'), `worker controls the page, shell cache holds ${sw.files} files of the ${listed} listed (${sw.keys.join(', ')})`);
  check(sw.covers > 0 && /^\/__mpfy\/cover\/[0-9a-f]{24}\?size=(small|large|xl)$/.test(sw.sample), `covers cached by id: ${sw.covers} entries, e.g. ${sw.sample}`);
  // A cover seen once comes from the cache even when every source is offline.
  await fetch(`${base}/__mock/offline?on=1`);
  const off = await evaluate(`
    const k = (await (await caches.open('mpfy-covers-v1')).keys())[0];
    const id = new URL(k.url).pathname.split('/').pop();
    const size = new URL(k.url).searchParams.get('size');
    const src = mpfy.sources.list[1].id;
    const r = await fetch('/s/' + src + '/api/cover/' + id + '?size=' + size);
    return { status: r.status, type: r.headers.get('content-type') };`);
  check(off.status === 200 && /^image\//.test(off.type), `offline, a cached cover from any source id: ${off.status} ${off.type}`);
  await fetch(`${base}/__mock/offline?on=0`);
  // The VPS offline and a cover of its own never cached by the worker (the large one of an album
  // only on the VPS): the page asks the worker's cache only (&cached=1), never the core (which
  // would hold a connection while it waits for the link), and draws it when the VPS comes back.
  // The cards of Home load the large ones too: they leave the worker's cache first.
  await evaluate(`const c = await caches.open('mpfy-covers-v1'); for (const k of await c.keys()) if (k.url.includes('size=large')) await c.delete(k); return true;`);
  await fetch(`${base}/__mock/offline?source=${vps.id}&on=1`);
  const rotte = await evaluate(`return [...mpfy.store.d.albums.values()].find((a) => a.name === 'Rotte').id;`);
  await go(`${base}/album/${rotte}`, 3000);
  const offl = await evaluate(`
    const reqs = performance.getEntriesByType('resource').filter((e) => e.name.includes('/s/${vps.id}/api/cover/'));
    return { plain: reqs.filter((e) => !e.name.includes('cached=1')).length, cached: reqs.filter((e) => e.name.includes('cached=1')).length, statuses: [...new Set(reqs.map((e) => e.responseStatus))], heroBroken: !!document.querySelector('.hero-cover.cover-broken') };`);
  check(offl.cached > 0 && offl.plain === 0 && offl.heroBroken, `VPS offline, a cover of its own not cached: only the worker's cache is asked, the placeholder shows (${JSON.stringify(offl)})`);
  await fetch(`${base}/__mock/offline?source=${vps.id}&on=0`);
  await evaluate(`await mpfy.sources.refresh(); return true;`);
  await sleep(2000);
  const back = await evaluate(`const img = document.querySelector('.hero-cover img'); return { broken: !!document.querySelector('.hero-cover.cover-broken'), w: img ? img.naturalWidth : 0, src: img ? img.getAttribute('src') : '' };`);
  check(!back.broken && back.w > 0 && !back.src.includes('cached=1'), `the VPS back: that cover is drawn again (${JSON.stringify(back)})`);
  // Memoria: the worker tells the size of its covers and drops them.
  const size = await evaluate(`const ch = new MessageChannel(); const p = new Promise((r) => (ch.port1.onmessage = (e) => r(e.data))); navigator.serviceWorker.controller.postMessage({ type: 'cover-cache-size' }, [ch.port2]); return await p;`);
  check(size.entries > 0 && size.bytes > 0, `the worker answers the covers cache size: ${JSON.stringify(size)}`);
  await go(`${base}/impostazioni`, 2500);
  const memSub = await text('.mem-cache .set-sub');
  check(/^\d+ (KB|MB)$/.test(memSub) && memSub !== '0 MB', `Memoria in a browser: "Svuota cache" with its size (${memSub})`);
  await click('.mem-cache');
  await sleep(1200);
  const after = await evaluate(`return { keys: (await caches.keys()).includes('mpfy-covers-v1') ? (await (await caches.open('mpfy-covers-v1')).keys()).length : 0, toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent).join('|'), sub: document.querySelector('.mem-cache .set-sub')?.textContent };`);
  check(after.keys === 0 && /Cache svuotata/.test(after.toast) && after.sub === '0 MB', `"Svuota cache": no dialog, the covers go, toast "Cache svuotata" (${JSON.stringify(after)})`);
  const nat = await evaluate(`const r = await fetch('/__native/file/abc'); return r.status;`);
  check(nat === 404, `/__native/ is never answered by the worker (the core answers 404): ${nat}`);
  await evaluate(`for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); return true;`);
}

// ---- helpers of the sections below ----
/** A key pressed on the page (Escape, Enter...), as a person would. */
async function press(key) {
  const codes = { Escape: 27, Enter: 13 };
  const typed = key === 'Enter' ? '\r' : undefined;
  await S('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: codes[key], nativeVirtualKeyCode: codes[key], ...(typed ? { text: typed, unmodifiedText: typed } : {}) });
  await S('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: codes[key], nativeVirtualKeyCode: codes[key] });
}
/** The system's back button. When it takes the page away (it should not) the check after it fails. */
async function systemBack() {
  try {
    await evaluate(`history.back(); return true;`);
  } catch {
    /* the page went away under the call */
  }
  await sleep(600);
}
/** Every toast shown from now on (only two stay on screen at once). */
const watchToasts = () =>
  evaluate(`window.__toasts = []; const root = document.getElementById('toasts'); window.__toastObs?.disconnect(); window.__toastObs = new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) window.__toasts.push(n.querySelector('.toast-text')?.textContent || n.textContent); }); window.__toastObs.observe(root, { childList: true }); return true;`);
const seenToasts = () => evaluate(`return window.__toasts || [];`);
/** The Mi A2's WebView (Chrome 81) knows no flex gap: every flex container loses its gap. */
const noFlexGap = () =>
  evaluate(`for (const e of document.querySelectorAll('*')) { const d = getComputedStyle(e).display; if (d === 'flex' || d === 'inline-flex') e.style.setProperty('gap', '0', 'important'); } return true;`);
/** The empty space between consecutive elements of a selector, vertical or horizontal. */
const spaces = (sel, axis = 'y') =>
  evaluate(`const r = [...document.querySelectorAll(${JSON.stringify(sel)})].map((e) => e.getBoundingClientRect()); return r.slice(1).map((b, i) => Math.round((${JSON.stringify(axis)} === 'y' ? b.top - r[i].bottom : b.left - r[i].right) * 10) / 10);`);
/** Two presses 180 ms apart on the middle of an element (a double tap). */
async function doubleTap(sel, textIn) {
  const at = await evaluate(`const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.textContent.includes(${JSON.stringify(textIn)})); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`);
  if (!at) return false;
  await sleep(150);
  const tap = async () => {
    await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 });
    await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 });
  };
  await tap();
  await sleep(180);
  await tap();
  return true;
}
const typeInto = (sel, value) => evaluate(`const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.focus(); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
const toastsNow = () => evaluate(`return [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | ');`);
const setFiles = async (sel, files) => {
  const { root } = await S('DOM.getDocument', { depth: -1, pierce: true });
  const { nodeId } = await S('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
  if (!nodeId) return false;
  await S('DOM.setFileInputFiles', { nodeId, files });
  return true;
};
const vpOf = (vp) => {
  const mobile = vp.width < 900;
  return { mobile, tag: `${vp.width}x${vp.height}` };
};
async function setViewport(vp) {
  const { mobile } = vpOf(vp);
  await S('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile });
  await S('Emulation.setTouchEmulationEnabled', { enabled: mobile });
  await freshHistory();
}
/**
 * Each part starts with a short history. This one tab lives through every part, and a browser
 * keeps at most 50 entries: once full, a new entry drops the oldest one pushed without a gesture
 * of the person, and the script's clicks are none, so a layer's own entry could go and its close
 * step back into an older page. A person's taps never make such entries.
 */
const freshHistory = () => S('Page.resetNavigationHistory').catch(() => {});

/** The way in: welcome, name, first source, "Ho già un profilo", "Recupera profilo". */
async function wayIn(vp) {
  const { mobile, tag } = vpOf(vp);
  log(`\n== ${tag} the way in`);
  await setViewport(vp);
  await fetch(`${base}/__mock/reset?sources=0&profile=0`);
  await go(`${base}/?nosw`, 2200);
  check((await text('.welcome-title')) === 'Benvenuto in MPfy' && (await text('.welcome-sub')) === 'La tua musica, ovunque.', `${tag} welcome: "Benvenuto in MPfy", "La tua musica, ovunque."`);
  check((await text('.welcome button')) === 'Inizia | Ho già un profilo | Recupera profilo', `${tag} welcome buttons: ${await text('.welcome button')}`);
  check((await evaluate(`return getComputedStyle(document.getElementById('bottom')).display === 'none' && getComputedStyle(document.getElementById('sidebar')).display === 'none';`)) === true, `${tag} welcome hides the navigation`);
  await overflowCheck(`${tag} welcome`);
  await shot(`${tag}-welcome`);

  // Inizia: the name, then the first source.
  await click('.welcome button', 'Inizia');
  await sleep(400);
  const nameStep = await evaluate(`return { t: document.querySelector('.welcome-title')?.textContent, ph: document.querySelector('.welcome input')?.placeholder, b: document.querySelector('.welcome .btn-primary')?.textContent, off: document.querySelector('.welcome .btn-primary')?.disabled };`);
  check(nameStep.t === 'Come ti chiami?' && nameStep.ph === 'Nome' && nameStep.b === 'Continua' && nameStep.off, `${tag} name step: "Come ti chiami?", placeholder "Nome", "Continua" (off while empty) ${JSON.stringify(nameStep)}`);
  await shot(`${tag}-name`);
  await typeInto('.welcome input', 'x'.repeat(41));
  await click('.welcome .btn-primary');
  await sleep(500);
  check((await text('.welcome-error')) === 'Nome non valido', `${tag} a name of 41 characters: "Nome non valido"`);
  await typeInto('.welcome input', 'Bacca');
  await click('.welcome .btn-primary');
  await sleep(1200);
  const first = await evaluate(`return { t: document.querySelector('.welcome-title')?.textContent, l: document.querySelector('.welcome-sub')?.textContent, heading: !!document.querySelector('.welcome .as-hero'), text: document.querySelector('.welcome').textContent };`);
  check(first.t === 'Aggiungi la prima fonte' && first.l === 'Ti serve il codice della fonte.' && !first.heading && !/Nome \(facoltativo\)/.test(first.text) && !/Il codice inizia con MPFY/.test(first.text), `${tag} first source: its title and line, the code form with no heading of its own, no name field, no MPFY line`);
  await shot(`${tag}-first-source`);
  const profileCode = (await (await fetch(`${base}/__mock/state`)).json()).profileCode;
  await typeInto('.code-input', profileCode);
  await sleep(200);
  check((await text('.welcome .as-error')) === 'Questo è il codice del profilo' && (await evaluate(`return document.querySelector('.welcome .as-form .btn-primary').disabled;`)), `${tag} a profile code in the source field: "Questo è il codice del profilo"`);
  await typeInto('.code-input', mi.code);
  await click('.welcome .as-form .btn-primary');
  await sleep(2600);
  check((await evaluate(`return !document.querySelector('.welcome') && document.querySelectorAll('.tile').length > 0;`)) === true, `${tag} after the first source: the library`);

  // A profile and no source: the first source at once, never the Welcome.
  await fetch(`${base}/__mock/reset?sources=0&profile=1`);
  await go(`${base}/?nosw`, 1500);
  check((await text('.welcome-title')) === 'Aggiungi la prima fonte' && !(await evaluate(`return !!document.querySelector('.welcome-logo');`)), `${tag} a profile with no source opens the first source step, never the Welcome`);

  // "Ho già un profilo": the profile code, then the first source.
  await fetch(`${base}/__mock/reset?sources=0&profile=0`);
  await go(`${base}/?nosw`, 2000);
  await click('.welcome button', 'Ho già un profilo');
  await sleep(400);
  const pc = await evaluate(`return { t: document.querySelector('.welcome-title')?.textContent, l: document.querySelector('.welcome-sub')?.textContent, label: document.querySelector('.welcome .field-label')?.textContent, ph: document.querySelector('.welcome input')?.placeholder, b: document.querySelector('.welcome .btn-primary')?.textContent };`);
  check(pc.t === 'Ho già un profilo' && pc.l === "Lo trovi sull'altro dispositivo, in Impostazioni." && pc.label === 'Codice del profilo' && pc.ph === 'MPFY-P-...' && pc.b === 'Continua', `${tag} profile code step: ${JSON.stringify(pc)}`);
  await shot(`${tag}-profile-code`);
  await typeInto('.welcome input', mi.code);
  await click('.welcome .btn-primary');
  await sleep(400);
  check((await text('.welcome-error')) === 'Questo è il codice di una fonte', `${tag} a source code there: "Questo è il codice di una fonte"`);
  const anyCode = (await (await fetch(`${base}/__mock/state`)).json()).anyProfileCode;
  await typeInto('.welcome input', anyCode.slice(0, -1) + (anyCode.endsWith('0') ? '1' : '0'));
  await click('.welcome .btn-primary');
  await sleep(700);
  check((await text('.welcome-error')) === 'Codice non valido', `${tag} a typo (the core says bad_code): "Codice non valido"`);
  await typeInto('.welcome input', anyCode.toLowerCase());
  await click('.welcome .btn-primary');
  await sleep(1200);
  check((await text('.welcome-title')) === 'Aggiungi la prima fonte', `${tag} the profile code taken: the first source next`);

  // "Recupera profilo": the three ways.
  await fetch(`${base}/__mock/reset?sources=0&profile=0`);
  await go(`${base}/?nosw`, 2000);
  log(`   history at "Recupera profilo": ${await evaluate('return history.length;')}`);
  await click('.welcome button', 'Recupera profilo');
  await sleep(400);
  check((await text('.welcome-title')) === 'Recupera profilo' && (await text('.welcome-option-label')) === 'Dal file del profilo | Con la password | Con il codice del profilo', `${tag} Recupera profilo: ${await text('.welcome-option-label')}`);
  await shot(`${tag}-recover`);
  await click('.welcome-option', 'Con il codice del profilo');
  await sleep(300);
  check((await text('.welcome-title')) === 'Ho già un profilo', `${tag} "Con il codice del profilo" is the "Ho già un profilo" screen`);
  await click('.welcome-back');
  await sleep(300);
  await click('.welcome-option', 'Con la password');
  await sleep(300);
  const pw1 = await evaluate(`return { t: document.querySelector('.welcome-title')?.textContent, l: document.querySelector('.welcome-sub')?.textContent, b: document.querySelector('.welcome .btn-primary')?.textContent };`);
  check(pw1.t === 'Con la password' && pw1.l === 'Il codice di una tua fonte.' && pw1.b === 'Continua', `${tag} password way, the code: ${JSON.stringify(pw1)}`);
  await typeInto('.code-input', 'MPFY-0000-0000-0000-0000-0000-0000-0000-0000');
  await click('.welcome .btn-primary');
  await sleep(100);
  const busy = await text('.welcome .btn-primary');
  await sleep(700);
  check(busy === 'Collegamento...' && (await text('.welcome .as-error')) === 'Fonte non raggiungibile', `${tag} while it connects "Collegamento...", then the core's unreachable: "Fonte non raggiungibile" (${busy})`);
  await typeInto('.code-input', mi.code);
  await click('.welcome .btn-primary');
  await sleep(700);
  const who = await evaluate(`return { t: document.querySelector('.welcome-title')?.textContent, rows: [...document.querySelectorAll('.welcome-option')].map((b) => b.textContent) };`);
  check(who.t === 'Chi sei?' && who.rows.includes('BaccaREDMAGIC 11 Pro') && who.rows.includes('BaccaPC di casa') && who.rows.includes('Giulia'), `${tag} "Chi sei?": a person with two devices shows the device under the name (${who.rows.join(', ')})`);
  await shot(`${tag}-who`);
  await click('.welcome-option', 'REDMAGIC');
  await sleep(300);
  check((await text('.welcome-title')) === 'Password' && (await text('.welcome .btn-primary')) === 'Recupera', `${tag} the password step: "Password", "Recupera"`);
  await typeInto('.welcome input', 'sbagliata');
  await click('.welcome .btn-primary');
  await sleep(120);
  const busy2 = await text('.welcome .btn-primary');
  await sleep(700);
  check(busy2 === 'Recupero...' && (await text('.welcome-error')) === 'Password errata', `${tag} "Recupero..." then "Password errata" (${busy2})`);
  await shot(`${tag}-wrong-password`);
  for (let i = 0; i < 4; i++) {
    await typeInto('.welcome input', `sbagliata ${i}`);
    await click('.welcome .btn-primary');
    await sleep(600);
  }
  check((await text('.welcome-error')) === 'Troppi tentativi, riprova più tardi', `${tag} the fifth wrong try: "Troppi tentativi, riprova più tardi"`);
  await fetch(`${base}/__mock/recovery?expire=1`);
  await typeInto('.welcome input', 'una frase breve');
  await click('.welcome .btn-primary');
  await sleep(700);
  check((await text('.welcome-title')) === 'Con la password' && /Tempo scaduto/.test(await toastsNow()), `${tag} the session gone: back to the code, toast "Tempo scaduto"`);
  await fetch(`${base}/__mock/reset?sources=0&profile=0`);
  await typeInto('.code-input', mi.code);
  await click('.welcome .btn-primary');
  await sleep(700);
  await click('.welcome-option', 'PC di casa');
  await sleep(300);
  await typeInto('.welcome input', 'una frase breve');
  await click('.welcome .btn-primary');
  await sleep(2200);
  const recovered = { toasts: await toastsNow(), state: await evaluate(`return { welcome: !!document.querySelector('.welcome'), title: (document.querySelector('.welcome-title') || {}).textContent || null, error: (document.querySelector('.welcome-error') || {}).textContent || null, name: mpfy.profile.name, path: location.pathname, hist: history.length, nav: (performance.getEntriesByType('navigation')[0] || {}).type || null, since: Math.round(performance.now()) };`) };
  check(/Profilo recuperato/.test(recovered.toasts) && !recovered.state.welcome && recovered.state.name === 'Bacca', `${tag} the right password: "Profilo recuperato", the library (${JSON.stringify(recovered)})`);

  // "Dal file del profilo" (a browser): the exported file brings the profile and its sources.
  const exp = await (await fetch(`${base}/local/profile/export`)).json();
  const fileOk = path.join(outDir, 'Bacca.mpfy');
  const fileBad = path.join(outDir, 'Rotto.mpfy');
  fs.writeFileSync(fileOk, `${JSON.stringify(exp.identity, null, 2)}\n`);
  fs.writeFileSync(fileBad, '{ "format": "altro" }\n');
  await fetch(`${base}/__mock/reset?sources=0&profile=0`);
  await go(`${base}/?nosw`, 2000);
  await click('.welcome button', 'Recupera profilo');
  await sleep(400);
  await setFiles('.welcome input[type=file]', [fileBad]);
  await sleep(800);
  check((await text('.welcome .as-error')) === 'File non valido', `${tag} a file that is not an identity: "File non valido"`);
  await setFiles('.welcome input[type=file]', [fileOk]);
  await sleep(2200);
  check(/Profilo recuperato/.test(await toastsNow()) && (await evaluate(`return !document.querySelector('.welcome') && mpfy.sources.list.length === 2;`)), `${tag} the profile file: "Profilo recuperato", its two sources`);

  // An install from before profiles: the name, full screen, with "Ho già un profilo".
  await fetch(`${base}/__mock/reset?sources=2&profile=0`);
  await go(`${base}/?nosw`, 2500);
  check((await text('.welcome-title')) === 'Come ti chiami?' && (await text('.welcome .welcome-link')) === 'Ho già un profilo', `${tag} sources and no profile: the name step, with "Ho già un profilo"`);
  await shot(`${tag}-upgraded`);
  await typeInto('.welcome input', 'Bacca');
  await click('.welcome .btn-primary');
  await sleep(1500);
  check((await evaluate(`return !document.querySelector('.welcome') && document.querySelectorAll('.tile').length > 0;`)) === true, `${tag} the name given: the library as it was`);

  // The naming step after "Aggiungi fonte", and after a first sync slower than the core waits.
  await fetch(`${base}/__mock/reset?sources=2`);
  await go(`${base}/impostazioni?nosw`, 2000);
  await click('button.set-row', 'Aggiungi fonte');
  await sleep(600);
  check((await text('.panel-add-source .as-hero h2')) === 'Collega una fonte' && !(await text('.panel-add-source')).includes('facoltativo'), `${tag} "Aggiungi fonte": the code form with its heading "Collega una fonte"`);
  await shot(`${tag}-add-source-panel`);
  await typeInto('.panel-add-source .code-input', 'MPFY-7K3Q-9XWD-ABCD-EFGH-JKMN-PQRS-TVWX-YZ12');
  await watchToasts();
  await click('.panel-add-source .btn-primary');
  await sleep(2500);
  const nm = await evaluate(`return { t: document.querySelector('.layer-dialog .dialog-title')?.textContent, v: document.querySelector('.layer-dialog input')?.value, b: document.querySelector('.layer-dialog .btn-primary')?.textContent };`);
  check(nm.t === 'Dai un nome a questa fonte' && /^Nuova fonte [0-9]+$/.test(nm.v) && nm.b === 'Salva', `${tag} after "Aggiungi fonte" of a source this person owns: "Dai un nome a questa fonte", prefilled (${JSON.stringify(nm)})`);
  await shot(`${tag}-name-source`);
  // A step to answer: Escape and a tap beside it leave it there.
  await press('Escape');
  await sleep(200);
  await evaluate(`document.querySelector('.layer-dialog:not(.closing) .backdrop')?.click(); return true;`);
  await sleep(400);
  check((await text('.layer-dialog:not(.closing) .dialog-title')) === 'Dai un nome a questa fonte', `${tag} "Dai un nome a questa fonte" stays on Escape and on a tap beside it`);
  await typeInto('.layer-dialog input', 'Casa di Marco');
  await click('.layer-dialog .btn-primary');
  await sleep(1500);
  check((await evaluate(`return mpfy.sources.list.some((s) => s.name === 'Casa di Marco' && s.named);`)) === true, `${tag} the source has its name`);
  const added = await seenToasts();
  check(added.includes('Casa di Marco aggiunta') && !added.some((x) => /^Nuova fonte [0-9]+ aggiunta$/.test(x)), `${tag} the toast says the name it got, after the naming step, never the name it had before (${added.join(' | ')})`);
  await fetch(`${base}/__mock/core?roleDelay=3500`);
  await click('button.set-row', 'Aggiungi fonte');
  await sleep(600);
  await typeInto('.panel-add-source .code-input', 'MPFY-8K3Q-9XWD-ABCD-EFGH-JKMN-PQRS-TVWX-YZ12');
  await click('.panel-add-source .btn-primary');
  await sleep(1800);
  const early = await evaluate(`return !!document.querySelector('.layer-dialog .dialog-title');`);
  await sleep(4000);
  check(!early && (await text('.layer-dialog .dialog-title')) === 'Dai un nome a questa fonte', `${tag} role still unknown after the add: asked every second, the naming step once it is known`);
  await evaluate(`history.back(); return true;`);
  await sleep(500);
  await fetch(`${base}/__mock/core?roleDelay=0`);
}

/**
 * Walking the way in: the back button of the system goes one step back (never out of the page),
 * the focus lands on each step, the back arrow sits in one place, spacing holds without flex gap,
 * a source link waits for the name of an install from before profiles, a profile nobody knows is
 * asked its name (and asked again at the next start when the question was left).
 */
async function wayBack(vp) {
  const { mobile, tag } = vpOf(vp);
  log(`\n== ${tag} the way in, step by step`);
  await setViewport(vp);
  await fetch(`${base}/__mock/reset?sources=0&profile=0`);
  await go(`${base}/?nosw`, 2200);
  const where = () => evaluate(`return { t: document.querySelector('.welcome-title')?.textContent, url: location.href, focus: document.activeElement === document.querySelector('.welcome-title') };`).catch(() => ({ t: null, url: 'gone', focus: false }));
  const arrowTop = () => evaluate(`const b = document.querySelector('.welcome-back'); return b ? Math.round(b.getBoundingClientRect().top) : null;`);
  const tops = [];
  check(JSON.stringify(await spaces('.welcome-actions > *')) === '[10,10]', `${tag} the welcome buttons 10 px apart (${JSON.stringify(await spaces('.welcome-actions > *'))})`);
  await noFlexGap();
  const g1 = await spaces('.welcome-actions > *');
  check(g1.length === 2 && g1.every((x) => x >= 8), `${tag} without flex gap (the Mi A2's WebView) the three welcome buttons still do not touch (${JSON.stringify(g1)})`);
  await click('.welcome button', 'Inizia');
  await sleep(500);
  tops.push(await arrowTop());
  await systemBack();
  let w = await where();
  check(w.t === 'Benvenuto in MPfy' && w.url.startsWith(base), `${tag} the back button on "Come ti chiami?": the Welcome again, inside the page (${JSON.stringify(w)})`);
  await click('.welcome button', 'Recupera profilo');
  await sleep(500);
  w = await where();
  check(w.t === 'Recupera profilo' && w.focus, `${tag} "Recupera profilo": the focus on its title (${JSON.stringify(w)})`);
  tops.push(await arrowTop());
  check(JSON.stringify(await spaces('.welcome-option')) === '[8,8]', `${tag} the three ways 8 px apart`);
  await noFlexGap();
  const g2 = await spaces('.welcome-option');
  const g3 = await spaces('.welcome-option:first-child > *', 'x');
  check(g2.every((x) => x >= 6) && g3.every((x) => x >= 10), `${tag} without flex gap the three ways and their icon and words still do not touch (${JSON.stringify(g2)} ${JSON.stringify(g3)})`);
  await click('.welcome-option', 'Con la password');
  await sleep(500);
  tops.push(await arrowTop());
  await systemBack();
  w = await where();
  check(w.t === 'Recupera profilo' && w.focus, `${tag} the back button on "Con la password": "Recupera profilo", its title focused (${JSON.stringify(w)})`);
  await press('Escape');
  await sleep(600);
  w = await where();
  check(w.t === 'Benvenuto in MPfy' && w.url.startsWith(base), `${tag} Escape (or back once more): the Welcome, still inside the page (${JSON.stringify(w)})`);
  await click('.welcome button', 'Ho già un profilo');
  await sleep(500);
  tops.push(await arrowTop());
  check(tops.every((x) => x !== null && x === tops[0]) && tops[0] <= 16, `${tag} the back arrow in the same top corner on every step (${JSON.stringify(tops)})`);
  await click('.welcome-back');
  await sleep(600);

  // Inizia, the name, Enter: the first source step is drawn once.
  await click('.welcome button', 'Inizia');
  await sleep(500);
  await evaluate(`window.__firsts = 0; new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.textContent === 'Aggiungi la prima fonte') window.__firsts++; }).observe(document.querySelector('.welcome'), { childList: true }); return true;`);
  await typeInto('.welcome input', 'Bacca');
  await press('Enter');
  await sleep(1500);
  const firsts = await evaluate(`return window.__firsts;`);
  check((await text('.welcome-title')) === 'Aggiungi la prima fonte' && firsts === 1, `${tag} the name given: "Aggiungi la prima fonte" drawn once (${firsts})`);
  check((await evaluate(`return !document.querySelector('.welcome-back');`)) === true, `${tag} the first source after the name: no way back to the Welcome (the profile is made)`);

  // A source link on an install from before profiles: the name first, then the code is there.
  await fetch(`${base}/__mock/reset?sources=2&profile=0`);
  const link = 'MPFY-9K3Q-9XWD-ABCD-EFGH-JKMN-PQRS-TVWX-YZ12';
  await go(`${base}/?nosw&from=link#aggiungi=${encodeURIComponent(link)}`, 2500);
  check((await text('.welcome-title')) === 'Come ti chiami?', `${tag} a source link on an install from before profiles: the name first`);
  await typeInto('.welcome input', 'Bacca');
  await click('.welcome .btn-primary');
  await sleep(2200);
  const filled = await evaluate(`const i = document.querySelector('.panel-add-source .code-input'); return i ? i.value : null;`);
  check(typeof filled === 'string' && filled.replace(/[^0-9A-Z]/gi, '').toUpperCase().endsWith('9K3Q9XWDABCDEFGHJKMNPQRSTVWXYZ12'), `${tag} then "Aggiungi fonte" opens with the link's code (${filled})`);
  await systemBack();

  // The link arriving while that name step is already up (the app opened again with a code).
  await fetch(`${base}/__mock/reset?sources=2&profile=0`);
  await go(`${base}/?nosw&from=late`, 2500);
  await evaluate(`location.hash = '#aggiungi=' + encodeURIComponent(${JSON.stringify(link)}); return true;`);
  await sleep(500);
  await typeInto('.welcome input', 'Bacca');
  await click('.welcome .btn-primary');
  await sleep(2200);
  const late = await evaluate(`const i = document.querySelector('.panel-add-source .code-input'); return i ? i.value : null;`);
  check(typeof late === 'string' && late.replace(/[^0-9A-Z]/gi, '').toUpperCase().endsWith('9K3Q9XWDABCDEFGHJKMNPQRSTVWXYZ12'), `${tag} a link while the name step is up: after the name, "Aggiungi fonte" with its code (${late})`);
  await systemBack();

  // The same link, and "Ho già un profilo" instead of the name: its step closes with the way in
  // while "Aggiungi fonte" opens; the panel stays, and the back button closes it, in the page.
  await fetch(`${base}/__mock/reset?sources=2&profile=0`);
  const known = (await (await fetch(`${base}/__mock/state`)).json()).anyProfileCode;
  await go(`${base}/?nosw&from=link2#aggiungi=${encodeURIComponent(link)}`, 2500);
  const h0 = await evaluate(`return history.length;`);
  await click('.welcome .welcome-link', 'Ho già un profilo');
  await sleep(500);
  await typeInto('.welcome input', known);
  await click('.welcome .btn-primary');
  await sleep(2500);
  const p1 = await evaluate(`return { panel: !!document.querySelector('.panel-add-source:not([aria-hidden])') && !document.querySelector('.layer-panel.closing'), code: document.querySelector('.panel-add-source .code-input')?.value || '', ov: history.state?.ov || 0, len: history.length };`);
  await systemBack();
  await sleep(200);
  const p2 = await evaluate(`return { panel: !!document.querySelector('.layer-panel:not(.closing)'), url: location.href, welcome: !!document.querySelector('.welcome'), ov: history.state?.ov || 0 };`);
  check(p1.panel && p1.code.replace(/[^0-9A-Z]/gi, '').toUpperCase().endsWith('9K3Q9XWDABCDEFGHJKMNPQRSTVWXYZ12') && p1.ov === 1 && !p2.panel && !p2.welcome && p2.url.startsWith(base) && p2.ov === 0, `${tag} the way in closing under a panel that opens: the panel stays, on its own history entry, and Back closes it (${JSON.stringify(p1)} ${JSON.stringify(p2)}, history ${h0})`);

  // "Ho già un profilo" there, with a profile no source knows: the name is asked once the app
  // shows; a tap beside it or Escape leave it there; left with the back button, it comes back at
  // the next start.
  await fetch(`${base}/__mock/reset?sources=2&profile=0`);
  const stranger = (await (await fetch(`${base}/__mock/state`)).json()).strangerProfileCode;
  await go(`${base}/?nosw`, 2500);
  await click('.welcome .welcome-link', 'Ho già un profilo');
  await sleep(500);
  await typeInto('.welcome input', stranger);
  await click('.welcome .btn-primary');
  await sleep(3000);
  check(!(await evaluate(`return !!document.querySelector('.welcome');`)) && (await text('.layer-dialog .dialog-title')) === 'Come ti chiami?', `${tag} "Ho già un profilo" on an install with sources, a profile no source knows: the library, and "Come ti chiami?"`);
  await press('Escape');
  await sleep(300);
  await sleep(400);
  await evaluate(`document.querySelector('.layer-dialog:not(.closing) .backdrop')?.click(); return true;`);
  await sleep(500);
  check((await text('.layer-dialog:not(.closing) .dialog-title')) === 'Come ti chiami?', `${tag} "Come ti chiami?" stays on Escape and on a tap beside it`);
  await systemBack();
  check(!(await evaluate(`return !!document.querySelector('.layer-dialog:not(.closing)');`)), `${tag} the back button still leaves it`);
  await go(`${base}/?nosw`, 4000);
  check((await text('.layer-dialog .dialog-title')) === 'Come ti chiami?', `${tag} with the name still empty, the next start asks it again`);
  await typeInto('.layer-dialog input', 'Giulia B');
  await click('.layer-dialog .btn-primary');
  await sleep(1200);
  check((await evaluate(`return mpfy.profile.name;`)) === 'Giulia B' && !(await evaluate(`return !!document.querySelector('.layer-dialog:not(.closing)');`)), `${tag} the name given, the question gone`);
  if (mobile) await shot(`${tag}-name-asked`);
}

/** The person's pages and the password recovery. */
async function profilePages(vp) {
  const { tag } = vpOf(vp);
  log(`\n== ${tag} profile`);
  await setViewport(vp);
  await cdp('Browser.grantPermissions', { origin: base, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
  await fetch(`${base}/__mock/reset?sources=2`);
  await go(`${base}/impostazioni?nosw`, 2000);
  await noFlexGap();
  const cardGaps = [...(await spaces('.person-card > *', 'x')), ...(await spaces('.person-main > *', 'x'))];
  check(cardGaps.length === 2 && cardGaps.every((x) => x >= 10), `${tag} without flex gap the name card keeps its spacing (${JSON.stringify(cardGaps)})`);
  await click('.person-edit');
  await sleep(800);
  check((await evaluate(`return location.pathname;`)) === '/impostazioni/profilo', `${tag} "Modifica" opens the person's page, like a tap on the card`);
  await click('button.set-row', 'Nome');
  await sleep(500);
  check((await text('.layer-dialog .dialog-title')) === 'Il tuo nome' && (await text('.layer-dialog .btn')) === 'Annulla | Salva', `${tag} "Nome": "Il tuo nome" with "Salva" / "Annulla"`);
  await typeInto('.layer-dialog input', 'Bacca B');
  await click('.layer-dialog .btn-primary');
  await sleep(1000);
  await go(`${base}/impostazioni?nosw`, 1500);
  check((await text('.person-name')) === 'Bacca B', `${tag} the new name on top`);
  if (vpOf(vp).mobile) {
    // A double tap on a row that opens a dialog: the second tap lands beside the new dialog and
    // must not close it; a tap beside it a moment later still does.
    await go(`${base}/impostazioni/profilo?nosw`, 1500);
    await doubleTap('button.set-row', 'Nome');
    await sleep(600);
    const stays = await text('.layer-dialog:not(.closing) .dialog-title');
    await evaluate(`document.querySelector('.layer-dialog:not(.closing) .backdrop')?.click(); return true;`);
    await sleep(500);
    const gone = !(await evaluate(`return !!document.querySelector('.layer-dialog:not(.closing)');`));
    check(stays === 'Il tuo nome' && gone, `${tag} a double tap on "Nome" leaves "Il tuo nome" open; a later tap beside it closes it (${stays}, ${gone})`);
  }
  // Renaming a source while another source answers slowly: the dialog closes as soon as the source
  // saved the name, the page shows it at once.
  await fetch(`${base}/__mock/core?syncMs=5000`);
  await go(`${base}/impostazioni/fonte/${mi.id}?nosw`, 1500);
  if (vpOf(vp).mobile) {
    await doubleTap('button.set-row', 'Rinomina fonte');
    await sleep(600);
    check((await text('.layer-dialog:not(.closing) .dialog-title')) === 'Rinomina fonte', `${tag} a double tap on "Rinomina fonte" leaves its dialog open`);
  } else {
    await click('button.set-row', 'Rinomina fonte');
    await sleep(500);
  }
  await watchToasts();
  await typeInto('.layer-dialog input', 'Mi A2 di casa');
  await click('.layer-dialog .btn-primary');
  await sleep(900);
  const renamedNow = await evaluate(`return { open: !!document.querySelector('.layer-dialog:not(.closing)'), name: document.querySelector('.src-name')?.firstChild?.textContent || '', title: document.querySelector('.set-top-title')?.textContent };`);
  check(!renamedNow.open && renamedNow.name === 'Mi A2 di casa' && renamedNow.title === 'Mi A2 di casa' && (await seenToasts()).includes('Fonte rinominata'), `${tag} "Rinomina fonte" with a slow source elsewhere: closed in under a second, the new name on the page (${JSON.stringify(renamedNow)})`);
  await sleep(5500);
  check((await evaluate(`return mpfy.sources.name(${JSON.stringify(mi.id)});`)) === 'Mi A2 di casa', `${tag} and it stays once the core's sync ended`);
  await fetch(`${base}/__mock/core?syncMs=0`);
  await go(`${base}/impostazioni/profilo?nosw`, 1500);
  const rows = await text('.set-title-text');
  check(rows === 'Nome | Codice del profilo | Esporta profilo | Recupero con password' && !(await evaluate(`return !!document.querySelector('.view .set-list .set-note');`)) && (await text('.set-top-title')) === 'Profilo', `${tag} Profilo: ${rows}`);
  check((await text('.set-row .set-sub')) === 'Bacca B | Disattivato', `${tag} Profilo subs: ${await text('.set-row .set-sub')}`);
  await overflowCheck(`${tag} profile`);
  await shot(`${tag}-profile`);
  const dl = path.join(outDir, `dl-${vp.width}`);
  fs.rmSync(dl, { recursive: true, force: true });
  fs.mkdirSync(dl, { recursive: true });
  await cdp('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl });
  await click('button.set-row', 'Esporta profilo');
  await sleep(1500);
  let exported = null;
  try {
    exported = JSON.parse(fs.readFileSync(path.join(dl, 'Bacca B.mpfy'), 'utf8'));
  } catch {
    /* not there */
  }
  check(exported?.format === 'mpfy-identity' && exported.profile.name === 'Bacca B', `${tag} "Esporta profilo" downloads <name>.mpfy (${fs.existsSync(dl) ? fs.readdirSync(dl).join(',') : 'none'})`);
  await click('a.set-row', 'Codice del profilo');
  await sleep(800);
  const link = await evaluate(`return { t: document.querySelector('.set-top-title')?.textContent, line: document.querySelector('.link-line')?.textContent, warn: document.querySelector('.warn')?.textContent, b: document.querySelector('.link-body .btn-primary')?.textContent, code: document.querySelectorAll('.code-big-group').length };`);
  check(link.t === 'Collega un altro dispositivo' && link.line === 'Sul nuovo dispositivo scegli "Ho già un profilo".' && link.warn === 'Solo per i tuoi dispositivi' && link.b === 'Mostra codice' && link.code === 0, `${tag} "Codice del profilo" opens "Collega un altro dispositivo", the code hidden: ${JSON.stringify(link)}`);
  await click('.link-body .btn-primary');
  await sleep(800);
  check((await evaluate(`return document.querySelectorAll('.code-big-group').length;`)) === 14, `${tag} "Mostra codice": MPFY-P and 14 groups of 4 (${await text('.code-big')})`);
  await click('.code-copy');
  await sleep(500);
  check(/Codice copiato/.test(await toastsNow()), `${tag} "Copia": "Codice copiato"`);
  await overflowCheck(`${tag} link a device`);
  await shot(`${tag}-link-device`);
  const centred = (sel) => evaluate(`const c = (e) => { const r = e.getBoundingClientRect(); return r.left + r.width / 2; }; return Math.round(Math.abs(c(document.querySelector(${JSON.stringify(sel)})) - c(document.querySelector('.set-top-title'))));`);
  const offLink = await centred('.link-body .link-icon');
  check(offLink <= 2, `${tag} "Collega un altro dispositivo": its icon, line and code centred under the title (${offLink} px off)`);
  await noFlexGap();
  const linkGaps = await spaces('.link-body > :not(:empty)');
  check(linkGaps.every((x) => x >= 12), `${tag} without flex gap the pieces of "Collega un altro dispositivo" keep their space (${JSON.stringify(linkGaps)})`);

  await go(`${base}/impostazioni/recupero?nosw`, 1500);
  check((await text('.set-top-title')) === 'Recupero con password' && (await text('.link-line')) === 'Usa una password che non usi altrove.' && (await text('.recovery-off .btn')) === 'Attiva', `${tag} recovery off: its line and "Attiva"`);
  await shot(`${tag}-recovery-off`);
  const offRec = [await centred('.recovery-head .link-icon'), await centred('.recovery-off .btn')];
  check(offRec.every((x) => x <= 2), `${tag} "Recupero con password": centred under the title (${JSON.stringify(offRec)} px off)`);
  await click('.recovery-off .btn');
  await sleep(500);
  const dlg = await evaluate(`return { t: document.querySelector('.layer-dialog .dialog-title')?.textContent, labels: [...document.querySelectorAll('.layer-dialog .field-label')].map((x) => x.textContent), hint: document.querySelector('.layer-dialog .field-hint')?.textContent, b: document.querySelector('.layer-dialog .btn-primary')?.textContent };`);
  check(dlg.t === 'Imposta una password' && dlg.labels.join('|') === 'Password|Ripeti la password' && dlg.hint === 'Almeno 8 caratteri. Meglio una frase breve.' && dlg.b === 'Attiva', `${tag} "Imposta una password": ${JSON.stringify(dlg)}`);
  await shot(`${tag}-set-password`);
  // Enter (the keyboard's "next") in the first field goes on to the second, it sends nothing.
  await evaluate(`document.querySelector('.layer-dialog input').focus(); return true;`);
  await S('Input.insertText', { text: 'frase lunga' });
  await press('Enter');
  await sleep(300);
  const nextField = await evaluate(`const [a, b] = document.querySelectorAll('.layer-dialog input'); return { onSecond: document.activeElement === b, error: document.querySelector('.layer-dialog .dialog-error')?.textContent || '' };`);
  check(nextField.onSecond && nextField.error === '', `${tag} Enter in "Password": on to "Ripeti la password", no error yet (${JSON.stringify(nextField)})`);
  await evaluate(`for (const i of document.querySelectorAll('.layer-dialog input')) i.value = ''; return true;`);
  await typeInto('.layer-dialog input', 'corta');
  await click('.layer-dialog .btn-primary');
  await sleep(300);
  check((await text('.dialog-error')) === 'Almeno 8 caratteri', `${tag} a short password: "Almeno 8 caratteri"`);
  await evaluate(`const [a, b] = document.querySelectorAll('.layer-dialog input'); a.value = 'una frase breve'; b.value = 'una frase lunga'; a.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
  await click('.layer-dialog .btn-primary');
  await sleep(300);
  check((await text('.dialog-error')) === 'Le password non coincidono', `${tag} two different ones: "Le password non coincidono"`);
  await evaluate(`const [a, b] = document.querySelectorAll('.layer-dialog input'); a.value = 'una frase breve'; b.value = 'una frase breve'; a.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
  await click('.layer-dialog .btn-primary');
  await sleep(100);
  const busy = await text('.layer-dialog .btn-primary');
  await sleep(1200);
  check(busy === 'Attivazione...' && /Recupero attivo/.test(await toastsNow()) && (await text('.view-recovery .set-title-text')) === 'Cambia password | Disattiva', `${tag} "Attivazione...", "Recupero attivo", then "Cambia password" and "Disattiva" (${busy})`);
  await shot(`${tag}-recovery-on`);
  await click('button.set-row', 'Cambia password');
  await sleep(500);
  check((await text('.layer-dialog .btn-primary')) === 'Salva', `${tag} changing it: "Salva"`);
  await evaluate(`const [a, b] = document.querySelectorAll('.layer-dialog input'); a.value = 'un altra frase'; b.value = 'un altra frase'; a.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
  await click('.layer-dialog .btn-primary');
  await sleep(1400);
  check(/Password cambiata/.test(await toastsNow()), `${tag} "Password cambiata"`);
  await sleep(2500);
  await click('button.set-row', 'Disattiva');
  await sleep(500);
  check((await text('.layer-dialog .dialog-title')) === 'Disattivare il recupero?' && (await text('.layer-dialog .dialog-text')) === 'La password non servirà più.' && (await text('.layer-dialog .btn')) === 'Annulla | Disattiva', `${tag} turning it off asks: "Disattivare il recupero?"`);
  await click('.layer-dialog .btn-danger');
  await sleep(1200);
  check(/Recupero disattivato/.test(await toastsNow()) && (await text('.recovery-off .btn')) === 'Attiva', `${tag} "Recupero disattivato", back to "Attiva"`);
}

/** What a member sees and does; the owner everything. The delete dialogs. */
async function roles(vp) {
  const { tag } = vpOf(vp);
  log(`\n== ${tag} roles`);
  await setViewport(vp);
  await fetch(`${base}/__mock/reset?sources=2`);
  await go(`${base}/?nosw`, 2200);
  // Già domani: only on the VPS, and someone else's.
  const theirs = await evaluate(`return [...mpfy.store.d.albums.values()].find((a) => a.name === 'Già domani').id;`);
  await go(`${base}/album/${theirs}?nosw`, 1500);
  await click('.track-row .tr-more');
  await sleep(600);
  const tm = await text('.layer-sheet .menu-item, .layer-sheet .menu-info');
  check(!/Modifica informazioni|Cambia copertina|Ripristina copertina|Elimina da/.test(tm) && /Disponibile su:VPS prova: WAV/.test(tm), `${tag} member, someone else's track: no edit, cover or delete (${tm})`);
  await shot(`${tag}-member-track-menu`);
  await evaluate(`history.back(); return true;`);
  await sleep(500);
  await click('.actions-left .icon-btn');
  await sleep(600);
  check(!/Cambia copertina/.test(await text('.layer-sheet .menu-item')), `${tag} member, someone else's album: no cover items (${await text('.layer-sheet .menu-item')})`);
  await evaluate(`history.back(); return true;`);
  await sleep(500);
  // Rotte: on the VPS and theirs: everything, and the last uploader's delete says it goes for all.
  const own = await evaluate(`return [...mpfy.store.d.albums.values()].find((a) => a.name === 'Rotte').id;`);
  await go(`${base}/album/${own}?nosw`, 1500);
  await click('.track-row .tr-more');
  await sleep(600);
  const om = await text('.layer-sheet .menu-item');
  check(/Modifica informazioni/.test(om) && /Cambia copertina/.test(om) && /Elimina da VPS prova/.test(om), `${tag} member, their own track: edit, cover, delete (${om})`);
  await click('.layer-sheet .menu-item', 'Elimina da VPS prova');
  await sleep(500);
  check((await text('.layer-dialog .dialog-title')) === 'Eliminare il brano?' && (await text('.layer-dialog .dialog-text')) === 'Sparisce da VPS prova per tutti.' && (await text('.layer-dialog .btn')) === 'Annulla | Elimina', `${tag} the last uploader deletes: "Sparisce da VPS prova per tutti."`);
  await evaluate(`history.back(); return true;`);
  await sleep(500);
  // Frequenze: on both; on the VPS theirs and someone else's.
  const both = await evaluate(`return [...mpfy.store.d.albums.values()].find((a) => a.name === 'Frequenze').id;`);
  await go(`${base}/album/${both}?nosw`, 1500);
  const before = await evaluate(`return document.querySelectorAll('.track-row').length;`);
  await click('.track-row .tr-more');
  await sleep(600);
  await click('.layer-sheet .menu-item', 'Elimina da VPS prova');
  await sleep(500);
  check((await text('.layer-dialog .dialog-text')) === 'Resta su VPS prova, è anche di altri.', `${tag} a member's track that others own too: "Resta su VPS prova, è anche di altri."`);
  await shot(`${tag}-delete-claim`);
  const t0 = await toastsNow();
  await click('.layer-dialog .btn-danger');
  await sleep(1500);
  const after = await evaluate(`return { rows: document.querySelectorAll('.track-row').length, sources: mpfy.store.trackSources(document.querySelector('.track-row').dataset.tid).length };`);
  const t1 = await toastsNow();
  check(after.rows === before && after.sources === 2 && !/Brano eliminato/.test(t1), `${tag} confirmed: nothing leaves the screen, no toast (${before} -> ${after.rows} rows, ${after.sources} sources; toasts "${t0}" -> "${t1}")`);
  await click('.track-row .tr-more');
  await sleep(600);
  await click('.layer-sheet .menu-item', 'Elimina da Mi A2');
  await sleep(500);
  check((await text('.layer-dialog .dialog-text')) === 'Sparisce da Mi A2 per tutti.', `${tag} the owner deletes: "Sparisce da Mi A2 per tutti."`);
  await evaluate(`history.back(); return true;`);
  await sleep(500);
  await click('.actions-left .icon-btn');
  await sleep(600);
  check(/Cambia copertina/.test(await text('.layer-sheet .menu-item')), `${tag} the owner's album: the cover items`);
  await evaluate(`history.back(); return true;`);
  await sleep(500);
  // A refusal that still happens (the screen still thought it was allowed): the generic line.
  await fetch(`${base}/__mock/source?source=${vps.id}&role=owner`);
  await evaluate(`await mpfy.store.refresh(); return true;`);
  await fetch(`${base}/__mock/source?source=${vps.id}&role=member`);
  const r = await evaluate(`const t = mpfy.store.lib.tracks.find((x) => x.album === 'Già domani'); await mpfy.store.editTrack(t.id, { title: 'Prova' }); await new Promise((res) => setTimeout(res, 400)); return [...document.querySelectorAll('.toast')].map((x) => x.textContent).join(' | ');`);
  check(/Qualcosa non ha funzionato/.test(r), `${tag} a 403 that still happens: "Qualcosa non ha funzionato" (${r})`);
}

/** An in-page ZIP (stored entries) of the given { name, bytes }. */
const zipJs = `
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
  const wav = (n, seed) => { const b = new Uint8Array(44 + n), dv = new DataView(b.buffer); const w = (o, s) => [...s].forEach((c, i) => (b[o + i] = c.charCodeAt(0))); w(0, 'RIFF'); dv.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, 11025, true); dv.setUint32(28, 22050, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n, true); for (let i = 0; i < n; i++) b[44 + i] = (i * seed) & 255; return b; };
`;

/** Uploads: the hint, outcomes, the "maybe" choice, archives, a folder, a chunked upload. */
async function uploadFlows(vp) {
  const { mobile, tag } = vpOf(vp);
  log(`\n== ${tag} uploads`);
  await setViewport(vp);
  await fetch(`${base}/__mock/reset?sources=2`);
  await go(`${base}/?nosw`, 2200);
  const openSheet = async () => {
    await click('.home-top [aria-label="Carica brani"]');
    await sleep(1000);
  };
  const closeSheet = async () => {
    await evaluate(`history.back(); return true;`);
    await sleep(500);
  };
  const hint = async (q) => {
    await fetch(`${base}/__mock/source?source=${mi.id}&${q}`);
    await evaluate(`await mpfy.sources.loadHealth({ force: true }); return true;`);
    await openSheet();
    const t = await text('.up-hint');
    await closeSheet();
    return t;
  };
  // Before the source's health is known the hint waits (empty, its line kept); it never says
  // first that the source takes no archives.
  await fetch(`${base}/__mock/source?source=${mi.id}&healthMs=2500`);
  await go(`${base}/?nosw&from=hint`, 600);
  await click('.home-top [aria-label="Carica brani"]');
  await sleep(300);
  const early = await evaluate(`const e = document.querySelector('.up-hint'); return { t: e.textContent, h: Math.round(e.getBoundingClientRect().height) };`);
  await sleep(3200);
  const late = await text('.up-hint');
  check(early.t === '' && early.h >= 14 && late === 'Brani fino a 600 MB, archivi ZIP, 7z e RAR fino a 4 GB.', `${tag} the hint waits for the health of a source with profiles, keeping its line (${JSON.stringify(early)} -> ${late})`);
  await closeSheet();
  await fetch(`${base}/__mock/source?source=${mi.id}&healthMs=0`);
  const hints = [await hint('rar=1&sevenZip=1'), await hint('rar=0'), await hint('sevenZip=0'), await hint('legacy=1')];
  await fetch(`${base}/__mock/source?source=${mi.id}&legacy=0&sevenZip=1&rar=1`);
  await evaluate(`await mpfy.sources.loadHealth({ force: true }); await mpfy.store.refresh(); return true;`);
  check(hints.join(' | ') === 'Brani fino a 600 MB, archivi ZIP, 7z e RAR fino a 4 GB. | Brani fino a 600 MB, archivi ZIP e 7z fino a 4 GB. | Brani fino a 600 MB, archivi ZIP fino a 4 GB. | Brani fino a 600 MB.', `${tag} the sheet hint follows the target's archives: ${hints.join(' | ')}`);
  await fetch(`${base}/__mock/source?source=${mi.id}&extractMs=500`);
  await openSheet();
  check((await text('.up-picks .btn')) === 'Scegli i file | Carica cartella' && (await text('.panel-upload .panel-title')) === 'Carica brani', `${tag} "Carica brani" with "Scegli i file" and "Carica cartella"`);
  await overflowCheck(`${tag} upload sheet`);
  await evaluate(`${zipJs}
    const { uploads } = await import('/js/upload.js');
    uploads.add([
      new File([wav(5000, 3)], 'Nebbia [forse].wav', { type: 'audio/wav' }),
      new File([wav(6000, 5)], 'Pezzo nuovo.wav', { type: 'audio/wav' }),
      new File([wav(7000, 7)], 'Approdo [hq].wav', { type: 'audio/wav' }),
      new File([wav(4000, 9)], 'Bussola.wav', { type: 'audio/wav' }),
      new File([zip([{ name: 'Disco/01 Alba.wav', bytes: wav(3000, 11) }, { name: 'Disco/02 Tramonto.wav', bytes: wav(3100, 13) }, { name: 'Disco/Bussola.wav', bytes: wav(3200, 17) }, { name: 'Disco/vecchio.zip', bytes: new Uint8Array([80, 75, 5, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) }, { name: 'Disco/cover.jpg', bytes: new Uint8Array([255, 216, 255, 224]) }])], 'Disco.zip', { type: 'application/zip' }),
      new File([zip([{ name: 'Correnti.wav', bytes: wav(3000, 19) }, { name: 'Isole.wav', bytes: wav(3000, 23) }])], 'Già qui.zip', { type: 'application/zip' }),
    ]);
    return true;`);
  await sleep(1800);
  const extracting = await text('.up-row .up-state');
  await sleep(7000);
  const rows = await evaluate(`return [...document.querySelectorAll('.up-row')].map((r) => r.querySelector('.up-name').textContent + ': ' + r.querySelector('.up-state').textContent);`);
  log(`   while extracting: ${extracting}`);
  check(rows.includes('Pezzo nuovo.wav: Caricato') && rows.includes('Approdo [hq].wav: Sostituito con una versione migliore') && rows.includes('Bussola.wav: Già presente'), `${tag} outcome rows: ${rows.join(' / ')}`);
  check(rows.includes('Disco.zip: 2 brani caricati, 1 file ignorato') && rows.includes('Già qui.zip: Già presente'), `${tag} archives: the summary (nested archive ignored, the cover and the folder name quietly), an album already there "Già presente"`);
  check(/Estrazione/.test(extracting), `${tag} an archive shows "Estrazione..." / "Estrazione n di m" while it is imported (${extracting})`);
  check((await text('.up-choice-title')) === 'Sembra lo stesso brano di Nebbia' && (await text('.up-choice .btn')) === 'Tieni la versione migliore | Tienili entrambi', `${tag} the "maybe": "Sembra lo stesso brano di Nebbia", both buttons`);
  await shot(`${tag}-upload-rows`);
  // With the sheet closed a choice says so, and "Apri" opens the sheet again.
  await closeSheet();
  await evaluate(`${zipJs}
    const { uploads } = await import('/js/upload.js');
    uploads.add([new File([wav(5200, 31)], 'Segnali lontani [forse].wav', { type: 'audio/wav' })]);
    return true;`);
  await sleep(1500);
  const t = await evaluate(`return [...document.querySelectorAll('.toast')].map((x) => (x.querySelector('.toast-action') ? x.textContent : '')).join('');`);
  check(t === 'Serve una sceltaApri', `${tag} a choice with the sheet closed: toast "Serve una scelta" with "Apri" (${t})`);
  await noFlexGap();
  const toastGap = await spaces('.toast.has-action > *', 'x');
  check(toastGap.length === 1 && toastGap[0] >= 10, `${tag} without flex gap "Serve una scelta" and "Apri" do not run into each other (${JSON.stringify(toastGap)})`);
  await click('.toast-action');
  await sleep(1000);
  check((await evaluate(`return !!document.querySelector('.panel-upload') && document.querySelectorAll('.up-choice-title').length === 2;`)) === true, `${tag} "Apri" opens the sheet with the choices`);
  await click('.up-choice .btn', 'Tieni la versione migliore');
  await sleep(1200);
  check((await evaluate(`return [...document.querySelectorAll('.up-row')].find((r) => r.textContent.includes('Nebbia [forse]')).querySelector('.up-state').textContent;`)) === 'Già presente', `${tag} "Tieni la versione migliore": "Già presente"`);
  if (mobile) {
    // A folder through webkitdirectory: the audio files go, the rest is left out.
    const dir = path.join(outDir, 'ui-folder', 'Cartella prova');
    fs.rmSync(path.join(outDir, 'ui-folder'), { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const w = Buffer.alloc(44 + 3000);
    w.write('RIFF', 0);
    w.writeUInt32LE(36 + 3000, 4);
    w.write('WAVE', 8);
    w.write('fmt ', 12);
    w.writeUInt32LE(16, 16);
    w.writeUInt16LE(1, 20);
    w.writeUInt16LE(1, 22);
    w.writeUInt32LE(11025, 24);
    w.writeUInt32LE(22050, 28);
    w.writeUInt16LE(2, 32);
    w.writeUInt16LE(16, 34);
    w.write('data', 36);
    w.writeUInt32LE(3000, 40);
    for (let i = 0; i < 3000; i++) w[44 + i] = (i * 29) & 255;
    fs.writeFileSync(path.join(dir, '01 Da cartella.wav'), w);
    fs.writeFileSync(path.join(dir, 'note.txt'), 'testo\n');
    const n0 = await evaluate(`return document.querySelectorAll('.up-row').length;`);
    await setFiles('.up-dir-input', [dir]);
    await sleep(2500);
    const fr = await evaluate(`return [...document.querySelectorAll('.up-row')].slice(${n0}).map((r) => r.querySelector('.up-name').textContent + ': ' + r.querySelector('.up-state').textContent);`);
    check(fr.length === 1 && /01 Da cartella\.wav: Caricato$/.test(fr[0]), `${tag} "Carica cartella" (webkitdirectory): the song goes, note.txt is left out quietly (${fr.join(' / ')})`);
    // A chunked upload through the real browser: a chunk cut halfway, then on.
    await fetch(`${base}/__mock/source?source=${mi.id}&drop=1`);
    const ch = await evaluate(`
      const { uploads } = await import('/js/upload.js');
      uploads.configure({ singleMax: 1048576, retry: [200, 400] });
      const n = 3 * 1048576 + 333; const b = new Uint8Array(44 + n); const dv = new DataView(b.buffer);
      const w = (o, s) => [...s].forEach((c, i) => (b[o + i] = c.charCodeAt(0)));
      w(0, 'RIFF'); dv.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, 11025, true); dv.setUint32(28, 22050, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n, true);
      for (let i = 0; i < n; i++) b[44 + i] = (i * 7) & 255;
      uploads.add([new File([b], 'Grande a pezzi.wav', { type: 'audio/wav' })]);
      const job = uploads.jobs[uploads.jobs.length - 1];
      const seen = [];
      for (let i = 0; i < 200 && !['done', 'error'].includes(job.state); i++) { if (seen[seen.length - 1] !== job.state) seen.push(job.state); await new Promise((r) => setTimeout(r, 50)); }
      uploads.configure({ singleMax: 32 * 1048576, retry: [1000, 2000, 4000, 8000, 15000] });
      return { state: job.state, seen, size: b.length };`);
    const stt = await (await fetch(`${base}/__mock/state`)).json();
    const sess = stt.servers.find((x) => x.name === 'Mi A2').sessions.find((x) => x.name === 'Grande a pezzi.wav');
    const resumed = (sess?.puts || []).filter((o) => o > 0);
    check(ch.state === 'done' && sess?.done && sess.offset === ch.size && resumed.length > 0, `${tag} a chunked upload cut halfway: it goes on from the bytes that arrived, to the end (${JSON.stringify(ch.seen)}, chunks at ${JSON.stringify(sess?.puts)}, ${sess?.offset} of ${ch.size})`);
  }
  await closeSheet();
}

/** The browser backend: a version that fails or stalls hands over to the next one. */
async function playerFailover(vp) {
  const { tag } = vpOf(vp);
  log(`\n== ${tag} versions in the browser`);
  await setViewport(vp);
  await fetch(`${base}/__mock/reset?sources=2`);
  await go(`${base}/?nosw`, 2200);
  const both = await evaluate(`return [...mpfy.store.d.albums.values()].find((a) => a.name === 'Frequenze').id;`);
  await go(`${base}/album/${both}?nosw`, 1500);
  // Songs not played before in this browser: a cached original would play from the cache.
  await fetch(`${base}/__mock/source?source=${vps.id}&streamFail=1`);
  await evaluate(`document.querySelectorAll('.track-row .tr-main')[2].click(); return true;`);
  await sleep(3000);
  const a = await evaluate(`return { src: mpfy.player.state.source, playing: mpfy.player.state.playing, items: mpfy.player.state.items.length };`);
  check(a.src === mi.id && a.playing, `${tag} the first version (the VPS) answers an error: the same song goes on from the Mi A2 (${JSON.stringify(a)})`);
  await evaluate(`mpfy.player.pause(); return true;`);
  await fetch(`${base}/__mock/source?source=${vps.id}&streamFail=0&streamStall=1`);
  await evaluate(`document.querySelectorAll('.track-row .tr-main')[3].click(); return true;`);
  await sleep(1500);
  const b0 = await evaluate(`return mpfy.player.state.source;`);
  await sleep(5500);
  const b1 = await evaluate(`return { src: mpfy.player.state.source, playing: mpfy.player.state.playing };`);
  check(b0 === vps.id && b1.src === mi.id && b1.playing, `${tag} the first version stalls (no progress for 4 s while waiting): the next one takes over (${b0} -> ${JSON.stringify(b1)})`);
  await evaluate(`mpfy.player.pause(); return true;`);
  await fetch(`${base}/__mock/source?source=${vps.id}&streamStall=0`);
  await versionsMoving(vp);
}

/**
 * The browser's player while sources come and go under a song (its audio element is reached
 * through a wrapper of Audio): a version the new order put first is tried when the one playing
 * fails, the position never drops to 0 on a switch, and a version whose source went down hands
 * over at the same moment of the song in the other file.
 */
async function versionsMoving(vp) {
  const { tag } = vpOf(vp);
  const grab = `(() => { const A = window.Audio; window.__audios = []; window.Audio = function (...a) { const x = new A(...a); window.__audios.push(x); return x; }; window.Audio.prototype = A.prototype; })();`;
  const { identifier } = await S('Page.addScriptToEvaluateOnNewDocument', { source: grab });
  const vpsOff = async (on) => {
    await fetch(`${base}/__mock/offline?source=${vps.id}&on=${on ? 1 : 0}`);
    await evaluate(`await mpfy.sources.refresh(); return true;`);
  };
  try {
    await fetch(`${base}/__mock/reset?sources=2`);
    await go(`${base}/?nosw&from=versions`, 2500);
    const songOf = (sameFile) => evaluate(`const t = mpfy.store.lib.tracks.find((x) => { const v = mpfy.store.versions(x.id); return v.length === 2 && (v[0].fileHash === v[1].fileHash) === ${sameFile}; }); return t ? t.id : null;`);
    const play = (id) => evaluate(`mpfy.player.playContext({ type: 'library', id: null, name: 'Libreria' }, [${JSON.stringify(id)}], 0); return true;`);
    const errorNow = () => evaluate(`const a = mpfy.player.audioElement; a.dispatchEvent(new Event('error')); return true;`);

    // The same file on both: the VPS down at the start, so the song plays from the Mi A2. The VPS
    // comes back and goes first in the new order; then the Mi A2's version fails.
    const same = await songOf(true);
    await vpsOff(true);
    await play(same);
    await sleep(2800);
    const s0 = await evaluate(`return { src: mpfy.player.state.source, playing: mpfy.player.state.playing, pos: mpfy.player.state.position };`);
    await vpsOff(false);
    await sleep(1700); // the player decides again a second after a source came or went
    await watchToasts();
    await evaluate(`window.__pos = []; window.__iv = setInterval(() => window.__pos.push(mpfy.player.state.position), 10); return true;`);
    await errorNow();
    await sleep(2200);
    const s1 = await evaluate(`clearInterval(window.__iv); const st = mpfy.player.state; return { src: st.source, playing: st.playing, id: st.items[st.index]?.id, min: Math.min(...window.__pos) };`);
    const skipped = (await seenToasts()).includes('Brano non disponibile');
    check(s0.src === mi.id && s0.playing && s1.src === vps.id && s1.id === same && s1.playing && !skipped, `${tag} the VPS came back first in the order and the Mi A2's version fails: the same song goes on from the VPS (${JSON.stringify(s0)} -> ${JSON.stringify(s1)}, skipped ${skipped})`);
    check(s0.pos > 1 && s1.min > 1, `${tag} the position never drops to 0 while the other version loads (min ${s1.min.toFixed ? s1.min.toFixed(2) : s1.min} s, was ${s0.pos.toFixed ? s0.pos.toFixed(2) : s0.pos} s)`);
    await evaluate(`mpfy.player.pause(); return true;`);

    // Two files of one song (the VPS copy starts 3 items, 371 ms, later). The version playing
    // loses its source; when it fails, the other starts at the same moment of the song.
    const diff = await songOf(false);
    await play(diff);
    await sleep(2800);
    await evaluate(`mpfy.player.pause(); return true;`);
    await sleep(300);
    const x = await evaluate(`return { src: mpfy.player.state.source, t: mpfy.player.audioElement.currentTime };`);
    const other = x.src === mi.id ? vps.id : mi.id;
    await fetch(`${base}/__mock/offline?source=${x.src}&on=1`);
    await evaluate(`await mpfy.sources.refresh(); return true;`);
    await sleep(1700);
    if ((await evaluate(`return mpfy.player.state.source;`)) === x.src) await errorNow();
    await sleep(1800);
    const y = await evaluate(`return { src: mpfy.player.state.source, t: mpfy.player.audioElement.currentTime };`);
    const want = x.src === mi.id ? 0.371 : -0.371; // the copy on the VPS is later
    check(y.src === other && Math.abs(y.t - x.t - want) < 0.03, `${tag} the version playing lost its source, then failed: the other file starts at the same moment (${x.t.toFixed(3)} s on ${x.src} -> ${y.t.toFixed(3)} s on ${y.src}, want ${want > 0 ? '+' : ''}${want})`);
    await fetch(`${base}/__mock/offline?source=${x.src}&on=0`);
  } finally {
    await S('Page.removeScriptToEvaluateOnNewDocument', { identifier });
  }
}

/** The page inside the app (a fake bridge 3): Memoria, the profile file, the folder picker. */
async function appMode(vp) {
  const { tag } = vpOf(vp);
  log(`\n== ${tag} in the app`);
  await setViewport(vp);
  await fetch(`${base}/__mock/reset?sources=2`);
  const fake = `(() => {
    window.__calls = [];
    const st = { downloadsBytes: 1288490189, downloadsCount: 37, cacheBytes: 356515840 };
    window.MPfyNative = new Proxy({}, { get: (_, name) => (...args) => {
      window.__calls.push([name, ...args]);
      switch (name) {
        case 'bridgeVersion': return '3';
        case 'getStorage': return JSON.stringify(st);
        case 'getProfileFile': return JSON.stringify({ fileName: 'Bacca.mpfy', folder: 'Documents/MPfy', state: 'ok' });
        case 'listDownloads': return JSON.stringify({ ids: [], progress: {}, items: [] });
        case 'getNetwork': return JSON.stringify({ type: 'wifi', metered: false });
        case 'getState': return JSON.stringify({ playing: false });
        case 'pickFolder': return 'f00df00df00df00d';
        case 'pickProfileFile': return 'p00dp00dp00dp00d';
        case 'clearDownloads': st.downloadsBytes = 0; st.downloadsCount = 0; return undefined;
        case 'clearCache': st.cacheBytes = 0; return undefined;
        default: return undefined;
      }
    } });
  })();`;
  const { identifier } = await S('Page.addScriptToEvaluateOnNewDocument', { source: fake });
  try {
    await go(`${base}/impostazioni?nosw`, 2200);
    await evaluate(`document.querySelector('.mem-downloads').scrollIntoView(); return true;`);
    await sleep(300);
    const mem = await evaluate(`return [...document.querySelectorAll('.mem-downloads, .mem-cache')].map((r) => r.querySelector('.set-title-text').textContent + ': ' + r.querySelector('.set-sub').textContent);`);
    check(mem.join(' / ') === 'Elimina download: 1,2 GB, 37 brani / Svuota cache: 340 MB', `${tag} Memoria in the app: ${mem.join(' / ')}`);
    await shot(`${tag}-app-memoria`);
    await click('.mem-downloads');
    await sleep(500);
    check((await text('.layer-dialog .dialog-title')) === 'Eliminare i download?' && (await text('.layer-dialog .dialog-text')) === 'Restano sulle fonti.' && (await text('.layer-dialog .btn')) === 'Annulla | Elimina', `${tag} "Elimina download" asks "Eliminare i download?", "Restano sulle fonti."`);
    await click('.layer-dialog .btn-danger');
    await sleep(800);
    const calls1 = await evaluate(`return window.__calls.map((c) => c[0]);`);
    check(calls1.includes('clearDownloads') && /Download eliminati/.test(await toastsNow()) && (await text('.mem-downloads .set-sub')) === 'Nessun download', `${tag} "Download eliminati": clearDownloads, then "Nessun download"`);
    await click('.mem-cache');
    await sleep(800);
    const calls2 = await evaluate(`return window.__calls.map((c) => c[0]);`);
    check(calls2.includes('clearCache') && /Cache svuotata/.test(await toastsNow()) && !(await evaluate(`return !!document.querySelector('.layer-dialog');`)), `${tag} "Svuota cache": no dialog, clearCache, "Cache svuotata"`);
    await go(`${base}/impostazioni/profilo?nosw`, 1500);
    check((await text('.set-title-text')) === 'Nome | Codice del profilo | File del profilo | Recupero con password' && (await text('.file-row .set-sub')) === 'Documents/MPfy/Bacca.mpfy', `${tag} the app: "File del profilo", in Documents/MPfy/Bacca.mpfy`);
    await shot(`${tag}-app-profile`);
    await go(`${base}/impostazioni/collega?nosw`, 1500);
    await click('.link-body .btn-primary');
    await sleep(800);
    await click('.code-copy');
    await sleep(300);
    const copied = await evaluate(`return window.__calls.filter((c) => c[0] === 'copySecret').map((c) => c[1]);`);
    check(copied.length === 1 && /^mpfy:\/\/collega\?p=MPFYP[0-9A-Z]{56}/.test(copied[0]) && /Codice copiato/.test(await toastsNow()), `${tag} "Copia" in the app: copySecret with the profile's link (code and sources), "Codice copiato"`);
    await go(`${base}/?nosw`, 1500);
    check((await evaluate(`return !document.querySelector('.update-btn') && !window.__calls.some((c) => c[0] === 'getUpdate');`)) === true, `${tag} an app with bridge 3: no update button, getUpdate never asked`);
    await click('.home-top [aria-label="Carica brani"]');
    await sleep(900);
    await click('.up-picks .btn', 'Carica cartella');
    await sleep(200);
    check((await evaluate(`return window.__calls.some((c) => c[0] === 'pickFolder');`)) === true, `${tag} "Carica cartella" in the app: the system folder picker`);
    await evaluate(`history.back(); return true;`);
    await sleep(400);
    await fetch(`${base}/__mock/reset?sources=0&profile=0`);
    await go(`${base}/?nosw`, 2000);
    await click('.welcome button', 'Recupera profilo');
    await sleep(400);
    check((await text('.welcome-option-label')).startsWith('Dal file del telefono | '), `${tag} in the app the first way is "Dal file del telefono"`);
    await click('.welcome-option', 'Dal file del telefono');
    await sleep(200);
    const exp = { format: 'mpfy-identity', v: 1, profile: { id: '22de25661c578b57b919dfcada067bd4', secret: '00'.repeat(32), name: 'Bacca', nameUpdatedAt: 1 }, clientSeed: '11'.repeat(32), sources: [{ id: mi.id, name: 'Mi A2', serverPublicKey: '22'.repeat(32), principal: true, addedAt: 1 }], recovery: null, exportedAt: 1 };
    await evaluate(`window.__mpfyNative({ type: 'profileFile', requestId: 'p00dp00dp00dp00d', state: 'ok', name: 'Bacca.mpfy', text: ${JSON.stringify(JSON.stringify(exp))} }); return true;`);
    await sleep(2000);
    const adopt = await evaluate(`return window.__calls.filter((c) => c[0] === 'adoptProfileFile').map((c) => c[1]);`);
    check(adopt.join() === 'p00dp00dp00dp00d' && /Profilo recuperato/.test(await toastsNow()) && !(await evaluate(`return !!document.querySelector('.welcome');`)), `${tag} "Dal file del telefono": imported, the file adopted, the library`);
  } finally {
    await S('Page.removeScriptToEvaluateOnNewDocument', { identifier });
  }
}

/**
 * The update button (an app with bridge 4): absent while there is no update, immediately left of
 * "Carica brani" otherwise; its ring full when ready or installing, a faint track with an accent
 * arc while it downloads; startUpdate only from "available"; a failure toasts and the ring is
 * full again.
 */
async function appUpdate(vp) {
  const { tag } = vpOf(vp);
  log(`\n== ${tag} the update button`);
  await setViewport(vp);
  await fetch(`${base}/__mock/reset?sources=2`);
  const fake = (update) => `(() => {
    window.__calls = [];
    window.MPfyNative = new Proxy({}, { get: (_, name) => (...args) => {
      window.__calls.push([name, ...args]);
      switch (name) {
        case 'bridgeVersion': return '4';
        case 'getUpdate': return ${JSON.stringify(JSON.stringify(update))};
        case 'getStorage': return JSON.stringify({ downloadsBytes: 0, downloadsCount: 0, cacheBytes: 0 });
        case 'listDownloads': return JSON.stringify({ ids: [], progress: {}, items: [] });
        case 'getNetwork': return JSON.stringify({ type: 'wifi', metered: false });
        case 'getState': return JSON.stringify({ playing: false, queueId: null });
        case 'getQueue': return JSON.stringify({ queueId: null, index: 0, positionMs: 0, items: [] });
        default: return undefined;
      }
    } });
  })();`;
  const btn = () =>
    evaluate(`const b = document.querySelector('.update-btn'); if (!b) return null; const ring = b.querySelector('.upd-ring'); const arc = b.querySelector('.upd-arc'); const next = b.nextElementSibling; return { label: b.getAttribute('aria-label'), title: b.getAttribute('title'), state: b.dataset.state, next: next ? next.getAttribute('aria-label') : null, inTop: !!b.closest('.home-top'), ring: getComputedStyle(ring).opacity, arc: getComputedStyle(arc).display, offset: arc.getAttribute('stroke-dashoffset'), dash: arc.getAttribute('stroke-dasharray'), rot: arc.getAttribute('transform'), arcColor: getComputedStyle(arc).color, w: Math.round(b.querySelector('svg').getBoundingClientRect().width), text: b.textContent.trim() };`);
  const send = (m) => evaluate(`window.__mpfyNative(${JSON.stringify(JSON.stringify(m))}); return true;`);
  let id = (await S('Page.addScriptToEvaluateOnNewDocument', { source: fake({ state: 'none', versionName: '', progress: 0 }) })).identifier;
  try {
    await go(`${base}/?nosw`, 1800);
    check((await btn()) === null && (await evaluate(`return window.__calls.some((c) => c[0] === 'getUpdate');`)) === true, `${tag} bridge 4, state none: getUpdate asked, no button`);
    await S('Page.removeScriptToEvaluateOnNewDocument', { identifier: id });
    id = (await S('Page.addScriptToEvaluateOnNewDocument', { source: fake({ state: 'available', versionName: '2.1.0', progress: 0 }) })).identifier;
    await go(`${base}/?nosw`, 1800);
    let b = await btn();
    check(!!b && b.inTop && b.next === 'Carica brani', `${tag} available: the button in the Home header, immediately left of "Carica brani" (${JSON.stringify(b && { next: b.next })})`);
    check(!!b && b.label === 'Aggiorna MPfy' && b.title === 'Aggiorna MPfy' && b.text === '' && b.w === 24, `${tag} available: "Aggiorna MPfy" as label and title, no text, a 24 px glyph (${JSON.stringify(b && { label: b.label, title: b.title, w: b.w })})`);
    check(!!b && b.ring === '1' && b.arc === 'none', `${tag} available: a full ring (${JSON.stringify(b && { ring: b.ring, arc: b.arc })})`);
    await overflowCheck(`${tag} Home with the update button`);
    await shot(`${tag}-update-available`);
    await evaluate(`window.__calls = []; document.querySelector('.update-btn').click(); return true;`);
    check((await evaluate(`return window.__calls.filter((c) => c[0] === 'startUpdate').length;`)) === 1, `${tag} a tap in "available": startUpdate`);
    const offsets = [];
    for (const p of [0, 0.42, 1]) {
      await send({ type: 'update', state: 'downloading', versionName: '2.1.0', progress: p });
      await sleep(120);
      b = await btn();
      offsets.push(b?.offset);
      if (p === 0.42) await shot(`${tag}-update-downloading`);
    }
    check(offsets.join(',') === '57.81,33.53,0', `${tag} downloading: the arc's offset for 0, 0.42 and 1 is ${offsets.join(', ')}`);
    check(!!b && b.state === 'downloading' && b.ring === '0.35' && b.arc !== 'none' && b.dash === '57.81' && b.rot === 'rotate(-90 12 12)' && b.arcColor === 'rgb(194, 194, 194)', `${tag} downloading: a 35% track and an accent arc from the top (${JSON.stringify(b && { ring: b.ring, arc: b.arc, dash: b.dash, rot: b.rot, color: b.arcColor })})`);
    check(!!b && b.label === 'Aggiornamento in corso' && b.title === 'Aggiornamento in corso', `${tag} downloading: "Aggiornamento in corso"`);
    await evaluate(`window.__calls = []; document.querySelector('.update-btn').click(); return true;`);
    await send({ type: 'update', state: 'installing', versionName: '2.1.0', progress: 1 });
    await sleep(120);
    b = await btn();
    await evaluate(`document.querySelector('.update-btn').click(); return true;`);
    check((await evaluate(`return window.__calls.filter((c) => c[0] === 'startUpdate').length;`)) === 0, `${tag} a tap while downloading or installing: nothing`);
    check(!!b && b.state === 'installing' && b.ring === '1' && b.arc === 'none' && b.label === 'Aggiornamento in corso', `${tag} installing: a full ring, "Aggiornamento in corso" (${JSON.stringify(b && { ring: b.ring, arc: b.arc, label: b.label })})`);
    await watchToasts();
    await send({ type: 'update', state: 'downloading', versionName: '2.1.0', progress: 0.6 });
    await sleep(120);
    await send({ type: 'update', state: 'available', versionName: '2.1.0', progress: 0, failed: true });
    await sleep(400);
    b = await btn();
    check((await seenToasts()).join(' | ') === 'Aggiornamento non riuscito' && !!b && b.state === 'available' && b.ring === '1' && b.arc === 'none', `${tag} a download that failed: "Aggiornamento non riuscito", the full ring again (${(await seenToasts()).join(' | ')})`);
    await send({ type: 'update', state: 'none', versionName: '', progress: 0 });
    await sleep(200);
    check((await btn()) === null && (await evaluate(`return !!document.querySelector('.home-top [aria-label="Carica brani"]');`)) === true, `${tag} back to none: the button goes, the header as before`);
  } finally {
    await S('Page.removeScriptToEvaluateOnNewDocument', { identifier: id });
  }
}

/**
 * "Cerca i dettagli in rete" on a source's page: only for its owner and only when the source says
 * where it stands; between "Rinomina fonte" and "Imposta come principale"; a tap sends the PATCH
 * at once, the answer is taken, a refusal puts the old state back with a toast.
 */
async function detailsSwitch(vp) {
  const { tag } = vpOf(vp);
  log(`\n== ${tag} the details switch`);
  await setViewport(vp);
  await fetch(`${base}/__mock/reset?sources=2`);
  const titles = () => text('.src-actions .set-title-text');
  const sw = () => evaluate(`const b = document.querySelector('.details-switch'); if (!b) return null; return { role: b.getAttribute('role'), checked: b.getAttribute('aria-checked'), tag: b.tagName, sub: !!b.querySelector('.set-sub'), thumb: getComputedStyle(b.querySelector('.switch-thumb')).transform, track: getComputedStyle(b.querySelector('.switch')).backgroundColor };`);
  const detailsOn = async (id) => (await (await fetch(`${base}/__mock/state`)).json()).servers.find((s) => s.id === id).details;
  // A source that does not say (older): no switch, even for its owner.
  await go(`${base}/impostazioni/fonte/${mi.id}?nosw`, 1500);
  check(!/Cerca i dettagli in rete/.test(await titles()), `${tag} the owner's source that does not say: no switch (${await titles()})`);
  // The VPS owned by this person and saying "on": the switch, in its place.
  await fetch(`${base}/__mock/source?source=${vps.id}&role=owner&details=1`);
  await go(`${base}/impostazioni/fonte/${vps.id}?nosw`, 1800);
  check((await titles()) === 'Rinomina fonte | Cerca i dettagli in rete | Imposta come principale | Mostra codice | Cambia codice | Dispositivi collegati | Rimuovi fonte', `${tag} owner, details on: the switch between "Rinomina fonte" and "Imposta come principale" (${await titles()})`);
  let s = await sw();
  check(!!s && s.tag === 'BUTTON' && s.role === 'switch' && s.checked === 'true' && !s.sub, `${tag} a button role switch, aria-checked true, no sub line (${JSON.stringify(s)})`);
  await overflowCheck(`${tag} source page with the switch`);
  await shot(`${tag}-details-on`);
  // The same switch stays and its thumb slides to the new state (a row drawn anew would jump).
  const tap = await evaluate(`const b = document.querySelector('.details-switch'); b.click(); await new Promise((r) => setTimeout(r, 30)); const now = document.querySelector('.details-switch'); return { same: now === b && b.isConnected, checked: now.getAttribute('aria-checked'), sliding: now.querySelector('.switch-thumb').getAnimations().filter((a) => a.transitionProperty === 'transform').length };`);
  check(tap.checked === 'false', `${tag} a tap: off at once (${tap.checked})`);
  check(tap.same && tap.sliding === 1, `${tag} a tap: the same switch, its thumb slides (${JSON.stringify(tap)})`);
  await sleep(1200);
  check((await detailsOn(vps.id)) === false && (await evaluate(`return mpfy.store.libOf(${JSON.stringify(vps.id)}).source.details;`)) === false && (await sw())?.checked === 'false', `${tag} the PATCH { details: false } reached the source, its answer taken`);
  await shot(`${tag}-details-off`);
  // The source refuses: back to off, "Qualcosa non ha funzionato".
  await fetch(`${base}/__mock/source?source=${vps.id}&detailsFail=1`);
  await watchToasts();
  await click('.details-switch');
  await sleep(40);
  const during = (await sw())?.checked;
  await sleep(1200);
  s = await sw();
  check(during === 'true' && s?.checked === 'false' && (await detailsOn(vps.id)) === false && (await seenToasts()).includes('Qualcosa non ha funzionato'), `${tag} refused: on for a moment, then off again with "Qualcosa non ha funzionato" (${during} -> ${s?.checked}, ${(await seenToasts()).join(' | ')})`);
  await fetch(`${base}/__mock/source?source=${vps.id}&detailsFail=0`);
  // A member of a source that says it: no switch.
  await fetch(`${base}/__mock/source?source=${vps.id}&role=member`);
  await go(`${base}/impostazioni/fonte/${vps.id}?nosw`, 1800);
  check(!/Cerca i dettagli in rete/.test(await titles()), `${tag} a member: no switch (${await titles()})`);
  await fetch(`${base}/__mock/reset?sources=2`);
}

/**
 * "Scheda di memoria" on the owner's source page: the line of each state the source reports, red
 * only while the card is away, its sheet on a tap; no row with no card, nor for a member.
 */
async function cardRow(vp) {
  const { tag } = vpOf(vp);
  log(`\n== ${tag} the memory card row`);
  await setViewport(vp);
  await fetch(`${base}/__mock/reset?sources=2`);
  const at = async (card, role = 'owner') => {
    await fetch(`${base}/__mock/source?source=${mi.id}&role=${role}&card=${card}`);
    await go(`${base}/impostazioni/fonte/${mi.id}?nosw`, 1500);
    return evaluate(`const r = document.querySelector('.src-actions .storage-row'); return r ? { title: r.querySelector('.set-title-text').textContent, sub: (r.querySelector('.set-sub') || {}).textContent || '', danger: r.classList.contains('danger'), icon: !!r.querySelector('.set-icon svg') } : null;`);
  };
  let r = await at('use');
  check(r?.title === 'Scheda di memoria' && /^In uso, \d+,\d GB liberi$/.test(r.sub) && !r.danger && r.icon, `${tag} card in use: "Scheda di memoria", its free space, not red (${JSON.stringify(r)})`);
  await shot(`${tag}-card-use`);
  await overflowCheck(`${tag} card row`);
  r = await at('moving');
  check(/^In uso, sposto la musica: 230 di 1200 brani$/.test(r?.sub || '') && !r.danger, `${tag} card moving: how many songs moved (${JSON.stringify(r)})`);
  r = await at('found');
  check(/^\d+,\d GB liberi\. Tocca per usarla per la musica$/.test(r?.sub || '') && !r.danger, `${tag} a card found: tap to use it (${JSON.stringify(r)})`);
  r = await at('away');
  check(r?.sub === 'Non trovata: 240 brani non disponibili' && r.danger, `${tag} card away: the songs not available, red (${JSON.stringify(r)})`);
  await shot(`${tag}-card-away`);
  await click('.src-actions .storage-row');
  await sleep(600);
  const items = await text('.layer-sheet .menu-item');
  check(items === 'Dimentica la scheda', `${tag} card away, a tap: the sheet with "Dimentica la scheda" (${items})`);
  await evaluate(`history.back(); return true;`);
  await sleep(500);
  r = await at('none');
  check(r === null, `${tag} no card: no row (${JSON.stringify(r)})`);
  r = await at('use', 'member');
  check(r === null, `${tag} a member: no row (${JSON.stringify(r)})`);
  await fetch(`${base}/__mock/reset?sources=2`);
}

/** Gapless in the browser: the next song loads in the spare element near the end, and goes on from it. */
async function gapless(vp) {
  const { tag } = vpOf(vp);
  log(`\n== ${tag} gapless`);
  await setViewport(vp);
  await fetch(`${base}/__mock/reset?sources=2`);
  await go(`${base}/?nosw`, 2000);
  const r = await evaluate(`const al = [...mpfy.store.d.albums.values()].find((a) => a.name === 'Fari nella nebbia');
    mpfy.player.playContext({ type: 'album', id: al.id }, al.trackIds, 0);
    await new Promise((res) => setTimeout(res, 1500));
    const before = mpfy.player.gaplessSwaps;
    const d = mpfy.player.state.duration;
    mpfy.player.seek(d - 4);
    await new Promise((res) => setTimeout(res, 7000));
    const s = mpfy.player.state;
    const out = { before, swaps: mpfy.player.gaplessSwaps, index: s.index, playing: s.playing, at: Math.round(s.position), title: mpfy.store.track(s.items[s.index].id).title };
    mpfy.player.pause();
    return out;`);
  check(r.before === 0 && r.swaps === 1 && r.index === 1 && r.playing && r.title === 'Il guardiano del faro', `${tag} the end of a song: the next one was ready and goes on from it (${JSON.stringify(r)})`);
  // Casuale with "ripeti tutto": the end of the round is a new order, its first not the song that ended.
  const round = await evaluate(`const al = [...mpfy.store.d.albums.values()].find((a) => a.name === 'Fari nella nebbia');
    mpfy.player.setShuffle(true);
    for (let i = 0; i < 3 && mpfy.player.state.repeat !== 'all'; i++) mpfy.player.cycleRepeat();
    mpfy.player.playContext({ type: 'album', id: al.id }, al.trackIds, 0);
    await new Promise((res) => setTimeout(res, 1000));
    for (let i = 0; i < 4; i++) { mpfy.player.next(); await new Promise((res) => setTimeout(res, 600)); }
    const before = mpfy.player.state.items.map((it) => it.id);
    const random = Math.random;
    Math.random = () => 0;
    mpfy.player.seek(mpfy.player.state.duration - 2);
    await new Promise((res) => setTimeout(res, 5000));
    Math.random = random;
    const s = mpfy.player.state;
    const out = { repeat: s.repeat, index: s.index, last: before[4], first: s.items[0].id, same: JSON.stringify(s.items.map((it) => it.id)) === JSON.stringify(before), n: s.items.length, playing: s.playing };
    mpfy.player.pause();
    mpfy.player.setShuffle(false);
    while (mpfy.player.state.repeat !== 'off') mpfy.player.cycleRepeat();
    return out;`);
  check(round.repeat === 'all' && round.index === 0 && round.n === 5 && !round.same && round.first !== round.last && round.playing, `${tag} casuale and "ripeti tutto": a new round in a new order, not starting with the song that ended (${JSON.stringify(round)})`);
}

/** "Volume uniforme": a song measured louder than the target plays lower; off, as it is; on again. */
async function evenVolume(vp) {
  const { tag } = vpOf(vp);
  log(`\n== ${tag} the even volume`);
  await setViewport(vp);
  await fetch(`${base}/__mock/reset?sources=2`);
  await go(`${base}/?nosw`, 2000);
  await evaluate(`localStorage.removeItem('mpfy.volnorm'); return true;`);
  const on = await evaluate(`const al = [...mpfy.store.d.albums.values()].find((a) => a.name === 'Fari nella nebbia'); mpfy.player.setVolume(1); mpfy.player.playContext({ type: 'album', id: al.id }, al.trackIds, 0); await new Promise((r) => setTimeout(r, 1500)); return { norm: mpfy.player.volumeNorm, out: mpfy.player.outputVolume };`);
  check(on.norm === true && Math.abs(on.out - 0.5012) < 0.001, `${tag} on by default: a song 6 dB over the target plays at half the amplitude (${JSON.stringify(on)})`);
  await evaluate(`mpfy.navigate('/impostazioni'); return true;`);
  await sleep(1500);
  const row = await evaluate(`const r = document.querySelector('.volnorm-switch'); return r && { text: r.textContent, on: r.getAttribute('aria-checked'), section: r.closest('.set-section').querySelector('.set-section-title').textContent };`);
  check(!!row && /Volume uniforme/.test(row.text) && /Ogni brano allo stesso volume/.test(row.text) && row.on === 'true' && row.section === 'Qualità audio', `${tag} Impostazioni: "Volume uniforme" in "Qualità audio", on (${JSON.stringify(row)})`);
  await click('.volnorm-switch');
  await sleep(600);
  const off = await evaluate(`return { norm: mpfy.player.volumeNorm, out: mpfy.player.outputVolume, saved: localStorage.getItem('mpfy.volnorm') };`);
  check(off.norm === false && off.out === 1 && off.saved === '0', `${tag} off: the song playing takes its own volume at once, remembered (${JSON.stringify(off)})`);
  await click('.volnorm-switch');
  await sleep(600);
  const back = await evaluate(`const o = { norm: mpfy.player.volumeNorm, out: mpfy.player.outputVolume }; mpfy.player.pause(); return o;`);
  check(back.norm === true && Math.abs(back.out - 0.5012) < 0.001, `${tag} on again: lower again (${JSON.stringify(back)})`);
  // An album as an album: its loud song and its quiet one at one volume; the same two elsewhere at their own.
  const two = await evaluate(`const al = [...mpfy.store.d.albums.values()].find((a) => a.name === 'Città di sale');
    const ids = al.trackIds.slice(0, 2);
    const at = async (ctx, list, i) => { mpfy.player.playContext(ctx, list, i); await new Promise((r) => setTimeout(r, 1200)); return mpfy.player.outputVolume; };
    const out = { album: [await at({ type: 'album', id: al.id }, al.trackIds, 0), await at({ type: 'album', id: al.id }, al.trackIds, 1)], list: [await at({ type: 'search', id: 'x' }, ids, 0), await at({ type: 'search', id: 'x' }, ids, 1)] };
    mpfy.player.pause();
    return out;`);
  check(two.album[0] === two.album[1] && two.album[0] > 0.5012 && two.album[0] < 1 && Math.abs(two.list[0] - 0.5012) < 0.001 && two.list[1] === 1, `${tag} an album as an album: one volume for its loud and its quiet song; in a list each at its own (${JSON.stringify(two)})`);
}

/**
 * The genres: the families in Cerca before the artists, a family's page (its genres as chips,
 * "Tutto" on), a genre's page (its family as a link), Play in order and with "casuale", the
 * genres a query finds.
 */
async function genres(vp) {
  const { tag } = vpOf(vp);
  log(`\n== ${tag} the genres`);
  await setViewport(vp);
  await fetch(`${base}/__mock/reset?sources=2`);
  await go(`${base}/search?nosw`, 2000);
  const fams = await evaluate(`return { names: [...document.querySelectorAll('.view-search .genre-card .browse-name')].map((x) => x.textContent), titles: [...document.querySelectorAll('.view-search .section-title')].map((x) => x.textContent) };`);
  check(JSON.stringify(fams.names) === JSON.stringify(['Pop', 'Hip hop e rap', 'Elettronica e dance', 'Colonne sonore e musical', 'Jazz e blues']) && JSON.stringify(fams.titles.slice(0, 2)) === JSON.stringify(['Sfoglia tutto', 'Artisti']), `${tag} Cerca: the families with songs, in their order, then "Artisti" (${JSON.stringify(fams)})`);
  const order = await evaluate(`return [...document.querySelectorAll('.view-search .browse-card:not(.genre-card) .browse-name')].map((x) => x.textContent);`);
  check(order.indexOf('Gli Scogli') > order.indexOf('Orsa Minore') && order.indexOf('Orsa Minore') >= 0, `${tag} the artists by their sort name: "Gli Scogli" sorted as "Scogli" (${JSON.stringify(order)})`);
  await shot(`${tag}-genres-browse`);
  await overflowCheck(`${tag} genres browse`);
  await click('.view-search .genre-card');
  await sleep(1500);
  const page = () => evaluate(`return { path: location.pathname, kind: document.querySelector('.view-detail .hero-kind')?.textContent, title: document.querySelector('.view-detail .hero-title')?.textContent, meta: document.querySelector('.view-detail .hero-meta')?.textContent, chips: [...document.querySelectorAll('.view-detail .genre-chips .chip')].map((c) => c.textContent + (c.classList.contains('on') ? '*' : '')), songs: [...document.querySelectorAll('.view-detail .track-row')].length };`);
  let pg = await page();
  check(pg.path === '/genere/pop' && pg.kind === 'Genere' && pg.title === 'Pop' && JSON.stringify(pg.chips) === JSON.stringify(['Tutto*', 'J-pop', 'City pop']) && pg.songs === 10, `${tag} a family's page: "Genere", its genres most songs first, "Tutto" on, its 10 songs (${JSON.stringify(pg)})`);
  await shot(`${tag}-genres-family`);
  await overflowCheck(`${tag} genre page`);
  // Play, in order: album artist, album, number.
  await evaluate(`mpfy.player.setShuffle(false); return true;`);
  await click('.view-detail .play-big');
  await sleep(1200);
  let st = await evaluate(`const s = mpfy.player.state; return { ctx: s.context && s.context.type + ':' + s.context.id, n: s.items.length, titles: s.items.slice(0, 6).map((it) => mpfy.store.track(it.id).title) };`);
  check(st.ctx === 'genre:pop' && st.n === 10 && JSON.stringify(st.titles) === JSON.stringify(['Città di sale', 'Saline', 'Vento di terra', 'Ultimo traghetto', 'Mareggiata', 'Luce di posizione']), `${tag} Play on a family: its songs in order, album after album (${JSON.stringify(st)})`);
  // "Ordina per": by title the list and Play start from the first title; back to by album.
  await evaluate(`localStorage.removeItem('mpfy.genre.sort'); return true;`);
  await click('.view-detail .genre-sort');
  await sleep(700);
  await evaluate(`[...document.querySelectorAll('.layer-sheet .menu-item')].find((x) => x.textContent.includes('Titolo')).click(); return true;`);
  await sleep(900);
  const byTitle = await evaluate(`const rows = [...document.querySelectorAll('.view-detail .track-row .tr-title')].map((x) => x.textContent); return { first: rows[0], label: document.querySelector('.view-detail .genre-sort').textContent };`);
  // Something else playing, so the button starts the genre (on the genre playing it would go on).
  await evaluate(`const t = mpfy.store.lib.tracks[0]; mpfy.player.playContext({ type: 'search', id: 'x' }, [t.id], 0); await new Promise((r) => setTimeout(r, 500)); mpfy.player.pause(); return true;`);
  await click('.view-detail .play-big');
  await sleep(1200);
  const playedFirst = await evaluate(`const s = mpfy.player.state; mpfy.player.pause(); return mpfy.store.track(s.items[0].id).title;`);
  check(byTitle.first === 'Approdo' && byTitle.label === 'Titolo' && playedFirst === 'Approdo', `${tag} "Ordina per: Titolo" on a genre: the list and Play from the first title (${JSON.stringify(byTitle)}, played ${playedFirst})`);
  await evaluate(`localStorage.removeItem('mpfy.genre.sort'); return true;`);
  // A genre of it: its own page, the family a link back.
  await evaluate(`[...document.querySelectorAll('.view-detail .genre-chips .chip')].find((c) => c.textContent === 'City pop').click(); return true;`);
  await sleep(1500);
  pg = await page();
  check(pg.path === '/genere/pop.citypop' && pg.title === 'City pop' && /^Pop/.test(pg.meta || '') && JSON.stringify(pg.chips) === JSON.stringify(['Tutto', 'J-pop', 'City pop*']) && pg.songs === 5, `${tag} a genre's page: its 5 songs, "Pop" as a link, its chip on (${JSON.stringify(pg)})`);
  // Casuale: the shuffle on, Play takes every song of the genre once.
  await evaluate(`mpfy.player.setShuffle(true); return true;`);
  await click('.view-detail .play-big');
  await sleep(1200);
  st = await evaluate(`const s = mpfy.player.state; const ids = s.items.map((it) => it.id); return { ctx: s.context && s.context.type + ':' + s.context.id, n: ids.length, once: new Set(ids).size === ids.length, shuffle: s.shuffle };`);
  check(st.ctx === 'genre:pop.citypop' && st.n === 5 && st.once && st.shuffle, `${tag} casuale on a genre: each of its songs once (${JSON.stringify(st)})`);
  await evaluate(`mpfy.player.pause(); mpfy.player.setShuffle(false); return true;`);
  // One song of an album has a genre: its album and its artist's other album come along.
  await go(`${base}/genere/jazz?nosw`, 1500);
  const jazz = await evaluate(`return document.querySelectorAll('.view-detail .track-row').length;`);
  check(jazz === 10, `${tag} a song with no genre takes its album's, else its artist's: 10 in Jazz e blues (${jazz})`);
  await go(`${base}/search?nosw`, 1500);
  await click('.view-search .genre-card');
  await sleep(1200);
  await evaluate(`[...document.querySelectorAll('.view-detail .genre-chips .chip')].find((c) => c.textContent === 'City pop').click(); return true;`);
  await sleep(1200);
  // "Modifica informazioni": a song with no genre written one ("Genere", several by commas) joins it.
  const rotte = await evaluate(`return [...mpfy.store.d.albums.values()].find((a) => a.name === 'Rotte').id;`);
  await go(`${base}/album/${rotte}?nosw`, 1500);
  await click('.view-detail .track-row .tr-more');
  await sleep(700);
  await evaluate(`[...document.querySelectorAll('.layer-sheet .menu-item')].find((x) => x.textContent.includes('Modifica informazioni')).click(); return true;`);
  await sleep(700);
  const field = await evaluate(`const l = [...document.querySelectorAll('.dialog-fields .field')].find((x) => x.querySelector('.field-label').textContent === 'Genere'); if (!l) return null; const i = l.querySelector('input'); const was = i.value; i.value = 'Anime, J-Pop'; i.dispatchEvent(new Event('input', { bubbles: true })); return { was };`);
  await evaluate(`document.querySelector('.layer .btn-primary').click(); return true;`);
  await sleep(1500);
  const edited = await evaluate(`const t = mpfy.store.d.tracks.get(mpfy.store.d.albums.get('${rotte}').trackIds[0]); return t.genres;`);
  await go(`${base}/genere/colonne?nosw`, 1500);
  const inFamily = await evaluate(`return [...document.querySelectorAll('.view-detail .genre-chips .chip')].map((c) => c.textContent);`);
  check(field && field.was === '' && JSON.stringify(edited) === JSON.stringify(['Anime', 'J-Pop']) && inFamily.includes('Anime'), `${tag} "Modifica informazioni", "Genere": the song takes what was written (${JSON.stringify({ field, edited, inFamily })})`);
  await go(`${base}/search?nosw`, 1500);
  await click('.view-search .genre-card');
  await sleep(1200);
  await evaluate(`[...document.querySelectorAll('.view-detail .genre-chips .chip')].find((c) => c.textContent === 'City pop').click(); return true;`);
  await sleep(1200);
  // The chips take the page's place: Back leaves the genres (to Cerca), not the last chip.
  await evaluate(`history.back(); return true;`);
  await sleep(1200);
  const backTo = await evaluate(`return location.pathname;`);
  check(backTo === '/search', `${tag} Back from a genre reached by its chip: Cerca, not the family (${backTo})`);
  // A query finds the genres, by name and written any way.
  for (const [q, want] of [['city pop', 'City pop'], ['jpop', 'J-pop'], ['colonne', 'Colonne sonore e musical']]) {
    await go(`${base}/search?q=${encodeURIComponent(q)}&nosw`, 1500);
    const found = await evaluate(`return [...document.querySelectorAll('.view-search .search-genres .chip')].map((c) => c.textContent);`);
    check(found.includes(want), `${tag} the query "${q}" finds the genre "${want}" (${JSON.stringify(found)})`);
  }
}

/** The profile photo: the letter, the photo through the crop screen, the letter again, the gear. */
async function photo(vp) {
  const { tag, mobile } = vpOf(vp);
  log(`\n== ${tag} photo`);
  await setViewport(vp);
  await fetch(`${base}/__mock/reset?sources=2`);
  // No source speaks the people part here: the picture opens Impostazioni (social() has its own part).
  await fetch(`${base}/__mock/social?on=0`);
  // What the picture shows in each place: the letter, or the photo's address and whether it loaded.
  const pics = () =>
    evaluate(`const one = (sel) => { const a = document.querySelector(sel); if (!a) return null; const img = a.querySelector('img.avatar-photo'); const r = a.getBoundingClientRect();
        return { letter: (a.querySelector('.avatar-initial') || {}).textContent || null, src: img ? img.getAttribute('src') : null, loaded: !!img && img.complete && img.naturalWidth === 320, w: Math.round(r.width), h: Math.round(r.height) }; };
      return { home: one('.home-top .avatar-btn .avatar'), settings: one('.person-card .avatar'), profile: one('.photo-head .avatar') };`);
  await go(`${base}/?nosw`, 1500);
  const home0 = await evaluate(`const b = document.querySelector('.home-top .avatar-btn'); if (!b) return null; const r = b.getBoundingClientRect(); return { label: b.getAttribute('aria-label'), w: Math.round(r.width), h: Math.round(r.height), gear: !!b.querySelector('svg') };`);
  const p0 = await pics();
  check(!!home0 && home0.label === 'Impostazioni' && home0.w >= 44 && home0.h >= 44 && !home0.gear && p0.home?.letter === 'B' && p0.home.w === 32 && !p0.home.src, `${tag} Home without a photo: the letter B, 32 px in a 44 px target named "Impostazioni" (${JSON.stringify({ home0, pic: p0.home })})`);
  await shot(`${tag}-home-letter`);
  await click('.home-top .avatar-btn');
  await sleep(900);
  check((await evaluate('return location.pathname;')) === '/impostazioni', `${tag} the picture opens Impostazioni`);
  const p1 = await pics();
  check(p1.settings?.letter === 'B' && p1.settings.w === 56, `${tag} Impostazioni without a photo: the letter on the person's card, 56 px (${JSON.stringify(p1.settings)})`);
  await go(`${base}/impostazioni/profilo?nosw`, 1500);
  const p2 = await pics();
  const head = await evaluate(`const b = document.querySelector('.photo-head .photo-btn'); const t = document.querySelector('.set-top-title'); if (!b) return null; const r = b.getBoundingClientRect(); const q = t.getBoundingClientRect(); const g = document.querySelector('.photo-badge').getBoundingClientRect();
    return { label: b.getAttribute('aria-label'), off: Math.round(Math.abs(r.left + r.width / 2 - (q.left + q.width / 2))), badge: !!document.querySelector('.photo-badge svg'), badgeIn: g.right <= r.right + 1 && g.bottom <= r.bottom + 1 && g.left > r.left + r.width / 2 };`);
  check(p2.profile?.letter === 'B' && p2.profile.w === 112 && !!head && head.label === 'Foto del profilo' && head.off <= 2 && head.badge && head.badgeIn, `${tag} Profilo without a photo: the letter, 112 px, centred under the title, the pencil at its lower right (${JSON.stringify({ pic: p2.profile, head })})`);
  check((await text('.set-title-text')) === 'Nome | Codice del profilo | Esporta profilo | Recupero con password', `${tag} Profilo keeps its rows under the photo`);
  await overflowCheck(`${tag} profile with the photo`);
  await shot(`${tag}-profile-letter`);
  await click('.photo-head .photo-btn');
  await sleep(700);
  check((await text('.layer:not(.closing) .menu-item')) === 'Cambia foto', `${tag} the menu without a photo: "Cambia foto" (${await text('.layer:not(.closing) .menu-item')})`);
  // A picture made here, given to the picker the page opens.
  const file = path.join(outDir, `photo-${vp.width}.jpg`);
  const jpg = await evaluate(`const c = document.createElement('canvas'); c.width = 900; c.height = 600; const g = c.getContext('2d');
    const gr = g.createLinearGradient(0, 0, 900, 600); gr.addColorStop(0, '#4a3f86'); gr.addColorStop(1, '#b2bcc4'); g.fillStyle = gr; g.fillRect(0, 0, 900, 600);
    g.fillStyle = '#f2f2f2'; g.beginPath(); g.arc(450, 260, 120, 0, Math.PI * 2); g.fill(); g.fillRect(250, 420, 400, 180);
    const u8 = new Uint8Array(await new Response(await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9))).arrayBuffer()); let str = ''; for (let i = 0; i < u8.length; i += 8192) str += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return btoa(str);`);
  fs.writeFileSync(file, Buffer.from(jpg, 'base64'));
  await evaluate(`const click = HTMLInputElement.prototype.click; HTMLInputElement.prototype.click = function () { if (this.type !== 'file') return click.call(this); window.__picked = (window.__picked || 0) + 1; }; return true;`);
  await click('.layer:not(.closing) .menu-item', 'Cambia foto');
  await sleep(600);
  check((await evaluate('return window.__picked || 0;')) === 1 && (await setFiles('body > input[type=file]', [file])), `${tag} "Cambia foto" opens the picker`);
  await sleep(1200);
  const cropNow = await evaluate(`const p = document.querySelector('.layer:not(.closing) .panel-crop'); if (!p) return null; const c = p.querySelector('.crop-window').getBoundingClientRect(); const s = p.querySelector('.crop-save'); const x = p.querySelector('.panel-head .icon-btn');
    return { d: Math.round(c.width), round: getComputedStyle(p.querySelector('.crop-window')).borderTopLeftRadius, save: s && s.getAttribute('aria-label'), check: !!(s && s.querySelector('svg')), close: x && x.getAttribute('aria-label') };`);
  check(!!cropNow && cropNow.d === 280 && cropNow.round === '50%' && cropNow.save === 'Salva' && cropNow.check && cropNow.close === 'Chiudi', `${tag} the crop screen: a 280 px circle, "Chiudi" and "Salva" (${JSON.stringify(cropNow)})`);
  await overflowCheck(`${tag} the crop screen`);
  await shot(`${tag}-photo-crop`);
  await click('.layer:not(.closing) .crop-save');
  await sleep(1800);
  const st = await (await fetch(`${base}/__mock/state`)).json();
  const hash = st.photo && st.photo.hash;
  const want = `/local/profile/photo?v=${hash}`;
  const p3 = await pics();
  const savedToast = await evaluate(`return [...document.querySelectorAll('.toast')].map((t) => t.textContent).join('|');`);
  check(!!hash && st.photoPuts === 1 && st.photo.size <= 48 * 1024 && !(await evaluate(`return !!document.querySelector('.layer:not(.closing)');`)) && /Foto aggiornata/.test(savedToast), `${tag} "Salva": one upload of at most 48 KB (${st.photo && st.photo.size} bytes), the screen closes, "Foto aggiornata" (${savedToast})`);
  check(p3.profile?.src === want && p3.profile.loaded && !p3.profile.letter, `${tag} Profilo shows the photo (${JSON.stringify(p3.profile)})`);
  const savedBytes = Buffer.from(await (await fetch(`${base}/local/profile/photo`)).arrayBuffer());
  if (mobile) {
    // A camera's picture, 4000 x 3000 and full of detail: it still ends as 320 x 320 under 48 KB.
    const big = path.join(outDir, `photo-big-${vp.width}.jpg`);
    const jpgBig = await evaluate(`const c = document.createElement('canvas'); c.width = 4000; c.height = 3000; const g = c.getContext('2d'); const d = g.createImageData(4000, 3000);
      let s = 7; for (let i = 0; i < d.data.length; i += 4) { s = (s * 1103515245 + 12345) & 0x7fffffff; d.data[i] = s & 255; d.data[i + 1] = (s >> 8) & 255; d.data[i + 2] = (s >> 16) & 255; d.data[i + 3] = 255; }
      g.putImageData(d, 0, 0);
      const u8 = new Uint8Array(await new Response(await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92))).arrayBuffer()); let str = ''; for (let i = 0; i < u8.length; i += 8192) str += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return btoa(str);`);
    fs.writeFileSync(big, Buffer.from(jpgBig, 'base64'));
    await click('.photo-head .photo-btn');
    await sleep(700);
    await evaluate(`const click = HTMLInputElement.prototype.click; HTMLInputElement.prototype.click = function () { if (this.type !== 'file') return click.call(this); window.__picked = (window.__picked || 0) + 1; }; return true;`);
    await click('.layer:not(.closing) .menu-item', 'Cambia foto');
    await sleep(600);
    await setFiles('body > input[type=file]', [big]);
    await sleep(2500);
    await click('.layer:not(.closing) .crop-save');
    await sleep(2500);
    const bigBytes = Buffer.from(await (await fetch(`${base}/local/profile/photo`)).arrayBuffer());
    const jpegSize = (b) => {
      let i = 2;
      while (i + 9 < b.length && b[i] === 0xff) {
        const m = b[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return `${b.readUInt16BE(i + 7)}x${b.readUInt16BE(i + 5)}`;
        i += 2 + b.readUInt16BE(i + 2);
      }
      return null;
    };
    check(fs.statSync(big).size > 1024 * 1024 && jpegSize(bigBytes) === '320x320' && bigBytes.length <= 48 * 1024 && !bigBytes.equals(savedBytes), `${tag} a 4000 x 3000 picture of ${Math.round(fs.statSync(big).size / 1024)} KB ends as a ${jpegSize(bigBytes)} JPEG of ${Math.round(bigBytes.length / 1024)} KB`);
    // The first photo back, for the checks that follow.
    await fetch(`${base}/local/profile/photo`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: savedBytes });
    await evaluate('await mpfy.profile.refresh(); return true;');
  }
  await shot(`${tag}-profile-photo`);
  await go(`${base}/?nosw`, 1500);
  const p4 = await pics();
  check(p4.home?.src === want && p4.home.loaded && p4.home.w === 32, `${tag} Home shows the photo, 32 px (${JSON.stringify(p4.home)})`);
  await shot(`${tag}-home-photo`);
  await go(`${base}/impostazioni?nosw`, 1500);
  const p5 = await pics();
  check(p5.settings?.src === want && p5.settings.loaded && p5.settings.w === 56, `${tag} Impostazioni shows the photo, 56 px (${JSON.stringify(p5.settings)})`);
  if (mobile) await shot(`${tag}-settings-photo`);
  // Its bytes gone while the profile still names it: the letter.
  await fetch(`${base}/__mock/core?photoGone=1`);
  await go(`${base}/?nosw`, 1500);
  const gone = await pics();
  await fetch(`${base}/__mock/core?photoGone=0`);
  check(gone.home?.letter === 'B' && !gone.home.src, `${tag} a photo whose bytes do not load: the letter instead (${JSON.stringify(gone.home)})`);
  // Taken away: the letter everywhere.
  await go(`${base}/impostazioni/profilo?nosw`, 1500);
  await click('.photo-head .photo-btn');
  await sleep(700);
  check((await text('.layer:not(.closing) .menu-item')) === 'Cambia foto | Rimuovi foto', `${tag} the menu with a photo: "Cambia foto | Rimuovi foto"`);
  await click('.layer:not(.closing) .menu-item', 'Rimuovi foto');
  await sleep(1200);
  const p6 = await pics();
  const st2 = await (await fetch(`${base}/__mock/state`)).json();
  const removedToast = await evaluate(`return [...document.querySelectorAll('.toast')].map((t) => t.textContent).join('|');`);
  check(!st2.photo && p6.profile?.letter === 'B' && !p6.profile.src && /Foto rimossa/.test(removedToast), `${tag} "Rimuovi foto": "Foto rimossa", the letter again on Profilo (${JSON.stringify([p6.profile, removedToast])})`);
  await go(`${base}/?nosw`, 1500);
  const p7 = await pics();
  await go(`${base}/impostazioni?nosw`, 1500);
  const p8 = await pics();
  check(p7.home?.letter === 'B' && !p7.home.src && p8.settings?.letter === 'B' && !p8.settings.src, `${tag} and in Home and Impostazioni (${JSON.stringify([p7.home, p8.settings])})`);
  // Set and taken away on another device while Home is open: its header follows.
  await go(`${base}/?nosw`, 1500);
  await fetch(`${base}/local/profile/photo`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: savedBytes });
  await evaluate('await mpfy.profile.refresh(); return true;');
  await sleep(900);
  const live = await pics();
  await fetch(`${base}/local/profile/photo`, { method: 'DELETE' });
  await evaluate('await mpfy.profile.refresh(); return true;');
  await sleep(900);
  const live2 = await pics();
  check(live.home?.src === want && live.home.loaded && live2.home?.letter === 'B' && !live2.home.src, `${tag} Home open while the photo comes and goes elsewhere: its header follows (${JSON.stringify([live.home, live2.home])})`);
  // A core from before profiles: the gear, as before.
  await fetch(`${base}/__mock/core?noProfiles=1`);
  await go(`${base}/?nosw`, 1500);
  const gear = await evaluate(`const b = [...document.querySelectorAll('.home-top button')].find((x) => x.getAttribute('aria-label') === 'Impostazioni'); return b ? { avatar: !!b.querySelector('.avatar'), svg: !!b.querySelector('svg') } : null;`);
  await fetch(`${base}/__mock/core?noProfiles=0`);
  check(!!gear && !gear.avatar && gear.svg, `${tag} a core without profiles: the gear in Home (${JSON.stringify(gear)})`);
}

/**
 * The people: your picture in Home (Amici, or Impostazioni with no social source), Amici (you,
 * "Recenti", "Impostazioni", the list by name with what they play, the tags on clashes only, the
 * search by name and ID, no result), a person's page (hero, ID, what they play and a tap that plays
 * it, the shelf of what your library has, your own page, invisible, a page nobody knows),
 * Recenti (days across midnight and a year, the name of what each play came from, two plays of a
 * song two rows, the next pages near the end, a tap in its context and alone, the library's 50
 * when the principal is older, nothing at all), Impostazioni > Social (the dialog, the held rows,
 * a refusal taken back, a private session ending), the PC's right column and what the page
 * reports as playing (never from bridge 5).
 */
async function people(vp) {
  const { mobile, tag } = vpOf(vp);
  log(`\n== ${tag} the people`);
  await setViewport(vp);
  await fetch(`${base}/__mock/reset?sources=2`);
  // The people part as it is without chats (sources at social 1): the chats have their own part.
  await fetch(`${base}/__mock/chat?level=1`);
  const st0 = await (await fetch(`${base}/__mock/state`)).json();
  const ME = st0.profile.id;
  const P = Object.fromEntries(st0.social.people.map((x) => [x.pid, x]));
  const giulia = P['MZ0Y-1MNK'];
  const marco = P['DN51-Y31E'];
  await go(`${base}/?nosw`, 1500);
  await evaluate(`try { localStorage.removeItem('mpfy.friends.side'); } catch {} return true;`);
  await go(`${base}/?nosw`, 1800);
  const pathNow = () => evaluate('return location.pathname + location.search;');

  // ---- Home: your picture ----
  const btn = await evaluate(`const b = document.querySelector('.home-top .avatar-btn'); if (!b) return null; const r = b.getBoundingClientRect(); const a = b.querySelector('.avatar').getBoundingClientRect(); const top = document.querySelector('.home-top');
    return { label: b.getAttribute('aria-label'), title: b.title, w: Math.round(r.width), av: Math.round(a.width), last: top.lastElementChild === b, gear: !!top.querySelector('.ic-settings') };`);
  check(!!btn && btn.label === 'Amici e impostazioni' && btn.title === 'Amici e impostazioni' && btn.w >= 44 && btn.av === 32 && btn.last && !btn.gear, `${tag} Home: your picture (32 px in a 44 px target) "Amici e impostazioni" ends the top bar, no gear (${JSON.stringify(btn)})`);
  if (mobile) {
    await click('.home-top .avatar-btn');
    await sleep(900);
    check((await pathNow()) === '/amici' && !!(await evaluate(`return !!document.querySelector('#main > .view-friends');`)), `${tag} the picture opens Amici`);
  } else {
    await click('.home-top .avatar-btn');
    await sleep(900);
    const open = await evaluate(`const a = document.querySelector('.friends-side'); const b = document.querySelector('.home-top .avatar-btn'); const cols = getComputedStyle(document.getElementById('app')).gridTemplateColumns.split(' ').length;
      return { path: location.pathname, shown: !!a && !a.hidden && a.getBoundingClientRect().width > 200, label: a && a.getAttribute('aria-label'), cols, open: b.classList.contains('is-open'), pressed: b.getAttribute('aria-pressed'), saved: localStorage.getItem('mpfy.friends.side'), count: document.querySelectorAll('.friends-side').length };`);
    check(open.path === '/' && open.shown && open.label === 'Amici' && open.cols === 3 && open.open && open.pressed === 'true' && open.saved === '1' && open.count === 1, `${tag} the picture opens the right column in place, the picture ringed and pressed, kept as "1" (${JSON.stringify(open)})`);
  }

  // ---- no source speaks the people part: Impostazioni ----
  await fetch(`${base}/__mock/social?on=0&clear=1`);
  await go(`${base}/?nosw`, 1800);
  const old = await evaluate(`const b = document.querySelector('.home-top .avatar-btn'); return b && { label: b.getAttribute('aria-label'), title: b.title, column: !!document.querySelector('.app.with-friends') };`);
  await click('.home-top .avatar-btn');
  await sleep(900);
  check(!!old && old.label === 'Impostazioni' && old.title === 'Impostazioni' && !old.column && (await pathNow()) === '/impostazioni', `${tag} no social source: the picture says "Impostazioni" and opens it, no column (${JSON.stringify(old)})`);
  check((await text('.set-section-title')) === 'Fonti musicali | Qualità audio | Memoria | Informazioni', `${tag} no social source: no Social section`);
  const asked = (await (await fetch(`${base}/__mock/state`)).json()).social;
  check(asked.peopleGets === 0, `${tag} no social source: the people are never asked (${asked.peopleGets})`);
  await fetch(`${base}/__mock/social?on=1`);

  // ---- Amici ----
  await go(`${base}/amici?nosw`, 1800);
  const top = await evaluate(`const t = document.querySelector('.view-friends .set-top'); return { back: t.querySelector('.back-btn').getAttribute('aria-label'), title: t.querySelector('.set-top-title').textContent, find: t.querySelector('.top-action').getAttribute('aria-label') };`);
  check(top.back === 'Indietro' && top.title === 'Amici' && top.find === 'Cerca negli amici', `${tag} Amici: back, "Amici", "Cerca negli amici" (${JSON.stringify(top)})`);
  const me = await evaluate(`const m = document.querySelector('.view-friends .me'); const main = m.querySelector('.me-main'); const av = main.querySelector('.avatar').getBoundingClientRect();
    return { label: main.getAttribute('aria-label'), href: main.getAttribute('href'), name: main.querySelector('.me-name').textContent, sub: main.querySelector('.me-sub').textContent, av: Math.round(av.width), rows: [...m.querySelectorAll('.me-row')].map((r) => r.textContent + '>' + r.getAttribute('href')) };`);
  check(me.label === 'Il tuo profilo' && me.href === `/persona/${ME}` && me.name === 'Bacca' && me.sub === 'Visualizza profilo' && me.av === 48 && me.rows.join(',') === 'Recenti>/recenti,Impostazioni>/impostazioni', `${tag} Amici starts with you (48 px, "Visualizza profilo" to your page), then "Recenti" and "Impostazioni" (${JSON.stringify(me)})`);
  const rowsOf = (scope) =>
    evaluate(`return [...document.querySelectorAll(${JSON.stringify(scope)} + ' .ami-row')].map((r) => ({ name: r.querySelector('.ami-name').textContent, tag: (r.querySelector('.id-tag') || {}).textContent || '', line: (r.querySelector('.ami-line-text') || {}).textContent || '', hist: !!r.querySelector('.ami-line .ic-history'), eq: !!r.querySelector('.ami-line .eq'), badge: !!r.querySelector('.now-badge'), time: (r.querySelector('.ami-time') || {}).textContent || '', label: r.getAttribute('aria-label'), href: r.getAttribute('href'), img: (r.querySelector('.avatar img') || {}).src || '', letter: (r.querySelector('.avatar-initial') || {}).textContent || '', av: Math.round(r.querySelector('.avatar').getBoundingClientRect().width) }));`);
  const rows = await rowsOf('.view-friends');
  const names = rows.map((r) => r.name + (r.tag ? `:${r.tag}` : '')).join(',');
  check(names === 'Bacca:58XM,Giulia:MZ0Y,Giulia:RERY,Luca,Marco,Sara', `${tag} one list by name, the 4 characters of the ID only where a name clashes (with you too), the person seen only in a chat absent: ${names}`);
  const g = rows.find((r) => r.tag === 'MZ0Y');
  const s = rows.find((r) => r.name === 'Sara');
  const b2 = rows.find((r) => r.name === 'Bacca');
  const l = rows.find((r) => r.name === 'Luca');
  check(g.eq && g.badge && g.line === 'Onda quadraDelta Nadir' && !g.time && g.img.includes(`/local/people/${giulia.id}/photo?v=${giulia.photo}`), `${tag} while she plays: the badge, the equalizer, title and artist, no time, her photo (${JSON.stringify(g)})`);
  check(s.hist && !s.eq && !s.badge && s.line === 'Finestre acceseClara Vento' && /^(lun|mar|mer|gio|ven|sab|dom|\d{1,2}\/\d{1,2})$/.test(s.time) && b2.time === '2 ore fa', `${tag} what they last played: the history glyph, title and artist, how long ago on the right (${s.time}, ${b2.time})`);
  check(!l.line && !l.time && l.letter === 'L' && rows.every((r) => r.av === 48) && rows.every((r) => r.label === `Profilo di ${r.name}`), `${tag} nothing played: the name alone; the letter on grey without a photo; 48 px; "Profilo di <nome>"`);
  check(!(await evaluate(`return !!document.querySelector('.view-friends .empty, .view-friends .ami-none');`)), `${tag} no text besides the list`);
  await overflowCheck(`${tag} Amici`);
  await barsCheck(`${tag} Amici`, mobile);
  await shot(`${tag}-amici`);
  await click('.view-friends .ami-row', 'Sara');
  await sleep(1000);
  check((await pathNow()) === `/persona/${P['H8NM-RVCE'].id}`, `${tag} a row opens the person's page`);
  await systemBack();
  await sleep(400);

  // ---- the search ----
  await click('.view-friends .set-top .top-action');
  await sleep(900);
  const sb = await evaluate(`const i = document.querySelector('.view-friends .bar-search input'); const c = document.querySelector('.view-friends .bar-search .search-clear'); return { path: location.pathname + location.search, ph: i && i.placeholder, focused: document.activeElement === i, clear: c && c.hidden, clearLabel: c && c.getAttribute('aria-label'), me: !!document.querySelector('.view-friends .me') };`);
  check(sb.path === '/amici?q=' && sb.ph === 'Cerca per nome o ID' && sb.focused && sb.clear === true && sb.clearLabel === 'Cancella' && !sb.me, `${tag} the search takes the top bar: "Cerca per nome o ID", focused, "Cancella" only with text (${JSON.stringify(sb)})`);
  const find = async (q) => {
    await typeInto('.view-friends .bar-search input', q);
    await sleep(400);
    return evaluate(`return { path: location.pathname + location.search, rows: [...document.querySelectorAll('.view-friends .ami-row')].map((r) => r.querySelector('.ami-name').textContent + ((r.querySelector('.id-tag') || {}).textContent || '')), none: (document.querySelector('.view-friends .ami-none') || {}).textContent || '', clear: document.querySelector('.view-friends .search-clear').hidden };`);
  };
  const f1 = await find('gi');
  check(f1.rows.join(',') === 'GiuliaMZ0Y,GiuliaRERY' && f1.path === '/amici?q=gi' && f1.clear === false, `${tag} "gi": both Giulia, the address follows (${JSON.stringify(f1)})`);
  const byId = [await find('MZ0Y-1MNK'), await find('mz0y1mnk'), await find('MZOY-IMNK')].map((f) => f.rows.join(','));
  check(byId.every((x) => x === 'GiuliaMZ0Y'), `${tag} by ID with and without the hyphen, with O and I typed: ${byId.join(' / ')}`);
  const f3 = await find('xyz');
  check(f3.rows.length === 0 && f3.none === 'Nessun risultato per "xyz"', `${tag} nothing found: ${f3.none}`);
  await shot(`${tag}-amici-cerca`);
  await click('.view-friends .search-clear');
  await sleep(400);
  const f4 = await evaluate(`return { n: document.querySelectorAll('.view-friends .ami-row').length, clear: document.querySelector('.view-friends .search-clear').hidden };`);
  check(f4.n === 6 && f4.clear, `${tag} "Cancella": everyone again, the button gone (${JSON.stringify(f4)})`);
  await click('.view-friends .bar-search .back-btn');
  await sleep(900);
  const backTo = await pathNow();
  check(/^\/amici(\?nosw)?$/.test(backTo) && !!(await evaluate(`return !!document.querySelector('.view-friends .me');`)), `${tag} back from the search: Amici as it was (${backTo})`);

  // ---- a person's page ----
  await go(`${base}/persona/${giulia.id}?nosw`, 2200);
  const hero = await evaluate(`const v = document.querySelector('.view-detail.detail-person'); if (!v) return null; const id = v.querySelector('.hero-id'); const now = v.querySelector('.meta-now-line');
    return { kind: v.querySelector('.hero-kind').textContent, name: v.querySelector('.hero-title').textContent, id: id.textContent, idLabel: id.getAttribute('aria-label'), now: now && now.textContent, nowLabel: now && now.getAttribute('aria-label'), img: (v.querySelector('.person-hero-avatar img') || {}).src || '', hero: getComputedStyle(v).getPropertyValue('--hero').trim(),
      shelf: [...v.querySelectorAll('.shelf .card')].map((c) => c.querySelector('.card-title').textContent + '/' + c.querySelector('.card-sub').textContent + (c.classList.contains('round') ? '/round' : '')), title: (v.querySelector('.shelf-head h2') || {}).textContent };`);
  check(!!hero && hero.kind === 'Profilo' && hero.name === 'Giulia' && hero.id === 'MZ0Y-1MNK' && hero.idLabel === 'ID del profilo' && hero.img.includes(`/local/people/${giulia.id}/photo`) && !!hero.hero, `${tag} her page: "Profilo", the name, the ID, the photo, a colour (${JSON.stringify(hero && { ...hero, shelf: undefined })})`);
  check(hero.now === 'Onda quadraDelta Nadir' && hero.nowLabel === 'Riproduci Onda quadra di Delta Nadir', `${tag} what she plays now under the ID (${hero.now})`);
  check(hero.title === 'Ascoltati di recente' && hero.shelf.join(',') === 'Frequenze/Delta Nadir,Orsa Minore/Artista/round,Costellazioni/Orsa Minore', `${tag} "Ascoltati di recente": albums, the artist of a play from an artist's page (round), only what your library has, once each: ${hero.shelf.join(', ')}`);
  await overflowCheck(`${tag} a person's page`);
  await shot(`${tag}-persona`);
  await click('.detail-person .meta-now-line');
  await sleep(1500);
  const played1 = await evaluate(`const t = mpfy.player.currentTrack(); return { title: t && t.title, ctx: mpfy.player.state.context && mpfy.player.state.context.type, n: mpfy.player.state.items.length };`);
  check(played1.title === 'Onda quadra' && played1.ctx === 'library' && played1.n === 1, `${tag} a tap on it plays the same song from your library, alone (${JSON.stringify(played1)})`);
  await evaluate('mpfy.player.pause(); return true;');
  await go(`${base}/persona/${marco.id}?nosw`, 2000);
  await click('.detail-person .meta-now-line');
  await sleep(1500);
  const played2 = await evaluate(`const t = mpfy.player.currentTrack(); return t && t.title;`);
  check(played2 === 'Stella polare', `${tag} a song your library has under another id: found by title and artist (${played2})`);
  await evaluate('mpfy.player.pause(); return true;');
  await go(`${base}/persona/${ME}?nosw`, 2000);
  const own = await evaluate(`const v = document.querySelector('.detail-person'); return { name: v.querySelector('.hero-title').textContent, id: v.querySelector('.hero-id').textContent, now: !!v.querySelector('.meta-now-line'), actions: !!v.querySelector('.actions') };`);
  check(own.name === 'Bacca' && own.id === '4BF2-ASGW' && !own.actions, `${tag} your own page, as the others see you, no actions (${JSON.stringify(own)})`);
  await fetch(`${base}/local/social`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invisible: true }) });
  await go(`${base}/persona/${ME}?nosw`, 2000);
  const hid = await evaluate(`const v = document.querySelector('.detail-person'); return { name: v.querySelector('.hero-title').textContent, now: !!v.querySelector('.meta-now-line'), shelf: !!v.querySelector('.shelf') };`);
  check(hid.name === 'Bacca' && !hid.now && !hid.shelf, `${tag} invisible: your page shows only the hero (${JSON.stringify(hid)})`);
  await fetch(`${base}/local/social`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invisible: false }) });
  for (const bad of ['ffffffffffffffffffffffffffffffff', 'xyz']) {
    await go(`${base}/persona/${bad}?nosw`, 1800);
    const miss = await evaluate(`const v = document.querySelector('.detail-person'); return v && { h2: (v.querySelector('.empty h2') || {}).textContent, back: !!v.querySelector('.topbar .back-btn'), hero: !!v.querySelector('.hero') };`);
    check(!!miss && miss.h2 === 'Profilo non trovato' && miss.back && !miss.hero, `${tag} a person nobody knows (${bad}): "Profilo non trovato" under the top bar (${JSON.stringify(miss)})`);
  }

  // ---- Recenti ----
  await fetch(`${base}/__mock/social?history=262&step=2000&midnight=1&clear=1`);
  await go(`${base}/recenti?nosw`, 2200);
  const days = () => evaluate(`return [...document.querySelectorAll('.view-recents .chat-day')].map((d) => d.textContent);`);
  const r1 = await evaluate(`const H = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--vrow-track')); const plays = [...document.querySelectorAll('.view-recents .vlist')].reduce((s, l) => s + Math.round(l.offsetHeight / H), 0); return { title: document.querySelector('.view-recents .set-top-title').textContent, rows: plays };`);
  const d1 = await days();
  check(r1.title === 'Recenti' && d1[0] === 'Oggi' && d1[1] === 'Ieri' && r1.rows > 50 && r1.rows <= 102, `${tag} Recenti: "Oggi", "Ieri" across midnight, then the dates; the first 100 (${r1.rows} rows, ${d1.slice(0, 4).join(', ')})`);
  check(d1.slice(2).every((d) => /^\d{1,2} [a-z]+( \d{4})?$/.test(d)) && new Set(d1).size === d1.length, `${tag} one label per day, the date in words: ${d1.slice(2, 6).join(', ')}`);
  const subs = await evaluate(`return [...document.querySelectorAll('.view-recents .track-row')].slice(0, 12).map((r) => r.querySelector('.tr-sub-text').textContent);`);
  check(subs.some((x) => /Fari nella nebbia|Città di sale|Costellazioni|Perché il mare|Ritorni|Notturno blu|Così lontano|Frequenze|Bassa marea/.test(x)) && subs.some((x) => !/nebbia|sale|Costellazioni|mare|Ritorni|blu|lontano|Frequenze|marea/.test(x)), `${tag} each row: the artist, then what it was played from (none for the library): ${subs.slice(0, 4).join(' / ')}`);
  for (let i = 0; i < 12; i++) {
    await evaluate(`const m = document.getElementById('main'); m.scrollTop = m.scrollHeight; return true;`);
    await sleep(500);
  }
  const all = await evaluate(`const H = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--vrow-track')); const plays = [...document.querySelectorAll('.view-recents .vlist')].reduce((s, l) => s + Math.round(l.offsetHeight / H), 0); const rows = [...document.querySelectorAll('.view-recents .track-row')]; const titles = rows.map((r) => r.querySelector('.tr-title-text').textContent); const counts = {}; for (const t of titles) counts[t] = (counts[t] || 0) + 1; return { n: plays, twice: Object.values(counts).some((c) => c > 1) };`);
  const d2 = await days();
  const gets = (await (await fetch(`${base}/__mock/state`)).json()).social.recentsGets;
  check(all.n >= 250 && d2.some((d) => / 20\d\d$/.test(d)) && gets.length === 3 && gets[0].before === null && gets.slice(1).every((x) => Number(x.before) > 0), `${tag} the next 100 near the end, until the last; another year shows its year; the same song twice is two rows (${all.n} rows, ${gets.length} pages, ${d2[d2.length - 1]})`);
  check(all.twice, `${tag} a song played twice: two rows`);
  await evaluate(`document.getElementById('main').scrollTop = 0; return true;`);
  await sleep(400);
  await shot(`${tag}-recenti`);
  const albumRow = await evaluate(`const rows = [...document.querySelectorAll('.view-recents .track-row')]; const i = rows.findIndex((r) => r.querySelector('.tr-sub-text').children.length > 0); return i;`);
  await evaluate(`[...document.querySelectorAll('.view-recents .track-row')][${albumRow}].querySelector('.tr-main').click(); return true;`);
  await sleep(1500);
  const inCtx = await evaluate(`return { ctx: mpfy.player.state.context && mpfy.player.state.context.type, n: mpfy.player.state.items.length, title: mpfy.player.currentTrack() && mpfy.player.currentTrack().title, row: [...document.querySelectorAll('.view-recents .track-row')][${albumRow}].querySelector('.tr-title-text').textContent };`);
  check(inCtx.ctx === 'album' && inCtx.n > 1 && inCtx.title === inCtx.row, `${tag} a tap plays it in its album from that song (${JSON.stringify(inCtx)})`);
  const libRow = await evaluate(`const rows = [...document.querySelectorAll('.view-recents .track-row')]; return rows.findIndex((r) => r.querySelector('.tr-sub-text').children.length === 0);`);
  await evaluate(`[...document.querySelectorAll('.view-recents .track-row')][${libRow}].querySelector('.tr-main').click(); return true;`);
  await sleep(1500);
  const alone = await evaluate(`return { ctx: mpfy.player.state.context && mpfy.player.state.context.type, n: mpfy.player.state.items.length };`);
  check(alone.ctx === 'library' && alone.n === 1, `${tag} played from the library: alone (${JSON.stringify(alone)})`);
  await evaluate('mpfy.player.pause(); return true;');
  await fetch(`${base}/__mock/social?recents=0`);
  await go(`${base}/recenti?nosw`, 2000);
  const libOnly = await evaluate(`const lib = mpfy.store.lib.recents.filter((r) => mpfy.store.track(r.trackId)).length; const H = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--vrow-track')); const plays = [...document.querySelectorAll('.view-recents .vlist')].reduce((s, l) => s + Math.round(l.offsetHeight / H), 0); return { rows: plays, lib };`);
  for (let i = 0; i < 3; i++) {
    await evaluate(`const m = document.getElementById('main'); m.scrollTop = m.scrollHeight; return true;`);
    await sleep(400);
  }
  const gets2 = (await (await fetch(`${base}/__mock/state`)).json()).social.recentsGets;
  check(libOnly.rows === libOnly.lib && libOnly.rows > 0 && gets2.length === 4 && gets2[3].answered === false, `${tag} a principal older than Recenti: the library's own plays, no more pages (${JSON.stringify(libOnly)}, asked ${gets2.length - 3} time)`);
  await fetch(`${base}/__mock/social?recents=1`);
  await fetch(`${base}/__mock/offline?source=${mi.id}&on=1`);
  await go(`${base}/recenti?nosw`, 2500);
  const away = await evaluate(`const lib = mpfy.store.lib.recents.filter((r) => mpfy.store.track(r.trackId)).length; const H = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--vrow-track')); const plays = [...document.querySelectorAll('.view-recents .vlist')].reduce((s, l) => s + Math.round(l.offsetHeight / H), 0); return { rows: plays, lib };`);
  await fetch(`${base}/__mock/offline?source=${mi.id}&on=0`);
  const gets3 = (await (await fetch(`${base}/__mock/state`)).json()).social.recentsGets.length;
  check(away.rows === away.lib && away.rows > 0 && gets3 === 4, `${tag} the principal away: the library's own plays, nothing asked of it (${JSON.stringify(away)})`);
  await fetch(`${base}/__mock/social?history=0`);
  await go(`${base}/recenti?nosw`, 2000);
  const empty = await evaluate(`const v = document.querySelector('.view-recents'); return { rows: v.querySelectorAll('.track-row').length, text: [...v.children].filter((c) => !c.matches('.set-top')).map((c) => c.textContent).join('').trim() };`);
  check(empty.rows === 0 && empty.text === '', `${tag} nothing played: nothing under the top bar (${JSON.stringify(empty)})`);

  // ---- Impostazioni > Social ----
  await fetch(`${base}/__mock/social?clear=1`);
  await go(`${base}/impostazioni?nosw`, 1800);
  await watchToasts();
  const sw = () => evaluate(`return [...document.querySelectorAll('.social-section .switch-row')].map((r) => ({ t: r.querySelector('.set-title-text').textContent, sub: (r.querySelector('.set-sub') || {}).textContent || '', on: r.getAttribute('aria-checked'), held: r.classList.contains('is-held') && r.getAttribute('aria-disabled') === 'true', role: r.getAttribute('role'), ic: (r.querySelector('.set-icon svg') || { getAttribute: () => '' }).getAttribute('class') }));`);
  const s0 = await sw();
  check(s0.map((x) => x.t).join(' | ') === 'Invisibile | Mostra cosa ascolto | Sessione privata | Mostra i miei ascolti recenti' && s0.every((x) => x.role === 'switch'), `${tag} Social: the four switches (${s0.map((x) => x.t).join(', ')})`);
  check(s0[0].sub === 'Sparisci dalle liste degli amici' && s0[1].sub === '' && s0[2].sub === 'Nasconde la tua attività per 6 ore' && s0[3].sub === '' && s0.map((x) => x.on).join() === 'false,true,false,true', `${tag} their lines and states`);
  check(/ic-invisible/.test(s0[0].ic) && /ic-eq/.test(s0[1].ic) && /ic-lock/.test(s0[2].ic) && /ic-history/.test(s0[3].ic), `${tag} their icons: invisible, eq, lock, history`);
  await evaluate(`document.querySelector('.social-section').scrollIntoView(); return true;`);
  await sleep(300);
  await shot(`${tag}-social`);
  await click('.social-section .social-invisible');
  await sleep(700);
  const dlg = { title: await text('.layer-dialog:not(.closing) .dialog-title'), text: await text('.layer-dialog:not(.closing) .dialog-text'), btns: await text('.layer-dialog:not(.closing) .btn') };
  check(dlg.title === 'Diventare invisibile?' && dlg.text === 'Nessuno ti vedrà tra gli amici, su nessuna fonte. Chi gestisce una fonte vede comunque che la usi.' && dlg.btns === 'Annulla | Diventa invisibile', `${tag} turning "Invisibile" on asks once: ${JSON.stringify(dlg)}`);
  await shot(`${tag}-invisibile`);
  await click('.layer-dialog:not(.closing) .btn', 'Annulla');
  await sleep(700);
  const st1 = (await (await fetch(`${base}/__mock/state`)).json()).social;
  check((await sw())[0].on === 'false' && st1.patches.length === 0, `${tag} "Annulla": still visible, nothing sent`);
  await click('.social-section .social-invisible');
  await sleep(700);
  await click('.layer-dialog:not(.closing) .btn-primary');
  await sleep(1000);
  const s1 = await sw();
  const st2 = (await (await fetch(`${base}/__mock/state`)).json()).social;
  check(s1[0].on === 'true' && s1.slice(1).every((x) => x.held) && s1.slice(1).map((x) => x.on).join() === 'true,false,true' && st2.privacy.invisible === true, `${tag} "Diventa invisibile": on, the three below held with their own states (${s1.map((x) => x.on + (x.held ? 'H' : '')).join()})`);
  await click('.social-section .social-now');
  await sleep(600);
  const st3 = (await (await fetch(`${base}/__mock/state`)).json()).social;
  check((await sw())[1].on === 'true' && st3.patches.length === 1, `${tag} a held switch ignores a tap`);
  await shot(`${tag}-invisibile-on`);
  await click('.social-section .social-invisible');
  await sleep(900);
  const s2 = await sw();
  check(s2[0].on === 'false' && !(await evaluate(`return !!document.querySelector('.layer-dialog:not(.closing)');`)) && s2.slice(1).every((x) => !x.held) && s2.slice(1).map((x) => x.on).join() === 'true,false,true', `${tag} turning it off asks nothing; the three come back as they were`);
  await fetch(`${base}/__mock/social?patchFail=1`);
  const mid = await evaluate(`const b = document.querySelector('.social-section .social-now'); b.click(); return b.getAttribute('aria-checked');`);
  await sleep(1200);
  check(mid === 'false' && (await sw())[1].on === 'true' && (await seenToasts()).includes('Qualcosa non ha funzionato'), `${tag} a refused change: the switch moves at once, then comes back, "Qualcosa non ha funzionato" (${mid})`);
  await fetch(`${base}/__mock/social?privateMs=2500`);
  await go(`${base}/impostazioni?nosw`, 1500);
  const p1 = (await sw())[2].on;
  await sleep(2500);
  check(p1 === 'true' && (await sw())[2].on === 'false', `${tag} "Sessione privata" shows on until its end, then off by itself`);

  // ---- the PC: the right column, and what the page reports as playing ----
  if (!mobile) {
    await go(`${base}/?nosw`, 1800);
    const kept = await evaluate(`const a = document.querySelector('.friends-side'); return !!a && !a.hidden;`);
    check(kept, `${tag} the column stays open across a reload (kept on this device)`);
    const col = await evaluate(`const a = document.querySelector('.friends-side'); return { head: a.querySelector('.side-lib-title').textContent, btns: [...a.querySelectorAll('.side-friends-head .icon-btn')].map((b) => b.getAttribute('aria-label')), me: a.querySelector('.me-name').textContent, rows: [...a.querySelectorAll('.ami-row')].map((r) => Math.round(r.querySelector('.avatar').getBoundingClientRect().width)), recenti: a.querySelector('.me-row').getAttribute('href') };`);
    check(col.head === 'Amici' && col.btns.join(',') === 'Cerca negli amici,Chiudi' && col.me === 'Bacca' && col.rows.length === 6 && col.rows.every((w) => w === 40) && col.recenti === '/recenti', `${tag} the column: "Amici", "Cerca negli amici", "Chiudi", you, the same list with 40 px pictures (${JSON.stringify(col)})`);
    await barsCheck(`${tag} with the column`, false);
    await overflowCheck(`${tag} with the column`);
    await shot(`${tag}-column`);
    await click('.friends-side .ami-row', 'Marco');
    await sleep(1000);
    check((await pathNow()) === `/persona/${marco.id}` && (await evaluate(`return !document.querySelector('.friends-side').hidden && !!document.querySelector('#main .detail-person');`)), `${tag} a row of the column opens the page in the main area, the column stays`);
    await click('.friends-side .me-row', 'Recenti');
    await sleep(1000);
    check((await pathNow()) === '/recenti', `${tag} "Recenti" of the column opens in the main area`);
    await click('.friends-side .side-friends-head .icon-btn');
    await sleep(500);
    await evaluate(`const i = document.querySelector('.friends-side .bar-search input'); i.focus(); i.value = 'sara'; i.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
    await sleep(500);
    const cs = await evaluate(`return { rows: [...document.querySelectorAll('.friends-side .ami-row')].map((r) => r.querySelector('.ami-name').textContent), me: !!document.querySelector('.friends-side .me') };`);
    check(cs.rows.join() === 'Sara' && !cs.me, `${tag} the search opens in the column's head (${JSON.stringify(cs)})`);
    await click('.friends-side .bar-search .back-btn');
    await sleep(400);
    check(!!(await evaluate(`return !!document.querySelector('.friends-side .side-lib-title') && document.querySelectorAll('.friends-side .ami-row').length === 6;`)), `${tag} back: the head and the whole list again`);
    await go(`${base}/?nosw`, 1500);
    await click('.friends-side .side-friends-head .icon-btn:last-child');
    await sleep(500);
    const shut = await evaluate(`const b = document.querySelector('.home-top .avatar-btn'); return { hidden: document.querySelector('.friends-side').hidden, cols: getComputedStyle(document.getElementById('app')).gridTemplateColumns.split(' ').length, open: b.classList.contains('is-open'), pressed: b.getAttribute('aria-pressed'), saved: localStorage.getItem('mpfy.friends.side') };`);
    check(shut.hidden && shut.cols === 2 && !shut.open && shut.pressed === null && shut.saved === '0', `${tag} "Chiudi": two columns again, the picture plain, kept as "0" (${JSON.stringify(shut)})`);
    await S('Emulation.setDeviceMetricsOverride', { width: 800, height: 768, deviceScaleFactor: 1, mobile: false });
    await go(`${base}/?nosw`, 1500);
    await evaluate(`localStorage.setItem('mpfy.friends.side', '1'); return true;`);
    await go(`${base}/?nosw`, 1500);
    await click('.home-top .avatar-btn');
    await sleep(900);
    check((await pathNow()) === '/amici' && (await evaluate(`return document.querySelector('.friends-side').hidden;`)), `${tag} below 900 px the column never shows, the picture opens Amici`);
    await setViewport(vp);

    // What the page plays, told to the core: play, pause, another song; artistPage from an artist's page.
    await fetch(`${base}/__mock/social?clear=1`);
    const albumId = await evaluate(`return [...mpfy.store.d.albums.values()].find((a) => a.name === 'Fari nella nebbia').id;`);
    await go(`${base}/album/${albumId}?nosw`, 1500);
    await evaluate(`document.querySelectorAll('.track-row .tr-main')[0].click(); return true;`);
    await sleep(2500);
    await evaluate('mpfy.player.pause(); return true;');
    await sleep(1200);
    await evaluate('mpfy.player.next(); return true;');
    await sleep(2500);
    const acts = (await (await fetch(`${base}/__mock/state`)).json()).social.activity.map((a) => a.body);
    const first = acts.find((a) => a.playing) || acts[0] || { track: {} };
    const t0 = await evaluate(`const al = [...mpfy.store.d.albums.values()].find((a) => a.name === 'Fari nella nebbia'); return al.trackIds.map((id) => mpfy.store.track(id).versions.map((v) => v.trackId));`);
    check(acts.length >= 3 && first.playing === true && first.track.title === 'Luce di posizione' && t0[0].includes(first.track.trackId) && first.track.album === 'Fari nella nebbia' && first.track.artist === 'Lumen Marino' && first.track.artistPage === false, `${tag} play: the core hears the song (the version playing) and that it plays (${JSON.stringify(first)})`);
    check(acts.some((a) => a.playing === false && a.track && a.track.trackId === first.track.trackId) && acts.some((a) => a.playing === true && a.track && a.track.title === 'Il guardiano del faro'), `${tag} then the pause, then the next song (${acts.map((a) => `${a.track && a.track.title}:${a.playing}`).join(', ')})`);
    await evaluate('mpfy.player.pause(); return true;');
    const artist = await evaluate(`return [...mpfy.store.d.artists.values()].find((a) => a.name === 'Orsa Minore').id;`);
    await fetch(`${base}/__mock/social?clear=1`);
    await go(`${base}/artist/${artist}?nosw`, 1500);
    await evaluate(`document.querySelectorAll('.track-row .tr-main')[0].click(); return true;`);
    await sleep(2500);
    await evaluate('mpfy.player.pause(); return true;');
    await sleep(800);
    const fromArtist = (await (await fetch(`${base}/__mock/state`)).json()).social.activity.map((a) => a.body);
    const fromArtistPlaying = fromArtist.find((a) => a.playing);
    check(!!fromArtistPlaying && fromArtistPlaying.track.artistPage === true, `${tag} a song started from an artist's page: artistPage (${JSON.stringify(fromArtistPlaying)})`);
    // Your page shows what the page reported, as the others see it.
    await go(`${base}/persona/${ME}?nosw`, 2000);
    const ownShelf = await evaluate(`return [...document.querySelectorAll('.detail-person .shelf .card .card-title')].map((c) => c.textContent);`);
    check(ownShelf.includes('Orsa Minore'), `${tag} your page shows what you played, as the others see it (${ownShelf.join(', ')})`);

    // In the app with bridge 5 the native player reports: the page sends nothing. With 4 it does.
    for (const v of ['5', '4']) {
      const fake = `(() => { window.MPfyNative = new Proxy({}, { get: (_, name) => (...args) => { switch (name) { case 'bridgeVersion': return '${v}'; case 'getState': return JSON.stringify({ playing: false }); case 'getNetwork': return JSON.stringify({ type: 'wifi', metered: false }); case 'listDownloads': return JSON.stringify({ ids: [], progress: {}, items: [] }); case 'getStorage': return JSON.stringify({}); case 'getUpdate': return JSON.stringify({ state: 'none' }); default: return undefined; } } }); })();`;
      const { identifier } = await S('Page.addScriptToEvaluateOnNewDocument', { source: fake });
      try {
        await fetch(`${base}/__mock/social?clear=1`);
        await go(`${base}/album/${albumId}?nosw`, 1800);
        await evaluate(`document.querySelectorAll('.track-row .tr-main')[1].click(); return true;`);
        await sleep(400);
        await evaluate(`const s = mpfy.player.state; window.__mpfyNative({ type: 'state', playing: true, buffering: false, index: s.index, positionMs: 1000, durationMs: 120000, queueId: s.queueId, repeat: 'off' }); return true;`);
        await sleep(1500);
        const n = (await (await fetch(`${base}/__mock/state`)).json()).social.activity.length;
        check(v === '5' ? n === 0 : n > 0, `${tag} in the app with bridge ${v}: the page ${v === '5' ? 'sends nothing (the native player reports)' : 'reports'} (${n})`);
      } finally {
        await S('Page.removeScriptToEvaluateOnNewDocument', { identifier });
      }
    }
    await go(`${base}/?nosw`, 1200);
  }
  // The column closed again for the parts that follow.
  await evaluate(`try { localStorage.removeItem('mpfy.friends.side'); } catch {} return true;`);
  await fetch(`${base}/__mock/reset?sources=2`);
}

/**
 * The chats (sources at social 2): Amici with the groups ("Fonti" open and closed, kept), the lines
 * of the rows in their order, a silenced chat's grey count and crossed bell, the search with the
 * groups first, the long press to silence; a 1:1 and a group (top bars, day labels, runs, cards
 * and their taps, quotes, the long press items, the delete question, pending and failed, the scroll
 * rules, read marks at most every 2 s, the bottom stack hidden); the composer (empty, Enter, the
 * 2000 cut, a double tap and a burst of Enter sending one message, a reply); the emoji panel; the
 * share sheet; Home's "Condivisi con te" and the dot on your picture; a person's page; block and
 * "Persone bloccate"; Impostazioni and Informazioni; a shared playlist; the app's bridge 6 (the
 * notification switch, chatSeen, #chat=); the PC's column with a chat in it.
 */
async function chats(vp) {
  const { mobile, tag } = vpOf(vp);
  log(`\n== ${tag} the chats`);
  await setViewport(vp);
  await cdp('Browser.grantPermissions', { origin: base, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
  await fetch(`${base}/__mock/reset?sources=2`);
  const st0 = await (await fetch(`${base}/__mock/state`)).json();
  const SIS = 'a7c1e0d2b3f4051627384950a1b2c3d4';
  const conv = (pred) => st0.chat.convs.find(pred);
  const giulia = conv((c) => c.with === SIS).id;
  const marcoChat = conv((c) => c.with === '6d4a1f0c2e3b5a7988c1d2e3f4051627').id;
  const saraChat = conv((c) => c.with === '8a2b4c6d8e0f1a3b5c7d9e1f2a4b6c8d').id;
  const group = conv((c) => c.kind === 'group' && c.count > 0).id;
  const chatState = async () => (await (await fetch(`${base}/__mock/state`)).json()).chat;
  const pathNow = () => evaluate('return location.pathname + location.search;');
  await go(`${base}/?nosw`, 1200);
  await evaluate(`for (const k of ['mpfy.friends.side', 'mpfy.friends.fonti', 'mpfy.emoji.recent', 'mpfy.shared.seen']) localStorage.removeItem(k); return true;`);

  // ---- Home: the dot on your picture, "Condivisi con te" ----
  await go(`${base}/?nosw`, 2200);
  const home = await evaluate(`const b = document.querySelector('.home-top .avatar-btn'); const d = b.querySelector('.new-dot'); const heads = [...document.querySelectorAll('.shelf-head h2')].map((h) => h.textContent); const sh = document.querySelector('.shelf-shared');
    return { cls: b.className, label: b.getAttribute('aria-label'), title: b.title, dot: d ? d.getAttribute('role') + ':' + d.getAttribute('aria-label') : null, heads, cards: sh ? [...sh.querySelectorAll('.card')].map((c) => ({ title: c.querySelector('.card-title').textContent, dot: c.querySelector('.unseen-dot') ? c.querySelector('.unseen-dot').getAttribute('aria-label') : null, sub: (c.querySelector('.card-sub') || {}).textContent || '', note: (c.querySelector('.card-note') || {}).textContent || '', label: c.querySelector('.card-link').getAttribute('aria-label'), from: !!c.querySelector('.card-from') })) : [] };`);
  check(/has-new/.test(home.cls) && home.label === 'Amici e impostazioni, messaggi non letti' && home.title === 'Amici e impostazioni' && home.dot === 'img:Non letti', `${tag} Home: the dot on your picture while a chat not silenced has unread messages (${JSON.stringify({ label: home.label, dot: home.dot })})`);
  const si = home.heads.indexOf('Condivisi con te');
  check(si >= 0 && home.heads[si + 1] === 'Ascoltati di recente', `${tag} "Condivisi con te" right before "Ascoltati di recente" (${home.heads.join(' | ')})`);
  const onda = home.cards.find((c) => c.title === 'Onda quadra');
  const bin = home.cards.find((c) => c.title === 'Binario tre');
  const stud = home.cards.find((c) => c.title === 'Studio notturno');
  check(!!onda && onda.dot === 'nuovo' && onda.sub === 'Delta Nadir' && onda.note === '\u00absenti il ritornello\u00bb' && onda.label === 'Onda quadra, da Giulia' && onda.from, `${tag} a shared card: the dot while not opened, the sub, the note in quotes, "<titolo>, da <nome>", the sender's photo (${JSON.stringify(onda)})`);
  check(!!bin && bin.dot === null && !!stud && stud.sub === 'Playlist' && stud.dot === null, `${tag} a silenced chat's card lights no dot; a playlist says "Playlist" (${JSON.stringify([bin, stud])})`);
  await overflowCheck(`${tag} Home with the shared cards`);
  await shot(`${tag}-home-shared`);
  const readsBefore = (await chatState()).reads.length;
  await evaluate(`[...document.querySelectorAll('.shelf-shared .card')].find((c) => c.textContent.includes('Onda quadra')).querySelector('.card-link').click(); return true;`);
  await sleep(1200);
  const opened = { path: await pathNow(), seen: await evaluate(`return JSON.parse(localStorage.getItem('mpfy.shared.seen') || '[]').length;`), reads: (await chatState()).reads.length - readsBefore };
  check(/^\/album\//.test(opened.path) && opened.seen === 1 && opened.reads === 0, `${tag} a tap on a shared track opens its album, clears the dot on this device, never the chat's read mark (${JSON.stringify(opened)})`);
  await systemBack();
  await sleep(600);
  check((await evaluate(`const c = [...document.querySelectorAll('.shelf-shared .card')].find((x) => x.textContent.includes('Onda quadra')); return !!c && !c.querySelector('.unseen-dot');`)) === true, `${tag} back on Home: that card has no dot`);

  // ---- Amici with chats ----
  await go(`${base}/amici?nosw`, 2000);
  const list = await evaluate(`const l = document.querySelector('.view-friends .ami-list'); const f = l.querySelector('.fonti-block');
    const row = (r) => ({ name: (r.querySelector('.ami-name') || {}).textContent, tag: (r.querySelector('.id-tag') || {}).textContent || '', line: (r.querySelector('.ami-line-text') || {}).textContent || '', ic: [...r.querySelectorAll('.ami-line-text .ic')].map((i) => i.getAttribute('class').replace('ic ic-', '')).join(), eq: !!r.querySelector('.ami-line-text .eq'), time: (r.querySelector('.ami-time') || {}).textContent || '', count: r.querySelector('.badge.count') ? r.querySelector('.badge.count').textContent + '/' + r.querySelector('.badge.count').getAttribute('aria-label') + (r.querySelector('.badge.count').classList.contains('muted') ? '/muted' : '') : '', bell: r.querySelector('.muted-ic') ? r.querySelector('.muted-ic').getAttribute('role') + ':' + r.querySelector('.muted-ic').getAttribute('aria-label') : '', unread: r.classList.contains('is-unread'), label: r.getAttribute('aria-label'), href: r.getAttribute('href') });
    return { first: l.firstElementChild === f, fonti: f && { label: f.querySelector('.ami-fonti').getAttribute('aria-label'), exp: f.querySelector('.ami-fonti').getAttribute('aria-expanded'), n: f.querySelector('.fonti-n').textContent, line: (f.querySelector('.ami-line-text') || {}).textContent, count: (f.querySelector('.badge.count') || {}).textContent, open: f.classList.contains('open') }, rows: [...l.querySelectorAll(':scope > .ami-row')].map(row) };`);
  check(list.first && list.fonti && list.fonti.label === 'Apri le fonti' && list.fonti.exp === 'false' && list.fonti.n === '2' && list.fonti.line === 'Marco: perfetto' && list.fonti.count === '2' && !list.fonti.open, `${tag} Amici: "Fonti" first, closed: its count, the newest group message "<nome>: <testo>", the unread of the groups (${JSON.stringify(list.fonti)})`);
  const order = list.rows.map((r) => r.name + (r.tag ? `:${r.tag.replace(/\W/g, '')}` : '')).join(',');
  check(order === 'Giulia:MZ0Y,Marco,Giulia:RERY,Chiara,Sara,Bacca:58XM,Luca', `${tag} the people: by their last message, then the others by name; the one seen only in a chat with it (${order})`);
  const R = Object.fromEntries(list.rows.map((r) => [r.name + r.tag.replace(/\W/g, ''), r]));
  check(R.GiuliaMZ0Y.line === 'stasera la mettiamo in macchina?\npasso alle 9' && R.GiuliaMZ0Y.count === '2/2 non letti' && R.GiuliaMZ0Y.unread && !R.GiuliaMZ0Y.eq && R.GiuliaMZ0Y.label === 'Chat con Giulia' && R.GiuliaMZ0Y.href === `/chat/${giulia}`, `${tag} an unread message first, its count, "Chat con <nome>" to the chat (${JSON.stringify(R.GiuliaMZ0Y)})`);
  check(R.Marco.eq && R.Marco.line === 'Stella polareOrsa Minore' && /^\d\d:\d\d$/.test(R.Marco.time) && !R.Marco.count, `${tag} nothing unread: what they play now, the time of the last message (${JSON.stringify(R.Marco)})`);
  check(R.GiuliaRERY.line === 'grazie, bellissimo album' && R.GiuliaRERY.time === 'ieri' && R.Sara.ic === 'playlist' && R.Sara.line === 'Studio notturno', `${tag} else the last message (no prefix; a card: its icon and title) (${JSON.stringify([R.GiuliaRERY.line, R.Sara.ic, R.Sara.line])})`);
  check(R.Chiara.count === '5/5 non letti/muted' && R.Chiara.bell === 'img:silenziata' && R.Chiara.ic === 'note' && R.Chiara.line === 'Binario tre', `${tag} silenced: the grey count, the crossed bell after the name (${JSON.stringify(R.Chiara)})`);
  check(R.Bacca58XM.line.includes('Maestrale') && R.Bacca58XM.ic === 'history' && R.Bacca58XM.time === '2 ore fa' && R.Luca.line === '' && R.Luca.href === `/chat/${(await evaluate(`return mpfy.social.byId('b1c2d3e4f5061728394a5b6c7d8e9f00').chat;`))}`, `${tag} no chat: what they last played with how long ago, or nothing; the row still opens their chat (${JSON.stringify([R.Bacca58XM.line, R.Luca.href])})`);
  await overflowCheck(`${tag} Amici with chats`);
  await barsCheck(`${tag} Amici with chats`, mobile);
  await shot(`${tag}-amici-chats`);
  await click('.view-friends .ami-fonti');
  await sleep(500);
  const fo = await evaluate(`const f = document.querySelector('.view-friends .fonti-block'); return { open: f.classList.contains('open'), label: f.querySelector('.ami-fonti').getAttribute('aria-label'), exp: f.querySelector('.ami-fonti').getAttribute('aria-expanded'), ph: f.querySelector('.fonti-search input').placeholder, groups: [...f.querySelectorAll('.fonti-groups .ami-row')].map((r) => r.getAttribute('aria-label') + '/' + r.querySelector('.ami-line-text').textContent), saved: localStorage.getItem('mpfy.friends.fonti') };`);
  check(fo.open && fo.label === 'Chiudi le fonti' && fo.exp === 'true' && fo.ph === 'Cerca una fonte' && fo.groups.join(',') === 'Gruppo Mi A2/Marco: perfetto,Gruppo VPS prova/Gruppo' && fo.saved === '1', `${tag} "Fonti" open: "Chiudi le fonti", "Cerca una fonte", the groups by last message ("Gruppo" before any), kept as "1" (${JSON.stringify(fo)})`);
  await shot(`${tag}-amici-fonti`);
  await go(`${base}/amici?nosw`, 1800);
  check((await evaluate(`return document.querySelector('.view-friends .fonti-block').classList.contains('open');`)) === true, `${tag} "Fonti" stays open on this device`);
  await evaluate(`const i = document.querySelector('.fonti-search input'); i.value = 'vps'; i.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
  await sleep(300);
  check((await text('.fonti-groups .ami-name')) === 'VPS prova', `${tag} "Cerca una fonte" filters the groups by name`);
  await click('.view-friends .ami-fonti');
  await sleep(300);
  check((await evaluate(`return localStorage.getItem('mpfy.friends.fonti');`)) === '0', `${tag} closed again: kept as "0"`);
  await go(`${base}/amici?q=prova&nosw`, 1800);
  const sq = await evaluate(`return [...document.querySelectorAll('.view-friends .ami-list > .ami-row')].map((r) => r.getAttribute('aria-label') + '/' + (r.querySelector('.src-mark') ? 'mark' : 'av'));`);
  await go(`${base}/amici?q=mz0y&nosw`, 1500);
  const sq2 = await text('.view-friends .ami-row .ami-name');
  await go(`${base}/amici?q=i&nosw`, 1500);
  const sq3 = await evaluate(`return [...document.querySelectorAll('.view-friends .ami-list > .ami-row')].map((r) => r.getAttribute('aria-label'));`);
  check(sq.join() === 'Gruppo VPS prova/mark' && sq2 === 'Giulia' && sq3[0] === 'Gruppo Mi A2' && sq3.includes('Chat con Chiara'), `${tag} the search: the groups whose name matches first, then the people by name or ID (someone seen only in a chat by name) (${JSON.stringify({ sq, sq2, sq3 })})`);
  await go(`${base}/amici?nosw`, 1800);
  await evaluate(`const r = document.querySelector('.view-friends .ami-row[href="/chat/${giulia}"]'); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); return true;`);
  await sleep(700);
  const ms = await evaluate(`const s = document.querySelector('.layer-sheet:not(.closing) .sheet'); return s && { title: (s.querySelector('.sheet-title') || {}).textContent, items: [...s.querySelectorAll('.menu-item')].map((b) => b.textContent) };`);
  check(!!ms && ms.title === 'Silenzia' && ms.items.join() === '8 ore,1 settimana,Sempre', `${tag} a long press on a row: "Silenzia" with "8 ore", "1 settimana", "Sempre" (${JSON.stringify(ms)})`);
  await click('.layer-sheet .menu-item', '8 ore');
  await sleep(1200);
  const muted = await evaluate(`const r = document.querySelector('.view-friends .ami-row[href="/chat/${giulia}"]'); return { muted: r.classList.contains('is-muted'), bell: !!r.querySelector('.muted-ic'), grey: !!r.querySelector('.badge.count.muted') };`);
  const mutes = (await chatState()).mutes;
  check(muted.muted && muted.bell && muted.grey && mutes[giulia] > Date.now() + 7.9 * 3600000, `${tag} "8 ore": silenced for 8 hours, the bell and the grey count at once (${JSON.stringify(muted)})`);
  await evaluate(`const r = document.querySelector('.view-friends .ami-row[href="/chat/${giulia}"]'); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); return true;`);
  await sleep(700);
  const ms2 = await text('.layer-sheet:not(.closing) .menu-item');
  await click('.layer-sheet .menu-item', 'Riattiva notifiche');
  await sleep(1200);
  check(ms2 === 'Riattiva notifiche' && !((await chatState()).mutes[giulia] !== undefined), `${tag} silenced: the long press offers "Riattiva notifiche", which takes the silence away (${ms2})`);

  // ---- the 1:1 chat ----
  await fetch(`${base}/__mock/chat?clear=1`);
  await go(`${base}/chat/${giulia}?nosw`, 2500);
  const top = await evaluate(`const t = document.querySelector('.view-chat .chat-top'); const av = t.querySelector('.chat-av'); const now = t.querySelector('.chat-now');
    return { inChat: document.body.classList.contains('in-chat'), stack: getComputedStyle(document.querySelector('.bottom-stack')).display, back: t.querySelector('.back-btn').getAttribute('aria-label'), av: av.tagName + '/' + av.getAttribute('aria-label') + '/' + av.getAttribute('href') + '/' + Math.round(av.querySelector('.avatar').getBoundingClientRect().width), name: t.querySelector('.chat-name').textContent, nameHref: t.querySelector('.chat-name').getAttribute('href'), now: now && now.getAttribute('aria-label'), more: t.querySelector('.chat-more').getAttribute('aria-label') };`);
  check(top.inChat && top.stack === 'none' && top.back === 'Indietro' && top.av === `A/Profilo di Giulia//persona/${SIS}/36` && top.name.replace(/\W/g, '') === 'GiuliaMZ0Y' && top.nameHref === `/persona/${SIS}` && top.now === 'Riproduci Onda quadra di Delta Nadir' && top.more === 'Altre opzioni', `${tag} 1:1: the bottom stack gives its place, back, their photo (36) and name to their page, what they play now, "Altre opzioni" (${JSON.stringify(top)})`);
  const log1 = await evaluate(`const l = document.querySelector('.view-chat .chat-log'); return { days: [...l.querySelectorAll('.chat-day')].map((d) => d.textContent), msgs: [...l.querySelectorAll('.msg')].map((m) => (m.classList.contains('mine') ? 'M' : 'T') + (m.classList.contains('run') ? 'r' : '') + (m.classList.contains('end') ? 'e' : '')), times: [...l.querySelectorAll('.msg-time')].every((t) => /^\\d\\d:\\d\\d$/.test(t.textContent)), pre: getComputedStyle(l.querySelector('.msg-text')).whiteSpace, font: getComputedStyle(l.querySelector('.msg-text')).fontFamily, nl: [...l.querySelectorAll('.msg-text')].some((t) => t.textContent.includes('\\n')) };`);
  check(log1.days.length === 3 && log1.days[1] === 'Ieri' && log1.days[2] === 'Oggi' && log1.msgs.join() === 'Tre,Mre,Tre,Mre,Tre,Tr,Te' && log1.times, `${tag} the log: a day label over each day, runs (one sender, one day, under 5 minutes), the time in each bubble (${JSON.stringify(log1.days)} ${log1.msgs.join()})`);
  check(log1.pre === 'pre-wrap' && log1.nl && /"Noto Color Emoji", "Segoe UI Emoji"$/.test(log1.font), `${tag} the text keeps its newlines; emoji in the system font (${log1.font})`);
  const cards = await evaluate(`return [...document.querySelectorAll('.view-chat .mcard')].map((c) => ({ title: c.querySelector('.mcard-title').textContent, sub: c.querySelector('.mcard-sub').textContent, play: c.querySelector('.mcard-play').getAttribute('aria-label'), cover: c.querySelector('.mcard-cover').className, mine: !!c.closest('.msg.mine') }));`);
  const viaggio = cards.find((c) => c.title === 'Viaggio in macchina');
  const ondaC = cards.find((c) => c.title === 'Onda quadra');
  check(!!viaggio && viaggio.sub === 'PlaylistTu' && viaggio.play === 'Riproduci Viaggio in macchina' && /cover-mosaic/.test(viaggio.cover) && !!ondaC && ondaC.sub === 'BranoDelta Nadir' && !/cover-ph/.test(ondaC.cover), `${tag} music cards: the kind and its sub ("Tu" for your playlist), play, the cover from your library (${JSON.stringify(cards)})`);
  const reads = (await chatState()).reads;
  check(reads.length === 1 && reads[0].cid === giulia, `${tag} opening at the bottom: one read mark for the newest message (${JSON.stringify(reads)})`);
  const bottom = await evaluate(`const s = document.querySelector('.view-chat .chat-scroll'); return Math.round(s.scrollHeight - s.scrollTop - s.clientHeight);`);
  check(bottom <= 2, `${tag} the chat opens at the bottom (${bottom})`);
  await overflowCheck(`${tag} the chat`);
  await barsCheck(`${tag} the chat`, mobile);
  await shot(`${tag}-chat`);

  // The composer.
  const comp = await evaluate(`const c = document.querySelector('.view-chat .composer'); const b = c.querySelector('.composer-send'); const i = c.querySelector('textarea');
    return { emoji: c.querySelector('.composer-emoji').getAttribute('aria-label'), ph: i.placeholder, send: b.getAttribute('aria-label') + '/' + b.disabled, bg: getComputedStyle(b).backgroundImage };`);
  check(comp.emoji === 'Emoji' && comp.ph === 'Messaggio' && comp.send === 'Invia/true', `${tag} the composer: "Emoji", "Messaggio", "Invia" disabled while empty (${JSON.stringify(comp)})`);
  await typeInto('.view-chat textarea', '   ');
  check((await evaluate(`return document.querySelector('.view-chat .composer-send').disabled;`)) === true, `${tag} only spaces: still nothing to send`);
  await typeInto('.view-chat textarea', 'x'.repeat(1990) + '\u{1F600}'.repeat(20));
  const cut = await evaluate(`const v = document.querySelector('.view-chat textarea').value; return { points: Array.from(v).length, last: v.codePointAt(v.length - 2) };`);
  check(cut.points === 2000 && cut.last === 0x1f600, `${tag} beyond 2000 characters the text is cut as it comes, never in the middle of an emoji (${JSON.stringify(cut)})`);
  await typeInto('.view-chat textarea', '');
  await fetch(`${base}/__mock/chat?clear=1`);
  await evaluate(`const i = document.querySelector('.view-chat textarea'); i.focus(); i.value = 'prima riga'; i.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
  await press('Enter');
  await sleep(500);
  const afterEnter = { value: await evaluate(`return document.querySelector('.view-chat textarea').value;`), posts: (await chatState()).posts.length };
  if (mobile) check(afterEnter.posts === 0, `${tag} with touch Enter is a new line, it never sends (${JSON.stringify(afterEnter)})`);
  else check(afterEnter.posts === 1 && afterEnter.value === '', `${tag} without touch Enter sends (${JSON.stringify(afterEnter)})`);
  await typeInto('.view-chat textarea', 'doppio tocco');
  await doubleTap('.view-chat .composer-send', '');
  await sleep(1200);
  const dbl = (await chatState()).posts.filter((p) => p.body.text === 'doppio tocco');
  check(dbl.length === 1, `${tag} a double tap on "Invia": one message (${dbl.length})`);
  if (!mobile) {
    await typeInto('.view-chat textarea', 'raffica');
    for (let i = 0; i < 5; i++) await press('Enter');
    await sleep(1200);
    const burst = (await chatState()).posts.filter((p) => p.body.text === 'raffica');
    check(burst.length === 1 && new Set(burst.map((p) => p.body.id)).size === 1, `${tag} a burst of 5 Enter: one message, one POST (${burst.length})`);
  }
  const lastMine = await evaluate(`const m = [...document.querySelectorAll('.view-chat .msg.mine')].pop(); return { text: m.querySelector('.msg-text').textContent, pending: m.classList.contains('is-pending') };`);
  const sb = await evaluate(`const s = document.querySelector('.view-chat .chat-scroll'); return Math.round(s.scrollHeight - s.scrollTop - s.clientHeight);`);
  check(lastMine.text === (mobile ? 'doppio tocco' : 'raffica') && !lastMine.pending && sb <= 2, `${tag} the message sent shows at the bottom (${JSON.stringify(lastMine)})`);
  // Pending, then sent; refused: it goes, "Messaggio non inviato".
  await fetch(`${base}/__mock/chat?postMs=6000`);
  await typeInto('.view-chat textarea', 'lento');
  await click('.view-chat .composer-send');
  await sleep(1500);
  const pend = await evaluate(`const m = [...document.querySelectorAll('.view-chat .msg.mine')].pop(); return { text: m.querySelector('.msg-text').textContent, pending: m.classList.contains('is-pending'), op: getComputedStyle(m.querySelector('.bubble')).opacity };`);
  await sleep(9000);
  const sentNow = await evaluate(`const m = [...document.querySelectorAll('.view-chat .msg.mine')].pop(); return { text: m.querySelector('.msg-text').textContent, pending: m.classList.contains('is-pending') };`);
  check(pend.text === 'lento' && pend.pending && Number(pend.op) <= 0.61 && sentNow.text === 'lento' && !sentNow.pending, `${tag} pending: the bubble at 60% until it is sent (${JSON.stringify({ pend, sentNow })})`);
  await fetch(`${base}/__mock/chat?postMs=0&failNext=1`);
  await watchToasts();
  await typeInto('.view-chat textarea', 'non arriva');
  await click('.view-chat .composer-send');
  await sleep(1500);
  const gone = await evaluate(`return [...document.querySelectorAll('.view-chat .msg-text')].some((t) => t.textContent === 'non arriva');`);
  check(!gone && (await seenToasts()).includes('Messaggio non inviato'), `${tag} failed: the bubble goes, "Messaggio non inviato" (${JSON.stringify(await seenToasts())})`);

  // Long press items, reply, copy, delete for everyone.
  const longPress = (sel, idx) => evaluate(`const els = [...document.querySelectorAll(${JSON.stringify(sel)})]; const e = els[${idx} < 0 ? els.length + ${idx} : ${idx}]; e.scrollIntoView({ block: 'center' }); e.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); return true;`);
  const menuItems = () => text('.layer-sheet:not(.closing) .menu-item');
  await longPress('.view-chat .msg.theirs .bubble', -1);
  await sleep(700);
  const theirsItems = await menuItems();
  await systemBack();
  await longPress('.view-chat .msg.mine .bubble', -1);
  await sleep(700);
  const mineItems = await menuItems();
  await systemBack();
  await longPress('.view-chat .msg.theirs .bubble.has-card', -1);
  await sleep(700);
  const cardItems = await menuItems();
  await systemBack();
  check(theirsItems === 'Rispondi | Copia' && mineItems === 'Rispondi | Copia | Elimina per tutti' && cardItems === 'Rispondi | Aggiungi in coda | Copia', `${tag} a long press on a bubble: "Rispondi", "Copia", on yours "Elimina per tutti", on a card "Aggiungi in coda" (${JSON.stringify([theirsItems, mineItems, cardItems])})`);
  await longPress('.view-chat .msg.theirs .bubble', -1);
  await sleep(600);
  await watchToasts();
  await click('.layer-sheet .menu-item', 'Copia');
  await sleep(800);
  const copied = await evaluate(`try { return await navigator.clipboard.readText(); } catch { return null; }`);
  check((await seenToasts()).includes('Copiato') && String(copied).split(String.fromCharCode(13)).join('') === 'stasera la mettiamo in macchina?' + String.fromCharCode(10) + 'passo alle 9', `${tag} "Copia": the text in the clipboard, "Copiato" (${JSON.stringify(copied)})`);
  await longPress('.view-chat .msg.theirs .bubble.has-card', -1);
  await sleep(600);
  await click('.layer-sheet .menu-item', 'Rispondi');
  await sleep(700);
  const rb = await evaluate(`const b = document.querySelector('.view-chat .reply-bar'); return { shown: !b.hidden, who: (b.querySelector('.quote-who') || {}).textContent, body: (b.querySelector('.quote-body') || {}).textContent, cover: !!b.querySelector('.quote-cover'), close: (b.querySelector('.reply-close') || {}).getAttribute ? b.querySelector('.reply-close').getAttribute('aria-label') : null };`);
  check(rb.shown && rb.who === 'Giulia' + '' + 'MZ0Y' && rb.body === 'Onda quadrasenti il ritornello' && rb.cover && rb.close === 'Annulla risposta', `${tag} "Rispondi": the quote above the field (cover, sender, title and note), "Annulla risposta" (${JSON.stringify(rb)})`);
  await fetch(`${base}/__mock/chat?clear=1`);
  await typeInto('.view-chat textarea', 'il ritornello \u00e8 pazzesco');
  await click('.view-chat .composer-send');
  await sleep(1500);
  const rp = (await chatState()).posts.pop();
  const rq = await evaluate(`const m = [...document.querySelectorAll('.view-chat .msg.mine')].pop(); const q = m.querySelector('.quote'); return q && { who: q.querySelector('.quote-who').textContent, body: q.querySelector('.quote-body').textContent, bar: !document.querySelector('.view-chat .reply-bar').hidden };`);
  check(!!rp && /^[0-9a-f]{32}$/.test(rp.body.replyTo) && !!rq && rq.body === 'Onda quadrasenti il ritornello' && !rq.bar, `${tag} the reply leaves with replyTo and shows its quote; the bar goes (${JSON.stringify(rq)})`);
  const mineId = await evaluate(`return [...document.querySelectorAll('.view-chat .msg.mine')].pop().dataset.id;`);
  await longPress('.view-chat .msg.mine .bubble', -1);
  await sleep(600);
  await click('.layer-sheet .menu-item', 'Elimina per tutti');
  await sleep(700);
  const dq = await evaluate(`const d = document.querySelector('.layer-dialog:not(.closing) .dialog'); return d && { title: d.querySelector('.dialog-title').textContent, btns: [...d.querySelectorAll('.btn')].map((b) => b.textContent).join(' | ') };`);
  check(!!dq && dq.title === 'Eliminare il messaggio per tutti?' && dq.btns === 'Annulla | Elimina', `${tag} "Elimina per tutti" asks first (${JSON.stringify(dq)})`);
  await click('.layer-dialog .btn', 'Elimina');
  await sleep(1200);
  check(!(await evaluate(`return !!document.querySelector('.view-chat .msg[data-id="${mineId}"]');`)) && (await chatState()).deletes.some((d) => d.id === mineId), `${tag} deleted for everyone: it vanishes, nothing takes its place`);
  await shot(`${tag}-chat-sent`);

  // The emoji panel.
  await evaluate(`localStorage.removeItem('mpfy.emoji.recent'); return true;`);
  await click('.view-chat .composer-emoji');
  await sleep(900);
  const ep = await evaluate(`const p = document.querySelector('.emoji-panel'); if (!p) return null; const r = p.getBoundingClientRect(); const c = document.querySelector('.view-chat .composer').getBoundingClientRect(); const cell = p.querySelector('.emoji-cell').getBoundingClientRect();
    return { h: Math.round(r.height), w: Math.round(r.width), under: r.top >= c.bottom - 1, above: r.bottom <= c.top + 1, heads: [...p.querySelectorAll('.emoji-head')].map((x) => x.textContent).slice(0, 2), cell: Math.round(cell.width) + 'x' + Math.round(cell.height), headColor: getComputedStyle(p.querySelector('.emoji-head')).color };`);
  check(!!ep && ep.cell === '40x40' && ep.heads[0] === 'Faccine ed emozioni' && (mobile ? ep.h === 260 && ep.under : ep.w === 320 && ep.h === 360 && ep.above), `${tag} the emoji panel: ${mobile ? '260 px under the composer' : 'a 320 x 360 popover above the button'}, 40 px cells, headings in the sub colour (${JSON.stringify(ep)})`);
  await shot(`${tag}-emoji`);
  // The text and its caret set as they are left when the panel opens (a focus would bring the
  // keyboard back on a phone, which closes the panel).
  await evaluate(`const i = document.querySelector('.view-chat textarea'); i.value = 'ab'; i.dispatchEvent(new Event('input', { bubbles: true })); i.setSelectionRange(1, 1); return true;`);
  await evaluate(`document.querySelectorAll('.emoji-panel .emoji-cell')[3].click(); return true;`);
  const ins = await evaluate(`return Array.from(document.querySelector('.view-chat textarea').value);`);
  check(ins.length === 3 && ins[0] === 'a' && ins[2] === 'b' && ins[1].codePointAt(0) > 0x1f000, `${tag} a tap inserts the emoji at the caret (${JSON.stringify(ins)})`);
  // A tap on Invia leaves the panel open: closing it first slid the composer from under the finger.
  const keptOpen = await evaluate(`document.querySelector('.view-chat .composer-send').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); return !!document.querySelector('.emoji-panel');`);
  check(keptOpen, `${tag} a tap on Invia leaves the emoji panel open (${keptOpen})`);
  await systemBack();
  const closedBack = await evaluate(`return !document.querySelector('.emoji-panel') && location.pathname;`);
  check(closedBack === `/chat/${giulia}`, `${tag} Back closes the panel, the chat stays (${closedBack})`);
  await click('.view-chat .composer-emoji');
  await sleep(700);
  const rec = await evaluate(`const p = document.querySelector('.emoji-panel'); return [...p.querySelectorAll('.emoji-head')].map((x) => x.textContent)[0];`);
  await press('Escape');
  await sleep(500);
  check(rec === 'Recenti' && !(await evaluate(`return !!document.querySelector('.emoji-panel');`)), `${tag} "Recenti" first once one was used; Escape closes the panel (${rec})`);
  if (mobile) {
    // A tap in the text with the panel open: it stays until the field has the focus (the keyboard), then goes.
    await click('.view-chat .composer-emoji');
    await sleep(700);
    const fieldTap = await evaluate(`const i = document.querySelector('.view-chat textarea'); i.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); const open = !!document.querySelector('.emoji-panel'); i.focus(); await new Promise((r) => setTimeout(r, 400)); return { open, after: !!document.querySelector('.emoji-panel'), focused: document.activeElement === i };`);
    check(fieldTap.open && !fieldTap.after && fieldTap.focused, `${tag} a tap in the text with the emoji open: the field takes the focus, then the panel goes (${JSON.stringify(fieldTap)})`);
    await evaluate(`document.activeElement.blur(); return true;`);
  }
  await typeInto('.view-chat textarea', '');

  // Scrolling: the older ones load at the top keeping the place; a new one comes into view only at the bottom.
  await fetch(`${base}/__mock/chat?bulk=${giulia}&n=120`);
  await go(`${base}/chat/${giulia}?nosw`, 2500);
  const n0 = await evaluate(`return document.querySelectorAll('.view-chat .msg').length;`);
  const keep = await evaluate(`const s = document.querySelector('.view-chat .chat-scroll'); const m = [...document.querySelectorAll('.view-chat .msg')][5]; s.scrollTop = 0; await new Promise((r) => setTimeout(r, 50)); const before = m.getBoundingClientRect().top; await new Promise((r) => setTimeout(r, 2500)); return { n: document.querySelectorAll('.view-chat .msg').length, moved: Math.round(m.getBoundingClientRect().top - before) };`);
  check(n0 === 50 && keep.n === 100 && Math.abs(keep.moved) <= 2, `${tag} at the top the 50 older ones load, the messages on screen staying where they are (${n0} -> ${keep.n}, moved ${keep.moved})`);
  await evaluate(`const s = document.querySelector('.view-chat .chat-scroll'); s.scrollTop = s.scrollHeight / 2; return true;`);
  await sleep(400);
  const mid = await evaluate(`return document.querySelector('.view-chat .chat-scroll').scrollTop;`);
  await fetch(`${base}/__mock/chat?say=${giulia}&from=${SIS}&text=${encodeURIComponent('arrivo ora')}`);
  await sleep(4500);
  const stay = await evaluate(`const s = document.querySelector('.view-chat .chat-scroll'); return { top: s.scrollTop, last: [...document.querySelectorAll('.view-chat .msg-text')].pop().textContent };`);
  check(stay.last === 'arrivo ora' && Math.abs(stay.top - mid) <= 2, `${tag} a new message while reading higher up: it comes, nothing jumps (${JSON.stringify({ mid, stay })})`);
  await evaluate(`const s = document.querySelector('.view-chat .chat-scroll'); s.scrollTop = s.scrollHeight; return true;`);
  await sleep(500);
  await fetch(`${base}/__mock/chat?clear=1`);
  await fetch(`${base}/__mock/chat?say=${giulia}&from=${SIS}&text=${encodeURIComponent('e adesso')}`);
  await sleep(4500);
  const follow = await evaluate(`const s = document.querySelector('.view-chat .chat-scroll'); return { gap: Math.round(s.scrollHeight - s.scrollTop - s.clientHeight), last: [...document.querySelectorAll('.view-chat .msg-text')].pop().textContent };`);
  const rd = (await chatState()).reads;
  check(follow.last === 'e adesso' && follow.gap <= 2 && rd.length >= 1 && rd.length <= 2, `${tag} at the bottom the new one scrolls into view and is read (marks at most every 2 s: ${rd.length}) (${JSON.stringify(follow)})`);

  // The quote of a loaded message takes you to it.
  await go(`${base}/chat/${marcoChat}?nosw`, 2200);
  await click('.view-chat .quote');
  await sleep(400);
  check((await evaluate(`return !!document.querySelector('.view-chat .msg.is-flash');`)) === true, `${tag} a tap on a quote goes to the quoted message`);
  // Its sender deletes the quoted message for everyone: the quote keeps the name only.
  const quoteNow = () => evaluate(`const q = [...document.querySelectorAll('.view-chat .quote')].pop(); return q && { who: q.querySelector('.quote-who').textContent, body: q.querySelector('.quote-body') ? q.querySelector('.quote-body').textContent : null };`);
  const qBefore = await quoteNow();
  await fetch(`${base}/__mock/chat?unquote=${marcoChat}`);
  await sleep(4500);
  const qAfter = await quoteNow();
  check(!!qBefore && !!qBefore.body && !!qAfter && qAfter.who === qBefore.who && qAfter.body === null, `${tag} the quoted message deleted for everyone by its sender: the quote keeps the name only (${JSON.stringify({ qBefore, qAfter })})`);

  // ---- the group ----
  await go(`${base}/chat/${group}?nosw`, 2500);
  const gr = await evaluate(`const t = document.querySelector('.view-chat .chat-top'); const theirs = [...document.querySelectorAll('.view-chat .msg.theirs')];
    return { mark: !!t.querySelector('.chat-av .src-mark-36'), name: t.querySelector('.chat-name').textContent, link: !!t.querySelector('a'), now: !!t.querySelector('.chat-now'), names: theirs.filter((m) => m.classList.contains('run')).map((m) => (m.querySelector('.msg-name') || {}).textContent || ''), avs: theirs.filter((m) => m.classList.contains('end')).map((m) => { const a = m.querySelector('.msg-av'); return a.tagName + (a.getAttribute('href') ? ':link' : '') + ':' + Math.round(a.querySelector('.avatar').getBoundingClientRect().width); }), blanks: theirs.filter((m) => !m.classList.contains('end')).every((m) => m.querySelector('.msg-av.blank')) };`);
  check(gr.mark && gr.name === 'Mi A2' && !gr.link && !gr.now && gr.names[0].replace(/\W/g, '') === 'GiuliaMZ0Y' && gr.names.includes('Chiara') && gr.avs.every((a) => /:28$/.test(a)) && gr.avs.some((a) => a.startsWith('A:link')) && gr.avs.some((a) => a.startsWith('SPAN')) && gr.blanks, `${tag} a group: its mark (36) and the source's name; the sender's name on a run's first bubble, their photo (28) by its last, a link to their page only where the sources show them (${JSON.stringify(gr)})`);
  await shot(`${tag}-gruppo`);
  await click('.view-chat .chat-more');
  await sleep(600);
  const gm = await menuItems();
  await systemBack();
  check(gm === 'Silenzia', `${tag} the group's "Altre opzioni": "Silenzia" (${gm})`);

  // ---- a shared playlist ----
  await go(`${base}/chat/${saraChat}?nosw`, 2500);
  await click('.view-chat .mcard-link');
  await sleep(2000);
  const sv = await evaluate(`const v = document.querySelector('#main .detail-shared'); return v && { path: location.pathname, title: v.querySelector('.hero-title').textContent, kind: v.querySelector('.hero-kind').textContent, meta: v.querySelector('.hero-meta').textContent, rows: v.querySelectorAll('.track-row').length, play: v.querySelector('.play-big').getAttribute('aria-label'), edit: !!v.querySelector('.actions-left .icon-btn') };`);
  check(!!sv && /^\/condivisa\//.test(sv.path) && sv.title === 'Studio notturno' && sv.kind === 'Playlist' && sv.meta === 'Sara6 brani' && sv.rows === 5 && sv.play === 'Riproduci Studio notturno' && !sv.edit, `${tag} a shared playlist: read whole from its source, the tracks your library has, no save, no edit (${JSON.stringify(sv)})`);
  await shot(`${tag}-condivisa`);
  await fetch(`${base}/__mock/chat?playlistDown=1`);
  await go(`${base}${sv ? sv.path : '/'}?nosw`, 2500);
  const kept = await evaluate(`return document.querySelectorAll('#main .detail-shared .track-row').length;`);
  check(kept === 5, `${tag} no source of it answers: the copy read last shows (${kept})`);
  await go(`${base}/condivisa/${saraChat}/${'1'.repeat(32)}?nosw`, 2500);
  check((await text('#main .detail-shared .empty h2')) === 'Nessun brano disponibile', `${tag} nothing found: "Nessun brano disponibile"`);
  await fetch(`${base}/__mock/chat?playlistDown=0`);

  // ---- a person's page: "Scrivi a", "Altre opzioni"; block and "Persone bloccate" ----
  await go(`${base}/persona/${SIS}?nosw`, 2500);
  const pa = await evaluate(`const a = document.querySelector('#main .detail-person .actions'); return a && { more: a.querySelector('.actions-left .icon-btn').getAttribute('aria-label'), write: a.querySelector('.write-btn').getAttribute('aria-label'), size: Math.round(a.querySelector('.write-btn').getBoundingClientRect().width), icon: !!a.querySelector('.write-btn .ic-chatBold') };`);
  check(!!pa && pa.more === 'Altre opzioni per Giulia' && pa.write === 'Scrivi a Giulia' && pa.size === 56 && pa.icon, `${tag} a person's page: "Altre opzioni per <nome>" and the 56 px "Scrivi a <nome>" (${JSON.stringify(pa)})`);
  await shot(`${tag}-persona-chat`);
  await click('#main .write-btn');
  await sleep(1200);
  check((await pathNow()) === `/chat/${giulia}`, `${tag} "Scrivi a" opens the chat`);
  await go(`${base}/persona/${st0.profile.id}?nosw`, 2000);
  check(!(await evaluate(`return !!document.querySelector('#main .detail-person .write-btn');`)), `${tag} not on your own page`);
  await go(`${base}/chat/${giulia}?nosw`, 2200);
  await click('.view-chat .chat-more');
  await sleep(600);
  const om = await menuItems();
  await click('.layer-sheet .menu-item', 'Blocca Giulia');
  await sleep(800);
  const bq = await evaluate(`const d = document.querySelector('.layer-dialog:not(.closing) .dialog'); return d && { title: d.querySelector('.dialog-title').textContent, text: d.querySelector('.dialog-text').textContent, btns: [...d.querySelectorAll('.btn')].map((b) => b.textContent).join(' | ') };`);
  check(om === 'Silenzia | Blocca Giulia' && !!bq && bq.title === 'Bloccare Giulia?' && bq.text === 'Non ti potr\u00e0 scrivere n\u00e9 vedere cosa ascolti.' && bq.btns === 'Annulla | Blocca', `${tag} "Blocca <nome>" asks (${JSON.stringify({ om, bq })})`);
  await click('.layer-dialog .btn', 'Blocca');
  await sleep(1800);
  const afterBlock = { path: await pathNow(), row: await evaluate(`return !!document.querySelector('.view-friends .ami-row[href="/chat/${giulia}"]');`), blocked: (await chatState()).blocked };
  check(afterBlock.path === '/amici' && !afterBlock.row && afterBlock.blocked.includes(SIS), `${tag} blocked: back to Amici, they are not there (${JSON.stringify(afterBlock)})`);
  await go(`${base}/impostazioni?nosw`, 1800);
  const so = await evaluate(`const s = document.querySelector('.social-section'); return [...s.querySelectorAll('.set-row')].map((r) => r.querySelector('.set-title-text').textContent + (r.getAttribute('href') ? '>' + r.getAttribute('href') : ''));`);
  check(so.join() === 'Invisibile,Mostra cosa ascolto,Sessione privata,Mostra i miei ascolti recenti,Persone bloccate>/impostazioni/bloccate', `${tag} Impostazioni > Social: "Persone bloccate" (no "Notifiche dei messaggi" outside the app) (${so.join()})`);
  await click('.social-section a.set-row', 'Persone bloccate');
  await sleep(1200);
  const bl = await evaluate(`return { top: document.querySelector('#main .set-top-title').textContent, rows: [...document.querySelectorAll('#main .blocked-row')].map((r) => r.querySelector('.set-title').textContent + '/' + Math.round(r.querySelector('.avatar').getBoundingClientRect().width) + '/' + r.querySelector('.btn').textContent) };`);
  check(bl.top === 'Persone bloccate' && bl.rows.length === 1 && bl.rows[0].replace(/[^\w/]/g, '') === 'GiuliaMZ0Y/40/Sblocca', `${tag} "Persone bloccate": photo (40), name and tag, "Sblocca" (${JSON.stringify(bl)})`);
  await shot(`${tag}-bloccate`);
  await click('#main .blocked-row .btn');
  await sleep(1500);
  check((await text('#main .empty h2')) === 'Nessuna persona bloccata' && !(await chatState()).blocked.length, `${tag} "Sblocca" asks nothing; none left: "Nessuna persona bloccata"`);

  // ---- the share sheet ----
  const albumId = await evaluate(`return [...mpfy.store.d.albums.values()].find((a) => a.name === 'Frequenze').id;`);
  await go(`${base}/album/${albumId}?nosw`, 1800);
  await evaluate(`document.querySelector('#main .track-row .tr-more').click(); return true;`);
  await sleep(700);
  const tm = await menuItems();
  check(tm.includes('Condividi con...'), `${tag} the track menu: "Condividi con..." (${tm})`);
  await click('.layer-sheet .menu-item', 'Condividi con...');
  await sleep(1200);
  const sh = await evaluate(`const s = document.querySelector('.layer-sheet:not(.closing) .share-sheet'); if (!s) return null; const rows = [...s.querySelectorAll('.pick-row')];
    return { label: s.getAttribute('aria-label'), title: s.querySelector('.sheet-title').textContent, item: s.querySelector('.sheet-item-title').textContent + '/' + s.querySelector('.sheet-item-sub').textContent, search: s.querySelector('.add-search input').placeholder, fonti: rows[0].getAttribute('aria-label') + '/' + rows[0].getAttribute('aria-expanded') + '/' + rows[0].querySelector('.pick-sub').textContent, people: rows.slice(1).map((r) => r.querySelector('.pick-name').textContent.replace(/\\W/g, '') + '/' + r.getAttribute('aria-pressed') + '/' + Math.round(r.querySelector('.avatar').getBoundingClientRect().width)), note: s.querySelector('.share-note textarea').placeholder + '/' + s.querySelector('.share-note textarea').getAttribute('aria-label'), send: s.querySelector('.share-send .btn').textContent + '/' + s.querySelector('.share-send .btn').disabled };`);
  check(!!sh && sh.label === 'Condividi con' && sh.title === 'Condividi con...' && sh.search === 'Cerca' && sh.fonti === 'Apri le fonti/false/Mi A2, VPS prova' && sh.note === 'Aggiungi una nota/Nota' && sh.send === 'Invia/true', `${tag} "Condividi con...": the item, "Cerca", the "Fonti" row closed, the note, "Invia" waiting for a pick (${JSON.stringify(sh)})`);
  check(!!sh && !sh.people.some((p) => p.startsWith('Chiara')) && sh.people[0] === 'GiuliaMZ0Y/false/48', `${tag} the people in Amici's order, 48 px, never someone seen only in a chat (${JSON.stringify(sh && sh.people)})`);
  await shot(`${tag}-condividi`);
  await click('.share-sheet .fonti-pick');
  await sleep(300);
  const opened2 = await evaluate(`return [...document.querySelectorAll('.share-sheet .pick-row')].slice(0, 3).map((r) => r.getAttribute('aria-label'));`);
  check(opened2.join() === 'Chiudi le fonti,Mi A2,VPS prova', `${tag} the "Fonti" row opens the groups in place (${opened2.join()})`);
  await click('.share-sheet .pick-row[aria-label="Mi A2"]');
  await click('.share-sheet .pick-row', 'Sara');
  await click('.share-sheet .pick-row', 'Marco');
  await sleep(200);
  const picked = await evaluate(`return [...document.querySelectorAll('.share-sheet .pick-row[aria-pressed="true"]')].map((r) => r.getAttribute('aria-label') + '/' + !!r.querySelector('.pick-check.on .ic-checkCircle')).concat([String(document.querySelector('.share-send .btn').disabled)]);`);
  check(picked.join() === 'Mi A2/true,Marco/true,Sara/true,false', `${tag} several picks, each with the accent check; "Invia" ready (${picked.join()})`);
  await typeInto('.share-sheet .share-note textarea', 'n'.repeat(350));
  check((await evaluate(`return Array.from(document.querySelector('.share-sheet .share-note textarea').value).length;`)) === 300, `${tag} the note is cut at 300`);
  await evaluate(`const i = document.querySelector('.share-sheet .add-search input'); i.value = 'h8nm'; i.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
  await sleep(400);
  const byId = await text('.share-sheet .pick-row .pick-name');
  await evaluate(`const i = document.querySelector('.share-sheet .add-search input'); i.value = 'prova'; i.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
  await sleep(400);
  const byGroup = await evaluate(`return [...document.querySelectorAll('.share-sheet .pick-row')].map((r) => r.getAttribute('aria-label') + '/' + r.querySelector('.pick-sub').textContent);`);
  check(byId === 'Sara' && byGroup.join() === 'VPS prova/Gruppo', `${tag} the sheet's search: by name or ID, the groups by name (${JSON.stringify({ byId, byGroup })})`);
  await fetch(`${base}/__mock/chat?clear=1`);
  await watchToasts();
  await doubleTap('.share-sheet .share-send .btn', 'Invia');
  await sleep(2200);
  const shPosts = (await chatState()).posts;
  check(shPosts.length === 3 && new Set(shPosts.map((p) => p.cid)).size === 3 && new Set(shPosts.map((p) => p.body.id)).size === 3 && shPosts.every((p) => p.body.card.kind === 'track' && p.body.text === 'n'.repeat(300)) && (await seenToasts()).includes('Inviato') && !(await evaluate(`return !!document.querySelector('.layer-sheet:not(.closing) .share-sheet');`)), `${tag} "Invia" (double tapped): one card message per target, each with its own id, the note as its text, the sheet closed, "Inviato" (${shPosts.length})`);
  const plId = await evaluate(`return mpfy.store.lib.playlists.find((p) => p.name === 'Viaggio in macchina').id;`);
  await go(`${base}/playlist/${plId}?nosw`, 1800);
  await click('.actions-left .icon-btn');
  await sleep(600);
  await click('.layer-sheet .menu-item', 'Condividi con...');
  await sleep(1000);
  await click('.share-sheet .pick-row', 'Sara');
  await fetch(`${base}/__mock/chat?clear=1`);
  await click('.share-sheet .share-send .btn');
  await sleep(1500);
  const plCard = (await chatState()).posts[0];
  check(!!plCard && plCard.body.card.kind === 'playlist' && plCard.body.card.id === plId && plCard.body.card.n === 14 && plCard.body.card.sources.length >= 1 && /^[0-9a-f]{8,64}$/.test(plCard.body.card.cover || '') && !('tracks' in plCard.body.card) && !('text' in plCard.body), `${tag} a playlist card: its id, name, count and the sources where it lives, never its tracks (${JSON.stringify(plCard && plCard.body.card)})`);

  // ---- Informazioni ----
  await go(`${base}/impostazioni?nosw`, 1500);
  check((await evaluate(`const r = document.querySelector('.info-messages'); return r && r.querySelector('.set-title-text').textContent + '/' + r.querySelector('.set-sub').textContent + '/' + !!r.querySelector('.ic-lock');`)) === 'Messaggi/Cifrati, le fonti vedono chi scrive a chi e quando, non cosa./true', `${tag} Informazioni: "Messaggi" with the lock and what the sources see`);

  // ---- the app (bridge 6): the notification switch, chatSeen, #chat= ----
  if (mobile) {
    const fake = `(() => { window.__calls = []; let notify = '1'; window.MPfyNative = new Proxy({}, { get: (_, name) => (...args) => { window.__calls.push(name + ':' + args.join(',')); switch (name) { case 'bridgeVersion': return '6'; case 'getChatNotify': return notify; case 'setChatNotify': notify = args[0] === '1' ? '1' : '0'; return notify; case 'getState': return JSON.stringify({ playing: false }); case 'getNetwork': return JSON.stringify({ type: 'wifi', metered: false }); case 'listDownloads': return JSON.stringify({ ids: [], progress: {}, items: [] }); case 'getStorage': return JSON.stringify({}); case 'getUpdate': return JSON.stringify({ state: 'none' }); default: return undefined; } } }); })();`;
    const { identifier } = await S('Page.addScriptToEvaluateOnNewDocument', { source: fake });
    try {
      await go(`${base}/impostazioni?nosw`, 1800);
      const nr = await evaluate(`const r = document.querySelector('.social-notify'); return r && { title: r.querySelector('.set-title-text').textContent, on: r.getAttribute('aria-checked'), ic: !!r.querySelector('.ic-bell') };`);
      await click('.social-notify');
      await sleep(300);
      const nr2 = await evaluate(`return { on: document.querySelector('.social-notify').getAttribute('aria-checked'), calls: window.__calls.filter((c) => /ChatNotify/.test(c)) };`);
      check(!!nr && nr.title === 'Notifiche dei messaggi' && nr.on === 'true' && nr.ic && nr2.on === 'false' && nr2.calls.includes('setChatNotify:0'), `${tag} the app (bridge 6): "Notifiche dei messaggi", on by default, kept by the app (${JSON.stringify({ nr, nr2 })})`);
      await go(`${base}/?nosw#chat=${giulia}`, 2500);
      const viaHash = await evaluate(`return { path: location.pathname, hash: location.hash, seen: window.__calls.filter((c) => c.startsWith('chatSeen:')) };`);
      check(viaHash.path === `/chat/${giulia}` && viaHash.hash === '' && viaHash.seen.includes(`chatSeen:${giulia}`), `${tag} #chat=<cid> from the notification: that chat opens, the fragment goes, its notification is taken back (${JSON.stringify(viaHash)})`);
    } finally {
      await S('Page.removeScriptToEvaluateOnNewDocument', { identifier });
    }
  }

  // ---- the PC: a chat inside the column ----
  if (!mobile) {
    await go(`${base}/?nosw`, 1500);
    await evaluate(`localStorage.setItem('mpfy.friends.side', '1'); return true;`);
    await go(`${base}/?nosw`, 2000);
    await click('.friends-side .ami-row', 'Giulia');
    await sleep(1800);
    const col = await evaluate(`const a = document.querySelector('.friends-side'); const c = a.querySelector('.side-chat'); return c && { path: location.pathname, label: a.getAttribute('aria-label'), av: Math.round(c.querySelector('.chat-top .avatar').getBoundingClientRect().width), log: !!c.querySelector('.side-chat-log .chat-log .msg'), comp: c.querySelector('.composer-dock').getBoundingClientRect().bottom <= a.getBoundingClientRect().bottom + 1 && c.querySelector('.composer-dock').getBoundingClientRect().bottom >= a.getBoundingClientRect().bottom - 2, main: !!document.querySelector('#main .view-home') };`);
    check(!!col && col.path === '/' && col.label === 'Chat con Giulia' && col.av === 32 && col.log && col.comp && col.main, `${tag} a row of the column opens its chat inside it: "Chat con <nome>", the 32 px photo, the log, the composer at its foot; the main area keeps its page (${JSON.stringify(col)})`);
    await barsCheck(`${tag} a chat in the column`, false);
    await overflowCheck(`${tag} a chat in the column`);
    await shot(`${tag}-column-chat`);
    await fetch(`${base}/__mock/chat?clear=1`);
    await evaluate(`const i = document.querySelector('.friends-side textarea'); i.focus(); i.value = 'dalla colonna'; i.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
    await press('Enter');
    await sleep(1200);
    check((await chatState()).posts.some((p) => p.body.text === 'dalla colonna'), `${tag} the column's composer sends`);
    await click('.friends-side .chat-top .back-btn');
    await sleep(800);
    check((await evaluate(`const a = document.querySelector('.friends-side'); return a.getAttribute('aria-label') === 'Amici' && !!a.querySelector('.ami-list');`)) === true, `${tag} back returns to the list`);
    await evaluate(`try { localStorage.removeItem('mpfy.friends.side'); } catch {} return true;`);
  }

  // ---- without chats: no shelf, no dot ----
  await fetch(`${base}/__mock/chat?level=1`);
  await go(`${base}/?nosw`, 2200);
  const quiet = await evaluate(`return { shelf: !!document.querySelector('.shelf-shared'), dot: !!document.querySelector('.home-top .new-dot') };`);
  check(!quiet.shelf && !quiet.dot, `${tag} no source holds chats: no shelf, no dot (${JSON.stringify(quiet)})`);
  await fetch(`${base}/__mock/reset?sources=2`);
}

/** The quality labels in the track menu: the codec in capitals, ~ and the class when measured lower. */
async function labels(vp) {
  const { tag } = vpOf(vp);
  log(`\n== ${tag} quality labels`);
  await setViewport(vp);
  await fetch(`${base}/__mock/reset?sources=2`);
  const lines = async () => {
    const al = await evaluate(`return [...mpfy.store.d.albums.values()].find((a) => a.name === 'Fari nella nebbia').id;`);
    await go(`${base}/album/${al}?nosw`, 1500);
    await click('.track-row .tr-more');
    await sleep(600);
    return text('.layer-sheet .menu-info-line');
  };
  await go(`${base}/?nosw`, 1500);
  let l = await lines();
  check(l === 'Mi A2: WAV | VPS prova: MP3 320', `${tag} not measured: "MP3 320" (${l})`);
  await evaluate(`history.back(); return true;`);
  await sleep(500);
  await fetch(`${base}/__mock/quality?on=1`);
  await evaluate(`await mpfy.store.refresh(); return true;`);
  l = await lines();
  check(l === 'Mi A2: WAV | VPS prova: MP3 ~128', `${tag} measured cut at 17 kHz: "MP3 ~128" (${l})`);
  await overflowCheck(`${tag} track menu with the labels`);
  await shot(`${tag}-labels`);
  await evaluate(`history.back(); return true;`);
  await sleep(500);
  await fetch(`${base}/__mock/quality?on=0`);
}

/**
 * A page older than the installed app (the first start after an update, bridge 4 with a newer
 * appVersion): the new version takes over while the page is visible, at once when nothing goes
 * on, but never while the way in is up, a code from #aggiungi= is not used yet, a source is being
 * added (its naming step lives in the page) or the person is typing or just tapped; it waits for
 * those to end or for the page to be hidden (on screen it looks again every 2 s, hidden it does
 * not wake for that), and a code not used yet comes back with the new page. The
 * service worker's "new version" message is handed to the page here (the shell on disk stays).
 */
async function olderPage() {
  const { tag } = vpOf(PHONE);
  log(`\n== ${tag} a page older than the app`);
  await setViewport(PHONE);
  const fake = `(() => {
    window.MPfyNative = new Proxy({}, { get: (_, name) => (...args) => {
      switch (name) {
        case 'bridgeVersion': return '4';
        case 'appVersion': return sessionStorage.getItem('fakeAppVersion') || '9.9.9';
        case 'getUpdate': return JSON.stringify({ state: 'none', versionName: '', progress: 0 });
        case 'getStorage': return JSON.stringify({ downloadsBytes: 0, downloadsCount: 0, cacheBytes: 0 });
        case 'listDownloads': return JSON.stringify({ ids: [], progress: {}, items: [] });
        case 'getNetwork': return JSON.stringify({ type: 'wifi', metered: false });
        case 'getState': return JSON.stringify({ playing: false, queueId: null });
        case 'getQueue': return JSON.stringify({ queueId: null, index: 0, positionMs: 0, items: [] });
        default: return undefined;
      }
    } });
    // The page's own "look again in 2 s", counted.
    const st = window.setTimeout;
    window.__rechecks = 0;
    window.setTimeout = function (fn, ms, ...rest) {
      if (ms === 2000 && fn && fn.name === 'reloadIfQuiet') window.__rechecks++;
      return st.call(this, fn, ms, ...rest);
    };
  })();`;
  const { identifier } = await S('Page.addScriptToEvaluateOnNewDocument', { source: fake });
  const hide = (on) => evaluate(`Object.defineProperty(document, 'hidden', { configurable: true, get: () => ${on} }); document.dispatchEvent(new Event('visibilitychange')); return true;`).catch(() => 'gone');
  const rechecks = () => evaluate(`return window.__rechecks;`).catch(() => -1);
  // Each page gets a mark: a reload takes it away.
  const mark = () => evaluate(`window.__samePage = 1; return true;`);
  const samePage = () => evaluate(`return window.__samePage === 1;`).catch(() => false);
  // The page listens once it registered its worker (at the end of its start).
  const newShell = () =>
    evaluate(`for (let i = 0; i < 50 && !(await navigator.serviceWorker.getRegistration()); i++) await new Promise((r) => setTimeout(r, 100)); navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'mpfy-shell-updated' } })); return true;`).catch(() => 'gone');
  const reloadedWithin = async (ms) => {
    for (const t0 = Date.now(); Date.now() - t0 < ms; ) {
      await sleep(100);
      if (!(await samePage())) {
        await sleep(1500); // the new page draws its view
        return true;
      }
    }
    return false;
  };
  const codeField = () => evaluate(`return document.querySelector('.view-welcome .code-input')?.value ?? null;`).catch(() => null);
  const title = () => text('.welcome-title').catch(() => '');
  try {
    // Nothing going on: at once, visible.
    await fetch(`${base}/__mock/reset?sources=2`);
    await go(`${base}/?older=1`, 1500);
    check((await evaluate(`return document.hidden === false && !document.querySelector('.welcome');`)) === true, `${tag} the library, visible`);
    await mark();
    await newShell();
    check(await reloadedWithin(1500), `${tag} older than the app, nothing going on: the new version takes over at once, the page visible`);

    // Typing: it waits for the field to be left and 3 s with nothing touched.
    await go(`${base}/search?older=2`, 1500);
    await typeInto('.search-input', 'nebbia');
    await mark();
    await newShell();
    await sleep(4500);
    check((await samePage()) && (await evaluate(`return document.querySelector('.search-input').value;`)) === 'nebbia', `${tag} a new version while the person types in a field: the page stays, the text in it`);
    await evaluate(`document.activeElement.blur(); return true;`);
    check(await reloadedWithin(6000), `${tag} the field left and nothing touched for 3 s: the new version takes over`);

    // A tap on the page (not in a field): it waits 3 s after it, a reload between a press and its
    // click would lose the tap.
    await go(`${base}/?older=8`, 1500);
    await evaluate(`for (let i = 0; i < 50 && !(await navigator.serviceWorker.getRegistration()); i++) await new Promise((r) => setTimeout(r, 100)); window.__taps = 0; window.addEventListener('pointerdown', () => window.__taps++, true); return true;`);
    const spot = await evaluate(`const el = document.querySelector('#main > .view-home h1'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + Math.min(20, r.width / 2), y: r.top + r.height / 2 };`);
    await mark();
    if (spot) {
      await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: spot.x, y: spot.y }] });
      await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
    await newShell();
    await sleep(1500);
    const tapped = { taps: await evaluate(`return window.__taps;`).catch(() => null), same: await samePage() };
    check(tapped.taps > 0 && tapped.same, `${tag} a new version right after a tap on the page: the page stays (${JSON.stringify(tapped)})`);
    check(await reloadedWithin(6000), `${tag} nothing touched for 3 s after the tap: the new version takes over`);

    // The way in, the first source step with nothing in it and nobody on it: it waits.
    await fetch(`${base}/__mock/reset?sources=0&profile=1`);
    await go(`${base}/?older=3`, 1500);
    await evaluate(`document.activeElement.blur(); return true;`);
    await mark();
    await newShell();
    await sleep(4500);
    check((await samePage()) && (await title()) === 'Aggiungi la prima fonte', `${tag} a new version while the way in is up: the page stays`);

    // Started with a code: the code stays in its field.
    const code = 'MPFY-5K3Q-9XWD-ABCD-EFGH-JKMN-PQRS-TVWX-YZ12';
    await go(`${base}/?older=4#aggiungi=${encodeURIComponent(code)}`, 1500);
    const at = await evaluate(`return location.pathname + location.search;`).catch(() => '');
    check(at === '/?older=4', `${tag} leaving a page whose new version waits: it goes where it was sent, not reloaded in its place (${at})`);
    check((await codeField()) === code.slice(5), `${tag} started with #aggiungi=: the first source step shows its code (${await codeField()})`);
    await mark();
    await newShell();
    await sleep(4500);
    const kept = { same: await samePage(), field: await codeField(), title: await title() };
    check(kept.same && kept.field === code.slice(5) && kept.title === 'Aggiungi la prima fonte', `${tag} a new version while that step shows the code: the page stays, the code in its field (${JSON.stringify(kept)})`);

    // The page hidden with the code not used: the new version takes over, and the code is back.
    await evaluate(`Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); return true;`).catch(() => 'gone');
    const went = await reloadedWithin(3000);
    const back = { field: await codeField(), title: await title(), url: await evaluate(`return location.href;`).catch(() => '') };
    check(went && back.field === code.slice(5) && back.title === 'Aggiungi la prima fonte' && !back.url.includes('#'), `${tag} hidden, the code not used yet: the new version takes over, and the code is in its field again (${JSON.stringify(back)})`);

    // The first source being added, its role not known yet when the core answers: the way in is
    // gone, the add goes on in this page until the role comes.
    await fetch(`${base}/__mock/core?roleDelay=5000`);
    await mark();
    await click('.welcome .as-form .btn-primary');
    await sleep(100);
    await newShell();
    await sleep(3400);
    const mid = { same: await samePage(), wayIn: await evaluate(`return !!document.querySelector('.welcome');`).catch(() => null) };
    check(mid.same && mid.wayIn === false, `${tag} a new version while the first source is being added: the page stays until the add is over (${JSON.stringify(mid)})`);
    check(await reloadedWithin(8000), `${tag} the add over: the new version takes over`);

    // "Aggiungi fonte" of a new source: the panel closes, the role comes late, then the naming step.
    await fetch(`${base}/__mock/reset?sources=2`);
    await fetch(`${base}/__mock/core?roleDelay=6000`);
    await go(`${base}/impostazioni?older=5`, 1500);
    await click('button.set-row', 'Aggiungi fonte');
    await sleep(600);
    await typeInto('.panel-add-source .code-input', 'MPFY-6K3Q-9XWD-ABCD-EFGH-JKMN-PQRS-TVWX-YZ12');
    await mark();
    await click('.panel-add-source .btn-primary');
    // The new version comes once the panel is gone and the role is still unknown.
    for (let i = 0; i < 30 && (await evaluate(`return !!document.querySelector('.panel-add-source');`).catch(() => false)); i++) await sleep(100);
    await sleep(300);
    const gone = !(await evaluate(`return !!document.querySelector('.panel-add-source') || !!document.querySelector('.layer-dialog');`).catch(() => true));
    await newShell();
    let named = false;
    for (let i = 0; i < 120 && !named; i++) {
      await sleep(100);
      named = (await evaluate(`return document.querySelector('.layer-dialog .dialog-title')?.textContent === 'Dai un nome a questa fonte';`).catch(() => false)) === true;
    }
    check(gone && named && (await samePage()), `${tag} a new version after "Aggiungi fonte" closed, before the naming step: the page stays, and "Dai un nome a questa fonte" comes (panel gone first: ${gone})`);
    if (named) {
      await typeInto('.layer-dialog input', 'Casa al mare');
      await click('.layer-dialog .btn-primary');
    }
    const after = await reloadedWithin(10000);
    const st = await (await fetch(`${base}/__mock/state`)).json();
    check(after && st.servers.some((s) => s.name === 'Casa al mare'), `${tag} named, the add over: the new version takes over (${st.servers.map((s) => s.name).join(', ')})`);

    // No profile yet: the code waits in the welcome for the name; back on the welcome step (no
    // layer over it), hidden: the code comes back with the new page, which asks the name again.
    await fetch(`${base}/__mock/reset?sources=0&profile=0`);
    await go(`${base}/?older=6#aggiungi=${encodeURIComponent(code)}`, 1500);
    const asked = await title();
    await systemBack();
    const welcomeAgain = await title();
    await mark();
    await newShell();
    await sleep(2500);
    const held = await samePage();
    await evaluate(`Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); return true;`).catch(() => 'gone');
    const wentW = await reloadedWithin(3000);
    const w = { asked, welcomeAgain, held, went: wentW, now: await title() };
    check(asked === 'Come ti chiami?' && welcomeAgain === 'Benvenuto in MPfy' && held && wentW && w.now === 'Come ti chiami?', `${tag} a code waiting for the name, back on the welcome, hidden: the new version takes over and the code still leads to the name (${JSON.stringify(w)})`);

    // An install from before profiles started with a code: the page keeps it until the name is
    // given. Hidden: the new page asks the name, and then "Aggiungi fonte" has the code.
    await fetch(`${base}/__mock/reset?sources=2&profile=0`);
    const early = 'MPFY-7K3Q-9XWD-ABCD-EFGH-JKMN-PQRS-TVWX-YZ12';
    await go(`${base}/?older=9#aggiungi=${encodeURIComponent(early)}`, 1500);
    const askedN = await title();
    await mark();
    await newShell();
    await sleep(2500);
    const heldN = await samePage();
    await hide(true);
    const wentN = await reloadedWithin(3000);
    const n = { asked: askedN, held: heldN, went: wentN, now: await title() };
    await typeInto('.welcome input', 'Bacca');
    await click('.welcome .btn-primary');
    await sleep(2200);
    n.field = await evaluate(`return document.querySelector('.panel-add-source .code-input')?.value ?? null;`).catch(() => null);
    check(n.asked === 'Come ti chiami?' && n.held && n.went && n.now === 'Come ti chiami?' && n.field === early.slice(5), `${tag} a code waiting for the name of an install from before profiles, hidden: the new version takes over, and after the name "Aggiungi fonte" has the code (${JSON.stringify(n)})`);
    await systemBack();

    // Held by something open: on screen it looks again every 2 s; hidden it does not wake for that
    // (the page coming back looks again).
    await fetch(`${base}/__mock/reset?sources=2`);
    await go(`${base}/impostazioni?older=10`, 1500);
    await click('button.set-row', 'Aggiungi fonte');
    await sleep(600);
    await evaluate(`document.activeElement.blur(); window.__rechecks = 0; return true;`);
    await mark();
    await newShell();
    await sleep(4500);
    const shown = await rechecks();
    await hide(true);
    await sleep(300);
    const atHide = await rechecks();
    await sleep(6000);
    const hid = { shown, woke: (await rechecks()) - atHide, same: await samePage() };
    await hide(false);
    await sleep(2500);
    hid.back = (await rechecks()) - atHide - hid.woke;
    await systemBack(); // the panel closes, no touch
    hid.went = await reloadedWithin(4000);
    check(hid.shown > 0 && hid.woke === 0 && hid.same && hid.back > 0 && hid.went, `${tag} a new version while "Aggiungi fonte" is open: on screen it looks again, hidden it does not wake every 2 s, back on screen it looks again and takes over once the panel closes (${JSON.stringify(hid)})`);

    // A page of the app's own version, hidden while a source is being added: the new version
    // waits for the add (its role comes late), then takes over.
    await fetch(`${base}/__mock/reset?sources=1`);
    await fetch(`${base}/__mock/core?roleDelay=3000`);
    await evaluate(`sessionStorage.setItem('fakeAppVersion', (await import('/js/util.js')).APP_VERSION); return true;`);
    await go(`${base}/impostazioni?older=7`, 1500);
    await click('button.set-row', 'Aggiungi fonte');
    await sleep(600);
    await typeInto('.panel-add-source .code-input', vps.code);
    await mark();
    await click('.panel-add-source .btn-primary');
    for (let i = 0; i < 30 && (await evaluate(`return !!document.querySelector('.panel-add-source');`).catch(() => false)); i++) await sleep(100);
    await newShell();
    await evaluate(`Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); return true;`).catch(() => 'gone');
    await sleep(1000);
    const heldHidden = await samePage();
    const wentHidden = await reloadedWithin(6000);
    const ms = await (await fetch(`${base}/__mock/state`)).json();
    const vpsPaired = ms.paired.some((p) => p.id === ms.servers.find((s) => s.name === 'VPS prova')?.id);
    check(heldHidden && wentHidden && vpsPaired, `${tag} a page of the app's version, hidden while a source is being added: the new version waits for the add, then takes over (held ${heldHidden}, then ${wentHidden}, VPS paired ${vpsPaired})`);
  } finally {
    await evaluate(`sessionStorage.removeItem('fakeAppVersion'); return true;`).catch(() => false);
    await fetch(`${base}/__mock/core?roleDelay=0`);
    await S('Page.removeScriptToEvaluateOnNewDocument', { identifier });
    await evaluate(`for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); for (const k of await caches.keys()) await caches.delete(k); return true;`).catch(() => false);
  }
}

/**
 * "Locale", the phone's own music (the mock's phone=1): the way in with no source, the access
 * asked once and asked again from Home and Impostazioni, only the phone (no Amici, no "Carica
 * brani", likes, playlists, plays, covers, a playlist cover, no "Sei offline"), a retagged song's
 * old like, a song on both (one row, both names, no "Elimina da Locale", played from the phone),
 * a local-only song's menu, and the move of the person's data to the first source: with its
 * dialog, removals made between two passes, the access off, and a reload in the middle.
 */
async function phoneMusic(vp) {
  const { mobile, tag } = vpOf(vp);
  log(`\n== ${tag} the phone's own music`);
  await setViewport(vp);
  const waitFor = async (expr, ms = 9000) => {
    const t0 = Date.now();
    for (;;) {
      const v = await evaluate(expr).catch(() => null);
      if (v || Date.now() - t0 > ms) return v;
      await sleep(150);
    }
  };
  const mstate = async () => (await fetch(`${base}/__mock/state`)).json();
  const miLib = async () => (await fetch(`${base}/s/${mi.id}/api/library`)).json();
  const phoneNow = async () => (await (await fetch(`${base}/local/sources`)).json()).phone;
  const menuOf = async (id) => {
    await evaluate(`document.querySelector('.track-row[data-tid="${id}"] .tr-more').click(); return true;`);
    await sleep(600);
    const m = await text('.layer-sheet .menu-item, .layer-sheet .menu-info');
    await evaluate(`history.back(); return true;`);
    await sleep(500);
    return m;
  };

  // The access: asked once when the app first shows, asked again from Home and Impostazioni (a
  // bridge that records the calls).
  const fake = `(() => { window.__access = []; window.MPfyNative = new Proxy({}, { get: (_, name) => (...args) => { if (name === 'askMusicAccess') window.__access.push(args[0]); switch (name) { case 'bridgeVersion': return '3'; case 'listDownloads': return JSON.stringify({ ids: [], progress: {}, items: [] }); case 'getNetwork': return JSON.stringify({ type: 'wifi', metered: false }); case 'getState': return JSON.stringify({ playing: false }); default: return undefined; } } }); })();`;
  const { identifier } = await S('Page.addScriptToEvaluateOnNewDocument', { source: fake });
  try {
    await fetch(`${base}/__mock/reset?sources=0&profile=0&phone=1`);
    await go(`${base}/?nosw`, 2200);
    check((await text('.welcome-title')) === 'Benvenuto in MPfy', `${tag} phone: the way in starts at "Benvenuto in MPfy"`);
    await click('.welcome button', 'Inizia');
    await sleep(400);
    check((await text('.welcome-title')) === 'Come ti chiami?' && (await text('.welcome .btn-primary')) === 'Continua', `${tag} phone: "Come ti chiami?", "Continua"`);
    await typeInto('.welcome input', 'Bacca');
    await click('.welcome .btn-primary');
    const n = await waitFor(`return !document.querySelector('.welcome') && mpfy.store.lib.tracks.length >= 300 ? mpfy.store.lib.tracks.length : 0;`);
    const first = await evaluate(`return document.body.textContent.includes('Aggiungi la prima fonte');`);
    check(n >= 300 && !first, `${tag} phone: after the name, Home with the phone's songs (${n}), never "Aggiungi la prima fonte"`);
    await sleep(500);
    check((await evaluate(`return window.__access.join(',');`)) === 'first', `${tag} phone: the system's question asked once, when the app first shows (${await evaluate(`return window.__access.join(',');`)})`);
    await shot(`${tag}-phone-home`);

    // The access off: no songs, Home's empty library asks for it, and so does Impostazioni.
    await fetch(`${base}/__mock/phone?state=off`);
    await waitFor(`return mpfy.store.lib.tracks.length === 0;`);
    await sleep(600);
    const empty = await evaluate(`return { h: document.querySelector('.empty h2')?.textContent || '', b: [...document.querySelectorAll('.empty .btn')].map((x) => x.textContent).join('|') };`);
    check(empty.h === 'La tua libreria è vuota' && empty.b === "Consenti l'accesso alla musica", `${tag} phone: access off, Home: "La tua libreria è vuota" and "Consenti l'accesso alla musica" (${JSON.stringify(empty)})`);
    await click('.empty .btn');
    await sleep(300);
    const fromHome = await evaluate(`return window.__access.join(',');`);
    await shot(`${tag}-phone-off`);
    await go(`${base}/impostazioni?nosw`, 1500);
    const secs = await evaluate(`return [...document.querySelectorAll('.set-section')].filter((s) => s.querySelector('.set-section-title')).map((s) => [s.querySelector('.set-section-title').textContent, s.querySelector('.set-list').textContent]);`);
    const fonti = secs.find((s) => s[0] === 'Fonti musicali');
    const tel = secs.find((s) => s[0] === 'Musica del telefono');
    check(!!fonti && !/Locale/.test(fonti[1]) && secs.map((s) => s[0]).indexOf('Musica del telefono') === secs.map((s) => s[0]).indexOf('Fonti musicali') + 1 && tel?.[1] === "Consenti l'accesso alla musicaPer vedere i brani salvati sul telefono", `${tag} phone: Impostazioni, "Musica del telefono" after "Fonti musicali" with the access row, no "Locale" among the sources (${JSON.stringify(secs.map((s) => s[0]))}, ${tel?.[1]})`);
    await shot(`${tag}-phone-settings-off`);
    await click('.phone-access');
    await sleep(300);
    // A new page asks "first" again (the app shows the system's dialog only once, ever).
    const asked = await evaluate(`return window.__access.join(',');`);
    check(fromHome === 'first,settings' && asked === 'first,settings', `${tag} phone: Home's button and the row ask with "settings" (${fromHome}; ${asked})`);
    await fetch(`${base}/__mock/phone?state=ready`);
    const sw = await waitFor(`const b = document.querySelector('.phone-details'); return b ? b.textContent + ':' + b.getAttribute('aria-checked') : '';`);
    check(sw === 'Cerca i dettagli in rete:true', `${tag} phone: access granted, the row becomes "Cerca i dettagli in rete" (${sw})`);
    await click('.phone-details');
    await sleep(1200);
    const det = (await phoneNow()).details;
    check(det === false && (await evaluate(`return document.querySelector('.phone-details').getAttribute('aria-checked');`)) === 'false', `${tag} phone: the switch turns Locale's details off (${det})`);
    await shot(`${tag}-phone-settings`);
  } finally {
    await S('Page.removeScriptToEvaluateOnNewDocument', { identifier });
  }

  // Only the phone: no Amici, no "Carica brani"; likes, playlists, plays and covers on the phone's store.
  await fetch(`${base}/__mock/reset?sources=0&profile=1&phone=1`);
  await go(`${base}/?nosw`, 2500);
  await waitFor(`return mpfy.store.lib.tracks.length >= 300;`);
  let st = await mstate();
  const own = st.phone.tracks.slice(20);
  const L = own[3];
  const top = await evaluate(`const b = document.querySelector('.home-top .avatar-btn'); return { title: b ? b.title : null, upload: !!document.querySelector('.home-top [aria-label="Carica brani"]'), social: mpfy.sources.social() };`);
  check(top.title === 'Impostazioni' && !top.upload && !top.social, `${tag} only the phone: no Amici (the picture opens Impostazioni), no "Carica brani" (${JSON.stringify(top)})`);
  await evaluate(`await mpfy.store.like('${L}'); const p = await mpfy.store.createPlaylist('Solo telefono', '', ['${L}']); window.__pl = p && p.id; mpfy.store.played('${L}', { type: 'library', id: null }); return true;`);
  await sleep(1500);
  st = await mstate();
  const plId = await evaluate(`return window.__pl;`);
  check(st.phone.user.likes.some((x) => x.id === L) && st.phone.user.playlists.some((p) => p.id === plId && p.trackIds.includes(L)) && st.phone.user.recents.some((r) => r.trackId === L) && st.phone.home === '0000', `${tag} only the phone: a like, a playlist and a play land on the phone's store`);
  await go(`${base}/recenti?nosw`, 1800);
  const title = await evaluate(`return mpfy.store.track('${L}').title;`);
  check((await evaluate(`return document.querySelector('#main > .view').textContent.includes(${JSON.stringify(title)});`)) === true, `${tag} only the phone: Recenti shows the play ("${title}")`);
  await go(`${base}/library?nosw`, 1800);
  const imgs = await waitFor(`const i = [...document.images].filter((x) => x.src.includes('/s/0000/api/cover/') && x.complete && x.naturalWidth > 0).length; return i;`);
  check(imgs > 0, `${tag} only the phone: covers from the phone (${imgs})`);
  const set = await evaluate(`const m = await import('/components/cover-edit.js'); const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d'); x.fillStyle = '#c33'; x.fillRect(0, 0, 64, 64); const b = await new Promise((r) => c.toBlob(r, 'image/png')); return m.changeCover('playlist', '${plId}', new File([b], 'c.png', { type: 'image/png' }));`);
  await go(`${base}/playlist/${plId}?nosw`, 1800);
  st = await mstate();
  const plCover = st.phone.user.covers.playlist[plId];
  const shown = await waitFor(`return [...document.images].some((x) => x.src.includes('/s/0000/api/cover/${plCover ? plCover.large : 'none'}') || x.src.includes('/s/0000/api/cover/${plCover ? plCover.small : 'none'}')) ? 1 : 0;`, 5000);
  check(set === true && !!plCover && shown === 1, `${tag} only the phone: a playlist cover is set and shows`);
  await shot(`${tag}-phone-playlist`);
  await evaluate(`Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }); window.dispatchEvent(new Event('offline')); return true;`);
  await sleep(500);
  const ban = await evaluate(`const b = document.getElementById('banner'); return b.hidden ? '' : b.textContent;`);
  check(ban === '', `${tag} only the phone: no "Sei offline" banner with the network off ("${ban}")`);
  await evaluate(`delete navigator.onLine; window.dispatchEvent(new Event('online')); return true;`);

  // A song written again by a tag editor: its old like shows on it, and an unlike takes it away.
  const X = own[5];
  await evaluate(`await mpfy.store.like('${X}'); return true;`);
  await sleep(800);
  const Y = (await (await fetch(`${base}/__mock/phone?retag=5`)).text()).trim().split(' -> ')[1];
  const liked = await waitFor(`return !!mpfy.store.track('${Y}') && mpfy.store.isLiked('${Y}');`);
  await evaluate(`await mpfy.store.unlike('${Y}'); await mpfy.store.refresh(); return true;`);
  await sleep(1500);
  st = await mstate();
  const after = await evaluate(`return mpfy.store.isLiked('${Y}');`);
  check(liked === true && after === false && !st.phone.user.likes.some((x) => x.id === X), `${tag} an unlike of a retagged song (its old id liked) leaves it unliked after the next answer`);

  // A song on both: one row, both names, no "Elimina da Locale", played from the phone; a local-only song.
  await fetch(`${base}/__mock/reset?sources=1&profile=1&phone=1`);
  await go(`${base}/?nosw`, 2500);
  await waitFor(`return mpfy.store.lib.tracks.length >= 300;`);
  st = await mstate();
  const S2 = st.phone.same[0];
  const both = await evaluate(`return { rows: mpfy.store.lib.tracks.filter((t) => t.id === '${S2}').length, vs: mpfy.store.versions('${S2}').map((v) => v.sourceId), al: mpfy.store.d.albumOf.get('${S2}'), home: mpfy.store.principalId };`);
  check(both.rows === 1 && both.vs.length === 2 && both.vs.includes('0000') && both.vs.includes(mi.id) && both.home === mi.id, `${tag} a song on both: one song, two versions, the home the source (${JSON.stringify(both)})`);
  await go(`${base}/album/${both.al}?nosw`, 1800);
  const tm = await menuOf(S2);
  check(/Disponibile su:Mi A2: WAVLocale: WAV/.test(tm) && /Elimina da Mi A2/.test(tm) && !/Elimina da Locale/.test(tm), `${tag} a song on both: "Disponibile su:" lists both, no Elimina da Locale (${tm})`);
  await evaluate(`document.querySelector('.track-row[data-tid="${S2}"] .tr-main').click(); return true;`);
  await sleep(2500);
  await click(mobile ? '.mini-main' : '.pb-cover-btn');
  await sleep(1200);
  const chip = await text('.np .q-chip');
  const npSrc = await text('.np .np-src');
  check(chip === 'MAX' && npSrc === 'Locale', `${tag} Now Playing plays local first: "${chip}" and "${npSrc}"`);
  await shot(`${tag}-phone-now-playing`);
  await evaluate(`mpfy.player.pause(); history.back(); return true;`);
  await sleep(700);
  const lo = own[40];
  const loAl = await evaluate(`return mpfy.store.d.albumOf.get('${lo}');`);
  const putsBefore = (await mstate()).phone.shadow.puts.length;
  await go(`${base}/album/${loAl}?nosw`, 1800);
  const lm = await menuOf(lo);
  check(/Disponibile su:Locale: MP3/.test(lm) && !/Modifica informazioni|Cambia copertina|Commenti|Elimina da/.test(lm), `${tag} a local-only song: no "Modifica informazioni", no "Cambia copertina", no "Commenti" (${lm})`);
  // The core is told which of the phone's songs a real source holds: the whole set once, then
  // what moved (the source's copy deleted: that song is the phone's alone now).
  // (Each page load is a start: it tells the whole set once. That of this page is waited for: a
  // slower load tells it after the delete, rightly whole.)
  for (let i = 0; i < 40 && (await mstate()).phone.shadow.puts.length <= putsBefore; i++) await sleep(250);
  st = await mstate();
  const sh1 = st.phone.shadow;
  await evaluate(`await mpfy.store.deleteVersion('${S2}', '${mi.id}'); return true;`);
  let sh2 = sh1;
  for (let i = 0; i < 40 && sh2.size !== 19; i++) {
    await sleep(250);
    sh2 = (await mstate()).phone.shadow;
  }
  await sleep(1000);
  sh2 = (await mstate()).phone.shadow;
  const since = sh2.puts.slice(sh1.puts.length);
  check(sh1.size === 20 && sh1.key === mi.id && sh1.puts.some((p) => 'all' in p) && sh2.size === 19 && since.length === 1 && since[0].add === 0 && since[0].remove === 1, `${tag} the phone's songs a real source holds: told whole once, then what moved (${JSON.stringify(sh2.puts)})`);

  // The move: the phone's store holds data (written with the access off), then "Aggiungi fonte".
  await fetch(`${base}/__mock/reset?sources=0&profile=1&phone=1`);
  st = await mstate();
  const [A1, A2, A3] = [st.phone.tracks[30], st.phone.tracks[31], st.phone.tracks[32]];
  await fetch(`${base}/__mock/phone?state=off`);
  await go(`${base}/?nosw`, 2500);
  await evaluate(`await mpfy.store.like('${A1}'); await mpfy.store.like('${A2}'); const k = await mpfy.store.createPlaylist('Da tenere', '', ['${A1}']); const g = await mpfy.store.createPlaylist('Da togliere', '', ['${A2}']); window.__keep = k && k.id; window.__drop = g && g.id; mpfy.store.played('${A1}', { type: 'library', id: null }); return true;`);
  const dropId = await evaluate(`return window.__drop;`);
  await sleep(1500);
  st = await mstate();
  check(st.phone.state === 'off' && st.phone.user.likes.length === 2 && st.phone.user.playlists.length === 2 && st.phone.user.recents.length === 1, `${tag} the access off and data in the phone's store: a like works (permission off, a like and the move still work)`);
  await fetch(`${base}/__mock/phone?holdMoved=1`);
  await go(`${base}/impostazioni?nosw`, 1500);
  await click('.set-add');
  await sleep(700);
  await typeInto('.code-input', mi.code);
  await click('.as-form .btn-primary');
  const dt = await waitFor(`const t = document.querySelector('.layer-dialog .dialog-title'); return t ? t.textContent : '';`, 12000);
  const labels = new Set();
  for (let i = 0; i < 20; i++) {
    const l = await evaluate(`return document.querySelector('.layer-dialog .progress-label')?.textContent || '';`);
    if (l) labels.add(l);
    await sleep(150);
  }
  let mid = await miLib();
  check(dt === 'Copia su Mi A2' && mid.playlists.filter((p) => p.name === 'Da tenere').length === 1 && mid.likes.some((x) => x.id === A2), `${tag} the move after "Aggiungi fonte": "Copia su Mi A2" (${dt}; ${[...labels].join(' / ')})`);
  await shot(`${tag}-phone-move`);
  // Taken back on the phone while the pass waits: they must not come back on the source.
  await evaluate(`await mpfy.store.unlike('${A2}'); await mpfy.store.deletePlaylist('${dropId}'); return true;`);
  await sleep(600);
  await fetch(`${base}/__mock/phone?holdMoved=0`);
  const fin = await waitFor(`const l = document.querySelector('.layer-dialog .progress-label'); return l && /^Fatto/.test(l.textContent) ? l.textContent : '';`, 15000);
  st = await mstate();
  mid = await miLib();
  check(fin === 'Fatto' && st.phone.moved.length === 1 && st.phone.home === mi.id && !st.phone.user.likes.length && !st.phone.user.playlists.length, `${tag} the move ends with "Fatto", the phone's store empty, the home the source (${fin})`);
  check(mid.playlists.filter((p) => p.name === 'Da tenere').length === 1 && !mid.playlists.some((p) => p.name === 'Da togliere') && mid.likes.some((x) => x.id === A1) && !mid.likes.some((x) => x.id === A2) && mid.likes.length === 13 && mid.recents.filter((r) => r.trackId === A1).length === 1, `${tag} the move: an unlike and a playlist deletion made between two passes are not on the source; its own likes stay (${JSON.stringify({ likes: mid.likes.length, a1: mid.likes.some((x) => x.id === A1), a2: mid.likes.some((x) => x.id === A2), keep: mid.playlists.filter((p) => p.name === 'Da tenere').length, drop: mid.playlists.filter((p) => p.name === 'Da togliere').length, plays: mid.recents.filter((r) => r.trackId === A1).length })})`);
  await click('.layer-dialog .btn-primary');
  await sleep(500);

  // A move interrupted by a reload: resumed at the next start with no dialog, nothing twice.
  await evaluate(`await mpfy.sources.remove('${mi.id}'); return true;`);
  await waitFor(`return mpfy.store.principalId === '0000';`);
  await evaluate(`await mpfy.store.like('${A3}'); mpfy.store.played('${A3}', { type: 'library', id: null }); return true;`);
  await sleep(1500);
  await fetch(`${base}/__mock/phone?holdMoved=1`);
  await go(`${base}/impostazioni?nosw`, 1500);
  await click('.set-add');
  await sleep(700);
  await typeInto('.code-input', mi.code);
  await click('.as-form .btn-primary');
  await waitFor(`const t = document.querySelector('.layer-dialog .dialog-title'); return t ? t.textContent : '';`, 12000);
  await sleep(1500);
  await go(`${base}/?nosw`, 3000);
  const dlgAfter = await evaluate(`return !!document.querySelector('.layer-dialog');`);
  await fetch(`${base}/__mock/phone?holdMoved=0`);
  const done2 = await waitFor(`return mpfy.store.principalId === '${mi.id}';`, 20000);
  st = await mstate();
  mid = await miLib();
  check(!dlgAfter && done2 && st.phone.moved.length === 2 && mid.likes.filter((x) => x.id === A3).length === 1 && mid.recents.filter((r) => r.trackId === A3).length === 1 && mid.playlists.filter((p) => p.name === 'Da tenere').length === 1, `${tag} the move reloaded in the middle: resumed with no dialog, nothing twice (dialog ${dlgAfter}, moved ${st.phone.moved.length})`);
  await overflowCheck(`${tag} phone`);
}

// MPFY_SMOKE_ONLY=wayIn,roles runs only those parts; MPFY_SMOKE_VP=360 only the phone size, 1366
// only the wide one.
const ONLY = (process.env.MPFY_SMOKE_ONLY || '').split(',').filter(Boolean);
const want = (name) => !ONLY.length || ONLY.includes(name);
const PHONE = { width: 360, height: 800 };
const WIDE = { width: 1366, height: 768 };
const SIZES = { 360: [PHONE], 1366: [WIDE] }[process.env.MPFY_SMOKE_VP] || [PHONE, WIDE];
try {
  if (want('run')) for (const vp of SIZES) await run(vp);
  for (const vp of SIZES) {
    if (want('wayIn')) await wayIn(vp);
    if (want('wayBack')) await wayBack(vp);
    if (want('profile')) await profilePages(vp);
    if (want('photo')) await photo(vp);
    if (want('people')) await people(vp);
    if (want('chats')) await chats(vp);
    if (want('roles')) await roles(vp);
    if (want('uploads')) await uploadFlows(vp);
    if (want('player')) await playerFailover(vp);
    if (want('app')) await appMode(vp);
    if (want('update')) await appUpdate(vp);
    if (want('details')) await detailsSwitch(vp);
    if (want('card')) await cardRow(vp);
    if (want('genres')) await genres(vp);
    if (want('volume')) await evenVolume(vp);
    if (want('gapless')) await gapless(vp);
    if (want('labels')) await labels(vp);
  }
  // The phone's own music, at a phone's size and a PC's (1280x800).
  if (want('phone')) for (const vp of { 360: [PHONE], 1366: [{ width: 1280, height: 800 }] }[process.env.MPFY_SMOKE_VP] || [PHONE, { width: 1280, height: 800 }]) await phoneMusic(vp);
  if (want('older')) await olderPage();
  if (want('sw')) await swCheck();
} catch (err) {
  log('ERROR', err.stack || String(err));
  fails++;
} finally {
  // Failed loads are expected here (sources taken offline or unpaired under a running page);
  // exceptions and console.error calls are not.
  const relevant = consoleErrors.filter((e) => !e.startsWith('log: Failed to load resource'));
  log(`\nconsole errors (all ${consoleErrors.length}, unexpected ${relevant.length}):`);
  for (const e of consoleErrors) log(`   ${e}`);
  check(relevant.length === 0, 'no unexpected console errors');
  try {
    await cdp('Browser.close');
  } catch {
    /* already gone */
  }
  ws.close();
  mock.kill();
  await sleep(1500);
  browser.kill();
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(profile, { recursive: true, force: true });
      break;
    } catch {
      await sleep(1000);
    }
  }
}
log(`fails=${fails}`);
fs.writeFileSync(path.join(outDir, 'ui-smoke.log'), out.join('\n') + '\n');
console.log(`fails=${fails}`);
process.exit(fails ? 1 : 0);
