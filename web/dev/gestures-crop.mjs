// The profile photo's crop screen under fast and odd input, on a phone screen with touch (and a
// desktop window with the mouse wheel). Test images are drawn in the page and given to the picker
// as files: a JPEG with EXIF orientation 6 (stored on its side), one in four coloured parts, a
// PNG of noise, and bytes that are no image.
//   open      double and triple taps on the photo open one menu; "Cambia foto" opens the picker
//   upright   the rotated JPEG shows upright under the circle and is saved upright (320 x 320)
//   moves     flings, taps during a fling, double and triple taps, two fingers (a pinch, one lifted
//             and the other moving on, a third finger): the image always covers the circle, never
//             under it, never more than 4 times it; a pinch zooms around its middle
//   save      a double and a triple tap on "Salva": one upload; what is saved is what the circle
//             shows (dragged to a corner: the four parts where they are); the photo then shows;
//             an image too rich for 48 KB at quality 0.85 is encoded again lower
//   fail      a core that refuses: "Foto non salvata", the screen stays, one upload per burst
//   leave     the system back and the close button leave without an upload; bytes that are no
//             image: "Immagine non valida"
//   wheel     the mouse wheel zooms around the pointer, between covering and 4 times (1366 x 768)
//
//   node web/dev/gestures-crop.mjs <out dir> [--only name|name]
//
// Prints PASS/FAIL lines and fails=<n> (exit 1 on a failure); the same lines and the details go to
// <out dir>/gestures-crop.log.
import fs from 'node:fs';
import path from 'node:path';
import { startMock, startBrowser, touchFling, tap, doubleTap, sleep, logger } from './gesture-lib.mjs';

const outDir = path.resolve(process.argv[2] || '.');
fs.mkdirSync(outDir, { recursive: true });
const onlyAt = process.argv.indexOf('--only');
const only = onlyAt > 0 ? process.argv[onlyAt + 1].split('|') : null;
const L = logger(path.join(outDir, 'gestures-crop.log'));
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

async function fresh(route = '/impostazioni/profilo', q = 'sources=2') {
  await touch('touchCancel', []).catch(() => {});
  await b.S('Page.navigate', { url: 'about:blank' });
  await sleep(200);
  await b.S('Storage.clearDataForOrigin', { origin: base, storageTypes: 'local_storage,indexeddb,service_workers,cache_storage' });
  await fetch(`${base}/__mock/reset?${q}`);
  await b.go(`${base}${route}${route.includes('?') ? '&' : '?'}nosw`, 600);
  await run(`for (let i = 0; i < 60 && !(window.mpfy && mpfy.store.loaded && mpfy.profile.loaded); i++) await new Promise((r) => setTimeout(r, 100)); return true;`);
  await sleep(400);
  // The system picker is not opened: the input it would fill is kept for the check.
  await run(`window.__picks = 0; const click = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () { if (this.type !== 'file') return click.call(this); window.__picks++; };
    return true;`);
}

