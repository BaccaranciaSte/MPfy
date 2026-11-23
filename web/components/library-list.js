// "La tua libreria" list: filter chips (Playlist, Artisti, Album, Brani), sort (Recenti, Aggiunti
// di recente, Alfabetico), "Brani che ti piacciono" pinned on top. Used by the Library page and,
// in compact form, by the desktop sidebar.
//
// The rows are a windowed list (vlist.js): only those near the screen are drawn, the list is as tall
// as all of them. A change of the library reaches the list once the hands rest (settle.js) and draws
// again only the rows drawn whose own content changed, at the same offset and with the keyboard
// focus on the same row; a heart draws again only "Brani che ti piacciono". A row kept opens its
// menu on the song as it is now. On the Library page the rows keep the order they were drawn in
// while the page is open (a play does not move the row under the finger); a new filter or sort, or
// the page opened again, sorts them afresh. The songs stay sorted between changes: a change moves
// only the songs it touched (store.changed()), never a sort of the whole library.

import { h, iconBtn, sep } from '../js/dom.js';
import { icon } from '../icons/icons.js';
import { store } from '../js/store.js';
import { player } from '../js/player.js';
import { LIKED_NAME, LIBRARY_NAME } from '../js/contexts.js';
import { cmpText, ctxKey, lsGet, lsSet, nBrani } from '../js/util.js';
import { vlist } from '../js/vlist.js';
import { coverEl, specs } from './cover.js';
import { trackRow, trackRowPresses, markRow, markPlayCtx, refreshAllMarks } from './track-row.js';
import { openSheet } from './sheet.js';
import { openTrackMenu } from './menus.js';
import { whenSettled, keepFocus } from '../js/settle.js';

const FILTERS = [
  ['playlist', 'Playlist'],
  ['artist', 'Artisti'],
  ['album', 'Album'],
  ['track', 'Brani'],
];
const SORTS = [
  ['recent', 'Recenti'],
  ['added', 'Aggiunti di recente'],
  ['alpha', 'Alfabetico'],
];

function libRow({ href, name, sub, cover, round, ctx, pinned }) {
  return h(
    'a',
    { class: 'lib-row', href, 'data-link': '', dataset: { playCtx: ctxKey(ctx) } },
    coverEl(cover, { cls: 'lib-cover', round }),
    h(
      'span',
      { class: 'lib-text' },
      h('span', { class: 'lib-name' }, name),
      h('span', { class: 'lib-sub' }, pinned ? h('span', { class: 'pin' }, icon('pin', 14)) : null, subLine(...sub))
    )
  );
}

/** What a row shows: two rows with the same one look the same (only the rows drawn are asked). */
const rowSig = (e) => JSON.stringify([ctxKey(e.ctx), e.name, e.sub, e.cover, !!e.round]);
const trackSig = (t, i) => JSON.stringify([i, t.id, t.title, t.artist, specs.track(t)]);

/**
 * `list` (sorted afresh) in the order of `was` (key -> place drawn): the rows drawn keep their
 * order, a new one goes before the first drawn row that follows it in `list`. One pass: each row
 * drawn goes to its place, the new ones gathered in front of the row they come before. Returns
 * { out, same }: same when `list` holds exactly the rows of `was` (their places stand).
 */
export function keepOrder(list, keyOf, was) {
  if (!was) return { out: list, same: false };
  const slots = new Array(was.size);
  const before = new Map(); // a row drawn -> the new rows that go before it (last first)
  const tail = []; // the new rows after every row drawn (last first)
  let next = null; // walking back: the row drawn that follows
  let olds = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    const at = was.get(keyOf(e));
    if (at !== undefined) {
      slots[at] = e;
      olds++;
      next = e;
    } else if (next) {
      const b = before.get(next);
      if (b) b.push(e);
      else before.set(next, [e]);
    } else tail.push(e);
  }
  const out = [];
  for (const e of slots) {
    if (e === undefined) continue;
    const b = before.get(e);
    if (b) for (let k = b.length - 1; k >= 0; k--) out.push(b[k]);
    out.push(e);
  }
  for (let k = tail.length - 1; k >= 0; k--) out.push(tail[k]);
  return { out, same: olds === list.length && olds === was.size };
}

