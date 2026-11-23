// Home: greeting by hour, the update button (the app, while there is an update), upload, and the
// person's picture (photo, else the letter of the name): with a source that speaks the people part
// it opens Amici (on a PC it opens and closes the right column instead), else Impostazioni; the
// gear on a core without profiles. A dot sits on the picture while a conversation that is not
// silenced has unread messages. Then 2x3 quick tiles (recent contexts and playlists), then the
// rows "Condivisi con te" (the music people shared with you in the chats, when there is some),
// "Ascoltati di recente", "Le tue playlist", "Aggiunti di recente", "I tuoi artisti", "Album".
//
// The page is drawn in parts (header, tiles, each row) and a change draws again only the parts
// whose content changed, once the hands rest (settle.js): a row scrolled or flung sideways stays
// where it is, and one drawn again keeps its offset.

import { h, iconBtn, sep, sameSpotAgain } from '../js/dom.js';
import { icon } from '../icons/icons.js';
import { store } from '../js/store.js';
import { player } from '../js/player.js';
import { greeting } from '../js/util.js';
import { LIKED_NAME, recentContexts, homeContexts } from '../js/contexts.js';
import { specs } from '../components/cover.js';
import { card, shelf, quickTile } from '../components/cards.js';
import { refreshAllMarks } from '../components/track-row.js';
import { openUploadSheet } from '../components/upload-sheet.js';
import { openAddSource } from '../components/add-source.js';
import { askNameIfMissing } from './welcome.js';
import { nativeCall } from '../js/native.js';
import { navigate } from '../js/router.js';
import { sources } from '../js/sources.js';
import { isOnline, onConn } from '../js/conn.js';
import { updates } from '../js/updates.js';
import { updateButton } from '../components/update-button.js';
import { whenSettled, patchParts } from '../js/settle.js';
import { profile } from '../js/profile.js';
import { avatar, avatarSig } from '../components/avatar.js';
import { friendsSide } from '../components/friends-side.js';
import { social } from '../js/social.js';
import { sharedCard, sharedSig, warmSharedCovers } from '../components/shared-card.js';

/** Turns a context into what a card or tile needs; null when it no longer exists. */
function entity(ctx) {
  const d = store.d;
  switch (ctx.type) {
    case 'playlist': {
      const pl = d.playlists.get(ctx.id);
      return pl && { ctx, href: `/playlist/${pl.id}`, title: pl.name, sub: 'Playlist', cover: specs.playlist(pl) };
    }
    case 'album': {
      const al = d.albums.get(ctx.id);
      return al && { ctx, href: `/album/${al.id}`, title: al.name, sub: al.artist, cover: specs.album(al) };
    }
    case 'artist': {
      const ar = d.artists.get(ctx.id);
      return ar && { ctx, href: `/artist/${ar.id}`, title: ar.name, sub: 'Artista', cover: specs.artist(ar), round: true };
    }
    case 'liked':
      return { ctx, href: '/liked', title: LIKED_NAME, sub: 'Playlist', cover: specs.liked() };
    default:
      return null;
  }
}

const toCard = (e) => card({ href: e.href, title: e.title, sub: e.year ? [String(e.year), sep(), e.sub] : e.sub, cover: e.cover, round: e.round, ctx: e.ctx });

/** A row as a part: its key is its title, its sig what its cards show. Null with no cards. */
function shelfPart(title, items, make = toCard) {
  if (!items.length) return null;
  return { key: `shelf:${title}`, sig: JSON.stringify(items), build: () => shelf(title, items.map(make)) };
}