// ---- test images, drawn in the page and saved as files ----
const IMAGES = `const jpeg = async (c, q = 0.92) => new Uint8Array(await new Response(await new Promise((r) => c.toBlob(r, 'image/jpeg', q))).arrayBuffer());
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return btoa(s); };
  // Stored on its side (200 x 300: red on the left, blue on the right) with EXIF orientation 6:
  // upright it is 300 x 200, red on top, blue below.
  const r = document.createElement('canvas'); r.width = 200; r.height = 300;
  const rg = r.getContext('2d'); rg.fillStyle = '#ff0000'; rg.fillRect(0, 0, 100, 300); rg.fillStyle = '#0000ff'; rg.fillRect(100, 0, 100, 300);
  const raw = await jpeg(r);
  const tiff = [0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0];
  const app1 = [0xff, 0xe1, 0, 2 + 6 + tiff.length, 0x45, 0x78, 0x69, 0x66, 0, 0].concat(tiff);
  const rot = new Uint8Array(raw.length + app1.length);
  rot.set(raw.subarray(0, 2), 0); rot.set(app1, 2); rot.set(raw.subarray(2), 2 + app1.length);
  // 1600 x 1200 in four parts split off the middle, at x 500 and y 400: red, green / blue, yellow.
  const q = document.createElement('canvas'); q.width = 1600; q.height = 1200;
  const qg = q.getContext('2d');
  [['#ff0000', 0, 0, 500, 400], ['#00ff00', 500, 0, 1100, 400], ['#0000ff', 0, 400, 500, 800], ['#ffff00', 500, 400, 1100, 800]].forEach(([c, x, y, w, hh]) => { qg.fillStyle = c; qg.fillRect(x, y, w, hh); });
  // 320 x 320 of loud noise, as a PNG: a JPEG of it at 0.85 is far above 48 KB.
  const n = document.createElement('canvas'); n.width = 320; n.height = 320;
  const ng = n.getContext('2d'); const nd = ng.createImageData(320, 320);
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < nd.data.length; i += 4) { nd.data[i] = rnd() * 255; nd.data[i + 1] = rnd() * 255; nd.data[i + 2] = rnd() * 255; nd.data[i + 3] = 255; }
  ng.putImageData(nd, 0, 0);
  const png = new Uint8Array(await new Response(await new Promise((r) => n.toBlob(r, 'image/png'))).arrayBuffer());
  return { rotated: b64(rot), quarters: b64(await jpeg(q)), noise: b64(png), noise85: (await jpeg(n, 0.85)).length };`;
const files = {};
async function makeImages() {
  if (files.rotated) return;
  const imgs = await run(IMAGES);
  files.noise85 = imgs.noise85;
  for (const k of ['rotated', 'quarters', 'noise']) {
    files[k] = path.join(outDir, `crop-${k}.${k === 'noise' ? 'png' : 'jpg'}`);
    fs.writeFileSync(files[k], Buffer.from(imgs[k], 'base64'));
  }
  files.junk = path.join(outDir, 'crop-junk.jpg');
  fs.writeFileSync(files.junk, Buffer.from('not an image at all, just words'.repeat(20)));
}

/** The center of the first element matching sel (whose text includes text). */
const at = (sel, text = null) =>
  run(`const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => ${JSON.stringify(text)} == null || x.textContent.includes(${JSON.stringify(text)}));
    if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };`);
const layersNow = () => run(`return [...document.querySelectorAll('#layers > .layer:not(.closing)')].map((l) => l.className);`);
const toastsNow = () => run(`return [...document.querySelectorAll('.toast')].map((t) => t.textContent);`);

/** The picker the page asked for gets this file. */
async function giveFile(file) {
  const { root } = await b.S('DOM.getDocument', { depth: -1, pierce: true });
  const { nodeId } = await b.S('DOM.querySelector', { nodeId: root.nodeId, selector: 'body > input[type=file]' });
  if (!nodeId) return false;
  await b.S('DOM.setFileInputFiles', { nodeId, files: [file] });
  return true;
}

/** From the Profilo page: the photo, "Cambia foto", the file; the crop screen open and still. */
async function openCrop(file) {
  const ph = await at('#main .photo-btn');
  await tap(b, ph.x, ph.y);
  await sleep(600);
  const ch = await at('#layers .menu-item', 'Cambia foto');
  await tap(b, ch.x, ch.y);
  await sleep(500);
  const given = await giveFile(file);
  await sleep(900);
  return given;
}

// The crop as it is on screen: the image's box, the circle's box, whether it covers it.
const CROP = `const st = document.querySelector('.layer:not(.closing) .crop-stage'); if (!st) return null;
  const img = st.querySelector('.crop-img'); const a = img.getBoundingClientRect(); const c = st.querySelector('.crop-window').getBoundingClientRect();
  const min = c.width / Math.min(img.naturalWidth, img.naturalHeight);
  return { img: [a.left, a.top, a.width, a.height].map((x) => Math.round(x * 10) / 10), ring: [c.left, c.top, c.width, c.height].map((x) => Math.round(x * 10) / 10),
    covers: a.left <= c.left + 0.6 && a.top <= c.top + 0.6 && a.right >= c.right - 0.6 && a.bottom >= c.bottom - 0.6,
    zoom: Math.round((a.width / img.naturalWidth / min) * 1000) / 1000, nat: [img.naturalWidth, img.naturalHeight],
    cx: Math.round(c.left + c.width / 2), cy: Math.round(c.top + c.height / 2), d: Math.round(c.width) };`;
