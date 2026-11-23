// Unit checks of pure pieces of web/ in Node, no browser, no network:
//   - the pairing code field: the "MPFY" prefix is dropped only from a text longer than a body
//     (a code whose 32 characters start with MPFY can be typed after the visible "MPFY-");
//   - the QR codes: the encoder gives the reference matrices of dev/qr-reference.json bit for bit
//     (made once by this encoder, then read back by ZXing in the app's QrReferenceTest, which also
//     compares them with ZXing's own encoder at the same mask), and the links they carry (a
//     profile with its sources, a source) are read back the same, anything else is no link;
//   - the order sent back after a playlist edit keeps the tracks the edit could not show;
//   - an unreachable source is "Fonte non raggiungibile" in every toast, never its name;
//   - a malformed percent sequence decodes to null instead of throwing;
//   - the service worker answers a cover asked with &cached=1 from its cache only: a miss is a
//     504 at once, never a request to the core (which would wait 6 s for an offline source);
//   - songs across sources: grouping by trackId, fileHash and signatures (thresholds, different
//     starts, never two tracks of one source), the order versions are tried in, quality labels,
//     scores, time offsets from raw fingerprints and from signatures;
//   - the words: every code, codes told apart, upload rows and archive summaries;
//   - when a new version may replace the page (hidden, older than the app, what holds it);
//   - the profile photo: sent as its bytes, and a change reads the profile again after it landed,
//     not from a read that left before it;
//   - the people: the profile ID of a profileId (the shared vectors) and the search by it (O as 0,
//     I and L as 1, with and without the hyphen, never from one character), the times in words
//     (clock, list, relative, chat days, Recenti days across midnight and a year), the list's
//     order and search, the settings switched in a burst (one request at a time, the last tap
//     wins) and taken back when the core refuses, the report of what plays (at a start, a pause,
//     a change, every 60 s while playing, one request at a time, never from bridge 5);
//   - the chats: the texts as they are sent (newlines kept, cut in code points), the cards (a
//     playlist is its id, name, count and sources, never a track list), the log's runs and day
//     labels, the newest window laid over the older pages (a deletion seen, a message being sent
//     kept), the list asked with the v it holds (304: nothing drawn, the shared cards not asked),
//     a silence and a block at once, a conversation's sends one at a time in order with their own
//     ids, a refused one gone, read marks at most every 2 s; the emoji data (no skin tones, no
//     hair, nothing newer than 12.0) and the 24 recent ones;
//   - the songs: the comments of two sources as one list (a comment both hold shown once, with both
//     sources; one per author, the newest; yours first; the older copies of an author kept for its
//     delete), what a comment must be; the lyrics' current line at, before and after the line
//     times, the card's three lines, past, now and next, the 4 still lines of a plain text, a text
//     with a time tag taken as synced, the answers made safe (sorted, cut, none), and their colour
//     from the cover's.
//
// Usage: node web/dev/unit.mjs <web dir>   (prints OK/FAIL lines, exit 1 on a failure)
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

const web = path.resolve(process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..'));
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
globalThis.fetch = async () => new Response('{}', { status: 200 });

let failures = 0;
const check = (ok, name, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);
  if (!ok) failures++;
};
const imp = (p) => import(pathToFileURL(path.join(web, p)).href);

// ===== pairing code =====
const { codeBody, formatCode } = await imp('components/add-source.js');
const BODY = 'MPFY7K3Q9XWDAB12CDEFGHJKMNPQRSTV'; // 32 characters that happen to start with MPFY
check(BODY.length === 32 && codeBody(BODY) === BODY, 'a body that starts with MPFY is kept whole', codeBody(BODY));
check(codeBody('mpfy-7k3q-9xwd-ab') === 'MPFY7K3Q9XWDAB', 'a short text is always a body, even after "mpfy"', codeBody('mpfy-7k3q-9xwd-ab'));
check(codeBody(formatCode(BODY)) === BODY, 'the same code pasted whole, with its prefix, gives the body back', codeBody(formatCode(BODY)));
const other = '7K3Q9XWDAB12CDEFGHJKMNPQRSTVWXYZ';
check(codeBody(`MPFY-${other}`) === other && codeBody(` mpfy ${other.toLowerCase()} `) === other, 'a pasted full code drops its prefix (case and spaces ignored)');
check(codeBody('MPFY-7K3Q-IL0O') === 'MPFY7K3Q1100', 'I and L read as 1, O as 0', codeBody('MPFY-7K3Q-IL0O'));
// Typing the rare code character by character never loses its first four characters.
let typed = '';
for (const ch of BODY) typed = codeBody(typed + ch);
check(typed === BODY, 'typing a body that starts with MPFY, one character at a time', typed);

// ===== QR codes and their links =====
{
  const { qrMatrix } = await imp('js/qr.js');
  const refs = JSON.parse(fs.readFileSync(path.join(web, 'dev', 'qr-reference.json'), 'utf8'));
  for (const r of refs) {
    const m = qrMatrix(r.text);
    const rows = m.dark.map((row) => row.map((d) => (d ? '1' : '0')).join(''));
    const diff = rows.reduce((n, row, y) => n + [...row].filter((c, x) => c !== (r.rows[y] || '')[x]).length, 0);
    check(m.version === r.version && m.mask === r.mask && rows.length === r.rows.length && diff === 0, `QR of ${r.text.length} bytes: version ${r.version}, mask ${r.mask}, the reference matrix`, `version ${m.version}, mask ${m.mask}, ${diff} modules differ`);
  }
  let threw = false;
  try {
    qrMatrix('x'.repeat(2400));
  } catch {
    threw = true;
  }
  check(threw, 'a text beyond version 40 is refused, not drawn wrong');

  const { parseLink, profileLink, sourceLink } = await imp('js/links.js');
  const P = 'MPFY-P-' + 'N3K0-AP4M-1BQ5-N2CR-6P7D-S8ET-9FVA-GWBH-XCJY-DKZ0-EM1F-N2GP-3HQ4-JR5K';
  const S1 = 'MPFY-DVBR-2EWC-S3FX-DT4G-YEV5-HZW6-JAX7-KBY8';
  const S2 = 'mpfy-7k3q-9xwd-ab12-cdef-ghjk-mnpq-rstv-wxyz';
  const link = profileLink(P, [S1, S2]);
  const back = parseLink(link);
  check(/^mpfy:\/\/collega\?p=MPFYP[0-9A-Z]{56}&s=MPFY[0-9A-Z]{32}&s=MPFY[0-9A-Z]{32}$/.test(link), 'the link of a profile: mpfy://collega?p=<profile>&s=<source>..., codes without dashes', link);
  check(!!back && back.profile === P.replace(/-/g, '') && back.sources.join() === [S1, S2].map((c) => c.replace(/-/g, '').toUpperCase()).join(), 'the link of a profile reads back its profile and its sources in order', JSON.stringify(back));
  const one = parseLink(sourceLink(S1));
  check(!!one && one.profile === null && one.sources.length === 1 && sourceLink(S1) === 'mpfy://fonte?s=' + S1.replace(/-/g, ''), 'the link of a source: mpfy://fonte?s=<source>', sourceLink(S1));
  check(parseLink(`MPFY://Collega?p=${P}&s=${S1}&s=${S1}`)?.sources.length === 1, 'any case, dashes kept, the same source twice counts once');
  const bad = [S1, P, 'https://example.com/?p=1', 'mpfy://other?s=' + S1, `mpfy://collega?s=${S1}`, `mpfy://collega?p=${P}&s=MPFY1234`, `mpfy://fonte?s=${S1}&s=${S2}`, `mpfy://fonte?p=${P}&s=${S1}`, `mpfy://collega?p=${P}&p=${P}`, `mpfy://fonte?s=${S1.replace('D', 'U')}`, 'mpfy://collega?p=' + P + Array.from({ length: 21 }, (_, i) => '&s=' + S1.slice(0, -2) + String(10 + i)).join('')];
  check(bad.every((t) => parseLink(t) === null), 'no link: a typed code, another scheme or host, no profile, a bad code, two sources for one, two profiles, a U, more than 20 sources', JSON.stringify(bad.filter((t) => parseLink(t) !== null)));
}

// ===== playlist edit order =====
const { mergePlaylistOrder, safeDecode } = await imp('js/util.js');
// u1, u2, u3 belong to a source whose library is not loaded: the edit does not show them.
const orig = ['u1', 'a', 'u2', 'b', 'c', 'u3'];
const shownSlots = new Set([1, 3, 4]);
const shown = (i) => shownSlots.has(i);
const ent = (...slots) => slots.map((index) => ({ index }));
const show = (r) => r.join(',');
let r = mergePlaylistOrder(orig, ent(1, 3, 4), shown);
check(show(r) === show(orig), 'no change: the same order back', show(r));
r = mergePlaylistOrder(orig, ent(1, 4), shown);
check(show(r) === 'u1,a,u2,c,u3', 'removing b keeps every hidden track', show(r));
r = mergePlaylistOrder(orig, ent(4, 1, 3), shown);
check(show(r) === 'u1,c,u3,a,u2,b', 'moving c to the top: hidden tracks move with the track they followed', show(r));
r = mergePlaylistOrder(orig, ent(3, 4), shown);
check(show(r) === 'u1,u2,b,c,u3', 'removing a: what followed it stays, at the top', show(r));
r = mergePlaylistOrder(orig, [], shown);
check(show(r) === 'u1,u2,u3', 'removing every shown track leaves the hidden ones', show(r));
r = mergePlaylistOrder(['a', 'a', 'x'], ent(1), (i) => i < 2);
check(show(r) === 'a,x', 'duplicates are told apart by their slot', show(r));

// ===== words =====
const { errorText } = await imp('js/api.js');
const { sources } = await imp('js/sources.js');
check(errorText({ status: 503, src: 'aaaa1111' }) === 'Fonte non raggiungibile', 'unreachable source: "Fonte non raggiungibile", no name', errorText({ status: 503, src: 'aaaa1111' }));
check(errorText({ status: 0, src: 'aaaa1111' }, 'Mi piace non salvato') === 'Fonte non raggiungibile', 'no answer at all: the same words');
check(errorText({ status: 507, src: 'aaaa1111' }) === `Spazio esaurito su ${sources.name('aaaa1111')}`, 'a full disk names the source');
check(errorText({ status: 500, src: 'aaaa1111' }, 'Playlist non creata') === 'Playlist non creata', 'anything else: the caller\'s words');

// ===== decoding the address =====
check(safeDecode('%E0%A4%A') === null && safeDecode('abc%20d') === 'abc d', 'a malformed percent sequence is null, not a throw');
const app = fs.readFileSync(path.join(web, 'app.js'), 'utf8');
const resolveSrc = /function resolve\([\s\S]*?\n\}/.exec(app)?.[0] || '';
check(resolveSrc.length > 0 && !/decodeURIComponent\(/.test(resolveSrc), 'app.js resolve() never calls decodeURIComponent directly', `${resolveSrc.length} chars`);

// ===== service worker: covers with &cached=1 =====
const swCode = fs.readFileSync(path.join(web, 'sw.js'), 'utf8');
function swEnv() {
  const listeners = {};
  const stores = new Map();
  const net = [];
  const openCache = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    return {
      match: async (k) => (m.has(String(k)) ? m.get(String(k)).clone() : undefined),
      put: async (k, v) => void m.set(String(k), v),
      keys: async () => [...m.keys()].map((k) => new Request(new URL(k, 'http://127.0.0.1:47123'))),
      delete: async (k) => m.delete(String(k)),
    };
  };
  const caches = {
    open: async (n) => openCache(n),
    match: async (k, { cacheName } = {}) => (cacheName ? openCache(cacheName).match(k) : undefined),
    keys: async () => [...stores.keys()],
    has: async (n) => stores.has(n),
    delete: async (n) => stores.delete(n),
  };
  const self = {
    addEventListener: (t, f) => (listeners[t] = f),
    location: { origin: 'http://127.0.0.1:47123' },
    clients: { matchAll: async () => [], claim: async () => {} },
    skipWaiting: async () => {},
  };
  // A same-origin answer as a page's fetch sees it (type "basic", which Node's Response cannot be).
  const basic = () => {
    const body = new Uint8Array([0xff, 0xd8, 0xff]);
    const r = { ok: true, status: 200, type: 'basic', headers: new Headers({ 'Content-Type': 'image/jpeg' }), arrayBuffer: async () => body.buffer.slice(0), clone: () => basic() };
    return r;
  };
  const fetchStub = async (req) => {
    net.push(typeof req === 'string' ? req : req.url);
    return basic();
  };
  vm.runInNewContext(swCode, { self, caches, fetch: fetchStub, Response, Request, Headers, URL, TextEncoder, crypto, console, setTimeout, clearTimeout, encodeURIComponent, decodeURIComponent });
  const ask = async (url) => {
    let p = null;
    const waits = [];
    listeners.fetch({ request: new Request(url), respondWith: (x) => (p = x), waitUntil: (x) => waits.push(x), clientId: 'c1' });
    const res = await p;
    await Promise.all(waits);
    return res;
  };
  return { ask, net, openCache };
}
{
  const env = swEnv();
  const base = 'http://127.0.0.1:47123/s/aaaa1111/api/cover/0123456789abcdef01234567';
  const miss = await env.ask(`${base}?size=small&cached=1`);
  check(miss.status === 504 && env.net.length === 0, 'cached=1 and not cached: 504 at once, nothing asked to the core', `status ${miss.status}, network ${env.net.length}`);
  const first = await env.ask(`${base}?size=small`);
  check(first.status === 200 && env.net.length === 1, 'without the flag a miss goes to the source (and fills the cache)', `status ${first.status}, network ${env.net.length}`);
  const hit = await env.ask(`http://127.0.0.1:47123/s/bbbb2222/api/cover/0123456789abcdef01234567?size=small&cached=1`);
  check(hit.status === 200 && env.net.length === 1, 'cached=1 and cached (from any source id): the copy, no network', `status ${hit.status}, network ${env.net.length}`);
}


