// The memory card on the page, in Node (no browser): the line under "Scheda di memoria" in each
// state the source reports (found, in use, moving, full, read-only, away, leaving, another
// source's, not keeping data, lost from source.json), its tap, and the danger color only when
// the card is away; and the page's rule for a version whose original is on a card that is away:
// with no ready level it cannot play (not reachable, never a candidate, the row dimmed and the
// player skipping it), with a ready level it plays.
//
// Usage: node web/dev/card-row.mjs <web dir> [<out dir>]   (OK/FAIL lines; card-row.log in <out dir>;
// exit 1 on a failure)
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const web = path.resolve(process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..'));
const outDir = process.argv[3] ? path.resolve(process.argv[3]) : null;
const noop = () => {};
const ls = new Map();
const el = () => ({ append: noop, appendChild: noop, remove: noop, classList: { add: noop, remove: noop, toggle: noop, contains: () => false }, style: { setProperty: noop }, setAttribute: noop, addEventListener: noop, children: [], firstElementChild: null, querySelector: () => null, querySelectorAll: () => [], dataset: {} });
globalThis.window = globalThis;
globalThis.addEventListener = noop;
globalThis.matchMedia = () => ({ matches: false, addEventListener: noop });
globalThis.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) };
globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: noop, removeEventListener: noop, createElement: el, createElementNS: el, createDocumentFragment: el, body: el(), documentElement: el(), hidden: false };
globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
globalThis.location = { origin: 'http://127.0.0.1:47123', href: 'http://127.0.0.1:47123/' };

const lines = [];
let failures = 0;
const check = (ok, name, extra = '') => {
  const line = `${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`;
  lines.push(line);
  console.log(line);
  if (!ok) failures++;
};
const imp = (p) => import(pathToFileURL(path.join(web, p)).href);
const GB = 1024 ** 3;

// ===== the row's line in each state =====
{
  const { storageState } = await imp('js/storage-row.js');
  const found = { volume: 'B275-0681', freeBytes: 31.9 * GB, totalBytes: 31.9 * GB, usable: true, why: null, appFolder: false };
  const card = (extra) => ({ volume: 'B275-0681', state: 'ready', freeBytes: 12.3 * GB, totalBytes: 31.9 * GB, floorBytes: GB, tracks: 1240, awayTracks: 0, moving: null, leaving: false, appFolder: false, full: false, bad: false, needBytes: null, ...extra });
  const cases = [
    ['found, not chosen', { card: null, found: [found] }, '31,9 GB liberi. Tocca per usarla per la musica', 'use', false],
    ['in use', { card: card(), found: [] }, 'In uso, 12,3 GB liberi', 'inUse', false],
    ['moving in', { card: card({ moving: { done: 230, total: 1200 } }), found: [] }, 'In uso, sposto la musica: 230 di 1.200 brani', 'inUse', false],
    ['full', { card: card({ full: true }), found: [] }, 'Piena, la musica nuova va nella memoria interna', 'inUse', false],
    ['read-only', { card: card({ state: 'readonly' }), found: [] }, 'In sola lettura, la musica nuova va nella memoria interna', 'inUse', false],
    ['away', { card: card({ state: 'away', awayTracks: 240 }), found: [] }, 'Non trovata: 240 brani non disponibili', 'away', true],
    ['leaving', { card: card({ leaving: true, moving: { done: 230, total: 1200 } }), found: [] }, 'Riporto la musica nella memoria interna: 230 di 1.200 brani', null, false],
    ["another source's", { card: null, found: [{ ...found, usable: false, why: 'other_source' }] }, "Di un'altra fonte MPfy, non si può usare", null, false],
    ['not keeping data', { card: card({ bad: true }), found: [] }, 'La scheda non conserva bene i dati, la musica resta nella memoria interna', 'inUse', false],
    ['lost from source.json', { card: card({ volume: null, state: 'unconfigured', awayTracks: 3 }), found: [] }, 'Scheda non configurata', 'away', true],
  ];
  for (const [name, view, sub, tap, danger] of cases) {
    const st = storageState(view);
    check(st !== null && st.sub === sub && (st.tap || null) === tap && !!st.danger === danger, `the row, ${name}: "${sub}"`, JSON.stringify(st));
  }
  check(storageState({ card: null, found: [] }) === null, 'no card in use or found: no row');
}

// ===== the page's rule for an away version =====
{
  const R = 'cafe0001';
  const hex = (n) => n.toString(16).padStart(24, '0');
  const [GONE, LEVEL, HERE] = [0xd1, 0xd2, 0xd3].map(hex);
  const tr = (id, extra = {}) => ({ id, fileHash: id, title: `Brano ${id.slice(-2)}`, artist: 'Prova', album: `Disco ${id.slice(-2)}`, albumArtist: 'Prova', trackNo: 1, discNo: 1, year: 2020, duration: 200, format: 'mp3', mime: 'audio/mpeg', codec: 'mp3', sampleRate: 44100, bitDepth: null, size: 8000000, bitrate: 320000, lossless: false, addedAt: 1, coverId: null, qualities: { low: false, normal: false, high: false }, mine: true, ...extra });
  const json = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === '/local/sources') return json({ sources: [{ id: R, name: 'Casa', principal: true, connected: true, rttMs: 30, throughputKbps: null, addedAt: 1, role: 'owner', named: true, profiles: true, social: 0 }] });
    if (u.startsWith(`/s/${R}/api/library`)) {
      return json({ version: 5, userVersion: 5, epochs: { shared: 'aaaaaaaaaaaaaaaa', user: 'aaaaaaaaaaaaaaaa' }, delta: { shared: false, user: false }, tracks: [tr(GONE, { away: true }), tr(LEVEL, { away: true, qualities: { low: false, normal: true, high: false } }), tr(HERE)], playlists: [], likes: [], recents: [], covers: { track: {}, album: {}, playlist: {} }, you: { profileId: 'p', role: 'owner' }, source: { name: 'Casa', named: true } });
    }
    return json({});
  };
  try {
    const { store } = await imp('js/store.js');
    const { sources } = await imp('js/sources.js');
    const { reachable, candidates, awayNow } = await imp('js/media.js');
    await sources.refresh();
    await store.refresh();
    await store.idle();
    check(store.versions(GONE).length === 1, 'the away song is in the library (the lists show it)');
    check(reachable(GONE) === false && candidates(GONE).length === 0, 'away with no ready level: not reachable, no candidate (dimmed, skipped by the player)');
    check(reachable(LEVEL) === true && candidates(LEVEL).length === 1, 'away with a ready level: it plays');
    check(reachable(HERE) === true, 'a song here plays');
    check(awayNow(store.versions(GONE)[0]) === true && awayNow(store.versions(LEVEL)[0]) === false, 'the car flags the first only');
  } catch (err) {
    check(false, 'the away checks ran', err.stack || String(err));
  }
}

console.log(`failures=${failures}`);
if (outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'card-row.log'), lines.join('\n') + `\nfailures=${failures}\n`);
}
process.exit(failures ? 1 : 0);