const crop = () => run(CROP);
const inBounds = (c) => !!c && c.covers && c.zoom >= 0.999 && c.zoom <= 4.001;

/** The color under a point of the screen (CSS px), from a screenshot read back in the page. */
async function screenColors(points) {
  const { data } = await b.S('Page.captureScreenshot', { format: 'png' });
  return run(`const img = new Image(); img.src = 'data:image/png;base64,${data}'; await img.decode();
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const k = img.naturalWidth / innerWidth;
    return ${JSON.stringify(points)}.map(([x, y]) => name(Array.from(g.getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data)));
    function name([r, gg, bb]) { const hi = (v) => v > 150; const lo = (v) => v < 100; if (hi(r) && lo(gg) && lo(bb)) return 'red'; if (lo(r) && hi(gg) && lo(bb)) return 'green'; if (lo(r) && lo(gg) && hi(bb)) return 'blue'; if (hi(r) && hi(gg) && lo(bb)) return 'yellow'; return [r, gg, bb].join(','); }`);
}
/** The saved photo, as the core gives it back: its size and the colors at points of it. */
const savedColors = (points) =>
  run(`const res = await fetch('/local/profile/photo', { cache: 'no-store' }); if (!res.ok) return { status: res.status };
    const img = new Image(); img.src = URL.createObjectURL(await res.blob()); await img.decode();
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const name = ([r, gg, bb]) => { const hi = (v) => v > 150; const lo = (v) => v < 100; if (hi(r) && lo(gg) && lo(bb)) return 'red'; if (lo(r) && hi(gg) && lo(bb)) return 'green'; if (lo(r) && lo(gg) && hi(bb)) return 'blue'; if (hi(r) && hi(gg) && lo(bb)) return 'yellow'; return [r, gg, bb].join(','); };
    return { status: res.status, size: [img.naturalWidth, img.naturalHeight], colors: ${JSON.stringify(points)}.map(([x, y]) => name(Array.from(g.getImageData(x, y, 1, 1).data))) };`);

/** Two fingers from distance d0 to d1 around (cx, cy), in steps. */
async function pinch(cx, cy, d0, d1, { steps = 8, ms = 12, lift = true } = {}) {
  const pts = (d) => [{ x: cx - d / 2, y: cy, id: 1 }, { x: cx + d / 2, y: cy, id: 2 }];
  await touch('touchStart', pts(d0));
  for (let i = 1; i <= steps; i++) {
    await sleep(ms);
    await touch('touchMove', pts(d0 + ((d1 - d0) * i) / steps));
  }
  if (lift) await touch('touchEnd', []);
}

const scenarios = [];
const scenario = (name, fn) => scenarios.push({ name, fn });

scenario('open', async () => {
  for (const count of [2, 3]) {
    await fresh();
    const ph = await at('#main .photo-btn');
    const letter = await run(`return (document.querySelector('#main .photo-btn .avatar-initial') || {}).textContent || null;`);
    await doubleTap(b, ph.x, ph.y, { gap: 120, hold: 60, count });
    await sleep(700);
    const l = await layersNow();
    const items = await run(`return [...document.querySelectorAll('#layers .layer:not(.closing) .menu-item')].map((e) => e.textContent.trim());`);
    check(letter === 'B' && l.length === 1 && items.join('|') === 'Cambia foto', `${count} taps on the photo: one menu, "Cambia foto" only (no photo yet: the letter ${letter})`, { l, items });
    const ch = await at('#layers .menu-item', 'Cambia foto');
    await doubleTap(b, ch.x, ch.y, { gap: 120, hold: 60, count });
    await sleep(700);
    check((await run('return window.__picks;')) === 1 && (await layersNow()).length === 0, `${count} taps on "Cambia foto": one picker`, { picks: await run('return window.__picks;') });
  }
});