// ===== songs across sources: grouping =====
const songs = await imp('js/songs.js');
const rnd32 = (seed) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
};
/** Raw items of a recording; a copy starts `shift` items later and has `flips` bits per item flipped. */
function raw(rec, n = 900, { shift = 0, flips = 0 } = {}) {
  const r = rnd32(rec * 7919 + 1);
  const base = Array.from({ length: n }, () => r());
  const noise = rnd32(rec * 31 + 7 + shift * 3 + flips);
  return Uint32Array.from({ length: n }, (_, j) => {
    let v = j >= shift ? base[j - shift] : noise();
    for (let k = 0; k < flips; k++) v ^= 1 << (noise() & 31);
    return v >>> 0;
  });
}
const b64 = (arr) => Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString('base64');
const sigFrom = (items, d, b = 32) => songs.signatureOf({ d, b, s: b64(items.slice(b, b + 64)) });
const ver = (sourceId, order, trackId, fileHash, sig) => ({ sourceId, order, trackId, fileHash: fileHash || trackId, sig });
const grouped = (vs) => songs.groupVersions(vs).map((g) => g.map((i) => `${vs[i].sourceId}:${vs[i].trackId}`).join('+')).sort();

{
  const A = raw(1);
  const vs = [ver('pp', 0, 't1', 'h1', null), ver('ss', 1, 't1', 'h9', null)];
  check(grouped(vs).join(' ') === 'pp:t1+ss:t1', 'merge: the same trackId on two sources is one song', grouped(vs).join(' '));
  const vh = [ver('pp', 0, 'a1', 'hh', null), ver('ss', 1, 'b7', 'hh', null)];
  check(grouped(vh).join(' ') === 'pp:a1+ss:b7', 'merge: the same fileHash on two sources is one song', grouped(vh).join(' '));
  // A copy 3 items later with about 3% of its bits flipped: the same song.
  const copy = raw(1, 900, { shift: 3, flips: 1 });
  const vsig = [ver('pp', 0, 'p1', null, sigFrom(A, 200.0)), ver('ss', 1, 's1', null, sigFrom(copy, 200.4))];
  check(grouped(vsig).join(' ') === 'pp:p1+ss:s1', 'merge: signatures within the thresholds (BER, 1.5 s) are one song', grouped(vsig).join(' '));
  const r = songs.compareSignatures(vsig[0].sig, vsig[1].sig);
  check(r && r.k === 3 && r.ber < 0.12, 'merge: the best raw offset of the two signatures is the shift', JSON.stringify(r));
  // Different starts (b): the raw offsets still line them up.
  const vb = [ver('pp', 0, 'p1', null, sigFrom(A, 200.0, 32)), ver('ss', 1, 's1', null, sigFrom(copy, 200.4, 8))];
  check(grouped(vb).join(' ') === 'pp:p1+ss:s1', 'merge: signatures with different b still align', JSON.stringify(songs.compareSignatures(vb[0].sig, vb[1].sig)));
  // Too far apart in time, or too different.
  const far = [ver('pp', 0, 'p1', null, sigFrom(A, 200.0)), ver('ss', 1, 's1', null, sigFrom(copy, 201.7))];
  check(grouped(far).length === 2, 'merge: durations 1.7 s apart stay two songs', grouped(far).join(' '));
  const noisy = raw(1, 900, { shift: 3, flips: 6 }); // about 17% of the bits
  const bad = [ver('pp', 0, 'p1', null, sigFrom(A, 200.0)), ver('ss', 1, 's1', null, sigFrom(noisy, 200.0))];
  const rb = songs.compareSignatures(bad[0].sig, bad[1].sig);
  check(grouped(bad).length === 2 && rb.ber > 0.12, 'merge: a BER above 0.12 stays two songs', JSON.stringify(rb));
  const other = [ver('pp', 0, 'p1', null, sigFrom(A, 200.0)), ver('ss', 1, 's1', null, sigFrom(raw(2), 200.0))];
  check(grouped(other).length === 2, 'merge: different recordings stay apart');
  // Two tracks of one source never share a song: the closer match wins, the other stays alone.
  const close = raw(1, 900, { shift: 1 });
  const two = [ver('pp', 0, 'p1', null, sigFrom(A, 200.0)), ver('ss', 1, 's1', null, sigFrom(close, 200.1)), ver('ss', 1, 's2', null, sigFrom(copy, 200.4))];
  check(grouped(two).join(' ') === 'pp:p1+ss:s1 ss:s2', 'merge: never two tracks of one source in a song (the lowest BER joins)', grouped(two).join(' '));
  // Order: the principal's version comes first, so it gives the song its id.
  const ord = songs.groupVersions([ver('ss', 1, 's1', null, sigFrom(copy, 200.4)), ver('pp', 0, 'p1', null, sigFrom(A, 200.0))]);
  check(ord.length === 1 && ord[0][0] === 1, 'merge: the version on the principal leads the song (its id)', JSON.stringify(ord));
}

// ===== version choice =====
{
  const info = { a: { throughputKbps: 3000, rttMs: 120, principal: true, addedAt: 1 }, b: { throughputKbps: 9000, rttMs: 40, principal: false, addedAt: 2 }, c: { throughputKbps: null, rttMs: 30, principal: false, addedAt: 3 } };
  const v = (sourceId, score) => ({ sourceId, score });
  const order = (vs, level) => songs.orderVersions(vs, level, (id) => info[id]).map((x) => `${x.sourceId}${x.score}`).join(',');
  check(order([v('a', 320), v('b', 1016000), v('c', 256)], 'max') === 'b1016000,a320,c256', 'version choice: Max plays the best score first, then the rest by score', order([v('a', 320), v('b', 1016000), v('c', 256)], 'max'));
  check(order([v('a', 1016000), v('b', 1016000)], 'max') === 'b1016000,a1016000', 'version choice: Max ties go by connection (the faster)', order([v('a', 1016000), v('b', 1016000)], 'max'));
  check(order([v('a', 320), v('b', 200), v('c', 1016000)], 'high') === 'c1016000,a320,b200', 'version choice: Alta wants >= 256, ordered by connection (c has the lowest RTT), then by score', order([v('a', 320), v('b', 200), v('c', 1016000)], 'high'));
  check(order([v('a', 160), v('b', 100)], 'normal') === 'a160,b100', 'version choice: Normale wants >= 153.6', order([v('a', 160), v('b', 100)], 'normal'));
  check(order([v('a', 100), v('b', 90)], 'low') === 'b90,a100', 'version choice: Bassa: both good enough, the faster first', order([v('a', 100), v('b', 90)], 'low'));
  const conn = (x, y) => songs.byConnection(x, y);
  check(conn({ throughputKbps: 1000, rttMs: 100 }, { throughputKbps: 1100, rttMs: 30 }) > 0, 'connection: throughputs within 20%: the lower RTT');
  check(conn({ throughputKbps: null, rttMs: 100 }, { throughputKbps: 5000, rttMs: 30 }) > 0 && conn({ throughputKbps: null, rttMs: 20 }, { throughputKbps: 5000, rttMs: 30 }) < 0, 'connection: an unknown throughput: the RTT decides');
  check(conn({ throughputKbps: 3000, rttMs: 100 }, { throughputKbps: 1000, rttMs: 10 }) < 0, 'connection: known throughputs more than 20% apart: the faster first');
  check(conn({ rttMs: null, principal: true, addedAt: 5 }, { rttMs: null, principal: false, addedAt: 1 }) < 0 && conn({ rttMs: null, addedAt: 5 }, { rttMs: null, addedAt: 1 }) > 0, 'connection: then the principal, then the older source');
}

// ===== quality labels =====
{
  const L = songs.qualityLabel;
  const cases = [
    [{ codec: 'flac', lossless: true, bitDepth: 16, sampleRate: 44100 }, 'FLAC'],
    [{ codec: 'flac', lossless: true, bitDepth: 24, sampleRate: 96000 }, 'FLAC 24/96'],
    [{ codec: 'wav', lossless: true, bitDepth: 24, sampleRate: 44100 }, 'WAV 24/44,1'],
    [{ codec: 'alac', lossless: true, bitDepth: 16, sampleRate: 88200 }, 'ALAC 16/88,2'],
    [{ codec: 'flac', lossless: true, fakeLossless: true, equivKbps: 192 }, 'FLAC ~192'],
    [{ codec: 'mp3', bitrate: 320000 }, 'MP3 320'],
    [{ codec: 'mp3', bitrate: 320000, cutoffHz: 17000, equivKbps: 128 }, 'MP3 ~128'],
    [{ codec: 'aac', bitrate: 256000, cutoffHz: 19500, equivKbps: 192 }, 'AAC ~192'],
    [{ codec: 'aac', bitrate: 256400 }, 'AAC 256'],
    [{ codec: 'aac', bitrate: 256400, cutoffHz: null, equivKbps: null }, 'AAC 256'],
    [{ codec: 'opus', bitrate: 160000 }, 'OPUS 160'],
    [{ codec: 'vorbis', bitrate: 191800 }, 'VORBIS 192'],
    [{ format: 'm4a', bitrate: 264000 }, 'AAC 264'],
    [{ format: 'mp3', size: 4000000, duration: 200 }, 'MP3 160'],
  ];
  const bad = cases.filter(([t, want]) => L(t) !== want).map(([t, want]) => `${JSON.stringify(t)} -> ${L(t)} (want ${want})`);
  check(!bad.length, 'quality labels: FLAC, FLAC 24/96, WAV 24/44,1, FLAC ~192, MP3 320, MP3 ~128, AAC ~192, AAC 256, OPUS 160, VORBIS 192', bad.join('; '));
  check(Math.round(songs.scoreOf({ codec: 'aac', bitrate: 256000 })) === 333 && songs.scoreOf({ codec: 'flac', lossless: true, bitDepth: 24, sampleRate: 96000 }) === 1024960 && songs.scoreOf({ codec: 'flac', lossless: true, fakeLossless: true, equivKbps: 128 }) === 128, 'scores: aac x 1.3, lossless by depth and rate, fake lossless as its mp3');
  const sc = [songs.scoreOf({ codec: 'mp3', bitrate: 320000, equivKbps: 128 }), songs.scoreOf({ codec: 'opus', bitrate: 256000, equivKbps: 192 }), songs.scoreOf({ codec: 'aac', bitrate: 256000, equivKbps: 192 }), songs.scoreOf({ codec: 'aac', bitrate: 224000 }), songs.scoreOf({ codec: 'mp3', bitrate: 320000, equivKbps: 128, score: 320 })];
  check(sc[0] === 128 && sc[1] === 192 && sc[2] === 192 && Math.round(sc[3] * 10) === 2912 && sc[4] === 320, 'scores with equivKbps: the class x 1.0 whatever the codec (an Opus 256 cut at 19 kHz under a real AAC 224), a score sent by the source wins', sc.join(', '));
}

// ===== time offsets =====
{
  const A = raw(5);
  const late = raw(5, 900, { shift: 2 }); // 250 ms of silence in front: two items later
  check(songs.rawOffset(A, late) === 2 && songs.offsetMs(songs.rawOffset(A, late)) === 248, 'offsets: from raw fingerprints, k items later is round(k x 123.81) ms', `k ${songs.rawOffset(A, late)}`);
  check(songs.rawOffset(late, A) === -2, 'offsets: the other way round is negative');
  const sa = sigFrom(A, 200);
  const sl = sigFrom(late, 200.2, 30);
  check(songs.signatureOffset(sa, sl) === 2, 'offsets: from the signatures (different b), the same raw offset', String(songs.signatureOffset(sa, sl)));
  check(songs.rawOffset(A, raw(6)) === null, 'offsets: two files that do not align give none');
}

