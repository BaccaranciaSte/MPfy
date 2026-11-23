// Drives web/js/upload.js in Node against a fake client core with one source, with a fake
// XMLHttpRequest that plays the source's upload endpoints (single PUT, resumable sessions, the
// "maybe" choice, archives) and can cut a chunk halfway, answer 503, refuse with 429, or take its
// time over the import after the last byte. Timings are shortened with uploads.configure().
//
// Checks: the words of every outcome and row state; the "maybe" choice; an archive's progress and
// summary (an album already there is "Già presente"); a chunked upload that resumes after a drop
// with no byte lost or doubled; a last chunk whose answer is slow is followed by asking the
// session until it is done, never by a second PUT at the end; "too many uploads" cancels the
// person's own stale sessions oldest first and asks once more, then gives up with its words;
// only failures the core answered count toward giving up; a source without profiles gets one PUT
// and no archive; files from a folder (relative paths) leave out what is not audio, quietly; the
// app's folder picker streams its files in, read with Range requests, and is released at the end;
// setUploading follows the queue, also on a hidden page (no animation frames); a full disk on a
// chunk is said at once, without pausing; sessions of files still waiting in the queue are kept
// when making room; a folder's images are offered as a cover only when named so; the hint waits
// for the source's health; several choices with the sheet closed show one toast; an archive's bar
// starts its extraction from empty and never runs back. An .lrc in a folder goes to its song's
// track once that upload answered (new or already there; the same name in any case, not one of
// another folder), as beside=1 and only to a source that speaks the songs part, its text read
// at once from the app's folder picker.
//
// Usage: node web/dev/upload-harness.mjs <web dir>   (prints OK/FAIL lines, exit 1 on a failure)
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const web = path.resolve(process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..'));
const noop = () => {};
const ls = new Map();
globalThis.Node = class {};
const el = () => Object.assign(Object.create(Node.prototype), { kids: [], append(...a) { this.kids.push(...a); }, appendChild: noop, remove: noop, classList: { add: noop, remove: noop, toggle: noop, contains: () => false }, style: { setProperty: noop }, setAttribute: noop, addEventListener: noop, children: [], firstElementChild: null, querySelector: () => null, querySelectorAll: () => [], dataset: {} });
const textOf = (e) => (typeof e === 'string' ? e : (e?.kids || []).map(textOf).join(''));
const toasts = [];
const toastRoot = { children: [], firstElementChild: null, append: (e) => toasts.push(textOf(e)) };
globalThis.window = globalThis;
globalThis.addEventListener = noop;
globalThis.matchMedia = () => ({ matches: false, addEventListener: noop });
globalThis.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) };
globalThis.document = { getElementById: (id) => (id === 'toasts' ? toastRoot : null), querySelector: () => null, querySelectorAll: () => [], addEventListener: noop, createElement: el, createElementNS: el, createDocumentFragment: el, body: el(), documentElement: el(), hidden: false };
globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
globalThis.location = { origin: 'http://127.0.0.1:47123', href: 'http://127.0.0.1:47123/' };
globalThis.URL.createObjectURL = () => 'blob:x';
globalThis.URL.revokeObjectURL = noop;

// ---- the app's bridge: only what uploads use ----
const calls = [];
globalThis.MPfyNative = new Proxy({}, { get: (_, name) => (...args) => {
  calls.push({ name, args });
  if (name === 'bridgeVersion') return '3';
  if (name === 'pickFolder') return 'fold0001fold0001';
  if (name === 'listDownloads') return JSON.stringify({ ids: [], progress: {}, items: [] });
  if (name === 'getNetwork') return JSON.stringify({ type: 'wifi', metered: false });
  return undefined;
} });

// ---- the fake source ----
const A = 'aaaa1111';
const srv = {
  role: 'owner',
  archives: { zip: true, sevenZip: true, rar: false },
  sessions: new Map(),
  maxSessions: 4,
  drop: 0, // the next n chunk requests are cut halfway (the bytes before the cut arrive)
  fail: 0, // the next n chunk requests answer 503
  silent: 0, // the next n chunk requests get no answer at all
  diskFull: 0, // the next n chunk requests answer 507 disk_full
  createFail: 0, // the next n session creations answer 503 (the link is down)
  singleSilent: 0, // the next n single PUTs get no answer at all
  pipelineMs: 0,
  archives2: new Map(),
  pending: new Map(),
  log: [], // what reached the source
  social: 3, // what it speaks of the social part (3: the songs too)
  lyrics: [], // the lyrics PUTs: { trackId, beside, text, type }
  stored: new Map(), // name -> the bytes of a finished upload
};
let seq = 0;
const nid = () => (++seq).toString(16).padStart(16, '0');
const resultFor = (name, bytes) => {
  const title = name.replace(/\.[^.]+$/, '');
  const track = { id: crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 24), title, artist: 'X', album: 'Y', coverId: null };
  srv.stored.set(name, Buffer.from(bytes));
  if (/\.zip$/i.test(name)) {
    const id = nid();
    const dup = /gia/i.test(name);
    srv.archives2.set(id, { id, name, step: 0, dup });
    return { status: 202, body: { outcome: 'archive', archive: { id } } };
  }
  if (/dup/.test(name)) return { status: 200, body: { outcome: 'duplicate', duplicate: true, track } };
  if (/\[hq\]/.test(name)) return { status: 200, body: { outcome: 'replaced', duplicate: true, track } };
  if (/\[forse\]/.test(name)) {
    const id = nid();
    srv.pending.set(id, { track });
    return { status: 200, body: { outcome: 'maybe', pending: { id, match: { id: 'm1', title: 'Il brano vero' }, candidate: { title }, expiresAt: Date.now() + 1e6 } } };
  }
  return { status: 201, body: { outcome: 'added', duplicate: false, track } };
};
const view = (s) => ({ id: s.id, name: s.name, size: s.size, offset: s.offset, processing: s.processing, done: s.done, expiresAt: 0, ...(s.done ? { result: s.result } : {}) });