export function homeView() {
  const el = h('div', { class: 'view view-home' });
  // One button for the life of the page: its ring moves in place, the header is drawn again only
  // when it comes or goes.
  const upd = updateButton();
  let updShown = false;
  const later = whenSettled(render);
  const offUpd = updates.subscribe((u) => {
    if ((u.state !== 'none') !== updShown) later();
    else upd.paint();
  });
  // The library's own changes come through update(); the connection matters only to the empty
  // library's upload button, the profile only to the picture in the header.
  const offConn = onConn(() => later());
  const offProfile = profile.subscribe(() => later());
  // A source that starts or stops speaking the people part changes what the picture opens; the
  // first real source, or the phone's access and first scan, change the empty library's words.
  let phoneSeen = '';
  const phoneKey = () => `${sources.list.length > 0}|${sources.phone ? sources.phone.state : ''}`;
  const offSources = sources.subscribe(() => {
    const k = phoneKey();
    if (sources.social() !== socialShown || k !== phoneSeen) {
      phoneSeen = k;
      later();
    }
  });
  const offSide = friendsSide.subscribe(() => paintOpen());
  // The chats: the dot on the picture and the shared cards.
  const offSocial = social.subscribe(() => later());
  const me = () => profile.supported && !!profile.data;
  let socialShown = sources.social();
  let meBtn = null;

  /** On a PC with the column open, the picture wears its ring (and says it is pressed). */
  function paintOpen() {
    if (!meBtn || !meBtn.isConnected) return;
    const on = socialShown && friendsSide.shown;
    meBtn.classList.toggle('is-open', on);
    if (on) meBtn.setAttribute('aria-pressed', 'true');
    else meBtn.removeAttribute('aria-pressed');
  }

  /**
   * The person's picture, 32 px in a 44 px target: Amici and Impostazioni with a social source
   * (a page on a phone, the right column on a PC), else Impostazioni; the gear without a profile.
   */
  function settingsButton() {
    meBtn = null;
    if (!me()) return iconBtn('settings', 'Impostazioni', () => navigate('/impostazioni'), { cls: 'top-action' });
    const title = socialShown ? 'Amici e impostazioni' : 'Impostazioni';
    const dot = socialShown && unreadNow();
    const label = dot ? 'Amici e impostazioni, messaggi non letti' : title;
    const b = h(
      'button',
      { type: 'button', class: `icon-btn top-action avatar-btn${dot ? ' has-new' : ''}`, 'aria-label': label, title },
      h('span', { class: 'avatar-cut' }, avatar(32)),
      dot ? h('span', { class: 'new-dot', role: 'img', 'aria-label': 'Non letti' }) : null
    );
    b.addEventListener('click', () => {
      if (!sources.social()) navigate('/impostazioni');
      else if (friendsSide.usable) {
        friendsSide.toggle();
        // The picture moves aside with the column: the rest of a double click, landing where it
        // was, still clicks it (open, then closed again), and never presses what is there now.
        sameSpotAgain(() => friendsSide.usable && friendsSide.toggle());
      } else navigate('/amici');
    });
    meBtn = b;
    return b;
  }

  // "Carica brani" only with a real source: with only the phone's own music there is nowhere to upload.
  function topBar() {
    return h(
      'header',
      { class: 'home-top' },
      h('h1', {}, greeting()),
      updShown ? upd.el : null,
      sources.list.length ? iconBtn('upload', 'Carica brani', () => openUploadSheet(), { cls: 'top-action' }) : null,
      settingsButton()
    );
  }

  /** A conversation that is not silenced has unread messages. */
  const unreadNow = () => social.chatsSupported && social.unread > 0;

  function parts() {
    socialShown = sources.social();
    const real = sources.list.length > 0;
    const ph = sources.phone;
    const top = { key: 'top', sig: `${greeting()}|${updShown}|${me() ? avatarSig() : ''}|${socialShown}|${socialShown && unreadNow()}|${real}`, build: topBar };
    // The phone's first scan still running with nothing to show yet: loading, not empty.
    if (!store.loaded || (!sources.loaded && !store.lib.tracks.length) || (!store.lib.tracks.length && ph?.state === 'scanning')) {
      return [top, { key: 'loading', sig: '', build: () => h('p', { class: 'empty-small' }, 'Caricamento della libreria...') }];
    }
    if (!store.lib.tracks.length) {
      const online = isOnline();
      // With no real source: the way to the phone's music while its access is off, else a source.
      const kind = real ? (online ? 'upload' : '') : ph ? (ph.state === 'off' ? 'access' : 'add') : '';
      const build = () => {
        let btn = null;
        if (kind === 'upload') {
          btn = h('button', { type: 'button', class: 'btn btn-light' }, icon('upload', 20), 'Carica brani');
          btn.addEventListener('click', () => openUploadSheet());
        } else if (kind === 'access') {
          btn = h('button', { type: 'button', class: 'btn btn-light home-access' }, icon('note', 20), "Consenti l'accesso alla musica");
          btn.addEventListener('click', () => nativeCall('askMusicAccess', 'settings'));
        } else if (kind === 'add') {
          btn = h('button', { type: 'button', class: 'btn btn-light home-add-source' }, icon('plus', 20), 'Aggiungi fonte');
          btn.addEventListener('click', () => openAddSource({ askName: askNameIfMissing }));
        }
        return h('div', { class: 'empty' }, h('div', { class: 'empty-icon' }, icon('note', 40)), h('h2', {}, 'La tua libreria è vuota'), btn);
      };
      return [top, { key: 'empty', sig: kind, build }];
    }
    const d = store.d;
    const cardOf = (e) => ({ href: e.href, title: e.title, sub: e.sub, cover: e.cover, round: !!e.round, ctx: e.ctx });

    // Quick tiles: recent contexts first, then liked, playlists and albums, up to six.
    const tiles = homeContexts(6)
      .map(entity)
      .filter(Boolean)
      .map((e) => ({ href: e.href, title: e.title, cover: e.cover, ctx: e.ctx }));
    const tilesPart = { key: 'tiles', sig: JSON.stringify(tiles), build: () => h('div', { class: 'tiles' }, tiles.map(quickTile)) };

    // Every recent kept (the source keeps the latest 50 for each person).
    const recent = recentContexts().map(entity).filter(Boolean).slice(0, 50).map(cardOf);
    const lists = [
      d.likedIds.length ? entity({ type: 'liked', id: null }) : null,
      ...[...store.lib.playlists].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).map((pl) => entity({ type: 'playlist', id: pl.id })),
    ]
      .filter(Boolean)
      .map(cardOf);

    // Recently added songs: a tap plays the song in that list.
    const added = [...store.lib.tracks]
      .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
      .slice(0, 20)
      .map((t) => ({ id: t.id, title: t.title, sub: t.artist, cover: specs.track(t) }));
    const addedIds = added.map((t) => t.id);
    const addedCard = (t, i) =>
      card({
        title: t.title,
        sub: t.sub,
        cover: t.cover,
        onClick: () => player.playContext({ type: 'library', id: null, name: 'Aggiunti di recente' }, addedIds, i),
      });

    const artists = [...d.artists.values()].sort((a, b) => {
      const pa = Math.max(0, ...a.trackIds.map((id) => d.trackLastPlayed.get(id) || 0));
      const pb = Math.max(0, ...b.trackIds.map((id) => d.trackLastPlayed.get(id) || 0));
      return pb - pa || b.trackIds.length - a.trackIds.length;
    });
    const artistCards = artists
      .slice(0, 20)
      .map((ar) => entity({ type: 'artist', id: ar.id }))
      .filter(Boolean)
      .map(cardOf);

    const albums = [...d.albums.values()].sort((a, b) => (b.year || 0) - (a.year || 0) || b.addedAt - a.addedAt);
    const albumCards = albums
      .slice(0, 20)
      .map((al) => {
        const e = entity({ type: 'album', id: al.id });
        return e && { ...cardOf(e), year: al.year || 0 };
      })
      .filter(Boolean);

    // Shared with you: the newest cards of the chats, each as the chat's card.
    const sharedItems = social.chatsSupported ? social.shared : [];
    warmSharedCovers(sharedItems, () => later());
    const sharedPart = sharedItems.length
      ? {
          key: 'shelf:Condivisi con te',
          sig: JSON.stringify(sharedItems.map(sharedSig)),
          build: () => {
            const el = shelf('Condivisi con te', sharedItems.map(sharedCard));
            el.classList.add('shelf-shared');
            return el;
          },
        }
      : null;

    return [
      top,
      tilesPart,
      sharedPart,
      shelfPart('Ascoltati di recente', recent),
      shelfPart('Le tue playlist', lists),
      shelfPart('Aggiunti di recente', added, addedCard),
      shelfPart('I tuoi artisti', artistCards),
      shelfPart('Album', albumCards),
    ].filter(Boolean);
  }

  function render() {
    updShown = updates.state.state !== 'none';
    upd.paint();
    if (patchParts(el, parts())) refreshAllMarks(el);
    paintOpen();
  }

  render();
  return {
    el,
    update: later,
    tab: 'home',
    destroy() {
      later.cancel();
      offUpd();
      offConn();
      offProfile();
      offSources();
      offSide();
      offSocial();
    },
  };
}
