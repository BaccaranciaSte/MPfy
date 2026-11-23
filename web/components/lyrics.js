// The lyrics in the full player: the "Testo" card above "Commenti", and the lyrics full screen.
//
// Card (lyr-card): head "Testo" and the expand icon, then three lines following the song (the one
// being sung white, the ones before it faded, the ones to come dark); before the first line the
// first three wait as lines to come. A tap on a line jumps there, a tap anywhere else on the card
// opens the full screen. A plain text shows its first 4 lines, still. No lyrics, or an
// instrumental: no card at all.
//
// Full screen (lyrics-full): the song in small at the top with "Chiudi", every line big, the
// position in the song and play or pause at the bottom; a layer in the history, so Back closes
// it. Synced lines follow the song with the current one kept at about a third of the height,
// sliding there; a scroll by hand stops the following for 5 s; a tap on a line jumps there. A
// plain text is shown whole, still. The next song shows its own lines once the player behind has
// them (it asks once a track stayed 1 s); a song without lyrics closes it.
//
// Both sit on the colour of the cover (--lyr, color.js lyricsColor), else on the player's.
// A double tap on a line jumps once; a tap that stops a glide jumps nowhere (the browser takes it).

import { h, iconBtn, repeatTap, markFresh } from '../js/dom.js';
import { icon } from '../icons/icons.js';
import { player } from '../js/player.js';
import { store } from '../js/store.js';
import { openLayer } from '../js/router.js';
import { addTicker } from '../js/ticker.js';
import { lyrics, lyricsSource, currentLine, cardWindow, lineClass, firstLines, plainLines } from '../js/lyrics.js';
import { seekBar, playPauseButton } from './controls.js';
import { holdModal } from './sheet.js';

const FOLLOW_PAUSE_MS = 5000;
const SLIDE_MS = 320;
let lyrCss = null; // the colour of the song playing (from its cover, else the player's), or null
let full = null; // the full screen open now

/** What to show for a song now: { key, lyr, off, synced } or null. */
function pickFor(songId) {
  if (!songId) return null;
  const src = lyricsSource(songId, player.playingVersionId());
  const lyr = src ? lyrics.held(src.v) : null;
  if (!lyr) return null;
  const synced = lyr.kind === 'synced' && src.off != null;
  return { key: `${src.v.sourceId}:${src.v.trackId}|${synced ? src.off : 'still'}`, v: src.v, lyr, off: synced ? src.off : 0, synced };
}

/** The colour the lyrics sit on: the cover's, else the player's (npColor). */
export function paintLyrics(cssColor, npColor = null) {
  lyrCss = cssColor || npColor || null;
  if (full) full.paint();
}

const setLyr = (el) => {
  if (lyrCss) el.style.setProperty('--lyr', lyrCss);
  else el.style.removeProperty('--lyr');
};

/** Jumps to a line (its time in the file of the text, off the offset to it from the one playing). */
function seekTo(t, off) {
  player.seek(Math.max(0, (t - off) / 1000));
}

