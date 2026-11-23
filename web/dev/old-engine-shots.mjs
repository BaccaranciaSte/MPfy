// The same screens drawn by an old Chromium (the Mi A2's WebView is Chrome 81 and is never
// updated) and by this PC's Edge, side by side, at the Mi A2's size in CSS pixels (360x681, the
// app's own viewport there): Home, Libreria, an album, Now Playing, Impostazioni, the upload
// sheet and the welcome screens, then Home with the update button and the owner's source page with
// "Cerca i dettagli in rete", the people (Amici, its search, a person's page, Recenti,
// Impostazioni > Social) and the chats (Amici with the groups, a 1:1 with its emoji panel, a
// group, a shared playlist, "Condividi con..."). Both get the same fake app (bridge 4), so both draw the app's UI, and
// the phone's own font (Roboto, from Android Studio's layout preview, where it is installed), so
// text fits as it does there. On both: no page exception or console error, no horizontal overflow,
// every cover square (aspect-ratio, or its fallback on engines older than Chrome 88), and every
// greeting whole beside the update button. Nothing touches a phone.
// Usage: node web/dev/old-engine-shots.mjs <old chrome.exe> <out dir>
//   (writes <out dir>/old-engine-shots.log, old-*.png, edge-*.png, side-*.png; exit 1 on a failure)
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [oldExe, outArg] = process.argv.slice(2);
if (!oldExe || !outArg) throw new Error('usage: node old-engine-shots.mjs <old chrome.exe> <out dir>');
const outDir = path.resolve(outArg);
const EDGE = process.env.MPFY_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const SIZE = { w: 360, h: 681 };
fs.mkdirSync(outDir, { recursive: true });
const out = [];
const log = (...a) => {
  out.push(a.join(' '));
  console.log(...a);
};
let fails = 0;
const check = (ok, label) => {
  log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) fails++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A headless browser with its own throwaway profile, and one page in it over DevTools. */
