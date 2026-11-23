// Uploads ("Carica brani"): files, whole folders and archives (ZIP, 7z, RAR) to the source chosen
// in "Carica su" (default the principal), two at a time. Jobs survive closing the sheet; the
// sheet only shows them.
//   - Up to 32 MB: one PUT /api/upload/:filename (XHR, real progress).
//   - Bigger: a resumable session in chunks (8 MB). A failed chunk pauses ("In pausa"), waits 1,
//     2, 4, 8, 15, 15... s, asks the source where it got to and goes on; after 10 minutes of
//     failures the core answered, "Caricamento non riuscito". A request the core never answered
//     (the app asleep) does not count toward those minutes.
//   - The last chunk: when it fails, or its answer takes more than 30 s once its bytes are out,
//     the session is asked every 2 s until it is done (the source goes on without the request).
//     A 409 on the session carries its state: a chunk is never sent again at the end.
//   - Too many sessions: the person's own sessions that are not in this queue are cancelled,
//     oldest first, and the session is asked once more.
//   - A source without profiles gets every file in one PUT, and no archives.
// The source says what happened: added, already there, replaced by a better version, a "maybe"
// (asked inline: the better one, or both), or an archive, followed while it is extracted until
// its summary; its own "maybe" entries are asked one after the other.
//
// Files come from the system picker, a folder (the app's folder picker, or webkitdirectory in a
// browser), or a drop on the window. In the app a folder's files are read with Range requests on
// their /__native/file/<id> URL. An image picked with the songs (cover.jpg next to an album) is
// not uploaded: once the batch is done it is offered as the cover of the uploaded albums that
// have none. An .lrc in a folder ("Brano.lrc" beside "Brano.mp3", the same name in any case) is
// not uploaded either: once its song's upload answered with a trackId (new or already there) it
// goes to that track as its lyrics (PUT /api/lyrics/<trackId>?beside=1: kept only when the track
// has no synced lyrics), on a source that speaks the songs part.

import { store } from './store.js';
import { sources } from './sources.js';
import { srcApi, uploadPath, chunkPath, errorText as apiErrorText } from './api.js';
import { wordsFor } from './words.js';
import { nativeCall, onNative } from './native.js';
import { hashId } from './util.js';
import { toast } from '../components/toast.js';

export const ACCEPT = 'audio/*,.mp3,.m4a,.flac,.ogg,.opus,.wav,.zip,.7z,.rar,application/zip,application/x-7z-compressed,application/vnd.rar,application/x-rar-compressed,image/jpeg,image/png,image/webp';
const AUDIO_EXT = /\.(mp3|m4a|mp4|aac|flac|ogg|oga|opus|wav|wave)$/i;
const ARCHIVE_EXT = /\.(zip|7z|rar)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;
const LRC_EXT = /\.lrc$/i;
const LRC_MAX_BYTES = 65536;
const MAX_PARALLEL = 2;
const MAX_AUDIO = 600 * 1024 * 1024;
const MAX_ARCHIVE = 4 * 1024 * 1024 * 1024;
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MiB = 1024 * 1024;

// Timings (the dev harness shortens them).
const T = {
  singleMax: 32 * MiB,
  chunkBytes: 8 * MiB,
  retry: [1000, 2000, 4000, 8000, 15000],
  failLimit: 10 * 60 * 1000,
  slowLast: 30000,
  poll: 2000,
  archiveOpen: 1000,
  archiveClosed: 5000,
};

const jobs = [];
const images = []; // { id, file, name, url }
const dismissed = new Set(); // album ids whose cover offer was answered
const listeners = new Set();
const folders = new Map(); // requestId of an app folder pick -> { done, jobs: Set }
const lrcs = new Map(); // "<source>|<folder>/<name without extension, lower case>" -> { text }: an .lrc of a folder
const besideSent = new Set(); // "<source>:<trackId>" whose .lrc went (or is on its way)
// The folder picker asked for and not answered yet. After PICK_WAIT_MS without an answer a tap
// opens one again (an answer lost on the way must not leave "Carica cartella" dead).
const PICK_WAIT_MS = 5000;
let picking = null;
let seq = 0;
let active = 0;
let emitQueued = false;
let sheetOpen = false;
let target = null; // chosen source id; null = the principal
let opener = null; // opens the sheet (the "Apri" of "Serve una scelta")
let uploadingSaid = false;
let batchStart = 0; // jobs from this index belong to the current batch
let lastBatchToast = -1;