class FakeXHR {
  constructor() {
    this.upload = {};
    this.status = 0;
    this.responseText = '';
    this.done = false;
  }
  open(method, url) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader() {}
  abort() {
    if (this.done) return;
    this.done = true;
    setTimeout(() => this.onabort?.(), 0);
  }
  answer(status, body) {
    if (this.done) return;
    this.done = true;
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
  fail() {
    if (this.done) return;
    this.done = true;
    this.onerror?.();
  }
  async send(body) {
    const bytes = body ? new Uint8Array(await new Response(body).arrayBuffer()) : new Uint8Array(0);
    const u = new URL(this.url, 'http://127.0.0.1:47123');
    srv.log.push(`${this.method} ${u.pathname}${u.search}`);
    await new Promise((r) => setTimeout(r, 5));
    let m = /^\/s\/[^/]+\/api\/upload\/(.+)$/.exec(u.pathname);
    if (m && srv.singleSilent > 0) {
      srv.singleSilent--;
      return this.fail();
    }
    if (m) {
      this.upload.onprogress?.({ lengthComputable: true, loaded: bytes.length, total: bytes.length });
      this.upload.onload?.();
      const r = resultFor(decodeURIComponent(m[1]), bytes);
      return this.answer(r.status, r.body);
    }
    m = /^\/s\/[^/]+\/api\/uploads\/([^/]+)$/.exec(u.pathname);
    const s = m && srv.sessions.get(m[1]);
    if (!s) return this.answer(404, { error: 'x', code: 'session_gone' });
    const off = Number(u.searchParams.get('offset'));
    if (s.processing || s.done || off !== s.offset) return this.answer(409, { error: 'x', code: 'offset_mismatch', ...view(s) });
    if (srv.silent > 0) {
      srv.silent--;
      return this.fail(); // nothing answered (the core never saw it)
    }
    if (srv.diskFull > 0) {
      srv.diskFull--;
      return this.answer(507, { error: 'Spazio su disco esaurito sulla fonte', code: 'disk_full' });
    }
    if (srv.fail > 0) {
      srv.fail--;
      return this.answer(503, { error: 'Fonte non raggiungibile' });
    }
    if (srv.drop > 0) {
      srv.drop--;
      const half = bytes.subarray(0, bytes.length >> 1);
      s.data.push(Buffer.from(half));
      s.offset += half.length;
      this.upload.onprogress?.({ lengthComputable: true, loaded: half.length, total: bytes.length });
      return this.fail();
    }
    s.data.push(Buffer.from(bytes));
    s.offset += bytes.length;
    this.upload.onprogress?.({ lengthComputable: true, loaded: bytes.length, total: bytes.length });
    this.upload.onload?.();
    if (s.offset < s.size) return this.answer(200, { offset: s.offset });
    s.processing = true;
    const all = Buffer.concat(s.data);
    await new Promise((r) => setTimeout(r, srv.pipelineMs));
    const r = resultFor(s.name, all);
    Object.assign(s, { processing: false, done: true, result: r.body });
    return this.answer(200, { offset: s.offset, done: true, result: r.body });
  }
}
globalThis.XMLHttpRequest = FakeXHR;

const fetchLog = [];
const nativeFiles = new Map(); // id -> bytes (a file of the app's folder picker)
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url), 'http://127.0.0.1:47123');
  const method = (init.method || 'GET').toUpperCase();
  fetchLog.push(`${method} ${u.pathname}${u.search}${init.headers?.Range ? ` [${init.headers.Range}]` : ''}`);
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
  if (u.pathname === '/local/sources') return json({ sources: [{ id: A, name: 'Mi A2', principal: true, connected: true, rttMs: 50, throughputKbps: null, lastError: null, addedAt: 1, role: srv.role, named: true, social: srv.social }] });
  const nf = /^\/__native\/file\/(.+)$/.exec(u.pathname);
  if (nf) {
    const b = nativeFiles.get(decodeURIComponent(nf[1]));
    if (!b) return new Response('', { status: 404 });
    const r = /^bytes=(\d+)-(\d+)$/.exec(init.headers?.Range || '');
    if (!r) return new Response(b, { status: 200 });
    return new Response(b.subarray(Number(r[1]), Number(r[2]) + 1), { status: 206 });
  }
  const m = /^\/s\/[^/]+\/api(\/[^?]*)$/.exec(u.pathname);
  if (!m) return json({});
  const p = m[1];
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
  const lp = /^\/lyrics\/([^/]+)$/.exec(p);
  if (lp && method === 'PUT') {
    const text = init.body instanceof Blob ? await init.body.text() : String(init.body || '');
    srv.lyrics.push({ trackId: lp[1], beside: u.searchParams.get('beside') === '1', text, type: init.headers?.['Content-Type'] || '' });
    return json({ trackId: lp[1], kind: 'synced', lines: [{ t: 1000, text: 'riga' }], from: 'lrc' });
  }
  if (p === '/health') return json(srv.role ? { ok: true, tracks: 0, archives: srv.archives } : { ok: true, tracks: 0 });
  if (p === '/library') return json({ version: 1, userVersion: 1, tracks: [], playlists: [], likes: [], recents: [], covers: {}, you: srv.role ? { profileId: 'me', role: srv.role } : undefined });
  if (p === '/uploads' && method === 'POST') {
    if (srv.createFail > 0) {
      srv.createFail--;
      return json({ error: 'Fonte non raggiungibile', code: 'unreachable' }, 503);
    }
    const mine = [...srv.sessions.values()].filter((s) => !s.done);
    const again = mine.find((s) => s.name === body.name && s.size === body.size && s.headHash === body.headHash);
    if (again) return json({ id: again.id, size: again.size, offset: again.offset, chunkBytes: srv.chunk || 1048576, expiresAt: 0 });
    if (mine.length >= srv.maxSessions) return json({ error: 'x', code: 'too_many_uploads' }, 429);
    const s = { id: nid(), name: body.name, size: body.size, lastModified: body.lastModified, headHash: body.headHash, offset: 0, data: [], processing: false, done: false, result: null, updatedAt: Date.now() };
    srv.sessions.set(s.id, s);
    return json({ id: s.id, size: s.size, offset: 0, chunkBytes: srv.chunk || 1048576, expiresAt: 0 }, 201);
  }
  if (p === '/uploads' && method === 'GET') return json({ sessions: [...srv.sessions.values()].filter((s) => !s.done).map((s) => ({ id: s.id, name: s.name, size: s.size, lastModified: s.lastModified, offset: s.offset, updatedAt: s.updatedAt })) });
  let x = /^\/uploads\/([^/]+)$/.exec(p);
  if (x) {
    const s = srv.sessions.get(x[1]);
    if (!s) return json({ error: 'x', code: 'session_gone' }, 404);
    if (method === 'DELETE') {
      srv.sessions.delete(s.id);
      return json({ ok: true });
    }
    return json(view(s));
  }
  x = /^\/pending\/([^/]+)$/.exec(p);
  if (x) {
    const pd = srv.pending.get(x[1]);
    if (!pd) return json({ error: 'x', code: 'pending_gone' }, 404);
    srv.pending.delete(x[1]);
    return json(body.keep === 'best' ? { outcome: 'duplicate', duplicate: true, track: pd.track } : { outcome: 'added', duplicate: false, track: pd.track });
  }
  x = /^\/archives\/([^/]+)$/.exec(p);
  if (x) {
    const a = srv.archives2.get(x[1]);
    a.step++;
    const total = 3;
    const done = Math.min(total, Math.max(0, a.step - 2));
    const state = a.step === 1 ? 'checking' : done < total ? 'importing' : 'done';
    const counts = a.dup ? { added: 0, replaced: 0, duplicates: done, ignored: 0 } : { added: Math.max(0, done - 1), replaced: done >= 3 ? 1 : 0, duplicates: 0, ignored: done >= 3 ? 1 : 0 };
    if (!a.dup && done >= 3) counts.added = 2;
    return json({ id: a.id, name: a.name, state, total: a.step === 1 ? 0 : total, done, ...counts, pending: [], trackIds: [], coverId: null, error: null, code: null });
  }
  return json({});
};