// ===== words for codes, and codes told apart =====
{
  const W = await imp('js/words.js');
  const want = {
    wrong_password: 'Password errata',
    locked: 'Troppi tentativi, riprova più tardi',
    no_recovery: 'Nessun profilo da recuperare qui',
    session_gone: 'Tempo scaduto',
    bad_code: 'Codice non valido',
    source_code: 'Questo è il codice di una fonte',
    profile_code: 'Questo è il codice del profilo',
    bad_file: 'File non valido',
    bad_name: 'Nome non valido',
    short_password: 'Almeno 8 caratteri',
    unreachable: 'Fonte non raggiungibile',
    too_large: 'File troppo grande',
    not_audio: 'Formato non supportato',
    unsupported_archive: 'Formato non supportato',
    too_many_uploads: 'Troppi caricamenti in corso',
    archive_encrypted: 'Archivio protetto da password',
    archive_too_big: 'Archivio troppo grande',
    archive_invalid: 'Archivio non valido',
  };
  const bad = Object.entries(want).filter(([c, w]) => W.wordsFor(c) !== w);
  check(!bad.length, 'every code has its words', bad.map(([c]) => c).join(','));
  check(W.wordsFor('disk_full', 'Mi A2') === 'Spazio esaurito su Mi A2', 'a full disk names the source');
  check(W.wordsFor('too_many_devices', 'Mi A2') === null && W.wordsFor('too_many_profiles') === null, 'no words for caps on devices or people: a source has none');
  check(W.localWords({ code: 'profile_exists', status: 409 }) === 'Qualcosa non ha funzionato' && W.localWords({ code: 'unknown_x' }) === 'Qualcosa non ha funzionato', 'an unknown code: the generic line');
  check(W.codeKind('MPFY-P-000G-40R4-0M30-E209-185G-R38E-1W81-24GK-2GAH-C5RR-34D1-P70X-3RFJ-2XHR') === 'profile' && W.codeKind('mpfy 7k3q 9xwd ab12 cdef ghjk mnpq rstv wxyz') === 'source' && W.codeKind('MPFY-7K3Q') === null, 'a profile code and a source code are told apart by length');
  const { errorText: et } = await imp('js/api.js');
  check(et({ status: 400, code: 'disk_full', src: 'aaaa1111' }) === `Spazio esaurito su ${sources.name('aaaa1111')}` && et({ status: 415, code: 'archive_encrypted' }) === 'Archivio protetto da password', 'source errors are worded from their code');
}

// ===== upload words =====
{
  const up = await imp('js/upload.js');
  const S = up.archiveSummary;
  check(S({ added: 15, replaced: 2, duplicates: 0, ignored: 0 }) === '17 brani caricati' && S({ added: 16, replaced: 1, ignored: 2 }) === '17 brani caricati, 2 file ignorati' && S({ added: 1, ignored: 1 }) === '1 brano caricato, 1 file ignorato', 'archive summary: "17 brani caricati", ", 2 file ignorati", singulars');
  check(S({ added: 0, replaced: 0, duplicates: 17, ignored: 0 }) === 'Già presente', 'archive summary: an album already there is "Già presente"');
  const st = (o) => up.stateText({ progress: 0, ...o });
  const texts = [st({ state: 'waiting' }), st({ state: 'uploading', progress: 0.42 }), st({ state: 'paused' }), st({ state: 'processing' }), st({ state: 'done' }), st({ state: 'duplicate' }), st({ state: 'replaced' }), st({ state: 'extracting', archive: { state: 'checking', total: 0 } }), st({ state: 'extracting', archive: { state: 'importing', total: 17, done: 7 } }), st({ state: 'cancelled' })];
  check(texts.join('|') === 'In attesa|Caricamento 42%|In pausa|Caricamento 100%|Caricato|Già presente|Sostituito con una versione migliore|Estrazione...|Estrazione 7 di 17|Annullato', 'upload row states', texts.join('|'));
}

// ===== the browser player: versions of one song =====
{
  // A fake audio element: the backend sets src, seeks after the metadata, listens to events.
  let now = 1000;
  const realNow = performance.now.bind(performance);
  performance.now = () => now;
  const els = [];
  class FakeAudio {
    constructor() {
      this.ls = {};
      this.attrs = {};
      this.t = 0;
      this.duration = NaN;
      this.readyState = 0;
      this.seeking = false;
      this.error = null;
      els.push(this);
    }
    addEventListener(t, f) {
      (this.ls[t] ||= []).push(f);
    }
    fire(t) {
      for (const f of this.ls[t] || []) f();
    }
    set src(u) {
      this.attrs.src = u;
      this.readyState = 0;
      this.duration = NaN;
      // The load algorithm: the position goes back to 0, said with a timeupdate.
      this.t = 0;
      this.fire('timeupdate');
    }
    get src() {
      return this.attrs.src || '';
    }
    getAttribute(k) {
      return this.attrs[k] ?? null;
    }
    removeAttribute(k) {
      delete this.attrs[k];
    }
    get currentTime() {
      return this.t;
    }
    set currentTime(v) {
      this.t = v;
    }
    play() {
      return Promise.resolve();
    }
    pause() {}
    load() {}
    /** The metadata of the file just set: duration known, the asked position applied. */
    meta(d = 240) {
      this.readyState = 1;
      this.duration = d;
      this.fire('durationchange');
      this.fire('loadedmetadata');
    }
  }
  globalThis.Audio = FakeAudio;
  const { createWebBackend } = await imp('js/backend-web.js');
  const seen = [];
  const be = createWebBackend({ time: (p) => seen.push(['time', p]), state: noop, ended: noop, error: (m) => seen.push(['error', m]), version: (v) => seen.push(['version', v.sourceId]), quality: noop });
  const a = els[0];
  const V = (sourceId, offsetMs = 0, fileHash = sourceId + 'h') => ({ sourceId, trackId: 't1', fileHash, url: '/s/' + sourceId + '/api/stream/t1', offsetMs });
  const versionsSeen = () => seen.filter((x) => x[0] === 'version').map((x) => x[1]).join(',');
  const errorsSeen = () => seen.filter((x) => x[0] === 'error').length;

  // Only A was up when the song started; B came back and the new order puts it first.
  be.load('s1', [V('A')], 0, true);
  a.meta();
  be.setVersions('s1', [V('B'), V('A')]);
  a.error = { message: 'network' };
  a.fire('error');
  check(versionsSeen() === 'A,B' && errorsSeen() === 0, 'browser: a version put before the one playing by a new order is tried when that one fails', versionsSeen() + ' errors ' + errorsSeen());
  a.meta();
  a.fire('error');
  check(errorsSeen() === 1 && (be.tried || []).map((v) => v.sourceId).sort().join(',') === 'A,B', 'browser: once both failed the player hears it, and the backend says which ones it tried', (be.tried || []).map((v) => v.sourceId).join(','));

  // Three versions, the one playing in the middle of the new order: the last is tried before
  // the player hears, the one already failed is not tried again.
  seen.length = 0;
  be.load('s3', [V('A'), V('B'), V('C')], 0, true);
  a.meta();
  a.fire('error'); // A fails: B
  a.meta();
  be.setVersions('s3', [V('A'), V('C'), V('B')]);
  a.fire('error'); // B fails: C (A failed already)
  a.meta();
  check(versionsSeen() === 'A,B,C' && errorsSeen() === 0, 'browser: after a reorder the next untried version follows, never one that already failed', versionsSeen());
  a.fire('error');
  check(errorsSeen() === 1, 'browser: and only then the player hears');

  // The version playing leaves the list (its source went down): its offset is taken into the
  // frame of the new list, so the next file starts at the same moment of the song.
  seen.length = 0;
  be.load('s2', [V('A', 0, 'fa'), V('B', 248, 'fb')], 0, true);
  a.meta();
  a.currentTime = 100;
  a.fire('timeupdate');
  // B's file has the song 248 ms later than A's: against B, A is -248 ms.
  be.setVersions('s2', [V('B', 0, 'fb')], (x) => (x.fileHash === 'fa' ? -248 : 0));
  a.fire('error');
  a.meta();
  check(versionsSeen() === 'A,B' && Math.abs(a.currentTime - 100.248) < 1e-6, 'browser: the version playing left the list: the next one starts at the same moment of the song (100.248 s)', String(a.currentTime));

  // While the next version loads, the position stays where it was (no jump back to 0).
  seen.length = 0;
  be.load('s4', [V('A'), V('B')], 0, true);
  a.meta();
  a.currentTime = 61.3;
  a.fire('timeupdate');
  seen.length = 0;
  a.fire('error');
  const times = seen.filter((x) => x[0] === 'time').map((x) => x[1]);
  a.meta();
  check(times.length > 0 && times.every((t) => Math.abs(t - 61.3) < 1e-6) && Math.abs(be.currentTime - 61.3) < 1e-6, 'browser: a switch reports the position it goes on from, never 0 before the seek', times.join(','));

  // A stall (waiting, no progress for 4 s) moves on too, to the untried one whatever its place.
  seen.length = 0;
  be.load('s5', [V('A')], 0, true);
  a.meta();
  be.setVersions('s5', [V('B'), V('A')]);
  a.fire('waiting');
  now += 4600;
  await new Promise((r) => setTimeout(r, 650));
  check(versionsSeen() === 'A,B', 'browser: a stall moves on to the untried version put first by the new order', versionsSeen());
  be.stop();
  performance.now = realNow;
}

// ===== renaming a source: the dialog does not wait for every source's sync =====
{
  const R = 'abcd1234';
  let coreName = 'mi-a2-hostname';
  let syncs = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    const json = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { 'Content-Type': 'application/json' } });
    if (u === '/local/sources') return json({ sources: [{ id: R, name: coreName, principal: true, connected: true, rttMs: 50, throughputKbps: null, lastError: null, addedAt: 1, role: 'owner', named: coreName !== 'mi-a2-hostname' }] });
    if (u === `/s/${R}/api/admin/source` && method === 'PATCH') return json({ source: { name: JSON.parse(init.body).name, named: true } });
    if (u === '/local/sync') {
      syncs++;
      // The core answers once every source answered: a slow one keeps it 3 s.
      await new Promise((r) => setTimeout(r, 3000));
      coreName = 'Casa';
      return json({ ok: true });
    }
    return json({});
  };
  await sources.refresh();
  const t0 = Date.now();
  await sources.renameSource(R, 'Casa');
  const took = Date.now() - t0;
  check(took < 1000 && syncs === 1, 'renaming a source answers once the source saved it, without waiting for the sync it asks', `${took} ms, ${syncs} sync`);
  check(sources.name(R) === 'Casa' && sources.get(R)?.named === true, 'the new name shows at once', sources.name(R));
  await sources.refresh(); // the core still has the old name: its sync is under way
  check(sources.name(R) === 'Casa', 'a poll before the core learnt the new name keeps it', sources.name(R));
  await new Promise((r) => setTimeout(r, 3200));
  await sources.refresh();
  check(sources.name(R) === 'Casa', 'and the core says it too after its sync', sources.name(R));
  globalThis.fetch = realFetch;
}

