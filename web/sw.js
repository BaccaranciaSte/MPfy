// MPfy service worker.
//
// - App shell: precached as ONE unit and served cache-first. A shell version is named after the
//   SHA-256 of all the shell files together, computed here from the files themselves (no build
//   step, nothing to bump by hand). A new version is downloaded completely into its own cache and
//   only then made current, with a single write of a pointer; if any file fails (a flaky P2P link
//   on mobile data), the attempt is dropped and the current version stays whole. So a page never
//   gets a mix of old and new modules, which would break an import and leave a blank page.
//   Each page also keeps the version it started with (by client id) until it is closed.
// - Covers (/s/<source>/api/cover/<coverId>?size=...): immutable by id, so cache-first
//   and keyed by coverId and size only: any source that has a cover fills the same entry, and a
//   cover seen once still shows while its source is offline. With &cached=1 (no source that has
//   it is connected) only the cache answers: a miss is a 504 at once, never a network request.
// - Everything else under /s/ (libraries, streams, uploads, admin) and /local/ goes straight to
//   the client core: the store keeps its own copy of each library in IndexedDB, and Range
//   requests and big bodies must never pass through here.
//
// Updates: the browser checks this file on every start; the page asks for a shell check once it
// has started ({ type: 'mpfy-check' }), and when a new version became current the pages get
// { type: 'mpfy-shell-updated' } and switch to it at a quiet moment (app.js).
// Keep SHELL_FILES in step with the files on disk (web/dev/check.mjs compares them).

const SHELL_PREFIX = 'mpfy-shell-';
const META = 'mpfy-meta-v1';
const COVERS = 'mpfy-covers-v1';
const POINTER = '/__mpfy/shell-current'; // key in META: { cache, digest } of the current shell
const COVER_KEY = '/__mpfy/cover/'; // + coverId + '?size=' + size
const COVERS_MAX = 4000; // entries; the oldest go first when it is full

const SHELL_FILES = [
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.webmanifest',
  '/icons/icons.js',
  '/icons/mpfy-32.png',
  '/icons/mpfy-64.png',
  '/icons/mpfy-192.png',
  '/icons/mpfy-512.png',
  '/js/actions.js',
  '/js/activity.js',
  '/js/api.js',
  '/js/backend-native.js',
  '/js/browse.js',
  '/js/backend-web.js',
  '/js/chat-data.js',
  '/js/chat.js',
  '/js/color.js',
  '/js/comments.js',
  '/js/compat.js',
  '/js/conn.js',
  '/js/contexts.js',
  '/js/dom.js',
  '/js/downloads.js',
  '/js/emoji-data.js',
  '/js/fingerprints.js',
  '/js/guessed-covers.js',
  '/js/heart.js',
  '/js/idb.js',
  '/js/libcache.js',
  '/js/links.js',
  '/js/lyrics.js',
  '/js/media.js',
  '/js/memory.js',
  '/js/merge.js',
  '/js/music-card.js',
  '/js/native.js',
  '/js/player.js',
  '/js/press.js',
  '/js/profile-id.js',
  '/js/profile.js',
  '/js/qr.js',
  '/js/quality.js',
  '/js/router.js',
  '/js/settle.js',
  '/js/social.js',
  '/js/sortable.js',
  '/js/songs.js',
  '/js/sources.js',
  '/js/speckle.js',
  '/js/storage-row.js',
  '/js/store.js',
  '/js/swap.js',
  '/js/theirs.js',
  '/js/ticker.js',
  '/js/updates.js',
  '/js/upload.js',
  '/js/userops.js',
  '/js/util.js',
  '/js/genres.js',
  '/js/genre-index.js',
  '/js/loudness.js',
  '/js/vlist.js',
  '/js/when.js',
  '/js/words.js',
  '/components/add-source.js',
  '/components/avatar.js',
  '/components/banner.js',
  '/components/cards.js',
  '/components/chat-menus.js',
  '/components/chat-panel.js',
  '/components/comments.js',
  '/components/composer.js',
  '/components/controls.js',
  '/components/cover-edit.js',
  '/components/cover.js',
  '/components/emoji-picker.js',
  '/components/friends-side.js',
  '/components/library-list.js',
  '/components/lyrics.js',
  '/components/menus.js',
  '/components/mini-player.js',
  '/components/nav.js',
  '/components/now-playing.js',
  '/components/people.js',
  '/components/photo-edit.js',
  '/components/player-bar.js',
  '/components/queue.js',
  '/components/share-sheet.js',
  '/components/shared-card.js',
  '/components/sheet.js',
  '/components/toast.js',
  '/components/track-row.js',
  '/components/update-button.js',
  '/components/upload-sheet.js',
  '/views/chat.js',
  '/views/detail.js',
  '/views/friends.js',
  '/views/home.js',
  '/views/library.js',
  '/views/person.js',
  '/views/profile.js',
  '/views/recents.js',
  '/views/search.js',
  '/views/settings.js',
  '/views/shared.js',
  '/views/welcome.js',
];