const imp = (p) => import(pathToFileURL(path.join(web, p)).href);
const { sources } = await imp('js/sources.js');
const { store } = await imp('js/store.js');
const up = await imp('js/upload.js');
const { uploads, stateText, hintFor } = up;
const barOf = up.barOf || (() => NaN);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, name, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);
  if (!ok) failures++;
};
const file = (name, size, seed = 1) => {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i++) b[i] = (i * 31 + seed * 7) & 255;
  const ext = (/.([^.]+)$/.exec(name)?.[1] || '').toLowerCase();
  const type = { zip: 'application/zip', mp3: 'audio/mpeg', flac: 'audio/flac', jpg: 'image/jpeg', txt: 'text/plain' }[ext] || 'application/octet-stream';
  return new File([b], name, { type, lastModified: 1000 + seed });
};
/** Waits until no job of these is on its way; records the row texts seen meanwhile. */
async function settle(jobs, ms = 8000) {
  const seen = jobs.map(() => []);
  const t0 = Date.now();
  for (;;) {
    jobs.forEach((j, i) => {
      const t = stateText(j);
      if (seen[i][seen[i].length - 1] !== t) seen[i].push(t);
    });
    if (jobs.every((j) => !['waiting', 'uploading', 'paused', 'processing', 'extracting', 'choosing'].includes(j.state))) break;
    if (Date.now() - t0 > ms) break;
    await sleep(5);
  }
  return seen;
}
const newJobs = (n) => uploads.jobs.slice(-n);

