// Player controls shared by the mini player, the desktop player bar and Now Playing.

import { h, staleTap } from '../js/dom.js';
import { icon } from '../icons/icons.js';
import { player } from '../js/player.js';
import { store } from '../js/store.js';
import { addTicker } from '../js/ticker.js';
import { fmtTime } from '../js/util.js';
import { toggleLike } from './menus.js';

// A finger that lands on a slider while the list holding it glides only stops the glide (a click
// there the browser drops by itself; a slider would take the position under the finger): the
// last scroll is kept with what scrolled, and a press on a slider inside it within MOVING_MS, or
// one the list scrolled under, moves nothing.
const MOVING_MS = 150;
let lastScroll = { at: -Infinity, el: null };
let held = null; // { input, moved }: the slider pressed now
const holds = (el, input) => !!el && (el === document ? document.documentElement : el).contains(input);
if (typeof window !== 'undefined') {
  window.addEventListener(
    'scroll',
    (e) => {
      lastScroll = { at: performance.now(), el: e.target };
      if (held && holds(e.target, held.input)) held.moved = true;
    },
    { capture: true, passive: true }
  );
}

export function playPauseButton({ cls = '', size = 24 } = {}) {
  const el = h('button', { type: 'button', class: `icon-btn pp ${cls}`, 'aria-label': 'Riproduci' }, icon('play', size, 'i-play'), icon('pause', size, 'i-pause'));
  el.addEventListener('click', () => player.toggle());
  const update = () => {
    const on = player.state.playing;
    el.classList.toggle('is-on', on);
    el.classList.toggle('is-buffering', on && player.state.buffering);
    el.setAttribute('aria-label', on ? 'Metti in pausa' : 'Riproduci');
  };
  update();
  return { el, update };
}

export function heartButton({ size = 24, cls = '' } = {}) {
  const el = h('button', { type: 'button', class: `icon-btn heart-btn ${cls}`, 'aria-label': 'Aggiungi a Mi piace', 'aria-pressed': 'false' }, icon('heart', size, 'i-off'), icon('heartFill', size, 'i-on'));
  let track = null;
  el.addEventListener('click', () => toggleLike(track));
  const update = (t) => {
    track = t || null;
    const liked = !!track && store.isLiked(track.id);
    el.classList.toggle('is-on', liked);
    el.setAttribute('aria-pressed', String(liked));
    el.setAttribute('aria-label', liked ? 'Rimuovi da Mi piace' : 'Aggiungi a Mi piace');
    el.disabled = !track;
  };
  return { el, update };
}

/** Shuffle, previous, play/pause, next, repeat. */
export function transport({ big = false } = {}) {
  const size = big ? 30 : 20;
  const shuffle = h('button', { type: 'button', class: 'icon-btn toggle', 'aria-label': 'Riproduzione casuale' }, icon('shuffle', size - 4));
  const prev = h('button', { type: 'button', class: 'icon-btn ctl', 'aria-label': 'Precedente' }, icon('previous', size));
  const pp = playPauseButton({ cls: big ? 'pp-big' : 'pp-small', size: big ? 30 : 18 });
  const next = h('button', { type: 'button', class: 'icon-btn ctl', 'aria-label': 'Successivo' }, icon('next', size));
  const repeat = h('button', { type: 'button', class: 'icon-btn toggle', 'aria-label': 'Ripeti' }, icon('repeat', size - 4, 'i-rep'), icon('repeatOne', size - 4, 'i-rep1'));
  shuffle.addEventListener('click', () => player.toggleShuffle());
  prev.addEventListener('click', () => player.previous());
  next.addEventListener('click', () => player.next());
  repeat.addEventListener('click', () => player.cycleRepeat());
  const el = h('div', { class: `transport${big ? ' transport-big' : ''}` }, shuffle, prev, pp.el, next, repeat);
  const update = () => {
    const st = player.state;
    const has = st.index >= 0;
    shuffle.classList.toggle('on', st.shuffle);
    shuffle.setAttribute('aria-pressed', String(st.shuffle));
    shuffle.setAttribute('aria-label', st.shuffle ? 'Disattiva riproduzione casuale' : 'Attiva riproduzione casuale');
    repeat.classList.toggle('on', st.repeat !== 'off');
    repeat.classList.toggle('one', st.repeat === 'one');
    repeat.setAttribute('aria-label', st.repeat === 'off' ? 'Attiva ripetizione' : st.repeat === 'all' ? 'Ripeti un brano' : 'Disattiva ripetizione');
    for (const b of [prev, next, pp.el]) b.disabled = !has;
    pp.update();
  };
  update();
  return { el, update };
}

/**
 * Seek slider with elapsed and remaining (or total, compact) time. While the thumb is held the
 * ticker leaves it alone; the hold ends with the lift (the slider keeps the pointer, so a lift
 * outside it ends here too) or with a touch the system took (an edge gesture, a call), which
 * seeks nothing and shows the song again. A tap that belongs to the gesture that opened Now
 * Playing does not seek (staleTap, dom.js), nor a finger that lands on it while the player
 * scrolls past (it only stops the glide).
 */
export function seekBar({ compact = false } = {}) {
  const input = h('input', { type: 'range', class: 'range seek', min: '0', max: '1000', step: '1', value: '0', 'aria-label': 'Posizione nel brano' });
  const t1 = h('span', { class: 'time' }, '0:00');
  const t2 = h('span', { class: 'time time-end' }, '0:00');
  let dragging = false;

  const paint = (pos, dur) => {
    const pct = dur > 0 ? Math.min(100, (pos / dur) * 100) : 0;
    input.style.setProperty('--pct', `${pct}%`);
    if (!dragging) input.value = String(Math.round(pct * 10));
    t1.textContent = fmtTime(pos);
    t2.textContent = compact ? fmtTime(dur) : `-${fmtTime(Math.max(0, dur - pos))}`;
    input.setAttribute('aria-valuetext', `${fmtTime(pos)} di ${fmtTime(dur)}`);
  };
  const showSong = () => {
    dragging = false;
    paint(player.positionNow(), player.durationNow());
  };
  input.addEventListener('pointerdown', () => {
    held = { input, moved: performance.now() - lastScroll.at < MOVING_MS && holds(lastScroll.el, input) };
  });
  // The keys move it as always.
  input.addEventListener('keydown', () => {
    if (held && held.input === input) held = null;
  });
  const notForIt = () => staleTap(input) || (!!held && held.input === input && held.moved);
  input.addEventListener('input', () => {
    if (notForIt()) {
      showSong();
      return;
    }
    dragging = true;
    const dur = player.durationNow();
    paint((Number(input.value) / 1000) * dur, dur);
  });
  input.addEventListener('change', () => {
    if (notForIt()) {
      showSong();
      return;
    }
    const dur = player.durationNow();
    player.seek((Number(input.value) / 1000) * dur);
    dragging = false;
  });
  // After the change event of this lift, if one comes.
  input.addEventListener('pointerup', () => setTimeout(() => (dragging = false), 0));
  // No change event follows a touch the system took.
  input.addEventListener('pointercancel', showSong);

  const el = compact ? h('div', { class: 'seek-row compact' }, t1, input, t2) : h('div', { class: 'seek-row' }, input, h('div', { class: 'seek-times' }, t1, t2));
  const stop = addTicker((pos, dur) => {
    if (!dragging) paint(pos, dur);
  });
  return { el, destroy: stop, input };
}
