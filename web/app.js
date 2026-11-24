// MPfy web UI entry point: draws the speckle, builds the shell, starts the profile, sources,
// store, player, the people (and the report of what plays, where the page is the player), the PC's
// right column and the router (in the app also updates, the heart outside the page and the car's
// library), wires global behaviour (links, focus refresh, drag and drop upload of files and
// folders, keyboard, the #aggiungi=<code> and #chat=<cid> fragments, service worker). Until there
// is a profile and a source, every route shows the way in (welcome.js): the welcome screen, the
// first source, or (an install from before profiles) the name.

import './js/compat.js';
import { applySpeckle } from './js/speckle.js';
import { native, nativeCall } from './js/native.js';
import { errorText } from './js/api.js';
import { progressDialog } from './components/sheet.js';
import { sources } from './js/sources.js';
import { store } from './js/store.js';
import { player } from './js/player.js';
import { downloads } from './js/downloads.js';
import { quality } from './js/quality.js';
import { startRouter, navigate, hasLayers, rerender } from './js/router.js';
import { swapViews } from './js/swap.js';
import { onConn } from './js/conn.js';
import { uploads } from './js/upload.js';
import { BRAND, safeDecode } from './js/util.js';
import { mountNav, mountSidebar, setActiveTab } from './components/nav.js';
import { mountMiniPlayer } from './components/mini-player.js';
import { mountPlayerBar } from './components/player-bar.js';
import { mountBanner } from './components/banner.js';
import { refreshAllMarks } from './components/track-row.js';
import { openUploadSheet } from './components/upload-sheet.js';
import { homeView } from './views/home.js';
import { searchView } from './views/search.js';
import { libraryView } from './views/library.js';
import { detailView } from './views/detail.js';
import { welcomeView } from './views/welcome.js';
import { settingsView, qualityView, sourceView, blockedView } from './views/settings.js';
import { profileView, linkDeviceView, recoveryView } from './views/profile.js';
import { openAddSource, addingSource, onAddEnd, codeOnScreen, sourcesOf } from './components/add-source.js';
import { parseLink } from './js/links.js';
import { askNameIfMissing } from './views/welcome.js';
import { profile } from './js/profile.js';
import { updates, olderThanApp, mayReload } from './js/updates.js';
import { heart } from './js/heart.js';
import { browse } from './js/browse.js';
import { redrawGuessedCovers } from './js/guessed-covers.js';
import { social } from './js/social.js';
import { startActivity } from './js/activity.js';
import { friendsView } from './views/friends.js';
import { personView } from './views/person.js';
import { recentsView } from './views/recents.js';
import { friendsSide } from './components/friends-side.js';
import { chatView } from './views/chat.js';
import { sharedPlaylistView } from './views/shared.js';
import { comments } from './js/comments.js';
import { lyrics } from './js/lyrics.js';

// Drawn once, before anything paints with it.
applySpeckle();

const main = document.getElementById('main');
let view = null;

/**
 * The way in, as the core says (until it answers, Home shows that it is loading): 'welcome' with
 * no profile and no source, 'first' with a profile and no source, 'name' with sources and no
 * profile; null when the app itself shows. A core without profiles only asks for a source.
 */
function gate() {
  if (!sources.loaded || !profile.loaded) return null;
  if (!sources.list.length) {
    if (profile.supported && !profile.data) return 'welcome';
    // A host with music of its own: the app shows with only the phone's songs (a source is added
    // later, from Impostazioni).
    return sources.phone ? null : 'first';
  }
  if (profile.supported && !profile.data) return 'name';
  return null;
}
let gateNow = null;