uploads.configure({ singleMax: 1048576, retry: [20, 40, 80], failLimit: 400, slowLast: 150, poll: 40, archiveOpen: 30, archiveClosed: 30 });
await sources.refresh();
await store.refresh();

// ===== outcomes in one PUT =====
uploads.add([file('Nuovo.mp3', 3000, 1), file('Vecchio dup.mp3', 3000, 2), file('Brano [hq].mp3', 3000, 3)]);
let jobs = newJobs(3);
check(jobs.every((j) => j.state === 'waiting' || j.state === 'uploading'), 'three files queued', jobs.map((j) => j.state).join(','));
await settle(jobs);
check(jobs.map(stateText).join('|') === 'Caricato|Già presente|Sostituito con una versione migliore', 'outcome texts: added, already there, replaced by a better version', jobs.map(stateText).join('|'));
check(srv.log.filter((l) => l.startsWith('PUT /s/') && l.includes('/upload/')).length === 3, 'files up to the limit go in one PUT each');
const setUp = calls.filter((c) => c.name === 'setUploading').map((c) => c.args[0]);
check(setUp.join(',') === 'true,false', 'setUploading: "true" when the queue starts, "false" when it empties', setUp.join(','));
check(toasts.includes('Caricati 2 brani'), 'end of the batch with the sheet closed: "Caricati 2 brani" (added and replaced)', toasts.join(' | '));

// ===== the "maybe" choice =====
const t0 = toasts.length;
uploads.add([file('Uno [forse].mp3', 3000, 41), file('Due [forse].mp3', 3000, 42), file('Tre [forse].mp3', 3000, 43)]);
jobs = newJobs(3);
await settle(jobs);
const choiceToasts = toasts.slice(t0).filter((t) => t.startsWith('Serve una scelta'));
check(jobs.every((j) => j.state === 'maybe') && choiceToasts.length === 1, 'three choices with the sheet closed: one "Serve una scelta" toast, not three', `${choiceToasts.length} toasts; ${jobs.map((j) => j.state).join(',')}`);
for (const j of jobs) await uploads.choose(j, 'both');
uploads.add([file('Simile [forse].mp3', 3000, 4)]);
[jobs[0]] = newJobs(1);
await settle([jobs[0]]);
check(jobs[0].state === 'maybe' && jobs[0].pending?.match?.title === 'Il brano vero', 'a maybe waits for the choice', jobs[0].state);
check(toasts[toasts.length - 1] === 'Serve una scelta' || toasts.some((t) => t.startsWith('Serve una scelta')), 'with the sheet closed: "Serve una scelta" with "Apri"', toasts.slice(-2).join(' | '));
await uploads.choose(jobs[0], 'best');
check(stateText(jobs[0]) === 'Già presente', 'keeping the better version: "Già presente"', stateText(jobs[0]));
uploads.add([file('Altro [forse].mp3', 3000, 5)]);
[jobs[0]] = newJobs(1);
await settle([jobs[0]]);
await uploads.choose(jobs[0], 'both');
check(stateText(jobs[0]) === 'Caricato', 'keeping both: "Caricato"', stateText(jobs[0]));

// ===== archives =====
uploads.setSheetOpen(true);
uploads.add([file('Album.zip', 4000, 6)]);
[jobs[0]] = newJobs(1);
const bars = [];
const sampler = setInterval(() => bars.push([jobs[0].state, jobs[0].archive?.total || 0, barOf(jobs[0])]), 2);
let seen = await settle([jobs[0]]);
clearInterval(sampler);
const extr = bars.filter((b) => b[0] === 'extracting');
const backwards = extr.some((b, i) => i > 0 && b[2] < extr[i - 1][2]);
check(extr.length > 0 && extr.filter((b) => !b[1]).every((b) => b[2] === 0) && !backwards && bars[bars.length - 1][2] === 1, "an archive's bar: the extraction starts from empty (pulsing until the count is known) and never runs back", extr.map((b) => `${b[1]}:${Number(b[2]).toFixed(2)}`).join(' '));
check(seen[0].includes('Estrazione...') && seen[0].includes('Estrazione 1 di 3') && seen[0].includes('Estrazione 2 di 3'), 'an archive: "Estrazione..." then "Estrazione 1 di 3", "2 di 3"', seen[0].join(' > '));
check(stateText(jobs[0]) === '3 brani caricati, 1 file ignorato', 'its summary: "3 brani caricati, 1 file ignorato" (added and replaced)', stateText(jobs[0]));
uploads.add([file('Album gia.zip', 4000, 7)]);
[jobs[0]] = newJobs(1);
await settle([jobs[0]]);
check(stateText(jobs[0]) === 'Già presente', 'an album already there: "Già presente"', stateText(jobs[0]));
uploads.setSheetOpen(false);