const ACTIVE = new Set(['waiting', 'uploading', 'paused', 'processing']);
const OPEN = new Set([...ACTIVE, 'extracting', 'choosing']);

/**
 * The app keeps uploading with the screen off while it hears "true" (a foreground service). Told
 * at once on every change: a hidden page gets no animation frames, so this never waits for one.
 */
function syncUploading() {
  const busy = jobs.some((j) => ACTIVE.has(j.state));
  if (busy !== uploadingSaid) {
    uploadingSaid = busy;
    nativeCall('setUploading', busy ? 'true' : 'false');
  }
}

function emitNow() {
  emitQueued = false;
  for (const fn of listeners) fn(jobs);
  syncUploading();
}

/** Progress events are frequent: the rows are drawn again once per frame. */
function emit() {
  syncUploading();
  if (emitQueued) return;
  emitQueued = true;
  requestAnimationFrame(emitNow);
}

const nameOf = (f) => f.name || '';
const isArchive = (f) => ARCHIVE_EXT.test(nameOf(f));
const isAudio = (f) => !isArchive(f) && (AUDIO_EXT.test(nameOf(f)) || /^audio\//.test(f.type || f.mime || ''));
const isImage = (f) => IMAGE_EXT.test(nameOf(f)) || /^image\/(jpeg|png|webp)$/.test(f.type || f.mime || '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function currentTarget() {
  if (target && sources.get(target)) return target;
  return sources.principal()?.id || null;
}

/** What a source accepts: sessions and archives come with profiles (its health lists archives). */
async function targetInfo(src) {
  let hl = sources.healthOf(src);
  if (!hl) {
    await sources.loadHealth();
    hl = sources.healthOf(src);
  }
  const a = hl?.archives && typeof hl.archives === 'object' ? hl.archives : null;
  return { modern: !!a || store.roleOf(src) !== null, archives: a ? { zip: a.zip !== false, sevenZip: !!a.sevenZip, rar: !!a.rar } : null };
}

/** The words for a failure: the source's code, else its status, else "Caricamento non riuscito". */
function failWords(job, status, data) {
  const name = sources.name(job.target);
  const w = wordsFor(data?.code, name);
  if (w) return w;
  return apiErrorText({ status, src: job.target, raw: typeof data?.error === 'string' ? data.error : '' }, 'Caricamento non riuscito');
}

// ---- bytes ----

/** The bytes [a, b) of a job's file: a slice of the File, or a Range read of an app file. */
async function readBytes(job, a, b) {
  if (!job.nativeFile) return job.file.slice(a, b);
  const res = await fetch(job.nativeFile.url, { headers: { Range: `bytes=${a}-${b - 1}` }, cache: 'no-store' });
  if (!res.ok) throw new Error('read');
  const blob = await res.blob();
  if (res.status === 206 || (a === 0 && blob.size === b)) return blob;
  return blob.slice(a, b);
}

async function sha256Hex(blob) {
  const buf = await new Response(blob).arrayBuffer();
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  let out = '';
  for (const x of d) out += x.toString(16).padStart(2, '0');
  return out;
}

/**
 * One XHR. Resolves { status, data } (status 0 when nothing answered). onSent: every byte went
 * out (from then on the source is working on it).
 */
function send(job, method, url, body, { onProgress, onSent, contentType } = {}) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    job.xhr = xhr;
    xhr.open(method, url);
    if (contentType) xhr.setRequestHeader('Content-Type', contentType);
    if (xhr.upload) {
      xhr.upload.onprogress = (e) => onProgress?.(e.loaded, e.total);
      xhr.upload.onload = () => onSent?.();
    }
    const end = (status) => {
      if (job.xhr === xhr) job.xhr = null;
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* no JSON */
      }
      resolve({ status, data });
    };
    xhr.onload = () => end(xhr.status);
    xhr.onerror = () => end(0);
    xhr.onabort = () => end(0);
    xhr.ontimeout = () => end(0);
    xhr.send(body);
  });
}

// ---- results ----

const plural = (n, one, many) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

/** The summary of a finished archive. */
export function archiveSummary(a) {
  const n = (a.added || 0) + (a.replaced || 0);
  if (!n && (a.duplicates || 0) > 0) return 'Già presente';
  const text = plural(n, 'brano caricato', 'brani caricati');
  return a.ignored > 0 ? `${text}, ${plural(a.ignored, 'file ignorato', 'file ignorati')}` : text;
}

