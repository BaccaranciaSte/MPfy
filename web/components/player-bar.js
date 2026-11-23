// Desktop player bar (>= 900 px): track on the left, transport and progress
// in the middle, queue, volume and full screen on the right.

import { h, iconBtn } from '../js/dom.js';
import { icon } from '../icons/icons.js';
import { player } from '../js/player.js';
import { store } from '../js/store.js';
import { coverEl, setCover, specs } from './cover.js';
import { heartButton, transport, seekBar } from './controls.js';
import { openNowPlaying } from './now-playing.js';
import { openQueue } from './queue.js';

export function mountPlayerBar(root) {
  const cover = coverEl(null, { cls: 'pb-cover' });
  const coverBtn = h('button', { type: 'button', class: 'pb-cover-btn', 'aria-label': 'Apri il brano in riproduzione' }, cover);
  coverBtn.addEventListener('click', () => openNowPlaying());
  const title = h('a', { class: 'pb-title', href: '/', 'data-link': '' });
  const artist = h('a', { class: 'pb-artist', href: '/', 'data-link': '' });
  const heart = heartButton({ size: 20 });
  const left = h('div', { class: 'pb-left' }, coverBtn, h('div', { class: 'pb-text' }, title, artist), heart.el);

  const tr = transport({ big: false });
  const seek = seekBar({ compact: true });
  const center = h('div', { class: 'pb-center' }, tr.el, seek.el);

  const queueBtn = iconBtn('queue', 'Coda', () => openQueue(), { size: 20 });
  const volIcon = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Disattiva audio' }, icon('volume', 20, 'i-vol'), icon('volumeOff', 20, 'i-mute'));
  const vol = h('input', { type: 'range', class: 'range vol', min: '0', max: '100', step: '1', 'aria-label': 'Volume' });
  let beforeMute = 1;
  const paintVol = () => {
    const v = player.state.volume;
    vol.value = String(Math.round(v * 100));
    vol.style.setProperty('--pct', `${v * 100}%`);
    volIcon.classList.toggle('muted', v === 0);
    volIcon.setAttribute('aria-label', v === 0 ? 'Riattiva audio' : 'Disattiva audio');
  };
  vol.addEventListener('input', () => {
    player.setVolume(Number(vol.value) / 100);
    paintVol();
  });
  volIcon.addEventListener('click', () => {
    if (player.state.volume > 0) {
      beforeMute = player.state.volume;
      player.setVolume(0);
    } else player.setVolume(beforeMute || 1);
    paintVol();
  });
  const full = iconBtn('expand', 'Schermo intero', () => openNowPlaying(), { size: 20 });
  const right = h('div', { class: 'pb-right' }, queueBtn, player.isNative ? null : h('div', { class: 'pb-vol' }, volIcon, vol), full);

  const el = h('div', { class: 'pb' }, left, center, right);
  root.replaceChildren(el);

  function update() {
    const t = player.currentTrack();
    el.classList.toggle('empty', !t);
    if (t) {
      setCover(cover, specs.track(t));
      title.textContent = t.title;
      const alId = store.d.albumOf.get(t.id);
      const arId = store.d.artistOf.get(t.id);
      title.setAttribute('href', alId ? `/album/${alId}` : '/');
      artist.textContent = t.artist;
      artist.setAttribute('href', arId ? `/artist/${arId}` : '/');
    } else {
      setCover(cover, null);
      title.textContent = '';
      artist.textContent = '';
    }
    heart.update(t);
    tr.update();
    queueBtn.disabled = !t;
    full.disabled = !t;
  }
  player.onChange(update);
  store.subscribe(update);
  update();
  paintVol();
}
