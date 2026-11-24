// Cover art: a single image, the 2x2 playlist mosaic, the "Brani che ti piacciono" gradient
// with a heart, or a placeholder with a music note.
//
// Covers follow their priority (custom track cover, else custom album cover, else the embedded one;
// playlists: custom cover, else the mosaic), resolved by the store. Lists load ?size=small;
// the cards of the grids, headers and Now Playing ?size=large: coverEl(spec, { size }).

import { h } from '../js/dom.js';
import { icon } from '../icons/icons.js';
import { coverHref } from '../js/media.js';
import { store } from '../js/store.js';
import { sources } from '../js/sources.js';

const img1 = (c) => ({ kind: 'img', id: c.id, small: c.small });

/**
 * Cover descriptions: { kind: 'img', id, small, via? } | { kind: 'mosaic', ids } | { kind: 'liked' } |
 * { kind: 'ph', icon } (via: the sources that hold a cover your libraries do not know).
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
    const ids = [];
    for (const tid of pl?.trackIds || []) {
      const c = d.trackCover.get(tid);
      if (!c) continue;
      const al = d.albumOf.get(tid);
      if (seen.has(al)) continue;
      seen.add(al);
      ids.push(c.small);
      if (ids.length === 4) break;
    }
    if (ids.length === 4) return { kind: 'mosaic', ids };
    if (ids.length) return { kind: 'img', id: ids[0], small: ids[0] };
    return { kind: 'ph', icon: 'note' };
  },
};

/** The cover id that represents a spec, for the dominant color (always the small one). */
export const specCoverId = (spec) => (spec?.kind === 'img' ? spec.small : spec?.kind === 'mosaic' ? spec.ids[0] : null);

function img(coverId, size, holder, via = null) {
  const src = coverHref(coverId, size, { via });
  const el = h('img', { src, alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
  const broken = () => {
    el.replaceWith(h('span', { class: 'cover-ph-inner' }, icon('note', 24)));
    holder.classList.add('cover-broken');
  };
  if (!src) queueMicrotask(broken);
  else el.addEventListener('error', broken);
  return el;
}

export function setCover(el, spec, size = el.dataset.size || 'small') {
  const key = `${size}|${JSON.stringify(spec || null)}`;
  if (el.dataset.spec === key) return;
  el.dataset.spec = key;
  el.dataset.size = size;
  el.replaceChildren();
  el.classList.remove('cover-liked', 'cover-mosaic', 'cover-ph', 'cover-broken');
  if (spec?.kind === 'img') el.append(img(size === 'large' ? spec.id : spec.small, size, el, spec.via || null));
  else if (spec?.kind === 'mosaic') {
    el.classList.add('cover-mosaic');
    for (const id of spec.ids) el.append(img(id, 'small', el));
  } else if (spec?.kind === 'liked') {
    el.classList.add('cover-liked');
    el.append(h('span', { class: 'cover-ph-inner' }, icon('heartFill', 24)));
  } else {
    el.classList.add('cover-ph');
    el.append(h('span', { class: 'cover-ph-inner' }, icon(spec?.icon || 'note', 24)));
  }
}

export function coverEl(spec, { cls = '', round = false, size = 'small' } = {}) {
  const el = h('div', { class: `cover${round ? ' round' : ''}${cls ? ' ' + cls : ''}`, 'aria-hidden': 'true', dataset: { size } });
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