scenario('upright', async () => {
  await fresh();
  await makeImages();
  await openCrop(files.rotated);
  const c = await crop();
  L.log('rotated crop', JSON.stringify(c));
  check(!!c && c.nat[0] === 300 && c.nat[1] === 200 && c.d === 280 && inBounds(c) && Math.abs(c.zoom - 1) < 0.002, `the rotated JPEG: 300 x 200 upright, a 280 px circle it just covers (${JSON.stringify(c && { nat: c.nat, d: c.d, zoom: c.zoom })})`, c);
  const r = c.d / 4;
  const seen = await screenColors([[c.cx, c.cy - r], [c.cx, c.cy + r], [c.cx - r, c.cy - r], [c.cx + r, c.cy - r]]);
  check(seen.join('|') === 'red|blue|red|red', `under the circle it shows upright: red on top, blue below (${seen.join(', ')})`);
  const save = await at('.layer:not(.closing) .crop-save');
  await tap(b, save.x, save.y);
  await sleep(1500);
  const saved = await savedColors([[160, 30], [160, 290], [30, 60], [290, 60]]);
  check(saved.status === 200 && saved.size.join('x') === '320x320' && saved.colors.join('|') === 'red|blue|red|red', `saved upright: 320 x 320, red on top, blue below (${JSON.stringify(saved)})`);
});