// ===== sessions: a drop halfway, then on =====
srv.drop = 1;
const big = file('Lungo.flac', 3 * 1048576 + 12345, 8);
uploads.add([big]);
[jobs[0]] = newJobs(1);
seen = await settle([jobs[0]]);
const sent = srv.stored.get('Lungo.flac');
const orig = Buffer.from(await big.arrayBuffer());
check(stateText(jobs[0]) === 'Caricato' && sent && Buffer.compare(sent, orig) === 0, 'a chunk cut halfway: it pauses, asks the offset and goes on; the file arrives whole, nothing doubled', `${seen[0].join(' > ')}; ${sent?.length} of ${orig.length}`);
check(seen[0].includes('In pausa'), 'the row says "In pausa" meanwhile');
const puts = srv.log.filter((l) => l.startsWith('PUT') && l.includes('/uploads/'));
check(puts.some((l) => /offset=1572864/.test(l)), 'the next chunk starts at the bytes that arrived (half of the second)', puts.join(', '));

// ===== a full disk on a chunk: said at once, no pause, the session given back =====
srv.diskFull = 1;
const fd0 = fetchLog.length;
uploads.add([file('Pieno.flac', 2 * 1048576 + 7, 30)]);
[jobs[0]] = newJobs(1);
seen = await settle([jobs[0]]);
const fdDel = fetchLog.slice(fd0).filter((l) => l.startsWith('DELETE') && l.includes('/uploads/'));
check(stateText(jobs[0]) === 'Spazio esaurito su Mi A2' && !seen[0].includes('In pausa'), 'a chunk refused for a full disk: "Spazio esaurito su Mi A2" at once, never "In pausa"', seen[0].join(' > '));
check(fdDel.length === 1, 'and its session is cancelled (its bytes and the room it holds go back to the source)', fdDel.join(','));
srv.diskFull = 0;

// ===== the last chunk takes its time: the session is asked until it is done =====
srv.pipelineMs = 700;
const fetches0 = fetchLog.length;
uploads.add([file('Lento.flac', 2 * 1048576 + 100, 9)]);
[jobs[0]] = newJobs(1);
seen = await settle([jobs[0]]);
const polls = fetchLog.slice(fetches0).filter((l) => /^GET \/s\/[^/]+\/api\/uploads\/[0-9a-f]+$/.test(l)).length;
const atEnd = srv.log.filter((l) => l.startsWith('PUT') && l.includes('/uploads/') && l.endsWith(`offset=${2 * 1048576 + 100}`)).length;
check(stateText(jobs[0]) === 'Caricato' && polls >= 2 && seen[0].includes('Caricamento 100%'), 'a slow last chunk: "Caricamento 100%" while the session is asked until done', `${polls} polls; ${seen[0].join(' > ')}`);
check(atEnd === 0, 'never a PUT at offset == size', `${atEnd}`);
srv.pipelineMs = 0;

// ===== too many uploads =====
const stale1 = { id: 'stale000000000001', name: 'a.mp3', size: 9e6, headHash: 'x', offset: 10, data: [], processing: false, done: false, updatedAt: 1000 };
const stale2 = { id: 'stale000000000002', name: 'b.mp3', size: 9e6, headHash: 'y', offset: 10, data: [], processing: false, done: false, updatedAt: 500 };
srv.sessions.set(stale1.id, stale1);
srv.sessions.set(stale2.id, stale2);
srv.maxSessions = 2;
const f0 = fetchLog.length;
uploads.add([file('Dopo.flac', 1048576 + 10, 10)]);
[jobs[0]] = newJobs(1);
await settle([jobs[0]]);
const dels = fetchLog.slice(f0).filter((l) => l.startsWith('DELETE'));
check(stateText(jobs[0]) === 'Caricato' && dels.join(',') === `DELETE /s/${A}/api/uploads/${stale2.id},DELETE /s/${A}/api/uploads/${stale1.id}`, 'too many uploads: the stale sessions not in the queue are cancelled, oldest first, and it goes on', dels.join(','));
// Three files, two at a time: the third one has an older session, kept for it while it waits.
srv.sessions.clear();
const cFile = file('Terzo.flac', 1048576 + 30, 33);
const cBytes = Buffer.from(await cFile.arrayBuffer());
const staleC = { id: 'stale00000000000c', name: 'Terzo.flac', size: cFile.size, lastModified: cFile.lastModified, headHash: crypto.createHash('sha256').update(cBytes.subarray(0, 65536)).digest('hex'), offset: 0, data: [], processing: false, done: false, updatedAt: 200 };
const staleX = { id: 'stale00000000000x', name: 'altro.flac', size: 9e6, lastModified: 3, headHash: 'z', offset: 10, data: [], processing: false, done: false, updatedAt: 100 };
srv.sessions.set(staleX.id, staleX);
srv.sessions.set(staleC.id, staleC);
srv.maxSessions = 3;
const q0 = fetchLog.length;
uploads.add([file('Primo.flac', 1048576 + 10, 31), file('Secondo.flac', 1048576 + 20, 32), cFile]);
jobs = newJobs(3);
await settle(jobs, 10000);
const qDels = fetchLog.slice(q0).filter((l) => l.startsWith('DELETE'));
check(jobs.every((j) => stateText(j) === 'Caricato') && jobs[2].sessionId === staleC.id && qDels.join(',') === `DELETE /s/${A}/api/uploads/${staleX.id}`, 'too many uploads: a session of a file still waiting in the queue is kept (it resumes it), only the others go', `${jobs.map(stateText).join(',')}; third ${jobs[2].sessionId}; ${qDels.join(',')}`);
srv.maxSessions = 0;
uploads.add([file('Troppi.flac', 1048576 + 10, 11)]);
[jobs[0]] = newJobs(1);
await settle([jobs[0]]);
check(stateText(jobs[0]) === 'Troppi caricamenti in corso', 'asked once more and still too many: "Troppi caricamenti in corso"', stateText(jobs[0]));
srv.maxSessions = 4;