let current = null; // { cache, digest } of the current shell, or null before the first install
const pinned = new Map(); // client id -> shell cache that page started with
let checking = null;

async function readPointer() {
  const res = await caches.match(POINTER, { cacheName: META });
  if (!res) return null;
  try {
    const p = await res.json();
    return p && typeof p.cache === 'string' && p.cache.startsWith(SHELL_PREFIX) ? p : null;
  } catch {
    return null;
  }
}

/** All shell files, or an exception if any one of them could not be fetched whole. */
async function fetchShell() {
  return Promise.all(
    SHELL_FILES.map(async (path) => {
      // no-cache revalidates with the ETag: an unchanged file costs a 304, not its bytes.
      const res = await fetch(path, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`${path}: ${res.status}`);
      return { path, body: await res.arrayBuffer(), type: res.headers.get('Content-Type') || '' };
    })
  );
}

async function digestOf(files) {
  const enc = new TextEncoder();
  const parts = [];
  for (const f of files) parts.push(enc.encode(`${f.path}\n${f.body.byteLength}\n`), new Uint8Array(f.body));
  const all = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.byteLength;
  }
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
  return [...hash.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Deletes shell caches that are neither current nor still used by an open page. */
async function dropOldShells() {
  const live = new Set((await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).map((c) => c.id));
  for (const id of [...pinned.keys()]) if (!live.has(id)) pinned.delete(id);
  const keep = new Set(pinned.values());
  if (current) keep.add(current.cache);
  for (const key of await caches.keys()) {
    if (key.startsWith(SHELL_PREFIX) && !keep.has(key)) await caches.delete(key);
  }
}

/**
 * Downloads the shell and, if its content changed, installs it as the new current version.
 * Resolves true when an older version was replaced. Throws when a file could not be fetched.
 */
async function updateShell() {
  const files = await fetchShell();
  const digest = await digestOf(files);
  current = current || (await readPointer());
  if (current?.digest === digest && (await caches.has(current.cache))) return false;
  const name = SHELL_PREFIX + digest;
  await caches.delete(name); // leftovers of an attempt cut short
  const cache = await caches.open(name);
  for (const f of files) {
    await cache.put(f.path, new Response(f.body, { headers: f.type ? { 'Content-Type': f.type } : {} }));
  }
  const replaced = !!current;
  // The switch: one write. Until here every page and every start used the old, complete shell.
  const meta = await caches.open(META);
  await meta.put(POINTER, new Response(JSON.stringify({ cache: name, digest }), { headers: { 'Content-Type': 'application/json' } }));
  current = { cache: name, digest };
  return replaced;
}

async function tellPages() {
  for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ type: 'mpfy-shell-updated' });
}

/** One shell check at a time; failures keep the current shell. */
function checkShell() {
  if (!checking) checking = (async () => {
    try {
      if (await updateShell()) await tellPages();
      await dropOldShells();
    } catch {
      /* offline or a file missing: the current shell stays as it is */
    } finally {
      checking = null;
    }
  })();
  return checking;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      // The very first install builds the shell; a worker that cannot get it whole does not
      // install, and the browser tries again at the next start. A newer worker leaves the current
      // shell alone: it may be serving a page that is still loading its modules right now (this
      // worker takes over at once), so the switch waits for the page's check after its start.
      if (!(await readPointer())) await updateShell();
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Anything that is not ours by these names (older versions of the app) goes.
      const keep = new Set([META, COVERS]);
      for (const key of await caches.keys()) {
        if (!keep.has(key) && !key.startsWith(SHELL_PREFIX)) await caches.delete(key);
      }
      await self.clients.claim();
      current = await readPointer();
      await dropOldShells(); // only leftovers: the current shell is kept
    })()
  );
});

/** The covers cache in bytes (each entry carries its size in X-MPfy-Bytes) and entries. */
async function coverCacheSize() {
  if (!(await caches.has(COVERS))) return { bytes: 0, entries: 0 };
  const cache = await caches.open(COVERS);
  const keys = await cache.keys();
  let bytes = 0;
  for (const k of keys) {
    const r = await cache.match(k);
    bytes += Number(r?.headers.get('X-MPfy-Bytes')) || Number(r?.headers.get('Content-Length')) || 0;
  }
  return { bytes, entries: keys.length };
}

/** Answers a page on the port it gave, else on its client. */
function reply(event, data) {
  if (event.ports && event.ports[0]) event.ports[0].postMessage(data);
  else event.source?.postMessage(data);
}