scenario('moves', async () => {
  await fresh();
  await makeImages();
  await openCrop(files.quarters);
  let c = await crop();
  check(inBounds(c) && Math.abs(c.zoom - 1) < 0.002, `the crop opens just covering the circle (zoom ${c && c.zoom})`, c);
  const bad = [];
  const look = async (what) => {
    const x = await crop();
    if (!inBounds(x)) bad.push({ what, x });
    return x;
  };
  // Flings far beyond every edge, fast.
  for (const [dx, dy] of [[900, 0], [-900, 0], [0, 900], [0, -900], [700, 700], [-700, -700]]) {
    await touchFling(b, { x: c.cx, y: c.cy, dx: dx / 3, dy: dy / 3, speed: 9000 });
    await look(`fling ${dx},${dy}`);
  }
  // Taps during a fling, double and triple taps on the image.
  await touchFling(b, { x: c.cx - 60, y: c.cy, dx: 200, speed: 7000 });
  await tap(b, c.cx, c.cy, { hold: 40 });
  await look('a tap after a fling');
  const before = await crop();
  await doubleTap(b, c.cx, c.cy, { gap: 100, hold: 50, count: 3 });
  await sleep(200);
  const after = await look('a triple tap');
  check(!!after && after.zoom === before.zoom && after.img.join() === before.img.join(), `a triple tap on the image moves and zooms nothing (${before.zoom} -> ${after && after.zoom})`);
  // A pinch out around a point off the middle: that point stays under the fingers.
  c = await crop();
  const px = c.cx - 40;
  const imgPoint = (x) => (px - x.img[0]) / x.img[2];
  const u0 = imgPoint(c);
  await pinch(px, c.cy, 80, 160);
  await sleep(150);
  const z = await look('a pinch out');
  check(!!z && z.zoom > 1.8 && z.zoom < 2.2 && Math.abs(imgPoint(z) - u0) < 0.002, `a pinch from 80 to 160 px: about twice, around its middle (zoom ${z && z.zoom}, the point under it ${u0.toFixed(3)} -> ${z && imgPoint(z).toFixed(3)})`, z);
  // Far beyond 4 times, and back below covering.
  await pinch(c.cx, c.cy, 40, 300, { steps: 12 });
  await pinch(c.cx, c.cy, 40, 300, { steps: 12 });
  const big = await look('pinches far out');
  check(!!big && Math.abs(big.zoom - 4) < 0.01, `pinches far out stop at 4 times (${big && big.zoom})`);
  await pinch(c.cx, c.cy, 300, 30, { steps: 12 });
  await pinch(c.cx, c.cy, 300, 30, { steps: 12 });
  const small = await look('pinches far in');
  check(!!small && Math.abs(small.zoom - 1) < 0.01, `pinches far in stop where the image covers the circle (${small && small.zoom})`);
  // Two fingers, one lifted, the other moving on: the image follows it from where it is, no jump.
  // The emulated touch screen lifts every finger at once: here the pointers are the page's own.
  const lift = await run(`const st = document.querySelector('.layer:not(.closing) .crop-stage'); const img = st.querySelector('.crop-img');
    const fire = (type, id, x, y) => st.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: id === 71, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true }));
    const left = () => Math.round(img.getBoundingClientRect().left * 10) / 10;
    const zoom = () => Math.round(img.getBoundingClientRect().width * 1000) / 1000;
    fire('pointerdown', 71, ${c.cx - 50}, ${c.cy}); fire('pointerdown', 72, ${c.cx + 50}, ${c.cy});
    for (let i = 1; i <= 5; i++) { fire('pointermove', 71, ${c.cx - 50} - i * 10, ${c.cy}); fire('pointermove', 72, ${c.cx + 50} + i * 10, ${c.cy}); }
    const pinched = { left: left(), width: zoom() };
    fire('pointerup', 72, ${c.cx + 100}, ${c.cy});
    const lifted = { left: left(), width: zoom() };
    fire('pointermove', 71, ${c.cx - 100} + 40, ${c.cy});
    const moved = { left: left(), width: zoom() };
    fire('pointerup', 71, ${c.cx - 60}, ${c.cy});
    return { pinched, lifted, moved };`);
  check(lift.pinched.width > c.img[2] * 1.5 && lift.lifted.left === lift.pinched.left && Math.abs(lift.moved.left - lift.lifted.left - 40) < 1 && lift.moved.width === lift.lifted.width, `a finger lifted from a pinch: no jump, the other moves the image on, no zoom (${lift.pinched.left} -> ${lift.lifted.left} -> ${lift.moved.left})`, lift);
  await look('one finger moving on after a pinch');
  // A third finger does nothing; one finger afterwards still moves the image.
  const three0 = await crop();
  await touch('touchStart', [{ x: c.cx - 50, y: c.cy, id: 1 }, { x: c.cx + 50, y: c.cy, id: 2 }]);
  await sleep(20);
  await touch('touchMove', [{ x: c.cx - 50, y: c.cy, id: 1 }, { x: c.cx + 50, y: c.cy, id: 2 }, { x: c.cx, y: c.cy + 80, id: 3 }]);
  await sleep(20);
  await touch('touchMove', [{ x: c.cx - 50, y: c.cy, id: 1 }, { x: c.cx + 50, y: c.cy, id: 2 }, { x: c.cx, y: c.cy + 160, id: 3 }]);
  await sleep(20);
  await touch('touchEnd', []);
  const three = await look('a third finger');
  check(!!three && three.zoom === three0.zoom && three.img.join() === three0.img.join(), 'a third finger moving while two rest: nothing moves');
  const slack = three.img[0] + three.img[2] - (three.ring[0] + three.ring[2]);
  const dx = slack > 30 ? -30 : 30;
  await touchFling(b, { x: c.cx, y: c.cy, dx, speed: 600 });
  await sleep(100);
  const alive = await look('one finger after three');
  check(!!alive && Math.abs(alive.img[0] - three.img[0] - dx) < 2, `one finger after them still moves the image (${three.img[0]} -> ${alive && alive.img[0]})`);
  check(bad.length === 0, `after every gesture the image covers the circle, at 1 to 4 times (${bad.length} not)`, bad);
});