// ===== only failures the core answered count =====
srv.silent = 30; // nobody answers for a while (longer than the limit of 400 ms here)
uploads.add([file('Sonno.flac', 1048576 + 10, 12)]);
[jobs[0]] = newJobs(1);
seen = await settle([jobs[0]], 10000);
check(stateText(jobs[0]) === 'Caricato', 'requests nobody answered do not count: it finishes after the long silence', seen[0].join(' > '));
srv.fail = 40; // the core answers 503 every time
uploads.add([file('Rotto.flac', 1048576 + 10, 13)]);
[jobs[0]] = newJobs(1);
await settle([jobs[0]], 10000);
check(stateText(jobs[0]) === 'Caricamento non riuscito', 'answered failures for longer than the limit: "Caricamento non riuscito"', stateText(jobs[0]));
srv.fail = 0;
sources.markUp(A); // its 503s marked it down for a while: it answers again

// ===== a source without profiles =====
srv.role = null;
await sources.refresh();
await sources.loadHealth({ force: true });
await sleep(400); // a refresh still on its way from the uploads before
await store.refresh();
await store.refresh();
const l0 = srv.log.length;
const f1 = fetchLog.length;
uploads.add([file('Vecchia fonte.flac', 2 * 1048576, 14), file('Album vecchio.zip', 2000, 15)]);
jobs = newJobs(2);
await settle(jobs);
const singlePut = srv.log.slice(l0).filter((l) => l.includes('/upload/'));
check(stateText(jobs[0]) === 'Caricato' && singlePut.length === 1 && singlePut[0].includes('Vecchia') && !fetchLog.slice(f1).some((l) => l.startsWith('POST') && l.includes('/uploads')), 'no profiles there: every file in one PUT, no session', singlePut.join(','));
check(stateText(jobs[1]) === 'Formato non supportato', 'and no archives: "Formato non supportato"', stateText(jobs[1]));
{
  const keep = sources.healthOf;
  sources.healthOf = () => null;
  const h0 = hintFor(A);
  sources.healthOf = keep;
  check(h0 === 'Brani fino a 600 MB.', 'its library says it has no profiles: the hint of a source without archives even before its health', JSON.stringify(h0));
}
srv.role = 'owner';
await sources.refresh();
await sources.loadHealth({ force: true });
await sleep(300); // a library refresh still on its way from the uploads before
await store.refresh();
await store.refresh();

// ===== limits =====
const huge = { name: 'Enorme.flac', size: 700 * 1048576, type: 'audio/flac', lastModified: 1, slice: () => new Blob([]) };
uploads.add([huge]);
[jobs[0]] = newJobs(1);
await settle([jobs[0]]);
check(stateText(jobs[0]) === 'File troppo grande', 'a song over 600 MB: "File troppo grande"', stateText(jobs[0]));
srv.archives.sevenZip = false;
await sources.loadHealth({ force: true });
uploads.add([file('Album.7z', 2000, 16)]);
[jobs[0]] = newJobs(1);
await settle([jobs[0]]);
check(stateText(jobs[0]) === 'Formato non supportato', 'a 7z where 7-Zip is missing: "Formato non supportato"', stateText(jobs[0]));
srv.archives.sevenZip = true;
await sources.loadHealth({ force: true });

// ===== a folder (relative paths): audio and archives go, the rest stays out quietly =====
const inFolder = (name, size, seed) => {
  const f = file(name, size, seed);
  Object.defineProperty(f, 'webkitRelativePath', { value: `Album/${name}` });
  return f;
};
const n0 = uploads.jobs.length;
uploads.add([inFolder('01 Uno.flac', 2000, 17), inFolder('note.txt', 20, 18), inFolder('album.cue', 20, 19), inFolder('cover.jpg', 200, 20)]);
const added = uploads.jobs.slice(n0);
await settle(added);
check(added.length === 1 && added[0].relPath === 'Album/01 Uno.flac' && stateText(added[0]) === 'Caricato' && uploads.images.some((i) => i.name === 'cover.jpg'), 'a folder: its song uploads, text files are left out without a row, the cover is kept for the offer', added.map((j) => `${j.relPath}:${stateText(j)}`).join(','));