// ===== the naming step: a source with profiles, without, or not known yet =====
{
  const realFetch = globalThis.fetch;
  const P = 'cccc3333';
  let core = { id: P, name: 'Vecchia', principal: false, connected: true, addedAt: 9, role: null, named: null, profiles: false };
  let polls = 0;
  globalThis.fetch = async (url) => {
    if (String(url) === '/local/sources') {
      polls++;
      return new Response(JSON.stringify({ sources: [core] }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
  await sources.refresh();
  check(sources.get(P)?.profiles === false, 'clean() keeps profiles (false)', JSON.stringify(sources.get(P)));
  const cachedList = JSON.parse(ls.get('mpfy.sources.v1') || '[]');
  check(cachedList.find((x) => x.id === P)?.profiles === false, 'the cached list keeps profiles', JSON.stringify(cachedList));
  const { afterSourceAdded } = await imp('components/add-source.js');
  let t0 = Date.now();
  polls = 0;
  let r = await sources.waitForRole(P, 3000, 200);
  check(Date.now() - t0 < 150 && polls === 0 && r?.role === null, 'naming step: profiles false decides at once (no 20 s wait)', `${Date.now() - t0} ms, ${polls} polls`);
  t0 = Date.now();
  await afterSourceAdded({ id: P, name: 'Vecchia', role: null, named: null, profiles: false });
  check(Date.now() - t0 < 150, 'and the add flow goes on at once, with no naming step', `${Date.now() - t0} ms`);
  core = { ...core, profiles: null };
  await sources.refresh();
  check(sources.get(P)?.profiles === null, 'profiles not known yet: null');
  t0 = Date.now();
  polls = 0;
  setTimeout(() => {
    core = { ...core, role: 'member', named: true, profiles: true };
  }, 500);
  r = await sources.waitForRole(P, 3000, 200);
  check(polls >= 2 && r?.role === 'member' && r.profiles === true && Date.now() - t0 >= 400, 'profiles null still polls, until the core knows', `${Date.now() - t0} ms, ${polls} polls`);
  core = { ...core, role: null, named: null, profiles: null };
  await sources.refresh();
  t0 = Date.now();
  r = await sources.waitForRole(P, 600, 200);
  check(Date.now() - t0 >= 550 && r?.role === null, 'never known: it gives up after its time', `${Date.now() - t0} ms`);
  globalThis.fetch = realFetch;
}

// ===== the profile photo: the profile is read again after the change landed =====
{
  const realFetch = globalThis.fetch;
  const { profile } = await imp('js/profile.js');
  const A = 'a'.repeat(64);
  const B = 'b'.repeat(64);
  let photo = A;
  let hold = false;
  let release = null;
  let put = null;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    const json = (o) => new Response(JSON.stringify(o), { status: 200 });
    const view = (p) => ({ id: 'p1', name: 'Ada', nameUpdatedAt: 1, photo: p });
    if (u === '/local/profile' && method === 'GET') {
      const seen = photo; // what the core holds when the read reaches it
      if (hold) {
        hold = false;
        await new Promise((r) => (release = r));
      }
      return json({ profile: view(seen), recovery: false, fileName: 'Ada.mpfy' });
    }
    if (u === '/local/profile/photo' && method === 'PUT') {
      put = { type: init.headers?.['Content-Type'], blob: init.body instanceof Blob };
      photo = B;
      return json({ profile: view(photo) });
    }
    if (u === '/local/profile/photo' && method === 'DELETE') {
      photo = null;
      return json({ profile: view(photo) });
    }
    return json({});
  };
  await profile.refresh();
  check(profile.data?.photo === A && profile.photoUrl() === `/local/profile/photo?v=${A}`, 'the profile carries its photo, shown by its hash', profile.photoUrl());
  // A read that left before the change (the page coming back to the front) answers after it.
  hold = true;
  const early = profile.refresh();
  await new Promise((r) => setTimeout(r, 20));
  const saving = profile.setPhoto(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' }));
  await new Promise((r) => setTimeout(r, 40));
  release();
  await Promise.all([early, saving]);
  check(put?.blob && put.type === 'image/jpeg', 'the photo goes as its own bytes, image/jpeg', JSON.stringify(put));
  check(profile.data?.photo === B, 'a new photo shows even with a read of the profile under way when it was saved', profile.data?.photo);
  hold = true;
  const early2 = profile.refresh();
  await new Promise((r) => setTimeout(r, 20));
  const removing = profile.removePhoto();
  await new Promise((r) => setTimeout(r, 40));
  release();
  await Promise.all([early2, removing]);
  check(profile.data?.photo === null && profile.photoUrl() === null, 'and a photo taken away goes', profile.data?.photo);
  globalThis.fetch = realFetch;
}

// ===== a page older than the installed app =====
{
  const { olderThanApp } = await imp('js/updates.js');
  const { APP_VERSION } = await imp('js/util.js');
  check(olderThanApp('2.1.0', '2.0.0') === true, 'the app is 2.1.0, the page 2.0.0: older');
  check(olderThanApp(APP_VERSION) === false, 'the same version: not older');
  check(olderThanApp('') === false && olderThanApp(undefined) === false && olderThanApp(null) === false, 'an app that cannot say (or no app): never older');
  check(olderThanApp() === false, 'outside the app: never older');

  // When a new version may replace the page.
  const { mayReload } = await imp('js/updates.js');
  const behind = { behind: true };
  check(mayReload({ hidden: true }) === true && mayReload({}) === false, 'a hidden page goes; a visible one of the same version waits');
  check(mayReload(behind) === true, 'a visible page older than the app, nothing going on: it goes at once');
  const holdAlways = ['layers', 'uploading', 'adding', 'playingHere'];
  const heldAlways = holdAlways.filter((k) => mayReload({ ...behind, [k]: true }) === false && mayReload({ hidden: true, [k]: true }) === false);
  check(heldAlways.join() === holdAlways.join(), 'something open, an upload, a source being added, music played by the page: held, hidden or not', heldAlways.join());
  const holdVisible = ['wayIn', 'code', 'busy'];
  const heldVisible = holdVisible.filter((k) => mayReload({ ...behind, [k]: true }) === false);
  check(heldVisible.join() === holdVisible.join(), 'older than the app but the way in is up, a code from #aggiungi= waits, or the person is busy: it waits', heldVisible.join());
  check(holdVisible.every((k) => mayReload({ hidden: true, behind: true, [k]: true }) === true), 'and goes once the page is hidden');
}

// ===== icons: two shapes side by side keep air between their strokes =====
{
  const { svgString } = await imp('icons/icons.js');
  const svg = svgString('devices');
  const rects = [...svg.matchAll(/<rect [^>]*?stroke-width="([\d.]+)"[^>]*?x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)].map((m) => {
    const [w, x, y, wd, ht] = m.slice(1).map(Number);
    return { l: x - w / 2, r: x + wd + w / 2, t: y - w / 2, b: y + ht + w / 2 };
  });
  const [mon, phone] = rects.sort((p, q) => p.l - q.l);
  const air = rects.length === 2 && phone.t < mon.b && mon.t < phone.b ? phone.l - mon.r : NaN;
  check(air >= 1.5 && mon.l >= 0 && phone.r <= 24, 'the devices icon: the monitor and the phone do not touch (at least 1.5 units between their strokes)', `air ${air.toFixed ? air.toFixed(2) : air}`);
}

// ===== the people: the profile ID and the search by it =====
{
  const P = await imp('js/profile-id.js');
  check(P.profileIdText('22de25661c578b57b919dfcada067bd4') === '4BF2-ASGW' && P.profileIdText('0b2b8f2b813476f9b1bea832400198fe') === '1CNR-YAW1', 'the profile ID of the shared vectors A and B', `${P.profileIdText('22de25661c578b57b919dfcada067bd4')} ${P.profileIdText('0b2b8f2b813476f9b1bea832400198fe')}`);
  check(P.profileIdText('ffffffffff') === 'ZZZZ-ZZZZ' && P.profileIdText('0000000000aa') === '0000-0000' && P.profileIdText('xyz') === '' && P.profileIdText(null) === '', 'the ID spans the 40 bits, and anything else is no ID');
  check(P.pidOf('4BF2-ASGW', '0b2b8f2b813476f9b1bea832400198fe') === '4BF2-ASGW' && P.pidOf('bogus', '22de25661c578b57b919dfcada067bd4') === '4BF2-ASGW' && P.pidOf(undefined, '22de25661c578b57b919dfcada067bd4') === '4BF2-ASGW', "the core's ID when it is one, else computed");
  check(P.searchKey(' mzoy-imnk ') === 'MZ0Y1MNK' && P.searchKey('l') === '1', 'the search key: upper case, no hyphen or space, O as 0, I and L as 1', P.searchKey(' mzoy-imnk '));
  const id = 'MZ0Y-1MNK';
  const hits = ['MZ0Y-1MNK', 'mz0y1mnk', 'MZOY-IMNK', 'mzoy', 'mz', 'MZ0Y-1', 'mz0y 1mlk'.slice(0, 7)].map((q) => P.idMatches(id, q));
  check(hits.every(Boolean), 'found by ID with and without the hyphen, with O and I typed, from 2 characters', JSON.stringify(hits));
  check(!P.idMatches(id, 'm') && !P.idMatches(id, 'ZZ') && !P.idMatches(id, '0Y') && !P.idMatches(id, ''), 'never from one character, never in the middle, never another start');
}

// ===== the people: times in words =====
{
  const W = await imp('js/when.js');
  const at = (y, mo, d, h = 12, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();
  const now = at(2026, 11, 18, 14, 32); // a Wednesday
  check(W.clockTime(at(2026, 11, 18, 9, 5)) === '09:05' && W.clockTime(at(2026, 11, 18, 0, 0)) === '00:00' && W.clockTime(at(2026, 11, 18, 23, 59)) === '23:59', 'the clock: HH:MM, 24 h');
  const lists = [at(2026, 11, 18, 9, 5), at(2026, 11, 17, 23, 59), at(2026, 11, 16, 8), at(2026, 11, 12, 8), at(2026, 11, 11, 8), at(2026, 1, 3), at(2025, 12, 31, 23, 59)].map((t) => W.listTime(t, now));
  check(lists.join(',') === '09:05,ieri,lun,gio,11/11,3/1,31/12/25', 'list times: today the clock, yesterday, the last 6 days, older, another year', lists.join(','));
  const rels = [now - 30000, now - 5 * 60000, now - 59 * 60000 - 59000, now - 61 * 60000, now - 2 * 3600000, now - 23 * 3600000 - 59 * 60000, now - 25 * 3600000, now + 5000].map((t) => W.relTime(t, now));
  check(rels.join(',') === 'adesso,5 min fa,59 min fa,1 ora fa,2 ore fa,23 ore fa,ieri,adesso', 'relative times: adesso, minutes, 1 ora fa, hours under a day, then the list time', rels.join(','));
  const chat = [at(2026, 11, 18, 0, 0, 1), at(2026, 11, 17, 23, 59, 59), at(2026, 11, 16), at(2026, 11, 15), at(2026, 11, 12), at(2026, 11, 11), at(2025, 11, 12)].map((t) => W.chatDay(t, now));
  check(chat.join(',') === 'Oggi,Ieri,Lunedì,Domenica,Giovedì,11 novembre,12 novembre 2025', 'chat days: Oggi, Ieri, the weekday in full, then the date, with the year when another', chat.join(','));
  const nearMidnight = at(2026, 1, 1, 0, 0, 30);
  const rec = [nearMidnight - 1000, at(2025, 12, 31, 23, 59, 59), at(2025, 12, 30, 23, 59), at(2025, 11, 12)].map((t) => W.recentsDay(t, nearMidnight));
  check(rec.join(',') === 'Oggi,Ieri,30 dicembre 2025,12 novembre 2025', 'Recenti days across midnight and a year change: Oggi, Ieri, then the date with its year', rec.join(','));
  const rec2 = [at(2026, 11, 18, 0, 1), at(2026, 11, 17, 23, 59), at(2026, 11, 16), at(2026, 3, 2)].map((t) => W.recentsDay(t, now));
  check(rec2.join(',') === 'Oggi,Ieri,16 novembre,2 marzo', 'Recenti days in the same year: no year, no weekday', rec2.join(','));
}

// ===== the people: words of the new codes =====
{
  const W = await imp('js/words.js');
  const want = { bad_card: 'Profilo social non valido', bad_time: 'Momento non valido', no_person: 'Persona non trovata', bad_message: 'Messaggio non valido', message_gone: 'Messaggio non trovato', bad_comment: 'Commento non valido', comment_gone: 'Commento non trovato', no_lyrics: 'Testo non trovato', bad_lyrics: 'Testo non valido', slow_down: 'Troppe richieste, riprova tra poco' };
  const bad = Object.entries(want).filter(([c, w]) => W.wordsFor(c) !== w);
  check(!bad.length, 'the social codes have their words', bad.map(([c]) => c).join(','));
}

// ===== the people: the list's order and its search =====
{
  const { listed, matches } = await imp('components/people.js');
  const { normPerson } = await imp('js/social.js');
  const raw = [
    { id: 'c3b1e5a7d9f20468ace13579bdf02468', name: 'Giulia', seen: 'all' },
    { id: 'a7c1e0d2b3f4051627384950a1b2c3d4', name: 'giulia', seen: 'all' },
    { id: '6d4a1f0c2e3b5a7988c1d2e3f4051627', name: 'Marco', seen: 'all' },
    { id: '0f1e2d3c4b5a69788796a5b4c3d2e1f0', name: 'Chiara', seen: 'chat' },
    { id: '2a3b4c5d6e7f80910a1b2c3d4e5f6071', name: 'Àlvaro', seen: 'all' },
    { id: 'zz', name: 'not a person' },
    { id: 'b1c2d3e4f5061728394a5b6c7d8e9f00', name: '' },
  ];
  const people = raw.map(normPerson).filter(Boolean);
  check(people.length === 5 && people.every((p) => /^[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(p.pid)), 'only real people are kept, each with an ID', people.map((p) => p.pid).join(','));
  const order = listed(people).map((p) => `${p.name}:${p.pid}`);
  check(order.join(',') === 'Àlvaro:58XM-RQBE,giulia:MZ0Y-1MNK,Giulia:RERY-B9YS,Marco:DN51-Y31E', 'the list: the ones every source shows, by name (accents and case aside), equal names by ID', order.join(','));
  const find = (q) => listed(people).filter((p) => matches(p, q)).map((p) => p.pid).join(',');
  check(find('GIU') === 'MZ0Y-1MNK,RERY-B9YS' && find('alva') === '58XM-RQBE' && find('mzoy-imnk') === 'MZ0Y-1MNK' && find('dn51y') === 'DN51-Y31E' && find('zz') === '', 'search: in the name without accents or case, or the start of the ID', [find('GIU'), find('alva'), find('mzoy-imnk'), find('dn51y')].join(' / '));
  const chiara = people.find((p) => p.seen === 'chat');
  check(matches(chiara, 'chia') && !matches(chiara, '1WF2'), 'someone seen only in a chat: by name, never by ID');
}

// ===== the people: the settings, one request at a time, the last tap wins, taken back on a refusal =====
{
  const realFetch = globalThis.fetch;
  const patches = [];
  let hold = null; // a promise the PATCH answer waits for
  let failNext = 0;
  let server = { invisible: false, showNow: true, privateUntil: 0, showRecent: true };
  const answer = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u === '/local/sources') return answer({ sources: [{ id: 'aaaa1111', name: 'Mi A2', principal: true, connected: true, social: 1 }] });
    if (u === '/local/people') return answer({ supported: true, v: 'v1', me: null, people: [] });
    if (u === '/local/social' && (!init.method || init.method === 'GET')) return answer({ supported: true, privacy: { ...server, privateSession: server.privateUntil > Date.now() }, blocked: [], mutes: {} });
    if (u === '/local/social' && init.method === 'PATCH') {
      const body = JSON.parse(init.body);
      patches.push(body);
      if (hold) await hold;
      if (failNext > 0) {
        failNext--;
        return answer({ error: 'x' }, 503);
      }
      for (const k of Object.keys(body)) {
        if (k === 'privateSession') server.privateUntil = body[k] ? Date.now() + 6 * 3600000 : 0;
        else server[k] = body[k];
      }
      return answer({ privacy: { ...server, privateSession: server.privateUntil > Date.now(), updatedAt: Date.now() } });
    }
    return answer({});
  };
  const { sources: src } = await imp('js/sources.js');
  const { social } = await imp('js/social.js');
  await src.refresh();
  await social.readSettings();
  const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
  check(src.social() && social.settingsSupported && social.privacy.showNow === true, 'a source with social 1: the settings are read and the section shows');

  // A burst: ten taps on "Mostra cosa ascolto", then nine: each moves the switch at once; the core
  // hears the burst once it rests, as one change (none when it ends where it began).
  const tapBurst = async (n, gap = 30) => {
    const seen = [];
    for (let i = 0; i < n; i++) {
      social.setPrivacy('showNow', !social.privacy.showNow);
      seen.push(social.privacy.showNow);
      await wait(gap);
    }
    return seen;
  };
  const ten = await tapBurst(10);
  await wait(450);
  check(ten.join() === 'false,true,false,true,false,true,false,true,false,true' && patches.length === 0 && social.privacy.showNow === true && server.showNow === true, 'ten taps: each one moves the switch at once; back where it began, nothing is sent', JSON.stringify({ patches, ten }));
  const nine = await tapBurst(9);
  await wait(450);
  check(nine[8] === false && patches.length === 1 && patches[0].showNow === false && server.showNow === false && social.privacy.showNow === false, 'nine taps: one request, with the state of the last tap', JSON.stringify(patches));
  // A tap while that request is on its way: one request at a time, the newest wish after it.
  let release;
  hold = new Promise((r) => (release = r));
  social.setPrivacy('showNow', true);
  await wait(450);
  social.setPrivacy('showNow', false);
  social.setPrivacy('showNow', true);
  await wait(450);
  const onTheWay = patches.length;
  hold = null;
  release();
  await wait(120);
  check(onTheWay === 2 && patches.length === 2 && server.showNow === true && social.privacy.showNow === true, 'taps while a request is on its way wait for it; their end state is the core\'s', JSON.stringify(patches));
  social.setPrivacy('showNow', false);
  await wait(450);
  check(patches.length === 3 && patches[2].showNow === false && server.showNow === false && social.privacy.showNow === false, 'and the next tap goes on its own', JSON.stringify(patches));
  social.setPrivacy('showNow', true);
  await wait(450);

  // Refused: the switch goes back to what the core holds.
  patches.length = 0;
  failNext = 1;
  social.setPrivacy('showRecent', false);
  const during = social.privacy.showRecent;
  await wait(450);
  check(during === false && social.privacy.showRecent === true && server.showRecent === true && patches.length === 1, 'a refused change comes back to the state before it', JSON.stringify({ during, after: social.privacy.showRecent }));

  // A private session: on until privateUntil, off by itself after it.
  social.setPrivacy('privateSession', true);
  await wait(450);
  const until = social.privacy.privateUntil;
  check(social.privacy.privateSession === true && until > Date.now() + 5.9 * 3600000, 'Sessione privata: on, for 6 hours', String(until - Date.now()));
  server.privateUntil = Date.now() + 40;
  await social.readSettings();
  const onNow = social.privacy.privateSession;
  await wait(60);
  check(onNow === true && social.privacy.privateSession === false, 'and off once privateUntil is past, with no request');
  social.setPrivacy('bogus', true);
  await wait(450);
  check(!patches.some((p) => 'bogus' in p), 'a field that is none of the four is never sent');
  globalThis.fetch = realFetch;
}

// ===== the people: the report of what plays (the page as the player) =====
{
  const A = await imp('js/activity.js');
  const vs = [0, '0', 2, '3', '4', 4, null, undefined, ''].map(A.pageReports);
  const no = [5, '5', '6', '10', 10].map(A.pageReports);
  check(vs.every(Boolean) && !no.some(Boolean), 'the page reports in a browser and with a bridge below 5, never from 5 (compared as numbers, "10" too)', JSON.stringify({ vs, no }));
  const sent = [];
  const timers = new Map();
  let tid = 0;
  let pending = null; // the answer of the request on its way
  const r = A.createReporter({
    send: (body) => {
      sent.push(body);
      return pending || Promise.resolve();
    },
    later: (fn, ms) => {
      timers.set(++tid, { fn, ms });
      return tid;
    },
    cancel: (id) => timers.delete(id),
  });
  const st = (trackId, playing, artistPage = false) => ({ track: { trackId, title: `T ${trackId}`, artist: 'A', album: 'L', artistPage }, playing });
  const flush = () => new Promise((res) => setTimeout(res, 0));
  r.update(st('aaa', false), { first: true });
  await flush();
  check(sent.length === 0 && timers.size === 0, 'the state the page starts with is no change: nothing sent');
  r.update(st('aaa', true));
  await flush();
  check(sent.length === 1 && sent[0].playing === true && sent[0].track.trackId === 'aaa' && timers.size === 1 && [...timers.values()][0].ms === 60000, 'play: one report, and the minute armed');
  r.update(st('aaa', true));
  await flush();
  check(sent.length === 1, 'the same state again: nothing');
  const beat = [...timers.entries()][0];
  timers.delete(beat[0]);
  beat[1].fn();
  await flush();
  check(sent.length === 2 && sent[1].playing === true && timers.size === 1, 'a minute while playing: the same state again, the next minute armed');
  r.update(st('bbb', true, true));
  await flush();
  check(sent.length === 3 && sent[2].track.trackId === 'bbb' && sent[2].track.artistPage === true, 'a change of track: reported, artistPage with it');
  r.update(st('bbb', false));
  await flush();
  check(sent.length === 4 && sent[3].playing === false && timers.size === 0, 'pause: reported, no minute left');
  r.update(st('ggg', false));
  await flush();
  check(sent.length === 4 && timers.size === 0, 'another song loaded while paused: nothing anyone sees changed, nothing sent');
  r.update(null);
  await flush();
  check(sent.length === 4 && timers.size === 0, 'an empty queue: nothing');
  // One request at a time: what comes while one is on its way waits, the newest replacing older.
  let done;
  pending = new Promise((res) => (done = res));
  r.update(st('ccc', true));
  pending = null;
  r.update(st('ddd', true));
  r.update(st('eee', true));
  r.update(st('fff', false));
  await flush();
  check(sent.length === 5 && sent[4].track.trackId === 'ccc', 'one request on its way, the others wait');
  done();
  await flush();
  await flush();
  check(sent.length === 6 && sent[5].track.trackId === 'fff' && sent[5].playing === false, 'then only the newest goes', JSON.stringify(sent.slice(4).map((s) => s.track.trackId)));
  const quiet = A.createReporter({ send: (b) => (sent.push(b), Promise.resolve()), may: () => false, later: () => 0, cancel: () => {} });
  const before = sent.length;
  quiet.update(st('zzz', true));
  await flush();
  check(sent.length === before, 'no source speaks the people part: nothing is sent');
}

// ===== the chats: texts, cards, the log's runs and days, the newest window over what was loaded =====
{
  const C = await imp('js/chat-data.js');
  check(C.cleanText('  ciao\r\nmondo\r! \u0007x \u2028y  ') === 'ciao\nmondo\n! x y', 'a chat text: \\r\\n and \\r become \\n, the other controls and the line separators go, trimmed, newlines kept', JSON.stringify(C.cleanText('  ciao\r\nmondo\r! \u0007x \u2028y  ')));
  check(C.cleanNote(' a\n\tb   c \u2029 d ') === 'a b c d', 'a note: one line, spaces collapsed', JSON.stringify(C.cleanNote(' a\n\tb   c \u2029 d ')));
  const smile = '\u{1F600}';
  check(C.cutPoints(smile.repeat(3), 2) === smile.repeat(2) && C.cutPoints('abc', 5) === 'abc' && C.cutPoints('x'.repeat(2001), C.TEXT_MAX).length === 2000 && C.TEXT_MAX === 2000 && C.NOTE_MAX === 300, 'cut in code points, never in the middle of an emoji; 2000 for a message, 300 for a note');
  const card = C.normCard({ kind: 'playlist', id: 'a1b2c3d4e5f60718', title: 'Studio notturno', sub: '', n: 6, sources: ['a54a6750', 3] });
  check(card && card.n === 6 && card.sources.join() === 'a54a6750' && !('tracks' in card), 'a playlist card: its id, name, track count and sources, no track list', JSON.stringify(card));
  check(C.normCard({ kind: 'video', id: 'a1b2c3d4', title: 'x' }) === null && C.normCard({ kind: 'track', id: 'zz', title: 'x' }) === null && C.normCard({ kind: 'album', id: 'a1b2c3d4e5f60718', title: '' }) === null, 'a card of another kind, a bad id or no title: none');
  check(C.normMsg({ id: 'a'.repeat(32), t: 'card' }) === null && C.normMsg({ id: 'b'.repeat(32), t: 'text', text: 'ciao', state: 'weird' }).state === 'sent', 'a card message without its card is dropped; an unknown state reads as sent');
  const goneQ = C.normMsg({ id: 'e'.repeat(32), t: 'text', text: 'ho capito', reply: { id: 'f'.repeat(32), from: 'a'.repeat(32), gone: true } }).reply;
  const liveQ = C.normReply({ id: 'f'.repeat(32), from: 'a'.repeat(32), text: 'ciao' });
  check(goneQ.gone === true && goneQ.text === '' && goneQ.card === null && liveQ.gone === false && liveQ.text === 'ciao', 'a quote the core says is of a message deleted for everyone stays gone: its sender only', JSON.stringify({ goneQ, liveQ }));
  const conv = C.normConv({ id: 'c'.repeat(32), kind: 'group', ids: ['d'.repeat(32)], unread: 5000, muted: true, mutedUntil: 0 });
  check(conv.ids.join() === ['c'.repeat(32), 'd'.repeat(32)].join() && conv.unread === 999 && conv.mutedUntil === 0 && conv.with === null, 'a conversation: every id of it, unread at most 999, silenced for ever', JSON.stringify(conv));
  const s1 = C.splitName('Giulia \u00b7 K7Q2');
  const s2 = C.splitName('Bacca');
  check(s1.name === 'Giulia' && s1.tag === 'K7Q2' && s2.name === 'Bacca' && s2.tag === null, 'a name as the core writes it: the name and the tag after the dot');
  const day0 = new Date(2026, 10, 18, 12, 0).getTime();
  const MIN = 60000;
  const A = 'a'.repeat(32);
  const B = 'b'.repeat(32);
  const msgs = [
    { id: '1', from: A, at: day0, mine: false },
    { id: '2', from: A, at: day0 + 4 * MIN, mine: false },
    { id: '3', from: A, at: day0 + 10 * MIN, mine: false },
    { id: '4', from: B, at: day0 + 11 * MIN, mine: true },
    { id: '5', from: B, at: day0 + 11.5 * MIN, mine: true },
    { id: '6', from: B, at: day0 + 13 * 3600000, mine: true },
  ];
  const lay = C.layoutLog(msgs).map((p) => `${p.day ? 'D' : ''}${p.run ? 'R' : ''}${p.end ? 'E' : ''}`);
  check(lay.join(',') === 'DR,E,RE,R,E,DRE', 'runs: one sender, one day, each less than 5 minutes after the one before; a day label over each day', lay.join(','));
  const m = (id, at, extra = {}) => ({ id, at, ...extra });
  const gone = new Set();
  const merged = C.mergeWindow([m('a1', 1), m('a2', 2), m('a3', 3), m('l9', 9, { local: true })], [m('a2', 2), m('a4', 4)], gone);
  check(merged.map((x) => x.id).join() === 'a1,a2,a4,l9' && [...gone].join() === 'a3', 'the newest window: what is older stays, what went from its span was deleted, a message being sent stays', JSON.stringify({ merged: merged.map((x) => x.id), gone: [...gone] }));
  check(C.mergeWindow([m('a1', 1)], [], new Set()).length === 0, 'an empty window: the conversation is empty');
  check(/^[0-9a-f]{32}$/.test(C.newMessageId()) && C.newMessageId() !== C.newMessageId(), 'a message id: 16 random bytes in hex');
}

// ===== the chats: the list asked with the v it holds, the shared cards only when it moved =====
// The page sends the v it holds as If-None-Match: the core answers 304 then (nothing to read), and
// a core that answers the whole list with the same v draws nothing either.
{
  const realFetch = globalThis.fetch;
  const asked = [];
  let listV = 'L1';
  let sharedGets = 0;
  let say304 = false;
  const answer = (obj, status = 200) => new Response(status === 304 ? null : JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
  const conv = (id, extra = {}) => ({ id, kind: 'direct', with: 'e'.repeat(32), display: 'Giulia', sources: ['aaaa1111'], ids: [id], last: { id: 'f'.repeat(32), from: 'e'.repeat(32), name: 'Giulia', mine: false, at: 5, t: 'text', text: 'ciao', state: 'sent', preview: 'ciao' }, unread: 2, muted: false, mutedUntil: null, at: 5, ...extra });
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const held = init.headers && init.headers['If-None-Match'];
    if (u === '/local/sources') return answer({ sources: [{ id: 'aaaa1111', name: 'Mi A2', principal: true, connected: true, social: 2 }] });
    if (u === '/local/chat/conversations') {
      asked.push(held || null);
      if (say304 && held === `"${listV}"`) return answer(null, 304);
      return answer({ supported: true, v: listV, unread: 2, conversations: [conv('1'.repeat(32)), conv('2'.repeat(32), { muted: true, unread: 7, at: 3 })] });
    }
    if (u === '/local/chat/shared') {
      sharedGets++;
      return answer({ v: `S-${listV}`, cards: [{ cid: '1'.repeat(32), messageId: '9'.repeat(32), from: 'e'.repeat(32), at: 4, card: { kind: 'track', id: '7f7b5b8431f309aac7052ce5', title: 'Onda quadra', sub: 'Delta Nadir' }, note: '', unseen: true, muted: false }] });
    }
    // The core answers every silence it holds: this one and the one the list already showed.
    if (u.endsWith('/mute')) return answer({ mutes: { ['1'.repeat(32)]: 0, ['2'.repeat(32)]: 0 } });
    if (u === '/local/social/blocked') return answer({ blocked: [JSON.parse(init.body).profileId] });
    return answer({});
  };
  const { sources: src } = await imp('js/sources.js');
  const { social } = await imp('js/social.js');
  await src.refresh();
  let emits = 0;
  const off = social.subscribe(() => emits++);
  await social.refreshChats();
  await new Promise((r) => setTimeout(r, 20));
  check(src.chats() && social.chatsSupported && social.conversations.length === 2 && social.unread === 2 && asked[0] === null, 'a source at social 2: the conversations, newest first, and the unread of the ones not silenced', JSON.stringify({ n: social.conversations.length, unread: social.unread, asked }));
  check(sharedGets === 1 && social.shared.length === 1 && social.shared[0].card.title === 'Onda quadra', 'the shared cards are read with the first list');
  const before = emits;
  await social.refreshChats();
  await new Promise((r) => setTimeout(r, 20));
  check(asked[1] === '"L1"' && emits === before && sharedGets === 1, 'the next ask holds its v: the same v comes back, nothing is drawn, the shared cards are not asked', JSON.stringify({ asked, emits, before, sharedGets }));
  say304 = true;
  await social.refreshChats();
  await new Promise((r) => setTimeout(r, 20));
  say304 = false;
  check(asked[2] === '"L1"' && emits === before && sharedGets === 1 && social.conversations.length === 2, 'a core that answers 304 to the v held: nothing drawn, nothing lost', JSON.stringify({ asked, emits, before, sharedGets }));
  listV = 'L2';
  await social.refreshChats();
  await new Promise((r) => setTimeout(r, 20));
  check(sharedGets === 2, 'the list moved: the shared cards are read again', String(sharedGets));
  await social.mute('1'.repeat(32), '8h');
  check(social.conversation('1'.repeat(32)).muted === true && social.unread === 0, 'silenced: at once in the list, its unread out of the total', JSON.stringify({ unread: social.unread }));
  check((await social.mute('1'.repeat(32), 'forever')) === false, 'a silence that is none of 8h, 1w, always, off is never asked');
  await social.block('e'.repeat(32));
  check(social.blocked.join() === 'e'.repeat(32) && !social.conversationWith('e'.repeat(32)), 'blocked: their chat goes at once');
  social.markSharedSeen('9'.repeat(32));
  check(social.sharedSeen('9'.repeat(32)) && JSON.parse(localStorage.getItem('mpfy.shared.seen')).includes('9'.repeat(32)), "a shared card opened from Home: its dot is cleared on this device (mpfy.shared.seen)");
  off();
  globalThis.fetch = realFetch;
}

// ===== the chats: one conversation open (the newest shown again with its v, sends one at a time) =====
{
  const realFetch = globalThis.fetch;
  const log = [];
  let msgs = [];
  let v = 'V1';
  let failNext = 0;
  let hold = null;
  const answer = (obj, status = 200) => new Response(status === 304 ? null : JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
  const mk = (id, at, extra = {}) => ({ id, from: 'e'.repeat(32), name: 'Giulia', mine: false, at, t: 'text', text: `m${at}`, state: 'sent', preview: '', ...extra });
  for (let i = 1; i <= 60; i++) msgs.push(mk(i.toString(16).padStart(32, '0'), i * 1000));
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || 'GET';
    const held = init.headers && init.headers['If-None-Match'];
    log.push(`${method} ${u}${held ? ` ${held}` : ''}${init.body ? ` ${init.body}` : ''}`);
    if (method === 'GET' && /\/messages\?limit=/.test(u)) {
      const q = new URLSearchParams(u.split('?')[1]);
      const limit = Number(q.get('limit'));
      // As the core: the whole page every time, with its v.
      const before = q.get('before');
      const end = before ? msgs.findIndex((x) => x.id === before) : msgs.length;
      const start = Math.max(0, end - limit);
      return answer({ v, messages: msgs.slice(start, end), more: start > 0 });
    }
    if (method === 'POST') {
      const b = JSON.parse(init.body);
      if (hold) await hold;
      if (failNext > 0) {
        failNext--;
        return answer({ message: { ...mk(b.id, Date.now(), { mine: true, text: b.text }), state: 'failed' } }, 201);
      }
      const m = mk(b.id, Date.now(), { mine: true, text: b.text, from: 'a'.repeat(32) });
      msgs.push(m);
      v = `V${msgs.length}`;
      return answer({ message: m }, 201);
    }
    if (method === 'PUT') return answer({ ok: true });
    if (method === 'DELETE') return answer({ ok: true });
    return answer({});
  };
  const { openChat } = await imp('js/chat.js');
  let changes = 0;
  const chat = openChat('c'.repeat(32), { onChange: () => changes++ });
  await chat.poll();
  check(chat.loaded && chat.messages.length === 50 && chat.more === true && log[0] === `GET /local/chat/${'c'.repeat(32)}/messages?limit=50`, 'opening: the newest 50, and that older ones exist', log[0]);
  const c0 = changes;
  await chat.poll();
  check(log[1].endsWith(' "V1"') && changes === c0, 'asked again with its v: unchanged, nothing drawn', log[1]);
  await chat.loadOlder();
  check(chat.messages.length === 60 && chat.more === false && /limit=50&before=0+b$/.test(log[2]), 'the 50 before the oldest shown: 10 more, none older', log[2]);
  await chat.poll();
  check(/limit=60/.test(log[3]), 'the newest are asked as many as are shown (at most 200)', log[3]);
  // Two sends at once: the first one's POST first, then the second's, each with its own id.
  let release;
  hold = new Promise((r) => (release = r));
  const p1 = chat.send({ text: 'uno' });
  const p2 = chat.send({ text: '  ' });
  const p3 = chat.send({ text: 'tre' });
  await new Promise((r) => setTimeout(r, 10));
  const posts0 = log.filter((l) => l.startsWith('POST')).length;
  const shownPending = chat.messages.filter((m) => m.local && m.state === 'pending').map((m) => m.text);
  hold = null;
  release();
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  const posts = log.filter((l) => l.startsWith('POST')).map((l) => JSON.parse(l.slice(l.indexOf('{'))));
  check(posts0 === 1 && shownPending.join() === 'uno,tre' && r2 === null && posts.length === 2 && posts[0].text === 'uno' && posts[1].text === 'tre' && posts[0].id !== posts[1].id && r1 && r3, 'sends: shown at once (pending), one POST at a time in order, each with its own id; an empty one sends nothing', JSON.stringify({ posts0, shownPending, posts }));
  failNext = 1;
  const rf = await chat.send({ text: 'perso' });
  check(rf === null && !chat.messages.some((m) => m.text === 'perso'), 'refused by every source: the message goes (and "Messaggio non inviato" is said)');
  // Read marks: a burst of five, one PUT now, the last one 2 s later.
  const puts = () => log.filter((l) => l.startsWith('PUT')).length;
  const ids = chat.messages.slice(-5).map((m) => m.id);
  for (const id of ids) chat.markRead(id);
  const now1 = puts();
  await new Promise((r) => setTimeout(r, 2150));
  const later1 = puts();
  check(now1 === 1 && later1 === 2 && log.filter((l) => l.startsWith('PUT')).pop().includes(ids[4]), 'read marks: at most one every 2 s, the newest last', JSON.stringify({ now1, later1 }));
  chat.markRead(ids[4]);
  await new Promise((r) => setTimeout(r, 20));
  check(puts() === 2, 'the mark already sent is not sent again');
  const changesPolled = changes;
  await chat.poll();
  check(changes === changesPolled, 'the newest again, the same v: nothing drawn', String(changes - changesPolled));
  const mine = chat.messages.filter((m) => m.mine).pop();
  await chat.remove(mine.id);
  check(!chat.messages.some((m) => m.id === mine.id) && log.some((l) => l.startsWith(`DELETE /local/chat/${'c'.repeat(32)}/messages/${mine.id}`)), 'delete for everyone: gone at once, then asked of the core');
  check((await chat.remove(chat.messages.find((m) => !m.mine).id)) === false, "someone else's message is never deleted from here");
  chat.stop();
  globalThis.fetch = realFetch;
}

// ===== the chats: older pages when the core no longer knows the oldest shown =====
{
  // A core restarted under an open chat holds only its newest; asked for what is before an id it
  // does not know, it gives its newest page. Nothing new came: the top stops asking.
  const realFetch = globalThis.fetch;
  const asked = [];
  const answer = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const mk = (i) => ({ id: i.toString(16).padStart(32, '0'), from: 'e'.repeat(32), name: 'Giulia', mine: false, at: i * 1000, t: 'text', text: `m${i}`, state: 'sent', preview: '' });
  let newest = Array.from({ length: 50 }, (_, i) => mk(100 + i));
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    return answer({ v: `N${asked.length}`, messages: newest, more: true });
  };
  const { openChat } = await imp('js/chat.js');
  const chat = openChat('f'.repeat(32));
  await chat.poll();
  newest = Array.from({ length: 50 }, (_, i) => mk(100 + i));
  const before = asked.length;
  await chat.loadOlder();
  await chat.loadOlder();
  check(chat.more === false && asked.length === before + 1, 'a page that brings nothing new ends the older pages (no request loop at the top)', JSON.stringify({ more: chat.more, asks: asked.length - before }));
  chat.stop();
  globalThis.fetch = realFetch;
}

// ===== the chats: a shared playlist, read whole from the core, kept in memory only =====
{
  const realFetch = globalThis.fetch;
  const lsBefore = JSON.stringify([...ls.keys()]);
  let answerWith = null;
  const answer = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = async (url) => {
    if (!/\/playlist$/.test(String(url))) return answer({});
    if (answerWith === 'away') throw new TypeError('Failed to fetch');
    if (answerWith === 404) return answer({ error: 'Risorsa non trovata', code: 'not_found' }, 404);
    return answer({ playlist: { id: 'a1b2c3d4e5f60718', name: 'Studio notturno', n: 3, trackIds: ['x'.repeat(24), 'y'.repeat(24), 7], cover: null, updatedAt: 5, live: answerWith !== 'copy' } });
  };
  const { readSharedPlaylist, playlistCopyNow, playlistGone } = await imp('js/chat.js');
  const cid = 'd'.repeat(32);
  const mid = '8'.repeat(32);
  const r1 = await readSharedPlaylist(cid, mid);
  check(r1.stale === false && r1.playlist.name === 'Studio notturno' && r1.playlist.trackIds.length === 2 && playlistCopyNow(cid, mid) === r1.playlist, 'a shared playlist: read whole and live, held for drawing', JSON.stringify(r1));
  answerWith = 'copy';
  const r2 = await readSharedPlaylist(cid, mid);
  check(r2.stale === true && r2.playlist.n === 3, "no source of it answers: the core's last copy, said stale");
  answerWith = 'away';
  const r3 = await readSharedPlaylist(cid, mid);
  check(r3 && r3.stale === true && r3.playlist === playlistCopyNow(cid, mid), 'the core away: the copy this session read');
  answerWith = 404;
  const r4 = await readSharedPlaylist(cid, mid);
  check(r4 && r4.gone === true && playlistCopyNow(cid, mid) === null && playlistGone(cid, mid), 'gone (404): no copy is shown any more');
  answerWith = 'away';
  check((await readSharedPlaylist('e'.repeat(32), mid)) === null, 'the core away and nothing read before: nothing');
  // Nothing of it goes to this device's storage: chat.js has no way to it, localStorage is as it was.
  const chatSrc = fs.readFileSync(path.join(web, 'js', 'chat.js'), 'utf8');
  check(!/idb\.js|indexedDB|localStorage|lsSet/.test(chatSrc) && JSON.stringify([...ls.keys()]) === lsBefore, 'nothing of it is written to this device');
  globalThis.fetch = realFetch;
}

// ===== the chats: the cover of a playlist someone shared =====
{
  // Their playlist's own cover is not in your libraries: it is asked from a source the card names
  // (where the playlist lives), never from your principal, which may not hold it.
  const { coverHref } = await imp('js/media.js');
  const coverId = 'c0ffee'.repeat(4);
  const href = coverHref(coverId, 'small', { forApp: true, via: ['abcd1234'] });
  check(typeof href === 'string' && href.includes('/abcd1234/'), "a shared playlist's cover is asked where the playlist lives", String(href));
  const plain = coverHref(coverId, 'small', { forApp: true });
  check(plain === null || !plain.includes('/abcd1234/'), 'without the card, nothing points there', String(plain));
}

// ===== the chats: what a card says of what you share =====
{
  // The core refuses a card whose title or sub is past 200 characters (the whole message would go):
  // a long tag is cut to one line of 200.
  const { cardOfTrack, cardOfAlbum } = await imp('js/music-card.js');
  const long = '\u{1F3B5}'.repeat(150) + 'x'.repeat(100);
  const t = cardOfTrack({ id: 'a'.repeat(24), title: long, artist: 'Lumen\nMarino' });
  const al = cardOfAlbum({ id: 'b'.repeat(16), name: long, artist: null });
  check(Array.from(t.title).length === 200 && t.sub === 'Lumen Marino' && Array.from(al.title).length === 200 && al.sub === '', 'a card: title and sub one line of at most 200 characters', JSON.stringify([Array.from(t.title).length, t.sub, Array.from(al.title).length, al.sub]));
}

// ===== the chats: the emoji of the panel =====
{
  const { EMOJI_SECTIONS } = await imp('js/emoji-data.js');
  const names = EMOJI_SECTIONS.map((s) => s.name);
  check(names.join('|') === 'Faccine ed emozioni|Persone e corpo|Animali e natura|Cibo e bevande|Viaggi e luoghi|Attività|Oggetti|Simboli|Bandiere', 'the sections, in their order', names.join('|'));
  const all = EMOJI_SECTIONS.flatMap((s) => s.list.split(' ')).map((w) => w.split('.').map((x) => parseInt(x, 16)));
  const has = (cps, lo, hi = lo) => cps.some((c) => c >= lo && c <= hi);
  const skin = all.filter((c) => has(c, 0x1f3fb, 0x1f3ff));
  const hair = all.filter((c) => has(c, 0x1f9b0, 0x1f9b3));
  // Code points of Emoji 13.0 and later (Unicode 13 to 16), and the symbol that became one in 13.0.
  const LATER = [[0x1f6d6, 0x1f6d7], [0x1f6dc, 0x1f6df], [0x1f6fb, 0x1f6fc], [0x1f7f0], [0x1f90c], [0x1f972], [0x1f977, 0x1f978], [0x1f979], [0x1f9a3, 0x1f9a4], [0x1f9ab, 0x1f9ad], [0x1f9cb, 0x1f9cc], [0x1fa74, 0x1fa77], [0x1fa7b, 0x1fa7c], [0x1fa83, 0x1fa89], [0x1fa8f], [0x1fa96, 0x1fabf], [0x1fac0, 0x1facf], [0x1fad0, 0x1fadf], [0x1fae0, 0x1faef], [0x1faf0, 0x1faff], [0x26a7]];
  const newer = all.filter((c) => LATER.some(([lo, hi = lo]) => has(c, lo, hi)));
  // Sequences of 13.0 and later whose code points are older: gender-neutral people (12.1), and the rest.
  const seq = (c) => c.map((x) => x.toString(16)).join('.');
  const LATER_SEQ = ['2764.fe0f.200d.1f525', '2764.fe0f.200d.1fa79', '1f62e.200d.1f4a8', '1f635.200d.1f4ab', '1f636.200d.1f32b.fe0f', '1f43b.200d.2744.fe0f', '1f408.200d.2b1b', '1f426.200d.2b1b', '1f1e8.1f1f6', '1f935.200d.2640.fe0f', '1f470.200d.2642.fe0f', '1f469.200d.1f37c'];
  const people = all.filter((c) => c.includes(0x200d) && c.includes(0x1f9d1) && seq(c) !== '1f9d1.200d.1f91d.200d.1f9d1');
  const laterSeq = all.filter((c) => LATER_SEQ.includes(seq(c)) || (c.includes(0x200d) && has(c, 0x27a1)));
  check(all.length > 1600 && !skin.length && !hair.length && !newer.length && !people.length && !laterSeq.length, 'the data: no skin tones, no hair, nothing newer than Emoji 12.0', JSON.stringify({ n: all.length, skin: skin.length, hair: hair.length, newer: newer.map(seq), people: people.length, laterSeq: laterSeq.map(seq) }));
  const twelve = ['1f971', '1f90e', '1f9a9', '1fa80', '1f9cf.200d.2640.fe0f', '1f415.200d.1f9ba', '1f9d1.200d.1f91d.200d.1f9d1', '1f3f4.200d.2620.fe0f', '263a.fe0f'];
  const words = new Set(EMOJI_SECTIONS.flatMap((s) => s.list.split(' ')));
  check(twelve.every((w) => words.has(w)), 'what 12.0 added is there, fully qualified (with its FE0F where it needs one)', twelve.filter((w) => !words.has(w)).join(','));
  const { recentEmoji, useEmoji } = await imp('components/emoji-picker.js');
  localStorage.removeItem('mpfy.emoji.recent');
  for (let i = 0; i < 30; i++) useEmoji(String.fromCodePoint(0x1f600 + i));
  // One still among the 24, used again: it comes first and is there once.
  useEmoji(String.fromCodePoint(0x1f610));
  const rec = recentEmoji();
  check(rec.length === 24 && rec[0] === String.fromCodePoint(0x1f610) && rec[1] === String.fromCodePoint(0x1f61d) && rec.filter((e) => e === String.fromCodePoint(0x1f610)).length === 1 && !rec.includes(String.fromCodePoint(0x1f605)), 'Recenti: the last 24 used, the newest first, each once', JSON.stringify(rec.slice(0, 3)));
}

// ===== the songs: comments of several sources as one list =====
{
  const { unionComments, normComment } = await imp('js/comments.js');
  const ME = 'a'.repeat(32);
  const G = 'b'.repeat(32);
  const M = 'c'.repeat(32);
  const id = (n) => String(n).repeat(32).slice(0, 32);
  const c = (n, from, at, text = 'ciao') => ({ id: id(n), trackId: 't'.repeat(24), from, name: '', at, text });
  // The Mi A2 and the VPS both hold Giulia's comment 1; Marco wrote twice (2 older on the Mi A2, 3 newer on the VPS); yours is the oldest.
  const mi = { src: 'mi', list: [c(1, G, 500), c(2, M, 300), c(4, ME, 100)] };
  const vps = { src: 'vps', list: [c(1, G, 500), c(3, M, 400)] };
  const u = unionComments([mi, vps], ME);
  check(u.length === 3 && u.filter((x) => x.id === id(1)).length === 1 && u.find((x) => x.id === id(1)).where.join() === 'mi,vps', 'a comment both sources hold is shown once, and both are remembered', JSON.stringify(u.map((x) => [x.id.slice(0, 2), x.where])));
  check(u[0].from === ME && u[1].id === id(1) && u[2].id === id(3), 'yours first, then the newest first, one per author (the newest)', JSON.stringify(u.map((x) => x.id.slice(0, 2))));
  check(u[2].older.length === 1 && u[2].older[0].id === id(2) && u[2].older[0].where.join() === 'mi', "an author's older copy is kept with its source (yours is deleted everywhere it was returned)", JSON.stringify(u[2].older));
  check(unionComments([vps, mi], null)[0].id === id(1) && unionComments([], ME).length === 0, 'without a profile no comment is yours; nothing held, nothing shown');
  check(!normComment({ id: 'x', from: G, at: 1, text: 'a' }) && !normComment({ id: id(1), from: G, at: 1, text: '' }) && !normComment({ id: id(1), from: 'nope', at: 1, text: 'a' }) && normComment({ id: id(1), from: G, at: '7', text: 'a', name: 'Giulia' }).at === 7, 'a comment: a 32 hex id and author, a time and some text, or it is not one');
}

// ===== the songs: the lyrics as they follow the song =====
{
  const { currentLine, cardWindow, lineClass, firstLines, plainLines, looksSynced, normLyrics } = await imp('js/lyrics.js');
  const lines = [{ t: 6000, text: 'Lascio il molo al buio' }, { t: 15500, text: 'rosso a sinistra' }, { t: 25000, text: 'verde a destra' }, { t: 34500, text: 'non chiedo dove vado' }, { t: 44000, text: 'basta che tu mi veda' }];
  check(currentLine(lines, 0) === -1 && currentLine(lines, 5999) === -1, 'before the first line: none is current');
  check(currentLine(lines, 6000) === 0 && currentLine(lines, 25000) === 2 && currentLine(lines, 34499) === 2, 'at a line time that line is current, just before it the one before');
  check(currentLine(lines, 999999) === 4 && currentLine([], 5) === -1, 'after the last line the last one stays; no lines, none');
  const win = (i) => cardWindow(lines.length, i).join('-');
  check(win(-1) === '0-3' && win(0) === '0-3' && win(2) === '1-4' && win(4) === '2-5' && cardWindow(2, 1).join('-') === '0-2', 'the card: the line before, the current, the next; at the ends the three nearest; before the first, the first three', [win(-1), win(0), win(2), win(4)].join(' '));
  check([0, 1, 2].map((k) => lineClass(k, -1)).join() === 'next,next,next' && [1, 2, 3].map((k) => lineClass(k, 2)).join() === 'past,now,next', 'past, now and next; before the first line all wait');
  const plain = { kind: 'plain', text: '\nStrade bianche di sale\r\ncase basse contro il vento\n\nil porto dorme\ne le barche aspettano\nnessuno corre' };
  check(firstLines(plain).join('|') === 'Strade bianche di sale|case basse contro il vento|il porto dorme|e le barche aspettano', 'a plain text: its first 4 lines with words, still', firstLines(plain).join('|'));
  check(plainLines({ kind: 'synced', lines }).length === 5, 'synced lines shown still: their texts');
  check(looksSynced('[00:12.34]Lascio il molo al buio') && looksSynced('[1:02]riga') && !looksSynced('Lascio il molo al buio\nrosso a sinistra') && !looksSynced('[ar:Lumen Marino]'), 'a time tag makes a text synced; a metadata tag alone does not');
  const n = normLyrics({ kind: 'synced', lines: [{ t: 9000, text: 'b' }, { t: 3000.4, text: 'a' }, { t: -1, text: 'x' }, { t: 'no', text: 'y' }, { t: 9000, text: 'c' }] });
  check(n.lines.map((l) => `${l.t}:${l.text}`).join(',') === '3000:a,9000:b,9000:c', 'an answer made safe: sorted by time (equal times keep their order), times whole, bad lines out', JSON.stringify(n.lines));
  check(!normLyrics({ kind: 'instrumental' }) && !normLyrics({ kind: 'plain', text: '  ' }) && !normLyrics({ kind: 'synced', lines: [] }) && normLyrics({ kind: 'plain', text: 'riga' }).text === 'riga', 'no lyrics: an instrumental, an empty text, no lines');
  const many = normLyrics({ kind: 'synced', lines: Array.from({ length: 2500 }, (_, i) => ({ t: i, text: 'r' })) });
  check(many.lines.length === 2000, 'at most 2,000 lines are kept');
  const { lyricsColor } = await imp('js/color.js');
  const hsl = ([r, g, b]) => {
    r /= 255;
    g /= 255;
    b /= 255;
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const l = (mx + mn) / 2;
    const d = mx - mn;
    const s2 = d === 0 ? 0 : l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    let h2 = 0;
    if (d) h2 = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) * 60 : mx === g ? ((b - r) / d + 2) * 60 : ((r - g) / d + 4) * 60;
    return [h2, s2, l];
  };
  const teal = [36, 66, 76]; // a toned cover colour (saturation about 0.36)
  const [h0, s0] = hsl(teal);
  const [h1, s1, l1] = hsl(lyricsColor(teal));
  check(Math.abs(h1 - h0) < 3 && Math.abs(s1 - Math.min(0.6, s0 * 1.7)) < 0.03 && Math.abs(l1 - 0.29) < 0.01, 'the lyrics colour: the cover hue, its saturation times 1.7 up to 0.6, lightness 0.29', JSON.stringify([h0, s0, h1, s1, l1]));
  const [, sg] = hsl(lyricsColor([70, 70, 70]));
  check(sg === 0, 'a grey cover gives a grey: no colour is made up');
}

// ===== "Locale": the phone's own music, the person's data on the phone, the move =====
{
  const realFetch = globalThis.fetch;
  const { store, allowedVersion: allowedV } = await imp('js/store.js');
  const { versionsFor, downloadVersion } = await imp('js/media.js');
  const { sources: srcs } = await imp('js/sources.js');
  const R = 'beef0001';
  const R2 = 'beef0002';
  const hex = (n) => n.toString(16).padStart(24, '0');
  const [A, B, LOC1, LOC2, OLD, LOC3, X0, X1, X2] = [0xa1, 0xb1, 0x11, 0x12, 0x10, 0x13, 0xc0, 0xc1, 0xc2].map(hex);
  const tr = (id, extra = {}) => ({ id, fileHash: id, title: `Brano ${id.slice(-2)}`, artist: 'Prova', album: `Disco ${id.slice(-2)}`, albumArtist: 'Prova', trackNo: 1, discNo: 1, year: 2020, duration: 200 + parseInt(id.slice(-2), 16), format: 'mp3', mime: 'audio/mpeg', codec: 'mp3', sampleRate: 44100, bitDepth: null, size: 8000000, bitrate: 320000, lossless: false, addedAt: 1, coverId: null, qualities: { low: true, normal: true, high: true }, mine: true, ...extra });
  const real = { v: 10, uv: 10, likes: [{ id: X0, at: 5 }], playlists: [], recents: [], played: [] };
  const phone = { v: 20, uv: 20, home: true, likes: [{ id: OLD, at: 7 }], playlists: [], recents: [], state: 'ready' };
  const reqs = [];
  let withReal = true;
  let secondReal = false;
  let failMoved = 0;
  const json = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { 'Content-Type': 'application/json' } });
  const lib = (s, tracks, user, you, source, ep) => ({ version: s.v, userVersion: s.uv, epochs: { shared: ep, user: ep }, delta: { shared: false, user: false }, tracks, playlists: user.playlists, likes: user.likes, recents: user.recents, covers: { track: {}, album: {}, playlist: {} }, you, source });
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : null;
    if (u !== '/local/sources' && !u.includes('/api/library')) reqs.push(`${method} ${u}${body ? ' ' + JSON.stringify(body) : ''}`);
    if (u === '/local/sources') {
      const list = withReal ? [{ id: R, name: 'Casa', principal: true, connected: true, rttMs: 30, throughputKbps: null, addedAt: 1, role: 'owner', named: true, profiles: true, social: 0 }] : [];
      if (withReal && secondReal) list.push({ id: R2, name: 'Altra', principal: false, connected: true, rttMs: 10, throughputKbps: null, addedAt: 2, role: 'owner', named: true, profiles: true, social: 0 });
      return json({ sources: list, phone: { id: '0000', name: 'Locale', state: phone.state, tracks: 4, v: `${phone.v}.${phone.uv}`, home: phone.home || !withReal, details: true, shadowed: true } });
    }
    if (u.startsWith(`/s/${R}/api/library`)) return json(lib(real, [tr(A, { format: 'flac', codec: 'flac', lossless: true, bitDepth: 24 }), tr(B)], real, { profileId: 'p', role: 'owner' }, { name: 'Casa', named: true }, 'aaaaaaaaaaaaaaaa'));
    if (u.startsWith(`/s/${R2}/api/library`)) return json(lib({ v: 1, uv: 1 }, [], { likes: [], playlists: [], recents: [] }, { profileId: 'p', role: 'owner' }, { name: 'Altra', named: true }, 'cccccccccccccccc'));
    if (u.startsWith('/s/0000/api/library')) return json(lib(phone, phone.state === 'off' ? [] : [tr(A, { format: 'flac', codec: 'flac', lossless: true, bitDepth: null }), tr(LOC1), tr(LOC2, { was: [OLD] }), tr(LOC3, { was: [B] })], phone.home ? phone : { likes: [], playlists: [], recents: [] }, null, { name: 'Locale', named: true, details: true, social: 0 }, 'bbbbbbbbbbbbbbbb'));
    const lk = /^\/s\/0000\/api\/likes\/([0-9a-f]+)/.exec(u);
    if (lk) {
      if (method === 'DELETE') phone.likes = phone.likes.filter((x) => x.id !== lk[1]);
      else if (!phone.likes.some((x) => x.id === lk[1])) phone.likes.unshift({ id: lk[1], at: Date.now() });
      phone.uv++;
      return json({ ok: true });
    }
    if (u === `/s/${R}/api/likes` && method === 'POST') {
      real.likes = real.likes.filter((x) => !(body.remove || []).includes(x.id));
      for (const id of body.add || []) if (!real.likes.some((x) => x.id === id)) real.likes.unshift({ id, at: Date.now() });
      real.uv++;
      return json({ ok: true });
    }
    if (u.startsWith('/s/0000/api/recents')) return json({ recents: phone.recents, more: false });
    if (u.startsWith(`/s/${R}/api/recents`)) return json({ recents: real.recents, more: false });
    if (u === `/s/${R}/api/played`) {
      real.played.push(body);
      real.recents.unshift(body);
      return json({ ok: true });
    }
    if (u === '/local/phone/moved') {
      if (failMoved > 0) {
        // The notification's heart took a like away while the pass ran.
        failMoved--;
        phone.likes = phone.likes.filter((x) => x.id !== X2);
        phone.uv++;
        return json({ error: 'I dati sono cambiati nel frattempo', code: 'changed' }, 409);
      }
      if (body.to !== R) return json({ code: 'not_found' }, 404);
      if (body.uv !== phone.uv || body.ue !== 'bbbbbbbbbbbbbbbb') return json({ code: 'changed' }, 409);
      phone.home = false;
      return json({ ok: true });
    }
    return json({ ok: true });
  };
  try {
    await srcs.refresh();
    await store.refresh();
    await store.idle();
    check(typeof srcs.music === 'function' && srcs.music().map((s) => s.id).join(',') === `${R},0000`, 'Locale: sources.music() is the real sources in order, then the phone', JSON.stringify(srcs.music?.().map((s) => s.id)));
    secondReal = true;
    await srcs.refresh();
    check(srcs.music?.().map((s) => s.id).join(',') === `${R},${R2},0000` && srcs.list.every((s) => s.id !== '0000'), 'Locale: never in the list, always after every real source', JSON.stringify(srcs.music?.().map((s) => s.id)));
    secondReal = false;
    await srcs.refresh();
    check(srcs.principal()?.id === R && srcs.name('0000') === 'Locale' && srcs.get('0000')?.rttMs === 0 && srcs.get('0000')?.social === 0 && srcs.isLocal?.('0000') === true, 'Locale: its entry apart, its name, rtt 0, social 0; the principal a real source', JSON.stringify(srcs.get('0000')));
    const song = store.track(A);
    const lv = song?.versions.find((v) => v.sourceId === '0000');
    check(!!lv && song.versions.length === 2 && allowedV(lv) === false && song.versions.some((v) => v.sourceId === R && allowedV(v)), 'Locale: allowedVersion is false for its version, true for the source one', JSON.stringify(song?.versions.map((v) => v.sourceId)));
    const vf = versionsFor(A);
    // The phone reads no bit depth below Android 12: its copy scores lower, and still goes first.
    check(vf.versions[0]?.sourceId === '0000' && vf.versions[0].v.score < vf.versions[1].v.score && vf.versions.length === 2 && vf.q === vf.level && /\/s\/0000\/api\/stream\//.test(vf.versions[0].url), 'Locale first: versionsFor puts the phone first and keeps the decided level', JSON.stringify(vf.versions.map((v) => v.sourceId).concat(vf.q, vf.level)));
    check(downloadVersion(A) === null && downloadVersion(B)?.v.sourceId === R, 'downloadVersion: null for a song with a Locale version, the source for the rest');
    check(store.gid(OLD) === LOC2 && store.track(OLD) === store.track(LOC2), 'the alias: a `was` id resolves to its song', String(store.gid(OLD)));
    check(store.gid(B) === B && store.track(B).versions.every((v) => v.sourceId === R), 'the alias never over a real version id', JSON.stringify(store.track(B)?.versions.map((v) => v.sourceId)));
    {
      // The real version goes in a change (no whole merge): its id resolves at once to the song
      // that carries it as an alias, the first of them in order, as the whole merge makes it.
      const { Union } = await imp('js/merge.js');
      const LOC4 = hex(0x14);
      const libs = new Map([[R, [tr(B), tr(A)]], ['0000', [tr(LOC3, { was: [B] }), tr(LOC4, { was: [B] })]]]);
      const host = { order: () => [R, '0000'], tracksOf: (sid) => libs.get(sid), trackOf: (sid, id) => libs.get(sid).find((t) => t.id === id), seqOf: (sid, id) => libs.get(sid).findIndex((t) => t.id === id) + 1, coversOf: () => null, kept: () => [] };
      const u = new Union(host);
      u.wholeNow();
      while (u.compareSome(50));
      const before = u.d.tracks.get(B)?.id;
      u.takeChanged();
      libs.set(R, [tr(A)]);
      u.patch({ tracks: [[R, B]] });
      while (u.compareSome(50));
      const c = u.takeChanged();
      const after = u.d.tracks.get(B)?.id;
      const ref = new Union(host);
      ref.wholeNow();
      check(before === B && after === LOC3 && ref.d.tracks.get(B)?.id === LOC3 && c.moved.has(B), 'a real version gone in a change: its id resolves at once to the first song carrying it as an alias', JSON.stringify({ before, after, whole: ref.d.tracks.get(B)?.id, moved: c.moved.has(B) }));
      // A song that comes later in order and carries it too leaves it where it is.
      const LOC5 = hex(0x15);
      libs.get('0000').push(tr(LOC5, { was: [B] }));
      u.patch({ tracks: [['0000', LOC5]] });
      while (u.compareSome(50));
      const ref2 = new Union(host);
      ref2.wholeNow();
      check(u.d.tracks.get(B)?.id === LOC3 && ref2.d.tracks.get(B)?.id === LOC3, 'a later song carrying the alias too does not take it (as the whole merge)', JSON.stringify({ patch: u.d.tracks.get(B)?.id, whole: ref2.d.tracks.get(B)?.id }));
      libs.set('0000', [tr(LOC4, { was: [B] }), tr(LOC5, { was: [B] })]);
      u.patch({ tracks: [['0000', LOC3]] });
      while (u.compareSome(50));
      check(u.d.tracks.get(B)?.id === LOC4, 'and when that song goes too, to the next one carrying it', String(u.d.tracks.get(B)?.id));
    }
    check(store.principalId === '0000', 'the home: the phone while it holds the data (principalId 0000)', String(store.principalId));
    check(store.isLiked(LOC2), 'the old like shows on the retagged song');
    reqs.length = 0;
    await store.unlike(LOC2);
    check(reqs.some((r) => r === `DELETE /s/0000/api/likes/${OLD}?brief=1`), 'an unlike of a retagged song removes its old like', JSON.stringify(reqs));
    // The move: a like the source held stays, the phone's go over, and a like the phone took back
    // during the pass is taken back on the source too.
    phone.likes = [{ id: X1, at: 8 }, { id: X2, at: 9 }];
    phone.uv++;
    phone.recents = [{ trackId: A, at: Date.now() - 3600000 * 2, context: { type: 'library', id: null } }, { trackId: LOC1, at: Date.now() - 40 * 86400000, context: { type: 'library', id: null } }];
    await srcs.refresh();
    await store.refresh();
    failMoved = 1;
    reqs.length = 0;
    const steps = [];
    const r = typeof store.movePhoneData === 'function' ? await store.movePhoneData(R, (done, total, label) => steps.push(label)) : null;
    const realIds = real.likes.map((x) => x.id).sort().join(',');
    check(!!r && realIds === [X0, X1].sort().join(','), 'the move: an unlike during the move is not undone, a like the source held stays', JSON.stringify({ realIds, reqs }));
    check(real.played.length === 1 && real.played[0].trackId === A && phone.home === false, 'the move: the plays of the last 30 days go with their own time, then moved', JSON.stringify(real.played));
    check(steps.includes('Recenti') && steps.includes('Mi piace'), 'the move: its steps', JSON.stringify(steps));
    await srcs.refresh();
    check(store.principalId === R, 'after the move the home is the principal', String(store.principalId));
    withReal = false;
    await srcs.refresh();
    check(srcs.principal() === null && store.principalId === '0000', 'principal never 0000: no real source, no principal; the home is the phone', JSON.stringify(srcs.principal()));
    phone.state = 'off';
    phone.v++;
    await srcs.refresh();
    check(srcs.isUp('0000') === true, 'the permission off: Locale is still up (the core answered)');
  } catch (err) {
    check(false, 'Locale checks ran', err.stack || String(err));
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log(`failures=${failures}`);
process.exit(failures ? 1 : 0);
