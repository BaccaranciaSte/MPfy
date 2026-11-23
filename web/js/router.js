// History based routing plus "layers" (sheets, dialogs, Now Playing, queue) that live in the
// history too, so the Android back button closes the top layer first.
//
// Routes: /  /search?q=  /library  /liked  /playlist/:id  /album/:id  /artist/:id
//         /impostazioni  /impostazioni/qualita  /impostazioni/fonte/:id
//         /amici  /amici?q=  /persona/:profileId  /recenti  /impostazioni/bloccate
//         /chat/:cid  /condivisa/:cid/:messageId
// (with no source paired yet every route shows the welcome screen, see app.js; its steps are layers)
// A layer pushes an entry with state { ov: depth } on the same URL; going back pops it. A layer
// opened while a close is still stepping the history back pushes its entry once that step is done.
//
// A double tap moves one step: the rest of the gesture that rendered a page does nothing on it
// (markFresh, dom.js), and the back arrow ignores the second tap of a double tap and a press while
// its step back is on its way.
//
// Each route entry knows its place in the history (n) and how it was reached (k: 't' by a tab or
// the sidebar, 'd' deeper), so a page change knows its motion (swap.js): deeper slides in, back
// slides out, a tab crossfades, and going back over a tab switch crossfades too.

import { markFresh, sameSpotTap } from './dom.js';

let renderRoute = null;
let currentPath = null;
let scroller = null;
let depthInApp = 0; // how many route entries we pushed, to know whether "back" stays in the app
const scrollMem = new Map(); // path -> { y, rows }: where its page was left, see rowsOf
const layers = [];
const waiters = [];
const inFlight = new Set(); // closes whose history step has not landed yet
let entryN = 0; // the place of the current route entry in the history
let entryK = 'd'; // how it was reached: 't' a tab or the sidebar, 'd' deeper

const pathNow = () => location.pathname + location.search;

export function startRouter(render, scrollEl) {
  renderRoute = render;
  scroller = scrollEl;
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  const st = history.state;
  entryN = typeof st?.n === 'number' ? st.n : 0;
  entryK = st?.k === 't' ? 't' : 'd';
  // A reload while a layer was open leaves an { ov } entry with no layer: normalize it.
  if (st?.ov || typeof st?.n !== 'number') history.replaceState({ r: 1, n: entryN, k: entryK }, '', location.href);
  window.addEventListener('popstate', onPop);
  window.addEventListener('keydown', (e) => {
    const top = layers[layers.length - 1];
    if (e.key === 'Escape' && top) {
      e.preventDefault();
      if (top.escape) closeLayer(top);
    }
  });
  sync(false);
}

// The rows of cards of a page scrolled sideways (Home's shelves, an album's "Altro di"), by their
// title: going back to the page finds them where they were left, as its own scroll.
function rowsOf(root) {
  const rows = {};
  for (const s of root.querySelectorAll('.shelf')) {
    if (s.closest('.view-leaving')) continue;
    const title = s.querySelector('.shelf-head h2');
    const row = s.querySelector('.shelf-row');
    if (title && row && row.scrollLeft > 0) rows[title.textContent] = row.scrollLeft;
  }
  return rows;
}

function putRows(root, rows) {
  for (const s of root.querySelectorAll('.shelf')) {
    if (s.closest('.view-leaving')) continue;
    const title = s.querySelector('.shelf-head h2');
    const row = s.querySelector('.shelf-row');
    const x = title && rows[title.textContent];
    if (row && x) row.scrollLeft = x;
  }
}

/** Renders the route of the address. motion: how the page changes (swap.js), null at once. */
function sync(restore, motion = null) {
  const p = pathNow();
  if (p === currentPath) return;
  if (currentPath != null && scroller) scrollMem.set(currentPath, { y: scroller.scrollTop, rows: rowsOf(scroller) });
  currentPath = p;
  const mem = restore ? scrollMem.get(p) : null;
  renderRoute(location.pathname, new URLSearchParams(location.search), mem ? mem.y : 0, motion);
  if (mem && scroller) putRows(scroller, mem.rows);
  markFresh(scroller);
}

/** Renders the current route again in place (the welcome gate changed, see app.js). */
export function rerender() {
  if (!renderRoute) return;
  currentPath = pathNow();
  renderRoute(location.pathname, new URLSearchParams(location.search), scroller?.scrollTop || 0);
  markFresh(scroller);
}

let backing = 0; // when goBack stepped the history back; cleared by the popstate