/**
 * What the target takes, from its health: archives come with sources that know about them. Until
 * its health or its library says what it is, nothing (a source with profiles would otherwise be
 * said to take no archives).
 */
export function hintFor(src) {
  const hl = src ? sources.healthOf(src) : null;
  const a = hl?.archives;
  if (!hl && !(src && store.withoutProfiles(src))) return '';
  if (!a || typeof a !== 'object') return 'Brani fino a 600 MB.';
  if (a.sevenZip && a.rar) return 'Brani fino a 600 MB, archivi ZIP, 7z e RAR fino a 4 GB.';
  if (a.sevenZip) return 'Brani fino a 600 MB, archivi ZIP e 7z fino a 4 GB.';
  return 'Brani fino a 600 MB, archivi ZIP fino a 4 GB.';
}

const FULL_BAR = new Set(['done', 'duplicate', 'replaced', 'archived', 'processing', 'maybe', 'choosing']);

/**
 * How full a row's bar is (0..1): the bytes sent, then for an archive its extraction from empty
 * (pulsing until the count of its songs is known), so the bar never runs back while it extracts.
 */
export function barOf(job) {
  if (job.state === 'extracting') return job.archive?.total > 0 ? Math.min(1, (job.archive.done || 0) / job.archive.total) : 0;
  return FULL_BAR.has(job.state) ? 1 : job.progress || 0;
}

/** The words of a row. */
export function stateText(job) {
  switch (job.state) {
    case 'waiting':
      return 'In attesa';
    case 'uploading':
      return `Caricamento ${Math.floor(job.progress * 100)}%`;
    case 'processing':
      return 'Caricamento 100%';
    case 'paused':
      return 'In pausa';
    case 'done':
      return 'Caricato';
    case 'duplicate':
      return 'Già presente';
    case 'replaced':
      return 'Sostituito con una versione migliore';
    case 'extracting':
      return job.archive?.total > 0 && (job.archive.state === 'extracting' || job.archive.state === 'importing') ? `Estrazione ${job.archive.done || 0} di ${job.archive.total}` : 'Estrazione...';
    case 'archived':
      return archiveSummary(job.archive);
    case 'maybe':
    case 'choosing':
      return ''; // the question below says it
    case 'cancelled':
      return 'Annullato';
    default:
      return job.error;
  }
}

// ---- an .lrc beside its song in a folder ----
const besideKey = (src, relPath) => `${src}|${String(relPath || '').replace(/\.[^./]*$/, '').toLowerCase()}`;

/** Its text is read now: the URL of an app folder's file stops working once the folder is released. */
function keepLrc(file, to) {
  if (!to || (Number(file.size) || 0) > LRC_MAX_BYTES) return;
  const key = besideKey(to, file.relPath || file.webkitRelativePath || '');
  const entry = { text: null };
  lrcs.set(key, entry);
  const read = file.nativeFile ? fetch(file.nativeFile.url, { cache: 'no-store' }).then((res) => (res.ok ? res.text() : null)) : file.text();
  read
    .then((text) => {
      if (lrcs.get(key) !== entry || typeof text !== 'string' || !text.trim()) return;
      entry.text = text;
      // Its song may have answered already.
      const job = jobs.find((j) => j.track && j.relPath && besideKey(j.target, j.relPath) === key);
      if (job) sendBeside(job);
    })
    .catch(() => {});
}

/** The song of a folder got its trackId: the .lrc beside it goes to that track. */
async function sendBeside(job) {
  if (!job.relPath || !job.track || typeof job.track.id !== 'string') return;
  const entry = lrcs.get(besideKey(job.target, job.relPath));
  if (!entry || !entry.text) return;
  const k = `${job.target}:${job.track.id}`;
  if (besideSent.has(k) || (sources.get(job.target)?.social || 0) < 3) return;
  besideSent.add(k);
  try {
    await srcApi(job.target).putLyrics(job.track.id, entry.text, true);
    store.refreshSoon();
  } catch {
    // The song stays without them; a later folder with the same song tries again.
    besideSent.delete(k);
  }
}

function applyResult(job, r) {
  const outcome = r?.outcome || (r?.track ? (r.duplicate ? 'duplicate' : 'added') : null);
  job.progress = 1;
  if (outcome === 'added' || outcome === 'duplicate' || outcome === 'replaced') {
    job.track = r.track || null;
    job.state = outcome === 'added' ? 'done' : outcome;
    sendBeside(job);
  } else if (outcome === 'maybe' && r.pending?.id) {
    job.state = 'maybe';
    job.pending = r.pending;
    askLater(job);
  } else if (outcome === 'archive' && r.archive?.id) {
    job.state = 'extracting';
    job.archive = { id: r.archive.id, state: 'queued', total: 0, done: 0, added: 0, replaced: 0, duplicates: 0, ignored: 0, pending: [] };
    followArchive(job);
  } else {
    job.state = 'error';
    job.error = 'Caricamento non riuscito';
  }
  store.refreshSoon();
}