scenario('save', async () => {
  for (const count of [2, 3]) {
    await fresh();
    await makeImages();
    await openCrop(files.quarters);
    const c = await crop();
    // Dragged to its top left corner: the circle shows the image's 1200 x 1200 from there, the
    // split at 117 and 93 px of its 280. The points are where a square from the middle (x from 200)
    // shows other colours.
    await touchFling(b, { x: c.cx - 100, y: c.cy - 100, dx: 260, dy: 260, speed: 3000 });
    await sleep(200);
    const [rx, ry] = c.ring;
    const shown = await screenColors([[rx + 92, ry + 44], [rx + 219, ry + 44], [rx + 92, ry + 219], [rx + 219, ry + 219]]);
    const save = await at('.layer:not(.closing) .crop-save');
    await doubleTap(b, save.x, save.y, { gap: 110, hold: 50, count });
    await sleep(1600);
    const st = await mockState();
    const saved = await savedColors([[105, 50], [250, 50], [105, 250], [250, 250]]);
    const shows = await run(`const i = document.querySelector('#main .photo-btn .avatar-photo'); return i ? { src: i.getAttribute('src'), ok: i.complete && i.naturalWidth === 320 } : null;`);
    check(st.photoPuts === 1 && !!st.photo && (await layersNow()).length === 0, `${count} taps on "Salva": one upload (${st.photoPuts}), the screen closes`);
    check(shown.join('|') === 'red|green|blue|yellow' && saved.colors.join('|') === shown.join('|'), `what is saved is what the circle showed (${shown.join(', ')} / ${saved.colors && saved.colors.join(', ')})`, saved);
    check(!!shows && shows.ok && shows.src === `/local/profile/photo?v=${st.photo.hash}`, `the Profilo page shows the new photo (${shows && shows.src})`);
    check(st.photo.size <= 48 * 1024, `the photo is at most 48 KB (${st.photo.size} bytes)`);
  }
  // Noise: at 0.85 far above 48 KB; saved lower, under the limit, in one upload.
  await fresh();
  await makeImages();
  await openCrop(files.noise);
  const save = await at('.layer:not(.closing) .crop-save');
  await doubleTap(b, save.x, save.y, { gap: 110, hold: 50 });
  await sleep(1800);
  const st = await mockState();
  check(files.noise85 > 48 * 1024 && st.photoPuts === 1 && !!st.photo && st.photo.size <= 48 * 1024 && st.photo.size > 24 * 1024 && (await layersNow()).length === 0, `an image too rich for 48 KB at 0.85 (${files.noise85} bytes): encoded again lower, saved at ${st.photo && st.photo.size} bytes, one upload`);
});

scenario('fail', async () => {
  await fresh();
  await makeImages();
  await fetch(`${base}/__mock/core?photoFail=1`);
  try {
    await openCrop(files.quarters);
    const save = await at('.layer:not(.closing) .crop-save');
    await doubleTap(b, save.x, save.y, { gap: 110, hold: 50, count: 3 });
    await sleep(1200);
    const st = await mockState();
    const t = await toastsNow();
    check(st.photoPuts === 1 && t.includes('Foto non salvata') && (await crop()) !== null, `a core that refuses, three taps on "Salva": one upload, "Foto non salvata", the screen stays (${st.photoPuts}, ${JSON.stringify(t)})`);
    await fetch(`${base}/__mock/core?photoFail=0`);
    await sleep(500);
    await tap(b, save.x, save.y);
    await sleep(1400);
    const st2 = await mockState();
    check(st2.photoPuts === 2 && !!st2.photo && (await layersNow()).length === 0, `a tap later, the core answering: saved, closed (${st2.photoPuts})`);
  } finally {
    await fetch(`${base}/__mock/core?photoFail=0`);
  }
});