function onPop(e) {
  backing = 0;
  const depth = e.state?.ov || 0;
  // Forward to an entry moves as reaching it did; back undoes how the entry left was reached. An
  // entry that does not say is a step back.
  const n = typeof e.state?.n === 'number' ? e.state.n : null;
  const motion = n != null && n > entryN ? (e.state.k === 't' ? 'fade' : 'forward') : entryK === 't' ? 'fade' : 'back';
  if (n != null) {
    entryN = n;
    entryK = e.state.k === 't' ? 't' : 'd';
  }
  // A layer whose entry is not pushed yet is not in the history: no pop reaches it. Pushed ones
  // always sit below it.
  let live = layers.filter((l) => l.pushed).length;
  while (live > depth) {
    const [l] = layers.splice(live - 1, 1);
    live--;
    if (!l.closed) {
      l.closed = true;
      l.onClose();
    }
  }
  // Wake the closes whose history step is done (a close waits for its own depth, not any pop).
  for (let k = waiters.length - 1; k >= 0; k--) {
    if (depth <= waiters[k].depth) waiters.splice(k, 1)[0].finish();
  }
  if (!depth && depthInApp > 0 && pathNow() !== currentPath) depthInApp--;
  sync(true, motion);
}

/**
 * Go to an app path. Open layers are closed first (their history entries are popped). tab: reached
 * by a tab or the sidebar (a crossfade); a replace moves like a step back (the page it replaces is
 * gone for good) unless motion says otherwise.
 */
export async function navigate(path, { replace = false, tab = false, motion = null } = {}) {
  if (layers.length) await closeLayer(layers[0]);
  if (path === pathNow() && !replace) {
    scroller?.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  if (replace) history.replaceState({ r: 1, n: entryN, k: entryK }, '', path);
  else {
    entryN++;
    entryK = tab ? 't' : 'd';
    history.pushState({ r: 1, n: entryN, k: entryK }, '', path);
    depthInApp++;
  }
  sync(false, motion || (tab ? 'fade' : replace ? 'back' : 'forward'));
}

/**
 * Back inside the app if we came from another page of it, otherwise to Home. A double tap is one
 * step (on the arrow, or on "Annulla" that draws the arrow under the finger: the second tap lands
 * where the first did), and nothing goes back again while the step is on its way. A tap on the
 * arrow right after a tap somewhere else goes back.
 */
export function goBack() {
  if (sameSpotTap() || (backing && performance.now() - backing < 700)) return;
  if (depthInApp > 0) {
    backing = performance.now();
    history.back();
  } else navigate('/', { replace: true });
}

/** Updates the query string of the current page without rendering it again (search box). */
export function replaceQuery(path) {
  if (path === pathNow()) return;
  history.replaceState(history.state, '', path);
  currentPath = pathNow();
}

/** Resolves once no close is stepping the history back any more. */
function settled() {
  return inFlight.size ? Promise.all([...inFlight]).then(settled) : Promise.resolve();
}

/**
 * Opens a layer. onClose runs once, when the layer closes for any reason (back button, Escape,
 * navigation, layer.close()). escape: false keeps it open on Escape (a step that must be
 * answered). Returns { close(): Promise } resolved after the history settled.
 *
 * A close still on its way would step back over an entry pushed now (the history steps by count,
 * later): the entry is pushed once that close landed. Until then the layer is open on screen but
 * not in the history.
 */
export function openLayer(onClose, { escape = true } = {}) {
  const layer = { onClose, closed: false, closing: null, pushed: false, escape };
  layers.push(layer);
  const push = () => {
    if (layer.closed || layer.pushed) return;
    layer.pushed = true;
    history.pushState({ ov: layers.filter((l) => l.pushed).length, n: entryN, k: entryK }, '', location.href);
  };
  if (inFlight.size) settled().then(push);
  else push();
  return {
    close: () => closeLayer(layer),
    get closed() {
      return layer.closed;
    },
  };
}

/**
 * Closes a layer and every layer above it. The layers leave the stack at once, so a second close
 * before the popstate arrives (double click on the backdrop, Escape twice, a double tap on a menu
 * item) gets the same pending promise and never steps the history back a second time, which
 * would leave the page or, on Android, the app.
 */
function closeLayer(layer) {
  if (layer.closing) return layer.closing;
  const i = layers.indexOf(layer);
  if (i < 0) return Promise.resolve(); // already closed by a popstate
  const gone = layers.splice(i);
  const steps = gone.filter((l) => l.pushed).length;
  // Close the DOM right away for a snappy UI; the history catches up asynchronously.
  for (let k = gone.length - 1; k >= 0; k--) {
    const l = gone[k];
    if (!l.closed) {
      l.closed = true;
      l.onClose();
    }
  }
  if (!steps) {
    // Never pushed (it waited for an earlier close): nothing to take back from the history.
    const none = Promise.resolve();
    for (const l of gone) l.closing = none;
    return none;
  }
  const closing = new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    waiters.push({ depth: i, finish });
    history.go(-steps);
    setTimeout(finish, 700); // safety net if popstate never comes
  });
  inFlight.add(closing);
  closing.then(() => inFlight.delete(closing));
  for (const l of gone) l.closing = closing;
  return closing;
}

export const hasLayers = () => layers.length > 0;