/** A choice is waiting and the sheet is closed: say so, with a way back to it (one toast at a time). */
let choiceToast = null;
function askLater(job) {
  if (sheetOpen || job.asked) return;
  job.asked = true;
  if (choiceToast && !choiceToast.gone) return;
  choiceToast = toast('Serve una scelta', { action: { label: 'Apri', onClick: () => opener?.() } });
}

async function followArchive(job) {
  let misses = 0;
  while (job.state === 'extracting' && !job.cancelled) {
    await sleep(sheetOpen ? T.archiveOpen : T.archiveClosed);
    let a;
    try {
      a = await srcApi(job.target).archive(job.archive.id);
      misses = 0;
    } catch (err) {
      if (err?.status === 404) {
        job.state = 'error';
        job.error = 'Caricamento non riuscito';
        break;
      }
      if (++misses > 120) {
        job.state = 'error';
        job.error = 'Caricamento non riuscito';
        break;
      }
      continue;
    }
    job.archive = { ...job.archive, ...a, pending: Array.isArray(a.pending) ? a.pending : [] };
    if (a.state === 'failed') {
      job.state = 'error';
      job.error = wordsFor(a.code, sources.name(job.target)) || 'Archivio non valido';
    } else if (a.state === 'done') {
      job.state = job.archive.pending.length ? 'maybe' : 'archived';
      if (job.state === 'maybe') askLater(job);
      store.refreshSoon();
    }
    emit();
  }
  emit();
  pump();
}

// ---- the queue ----

async function runSingle(job) {
  const since = Date.now();
  for (let tries = 0; ; tries++) {
    const body = job.nativeFile ? await readBytes(job, 0, job.size) : job.file;
    if (job.cancelled) return;
    job.state = 'uploading';
    emit();
    const r = await send(job, 'PUT', uploadPath(job.target, job.name), body, {
      contentType: job.type || 'application/octet-stream',
      onProgress: (loaded, total) => {
        if (total) {
          job.progress = loaded / total;
          emit();
        }
      },
    });
    if (job.cancelled) return;
    if (r.status >= 200 && r.status < 300) {
      applyResult(job, r.data);
      return;
    }
    if (r.status >= 502 && r.status <= 504) sources.markDown(job.target);
    // Sent again only when nothing answered: the source keeps one copy of the same file anyway.
    if (notAnswered(r.status) && Date.now() - since <= T.failLimit) {
      job.state = 'paused';
      job.progress = 0;
      emit();
      await sleep(T.retry[Math.min(tries, T.retry.length - 1)]);
      if (job.cancelled) return;
      continue;
    }
    job.state = 'error';
    job.error = notAnswered(r.status) ? 'Fonte non raggiungibile' : failWords(job, r.status, r.data);
    return;
  }
}

/** True for a failure that only says the source did not answer: the link is down, or the core gave up waiting for it. */
function notAnswered(status) {
  return !status || (status >= 502 && status <= 504);
}

/**
 * A step before the bytes go (the session): while the source does not answer, wait and try again,
 * as the chunks do. A link that drops for a moment (a permission dialog, Wi-Fi to mobile data)
 * must not end the upload.
 */
async function untilAnswered(job, step) {
  const since = Date.now();
  for (let tries = 0; ; tries++) {
    try {
      return await step();
    } catch (err) {
      if (!notAnswered(err?.status) || job.cancelled || Date.now() - since > T.failLimit) throw err;
      if (err?.status) sources.markDown(job.target);
      job.state = 'paused';
      emit();
      await sleep(T.retry[Math.min(tries, T.retry.length - 1)]);
      if (job.cancelled) throw err;
      job.state = 'uploading';
      emit();
    }
  }
}

