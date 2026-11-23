// A playlist someone shared in a chat (/condivisa/<cid>/<messageId>), laid out as a playlist's page:
// the mosaic of the first 4 covers found, the name, "Playlist", who shared it, how many tracks it
// has, play, then the tracks your library has. Nothing to save or edit: it is theirs. None found:
// "Nessun brano disponibile".
//
// The playlist is read whole and current from a source where it lives (chat.js); when none answers
// the core gives the last copy it read. The card the page knows shows at once (the chat's card, or
// Home's). Gone (the message deleted, or the playlist no longer theirs): "Nessun brano disponibile".

import { h, iconBtn, sep } from '../js/dom.js';
import { whenSettled, patchParts } from '../js/settle.js';
import { icon } from '../icons/icons.js';
import { goBack } from '../js/router.js';
import { store } from '../js/store.js';
import { player } from '../js/player.js';
import { social } from '../js/social.js';
import { readSharedPlaylist, playlistCopyNow, playlistGone } from '../js/chat.js';
import { songsOfCopy, openedCard } from '../js/music-card.js';
import { nBrani, clamp } from '../js/util.js';
import { dominantColor, cachedColor, css, darken, DEFAULT_RGB, nameColor } from '../js/color.js';
import { coverEl, specs, specCoverId } from '../components/cover.js';
import { trackRow, refreshAllMarks } from '../components/track-row.js';
import { openTrackMenu } from '../components/menus.js';
import { whoOf } from '../components/chat-panel.js';

export function sharedPlaylistView(cid, messageId) {
  const scroller = document.getElementById('main');
  const el = h('div', { class: 'view view-detail detail-playlist detail-shared' });
  let pl = playlistGone(cid, messageId) ? null : playlistCopyNow(cid, messageId);
  let done = !!pl || playlistGone(cid, messageId);
  let topbar = null;
  let heroTitle = null;
  let colorSig = null;
  let colorToken = 0;
  const ctx = { type: 'library', id: null };

  /** What the page knows of the card before the playlist came: the card that opened it, or Home's. */
  const cardNow = () => openedCard(cid, messageId) || social.shared.find((x) => x.messageId === messageId && x.cid === cid) || null;

  function model() {
    const c = cardNow();
    const title = (pl && pl.name) || (c && c.card.title) || '';
    const from = (c && c.from) || null;
    const n = pl ? pl.n : c ? c.card.n || 0 : 0;
    const ids = songsOfCopy(pl);
    const coverId = (pl && pl.cover) || (c && c.card.cover) || null;
    // The mosaic of the covers your library has, else the playlist's own cover, else a grey one.
    const mosaic = ids.length ? specs.playlist({ id: null, trackIds: ids }) : null;
    const cover = mosaic && mosaic.kind !== 'ph' ? mosaic : coverId ? { kind: 'img', id: coverId, small: coverId, via: (c && c.card.sources) || [] } : { kind: 'ph', icon: 'playlist' };
    return { title, from, n, ids, cover };
  }

  function paint(rgb) {
    el.style.setProperty('--hero', css(rgb, 0.9));
    el.style.setProperty('--hero-mid', css(rgb, 0.45));
    el.style.setProperty('--hero-bar', css(darken(rgb, 0.55)));
  }
  function applyColor(m) {
    const token = ++colorToken;
    const coverId = specCoverId(m.cover);
    const rgb = cachedColor(coverId);
    paint(rgb || (coverId ? DEFAULT_RGB : nameColor(m.title || 'Playlist')));
    if (!rgb && coverId) dominantColor(coverId).then((c) => c && token === colorToken && paint(c));
  }

  let raf = 0;
  function onScroll() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (!topbar || !heroTitle) return;
      const y = scroller.scrollTop;
      const bottom = heroTitle.offsetTop + heroTitle.offsetHeight;
      topbar.style.setProperty('--tb', String(clamp((y - bottom * 0.35) / (bottom * 0.6), 0, 1)));
      topbar.classList.toggle('show-title', y > bottom - 40);
    });
  }
  scroller.addEventListener('scroll', onScroll, { passive: true });

  const playFrom = (ids, ci) => player.playContext({ ...ctx, name: model().title }, ids, ci);

  function parts() {
    const m = model();
    const who = m.from ? whoOf(m.from).name : '';
    const out = [
      { key: 'bg', sig: '', build: () => h('div', { class: 'hero-bg', 'aria-hidden': 'true' }) },
      {
        key: 'top',
        sig: m.title,
        build: () => {
          const back = iconBtn('chevronLeft', 'Indietro', () => goBack(), { cls: 'back-btn', size: 26 });
          topbar = h('div', { class: 'topbar' }, back, h('div', { class: 'topbar-title' }, m.title));
          return topbar;
        },
      },
      {
        key: 'hero',
        sig: JSON.stringify([m.title, who, m.n, m.cover]),
        build: () => {
          heroTitle = h('h1', { class: 'hero-title' }, m.title);
          const meta = [who ? h('span', { class: 'meta-owner' }, who) : null, who ? sep() : null, h('span', {}, nBrani(m.n))];
          return h('div', { class: 'hero' }, coverEl(m.cover, { cls: 'hero-cover', size: 'large' }), h('div', { class: 'hero-text' }, h('div', { class: 'hero-kind' }, 'Playlist'), heroTitle, h('div', { class: 'hero-meta' }, meta)));
        },
      },
      {
        key: 'actions',
        sig: JSON.stringify([m.title, m.ids.length > 0]),
        build: () => {
          const play = h('button', { type: 'button', class: 'play-ctx play-big', 'aria-label': `Riproduci ${m.title}`, disabled: !m.ids.length }, icon('play', 28, 'i-play'), icon('pause', 28, 'i-pause'));
          play.addEventListener('click', () => {
            const now = model();
            if (now.ids.length) playFrom(now.ids, 0);
          });
          return h('div', { class: 'actions' }, h('div', { class: 'actions-left' }), h('div', { class: 'actions-right' }, play));
        },
      },
    ];
    if (done && !m.ids.length) out.push({ key: 'none', sig: '', build: () => h('div', { class: 'empty' }, h('h2', {}, 'Nessun brano disponibile')) });
    else if (m.ids.length) {
      out.push({
        key: 'list',
        sig: JSON.stringify(m.ids.map((id) => [id, specs.track(store.track(id))])),
        build: () => {
          const list = h('div', { class: 'track-list' });
          m.ids.forEach((id, ci) => {
            const t = store.track(id);
            if (t) list.append(trackRow(t, { ctx, ci, onPlay: () => playFrom(m.ids, ci), onMenu: () => openTrackMenu(store.track(t.id) || t) }));
          });
          return list;
        },
      });
    }
    return out;
  }

  function render() {
    const m = model();
    const changed = patchParts(el, parts());
    const cs = JSON.stringify([m.cover, m.title]);
    if (cs !== colorSig) {
      colorSig = cs;
      applyColor(m);
    }
    if (changed) refreshAllMarks(el);
    onScroll();
  }
  const later = whenSettled(render);

  readSharedPlaylist(cid, messageId).then((r) => {
    if (r && r.playlist) pl = r.playlist;
    else if (r && r.gone) pl = null;
    done = true;
    later();
  });
  const offs = [store.subscribe(() => later()), social.subscribe(() => later())];
  render();
  return {
    el,
    tab: 'home',
    update: later,
    destroy() {
      later.cancel();
      cancelAnimationFrame(raf);
      scroller.removeEventListener('scroll', onScroll);
      offs.forEach((f) => f());
    },
  };
}
