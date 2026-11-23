// Redrawing a view under the person's hands loses what they are doing: a shelf flung sideways
// starts again from its first card, a tap lands on the row that slid in. These helpers hold a
// redraw until the hands rest, and redraw only the parts of a view whose content changed, each
// part drawn again keeping the scroll offsets of its rows and the keyboard focus it held.
//
// The hands rest when no finger and no mouse button is down and no touch, wheel or scroll event
// came for QUIET_MS (a fling glides on with scroll events after the finger lifts).

const QUIET_MS = 200;
// A press whose end never arrived (the window lost it) stops holding after this long with no event.
const HELD_MAX_MS = 5000;

let fingers = 0;
let button = false;
let lastEvent = -Infinity;
const due = new Set();
let timer = 0;

/** Milliseconds until the hands rest (0: they do). */
function waitLeft() {
  const since = performance.now() - lastEvent;
  if ((fingers > 0 || button) && since < HELD_MAX_MS) return QUIET_MS;
  return since < QUIET_MS ? Math.ceil(QUIET_MS - since) : 0;
}

function check() {
  clearTimeout(timer);
  timer = 0;
  if (!due.size) return;
  const left = waitLeft();
  if (left > 0) {
    timer = setTimeout(check, left);
    return;
  }
  const fns = [...due];
  due.clear();
  for (const fn of fns) {
    try {
      fn();
    } catch (err) {
      console.error('settled redraw', err);
    }
  }
}

function moved() {
  lastEvent = performance.now();
  if (due.size && !timer) timer = setTimeout(check, QUIET_MS);
}

if (typeof window !== 'undefined') {
  const opts = { capture: true, passive: true };
  const touches = (e) => {
    fingers = e.touches ? e.touches.length : 0;
    moved();
  };
  const press = (down) => (e) => {
    if (e.pointerType !== 'touch') button = down;
    moved();
  };
  window.addEventListener('touchstart', touches, opts);
  window.addEventListener('touchend', touches, opts);
  window.addEventListener('touchcancel', touches, opts);
  window.addEventListener('touchmove', moved, opts);
  window.addEventListener('pointerdown', press(true), opts);
  window.addEventListener('pointerup', press(false), opts);
  window.addEventListener('pointercancel', press(false), opts);
  window.addEventListener('wheel', moved, opts);
  window.addEventListener('scroll', moved, opts);
  window.addEventListener('blur', () => {
    fingers = 0;
    button = false;
  });
}

/** True when the hands rest. */
export const settled = () => waitLeft() === 0;

/**
 * Wraps fn: a call while the hands rest runs fn at once; a call while they do not runs it once,
 * when they do (the calls in between make one run). call.cancel() drops a run still waiting.
 */
export function whenSettled(fn) {
  const call = () => {
    if (waitLeft() === 0) {
      due.delete(fn);
      fn();
      return;
    }
    due.add(fn);
    if (!timer) timer = setTimeout(check, waitLeft());
  };
  call.cancel = () => {
    due.delete(fn);
  };
  return call;
}

/** The scroll offsets of `root` and of the elements under it matching `rows`, in order. */
export function offsetsOf(root, rows) {
  const els = root.matches && root.matches(rows) ? [root] : [];
  return els.concat([...root.querySelectorAll(rows)]).map((e) => [e.scrollLeft, e.scrollTop]);
}

/** Gives the rows of `root` the offsets taken with offsetsOf, in order (as far as they reach). */
export function applyOffsets(root, rows, offs) {
  const els = (root.matches && root.matches(rows) ? [root] : []).concat([...root.querySelectorAll(rows)]);
  els.forEach((e, i) => {
    const o = offs[i];
    if (!o) return;
    if (o[0] && e.scrollLeft !== o[0]) e.scrollLeft = o[0];
    if (o[1] && e.scrollTop !== o[1]) e.scrollTop = o[1];
  });
}

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]';
const focusables = (root) => (root.matches && root.matches(FOCUSABLE) ? [root] : []).concat([...root.querySelectorAll(FOCUSABLE)]);
/** What tells a focusable element from the others: its kind, link, label and the song row it is in. */
function focusKey(e) {
  const row = e.closest('[data-tid]');
  return [e.tagName, e.getAttribute('href'), e.getAttribute('aria-label') || e.textContent.trim().slice(0, 80), row ? row.getAttribute('data-tid') : ''].join('|');
}

/**
 * Runs draw(), which draws `root` again (in place, or as the element target() returns), and gives
 * back the keyboard focus it held: to the element drawn for the same thing (kind, link, label),
 * else to the one at the same place. Nothing scrolls for it.
 */
export function keepFocus(root, draw, target = () => root) {
  const a = document.activeElement;
  if (!a || a === document.body || !root.contains(a)) {
    draw();
    return;
  }
  const key = focusKey(a);
  const at = focusables(root).indexOf(a);
  draw();
  const now = document.activeElement;
  if (now && now !== document.body && now.isConnected) return;
  const to = target();
  if (!to || !to.isConnected) return;
  const all = focusables(to);
  const el = all.find((x) => focusKey(x) === key) || all[Math.min(at, all.length - 1)];
  if (el) el.focus({ preventScroll: true });
}

/**
 * Brings the children of `parent` to `parts` ([{ key, sig, build }], in order), touching only what
 * changed: a child with the same key and sig stays as it is (its scroll offsets and a fling in
 * progress with it); one whose sig changed is built again in its place, and its rows (matching
 * `rows`) take the offsets of the old ones unless carry is false, the keyboard focus it held its
 * new drawing; a child no part names goes. build() returns the part's element. Returns true when
 * something changed.
 */
export function patchParts(parent, parts, { rows = '.shelf-row', carry = true } = {}) {
  let changed = false;
  const old = new Map();
  for (const c of [...parent.childNodes]) {
    if (c.__part != null && !old.has(c.__part)) old.set(c.__part, c);
    else {
      c.remove();
      changed = true;
    }
  }
  const named = new Set(parts.map((p) => p.key));
  for (const [k, c] of old) {
    if (named.has(k)) continue;
    c.remove();
    old.delete(k);
    changed = true;
  }
  let prev = null;
  for (const p of parts) {
    let node = old.get(p.key);
    if (!node || node.__sig !== p.sig) {
      const fresh = p.build();
      fresh.__part = p.key;
      fresh.__sig = p.sig;
      if (node) {
        const was = node;
        const offs = carry ? offsetsOf(was, rows) : null;
        keepFocus(
          was,
          () => {
            was.replaceWith(fresh);
            if (offs) applyOffsets(fresh, rows, offs);
          },
          () => fresh
        );
      }
      node = fresh;
      changed = true;
    }
    const want = prev ? prev.nextSibling : parent.firstChild;
    if (node !== want) parent.insertBefore(node, want);
    prev = node;
  }
  return changed;
}