self.addEventListener('message', (event) => {
  const type = event.data?.type;
  if (type === 'mpfy-check') event.waitUntil(checkShell());
  else if (type === 'cover-cache-size') event.waitUntil(coverCacheSize().then((r) => reply(event, { type, ...r }), () => reply(event, { type, bytes: 0, entries: 0 })));
  else if (type === 'clear-covers') event.waitUntil(caches.delete(COVERS).then(() => reply(event, { type, ok: true }), () => reply(event, { type, ok: false })));
});

let coverPuts = 0;
// A source answers ?size=small with the original image until its background job has made the
// 160 px version. Such a big "small" answer is kept, but fetched again now and then.
const SMALL_MAX_BYTES = 64 * 1024;
const RECHECK_MS = 3600 * 1000;

async function putCover(cache, key, res, size) {
  const body = await res.arrayBuffer();
  const headers = new Headers(res.headers);
  headers.delete('Content-Encoding');
  headers.set('Content-Length', String(body.byteLength));
  headers.set('X-MPfy-Bytes', String(body.byteLength));
  if (size === 'small' && body.byteLength > SMALL_MAX_BYTES) headers.set('X-MPfy-Recheck', String(Date.now()));
  else headers.delete('X-MPfy-Recheck');
  await cache.put(key, new Response(body, { status: 200, headers }));
  // Now and then, keep the cache bounded (keys come back oldest first).
  if (++coverPuts % 50 === 0) {
    const keys = await cache.keys();
    for (const k of keys.slice(0, Math.max(0, keys.length - COVERS_MAX))) await cache.delete(k);
  }
}

/**
 * Covers by id, whichever source serves them: cache-first, fetched once. cachedOnly (the page
 * added &cached=1 because no source that has the cover is connected): the cache or a 504 at
 * once, never the network, where the core would make the request wait for the link.
 */
async function coverCacheFirst(event, coverId, size, cachedOnly) {
  const key = `${COVER_KEY}${encodeURIComponent(coverId)}?size=${size}`;
  const cache = await caches.open(COVERS);
  const hit = await cache.match(key);
  if (!hit && cachedOnly) return new Response('', { status: 504 });
  if (hit) {
    const at = Number(hit.headers.get('X-MPfy-Recheck'));
    if (at && !cachedOnly && Date.now() - at > RECHECK_MS) {
      event.waitUntil(
        fetch(event.request)
          .then((res) => (res.ok && res.type === 'basic' ? putCover(cache, key, res, size) : null))
          .catch(() => {})
      );
    }
    return hit;
  }
  let res;
  try {
    res = await fetch(event.request);
  } catch {
    return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  if (res.ok && res.type === 'basic') event.waitUntil(putCover(cache, key, res.clone(), size).catch(() => {}));
  return res;
}

/**
 * Shell files, cache-first from the version this page started with. A navigation picks the
 * current version and pins it to the page it creates, so a version that becomes current while
 * the page is still loading its modules cannot mix into it. Files outside the precached shell,
 * or a start before the first install finished, go to the network.
 */
async function serveShell(event, path, navigation) {
  let name;
  if (navigation) {
    current = (await readPointer()) || current;
    name = current?.cache;
    if (name && event.resultingClientId) pinned.set(event.resultingClientId, name);
  } else {
    name = pinned.get(event.clientId) || (current = current || (await readPointer()))?.cache;
  }
  if (name) {
    const hit = await caches.match(path, { cacheName: name, ignoreSearch: true });
    if (hit) return hit;
  }
  try {
    return await fetch(navigation ? new Request('/index.html', { cache: 'no-cache' }) : event.request);
  } catch {
    return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

const COVER_PATH = /^\/s\/[^/]+\/api\/cover\/([^/]+)$/;

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;

  const cover = COVER_PATH.exec(path);
  if (cover) {
    const size = url.searchParams.get('size') === 'large' ? 'large' : 'small';
    let id = cover[1];
    try {
      id = decodeURIComponent(id);
    } catch {
      /* keep it as it came */
    }
    event.respondWith(coverCacheFirst(event, id, size, url.searchParams.get('cached') === '1'));
    return;
  }
  // The app serves picked files itself at /__native/: never answered here.
  if (path.startsWith('/s/') || path.startsWith('/local/') || path.startsWith('/api/') || path.startsWith('/admin/') || path.startsWith('/dev/') || path.startsWith('/__mock/') || path.startsWith('/__native/')) return;
  if (path === '/sw.js') return;

  // Every app route is the same single page.
  if (req.mode === 'navigate') {
    event.respondWith(serveShell(event, '/index.html', true));
    return;
  }
  event.respondWith(serveShell(event, path, false));
});
