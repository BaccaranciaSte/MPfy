// Now Playing: full screen sheet that slides up. Chevron down, "IN RIPRODUZIONE DA" + context,
// track menu, large cover, title/artist + heart, seek slider, transport, then the quality chip
// (the level the source actually serves: MAX, ALTA, NORMALE, BASSA) with the source's name, and
// the queue button. Background: a gradient from the cover's dominant color. Swipe down closes it.
//
// Under that first screen the player scrolls to the song's cards: "Testo" (its lyrics, only when
// it has some) above "Commenti" (only where a source holds comments). Their data is asked when the
// player opens and, while it is open, once a track stayed 1 s (a burst of skips asks for the last
// one only); nothing is asked while it is closed. At the top a drag down on the header or the
// cover still closes the player (a drag up scrolls to the cards); scrolled down, they scroll.

import { h, iconBtn, marqueeBox, setMarqueeText, fitMarquee, markFresh } from '../js/dom.js';
import { player } from '../js/player.js';
import { store } from '../js/store.js';
import { openLayer } from '../js/router.js';
import { contextName, contextHref } from '../js/contexts.js';
import { dominantColor, cachedColor, css, darken, DEFAULT_RGB } from '../js/color.js';
import { coverEl, setCover, specs } from './cover.js';
import { heartButton, transport, seekBar } from './controls.js';
import { attachDragDismiss, holdModal } from './sheet.js';
import { openTrackMenu } from './menus.js';
import { openQueue } from './queue.js';
import { quality } from '../js/quality.js';
import { sources } from '../js/sources.js';
import { lyricsColor } from '../js/color.js';
import { comments } from '../js/comments.js';
import { lyrics, lyricsSource } from '../js/lyrics.js';
import { lyricsCard, paintLyrics } from './lyrics.js';
import { commentsCard } from './comments.js';

const SETTLE_MS = 1000; // a track kept this long has its comments and lyrics asked

let ui = null;
let layer = null;

