// A long list drawn as a window: only the rows near the screen are in the page, a spacer above and
// below them stands for the rest, so the list is as tall as all its rows from the first frame
// (items x the row height) and a page put back at its scroll offset finds it.
//
//   const list = vlist({ scroller, cls, rowKind, items, keyOf, sigOf, renderRow });
//   parent.append(list.el); ... list.mounted();   // once the list is in the page
//   list.update(items);                            // the list changed
//
// The row height comes from CSS: the custom property --vrow-<rowKind> on the root element (styles.css
// gives every row of that kind that height). It is read with getComputedStyle of the root, which
// works while the list is not in the page yet, and again on resize; a row is never measured.
//
// The rows drawn: those on screen plus one screen above and one below (overscanScreens). A scroll
// asks for one animation frame, which moves the window only when it moved by STEP_ROWS rows or
// more, so the rows come and go a screen away from the finger, never under it. The rows on screen
// are drawn in that frame; those of the window off screen at most NEW_ROWS a frame, nearest first
// (the way the list moves), the next ones in the next frames: a fling costs every frame a little,
// none of them a whole step. Rows are keyed: a row whose key stays in the window stays the same
// element, untouched; update() draws again in its place only a row whose signature changed (the
// keyboard focus kept), and touches nothing when the rows drawn are the same. Some rows are never
// taken away while they matter: the row holding the
// keyboard focus, and the row last pressed or clicked (a long press under way, the row whose menu
// is open, the row being dragged); one of them out of the window is drawn in its place, with
// spacers around it.
//
// The first window is drawn by mounted(), which the page calls right after the list went into the
// page and before the first frame (app.js render()); a list nobody tells is drawn in the first
// animation frame after it went in. Rows carry aria-setsize and aria-posinset (the list is
// role="list"), so a screen reader still says where a row is; find in page reaches only the rows
// drawn (Search finds a song). Every row drawn carries data-i, its index in the list (sortable.js
// moves rows by it).

import { h } from './dom.js';
import { keepFocus } from './settle.js';

// The window moves by at least this many rows (a smaller move keeps the rows drawn).
const STEP_ROWS = 4;
// The keyboard focus this close to an end of the window grows it, so Tab finds the next row.
const EDGE_ROWS = 3;
// Rows off screen drawn in one frame while the list scrolls.
const NEW_ROWS = 2;

/** The row height of a kind, from --vrow-<kind> on the root element (in px). */
export function rowHeight(kind) {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(`--vrow-${kind}`));
  return v > 0 ? v : 60;
}

// One scroll listener and one animation frame per scroller, whatever the number of lists on it.
const groups = new Map(); // scroller -> { lists: Set, raf, onScroll }

function join(sc, list) {
  let g = groups.get(sc);
  if (!g) {
    g = { lists: new Set(), raf: 0, onScroll: null };
    g.onScroll = () => {
      if (g.raf) return;
      g.raf = requestAnimationFrame(() => {
        g.raf = 0;
        for (const l of [...g.lists]) l.step();
      });
    };
    sc.addEventListener('scroll', g.onScroll, { passive: true });
    groups.set(sc, g);
  }
  g.lists.add(list);
}

function leave(sc, list) {
  const g = groups.get(sc);
  if (!g) return;
  g.lists.delete(list);
  if (g.lists.size) return;
  sc.removeEventListener('scroll', g.onScroll);
  cancelAnimationFrame(g.raf);
  groups.delete(sc);
}

const sized = new Set(); // every list in the page, for resize
if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => {
    for (const l of [...sized]) l.resized();
  });
}

const isDoc = (sc) => sc === document.scrollingElement || sc === document.documentElement || sc === document.body;

/**
 * scroller: the element that scrolls (or a function giving it); cls: classes of the list element;
 * rowKind: the CSS row height used (--vrow-<rowKind>); keyOf(item, i), sigOf(item, i): what tells a
 * row from the others, and what it shows (two rows with the same signature look the same);
 * renderRow(item, i): a new row element; mark(row): what refreshMarks() does to every row drawn.
 */
