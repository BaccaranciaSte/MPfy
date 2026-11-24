// Detail pages: playlist, album, artist, "Brani che ti piacciono".
// Big cover, title, meta line (owner "Tu", n brani, total duration), round accent play button,
// shuffle toggle, download toggle (only in the app), "..." menu. The header gets a gradient from the
// cover's dominant color, and a top bar that fills with that color as the page scrolls.
// Playlists have an edit mode ("Modifica playlist"): rename, describe, remove and drag to reorder.
//
// The page is drawn in parts (top bar, header, actions, each list and row of cards) and a change
// draws again only the parts whose content changed, once the hands rest (settle.js): a row of
// cards scrolled sideways stays where it is, and a list does not move under a finger. A list of
// songs is a windowed list (vlist.js): only the rows near the screen are drawn, and a change draws
// again only the rows drawn whose own content changed. "Popolari" (five rows) is drawn whole. The
// rows of a list share one long press listener (press.js onLongPressIn). The edit list is windowed
// too, its rows moved by index (sortable.js).

import { h, iconBtn, sep, markFresh } from '../js/dom.js';
import { whenSettled, patchParts } from '../js/settle.js';
import { icon, logoEl } from '../icons/icons.js';
import { store } from '../js/store.js';
import { player } from '../js/player.js';
import { downloads } from '../js/downloads.js';
import { goBack, openLayer, navigate } from '../js/router.js';
import { artistTrackIds, LIKED_NAME } from '../js/contexts.js';
import { dominantColor, cachedColor, css, darken, LIKED_RGB, DEFAULT_RGB, nameColor } from '../js/color.js';
import { fmtTotal, nBrani, ctxKey, clamp, mergePlaylistOrder } from '../js/util.js';
import { makeSortable } from '../js/sortable.js';
import { vlist } from '../js/vlist.js';
import { coverEl, specs, specCoverId } from '../components/cover.js';
import { card, shelf, playCtxButton } from '../components/cards.js';
import { trackRow, trackRowPresses, markRow, refreshAllMarks } from '../components/track-row.js';
import { toast } from '../components/toast.js';
import { openTrackMenu, openPlaylistMenu, openCollectionMenu, openAddTracks } from '../components/menus.js';
import { profile } from '../js/profile.js';
import { avatar, avatarSig } from '../components/avatar.js';
import { genrePage, genreHref } from '../js/genre-index.js';

const KIND_LABEL = { playlist: 'Playlist', album: 'Album', artist: 'Artista', liked: 'Playlist', genre: 'Genere' };

/** Everything a page needs, resolved from the store; null when the item does not exist. */
function model(kind, id) {
  const d = store.d;
  const entriesOf = (ids) => ids.map((tid, index) => ({ t: d.tracks.get(tid), index })).filter((e) => e.t);
  if (kind === 'playlist') {
    const pl = d.playlists.get(id);
    if (!pl) return null;
    // Each entry keeps the trackId drawn at its position: a removal names the song it showed.
    const entries = entriesOf(pl.trackIds).map((e) => ({ ...e, tid: pl.trackIds[e.index] }));
    return { title: pl.name, desc: pl.description, cover: specs.playlist(pl), entries, pl };
  }
  if (kind === 'album') {
    const al = d.albums.get(id);
    if (!al) return null;
    return { title: al.name, cover: specs.album(al), entries: entriesOf(al.trackIds), al };
  }
  if (kind === 'artist') {
    const ar = d.artists.get(id);
    if (!ar) return null;
    return { title: ar.name, cover: specs.artist(ar), entries: entriesOf(artistTrackIds(id)), ar, round: true };
  }
  if (kind === 'genre') {
    const g = genrePage(id);
    if (!g) return null;
    return { title: g.title, cover: specs.playlist({ trackIds: g.songs.slice(0, 200).map((s) => s.id) }), entries: g.songs.map((t, index) => ({ t, index })), genre: g };
  }
  return { title: LIKED_NAME, cover: specs.liked(), entries: entriesOf(d.likedIds) };
}