function build() {
  const close = iconBtn('chevronDown', 'Chiudi', () => layer?.close(), { size: 28 });
  const fromName = h('a', { class: 'np-from-name', href: '/', 'data-link': '' });
  const from = h('div', { class: 'np-from' }, h('span', { class: 'np-from-label' }, 'IN RIPRODUZIONE DA'), fromName);
  const more = iconBtn('moreV', 'Altre opzioni per il brano', () => openTrackMenu(player.currentTrack()));
  const head = h('header', { class: 'np-head' }, close, from, more);

  const cover = coverEl(null, { cls: 'np-cover', size: 'large' });
  const art = h('div', { class: 'np-art' }, cover);

  const title = marqueeBox('np-title');
  const artist = h('a', { class: 'np-artist', href: '/', 'data-link': '' });
  const heart = heartButton({ size: 28, cls: 'np-heart' });
  const meta = h('div', { class: 'np-meta' }, h('div', { class: 'np-titles' }, title, artist), heart.el);

  const seek = seekBar();
  const tr = transport({ big: true });
  const queueBtn = iconBtn('queue', 'Coda', () => openQueue(), { cls: 'np-queue' });
  const chip = h('span', { class: 'q-chip', title: 'Qualità del brano in riproduzione' });
  const srcName = h('span', { class: 'np-src' });
  const foot = h('div', { class: 'np-foot' }, h('div', { class: 'np-served' }, chip, srcName), queueBtn);

  const lyrCard = lyricsCard();
  const cmCard = commentsCard();
  const screen = h('div', { class: 'np-screen' }, art, meta, seek.el, tr.el, foot);
  const cards = h('div', { class: 'np-cards' }, lyrCard.el, cmCard.el);
  const inner = h('div', { class: 'np-inner np-scroll' }, head, screen, cards);
  const el = h('div', { class: 'np', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'In riproduzione', tabindex: '-1', 'aria-hidden': 'true' }, h('div', { class: 'np-bg' }), inner);
  document.getElementById('layers').before(el);

  // Only at the top does a drag down close it; scrolled down, the header and the cover scroll.
  const atTop = () => inner.scrollTop <= 0;
  attachDragDismiss(head, el, () => layer?.close(), { when: atTop });
  attachDragDismiss(art, el, () => layer?.close(), { when: atTop });
  inner.addEventListener('scroll', () => el.classList.toggle('np-scrolled', !atTop()), { passive: true });

  // The cards of the song: drawn from what is held at once, asked once the track stayed 1 s.
  let followed = null; // the song whose data was asked (or is about to be)
  let settled = null; // ... once its second passed
  let lyrKey = '';
  let settleTimer = 0;
  const lyrSource = (id) => lyricsSource(id, player.playingVersionId());
  function askFor(id) {
    settled = id;
    comments.load(id);
    const src = lyrSource(id);
    lyrKey = src ? `${src.v.sourceId}:${src.v.trackId}` : '';
    if (src) lyrics.load(src.v);
  }
  function follow(id, now) {
    if (id === followed) {
      // The same song from another version (a failover): its text may be another one.
      const src = id === settled ? lyrSource(id) : null;
      const k = src ? `${src.v.sourceId}:${src.v.trackId}` : '';
      if (src && k !== lyrKey) {
        lyrKey = k;
        lyrics.load(src.v);
      }
      return;
    }
    followed = id;
    settled = null;
    clearTimeout(settleTimer);
    if (now) askFor(id);
    else settleTimer = setTimeout(() => layer && followed === id && askFor(id), SETTLE_MS);
  }
  function stopFollowing() {
    clearTimeout(settleTimer);
    followed = null;
    settled = null;
  }
  function drawCards(id) {
    lyrCard.show(id);
    cmCard.show(id);
    inner.classList.toggle('np-still', lyrCard.el.hidden && cmCard.el.hidden);
  }
  lyrics.subscribe(() => {
    if (!layer) return;
    // A text forgotten here (lyrics added or taken away) is asked again for the song kept.
    const src = settled ? lyrSource(settled) : null;
    if (src && !lyrics.known(src.v)) lyrics.load(src.v);
    drawCards(player.currentTrack()?.id || null);
  });
  comments.subscribe(() => layer && inner.classList.toggle('np-still', lyrCard.el.hidden && cmCard.el.hidden));

  let lastId = null;
  let colorToken = 0;
  const paint = (rgb, fromCover) => {
    el.style.setProperty('--np', css(rgb));
    el.style.setProperty('--np-dark', css(darken(rgb, 0.45)));
    // The lyrics sit on the cover's own colour; without one, on the player's.
    const lyr = fromCover ? css(lyricsColor(rgb)) : null;
    if (lyr) el.style.setProperty('--lyr', lyr);
    else el.style.removeProperty('--lyr');
    paintLyrics(lyr, css(rgb));
  };

  function update() {
    const t = player.currentTrack();
    const st = player.state;
    if (!t) {
      if (layer) layer.close();
      return;
    }
    const ctx = st.context;
    const m = player.currentItem();
    fromName.textContent = m?.m || !ctx ? 'La tua coda' : contextName(ctx);
    fromName.setAttribute('href', m?.m || !ctx ? '/library' : contextHref(ctx));
    const coverKey = `${t.id}|${store.d.trackCover.get(t.id)?.id || ''}`;
    if (coverKey !== lastId) {
      lastId = coverKey;
      setCover(cover, specs.track(t));
      const token = ++colorToken;
      const cid = store.d.trackCover.get(t.id)?.small || null;
      const rgb = cachedColor(cid);
      paint(rgb || DEFAULT_RGB, !!rgb);
      if (!rgb && cid) dominantColor(cid).then((c) => c && token === colorToken && paint(c, true));
    }
    setMarqueeText(title, t.title);
    artist.textContent = t.artist;
    const arId = store.d.artistOf.get(t.id);
    artist.setAttribute('href', arId ? `/artist/${arId}` : '/');
    heart.update(t);
    tr.update();
    const label = quality.chip(st.quality);
    chip.textContent = label;
    chip.hidden = !label;
    chip.setAttribute('aria-label', label ? `Qualità: ${label.toLowerCase()}` : '');
    srcName.textContent = st.source ? sources.name(st.source) : '';
    follow(t.id, false);
    drawCards(t.id);
  }

  player.onChange(() => layer && update());
  store.subscribe(() => layer && update());
  sources.subscribe(() => layer && drawCards(player.currentTrack()?.id || null));
  return {
    el,
    update,
    title,
    inner,
    /** Opened: the song's data asked at once. */
    opened() {
      inner.scrollTop = 0;
      el.classList.remove('np-scrolled');
      const t = player.currentTrack();
      followed = null;
      if (t) follow(t.id, true);
    },
    closed: stopFollowing,
  };
}

export function openNowPlaying() {
  if (layer || !player.currentTrack()) return;
  if (!ui) ui = build();
  ui.opened();
  ui.update();
  ui.el.setAttribute('aria-hidden', 'false');
  document.body.classList.add('np-open');
  const release = holdModal(ui.el); // a full screen dialog: the page behind it is inert
  // The rest of the gesture that opened it does nothing on it, and the one that closes it does
  // nothing on the page it uncovers while it slides away (dom.js, markFresh).
  markFresh(ui.el);
  const mine = openLayer(() => {
    markFresh();
    ui.closed();
    ui.el.classList.remove('open');
    ui.el.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('np-open');
    release();
    if (layer === mine) layer = null;
  });
  layer = mine;
  // Next frame so the transition runs from the closed position; not when back already closed it.
  requestAnimationFrame(() => {
    if (layer !== mine) return;
    ui.el.classList.add('open');
    fitMarquee(ui.title);
    ui.el.focus({ preventScroll: true });
  });
}

export const closeNowPlaying = () => layer?.close();