/** POST /api/uploads; on "too many" the person's sessions outside this queue go, then once more. */
async function createSession(job, meta) {
  const api = srcApi(job.target);
  try {
    return await api.createSession(meta);
  } catch (err) {
    if (err?.code !== 'too_many_uploads') throw err;
  }
  // In the queue: the sessions its jobs hold, and those of files still waiting their turn (the
  // source resumes them by name, size and date when they start).
  const mine = new Set(jobs.map((j) => j.sessionId).filter(Boolean));
  const fileKey = (x) => [x.name, Number(x.size) || 0, Number(x.lastModified) || 0].join('|');
  const queued = new Set(jobs.filter((j) => j.target === job.target && ACTIVE.has(j.state)).map(fileKey));
  try {
    const { sessions } = await api.sessions();
    const stale = (sessions || []).filter((s) => !mine.has(s.id) && !queued.has(fileKey(s))).sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
    for (const s of stale) await api.cancelSession(s.id).catch(() => {});
  } catch {
    /* the second try decides */
  }
  return api.createSession(meta);
}

async function runSession(job) {
  const api = srcApi(job.target);
  const headHash = await sha256Hex(await readBytes(job, 0, Math.min(65536, job.size)));
  if (job.cancelled) return;
  let s;
  try {
    s = await untilAnswered(job, () => createSession(job, { name: job.name, size: job.size, lastModified: job.lastModified, headHash }));
  } catch (err) {
    if (job.cancelled) return;
    job.state = 'error';
    job.error = notAnswered(err?.status) ? 'Fonte non raggiungibile' : failWords(job, err?.status, err?.data);
    return;
  }
  job.sessionId = s.id;
  let offset = Number(s.offset) || 0;
  const chunk = Math.min(16 * MiB, Number(s.chunkBytes) || T.chunkBytes);
  let failSince = 0;
  let tries = 0;
  const progress = () => {
    job.progress = job.size ? offset / job.size : 1;
    emit();
  };
  progress();

  /** A failure: counted when the core answered; "In pausa", then the wait. False: give up. */
  const pause = async (answered) => {
    if (answered && !failSince) failSince = Date.now();
    if (failSince && Date.now() - failSince > T.failLimit) {
      job.state = 'error';
      job.error = 'Caricamento non riuscito';
      return false;
    }
    job.state = 'paused';
    emit();
    await sleep(T.retry[Math.min(tries, T.retry.length - 1)]);
    tries++;
    return !job.cancelled;
  };
  /** The session's state, from a 409 or a GET: true when it settled the job. */
  const adopt = (st) => {
    if (st.done) {
      if (st.error) {
        job.state = 'error';
        job.error = failWords(job, st.error.status, st.error);
      } else applyResult(job, st.result);
      return true;
    }
    offset = Number(st.offset) || 0;
    if (st.processing) offset = job.size;
    return false;
  };

  /** The source is working on the whole file: ask it every few seconds until it is done. */
  const waitDone = async () => {
    job.state = 'processing';
    job.progress = 1;
    emit();
    for (;;) {
      if (job.cancelled) return true;
      try {
        const st = await api.session(job.sessionId, { timeout: 10000 });
        failSince = 0;
        if (adopt(st)) return true;
        if (!st.processing && offset < job.size) return false; // the last bytes never arrived
      } catch (err) {
        if (err?.status === 404) {
          job.state = 'error';
          job.error = 'Caricamento non riuscito';
          return true;
        }
        if (err?.status && !failSince) failSince = Date.now();
        if (failSince && Date.now() - failSince > T.failLimit) {
          job.state = 'error';
          job.error = 'Caricamento non riuscito';
          return true;
        }
      }
      await sleep(T.poll);
    }
  };

  while (!job.cancelled) {
    if (offset >= job.size) {
      if (await waitDone()) return;
      continue;
    }
    job.state = 'uploading';
    progress();
    const end = Math.min(job.size, offset + chunk);
    const last = end === job.size;
    let body;
    try {
      body = await readBytes(job, offset, end);
    } catch {
      job.state = 'error';
      job.error = 'Caricamento non riuscito';
      return;
    }
    const at = offset;
    let slow = null;
    const r = await new Promise((resolve) => {
      let settled = false;
      const finish = (x) => {
        if (settled) return;
        settled = true;
        clearTimeout(slow);
        resolve(x);
      };
      send(job, 'PUT', chunkPath(job.target, job.sessionId, at), body, {
        contentType: 'application/octet-stream',
        onProgress: (loaded) => {
          job.progress = Math.min(1, (at + loaded) / job.size);
          emit();
        },
        // The last bytes are out: the source checks and imports the file now; a slow answer
        // is followed by asking the session instead.
        onSent: () => {
          if (last) slow = setTimeout(() => finish({ slow: true }), T.slowLast);
        },
      }).then(finish);
    });
    if (job.cancelled) return;
    if (r.slow) {
      const settled = await waitDone();
      job.xhr?.abort(); // the source goes on without the request
      if (settled) return;
      continue;
    }
    if (r.status === 200 || r.status === 201) {
      failSince = 0;
      tries = 0;
      if (r.data?.done) {
        if (r.data.result) applyResult(job, r.data.result);
        else if (adopt(r.data)) return;
        return;
      }
      offset = Number(r.data?.offset) || end;
      progress();
      continue;
    }
    if (r.status === 409 && r.data && typeof r.data.offset === 'number') {
      failSince = 0;
      if (adopt(r.data)) return;
      continue;
    }
    if (r.status === 404) {
      job.state = 'error';
      job.error = 'Caricamento non riuscito';
      return;
    }
    const full = r.status === 507 || r.data?.code === 'disk_full';
    if ((r.status && r.status < 500 && r.status !== 429) || full) {
      // Refused for good (format, size, a full disk): the pipeline's answer, or the chunk's. On a
      // full disk the session goes too: its bytes and the room it holds are what the source lacks.
      job.state = 'error';
      job.error = failWords(job, r.status, r.data);
      if (full) api.cancelSession(job.sessionId).catch(() => {});
      return;
    }
    if (r.status >= 502 && r.status <= 504) sources.markDown(job.target);
    if (last && at + body.size === job.size && r.status === 0 && job.progress >= 0.999) {
      // The answer to the last chunk was lost: the source may well be importing it.
      if (await waitDone()) return;
      continue;
    }
    if (!(await pause(r.status !== 0))) return;
    try {
      const st = await api.session(job.sessionId, { timeout: 10000 });
      if (adopt(st)) return;
    } catch (err) {
      if (err?.status === 404) {
        job.state = 'error';
        job.error = 'Caricamento non riuscito';
        return;
      }
      if (err?.status && !failSince) failSince = Date.now();
    }
  }
}