// A malformed id in the address (a hand-typed %) decodes to null and the route falls back to Home:
// a throw here would happen inside startRouter and stop boot() before the library loads.
function resolve(pathname, query) {
  gateNow = gate();
  if (gateNow) return welcomeView(gateNow);
  if (pathname === '/impostazioni') return settingsView();
  if (pathname === '/impostazioni/qualita') return qualityView();
  if (pathname === '/impostazioni/profilo') return profileView();
  if (pathname === '/impostazioni/collega') return linkDeviceView();
  if (pathname === '/impostazioni/recupero') return recoveryView();
  if (pathname === '/impostazioni/bloccate') return blockedView();
  const src = /^\/impostazioni\/fonte\/([^/]+)$/.exec(pathname);
  const srcId = src && safeDecode(src[1]);
  if (srcId) return sourceView(srcId);
  if (pathname === '/amici') return friendsView(query);
  if (pathname === '/recenti') return recentsView();
  const chat = /^\/chat\/([0-9a-f]{32})$/.exec(pathname);
  if (chat) return chatView(chat[1]);
  const shared = /^\/condivisa\/([0-9a-f]{32})\/([0-9a-f]{32})$/.exec(pathname);
  if (shared) return sharedPlaylistView(shared[1], shared[2]);
  const person = /^\/persona\/([^/]+)$/.exec(pathname);
  const personId = person && safeDecode(person[1]);
  if (personId) return personView(personId);
  if (pathname === '/search') return searchView(query);
  if (pathname === '/library') return libraryView();
  if (pathname === '/liked') return detailView('liked', null);
  const genre = /^\/genere\/([a-z0-9.]+)$/.exec(pathname);
  if (genre) return detailView('genre', genre[1]);
  const m = /^\/(playlist|album|artist)\/([^/]+)$/.exec(pathname);
  const id = m && safeDecode(m[2]);
  if (id) return detailView(m[1], id);
  return homeView();
}

/** motion: how the page changes (swap.js); the way in comes and goes at once. */
function render(pathname, query, scrollTop, motion = null) {
  const was = view;
  try {
    view?.destroy?.();
  } catch (err) {
    console.error('view destroy', err);
  }
  view = resolve(pathname, query);
  document.body.classList.toggle('welcome-on', !!view.welcome);
  friendsSide.recheck(); // never on the way in
  const kind = motion && was && !was.welcome && !view.welcome ? motion : null;
  swapViews(main, was ? was.el : null, view.el, { kind, scrollTop: scrollTop || 0 });
  setActiveTab(view.tab || null);
  view.mounted?.();
  refreshAllMarks();
}

// ---- global link handling: <a data-link> navigates inside the app; the tabs and the sidebar
// crossfade, every other link goes one page deeper; one with data-replace takes the page's place in
// the history (a genre's chips: Back leaves the genres, not the last chip) ----
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate(a.getAttribute('href'), { tab: !!a.closest('#nav, #sidebar'), replace: a.hasAttribute('data-replace') });
});

// ---- desktop layout pieces are mounted only when the desktop layout is active ----
const desktop = matchMedia('(min-width: 900px)');
let desktopMounted = false;
function mountDesktop() {
  if (desktopMounted || !desktop.matches) return;
  desktopMounted = true;
  mountSidebar(document.getElementById('sidebar'));
  mountPlayerBar(document.getElementById('playerbar'));
  refreshAllMarks();
}
desktop.addEventListener('change', mountDesktop);

// ---- drag and drop upload onto the window ----
function setupDrop() {
  const zone = document.getElementById('dropzone');
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    depth++;
    zone.hidden = false;
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) zone.hidden = true;
  });
  window.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    zone.hidden = true;
    // Entries must be taken during the event; a folder is then walked (its files keep their path).
    const entries = [...(e.dataTransfer.items || [])].map((it) => (it.kind === 'file' && it.webkitGetAsEntry ? it.webkitGetAsEntry() : null)).filter(Boolean);
    if (entries.some((en) => en.isDirectory)) folderFiles(entries).then((files) => files.length && openUploadSheet(files));
    else if (e.dataTransfer.files.length) openUploadSheet(e.dataTransfer.files);
  });
}

/** The files under dropped entries (depth 8, at most 5000), each with its path in relPath. */
async function folderFiles(entries) {
  const out = [];
  const walk = async (en, path, depth) => {
    if (out.length >= 5000) return;
    if (en.isFile) {
      try {
        const f = await new Promise((res, rej) => en.file(res, rej));
        Object.defineProperty(f, 'relPath', { value: path + f.name });
        out.push(f);
      } catch {
        /* unreadable: left out */
      }
    } else if (en.isDirectory && depth < 8) {
      const reader = en.createReader();
      for (;;) {
        let batch = [];
        try {
          batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        } catch {
          break;
        }
        if (!batch.length) break;
        for (const c of batch) await walk(c, `${path}${en.name}/`, depth + 1);
      }
    }
  };
  for (const en of entries) await walk(en, '', 0);
  return out;
}