async function openBrowser(exe, name) {
  const prof = path.join(outDir, `${name}-profile`);
  fs.rmSync(prof, { recursive: true, force: true });
  fs.mkdirSync(prof, { recursive: true });
  const proc = spawn(exe, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio', '--remote-debugging-port=0', `--user-data-dir=${prof}`, 'about:blank'], { stdio: 'ignore' });
  let wsUrl = null;
  for (let i = 0; i < 150 && !wsUrl; i++) {
    await sleep(200);
    try {
      const [p] = fs.readFileSync(path.join(prof, 'DevToolsActivePort'), 'utf8').split('\n');
      wsUrl = (await (await fetch(`http://127.0.0.1:${p}/json/version`)).json()).webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
  }
  if (!wsUrl) throw new Error(`${name}: the browser did not start`);
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let seq = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') errors.push(`exception: ${m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text} ${m.params.exceptionDetails?.url || ''}`);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(`console.error: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(`log: ${m.params.entry.text} ${m.params.entry.url || ''}`);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(m.error.message));
      else resolve(m.result);
    }
  });
  const call = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => call(m, p, sessionId);
  await S('Page.enable');
  await S('Runtime.enable');
  await S('Log.enable');
  return {
    name,
    S,
    errors,
    navigate: (url) => S('Page.navigate', { url }),
    async evaluate(expr) {
      const r = await S('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    async shot(file) {
      const { data } = await S('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(outDir, file), Buffer.from(data, 'base64'));
    },
    async close() {
      // An old Chromium closes the socket before it answers: never wait more than a moment.
      await Promise.race([call('Browser.close').catch(() => {}), sleep(2000)]);
      ws.close();
      await sleep(800);
      try {
        proc.kill();
      } catch (err) {
        // On Windows a browser already on its way out refuses the signal (EPERM): what counts is
        // that it goes, so wait for it a moment and fail only when it stays.
        if (err.code !== 'EPERM') throw err;
        const gone = () => proc.exitCode !== null || proc.signalCode !== null;
        if (!gone()) await Promise.race([new Promise((resolve) => proc.once('exit', resolve)), sleep(5000)]);
        if (!gone()) throw err;
      }
      try {
        fs.rmSync(prof, { recursive: true, force: true });
      } catch {
        /* still closing */
      }
    },
  };
}

// The fake app, bridge 4. Its update state is read from localStorage (fake-update), so a screen can
// show the button.
const FAKE_APP = `(() => {
  window.MPfyNative = new Proxy({}, { get: (_, name) => () => {
    switch (name) {
      case 'bridgeVersion': return '4';
      case 'getStorage': return JSON.stringify({ downloadsBytes: 0, downloadsCount: 0, cacheBytes: 0 });
      case 'listDownloads': return JSON.stringify({ ids: [], progress: {}, items: [] });
      case 'getNetwork': return JSON.stringify({ type: 'wifi', metered: false });
      case 'getState': return JSON.stringify({ playing: false, queueId: null });
      case 'getQueue': return JSON.stringify({ queueId: null, index: 0, positionMs: 0, items: [] });
      case 'getUpdate': return localStorage.getItem('fake-update') || JSON.stringify({ state: 'none', versionName: '', progress: 0 });
      case 'getProfileFile': return JSON.stringify({ fileName: 'Bacca.mpfy', folder: 'Documents/MPfy', state: 'ok' });
      default: return undefined;
    }
  } });
})();`;

// Roboto, the face the phone draws the page with (no Windows browser has it): a variable font, so
// one file gives every weight. Added from memory (FontFace), which the page's CSP does not stop.
const ROBOTO = 'C:/Program Files/Android/Android Studio/plugins/design-tools/resources/layoutlib/data/fonts/Roboto-Regular.ttf';
const PHONE_FONT = fs.existsSync(ROBOTO)
  ? `(() => {
  try {
    const bin = atob('${fs.readFileSync(ROBOTO).toString('base64')}');
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const face = new FontFace('Roboto', buf.buffer, { weight: '100 900' });
    document.fonts.add(face);
    face.load();
  } catch (err) {
    console.error('phone font', err);
  }
})();`
  : null;

/** Every screen, driven the same way in both browsers. */
async function screens(t, base) {
  await t.S('Emulation.setDeviceMetricsOverride', { width: SIZE.w, height: SIZE.h, deviceScaleFactor: 1, mobile: true });
  await t.S('Emulation.setTouchEmulationEnabled', { enabled: true });
  await t.S('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_APP });
  if (PHONE_FONT) await t.S('Page.addScriptToEvaluateOnNewDocument', { source: PHONE_FONT });
  const go = async (url, wait = 2500) => {
    await t.navigate(url);
    for (let i = 0; i < 80; i++) {
      await sleep(150);
      try {
        if (await t.evaluate("return !!document.querySelector('#main > .view');")) break;
      } catch {
        /* still loading */
      }
    }
    await sleep(wait);
  };
  const look = async (name) => {
    const r = await t.evaluate(`
      const covers = [...document.querySelectorAll('.cover')].map((e) => e.getBoundingClientRect()).filter((b) => b.width > 1 && b.top < innerHeight && b.bottom > 0);
      const bad = covers.filter((b) => Math.abs(b.width - b.height) > 1).map((b) => Math.round(b.width) + 'x' + Math.round(b.height));
      const ua = /Chrome\\/[\\d.]+/.exec(navigator.userAgent);
      return { doc: document.documentElement.scrollWidth, vw: innerWidth, vh: innerHeight, covers: covers.length, bad, ua: ua ? ua[0] : navigator.userAgent };`);
    check(r.doc <= r.vw, `${t.name} ${name}: no horizontal overflow (${r.doc}/${r.vw})`);
    check(!r.bad.length, `${t.name} ${name}: every cover square (${r.covers} covers${r.bad.length ? `, not square: ${r.bad.slice(0, 5).join(' ')}` : ''})`);
    await t.shot(`${t.name}-${name}.png`);
    return r;
  };
  await fetch(`${base}/__mock/reset?sources=2`);
  await go(`${base}/?nosw`, 3500);
  const first = await look('home');
  log(`   ${t.name}: ${first.ua}, viewport ${first.vw}x${first.vh}`);
  await go(`${base}/library?nosw`);
  await look('library');
  const al = await t.evaluate("return [...mpfy.store.d.albums.values()].find((a) => a.name === 'Frequenze').id;");
  await go(`${base}/album/${al}?nosw`);
  await look('album');
  await t.evaluate(`const t = mpfy.store.d.albums.get(${JSON.stringify(al)}).trackIds[0]; mpfy.player.addToQueue([t]); (await import('/components/now-playing.js')).openNowPlaying(); return true;`);
  await sleep(2500);
  await look('now-playing');
  await t.evaluate('history.back(); return true;');
  await sleep(800);
  await go(`${base}/impostazioni?nosw`);
  await look('settings');
  await go(`${base}/?nosw`);
  await t.evaluate("document.querySelector('.home-top [aria-label=\"Carica brani\"]').click(); return true;");
  await sleep(1500);
  await look('upload-sheet');
  await fetch(`${base}/__mock/reset?sources=0&profile=0`);
  await go(`${base}/?nosw`, 2500);
  await look('welcome');
  await t.evaluate("const b = [...document.querySelectorAll('.welcome button')].find((x) => x.textContent.includes('Inizia')); if (b) b.click(); return true;");
  await sleep(1500);
  await look('welcome-name');
  await fetch(`${base}/__mock/reset?sources=2`);
  // Home with the update button, the arc at 42%: every greeting stays whole beside it.
  await go(`${base}/?nosw`, 1000);
  await t.evaluate(`localStorage.setItem('fake-update', ${JSON.stringify(JSON.stringify({ state: 'downloading', versionName: '2.1.0', progress: 0.42 }))}); return true;`);
  await go(`${base}/?nosw`, 3000);
  const upd = await t.evaluate(`
    const b = document.querySelector('.update-btn');
    const h1 = document.querySelector('.home-top h1');
    const arc = b && b.querySelector('.upd-arc');
    const was = h1.textContent;
    const fit = ['Buongiorno', 'Buon pomeriggio', 'Buonasera'].map((g) => { h1.textContent = g; return g + ' ' + h1.scrollWidth + '/' + h1.clientWidth; });
    h1.textContent = was;
    const font = [...document.fonts].some((f) => f.family.replace(/"/g, '') === 'Roboto' && f.status === 'loaded');
    return { shown: !!b, next: b && b.nextElementSibling ? b.nextElementSibling.getAttribute('aria-label') : null, offset: arc ? arc.getAttribute('stroke-dashoffset') : null, fit, font };`);
  check(upd.shown && upd.next === 'Carica brani' && upd.offset === '33.53', `${t.name} home-update: the button left of "Carica brani", the arc at 33.53 (${JSON.stringify({ next: upd.next, offset: upd.offset })})`);
  check(!PHONE_FONT || upd.font, `${t.name} home-update: drawn with the phone's font (Roboto loaded: ${upd.font})`);
  check(upd.fit.every((x) => { const [w, c] = x.split(' ').pop().split('/').map(Number); return w <= c; }), `${t.name} home-update: every greeting whole beside the button (${upd.fit.join(', ')})`);
  await look('home-update');
  await t.evaluate("localStorage.removeItem('fake-update'); return true;");
  // The owner's source page with "Cerca i dettagli in rete".
  const vps = (await (await fetch(`${base}/__mock/state`)).json()).servers.find((x) => x.name === 'VPS prova');
  await fetch(`${base}/__mock/source?source=${vps.id}&role=owner&details=1`);
  await go(`${base}/impostazioni/fonte/${vps.id}?nosw`, 3000);
  const sw = await t.evaluate(`
    const b = document.querySelector('.details-switch');
    if (!b) return null;
    const r = b.querySelector('.switch').getBoundingClientRect();
    return { checked: b.getAttribute('aria-checked'), right: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height), thumb: getComputedStyle(b.querySelector('.switch-thumb')).transform };`);
  check(!!sw && sw.checked === 'true' && sw.w === 44 && sw.h === 26 && sw.right <= SIZE.w && sw.thumb === 'matrix(1, 0, 0, 1, 18, 0)', `${t.name} source page: the switch on, a 44x26 track inside the page, the thumb at the right (${JSON.stringify(sw)})`);
  await look('source-switch');
  // The people: Amici, its search, a person's page, Recenti, Impostazioni > Social (as they are
  // without chats, sources at social 1; the chats follow).
  await fetch(`${base}/__mock/reset?sources=2`);
  await fetch(`${base}/__mock/chat?level=1`);
  await fetch(`${base}/__mock/social?history=40&step=600&midnight=1`);
  await go(`${base}/amici?nosw`, 3000);
  const am = await t.evaluate(`
    const rows = [...document.querySelectorAll('.view-friends .ami-row')];
    const sq = (e) => { const r = e.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); };
    return { n: rows.length, tops: rows.map((r) => Math.round(r.querySelector('.ami-top').getBoundingClientRect().height)), avs: rows.map((r) => sq(r.querySelector('.avatar'))), me: sq(document.querySelector('.view-friends .me-av')),
      badge: (() => { const b = document.querySelector('.view-friends .now-badge'); if (!b) return null; const a = b.parentElement.getBoundingClientRect(); const r = b.getBoundingClientRect(); return [Math.round(r.right - a.right), Math.round(r.bottom - a.bottom), sq(b)]; })() };`);
  check(am.n === 6 && am.tops.every((x) => x <= 26) && am.avs.every((x) => x === '48x48') && am.me === '48x48' && !!am.badge && am.badge[0] === 3 && am.badge[1] === 3 && am.badge[2] === '20x20', `${t.name} amici: six rows, each name and time on one line, round 48 px pictures, the playing badge at the picture's corner (${JSON.stringify(am)})`);
  await look('amici');
  await go(`${base}/amici?q=gi&nosw`, 2500);
  const se = await t.evaluate(`const f = document.querySelector('.bar-search .add-search').getBoundingClientRect(); const i = document.querySelector('.bar-search input').getBoundingClientRect(); return { h: Math.round(f.height), inside: i.top >= f.top - 1 && i.bottom <= f.bottom + 1, rows: document.querySelectorAll('.view-friends .ami-row').length };`);
  check(se.h === 40 && se.inside && se.rows === 2, `${t.name} amici-cerca: the field 40 px high with its input inside, two Giulia (${JSON.stringify(se)})`);
  await look('amici-cerca');
  await go(`${base}/persona/a7c1e0d2b3f4051627384950a1b2c3d4?nosw`, 3000);
  const pe = await t.evaluate(`const a = document.querySelector('.person-hero-avatar').getBoundingClientRect(); const n = document.querySelector('.meta-now-line'); return { w: Math.round(a.width), h: Math.round(a.height), mid: Math.round(Math.abs(a.left + a.width / 2 - innerWidth / 2)), now: !!n && n.getBoundingClientRect().height <= 34, cards: document.querySelectorAll('.detail-person .shelf .card').length };`);
  check(pe.w === pe.h && pe.w >= 200 && pe.mid <= 1 && pe.now && pe.cards === 3, `${t.name} persona: the picture round and as big as an artist's, centred; what she plays on one line; three cards (${JSON.stringify(pe)})`);
  await look('persona');
  await go(`${base}/recenti?nosw`, 3000);
  const re = await t.evaluate(`const d = document.querySelector('.view-recents .chat-day').getBoundingClientRect(); return { label: document.querySelector('.view-recents .chat-day').textContent, mid: Math.round(Math.abs(d.left + d.width / 2 - innerWidth / 2)), plays: [...document.querySelectorAll('.view-recents .vlist')].reduce((n, l) => n + Math.round(l.offsetHeight / parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--vrow-track'))), 0) };`);
  // Each day is a windowed list: its plays are counted from its height, not from the rows drawn.
  check(re.label === 'Oggi' && re.mid <= 1 && re.plays >= 40, `${t.name} recenti: the day centred over its plays (${JSON.stringify(re)})`);
  await look('recenti');
  await go(`${base}/impostazioni?nosw`, 2500);
  await t.evaluate(`document.querySelector('.social-section').scrollIntoView(); return true;`);
  await sleep(500);
  const so = await t.evaluate(`return [...document.querySelectorAll('.social-section .switch')].map((s) => { const r = s.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height) + (r.right <= innerWidth ? '' : '!'); });`);
  check(so.length === 4 && so.every((x) => x === '44x26'), `${t.name} settings-social: four switches, 44x26, inside the page (${so.join(' ')})`);
  await look('settings-social');
  // The chats: Amici with the groups, a 1:1 and a group, the emoji panel, the share sheet, a shared
  // playlist. The composer at the foot of the screen, the log scrolling between it and the top bar.
  await fetch(`${base}/__mock/reset?sources=2`);
  const cst = await (await fetch(`${base}/__mock/state`)).json();
  const gi = cst.chat.convs.find((c) => c.with === 'a7c1e0d2b3f4051627384950a1b2c3d4').id;
  const grp = cst.chat.convs.find((c) => c.kind === 'group' && c.count > 0).id;
  const sar = cst.chat.convs.find((c) => c.with === '8a2b4c6d8e0f1a3b5c7d9e1f2a4b6c8d').id;
  await go(`${base}/amici?nosw`, 3000);
  const ac = await t.evaluate(`
    const sq = (e) => { const r = e.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); };
    const f = document.querySelector('.view-friends .ami-fonti');
    const rows = [...document.querySelectorAll('.view-friends .ami-list > .ami-row')];
    const count = document.querySelector('.view-friends .badge.count');
    const bell = document.querySelector('.view-friends .muted-ic svg');
    return { stack: sq(f.querySelector('.src-stack')), marks: [...f.querySelectorAll('.src-mark')].map(sq), rows: rows.length, tops: rows.map((r) => Math.round(r.querySelector('.ami-top').getBoundingClientRect().height)), count: count && sq(count), bell: bell && sq(bell) };`);
  check(ac.stack === '48x48' && ac.marks.every((x) => x === '33x33') && ac.rows === 7 && ac.tops.every((x) => x <= 26) && ac.count === '20x20' && ac.bell === '14x14', `${t.name} amici-chats: "Fonti" with its two marks, seven rows each on one line, the round count, the crossed bell (${JSON.stringify(ac)})`);
  await look('amici-chats');
  await go(`${base}/chat/${gi}?nosw`, 3000);
  const ch = await t.evaluate(`
    const v = document.querySelector('.view-chat'); const s = v.querySelector('.chat-scroll'); const top = v.querySelector('.chat-top').getBoundingClientRect(); const dock = v.querySelector('.composer-dock').getBoundingClientRect();
    const bubbles = [...v.querySelectorAll('.bubble')].map((b) => b.getBoundingClientRect().width);
    const time = [...v.querySelectorAll('.bubble')].every((b) => { const r = b.getBoundingClientRect(); const t = b.querySelector('.msg-time').getBoundingClientRect(); return t.right <= r.right && t.bottom <= r.bottom && t.left >= r.left; });
    const cov = v.querySelector('.mcard-cover').getBoundingClientRect();
    return { top: Math.round(top.top), dock: Math.round(dock.bottom), vh: innerHeight, gap: Math.round(s.scrollHeight - s.scrollTop - s.clientHeight), scrolls: s.scrollHeight > s.clientHeight, wide: Math.round(Math.max(...bubbles)), time, cover: Math.round(cov.width) + 'x' + Math.round(cov.height), stack: getComputedStyle(document.querySelector('.bottom-stack')).display, send: Math.round(v.querySelector('.composer-send').getBoundingClientRect().width) };`);
  check(ch.top === 0 && ch.dock === ch.vh && ch.scrolls && ch.gap <= 2 && ch.wide <= 300 && ch.time && ch.cover === '56x56' && ch.stack === 'none' && ch.send === 44, `${t.name} chat: the top bar at the top, the composer at the foot, the log between them at its bottom, bubbles at most 300 px with their time inside, the card's cover 56 px (${JSON.stringify(ch)})`);
  await look('chat');
  await t.evaluate(`document.querySelector('.view-chat .composer-emoji').click(); return true;`);
  await sleep(1500);
  const em = await t.evaluate(`const p = document.querySelector('.emoji-panel'); const cells = [...p.querySelectorAll('.emoji-cell')]; const r = p.getBoundingClientRect(); const c0 = cells[0].getBoundingClientRect(); const row = cells.filter((c) => Math.round(c.getBoundingClientRect().top) === Math.round(c0.top)).length;
    return { h: Math.round(r.height), bottom: Math.round(r.bottom), vh: innerHeight, cell: Math.round(c0.width) + 'x' + Math.round(c0.height), row, drawn: cells.length, head: p.querySelector('.emoji-head').textContent };`);
  check(em.h === 260 && em.bottom === em.vh && em.cell === '40x40' && em.row >= 8 && em.drawn >= 100 && em.head === 'Faccine ed emozioni', `${t.name} emoji: the panel 260 px at the foot, a grid of 40 px cells, its first heading (${JSON.stringify(em)})`);
  await look('emoji');
  await go(`${base}/chat/${grp}?nosw`, 3000);
  const gc = await t.evaluate(`const a = [...document.querySelectorAll('.view-chat .msg-av:not(.blank) .avatar')].map((e) => Math.round(e.getBoundingClientRect().width)); const n = document.querySelector('.view-chat .msg-name'); return { avs: a, name: n && Math.round(n.getBoundingClientRect().height) };`);
  check(gc.avs.length >= 3 && gc.avs.every((x) => x === 28) && gc.name > 0 && gc.name <= 20, `${t.name} gruppo: the senders' photos 28 px, their names on one line (${JSON.stringify(gc)})`);
  await look('gruppo');
  await go(`${base}/chat/${sar}?nosw`, 3000);
  await t.evaluate(`document.querySelector('.view-chat .mcard-link').click(); return true;`);
  await sleep(3000);
  const sv = await t.evaluate(`const v = document.querySelector('#main .detail-shared'); return v && { title: v.querySelector('.hero-title').textContent, rows: v.querySelectorAll('.track-row').length };`);
  check(!!sv && sv.title === 'Studio notturno' && sv.rows === 5, `${t.name} condivisa: the shared playlist with the tracks the library has (${JSON.stringify(sv)})`);
  await look('condivisa');
  const alb = await t.evaluate("return [...mpfy.store.d.albums.values()].find((a) => a.name === 'Frequenze').id;");
  await go(`${base}/album/${alb}?nosw`, 2500);
  await t.evaluate(`document.querySelector('#main .track-row .tr-more').click(); return true;`);
  await sleep(1000);
  await t.evaluate(`[...document.querySelectorAll('.layer-sheet .menu-item')].find((x) => x.textContent === 'Condividi con...').click(); return true;`);
  await sleep(1500);
  const sh = await t.evaluate(`const s = document.querySelector('.layer-sheet:not(.closing) .share-sheet'); const r = s.getBoundingClientRect(); const l = s.querySelector('.share-list'); const send = s.querySelector('.share-send .btn').getBoundingClientRect();
    return { h: Math.round(r.height), vh: innerHeight, scrolls: l.scrollHeight > l.clientHeight, send: Math.round(send.bottom) <= innerHeight, rows: s.querySelectorAll('.pick-row').length };`);
  check(Math.abs(sh.h - Math.round(sh.vh * 0.88)) <= 2 && sh.scrolls && sh.send && sh.rows >= 6, `${t.name} condividi: the sheet 88% of the screen, its list scrolling, the note and "Invia" in view (${JSON.stringify(sh)})`);
  await look('condividi');
  await fetch(`${base}/__mock/reset?sources=2`);
  const relevant = t.errors.filter((e) => !e.startsWith('log: Failed to load resource'));
  for (const e of t.errors) log(`   ${t.name} ${e}`);
  check(relevant.length === 0, `${t.name}: no page exceptions or console errors (${relevant.length})`);
}

const mock = spawn(process.execPath, [path.join(HERE, 'mock-server.mjs')], {
  env: { ...process.env, MOCK_PORT: '0', MOCK_DELAY: '20', MOCK_SOURCES: '2' },
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
try {
  for (const [exe, name] of [
    [oldExe, 'old'],
    [EDGE, 'edge'],
  ]) {
    log(`== ${name}`);
    const b = await openBrowser(exe, name);
    try {
      await screens(b, base);
    } catch (err) {
      log(`ERROR ${name}`, err.stack || String(err));
      fails++;
    } finally {
      await b.close();
    }
  }
  // ---- side by side ----
  const b = await openBrowser(EDGE, 'side');
  try {
    await b.S('Emulation.setDeviceMetricsOverride', { width: SIZE.w * 2 + 12, height: SIZE.h + 32, deviceScaleFactor: 1, mobile: false });
    for (const f of fs.readdirSync(outDir).filter((x) => /^old-.*\.png$/.test(x))) {
      const name = f.slice(4, -4);
      const edge = path.join(outDir, `edge-${name}.png`);
      if (!fs.existsSync(edge)) continue;
      const img = (p) => `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`;
      const col = (title, p) => `<div style="width:${SIZE.w}px"><div style="height:24px;padding:4px 8px;box-sizing:border-box">${title}</div><img src="${img(p)}" style="width:${SIZE.w}px;display:block"></div>`;
      const html = `<html><body style="margin:0;background:#000;color:#ccc;font:13px sans-serif;display:flex">${col('Chromium 81 (the Mi A2 WebView engine)', path.join(outDir, f))}<div style="width:12px"></div>${col('Edge (current)', edge)}</body></html>`;
      await b.navigate('about:blank');
      await sleep(300);
      await b.S('Runtime.evaluate', { expression: `document.open(); document.write(${JSON.stringify(html)}); document.close();` });
      await sleep(600);
      await b.shot(`side-${name}.png`);
    }
  } finally {
    await b.close();
  }
} catch (err) {
  log('ERROR', err.stack || String(err));
  fails++;
} finally {
  mock.kill();
}
log(`fails=${fails}`);
fs.writeFileSync(path.join(outDir, 'old-engine-shots.log'), out.join('\n') + '\n');
process.exit(fails ? 1 : 0);