async function run(job) {
  active++;
  job.state = 'uploading';
  job.progress = 0;
  emit();
  try {
    const info = await targetInfo(job.target);
    if (job.cancelled) return;
    const archive = isArchive(job);
    const ext = (/\.([^.]+)$/.exec(job.name)?.[1] || '').toLowerCase();
    if (archive && (!info.modern || (ext === '7z' && !info.archives?.sevenZip) || (ext === 'rar' && !info.archives?.rar))) {
      job.state = 'error';
      job.error = 'Formato non supportato';
    } else if (job.size > (archive ? MAX_ARCHIVE : MAX_AUDIO)) {
      job.state = 'error';
      job.error = 'File troppo grande';
    } else if (!info.modern || job.size <= T.singleMax) await runSingle(job);
    else await runSession(job);
  } catch (err) {
    console.warn('upload', err);
    if (!job.cancelled && ACTIVE.has(job.state)) {
      job.state = 'error';
      job.error = 'Caricamento non riuscito';
    }
  } finally {
    active--;
    job.xhr = null;
    if (job.cancelled) job.state = 'cancelled';
    releaseFolders();
    emit();
    pump();
  }
}

function pump() {
  while (active < MAX_PARALLEL) {
    const job = jobs.find((j) => j.state === 'waiting');
    if (!job) break;
    run(job);
  }
  if (!jobs.some((j) => OPEN.has(j.state)) && active === 0 && jobs.length) batchDone();
}

/** How many songs this batch brought: added and replaced, archives included. */
function batchCount() {
  let n = 0;
  for (const j of jobs.slice(batchStart)) {
    if (j.state === 'done' || j.state === 'replaced') n++;
    else if (j.archive && (j.state === 'archived' || j.state === 'maybe')) n += (j.archive.added || 0) + (j.archive.replaced || 0);
  }
  return n;
}

function batchDone() {
  // When the sheet is closed, say that the batch finished (once per batch).
  const n = batchCount();
  if (!sheetOpen && n && lastBatchToast !== batchStart) {
    lastBatchToast = batchStart;
    toast(n === 1 ? 'Caricato 1 brano' : `Caricati ${n} brani`);
  }
}

/** App folders: their file URLs stop working once every upload from them is over. */
function releaseFolders() {
  for (const [rid, f] of folders) {
    if (!f.done) continue;
    if ([...f.jobs].some((j) => ACTIVE.has(j.state))) continue;
    folders.delete(rid);
    nativeCall('releaseFolder', rid);
  }
}