/** The "Testo" card. show(songId) draws it for that song (hidden without lyrics). */
export function lyricsCard() {
  const lines = h('div', { class: 'lyr' });
  const head = h('div', { class: 'card-head' }, h('h2', {}, 'Testo'), icon('expand', 20));
  const el = h('section', { class: 'lyr-card', 'aria-label': 'Testo', tabindex: '0', hidden: true }, head, lines);
  let songId = null;
  let pick = null;
  let cur = -2;
  let first = -1;
  const ps = [];

  function drawWindow(pos) {
    if (!pick || !pick.synced) return;
    const ls = pick.lyr.lines;
    const i = currentLine(ls, Math.round(pos * 1000) + pick.off);
    if (i === cur) return;
    cur = i;
    const [a, b] = cardWindow(ls.length, i);
    if (a !== first || ps.length !== b - a) {
      first = a;
      while (ps.length < b - a) ps.push(h('p'));
      ps.length = b - a;
      lines.replaceChildren(...ps);
      for (let k = a; k < b; k++) {
        ps[k - a].textContent = ls[k].text;
        ps[k - a].dataset.t = String(ls[k].t);
      }
    }
    for (let k = a; k < b; k++) ps[k - a].className = lineClass(k, i);
  }

  function show(id) {
    songId = id;
    const next = pickFor(id);
    if (!next) {
      pick = null;
      el.hidden = true;
      return;
    }
    el.hidden = false;
    if (pick && pick.key === next.key && pick.lyr === next.lyr) {
      drawWindow(player.positionNow());
      return;
    }
    pick = next;
    cur = -2;
    first = -1;
    ps.length = 0;
    if (pick.synced) {
      lines.classList.remove('is-still');
      drawWindow(player.positionNow());
    } else {
      lines.classList.add('is-still');
      lines.replaceChildren(...firstLines(pick.lyr, 4).map((t) => h('p', {}, t)));
    }
  }

  el.addEventListener('click', (e) => {
    if (!pick) return;
    const p = e.target.closest('p[data-t]');
    if (p && pick.synced) {
      // A double tap on a line jumps there once.
      if (!repeatTap('lyr-line')) seekTo(Number(p.dataset.t), pick.off);
      return;
    }
    if (!repeatTap('lyr-open')) openLyricsFull(songId);
  });
  el.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target === el) {
      e.preventDefault();
      if (pick) openLyricsFull(songId);
    }
  });
  const stop = addTicker((pos) => {
    if (!el.hidden) drawWindow(pos);
  });
  return { el, show, destroy: stop };
}

