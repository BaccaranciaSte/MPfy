// A cover drawn before the page knew a connected source that has it (the library from the
// device's copy, the sources not answered yet) asks the service worker's cache only (&cached=1),
// or nothing, and shows the placeholder when that misses. Pages are drawn again only when what
// they show changes, so such a cover is pointed at the source here, once one is known: after a
// change of the library and after a connection flip. Each address is tried once per cover.

import { setCover } from '../components/cover.js';
import { coverHref } from './media.js';

const guess = (src) => /[?&]cached=1(&|$)/.test(src || '');
const tried = new WeakMap(); // cover holder -> the address it was last drawn from here

/** Draws again, from a connected source, the covers under root that wait on a guess or broke. */
export function redrawGuessedCovers(root = document) {
  for (const el of root.querySelectorAll('.cover[data-spec]')) {
    const broken = el.classList.contains('cover-broken');
    const waiting = !broken && [...el.querySelectorAll('img')].some((img) => guess(img.getAttribute('src')) && !(img.complete && img.naturalWidth > 0));
    if (!broken && !waiting) continue;
    const key = el.dataset.spec;
    const bar = key.indexOf('|');
    if (bar < 0) continue;
    let spec;
    try {
      spec = JSON.parse(key.slice(bar + 1));
    } catch {
      continue;
    }
    const size = key.slice(0, bar);
    const one = spec?.kind === 'img';
    const id = one ? (size === 'large' ? spec.id : spec.small) : spec?.kind === 'mosaic' ? spec.ids[0] : null;
    const href = id ? coverHref(id, one ? size : 'small') : null;
    if (!href || guess(href) || tried.get(el) === href) continue;
    tried.set(el, href);
    delete el.dataset.spec;
    setCover(el, spec, size);
  }
}