/**
 * The image most likely to be the album cover: cover, folder or front by name; else the first one
 * picked by hand with the songs. A folder brings every image it holds (back, booklet, cd): only
 * one named as a cover is offered from there.
 */
function bestImage() {
  return images.find((i) => /^(cover|folder|front|copertina)\b/i.test(i.name)) || images.find((i) => !i.fromFolder) || null;
}

/**
 * One picked file into the queue. Images wait for the cover offer; in a folder (a relative path,
 * or the app's folder picker) anything that is neither audio nor an archive is left out quietly.
 */
function addOne(file, to, extra = {}) {
  const inFolder = !!(file.nativeFile || file.relPath || file.webkitRelativePath);
  if (!isAudio(file) && !isArchive(file) && isImage(file)) {
    if (file.size > MAX_IMAGE_BYTES) return null;
    if (!file.nativeFile) images.push({ id: ++seq, file, name: file.name, url: URL.createObjectURL(file), fromFolder: inFolder });
    else {
      // Its URL stops working once the folder is released: keep the bytes now.
      fetch(file.nativeFile.url)
        .then((res) => (res.ok ? res.blob() : null))
        .then((blob) => {
          if (!blob) return;
          images.push({ id: ++seq, file: blob, name: file.name, url: URL.createObjectURL(blob), fromFolder: true });
          emit();
        })
        .catch(() => {});
    }
    return null;
  }
  if (inFolder && LRC_EXT.test(nameOf(file))) {
    keepLrc(file, to);
    return null;
  }
  if (inFolder && !isAudio(file) && !isArchive(file)) return null;
  const job = {
    id: ++seq,
    file: file.nativeFile ? null : file,
    nativeFile: file.nativeFile || null,
    name: file.name,
    relPath: file.relPath || file.webkitRelativePath || '',
    size: Number(file.size) || 0,
    type: file.type || file.mime || '',
    lastModified: Number(file.lastModified) || 0,
    target: to,
    state: 'waiting',
    progress: 0,
    error: '',
    track: null,
    xhr: null,
    ...extra,
  };
  if (!to) {
    job.state = 'error';
    job.error = 'Nessuna fonte collegata';
  } else if (!isAudio(file) && !isArchive(file)) {
    job.state = 'error';
    job.error = 'Formato non supportato';
  }
  jobs.push(job);
  return job;
}

function startBatch() {
  if (!jobs.some((j) => OPEN.has(j.state))) batchStart = jobs.length;
}