scenario('leave', async () => {
  await fresh();
  await makeImages();
  await openCrop(files.quarters);
  await run('history.back(); return true;');
  await sleep(800);
  check((await crop()) === null && (await layersNow()).length === 0 && (await mockState()).photoPuts === 0 && (await run('return location.pathname;')) === '/impostazioni/profilo', 'the system back closes the crop, nothing saved, the Profilo page stays');
  await openCrop(files.quarters);
  const close = await at('.layer:not(.closing) .panel-head .icon-btn[aria-label="Chiudi"]');
  await doubleTap(b, close.x, close.y, { gap: 110, hold: 50 });
  await sleep(800);
  check((await crop()) === null && (await layersNow()).length === 0 && (await mockState()).photoPuts === 0 && (await run('return location.pathname;')) === '/impostazioni/profilo', 'a double tap on the close button: closed, nothing saved, the Profilo page stays');
  await openCrop(files.junk);
  await sleep(300);
  const t = await toastsNow();
  check((await crop()) === null && t.includes('Immagine non valida'), `bytes that are no image: "Immagine non valida", no crop (${JSON.stringify(t)})`);
});

scenario('wheel', async () => {
  await b.S('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
  await b.S('Emulation.setTouchEmulationEnabled', { enabled: false });
  await fresh();
  await makeImages();
  const click = async (p) => {
    await b.S('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await b.S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  };
  await click(await at('#main .photo-btn'));
  await sleep(600);
  await click(await at('#layers .menu-item', 'Cambia foto'));
  await sleep(500);
  await giveFile(files.quarters);
  await sleep(900);
  const c = await crop();
  check(!!c && c.d === 280 && inBounds(c), `the crop beside the page: a 280 px circle (${c && c.d})`, c);
  const wheel = (x, y, deltaY) => b.S('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
  const px = c.cx + 50;
  const u0 = (px - c.img[0]) / c.img[2];
  for (let i = 0; i < 3; i++) {
    await wheel(px, c.cy, -120);
    await sleep(40);
  }
  await sleep(200);
  const z = await crop();
  const u1 = (px - z.img[0]) / z.img[2];
  check(z.zoom > 1.3 && inBounds(z) && Math.abs(u1 - u0) < 0.01, `the wheel zooms in around the pointer (zoom ${z.zoom}, the point under it ${u0.toFixed(3)} -> ${u1.toFixed(3)})`, z);
  for (let i = 0; i < 30; i++) await wheel(px, c.cy, -400);
  await sleep(200);
  const big = await crop();
  for (let i = 0; i < 30; i++) await wheel(px, c.cy, 400);
  await sleep(200);
  const small = await crop();
  check(Math.abs(big.zoom - 4) < 0.01 && Math.abs(small.zoom - 1) < 0.01 && inBounds(big) && inBounds(small), `the wheel stops at 4 times and where the image covers the circle (${big.zoom}, ${small.zoom})`);
  // A drag with the mouse moves it, as far as it has room to.
  const room = small.img[0] + small.img[2] - (small.ring[0] + small.ring[2]) > small.ring[0] - small.img[0] ? -1 : 1;
  const far = room < 0 ? small.img[0] + small.img[2] - (small.ring[0] + small.ring[2]) : small.ring[0] - small.img[0];
  const by = room * Math.min(30, Math.floor(far) - 1);
  await b.S('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.cx, y: c.cy, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 6; i++) await b.S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.cx + (i * by) / 6, y: c.cy, button: 'left', buttons: 1 });
  await b.S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.cx + by, y: c.cy, button: 'left', clickCount: 1 });
  await sleep(100);
  const dragged = await crop();
  check(Math.abs(by) >= 20 && Math.abs(dragged.img[0] - small.img[0] - by) < 1.5 && inBounds(dragged), `a mouse drag moves the image (${small.img[0]} -> ${dragged.img[0]}, by ${by})`);
  await b.S('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.cx, y: c.cy, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 8; i++) await b.S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.cx + i * 120, y: c.cy - i * 90, button: 'left', buttons: 1 });
  await b.S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.cx + 960, y: c.cy - 720, button: 'left', clickCount: 1 });
  await sleep(100);
  check(inBounds(await crop()), 'a mouse drag far out of the window: the image still covers the circle');
});

const errors = [];
try {
  for (const s of scenarios) {
    if (only && !only.includes(s.name)) continue;
    L.log(`\n== ${s.name}`);
    b = await startBrowser(`crop-${s.name}`);
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
