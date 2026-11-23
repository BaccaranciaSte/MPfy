// Tiny DOM helpers. All user data goes in through textContent (never innerHTML), so track titles
// cannot inject markup. Only our own SVG icons use innerHTML, via the "html" prop.

import { icon } from '../icons/icons.js';

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') {
        if (typeof v === 'string') el.style.cssText = v;
        else for (const sk in v) {
          if (sk.startsWith('--')) el.style.setProperty(sk, v[sk]);
          else el.style[sk] = v[sk];
        }
      } else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'html') el.innerHTML = v; // trusted markup only (icons)
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value' || k === 'checked') el[k] = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  addKids(el, kids);
  return el;
}

function addKids(el, kids) {
  for (const k of kids) {
    if (k == null || k === false || k === true) continue;
    if (Array.isArray(k)) addKids(el, k);
    else el.append(k instanceof Node ? k : String(k));
  }
}

export function iconBtn(name, label, onClick, { cls = '', size = 24, pressed } = {}) {
  const b = h('button', { type: 'button', class: `icon-btn ${cls}`.trim(), 'aria-label': label, title: label }, icon(name, size));
  if (onClick) b.addEventListener('click', onClick);
  if (pressed != null) b.setAttribute('aria-pressed', String(!!pressed));
  return b;
}

/** Small round separator drawn in CSS (no Unicode bullet glyphs in the UI). */
export const sep = () => h('span', { class: 'sep', 'aria-hidden': 'true' });

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
export const prefersReducedMotion = () => reducedMotion.matches;

/**
 * Turns a ".mq" box (one child span) into a marquee when its text does not fit, like the title of
 * a player. Otherwise the text is simply ellipsized.
 */
export function fitMarquee(box) {
  if (!box) return;
  box.classList.remove('mq-on');
  if (reducedMotion.matches) return;
  requestAnimationFrame(() => {
    const span = box.firstElementChild;
    if (!span || !box.clientWidth) return;
    const over = span.scrollWidth - box.clientWidth;
    if (over > 2) {
      box.style.setProperty('--mq-dist', `${-over}px`);
      box.style.setProperty('--mq-dur', `${Math.max(4, over / 28 + 3).toFixed(1)}s`);
      box.classList.add('mq-on');
    }
  });
}

export function marqueeBox(cls) {
  return h('div', { class: `mq ${cls}` }, h('span'));
}

export function setMarqueeText(box, text) {
  const span = box.firstElementChild;
  if (span.textContent !== text) {
    span.textContent = text;
    fitMarquee(box);
  }
}

/** Renders a long list in chunks, adding more as the user scrolls near the end. */
export function renderChunked(container, items, renderItem, { chunk = 80, root = null } = {}) {
  let i = 0;
  let observer = null;
  const sentinel = h('div', { class: 'chunk-sentinel', 'aria-hidden': 'true' });
  const more = () => {
    const end = Math.min(items.length, i + chunk);
    const frag = document.createDocumentFragment();
    for (; i < end; i++) frag.append(renderItem(items[i], i));
    sentinel.before(frag);
    if (i >= items.length) {
      observer?.disconnect();
      sentinel.remove();
    }
  };
  container.append(sentinel);
  more();
  if (i < items.length && 'IntersectionObserver' in window) {
    observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) more();
    }, { root, rootMargin: '800px 0px' });
    observer.observe(sentinel);
  } else if (i < items.length) {
    while (i < items.length) more();
  }
  return () => observer?.disconnect();
}

/** replaceChildren without the null and false children (the DOM would write them as text). */
export function put(el, ...kids) {
  el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false && k !== true));
}

// ---- taps that belong to an earlier gesture ----
// Presses less than GESTURE_GAP_MS apart (press to press) make one gesture: a double or triple
// tap. What a gesture opened, closed or drew again does not take the rest of it: the second tap
// of a double tap on "..." does nothing on the sheet that slid up under the finger, and a tap
// released after a dialog appeared under it does not press its button. A tap pressed
// GESTURE_GAP_MS or more after the previous press is a new gesture and always counts (so does a
// tap after a long press). A tap whose control was drawn again as another one under the finger
// does nothing. Keyboard and script clicks (detail 0) are never held back. (A tap on a list still
// gliding after a fling only stops it: the browser already drops it.) Presses are timed by the
// event's own time stamp, when the finger touched: a page still busy with the first tap of a
// double tap gets the second press late, and that must not split the double tap in two.