export const uploads = {
  get jobs() {
    return jobs;
  },
  get images() {
    return images;
  },
  /** Bytes are still on their way (or about to be). */
  get busy() {
    return jobs.some((j) => ACTIVE.has(j.state));
  },
  /** The source new files go to ("Carica su"). */
  get target() {
    return currentTarget();
  },
  setTarget(id) {
    target = id;
    emitNow();
  },
  /** Track ids that the current list produced (new or already present), in order. */
  get trackIds() {
    const out = [];
    for (const j of jobs) {
      if (j.track) out.push(j.track.id);
      if (j.archive?.trackIds) out.push(...j.archive.trackIds);
    }
    return out;
  },
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  setSheetOpen(open) {
    sheetOpen = open;
  },
  /** What "Apri" of "Serve una scelta" opens. */
  setOpener(fn) {
    opener = fn;
  },
  /** Timings, shortened by the dev harness. */
  configure(t) {
    Object.assign(T, t);
  },

  /** Files from the picker, a webkitdirectory input or a drop (Files, or app files). */
  add(fileList) {
    startBatch();
    const to = currentTarget();
    for (const file of Array.from(fileList || [])) addOne(file, to);
    emitNow();
    pump();
  },

  /**
   * "Carica cartella" in the app: the system folder picker; its files arrive in batches and go
   * to the queue as they come. Resolves false when the app cannot pick folders. A second call
   * before the picker answered (a double tap, a tap before the picker covered the page) opens
   * nothing more: the picker already on its way is the one.
   */
  pickFolder() {
    if (picking && performance.now() - picking.at < PICK_WAIT_MS) return true;
    const rid = nativeCall('pickFolder');
    if (typeof rid !== 'string' || !rid) return false;
    picking = { rid, at: performance.now() };
    folders.set(rid, { done: false, jobs: new Set(), to: currentTarget() });
    startBatch();
    return true;
  },

  /** True when a failed job can go again: its file is still in hand. */
  canRetry(job) {
    return job.state === 'error' && !!job.file;
  },

  retry(job) {
    if (!uploads.canRetry(job)) return;
    Object.assign(job, { state: 'waiting', error: null, progress: 0, sessionId: null, cancelled: false, archive: null });
    emit();
    pump();
  },

  cancel(job) {
    job.cancelled = true;
    if (job.state === 'waiting') {
      job.state = 'cancelled';
      emit();
      pump();
      return;
    }
    job.xhr?.abort();
    if (job.sessionId) srcApi(job.target).cancelSession(job.sessionId).catch(() => {});
    if (job.state === 'paused' || job.state === 'extracting') job.state = 'cancelled';
    emit();
  },

  /**
   * The "maybe" choice: keep 'best' (the better one replaces or joins the other) or 'both'. For
   * an archive, its first waiting entry; after the last one the archive's summary is read again.
   */
  async choose(job, keep) {
    const entry = job.archive ? job.archive.pending[0] : job.pending;
    if (!entry || job.state !== 'maybe') return;
    job.state = 'choosing';
    emit();
    let r = null;
    let gone = false;
    try {
      r = await srcApi(job.target).choose(entry.id, keep);
    } catch (err) {
      gone = err?.status === 404;
      if (!gone) {
        job.state = 'maybe';
        toast(apiErrorText(err));
        emit();
        return;
      }
    }
    if (job.archive) {
      job.archive.pending = job.archive.pending.slice(1);
      if (!job.archive.pending.length) {
        try {
          job.archive = { ...job.archive, ...(await srcApi(job.target).archive(job.archive.id)), pending: [] };
        } catch {
          /* the counts seen last stay */
        }
      }
      job.state = job.archive.pending.length ? 'maybe' : 'archived';
      store.refreshSoon();
    } else if (gone) {
      // Unanswered too long: the source kept both.
      job.state = 'done';
    } else applyResult(job, r);
    emit();
    pump();
  },

  /** Removes finished rows (keeps what is still on its way) and the picked images. */
  clearFinished() {
    for (let i = jobs.length - 1; i >= 0; i--) {
      if (!OPEN.has(jobs[i].state) && jobs[i].state !== 'maybe') jobs.splice(i, 1);
    }
    batchStart = Math.min(batchStart, jobs.length);
    if (!uploads.busy) {
      for (const im of images.splice(0)) URL.revokeObjectURL(im.url);
      dismissed.clear();
      lrcs.clear();
    }
    emitNow();
  },

  /**
   * Albums of this batch that have no embedded cover (and no custom one yet), once the batch is
   * done and an image was picked with it: [{ albumId, name, artist, image }].
   */
  coverOffers() {
    const image = bestImage();
    if (!image || uploads.busy) return [];
    const albums = new Map();
    for (const j of jobs) {
      const t = j.track;
      if (!t || !['done', 'duplicate', 'replaced'].includes(j.state)) continue;
      const albumArtist = t.albumArtist || t.artist || '';
      const albumId = hashId(`${albumArtist}\u0000${t.album || ''}`);
      let a = albums.get(albumId);
      if (!a) albums.set(albumId, (a = { albumId, name: t.album || 'Album', artist: albumArtist, image, embedded: false }));
      if (t.coverId) a.embedded = true;
    }
    return [...albums.values()].filter((a) => !a.embedded && !dismissed.has(a.albumId) && !store.hasCustomCover('album', a.albumId));
  },
  dismissOffer(albumId) {
    dismissed.add(albumId);
    emitNow();
  },
};

// The app's folder picker: files in batches of up to 50, then done (or cancelled, or an error).
onNative('folder', (m) => {
  if (picking && picking.rid === m.requestId) picking = null;
  const f = folders.get(m.requestId);
  if (!f) return;
  if (m.state === 'files' && Array.isArray(m.files)) {
    for (const x of m.files) {
      if (!x || typeof x.id !== 'string') continue;
      const nf = { id: x.id, url: `/__native/file/${encodeURIComponent(x.id)}` };
      const job = addOne({ nativeFile: nf, name: String(x.name || ''), relPath: String(x.relPath || ''), size: Number(x.size) || 0, mime: String(x.mime || ''), lastModified: Number(x.lastModified) || 0 }, f.to);
      if (job) f.jobs.add(job);
    }
    emitNow();
    pump();
  } else if (m.state === 'done' || m.state === 'cancelled' || m.state === 'error') {
    f.done = true;
    if (m.state === 'error') toast('Qualcosa non ha funzionato');
    releaseFolders();
  }
});
