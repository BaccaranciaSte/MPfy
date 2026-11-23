// Cards (Home and search shelves), horizontal shelves and the Home quick tiles.

import { h, repeatTap } from '../js/dom.js';
import { icon, eqEl } from '../icons/icons.js';
import { coverEl } from './cover.js';
import { ctxKey } from '../js/util.js';
import { togglePlayCtx } from '../js/actions.js';

/** Round accent play button bound to a context (shows pause while that context plays). */
export function playCtxButton(ctx, { cls = '', size = 24, label } = {}) {
  const b = h(
    'button',
    { type: 'button', class: `play-ctx ${cls}`, 'aria-label': label || 'Riproduci', dataset: { playCtx: ctxKey(ctx), label: label || 'Riproduci' } },
    icon('play', size, 'i-play'),
    icon('pause', size, 'i-pause')
  );
  b.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    togglePlayCtx(ctx);
  });
  return b;
}

/**
 * A card: cover, title, subtitle. Either a link (href) or an action (onClick).
 * ctx adds a hover play button (desktop) and the "playing" highlight.
 */
export function card({ href, onClick, title, sub, cover, round = false, ctx = null }) {
  const el = h('div', { class: `card${round ? ' round' : ''}`, dataset: ctx ? { playCtx: ctxKey(ctx) } : {} });
  const coverBox = h('div', { class: 'card-cover' }, coverEl(cover, { round }));
  const label = round ? `${title}, artista` : title;
  const link = href
    ? h('a', { class: 'card-link', href, 'data-link': '', 'aria-label': label })
    : h('button', { type: 'button', class: 'card-link', 'aria-label': `Riproduci ${title}` });
  // A card that plays: the second tap of a double tap does not load it again.
  if (onClick) {
    link.addEventListener('click', (e) => {
      if (!repeatTap(`card|${href || ''}|${title}`)) onClick(e);
    });
  }
  el.append(coverBox, h('div', { class: 'card-title' }, title), sub ? h('div', { class: 'card-sub' }, sub) : null, link);
  if (ctx) coverBox.append(playCtxButton(ctx, { cls: 'card-play', label: `Riproduci ${title}` }));
  return el;
}

/** A titled horizontal row of cards. */
export function shelf(title, cards) {
  if (!cards.length) return null;
  return h('section', { class: 'shelf' }, h('div', { class: 'shelf-head' }, h('h2', {}, title)), h('div', { class: 'shelf-row' }, cards));
}

/** Home quick tile: small cover and name in a 2x3 grid. */
export function quickTile({ href, title, cover, ctx }) {
  // A stretched link plus a sibling play button: no button nested inside the link.
  return h(
    'div',
    { class: 'tile', dataset: { playCtx: ctxKey(ctx) } },
    coverEl(cover, { cls: 'tile-cover', round: ctx.type === 'artist' }),
    h('span', { class: 'tile-name' }, title),
    h('span', { class: 'tile-eq' }, eqEl()),
    h('a', { class: 'tile-link', href, 'data-link': '', 'aria-label': title }),
    playCtxButton(ctx, { cls: 'tile-play', size: 20, label: `Riproduci ${title}` })
  );
}