// ---- keyboard: space toggles play, as in desktop players ----
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t.closest?.('input, textarea, button, a, [contenteditable="true"]')) return;
  e.preventDefault();
  player.toggle();
});

// ---- refresh the library when the app comes back to the foreground ----
let lastRefresh = 0;
function refreshIfStale() {
  if (Date.now() - lastRefresh < 10000) return;
  lastRefresh = Date.now();
  sources.refresh();
  profile.refresh();
  store.refresh();
  checkForUpdate();
}

function updateTitle() {
  const t = player.currentTrack();
  document.title = t && player.state.playing ? `${t.title} - ${t.artist}` : BRAND;
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !location.protocol.startsWith('http')) return;
  // ?nosw turns the service worker off (handy while developing the UI).
  if (new URLSearchParams(location.search).has('nosw')) {
    navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister()));
    return;
  }
  const register = () => navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err) => console.warn('service worker', err));
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });

  // A new version of the app (installed whole by the service worker, see sw.js) replaces this
  // one at a quiet moment: the page is hidden, nothing is open, no upload is running, no source
  // is being added, and the reload cannot cut the music (the web backend plays inside this page;
  // in the app the music lives in the native service and the reloaded page adopts it). Otherwise
  // at the next start.
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'mpfy-shell-updated') {
      updateReady = true;
      reloadIfQuiet();
    }
  });
  // A tick later: a page being left turns hidden as it unloads, and a reload then would take the
  // place of where it was going.
  document.addEventListener('visibilitychange', () => setTimeout(reloadIfQuiet, 0));
  player.onChange(reloadIfQuiet);
  uploads.subscribe(reloadIfQuiet);
  onAddEnd(reloadIfQuiet);
  for (const t of ['pointerdown', 'touchstart', 'keydown', 'input', 'wheel']) {
    window.addEventListener(t, () => (lastInput = Date.now()), { capture: true, passive: true });
  }
}

let updateReady = false;
let lastShellCheck = 0;
let recheck = 0;
// A page older than the app itself (just updated) does not wait to be hidden, but it does not cut
// what the person is doing either: it looks again every 2 s while it is on screen.
const behindApp = olderThanApp();

// Busy on the page: a text field has the focus, or the page was touched or typed in within the
// last 3 s (a reload between a press and its click would lose the tap).
const BUSY_MS = 3000;
let lastInput = 0;
const TEXT_INPUT = /^(text|search|password|email|url|tel|number)$/;
function personBusy() {
  const a = document.activeElement;
  const typing = !!a && (a.isContentEditable || a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && TEXT_INPUT.test(a.type)));
  return typing || Date.now() - lastInput < BUSY_MS;
}

/** The code from #aggiungi= nobody used yet: waiting for its step, or still in its field. */
function unusedCode() {
  return pendingAdd || view?.waitingCode?.() || (lastCode && codeOnScreen(lastCode) ? lastCode : '');
}

function reloadIfQuiet() {
  clearTimeout(recheck);
  if (!updateReady) return;
  const code = unusedCode();
  const now = mayReload({
    hidden: document.hidden,
    behind: behindApp,
    layers: hasLayers(),
    uploading: uploads.busy,
    adding: addingSource(),
    playingHere: !player.isNative && player.state.playing,
    wayIn: !!gateNow,
    code: !!code,
    busy: personBusy(),
  });
  if (!now) {
    // A hidden page is held by an upload or an add, which look again when they end, or by
    // something open, which the page coming back looks at: no timer wakes it.
    if (behindApp && !document.hidden) recheck = setTimeout(reloadIfQuiet, 2000);
    return;
  }
  updateReady = false;
  // The reloaded page takes the code again, as at the start.
  if (code) history.replaceState(history.state, '', `${location.pathname}${location.search}#aggiungi=${encodeURIComponent(code)}`);
  location.reload();
}