// A folder with no image named as a cover: none is offered (not the back, not the booklet).
uploads.clearFinished();
uploads.add([inFolder('01 Tre.flac', 2100, 21), inFolder('back.jpg', 200, 22), inFolder('booklet-01.png', 200, 23)]);
await settle(uploads.jobs.slice(-1));
const folderOffers = uploads.coverOffers().map((o) => o.image.name);
check(uploads.images.length === 2 && folderOffers.length === 0, 'a folder without cover, folder or front: no image is offered as the cover', folderOffers.join(','));
uploads.clearFinished();
uploads.add([file('Quattro.mp3', 2200, 24), file('scansione.jpg', 200, 25)]);
await settle(uploads.jobs.slice(-1));
const handOffers = uploads.coverOffers().map((o) => o.image.name);
check(handOffers.join(',') === 'scansione.jpg', 'an image picked by hand with the songs is offered, whatever its name', handOffers.join(','));
uploads.clearFinished();

// ===== the app's folder picker: files streamed in, read with Range requests =====
const nb = Buffer.alloc(1048576 + 4096, 3);
nativeFiles.set('nf1', nb);
check(uploads.pickFolder() === true, 'the app opens its folder picker');
window.__mpfyNative({ type: 'folder', requestId: 'fold0001fold0001', state: 'files', files: [{ id: 'nf1', name: '02 Due.flac', relPath: 'Album/02 Due.flac', size: nb.length, mime: 'audio/flac', lastModified: 5 }] });
window.__mpfyNative({ type: 'folder', requestId: 'fold0001fold0001', state: 'done', folderName: 'Album', count: 1 });
[jobs[0]] = newJobs(1);
await settle([jobs[0]]);
const ranges = fetchLog.filter((l) => l.startsWith('GET /__native/file/nf1 ['));
check(stateText(jobs[0]) === 'Caricato' && Buffer.compare(srv.stored.get('02 Due.flac') || Buffer.alloc(0), nb) === 0 && ranges.length >= 2, 'an app file: read in Range requests on /__native/file/<id>, it arrives whole', ranges.join(', '));
await sleep(20);
check(calls.some((c) => c.name === 'releaseFolder' && c.args[0] === 'fold0001fold0001'), 'and the folder is released when its uploads are over');

// ===== an .lrc beside its song in a folder: the lyrics of that track, once its upload answered =====
{
  const inDir = (f, dir) => {
    Object.defineProperty(f, 'webkitRelativePath', { value: `${dir}/${f.name}` });
    return f;
  };
  const lrcIn = (dir, name, text) => inDir(new File([text], name, { type: 'application/octet-stream', lastModified: 7 }), dir);
  const LRC = '[00:01.00]Prima riga inventata\n[00:05.50]seconda riga inventata\n';
  uploads.clearFinished();
  srv.lyrics.length = 0;
  const n1 = uploads.jobs.length;
  uploads.add([
    lrcIn('Dischi/Uno', '01 Mare.LRC', LRC),
    inDir(file('01 Mare.flac', 2300, 31), 'Dischi/Uno'),
    inDir(file('02 Vento.flac', 2400, 32), 'Dischi/Uno'),
    lrcIn('Dischi/Due', '02 Vento.lrc', '[00:02]di un altra cartella'),
    lrcIn('Dischi/Uno', 'dup 03 Sale.lrc', 'una riga ferma senza tempo'),
    inDir(file('dup 03 Sale.mp3', 2500, 33), 'Dischi/Uno'),
  ]);
  const got = uploads.jobs.slice(n1);
  await settle(got);
  await sleep(50);
  const idOf = (name) => got.find((j) => j.name === name)?.track?.id;
  const sent = srv.lyrics.map((l) => `${l.trackId}:${l.beside}`).sort().join(',');
  const want = [`${idOf('01 Mare.flac')}:true`, `${idOf('dup 03 Sale.mp3')}:true`].sort().join(',');
  check(got.length === 3 && got.every((j) => !/\.lrc$/i.test(j.name)), 'a folder with .lrc files: no row for them, the songs upload', got.map((j) => `${j.name}:${stateText(j)}`).join(','));
  check(sent === want && srv.lyrics.length === 2, "each .lrc goes to its own song's track (any case, a song already there too) with beside=1; one of another folder goes nowhere", JSON.stringify(srv.lyrics.map((l) => [l.trackId, l.beside])));
  const mare = srv.lyrics.find((l) => l.trackId === idOf('01 Mare.flac'));
  check(!!mare && mare.text === LRC && /^text\/plain; charset=utf-8$/.test(mare.type), 'as the text of the file, text/plain in UTF-8', JSON.stringify(mare && mare.type));

  // The app's folder picker: the song answered first, its .lrc comes in a later batch.
  srv.lyrics.length = 0;
  uploads.clearFinished();
  const ab = Buffer.alloc(3000, 5);
  nativeFiles.set('nf2', ab);
  nativeFiles.set('nf3', Buffer.from('[00:03.10]una riga dal telefono\n'));
  check(uploads.pickFolder() === true, 'the folder picker again');
  window.__mpfyNative({ type: 'folder', requestId: 'fold0001fold0001', state: 'files', files: [{ id: 'nf2', name: '04 Faro.flac', relPath: 'Telefono/04 Faro.flac', size: ab.length, mime: 'audio/flac', lastModified: 9 }] });
  const [fj] = newJobs(1);
  await settle([fj]);
  window.__mpfyNative({ type: 'folder', requestId: 'fold0001fold0001', state: 'files', files: [{ id: 'nf3', name: '04 faro.lrc', relPath: 'Telefono/04 faro.lrc', size: 33, mime: 'application/octet-stream', lastModified: 9 }] });
  window.__mpfyNative({ type: 'folder', requestId: 'fold0001fold0001', state: 'done', folderName: 'Telefono', count: 2 });
  await sleep(100);
  check(srv.lyrics.length === 1 && srv.lyrics[0].trackId === fj.track?.id && srv.lyrics[0].text.includes('una riga dal telefono') && fetchLog.some((l) => l.startsWith('GET /__native/file/nf3')), 'an .lrc that comes after its song answered: read from the app at once and sent to that track', JSON.stringify(srv.lyrics));

  // A source that does not speak the songs part gets no lyrics.
  srv.lyrics.length = 0;
  uploads.clearFinished();
  srv.social = 2;
  await sources.refresh();
  const n2 = uploads.jobs.length;
  uploads.add([lrcIn('Dischi/Tre', '05 Onda.lrc', LRC), inDir(file('05 Onda.flac', 2600, 34), 'Dischi/Tre')]);
  await settle(uploads.jobs.slice(n2));
  await sleep(50);
  check(srv.lyrics.length === 0, 'a source below the songs part: the song uploads, its .lrc goes nowhere');
  srv.social = 3;
  await sources.refresh();
  uploads.clearFinished();
}

