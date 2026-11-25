// Cover art: a single image, the 2x2 playlist mosaic, the "Brani che ti piacciono" gradient
// with a heart, or a placeholder with a music note.
//
// Covers follow their priority (custom track cover, else custom album cover, else the embedded one;
// playlists: custom cover, else the mosaic), resolved by the store. Lists load ?size=small;
// the cards of the grids and headers ?size=large; Now Playing ?size=xl (1280 px: on a phone it is
// about 1100 px wide), with the large one when a source does not know xl: coverEl(spec, { size }).
// A mosaic's four pieces follow the holder too (a 232 px header is four 116 px pieces, more
// than the small 160 px image on a phone), unless the holder says otherwise with tiles.

import { h } from '../js/dom.js';
import { icon } from '../icons/icons.js';
import { coverHref } from '../js/media.js';
import { store } from '../js/store.js';
import { sources } from '../js/sources.js';

const img1 = (c) => ({ kind: 'img', id: c.id, small: c.small });

/**
 * Cover descriptions: { kind: 'img', id, small, via? } | { kind: 'mosaic', ids, large } |
 * { kind: 'liked' } | { kind: 'ph', icon } (via: the sources that hold a cover your libraries do not
 * know; a mosaic's ids are the small images, large the same four as large ones).
 */
export const specs = {
  track(t) {
    const c = t && store.d.trackCover.get(t.id);
    return c ? img1(c) : { kind: 'ph', icon: 'note' };
  },
  album: (al) => (al?.cover ? img1(al.cover) : { kind: 'ph', icon: 'album' }),
  artist: (ar) => (ar?.cover ? img1(ar.cover) : { kind: 'ph', icon: 'artist' }),
  liked: () => ({ kind: 'liked' }),
  /** A custom cover, else the first four distinct album covers as a mosaic, else the single one. */
  playlist(pl) {
    const d = store.d;
    const own = pl && d.playlistCover.get(pl.id);
    if (own) return img1(own);
    const seen = new Set();
    const found = [];
    for (const tid of pl?.trackIds || []) {
      const c = d.trackCover.get(tid);
      if (!c) continue;
      const al = d.albumOf.get(tid);
      if (seen.has(al)) continue;
      seen.add(al);
      found.push(c);
      if (found.length === 4) break;
    }
    if (found.length === 4) return { kind: 'mosaic', ids: found.map((c) => c.small), large: found.map((c) => c.id) };
    if (found.length) return img1(found[0]);
    return { kind: 'ph', icon: 'note' };
  },
};

/** The cover id that represents a spec, for the dominant color (always the small one). */
export const specCoverId = (spec) => (spec?.kind === 'img' ? spec.small : spec?.kind === 'mosaic' ? spec.ids[0] : null);

/**
 * The images a spec is drawn from in a holder of that size: [{ id, size }], one or four (none
 * for the heart and the placeholder). tiles: the size of a mosaic's pieces (default: the holder's).
 */
export function coverImages(spec, size, tiles = size) {
  if (spec?.kind === 'img') return [{ id: size === 'small' ? spec.small : spec.id, size }];
  if (spec?.kind !== 'mosaic') return [];
  // A mosaic drawn before its large ids existed (an older page's data-spec): the small ones.
  const big = tiles !== 'small' && Array.isArray(spec.large) && spec.large.length === spec.ids.length;
  return (big ? spec.large : spec.ids).map((id) => ({ id, size: big ? 'large' : 'small' }));
}

function img(coverId, size, holder, via = null) {
  const src = coverHref(coverId, size, { via });
  const el = h('img', { src, alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
  const broken = () => {
    el.replaceWith(h('span', { class: 'cover-ph-inner' }, icon('note', 24)));
    holder.classList.add('cover-broken');
  };
  // xl from a source older than it (400), or not in the cache while offline: the large one first.
  const large = size === 'xl' ? coverHref(coverId, 'large', { via }) : null;
  if (!src) queueMicrotask(broken);
  else {
    el.addEventListener('error', () => {
      if (large && el.getAttribute('src') !== large) el.setAttribute('src', large);
      else broken();
    });
  }
  return el;
}

export function setCover(el, spec, size = el.dataset.size || 'small') {
  const key = `${size}|${JSON.stringify(spec || null)}`;
  if (el.dataset.spec === key) return;
  el.dataset.spec = key;
  el.dataset.size = size;
  el.replaceChildren();
  el.classList.remove('cover-liked', 'cover-mosaic', 'cover-ph', 'cover-broken');
  if (spec?.kind === 'img' || spec?.kind === 'mosaic') {
    if (spec.kind === 'mosaic') el.classList.add('cover-mosaic');
    for (const p of coverImages(spec, size, el.dataset.tiles || size)) el.append(img(p.id, p.size, el, spec.via || null));
  } else if (spec?.kind === 'liked') {
    el.classList.add('cover-liked');
    el.append(h('span', { class: 'cover-ph-inner' }, icon('heartFill', 24)));
  } else {
    el.classList.add('cover-ph');
    el.append(h('span', { class: 'cover-ph-inner' }, icon(spec?.icon || 'note', 24)));
  }
}

/** tiles: the size of a mosaic's pieces when it is not the holder's (a large but tiny holder: 'small'). */
export function coverEl(spec, { cls = '', round = false, size = 'small', tiles = null } = {}) {
  const el = h('div', { class: `cover${round ? ' round' : ''}${cls ? ' ' + cls : ''}`, 'aria-hidden': 'true', dataset: tiles ? { size, tiles } : { size } });
  setCover(el, spec, size);
  return el;
}

/**
 * Draws again the covers that could not show (placeholder after an error, or no URL while no
 * source that has them was connected). Each holder keeps its spec in data-spec ("size|json").
 */
export function retryBrokenCovers(root = document) {
  for (const el of root.querySelectorAll('.cover.cover-broken')) {
    const key = el.dataset.spec || '';
    const bar = key.indexOf('|');
    if (bar < 0) continue;
    let spec;
    try {
      spec = JSON.parse(key.slice(bar + 1));
    } catch {
      continue;
    }
    delete el.dataset.spec;
    setCover(el, spec, key.slice(0, bar));
  }
}

// A source came or went (or the core said for the first time which ones are connected): the
// covers that failed may come from it now. Only a change of the connected set counts: the RTT
// moves at every poll.
const upKeyNow = () => `${sources.loaded ? '' : '?'}${sources.music().filter((s) => sources.isUp(s.id)).map((s) => s.id).join(',')}`;
let upKey = upKeyNow();
sources.subscribe(() => {
  const k = upKeyNow();
  if (k === upKey) return;
  upKey = k;
  retryBrokenCovers();
});