const GESTURE_GAP_MS = 400;
const SAME_SPOT_PX = 40; // two taps this close are one finger tapping twice
const marks = new WeakMap(); // element -> when it appeared, closed over or changed
let gesture = 0;
let gestureAt = -Infinity;
let lastTap = { gesture: 0, x: 0, y: 0 }; // where the last click let through landed
let sameSpot = false; // the click being handled landed where the previous one of its gesture did
let pressAt = -Infinity; // when the last press touched (its time stamp)
let downAt = -Infinity; // when the page got the last press and lift
let upAt = -Infinity;
let down = false;
let pressId = null; // the pointer of the press under way
let downEl = null;
let downWhat = '';
let current = null; // the tap whose click is being handled now
let lastRepeat = { key: null, gesture: 0 };
let again = null; // { gesture, x, y, fn }: the later taps of that gesture on that spot run fn

/** When e happened: its time stamp when the browser gives a usable one, else now. */
function stamp(e) {
  const now = performance.now();
  return e.timeStamp > now - 1000 && e.timeStamp <= now ? e.timeStamp : now;
}

/** The control a press is on, by its label: a control drawn again the same way is the same one. */
function what(el) {
  const c = el && el.closest ? el.closest('button, a, input, select, textarea, label, [role=button], [role=menuitem], [role=switch], [role=radio]') : null;
  return c ? `${c.tagName}|${c.getAttribute('aria-label') || c.textContent.trim().slice(0, 80)}` : '';
}

function markedSince(el, t) {
  for (let n = el; n; n = n.parentNode) {
    const at = marks.get(n);
    if (at !== undefined && at > t) return true;
  }
  return false;
}

/** el (by default the whole page) appeared, was uncovered or changed: the gesture under way does nothing in it. */
export function markFresh(el = document.documentElement) {
  if (el) marks.set(el, performance.now());
}

/** True while a press (or the one just lifted) belongs to a gesture older than el. */
export function staleTap(el) {
  const now = performance.now();
  if (down ? now - downAt > 10000 : now - upAt > 100) return false;
  return markedSince(el, gestureAt);
}

/** True for a later tap of a gesture on the spot of the tap before it (the rest of a double tap); false for keyboard and script clicks. */
export const sameSpotTap = () => !!current && sameSpot;

/** True for a later tap of the same gesture on the same key: a double tap on play does not start and stop. */
export function repeatTap(key) {
  if (!current) return false;
  if (lastRepeat.key === key && lastRepeat.gesture === gesture) return true;
  lastRepeat = { key, gesture };
  return false;
}

/**
 * The control being tapped moves away from under the pointer (the page makes room beside it): the
 * later taps of the same gesture on the spot where it was run fn instead of pressing whatever is
 * there now, so a double click on it is two clicks on it, wherever it went. Keyboard and script
 * clicks set nothing.
 */
export function sameSpotAgain(fn) {
  again = current ? { gesture, x: current.clientX, y: current.clientY, fn } : null;
}

/**
 * fn that does nothing while its previous call is still running (a request, a picker, a dialog).
 * keyOf (of the same arguments) makes that per thing: one call at a time for each key.
 */
export function oneAtATime(fn, keyOf = () => '') {
  const busy = new Set();
  return async (...args) => {
    const key = keyOf(...args);
    if (busy.has(key)) return undefined;
    busy.add(key);
    try {
      return await fn(...args);
    } finally {
      busy.delete(key);
    }
  };
}

// The press is the first pointer down; a second finger during it is not a press of its own.
window.addEventListener(
  'pointerdown',
  (e) => {
    if (down && !e.isPrimary) return;
    pressId = e.pointerId;
    const at = stamp(e);
    if (at - pressAt >= GESTURE_GAP_MS) {
      gesture++;
      gestureAt = at;
    }
    pressAt = at;
    down = true;
    downAt = performance.now();
    downEl = e.target;
    downWhat = what(e.target);
  },
  true
);
const lift = (e) => {
  if (!down || e.pointerId !== pressId) return;
  down = false;
  upAt = performance.now();
};
window.addEventListener('pointerup', lift, true);
window.addEventListener('pointercancel', lift, true);
// Only a click that ends the press just seen is judged: keyboard and script clicks (detail 0) and
// a click whose press went unseen are left alone.
window.addEventListener(
  'click',
  (e) => {
    if (!e.detail || down || performance.now() - upAt > 1000) return;
    if (again && again.gesture === gesture && Math.hypot(e.clientX - again.x, e.clientY - again.y) <= SAME_SPOT_PX) {
      e.preventDefault();
      e.stopImmediatePropagation();
      again.fn();
      return;
    }
    const moved = !!downEl && !downEl.isConnected && what(e.target) !== downWhat;
    if (moved || markedSince(e.target, gestureAt)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    sameSpot = lastTap.gesture === gesture && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) <= SAME_SPOT_PX;
    lastTap = { gesture, x: e.clientX, y: e.clientY };
    current = e;
    setTimeout(() => {
      if (current === e) current = null;
    }, 0);
  },
  true
);
