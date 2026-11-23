// A long press: a finger held still on something for half a second, or a right click with a mouse
// (the browser's 'contextmenu'), opens our own menu of it, never the browser's.
//
// The finger is timed here (a WebView does not always turn a held finger into a 'contextmenu', and
// on text it would start a selection instead): it counts when it stays within a few pixels, alone,
// for LONG_MS; the lift that ends it is not a tap on what it was held on. A finger that lands on a
// list still gliding after a fling stops it; held there, it is not a long press on the row it
// stopped on: a press that began while the page was scrolling opens nothing, nor one the page
// scrolled under. A press older than what it is on (the row was drawn under the finger) opens
// nothing either.
//
// One press opens one menu. The WebView sends its own 'contextmenu' for the same finger at the
// system's long press time (on Android 400 ms, 1 s or 1.5 s, as the user set it), so before our
// timer or after it; some browsers send it on the lift, some never. Whichever comes first opens the
// menu, and the rest of that press opens nothing.
//
// What a long press is on gets the class long-press (styles.css): no text selection starts under
// the finger, nor the system's own callout. A long list (its rows drawn and dropped as it scrolls)
// takes one set of listeners for all its rows, on the list itself (onLongPressIn): the list gets
// the class, so every row in it, drawn now or later, is covered; a finger that leaves its row (it
// moves out of the row's box, or onto another row) ends the press as leaving the element does.

import { staleTap } from './dom.js';

const LONG_MS = 500;
const SLOP_PX = 10;
const SCROLL_QUIET_MS = 150;
// A context menu with no press of its own (the keyboard's menu key) is never a press on a list.
const PRESS_MS = 3000;
// The browser's 'contextmenu' and click of a press still belong to it this long after its lift.
const AFTER_LIFT_MS = 1000;
let lastScroll = -Infinity;
let pressAt = -Infinity;
let pressScrolled = false;
let active = null; // the finger being timed now: { id, cancel }

if (typeof window !== 'undefined') {
  window.addEventListener('scroll', () => (lastScroll = performance.now()), { capture: true, passive: true });
  const down = () => {
    pressAt = performance.now();
    pressScrolled = pressAt - lastScroll < SCROLL_QUIET_MS;
  };
  window.addEventListener('pointerdown', down, { capture: true, passive: true });
  window.addEventListener('touchstart', down, { capture: true, passive: true });
  // A second finger anywhere is a pinch, not a press.
  window.addEventListener(
    'pointerdown',
    (e) => {
      if (active && e.pointerId !== active.id) active.cancel();
    },
    { capture: true, passive: true }
  );
}

/** The press under way began on a moving list, or the list moved under it. */
const scrolledPress = () => performance.now() - pressAt < PRESS_MS && (pressScrolled || lastScroll > pressAt);

/** fn(event) on a long press or a right click on el (never for a press that landed on a moving list). */
export function onLongPress(el, fn) {
  el.classList.add('long-press');
  watch(el, null, (row, e) => fn(e));
}

/**
 * fn(row, event) on a long press or a right click on an element matching `selector` inside box (a
 * row of a long list), with the listeners on box alone: rows drawn later need nothing of their own.
 */
export function onLongPressIn(box, selector, fn) {
  box.classList.add('long-press');
  watch(box, selector, fn);
}

/** The press rules on box: on box itself (selector null), or on its elements matching selector. */
function watch(box, selector, fn) {
  let timer = 0;
  let start = null;
  // The finger's press: { id, opened, up (when it was lifted, -1 while held), on (what it is on) }.
  let press = null;
  const cancel = () => {
    clearTimeout(timer);
    timer = 0;
    start = null;
    if (active && active.cancel === cancel) active = null;
  };
  /** What an event is on: box itself, or the element of box matching selector it is in (else null). */
  const onWhat = (e) => {
    if (!selector) return box;
    const t = e.target && e.target.closest ? e.target.closest(selector) : null;
    return t && box.contains(t) ? t : null;
  };
  /** The press held now, or lifted just now; null for none. */
  const current = () => (press && (press.up < 0 || performance.now() - press.up < AFTER_LIFT_MS) ? press : null);
  /** This press already opened the menu. */
  const opened = () => !!current() && press.opened;
  const open = (e) => {
    const p = current();
    if (p) p.opened = true;
    fn(onWhat(e) || (p && p.on) || box, e);
  };
  box.addEventListener('pointerdown', (e) => {
    cancel();
    if (e.pointerType === 'mouse' || !e.isPrimary) return;
    const el = onWhat(e);
    press = el ? { id: e.pointerId, opened: false, up: -1, on: el } : null;
    if (!el) return;
    if (pressScrolled) return;
    start = { id: e.pointerId, x: e.clientX, y: e.clientY };
    active = { id: e.pointerId, cancel };
    const ev = e;
    timer = setTimeout(() => {
      timer = 0;
      start = null;
      active = null;
      if (scrolledPress() || staleTap(el)) return;
      open(ev);
    }, LONG_MS);
  });
  box.addEventListener('pointermove', (e) => {
    if (!start || e.pointerId !== start.id) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > SLOP_PX) cancel();
    else if (selector && press && (!inside(press.on, e) || onWhat(e) !== press.on)) cancel();
  });
  const lift = (e) => {
    cancel();
    if (press && e.pointerId === press.id) press.up = performance.now();
  };
  box.addEventListener('pointerup', lift);
  box.addEventListener('pointercancel', lift);
  // The finger leaves the element (on a list: its row, seen by its moves, see pointermove).
  if (!selector) {
    box.addEventListener('pointerleave', (e) => {
      if (start && e.pointerId === start.id) cancel();
    });
  }
  // The lift of a long press is not a tap on what it was held on, however long it was held.
  box.addEventListener(
    'click',
    (e) => {
      if (!opened()) return;
      e.preventDefault();
      e.stopPropagation();
    },
    true
  );
  box.addEventListener('contextmenu', (e) => {
    const el = onWhat(e);
    if (!el) return;
    e.preventDefault();
    // This press already opened it: our timer came first (the browser's comes later, or on the lift).
    if (opened()) return;
    // The browser's long press came first: it is this press's one, the timer opens nothing more.
    cancel();
    if (scrolledPress() || staleTap(el)) return;
    open(e);
  });
}

/** The pointer of e is still on el: within its box (rows of a list never overlap). */
function inside(el, e) {
  const r = el.getBoundingClientRect();
  return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
}