/**
 * The songs of `list` (sorted by cmp) with those in `moved` (ids) taken out and put back where
 * they go now (`now(id)`: the song, or null when it is gone): one pass, no sort of the list.
 */
export function moveSorted(list, moved, now, cmp) {
  const back = [];
  for (const id of moved) {
    const s = now(id);
    if (s) back.push(s);
  }
  back.sort(cmp);
  const out = [];
  let k = 0;
  for (const s of list) {
    if (moved.has(s.id)) continue;
    while (k < back.length && cmp(back[k], s) < 0) out.push(back[k++]);
    out.push(s);
  }
  while (k < back.length) out.push(back[k++]);
  return out;
}

function subLine(...parts) {
  const out = [];
  parts.filter(Boolean).forEach((p, i) => {
    if (i) out.push(sep());
    out.push(h('span', { class: 'lib-sub-part' }, p));
  });
  return out;
}

export function libraryPanel({ compact = false, scroller = null } = {}) {
  const prefix = compact ? 'mpfy.side' : 'mpfy.lib';
  let filter = lsGet(`${prefix}.filter`, null);
  let sort = lsGet(`${prefix}.sort`, 'recent');
  if (!FILTERS.some(([k]) => k === filter)) filter = null;
  if (!SORTS.some(([k]) => k === sort)) sort = 'recent';

  const chips = h('div', { class: 'chips', role: 'toolbar', 'aria-label': 'Filtri' });
  const sortBtn = h('button', { type: 'button', class: 'sort-btn' });
  const list = h('div', { class: 'lib-list' });
  const el = h('div', { class: `libpanel${compact ? ' compact' : ''}` }, chips, h('div', { class: 'sort-row' }, sortBtn), list);
  const scrollerEl = () => scroller || document.getElementById('main');
  let chipsKey = null;
  let rows = null; // the windowed list drawn: { view: what it shows, v: vlist }
  let shown = []; // the items it shows now
  let note = null; // the line drawn instead of rows ("Caricamento...", "Nessun brano")
  let pinKey = null;
  let pinEl = null;
  let order = null; // { view: filter|sort, places: key -> place } of the rows drawn (Library page)
  let sorted = null; // { sort, songs, tlp }: the songs in the sort's order, kept between changes
  // What the store moved since the songs were last sorted (store.changed() at each of its emits):
  // all when it does not say, or an emit was missed.
  let since = { all: true, songs: new Set() };
  let seen = null; // the last emit seen

  /** One more emit of the store: what it moved joins what the next drawing has to put in place. */
  function noteMoves() {
    const ch = typeof store.changed === 'function' ? store.changed() : null;
    if (!ch || ch.all || seen == null || ch.seq !== seen + 1) since.all = true;
    else for (const id of ch.songs) since.songs.add(id);
    seen = ch ? ch.seq : null;
  }

  function renderChips() {
    const k = `${filter}|${sort}`;
    if (k === chipsKey) return;
    chipsKey = k;
    chips.replaceChildren();
    if (filter) {
      chips.append(iconBtn('close', 'Rimuovi filtro', () => setFilter(null), { cls: 'chip chip-clear', size: 16 }));
    }
    for (const [key, label] of FILTERS) {
      if (filter && filter !== key) continue;
      const b = h('button', { type: 'button', class: `chip${filter === key ? ' on' : ''}`, 'aria-pressed': String(filter === key) }, label);
      b.addEventListener('click', () => setFilter(filter === key ? null : key));
      chips.append(b);
    }
    sortBtn.replaceChildren(icon('sort', 18), h('span', {}, SORTS.find(([k]) => k === sort)[1]));
    sortBtn.setAttribute('aria-label', `Ordina per: ${SORTS.find(([k]) => k === sort)[1]}`);
  }

  function setFilter(f) {
    filter = f;
    lsSet(`${prefix}.filter`, f);
    render(true);
  }

  sortBtn.addEventListener('click', () => {
    openSheet({
      header: h('div', { class: 'sheet-title' }, 'Ordina per'),
      label: 'Ordina per',
      items: SORTS.map(([key, label]) => ({
        icon: sort === key ? 'check' : 'sort',
        label,
        active: sort === key,
        onSelect: () => {
          sort = key;
          lsSet(`${prefix}.sort`, key);
          render(true);
        },
      })),
    });
  });

  /** Sort key helpers: recency of play, recency of addition, name. */
  function sortEntries(entries) {
    if (sort === 'alpha') return entries.sort((a, b) => cmpText(a.name, b.name));
    if (sort === 'added') return entries.sort((a, b) => b.added - a.added || cmpText(a.name, b.name));
    return entries.sort((a, b) => b.played - a.played || b.added - a.added || cmpText(a.name, b.name));
  }

  function collectionEntries() {
    const d = store.d;
    const lp = d.lastPlayed;
    const out = [];
    if (!filter || filter === 'playlist') {
      for (const pl of store.lib.playlists) {
        const ctx = { type: 'playlist', id: pl.id };
        out.push({ ctx, name: pl.name, sub: ['Playlist', 'Tu'], cover: specs.playlist(pl), href: `/playlist/${pl.id}`, played: lp.get(ctxKey(ctx)) || 0, added: pl.createdAt || 0 });
      }
    }
    if (!filter || filter === 'artist') {
      for (const ar of d.artists.values()) {
        const ctx = { type: 'artist', id: ar.id };
        // A loop, not a spread into Math.max: an artist may hold more songs than a call takes arguments.
        let played = lp.get(ctxKey(ctx)) || 0;
        for (const id of ar.trackIds) {
          const at = d.trackLastPlayed.get(id) || 0;
          if (at > played) played = at;
        }
        out.push({ ctx, name: ar.name, sub: ['Artista'], cover: specs.artist(ar), round: true, href: `/artist/${ar.id}`, played, added: ar.addedAt });
      }
    }
    if (!filter || filter === 'album') {
      for (const al of d.albums.values()) {
        const ctx = { type: 'album', id: al.id };
        out.push({ ctx, name: al.name, sub: ['Album', al.artist], cover: specs.album(al), href: `/album/${al.id}`, played: lp.get(ctxKey(ctx)) || 0, added: al.addedAt });
      }
    }
    return sortEntries(out);
  }

  /** How two songs compare in the sort chosen (a tie keeps the library's order, as a stable sort). */
  function songCmp() {
    const d = store.d;
    if (sort === 'alpha') return (a, b) => cmpText(a.title, b.title);
    if (sort === 'added') return (a, b) => (b.addedAt || 0) - (a.addedAt || 0);
    return (a, b) => (d.trackLastPlayed.get(b.id) || 0) - (d.trackLastPlayed.get(a.id) || 0) || (b.addedAt || 0) - (a.addedAt || 0);
  }

  /**
   * The songs in the sort's order. Sorted afresh for a new sort, or when the whole library may have
   * moved; else the songs the changes since the last drawing moved (and, sorted by plays, those
   * whose last play moved) are taken out and put back in place, in one pass (store.changed()).
   */
  function trackEntries() {
    const d = store.d;
    const s = sorted;
    const moved = since;
    since = { all: false, songs: new Set() };
    const tlp = new Map(d.trackLastPlayed);
    if (s && s.sort === sort && !moved.all) {
      if (sort === 'recent') {
        for (const [id, at] of tlp) if (s.tlp.get(id) !== at) moved.songs.add(id);
        for (const id of s.tlp.keys()) if (!tlp.has(id)) moved.songs.add(id);
      }
      const songs = moved.songs.size ? moveSorted(s.songs, moved.songs, (id) => (d.tracks.get(id)?.id === id ? d.tracks.get(id) : null), songCmp()) : s.songs;
      sorted = { sort, songs, tlp };
      return songs;
    }
    const songs = [...store.lib.tracks].sort(songCmp());
    sorted = { sort, songs, tlp };
    return songs;
  }

  /** The rows in the order drawn on the Library page (sorted afresh for a new filter or sort). */
  function inOrder(items, keyOf) {
    if (compact) return items;
    const view = `${filter}|${sort}`;
    const was = order && order.view === view ? order : null;
    // The same sorted list as last time: the same rows in the same order.
    if (was && was.src === items) return was.out;
    const { out, same } = keepOrder(items, keyOf, was ? was.places : null);
    let places = was && same ? was.places : null;
    if (!places) {
      places = new Map();
      for (let i = 0; i < out.length; i++) places.set(keyOf(out[i]), i);
    }
    order = { view, places, src: items, out };
    return out;
  }

  /** The song rows: one listener for their long presses, the song as it is now at each tap. */
  function songRows(items) {
    const ctx = { type: 'library', id: null };
    const v = vlist({
      scroller: scrollerEl,
      cls: 'lib-rows',
      rowKind: 'track',
      items,
      keyOf: (t) => t.id,
      sigOf: trackSig,
      renderRow: (t, i) =>
        trackRow(t, {
          ctx,
          ci: i,
          inList: true,
          onPlay: () =>
            player.playContext(
              { ...ctx, name: LIBRARY_NAME },
              shown.map((x) => x.id),
              i
            ),
          // A row stays while what it shows stays: its menu takes the song as it is now.
          onMenu: () => openTrackMenu(store.track(t.id) || t),
        }),
      mark: markRow,
    });
    trackRowPresses(v.el);
    return v;
  }

  function collectionRows(items) {
    const renderRow = (e) => {
      const r = libRow(e);
      markPlayCtx(r);
      return r;
    };
    return vlist({ scroller: scrollerEl, cls: 'lib-rows', rowKind: compact ? 'lib-compact' : 'lib', items, keyOf: (e) => ctxKey(e.ctx), sigOf: rowSig, renderRow, mark: markPlayCtx });
  }

  /**
   * Draws the list. mine: the person changed the filter or the sort, and the list starts afresh.
   * Otherwise the library changed: the rows drawn whose content changed are drawn again in place,
   * nothing else moves.
   */
  function render(mine = false) {
    renderChips();
    if (mine === true) order = null;
    const d = store.d;
    let view = 'loading';
    let items = [];
    let pin = null;
    let line = null;
    if (store.loaded && filter === 'track') {
      view = `track|${sort}`;
      items = inOrder(trackEntries(), (t) => t.id);
      if (!items.length) line = 'Nessun brano';
    } else if (store.loaded) {
      view = `${filter}|${sort}`;
      items = inOrder(collectionEntries(), (e) => ctxKey(e.ctx));
      if (!filter || filter === 'playlist') pin = { href: '/liked', name: LIKED_NAME, sub: ['Playlist', nBrani(d.likedIds.length)], cover: specs.liked(), ctx: { type: 'liked', id: null }, pinned: true };
      if (!items.length && filter) line = 'Niente da mostrare';
    } else line = 'Caricamento...';
    shown = items;
    const sc = scrollerEl();
    const top = sc ? sc.scrollTop : 0;
    const fresh = mine === true || !rows || rows.view !== view;
    const pk = pin ? rowSig(pin) : null;
    keepFocus(list, () => {
      if (fresh) {
        if (rows) rows.v.destroy();
        rows = null;
        pinEl = null;
        pinKey = null;
        note = null;
        list.replaceChildren();
        if (view !== 'loading') {
          rows = { view, v: filter === 'track' ? songRows(items) : collectionRows(items) };
          list.append(rows.v.el);
        }
      } else if (rows) rows.v.update(items);
      // "Brani che ti piacciono", above the rows: drawn again only when what it shows changed.
      if (pk !== pinKey) {
        const was = pinEl;
        pinEl = pin ? libRow(pin) : null;
        pinKey = pk;
        if (was && pinEl) keepFocus(was, () => was.replaceWith(pinEl), () => pinEl);
        else if (was) was.remove();
        else if (pinEl) list.prepend(pinEl);
        if (pinEl && !fresh) refreshAllMarks(list);
      }
      if ((note ? note.textContent : null) !== line) {
        if (note) note.remove();
        note = line ? h('p', { class: 'empty-small' }, line) : null;
        if (note) list.append(note);
      }
    });
    if (fresh && rows) rows.v.mounted();
    if (fresh) refreshAllMarks(list);
    // The library changed under the person: the list stays where it was.
    if (mine !== true && sc && sc.scrollTop !== top) sc.scrollTop = top;
  }

  const later = whenSettled(render);
  const update = () => {
    noteMoves();
    later();
  };
  update.cancel = later.cancel;
  seen = typeof store.changed === 'function' ? store.changed().seq : null;
  render(true);
  return {
    el,
    update,
    /** The panel went into the page: its rows are drawn for where it is scrolled. */
    mounted: () => rows && rows.v.mounted(),
    destroy: () => {
      update.cancel();
      if (rows) rows.v.destroy();
    },
  };
}