/** The lyrics full screen of the song playing. */
export function openLyricsFull(songId) {
  if (full || !songId) return;
  const t = store.track(songId);
  if (!t) return;
  const close = iconBtn('chevronDown', 'Chiudi', () => layer.close(), { size: 28 });
  const title = h('b');
  const artist = h('span');
  const head = h('header', { class: 'lf-head' }, close, h('div', { class: 'lf-song' }, title, artist), h('span', { class: 'icon-spacer' }));
  const lines = h('div', { class: 'lf-lines lyr' });
  const seek = seekBar();
  const pp = playPauseButton({ cls: 'lf-pp', size: 26 });
  const el = h('div', { class: 'lyrics-full', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Testo', tabindex: '-1' }, head, lines, h('div', { class: 'lf-ctl' }, seek.el, pp.el));
  setLyr(el);
  document.getElementById('layers').before(el);
  const release = holdModal(el);
  markFresh(el);

  let id = songId;
  let pick = null;
  let cur = -2;
  let ps = [];
  let pausedUntil = 0; // a scroll by hand stops the following until then
  let anim = 0;
  let lastSet = -1; // the scrollTop the following set last
  let touching = false;
  let centered = false; // the current line sits where the following puts it

  function paintSong() {
    const s = store.track(id);
    title.textContent = s ? s.title : '';
    artist.textContent = s ? s.artist : '';
  }

  function draw() {
    const next = pickFor(id);
    if (!next) {
      // A song without lyrics (or whose text came back as none) closes it; one whose text is on
      // its way (the player asks once the track stayed 1 s) waits for it.
      const src = lyricsSource(id, player.playingVersionId());
      if (!src || lyrics.known(src.v)) {
        layer.close();
        return;
      }
      pick = null;
      ps = [];
      lines.replaceChildren();
      return;
    }
    if (pick && pick.key === next.key && pick.lyr === next.lyr) return;
    pick = next;
    cur = -2;
    cancelAnimationFrame(anim);
    if (pick.synced) {
      lines.classList.remove('is-still');
      ps = pick.lyr.lines.map((l) => h('p', { class: 'next', dataset: { t: String(l.t) } }, l.text));
    } else {
      lines.classList.add('is-still');
      ps = plainLines(pick.lyr).map((l) => h('p', {}, l));
    }
    lines.replaceChildren(...ps);
    lines.scrollTop = 0;
    lastSet = lines.scrollTop;
    follow(player.positionNow(), true);
  }

  /** The current line kept at about a third of the height, sliding there (at once: jump). */
  function slideTo(top, now) {
    cancelAnimationFrame(anim);
    const max = Math.max(0, lines.scrollHeight - lines.clientHeight);
    const to = Math.max(0, Math.min(max, Math.round(top)));
    const from = lines.scrollTop;
    if (Math.abs(to - from) < 1) return;
    if (now || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      lines.scrollTop = to;
      lastSet = lines.scrollTop;
      return;
    }
    const t0 = performance.now();
    const step = (ts) => {
      const k = Math.min(1, (ts - t0) / SLIDE_MS);
      const e = 1 - Math.pow(1 - k, 3);
      lines.scrollTop = from + (to - from) * e;
      lastSet = lines.scrollTop;
      if (k < 1) anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
  }

  function follow(pos, now = false) {
    if (!pick || !pick.synced) return;
    const i = currentLine(pick.lyr.lines, Math.round(pos * 1000) + pick.off);
    if (i !== cur) {
      // Only the lines between the old and the new current one change class.
      const lo = Math.max(0, Math.min(i, cur) - 1);
      const hi = Math.min(ps.length - 1, Math.max(i, cur) + 1);
      if (cur === -2) for (let k = 0; k < ps.length; k++) ps[k].className = lineClass(k, i);
      else for (let k = lo; k <= hi; k++) ps[k].className = lineClass(k, i);
      cur = i;
      centered = false;
    }
    if (now) centered = false;
    if (centered || touching || performance.now() < pausedUntil) return;
    const p = ps[Math.max(0, cur)];
    if (!p) return;
    centered = true;
    slideTo(p.offsetTop - lines.clientHeight / 3, now);
  }

  // A scroll by hand: a finger, a wheel, or a glide that did not come from the following.
  const byHand = () => {
    pausedUntil = performance.now() + FOLLOW_PAUSE_MS;
    centered = false;
    cancelAnimationFrame(anim);
  };
  lines.addEventListener('touchstart', () => {
    touching = true;
    centered = false;
    cancelAnimationFrame(anim);
  }, { passive: true });
  const lift = () => {
    if (!touching) return;
    touching = false;
    pausedUntil = Math.max(pausedUntil, performance.now() + FOLLOW_PAUSE_MS);
  };
  lines.addEventListener('touchend', lift, { passive: true });
  lines.addEventListener('touchcancel', lift, { passive: true });
  lines.addEventListener('wheel', byHand, { passive: true });
  lines.addEventListener('scroll', () => {
    if (Math.abs(lines.scrollTop - lastSet) > 1) byHand();
  }, { passive: true });
  lines.addEventListener('click', (e) => {
    const p = e.target.closest('p[data-t]');
    if (!p || !pick || !pick.synced || repeatTap('lyr-line')) return;
    // A jump takes the following back at once.
    pausedUntil = 0;
    seekTo(Number(p.dataset.t), pick.off);
  });

  const stopTicker = addTicker((pos) => follow(pos));
  const update = () => {
    const t2 = player.currentTrack();
    if (!t2) {
      layer.close();
      return;
    }
    id = t2.id;
    paintSong();
    pp.update();
    draw();
  };
  const offPlayer = player.onChange(update);
  const offLyrics = lyrics.subscribe(() => draw());

  full = { paint: () => setLyr(el) };
  const layer = openLayer(() => {
    full = null;
    markFresh();
    cancelAnimationFrame(anim);
    stopTicker();
    seek.destroy();
    offPlayer();
    offLyrics();
    release();
    el.classList.remove('open');
    el.setAttribute('aria-hidden', 'true');
    setTimeout(() => el.remove(), 260);
  });
  paintSong();
  pp.update();
  draw();
  requestAnimationFrame(() => {
    if (layer.closed) return;
    el.classList.add('open');
    el.focus({ preventScroll: true });
    follow(player.positionNow(), true);
  });
  return layer;
}

export const lyricsFullOpen = () => !!full;