/** An album as a card of a row. */
const albumCard = (o) => ({ href: `/album/${o.id}`, title: o.name, sub: o.year ? String(o.year) : 'Album', cover: specs.album(o), ctx: { type: 'album', id: o.id } });

export function detailView(kind, id) {
  const ctx = { type: kind, id: kind === 'liked' ? null : id };
  const key = ctxKey(ctx);
  const scroller = document.getElementById('main');
  const el = h('div', { class: `view view-detail detail-${kind}` });
  let editing = null; // { name, description, entries, orig, shown, layer, committing }
  let topbar = null;
  let heroTitle = null;
  let colorToken = 0;
  let colorSig = null;
  let current = null;
  let shuffleBtn = null;
  let dlBtn = null;
  const lists = new Map(); // part key -> its windowed list: { v, entries }
  let editList = null; // the windowed list of the edit mode

  // ---- color ----
  function paint(rgb) {
    el.style.setProperty('--hero', css(rgb, 0.9)); // a little see-through: the speckle shows under it
    el.style.setProperty('--hero-mid', css(rgb, 0.45));
    el.style.setProperty('--hero-bar', css(darken(rgb, 0.55)));
  }
  function applyColor(m) {
    const token = ++colorToken;
    if (kind === 'liked') return paint(LIKED_RGB);
    const coverId = specCoverId(m.cover);
    const rgb = cachedColor(coverId);
    paint(rgb || (coverId ? DEFAULT_RGB : nameColor(m.title)));
    if (!rgb && coverId) dominantColor(coverId).then((c) => c && token === colorToken && paint(c));
  }

  // ---- top bar that fills while scrolling ----
  let raf = 0;
  function onScroll() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (!topbar || !heroTitle) return;
      const y = scroller.scrollTop;
      const titleBottom = heroTitle.offsetTop + heroTitle.offsetHeight;
      topbar.style.setProperty('--tb', String(clamp((y - titleBottom * 0.35) / (titleBottom * 0.6), 0, 1)));
      topbar.classList.toggle('show-title', y > titleBottom - 40);
    });
  }
  scroller.addEventListener('scroll', onScroll, { passive: true });

  // A row kept from an earlier drawing plays and opens its menu with the page as it is now.
  const playFrom = (ci) => current && player.playContext({ ...ctx, name: current.title }, current.entries.map((e) => e.t.id), ci);

  /** What the meta line shows, as plain values (the header's part is drawn again when they change). */
  function metaData(m) {
    const total = m.entries.reduce((s, e) => s + (e.t.duration || 0), 0);
    const al = m.al;
    return [m.entries.length, total, al ? [al.artist, al.year || 0, store.d.artists.has(al.artistId) ? al.artistId : null] : null];
  }

  function metaLine(m) {
    const total = m.entries.reduce((s, e) => s + (e.t.duration || 0), 0);
    const count = `${nBrani(m.entries.length)}${m.entries.length ? `, ${fmtTotal(total)}` : ''}`;
    if (kind === 'album') {
      const al = m.al;
      const artistLink = store.d.artists.has(al.artistId)
        ? h('a', { class: 'meta-owner', href: `/artist/${al.artistId}`, 'data-link': '' }, al.artist)
        : h('span', { class: 'meta-owner' }, al.artist);
      return [artistLink, sep(), h('span', {}, `Album${al.year ? ` ${al.year}` : ''}`), sep(), h('span', {}, count)];
    }
    if (kind === 'artist') return [h('span', {}, count)];
    if (kind === 'genre') {
      // A genre's page: its family first, a link back to all of it.
      const g = m.genre;
      return g.genre ? [h('a', { class: 'meta-owner', href: genreHref(g.family.id), 'data-link': '', 'data-replace': '' }, g.family.name), sep(), h('span', {}, count)] : [h('span', {}, count)];
    }
    // You: your picture (18 px) next to "Tu"; the logo on a core without profiles.
    return [h('span', { class: 'meta-owner' }, profile.data ? avatar(18, { cls: 'owner-av' }) : logoEl(18), 'Tu'), sep(), h('span', {}, count)];
  }

  function actions(m) {
    const left = h('div', { class: 'actions-left' });
    dlBtn = null;
    if (downloads.available && m.entries.length && kind !== 'genre') {
      dlBtn = h('button', { type: 'button', class: 'icon-btn dl-toggle' }, icon('download', 28, 'i-off'), icon('downloaded', 28, 'i-on'));
      // Taps in a quick run make one change, to the state of the last one (downloads.js).
      dlBtn.addEventListener('click', () => downloads.toggleContext(ctx));
      left.append(dlBtn);
    }
    left.append(
      iconBtn('moreV', `Altre opzioni per ${m.title}`, () => {
        const c = current;
        if (!c) return;
        if (kind === 'playlist') openPlaylistMenu(c.pl, { onEdit: startEdit });
        else
          openCollectionMenu({
            ctx,
            title: c.title,
            sub: kind === 'album' ? c.al.artist : kind === 'artist' ? 'Artista' : kind === 'genre' ? 'Genere' : nBrani(c.entries.length),
            cover: c.cover,
            artistId: kind === 'album' ? c.al.artistId : null,
          });
      })
    );
    shuffleBtn = h('button', { type: 'button', class: 'icon-btn toggle shuffle-toggle' }, icon('shuffle', 28));
    shuffleBtn.addEventListener('click', () => player.toggleShuffle());
    const play = playCtxButton(ctx, { cls: 'play-big', size: 28, label: `Riproduci ${m.title}` });
    if (!m.entries.length) play.disabled = true;
    const row = h('div', { class: 'actions' }, left, h('div', { class: 'actions-right' }, shuffleBtn, play));
    updateToggles();
    return row;
  }

  function updateToggles() {
    if (shuffleBtn) {
      const on = player.state.shuffle;
      shuffleBtn.classList.toggle('on', on);
      shuffleBtn.setAttribute('aria-pressed', String(on));
      shuffleBtn.setAttribute('aria-label', on ? 'Disattiva riproduzione casuale' : 'Attiva riproduzione casuale');
    }
    if (dlBtn) {
      const on = downloads.isContextOn(ctx);
      dlBtn.classList.toggle('is-on', on);
      dlBtn.setAttribute('aria-pressed', String(on));
      dlBtn.setAttribute('aria-label', on ? 'Rimuovi download' : 'Scarica');
    }
  }

  /** A song row of the list `entries` of model m, at index k of it. */
  function songRow(m, entries, e, k, { cover = true, numbered = false, startAt = 0 } = {}) {
    const ci = entries === m.entries ? k : m.entries.indexOf(e);
    // In a playlist the menu's "Rimuovi" names the position and the trackId drawn there, the
    // list it was drawn from and the versions its song had then (store.removeFromPlaylist).
    const song = (e.t.versions || []).map((v) => v.trackId);
    const slot = kind === 'playlist' ? { playlistId: id, index: { index: e.index, id: e.tid, list: m.pl.trackIds, song } } : {};
    return trackRow(e.t, {
      ctx,
      ci,
      cover,
      inList: true,
      num: numbered ? startAt + k + 1 : null,
      sub: kind === 'artist' ? e.t.album : null,
      onPlay: () => playFrom(ci),
      onMenu: () => openTrackMenu(store.track(e.t.id) || e.t, slot),
    });
  }

  /** What a row shows, and where (a row drawn again when it moved: its number and its index change). */
  const rowSig = (e, k) => JSON.stringify([k, e.t.id, e.index, e.tid || null, e.t.title, e.t.artist, kind === 'artist' ? e.t.album : null, specs.track(e.t)]);

  /** A short list drawn whole ("Popolari"). */
  function trackList(m, entries, opts) {
    const list = h('div', { class: 'track-list' });
    entries.forEach((e, k) => list.append(songRow(m, entries, e, k, opts)));
    trackRowPresses(list);
    return list;
  }

  /**
   * A part drawing one list of the page's songs (every song of the page: m.entries) as a windowed
   * list. The part stays as long as its kind of list does; the list itself follows the entries
   * (update after each drawing of the page, see render), drawing again only the rows that changed.
   */
  function listPart(partKey, m, entries, opts) {
    return {
      key: partKey,
      sig: JSON.stringify(opts || null),
      build: () => {
        // The rows keep the model they were drawn with: a kept row's menu names its own position
        // and list, which the store moves on to the list as it is now.
        const v = vlist({
          scroller,
          cls: 'track-list',
          rowKind: 'track',
          items: entries,
          keyOf: (e) => (kind === 'playlist' ? `p${e.index}` : e.t.id),
          sigOf: rowSig,
          renderRow: (e, k) => songRow(current || m, (current || m).entries, e, k, opts),
          mark: markRow,
        });
        trackRowPresses(v.el);
        const old = lists.get(partKey);
        if (old) old.v.destroy();
        lists.set(partKey, { v, entries, fresh: true });
        return v.el;
      },
    };
  }

  /** A short list part drawn whole: its sig names every row and the whole list it plays in. */
  function plainPart(partKey, m, entries, opts) {
    const all = entries === m.entries ? null : m.entries.map((e) => e.t.id);
    return { key: partKey, sig: JSON.stringify([entries.map((e, k) => rowSig(e, k)), all, opts || null]), build: () => trackList(m, entries, opts) };
  }

  /**
   * After a drawing of the page: every windowed list still in it takes the page's songs (they all
   * show m.entries), one just built draws its first rows; one no longer in the page is dropped.
   */
  function syncLists(m) {
    for (const [k, l] of lists) {
      if (!el.contains(l.v.el)) {
        l.v.destroy();
        lists.delete(k);
      } else if (l.fresh) {
        l.fresh = false;
        l.entries = m.entries;
        if (el.isConnected) l.v.mounted();
      } else if (m.entries !== l.entries) {
        l.entries = m.entries;
        l.v.update(m.entries);
      }
    }
  }

  function dropLists() {
    for (const l of lists.values()) l.v.destroy();
    lists.clear();
  }

  function topBar(m) {
    const back = iconBtn('chevronLeft', 'Indietro', () => goBack(), { cls: 'back-btn', size: 26 });
    topbar = h('div', { class: 'topbar' }, back, h('div', { class: 'topbar-title' }, m.title));
    return topbar;
  }

  function hero(m) {
    heroTitle = h('h1', { class: 'hero-title' }, m.title);
    const text = h('div', { class: 'hero-text' }, h('div', { class: 'hero-kind' }, KIND_LABEL[kind]), heroTitle);
    if (m.desc) text.append(h('p', { class: 'hero-desc' }, m.desc));
    text.append(h('div', { class: 'hero-meta' }, metaLine(m)));
    return h('div', { class: 'hero' }, coverEl(m.cover, { cls: 'hero-cover', round: !!m.round, size: 'large' }), text);
  }

  function bodyParts(m) {
    const out = [];
    if (kind === 'playlist') {
      if (!m.entries.length) {
        out.push({ key: 'empty', sig: '', build: () => h('div', { class: 'empty empty-playlist' }, h('h2', {}, 'Iniziamo a costruire la tua playlist')) });
      }
      out.push({
        key: 'add',
        sig: '',
        build: () => {
          const add = h('button', { type: 'button', class: 'add-row-btn' }, h('span', { class: 'add-row-icon' }, icon('plus', 26)), h('span', {}, 'Aggiungi a questa playlist'));
          add.addEventListener('click', () => openAddTracks(id));
          return add;
        },
      });
      if (m.entries.length) out.push(listPart('list', m, m.entries));
    } else if (kind === 'album') {
      out.push(listPart('list', m, m.entries, { cover: false, numbered: true }));
      const al = m.al;
      if (al.year) out.push({ key: 'foot', sig: String(al.year), build: () => h('p', { class: 'album-foot' }, String(al.year)) });
      const others = (store.d.artists.get(al.artistId)?.albumIds.filter((x) => x !== al.id) || []).map((x) => store.d.albums.get(x)).filter(Boolean).map(albumCard);
      if (others.length) {
        const title = `Altro di ${al.artist}`;
        out.push({ key: `shelf:${title}`, sig: JSON.stringify(others), build: () => shelf(title, others.map((o) => card(o))) });
      }
    } else if (kind === 'artist') {
      const pc = store.d.playCount;
      const played = m.entries.filter((e) => pc.get(e.t.id)).sort((a, b) => pc.get(b.t.id) - pc.get(a.t.id));
      const popular = [...played, ...m.entries.filter((e) => !pc.get(e.t.id))].slice(0, 5);
      out.push({ key: 'popular-title', sig: '', build: () => h('h2', { class: 'section-title' }, 'Popolari') });
      out.push(plainPart('popular', m, popular, { numbered: true }));
      const albums = m.ar.albumIds.map((x) => store.d.albums.get(x)).filter(Boolean).map(albumCard);
      if (albums.length) out.push({ key: 'shelf:Album', sig: JSON.stringify(albums), build: () => shelf('Album', albums.map((o) => card(o))) });
      out.push({ key: 'all-title', sig: '', build: () => h('h2', { class: 'section-title' }, 'Tutti i brani') });
      out.push(listPart('all', m, m.entries));
    } else if (kind === 'genre') {
      // The genres of the family, most songs first: "Tutto" is the whole family.
      const g = m.genre;
      out.push({
        key: 'genres',
        sig: JSON.stringify([g.id, g.family, g.genres]),
        build: () => {
          const chip = (label, gid) => h('a', { class: `chip${gid === g.id ? ' on' : ''}`, href: genreHref(gid), 'data-link': '', 'data-replace': '', 'aria-current': gid === g.id ? 'page' : null }, label);
          return h('div', { class: 'chips genre-chips' }, chip('Tutto', g.family.id), ...g.genres.filter((x) => x.name !== g.family.name).map((x) => chip(x.name, x.id)));
        },
      });
      out.push(listPart('list', m, m.entries));
    } else if (!m.entries.length) {
      out.push({ key: 'empty', sig: '', build: () => h('div', { class: 'empty' }, h('div', { class: 'empty-icon' }, icon('heart', 40)), h('h2', {}, 'I brani che ti piacciono appariranno qui')) });
    } else {
      out.push(listPart('list', m, m.entries));
    }
    return out;
  }

  function parts(m) {
    const heroSig = JSON.stringify([m.title, m.desc || '', m.cover, !!m.round, metaData(m), kind === 'album' || kind === 'artist' || kind === 'genre' ? '' : `${!!profile.data}|${avatarSig()}`]);
    return [
      { key: 'bg', sig: '', build: () => h('div', { class: 'hero-bg', 'aria-hidden': 'true' }) },
      { key: 'top', sig: m.title, build: () => topBar(m) },
      { key: 'hero', sig: heroSig, build: () => hero(m) },
      { key: 'actions', sig: JSON.stringify([m.title, m.entries.length > 0, downloads.available]), build: () => actions(m) },
      ...bodyParts(m),
    ];
  }

  /** The page of something that is not there (yet). */
  function missingParts() {
    const loaded = store.loaded;
    return [
      {
        key: 'missing-top',
        sig: '',
        build: () => {
          const back = iconBtn('chevronLeft', 'Indietro', () => goBack(), { cls: 'back-btn', size: 26 });
          topbar = h('div', { class: 'topbar' }, back);
          return topbar;
        },
      },
      {
        key: 'missing',
        sig: String(loaded),
        build: () => {
          const home = h('button', { type: 'button', class: 'btn btn-light' }, 'Vai alla Home');
          home.addEventListener('click', () => navigate('/', { replace: true }));
          return h('div', { class: 'empty' }, h('h2', {}, loaded ? 'Non trovato' : 'Caricamento...'), loaded ? home : null);
        },
      },
    ];
  }

  // What the store moved since the page was last drawn (store.changed() at each of its emits): a
  // page none of whose songs, list or counts moved is not drawn again (a play report on "Brani che
  // ti piacciono" builds nothing). all: anything may have moved, or the store does not say.
  let moves = { all: true };
  let seen = typeof store.changed === 'function' ? store.changed().seq : null;

  function noteMoves() {
    const ch = typeof store.changed === 'function' ? store.changed() : null;
    if (!ch || ch.all || seen == null || ch.seq !== seen + 1) moves.all = true;
    else {
      if (ch.songs.size) moves.songs = true;
      if (kind === 'liked' && ch.likes) moves.mine = true;
      if (kind === 'playlist' && ch.playlists.has(id)) moves.mine = true;
      if ((kind === 'album' || kind === 'artist') && (ch.albums.size || ch.artists.size)) moves.mine = true;
      // "Popolari" follows the plays.
      if (kind === 'artist' && ch.recents) moves.mine = true;
    }
    seen = ch ? ch.seq : null;
  }

  function render() {
    moves = { all: false };
    const m = model(kind, id);
    current = m;
    if (!m) {
      heroTitle = null;
      shuffleBtn = null;
      dlBtn = null;
      colorSig = null;
      patchParts(el, missingParts());
      dropLists();
      return;
    }
    if (editList) {
      editList.destroy();
      editList = null;
    }
    if (editing) {
      el.replaceChildren();
      dropLists();
      colorSig = null;
      renderEdit(m);
      return;
    }
    const changed = patchParts(el, parts(m));
    syncLists(m);
    const cs = JSON.stringify([m.cover, m.title]);
    if (cs !== colorSig) {
      colorSig = cs;
      applyColor(m);
    }
    if (changed) refreshAllMarks(el);
    onScroll();
  }
  const later = whenSettled(() => {
    if (!editing && (moves.all || moves.songs || moves.mine)) render();
  });

  // ---- edit mode (playlists) ----
  function startEdit() {
    const m = model(kind, id);
    if (!m?.pl) return;
    // orig and shown: the tracks this edit cannot show (their source's library is not loaded)
    // keep their place in the order sent back (mergePlaylistOrder), they are never dropped.
    editing = { name: m.pl.name, description: m.pl.description || '', entries: m.entries.slice(), orig: m.pl.trackIds.slice(), shown: new Set(m.entries.map((x) => x.index)), committing: false };
    // A history layer, so the back button leaves edit mode instead of the page.
    editing.layer = openLayer(() => {
      const e = editing;
      editing = null;
      if (e && !e.committing) render();
    });
    render();
    scroller.scrollTop = 0;
  }

  async function commitEdit() {
    const e = editing;
    if (!e) return;
    const pl = store.d.playlists.get(id);
    e.committing = true;
    await e.layer.close();
    render();
    if (!pl) return;
    const patch = {};
    const name = e.name.trim();
    if (name && name !== pl.name) patch.name = name;
    if (e.description.trim() !== (pl.description || '')) patch.description = e.description.trim();
    // The order goes back only when the edit changed it (nothing removed, nothing moved otherwise),
    // with the list the edit started from: the source applies the edit to the list as it is now,
    // so a song added or removed elsewhere meanwhile is not undone.
    const touched = e.entries.length !== e.shown.size || e.entries.some((x, i) => i > 0 && x.index < e.entries[i - 1].index);
    if (touched) {
      patch.trackIds = mergePlaylistOrder(e.orig, e.entries, (i) => e.shown.has(i));
      patch.base = e.orig;
    }
    if (Object.keys(patch).length && (await store.updatePlaylist(id, patch))) toast('Playlist aggiornata');
  }

  function renderEdit(m) {
    const e = editing;
    const cancel = h('button', { type: 'button', class: 'link-btn' }, 'Annulla');
    cancel.addEventListener('click', () => e.layer.close());
    const done = h('button', { type: 'button', class: 'btn btn-primary btn-small' }, 'Fine');
    done.addEventListener('click', commitEdit);
    const bar = h('div', { class: 'topbar topbar-edit' }, cancel, h('div', { class: 'topbar-title' }, 'Modifica playlist'), done);

    const nameInput = h('input', { class: 'text-input text-input-big', type: 'text', maxlength: '100', 'aria-label': 'Nome della playlist' });
    nameInput.value = e.name;
    nameInput.addEventListener('input', () => (e.name = nameInput.value));
    const descInput = h('textarea', { class: 'text-input', rows: '2', maxlength: '300', placeholder: 'Aggiungi una descrizione facoltativa', 'aria-label': 'Descrizione' });
    descInput.value = e.description;
    descInput.addEventListener('input', () => (e.description = descInput.value));

    // The rows of the edit, windowed: each carries data-i, its place, and a drag or an arrow key
    // moves a song by its index (makeSortable).
    const v = vlist({
      scroller,
      cls: 'track-list edit-list',
      rowKind: 'edit',
      items: e.entries,
      keyOf: (entry) => entry.index,
      sigOf: (entry) => JSON.stringify([entry.t.id, entry.t.title, entry.t.artist, specs.track(entry.t)]),
      renderRow: (entry) => {
        const t = entry.t;
        const rm = iconBtn('minusCircle', `Rimuovi ${t.title}`, () => {
          const at = e.entries.indexOf(entry);
          if (at < 0) return;
          e.entries.splice(at, 1);
          fill();
          // The next row slid under the finger: the rest of this tap gesture does nothing in the
          // list (a double tap removes one song; a tap after a pause removes the next).
          markFresh(list);
        }, { cls: 'edit-remove' });
        return h(
          'div',
          { class: 'edit-row sortable' },
          rm,
          coverEl(specs.track(t), { cls: 'tr-cover' }),
          h('span', { class: 'tr-text' }, h('span', { class: 'tr-title' }, h('span', { class: 'tr-title-text' }, t.title)), h('span', { class: 'tr-sub' }, h('span', { class: 'tr-sub-text' }, t.artist))),
          // A button: drag it, or focus it and use the arrow keys (makeSortable).
          h('button', { type: 'button', class: 'icon-btn drag-handle', 'aria-label': `Sposta ${t.title}: frecce su e giù`, title: 'Trascina o usa le frecce per riordinare' }, icon('drag', 24))
        );
      },
    });
    const list = v.el;
    const empty = h('p', { class: 'empty-small' }, 'La playlist è vuota.');
    const fill = () => {
      v.update(e.entries);
      empty.hidden = e.entries.length > 0;
    };
    makeSortable(list, {
      item: '.sortable',
      scroller,
      size: () => e.entries.length,
      onMove: (from, to) => {
        const [x] = e.entries.splice(from, 1);
        e.entries.splice(to, 0, x);
        fill();
      },
    });
    editList = v;
    fill();
    el.append(
      bar,
      h('div', { class: 'edit-head' }, coverEl(m.cover, { cls: 'edit-cover' }), h('div', { class: 'edit-fields' }, nameInput, descInput)),
      list,
      empty
    );
    topbar = bar;
    heroTitle = null;
    if (el.isConnected) v.mounted();
  }

  const offPlayer = player.onChange(updateToggles);
  const offDl = downloads.subscribe(updateToggles);
  // Your picture next to "Tu" follows a new photo.
  const offProfile =
    kind === 'playlist' || kind === 'liked'
      ? profile.subscribe(() => {
          moves.all = true;
          if (!editing) later();
        })
      : () => {};

  render();
  return {
    el,
    tab: null,
    update() {
      noteMoves();
      if (!editing) later();
    },
    /** The page went into #main: its lists draw the rows of where it is scrolled. */
    mounted() {
      for (const l of lists.values()) l.v.mounted();
      if (editList) editList.mounted();
    },
    destroy() {
      later.cancel();
      dropLists();
      if (editList) editList.destroy();
      scroller.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf);
      offPlayer();
      offDl();
      offProfile();
      if (editing) {
        editing.committing = true; // leaving the page discards the edit silently
        editing = null;
      }
    },
    key,
    get model() {
      return current;
    },
  };
}