/** Asks the service worker to look for a new version of the app (at start, then every 6 hours). */
function checkForUpdate() {
  if (Date.now() - lastShellCheck < 6 * 3600 * 1000) return;
  lastShellCheck = Date.now();
  navigator.serviceWorker?.controller?.postMessage({ type: 'mpfy-check' });
}

/** The link of a profile's QR code, on a device with no profile yet: the way in takes it. */
const forWayIn = (code) => !!parseLink(code)?.profile && profile.supported && !profile.data;

/**
 * A code or a link the app opened the page with, where it goes: the way in ("Ho già un profilo"
 * for a profile's link, else the first source step) or "Aggiungi fonte". A link's sources: the
 * first in the field, the others added with it. Nothing is sent before the person taps.
 */
function useCode(code, onDone) {
  if (gateNow && forWayIn(code) && view?.fillLink) {
    view.fillLink(code);
    return;
  }
  const { code: first, more } = sourcesOf(code);
  if (gateNow && view?.fillCode) view.fillCode(first, more);
  else if (!gateNow) openAddSource({ code: first, more, askName: askNameIfMissing, onDone });
}

/**
 * #aggiungi=<code>: the Android app starts the page with it when it was launched with a
 * code, or with the link of a QR code (links.js). The fragment is removed from the address first
 * (layers push the current URL) and the add screen opens with the code filled in. A new version
 * that takes over before the code was used puts it back in the address (reloadIfQuiet).
 */
function takeAddFragment() {
  const m = /^#aggiungi=(.*)$/.exec(location.hash);
  if (!m) return;
  let code = m[1];
  try {
    code = decodeURIComponent(code);
  } catch {
    /* keep it raw */
  }
  history.replaceState(history.state, '', location.pathname + location.search);
  lastCode = sourcesOf(code).code;
  // On the way in, the first source step takes it (after the name when there is none yet). The
  // name of an install from before profiles closes the way in by itself: the code waits for it,
  // and a profile's link goes to "Ho già un profilo" at once.
  if (gateNow && (gateNow !== 'name' || forWayIn(code)) && view?.fillCode) useCode(code);
  else if (gateNow || !sources.loaded) pendingAdd = code;
  else useCode(code, () => navigate('/', { replace: true, motion: 'fade' }));
}
let pendingAdd = '';
let lastCode = '';

/**
 * #chat=<cid>: the Android app opens the page with it when its message notification was tapped.
 * The fragment leaves the address and the conversation opens (once the way in is past).
 */
function takeChatFragment() {
  const m = /^#chat=([0-9a-f]{32})$/.exec(location.hash);
  if (!m) return;
  history.replaceState(history.state, '', location.pathname + location.search);
  if (gateNow) return;
  navigate(`/chat/${m[1]}`);
}

// ---- the person's data from the phone's store to the real principal ----
// Due when the core says the phone's store is still the home while a real principal exists (a
// source just added, or a move an earlier session left unfinished) and that principal is up. One
// at a time (a Web Lock, as for plays). A failed pass is tried again when the principal comes
// back up or at the next start, never in a loop. No question is asked: with a real principal the
// data must move.
let moving = false;
let moveFailedFor = null;
let movePrincipalUp = false;
async function movePhone(dialog) {
  const to = sources.principal();
  const up = !!to && sources.isUp(to.id);
  if (up && !movePrincipalUp) moveFailedFor = null; // it came back up: worth a pass again
  movePrincipalUp = up;
  if (moving || !up || !sources.phone?.home || !store.loaded || addingSource()) return;
  if (!dialog && moveFailedFor === to.id) return;
  moving = true;
  const run = async () => {
    const dlg = dialog ? progressDialog({ title: `Copia su ${to.name}` }) : null;
    downloads.suspend(true);
    try {
      const { idMap, skippedCovers } = await store.movePhoneData(to.id, (done, total, label) => dlg?.set(done, total, label));
      downloads.remapPlaylists(idMap);
      player.remapPlaylists(idMap);
      moveFailedFor = null;
      dlg?.finish(skippedCovers ? `Fatto, ${skippedCovers === 1 ? '1 copertina non copiata' : `${skippedCovers} copertine non copiate`}` : 'Fatto');
    } catch (err) {
      moveFailedFor = to.id;
      dlg?.fail(errorText(err, 'Copia non riuscita'));
    } finally {
      downloads.suspend(false);
    }
  };
  try {
    if (navigator.locks?.request) await navigator.locks.request('mpfy-phone-move', { ifAvailable: true }, (lock) => (lock ? run() : null));
    else await run();
  } catch (err) {
    console.warn('phone move', err);
  } finally {
    moving = false;
  }
}