export function vlist({ scroller, cls = '', rowKind = 'track', items = [], keyOf, sigOf, renderRow, overscanScreens = 1, mark = null }) {
  const el = h('div', { class: `vlist ${cls}`.trim(), role: 'list' });
  const scrollerEl = () => (typeof scroller === 'function' ? scroller() : scroller);
  let list = items || [];
  let gen = 0; // moves at each update: a row's signature is asked again once per update at most
  let H = rowHeight(rowKind);
  let rows = new Map(); // key -> { el, key, sig, i, gen, pos, size }: the rows drawn
  const recOf = new WeakMap(); // row element -> its record
  const spacers = [];
  let a = 0; // the window: rows [a, b)
  let b = 0;
  let da = 0; // the rows of the window drawn so far: [da, db), the rows on screen always among them
  let db = 0;
  let vis = [0, 0]; // the rows on screen at the last look
  let from = 0; // where the screen was in the list at the last look, and the way it moved
  let dir = 1;
  let more = 0; // the frame asked to draw more of the window
  let live = false; // in the page and following its scroller
  let dead = false;
  let sc = null;
  let pinLast = null; // the key of the row last pressed or clicked

  /** The part of the list on screen, in px from the list's top: { from, to, height }; null off the page. */
  function viewport() {
    const s = sc || scrollerEl();
    if (!s || !el.isConnected) return null;
    const doc = isDoc(s);
    const top = doc ? 0 : s.getBoundingClientRect().top;
    const height = doc ? innerHeight : s.clientHeight;
    const off = el.getBoundingClientRect().top - top;
    return { from: -off, to: height - off, height };
  }

  const clampN = (x) => Math.max(0, Math.min(list.length, x));

  /** The window a viewport asks for, moved only by STEP_ROWS or more while it still covers the screen. */
  function windowFor(v) {
    const over = v.height * overscanScreens;
    const lo = clampN(Math.floor((v.from - over) / H));
    const hi = clampN(Math.ceil((v.to + over) / H));
    const vlo = clampN(Math.floor(v.from / H));
    const vhi = clampN(Math.ceil(v.to / H));
    const ca = clampN(a);
    const cb = clampN(b);
    const n = list.length;
    // Kept while it covers the screen and is near enough; an end of the list in reach is always drawn.
    const near = Math.abs(lo - ca) < STEP_ROWS && Math.abs(hi - cb) < STEP_ROWS && (hi < n || cb === n) && (lo > 0 || ca === 0);
    if (vlo >= ca && vhi <= cb && near) return [ca, cb];
    return [lo, hi];
  }

  function spacer(k, px) {
    let sp = spacers[k];
    if (!sp) {
      sp = h('div', { class: 'vspace', 'aria-hidden': 'true' });
      sp.__h = -1;
      spacers[k] = sp;
    }
    if (sp.__h !== px) {
      sp.style.height = `${px}px`;
      sp.__h = px;
    }
    return sp;
  }

  /** The row element holding node (a child of the list), or null. */
  function rowOfNode(node) {
    let n = node;
    while (n && n.parentNode !== el) n = n.parentNode;
    return n && recOf.has(n) ? n : null;
  }

  /** Where the item with this key is now, or -1. */
  function indexOfKey(key) {
    const rec = rows.get(key);
    if (rec && rec.i < list.length && keyOf(list[rec.i], rec.i) === key) return rec.i;
    for (let i = 0; i < list.length; i++) if (keyOf(list[i], i) === key) return i;
    return -1;
  }

  /** The keys of the rows that stay drawn wherever the window is. */
  function pinnedKeys() {
    const out = [];
    const f = document.activeElement;
    if (f && f !== document.body && el.contains(f)) {
      const r = rowOfNode(f);
      if (r) out.push(recOf.get(r).key);
    }
    if (pinLast != null && !out.includes(pinLast)) out.push(pinLast);
    return out;
  }

  function rowAt(i, next) {
    const item = list[i];
    let key = keyOf(item, i);
    // Two items with one key (they should not): the second is drawn as its own row.
    if (next.has(key)) key = `${key}|#${i}`;
    let rec = rows.get(key);
    // A scroll alone changes no row: the signature is asked only after an update or a move.
    if (!rec || rec.gen !== gen || rec.i !== i) {
      const sig = sigOf(item, i);
      if (!rec || rec.sig !== sig) {
        const row = renderRow(item, i);
        // An item of the list, unless the row is a link or a button (it keeps what it is).
        if (!row.hasAttribute('role') && row.tagName !== 'A' && row.tagName !== 'BUTTON') row.setAttribute('role', 'listitem');
        rec = { el: row, key, sig, i, gen, pos: 0, size: 0 };
        recOf.set(row, rec);
      } else {
        rec.i = i;
        rec.gen = gen;
      }
    }
    const n = list.length;
    if (rec.pos !== i + 1) {
      rec.el.setAttribute('aria-posinset', String(i + 1));
      rec.el.setAttribute('data-i', String(i));
      rec.pos = i + 1;
    }
    if (rec.size !== n) {
      rec.el.setAttribute('aria-setsize', String(n));
      rec.size = n;
    }
    next.set(key, rec);
    return rec.el;
  }

  /** Puts the nodes of `want` in the list, in order, moving and removing only what must. */
  function place(want) {
    const keep = new Set(want);
    for (let c = el.firstChild; c; ) {
      const nx = c.nextSibling;
      if (!keep.has(c)) el.removeChild(c);
      c = nx;
    }
    let cur = el.firstChild;
    for (const node of want) {
      if (node === cur) cur = cur.nextSibling;
      else el.insertBefore(node, cur);
    }
  }

  /**
   * Draws the window [a, b) and the pinned rows, the spacers between them. paced (a scroll): the
   * rows on screen, those of the window drawn already that touch them, and NEW_ROWS more toward the
   * window's ends, the way the list moves first; another frame draws the next ones.
   */
  function draw(paced = false) {
    const n = list.length;
    a = clampN(a);
    b = clampN(b);
    let lo = live ? a : 0;
    let hi = live ? b : 0;
    if (live && paced) {
      lo = Math.max(a, Math.min(vis[0], b));
      hi = Math.max(lo, Math.min(vis[1], b));
      const ka = Math.max(a, da);
      const kb = Math.min(b, db);
      if (ka < kb && ka <= hi && kb >= lo) {
        lo = Math.min(lo, ka);
        hi = Math.max(hi, kb);
      }
      for (let left = NEW_ROWS; left > 0 && (lo > a || hi < b); left--) {
        if ((dir > 0 && hi < b) || lo <= a) hi++;
        else lo--;
      }
    }
    da = lo;
    db = hi;
    const idx = [];
    for (let i = lo; i < hi; i++) idx.push(i);
    if (live) {
      const extra = [];
      for (const k of pinnedKeys()) {
        const i = indexOfKey(k);
        if (i >= 0 && (i < lo || i >= hi) && !extra.includes(i)) extra.push(i);
        else if (i < 0 && k === pinLast) pinLast = null;
      }
      if (extra.length) {
        idx.push(...extra);
        idx.sort((x, y) => x - y);
      }
    }
    const next = new Map();
    const want = [];
    let prev = 0;
    let k = 0;
    for (const i of idx) {
      if (i > prev) want.push(spacer(k++, (i - prev) * H));
      want.push(rowAt(i, next));
      prev = i + 1;
    }
    if (n > prev) want.push(spacer(k++, (n - prev) * H));
    rows = next;
    keepFocus(el, () => {
      const f = document.activeElement;
      place(want);
      // A row moved in the list loses the focus it held: it gets it back, without a scroll.
      if (f && f !== document.body && f.isConnected && document.activeElement !== f && el.contains(f)) f.focus({ preventScroll: true });
    });
    if (live && (da > a || db < b) && !more) {
      more = requestAnimationFrame(() => {
        more = 0;
        api.step();
      });
    }
  }

  /** Where the screen is in the list: the rows on it, and the way the list moved. */
  function look(v) {
    vis = [clampN(Math.floor(v.from / H)), clampN(Math.ceil(v.to / H))];
    if (v.from !== from) dir = v.from > from ? 1 : -1;
    from = v.from;
  }

  /** A frame after a scroll: the window follows when it moved enough, its rows a few at a time. */
  function step() {
    if (!live || dead) return;
    const v = viewport();
    if (!v) return;
    look(v);
    const [lo, hi] = windowFor(v);
    if (lo === a && hi === b && da === a && db === b) return;
    a = lo;
    b = hi;
    draw(true);
  }

  function mounted() {
    if (dead) return;
    const s = scrollerEl();
    if (!s || !el.isConnected) return;
    if (!live) {
      live = true;
      sc = s;
      join(sc, api);
      sized.add(api);
    }
    H = rowHeight(rowKind);
    const v = viewport();
    if (v) {
      look(v);
      [a, b] = windowFor(v);
    }
    draw();
  }

  // The row pressed or clicked last stays drawn (a long press under way, its menu, a drag).
  const note = (e) => {
    const r = rowOfNode(e.target);
    if (r) pinLast = recOf.get(r).key;
  };
  el.addEventListener('pointerdown', note, { capture: true, passive: true });
  el.addEventListener('click', note, true);
  // The focus near an end of the window grows it before the next Tab, so Tab walks row by row.
  el.addEventListener('focusin', (e) => {
    if (!live) return;
    const r = rowOfNode(e.target);
    if (!r) return;
    const i = recOf.get(r).i;
    if (i < da || i >= db) return;
    if (i + EDGE_ROWS < db && i - EDGE_ROWS >= da) return;
    a = clampN(Math.min(a, i - EDGE_ROWS));
    b = clampN(Math.max(b, i + EDGE_ROWS + 1));
    draw();
  });

  const api = {
    el,
    mounted,
    /** The list now (the same keys and signatures in the window: nothing is touched). */
    update(next) {
      list = next || [];
      gen++;
      if (dead) return;
      if (!live && el.isConnected) {
        mounted();
        return;
      }
      if (live) {
        const v = viewport();
        if (v) {
          look(v);
          [a, b] = windowFor(v);
        }
      }
      draw();
    },
    /** The marks of every row drawn (the current track, downloaded). */
    refreshMarks() {
      if (mark) for (const rec of rows.values()) mark(rec.el);
    },
    destroy() {
      dead = true;
      cancelAnimationFrame(more);
      if (live) {
        leave(sc, api);
        sized.delete(api);
      }
      live = false;
    },
    step,
    resized() {
      if (!live || dead) return;
      const was = H;
      H = rowHeight(rowKind);
      if (H !== was) {
        const v = viewport();
        if (v) {
          look(v);
          [a, b] = windowFor(v);
        }
        draw();
      } else step();
    },
  };

  // The total height before anything else: no rows yet, one spacer for all of them.
  draw();
  // A list nobody tells it is in the page: the first frame after it went in draws it.
  requestAnimationFrame(() => {
    if (!live && !dead && el.isConnected) mounted();
  });
  return api;
}