// ===== the hint follows what the source takes =====
const health = (a) => {
  sources.healthOf = () => (a ? { archives: a } : { tracks: 1 });
  return hintFor(A);
};
const realHealth = sources.healthOf;
const hints = [health({ zip: true, sevenZip: true, rar: true }), health({ zip: true, sevenZip: true, rar: false }), health({ zip: true, sevenZip: false, rar: false }), health(null)];
sources.healthOf = () => null;
const unknownHint = hintFor(A);
sources.healthOf = realHealth;
check(unknownHint === '', 'before the health of a source with profiles is known, no hint (never the line of a source without archives)', JSON.stringify(unknownHint));
check(hints.join('|') === 'Brani fino a 600 MB, archivi ZIP, 7z e RAR fino a 4 GB.|Brani fino a 600 MB, archivi ZIP e 7z fino a 4 GB.|Brani fino a 600 MB, archivi ZIP fino a 4 GB.|Brani fino a 600 MB.', 'the sheet hint follows the source\'s archives', hints.join(' | '));

// ===== the screen off: no animation frames, setUploading still follows the queue =====
{
  const raf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = () => 0; // a hidden page: frames never come
  document.hidden = true;
  const c0 = calls.length;
  uploads.add([file('Al buio.mp3', 3000, 40)]);
  [jobs[0]] = newJobs(1);
  await settle([jobs[0]]);
  await sleep(30);
  const said = calls.slice(c0).filter((c) => c.name === 'setUploading').map((c) => c.args[0]);
  check(stateText(jobs[0]) === 'Caricato' && said.join(',') === 'true,false', 'page hidden (no animation frames): setUploading "true", then "false" when the queue empties', said.join(','));
  globalThis.requestAnimationFrame = raf;
  document.hidden = false;
}

// ===== a link that drops before the bytes go: the upload waits for the source =====
{
  srv.createFail = 3; // the session cannot be made for a moment (a permission dialog, a network switch)
  uploads.add([file('Dialogo.flac', 1048576 + 10, 41)]);
  [jobs[0]] = newJobs(1);
  const seenC = await settle([jobs[0]], 10000);
  check(stateText(jobs[0]) === 'Caricato' && seenC[0].includes('In pausa') && srv.createFail === 0, 'the session cannot be made for a moment: "In pausa", then it goes on by itself', seenC[0].join(' > '));
  sources.markUp(A);

  srv.singleSilent = 2; // a small file whose PUT gets no answer twice
  const p0 = srv.log.length;
  uploads.add([file('Piccolo.mp3', 3000, 42)]);
  [jobs[0]] = newJobs(1);
  await settle([jobs[0]], 10000);
  const singles = srv.log.slice(p0).filter((l) => l.includes('/upload/'));
  check(stateText(jobs[0]) === 'Caricato' && singles.length === 3, 'a small file nobody answered: sent again until it arrives', singles.length + ' PUTs');

  srv.createFail = 100000; // the source stays away for longer than the limit
  uploads.add([file('Lontano.flac', 1048576 + 10, 43)]);
  [jobs[0]] = newJobs(1);
  await settle([jobs[0]], 10000);
  check(stateText(jobs[0]) === 'Fonte non raggiungibile' && uploads.canRetry(jobs[0]), 'away for longer than the limit: "Fonte non raggiungibile", and it can be tried again', stateText(jobs[0]));
  srv.createFail = 0;
  sources.markUp(A);
  uploads.retry(jobs[0]);
  await settle([jobs[0]], 10000);
  check(stateText(jobs[0]) === 'Caricato', 'tried again once the source is back: "Caricato"', stateText(jobs[0]));
  sources.markUp(A);
}

console.log(`failures=${failures}`);
process.exit(failures ? 1 : 0);
