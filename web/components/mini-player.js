// Mini player above the bottom navigation: cover, title (marquee when long) and artist, heart,
// play/pause and a thin progress line along its bottom edge. Tap opens Now Playing; swipe left or
// right skips.

import { h, marqueeBox, setMarqueeText, fitMarquee } from '../js/dom.js';
import { player } from '../js/player.js';
import { store } from '../js/store.js';
import { addTicker } from '../js/ticker.js';
import { dominantColor, cachedColor, css, darken, DEFAULT_RGB } from '../js/color.js';
import { coverEl, setCover, specs } from './cover.js';
import { heartButton, playPauseButton } from './controls.js';
import { openNowPlaying } from './now-playing.js';

export function mountMiniPlayer(root) {
  const cover = coverEl(null, { cls: 'mini-cover' });
  const title = marqueeBox('mini-title');
  const artist = h('div', { class: 'mini-artist' });
  const main = h('button', { type: 'button', class: 'mini-main', 'aria-label': 'Apri il brano in riproduzione' }, cover, h('div', { class: 'mini-text' }, title, artist));
  const heart = heartButton({ cls: 'mini-heart' });
  const pp = playPauseButton({ cls: 'mini-pp', size: 26 });
  const bar = h('i');
  const el = h('div', { class: 'mini' }, main, heart.el, pp.el, h('div', { class: 'mini-progress', 'aria-hidden': 'true' }, bar));
  root.replaceChildren(el);

  let swiped = false;
  main.addEventListener('click', () => {
    if (swiped) {
      swiped = false;
      return;
    }
    openNowPlaying();
  });

  // Horizontal swipe on the mini player: left = next, right = previous.
  let sx = 0;
  let sy = 0;
  let pid = null;
  main.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    pid = e.pointerId;
    sx = e.clientX;
    sy = e.clientY;
    swiped = false;
  });
  main.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pid) return;
    const dx = e.clientX - sx;
    if (Math.abs(dx) > 12 && Math.abs(e.clientY - sy) < 30) main.style.transform = `translateX(${dx * 0.4}px)`;
  });
  const end = (e) => {
    if (e.pointerId !== pid) return;
    pid = null;
    main.style.transform = '';
    const dx = e.clientX - sx;
    if (e.type === 'pointerup' && Math.abs(dx) > 60 && Math.abs(e.clientY - sy) < 40) {
      swiped = true;
      if (dx < 0) player.next();
      else player.previous();
    }
  };
  main.addEventListener('pointerup', end);
  main.addEventListener('pointercancel', end);

  let lastId = null;
  let lastTitle = '';
  let lastCover = '';
  let colorToken = 0;

  function paintColor(t) {
    const token = ++colorToken;
    const cid = store.d.trackCover.get(t.id)?.small || null;
    const rgb = cachedColor(cid);
    el.style.setProperty('--mini-bg', css(darken(rgb || DEFAULT_RGB, 0.62)));
    if (!rgb && cid) {
      dominantColor(cid).then((c) => {
        if (c && token === colorToken) el.style.setProperty('--mini-bg', css(darken(c, 0.62)));
      });
    }
  }

  function update() {
    const t = player.currentTrack();
    document.body.classList.toggle('has-track', !!t);
    if (!t) {
      lastId = null;
      return;
    }
    const coverKey = store.d.trackCover.get(t.id)?.small || '';
    if (t.id !== lastId || t.title !== lastTitle || coverKey !== lastCover) {
      const fresh = lastId === null;
      lastId = t.id;
      lastTitle = t.title;
      lastCover = coverKey;
      setCover(cover, specs.track(t));
      setMarqueeText(title, t.title);
      artist.textContent = t.artist;
      paintColor(t);
      if (fresh) fitMarquee(title);
    }
    heart.update(t);
    pp.update();
  }

  player.onChange(update);
  store.subscribe(update);
  addTicker((pos, dur) => {
    bar.style.transform = `scaleX(${dur > 0 ? Math.min(1, pos / dur) : 0})`;
  });
  update();
  // The marquee needs real widths: measure again once the layout settled and on resize.
  window.addEventListener('resize', () => fitMarquee(title));
}