async function boot() {
  document.body.classList.toggle('has-native', !!native);
  mountBanner(document.getElementById('banner'));
  mountNav(document.getElementById('nav'));
  mountMiniPlayer(document.getElementById('mini'));
  friendsSide.mount(document.getElementById('app'));
  mountDesktop();
  setupDrop();

  quality.init();
  profile.refresh();
  sources.start();
  uploads.setOpener(() => openUploadSheet());
  if (native) {
    downloads.init();
    downloads.subscribe(() => refreshAllMarks());
    // A downloaded track keeps its lyrics for offline.
    lyrics.init();
    updates.init();
  }

  // The way in comes and goes with the profile and the first (or the last) source; while it is
  // up, its own steps follow what changed.
  const checkGate = () => {
    const g = gate();
    if (!!g !== !!gateNow) rerender();
    else if (g && g !== gateNow) {
      gateNow = g;
      view?.setKind?.(g);
    }
    if (pendingAdd && sources.loaded && profile.loaded && (gateNow !== 'name' || forWayIn(pendingAdd))) {
      const code = pendingAdd;
      pendingAdd = '';
      useCode(code);
    }
    // Straight into the library with a profile that has no name (its question was left with the
    // back button, or the app closed on it): asked once more. The way in asks it itself.
    if (gateNow) nameChecked = true;
    else if (!nameChecked && sources.loaded && profile.loaded) {
      nameChecked = true;
      askNameIfMissing();
    }
    // The phone's music: the system's own question, once, when the app (not the way in) first
    // shows; the app asks only if it never did and the access is not granted.
    if (!accessAsked && !gate() && sources.loaded && profile.loaded && sources.phone) {
      accessAsked = true;
      nativeCall('askMusicAccess', 'first');
    }
  };
  let accessAsked = false;
  let nameChecked = false;
  sources.subscribe(() => {
    refreshAllMarks(); // a source came or went: its tracks dim or light up
    checkGate();
    movePhone(false);
  });
  profile.subscribe(checkGate);
  // The move that "Aggiungi fonte" started shows its progress; one resumed at a start does not.
  onAddEnd(() => movePhone(true));

  player.init();
  player.onChange(() => {
    refreshAllMarks();
    updateTitle();
  });
  social.start();
  startActivity();
  if (native) {
    heart.init();
    browse.init();
  }

  store.subscribe(() => {
    try {
      view?.update?.();
    } catch (err) {
      console.error('view update', err);
    }
    refreshAllMarks();
    redrawGuessedCovers();
  });

  // A connection flip alone changes nothing a page draws from the library (rows dim through the
  // marks, Home's empty library follows it itself): no view is drawn again for it, only the covers
  // drawn before a connected source was known are pointed at one.
  onConn((online) => {
    if (online) store.refresh();
    redrawGuessedCovers();
  });

  startRouter(render, main);
  takeAddFragment();
  takeChatFragment();
  window.addEventListener('hashchange', () => {
    takeAddFragment();
    takeChatFragment();
  });
  lastRefresh = Date.now();
  await store.init();
  movePhone(false); // a move an earlier session left unfinished

  window.addEventListener('focus', refreshIfStale);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshIfStale();
  });
  registerServiceWorker();
  checkForUpdate(); // the page is fully loaded now: a version switch cannot mix into it
}

boot().catch((err) => console.error('boot', err));

// Exposed for debugging from the console only.
window.mpfy = { sources, store, player, quality, profile, uploads, navigate, hasLayers, social, friendsSide, comments, lyrics };
