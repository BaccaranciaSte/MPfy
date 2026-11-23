// Cerca: "Cosa vuoi ascoltare?". Live results grouped as "Risultato migliore", "Brani", "Artisti",
// "Album", "Playlist"; matching is case and accent insensitive over title, artist and album.
// With an empty field: "Sfoglia tutto", one colored card per artist.
// A change of the library draws again only the groups whose content changed, once the hands rest
// (settle.js): a row of cards scrolled sideways stays where it is.

import { h, iconBtn, sep } from '../js/dom.js';
import { icon } from '../icons/icons.js';
import { store } from '../js/store.js';
import { player } from '../js/player.js';
import { replaceQuery } from '../js/router.js';
import { norm, cmpText, debounce } from '../js/util.js';
import { dominantColor, cachedColor, nameColor, css } from '../js/color.js';
import { coverEl, specs } from '../components/cover.js';
import { card, shelf, playCtxButton } from '../components/cards.js';
import { trackRow, refreshAllMarks } from '../components/track-row.js';
import { openTrackMenu } from '../components/menus.js';
import { whenSettled, patchParts } from '../js/settle.js';

/** Relevance of one text for the query (0 = no match). */
function score(text, q, words) {
  const n = norm(text);
  if (!n) return 0;
  if (n === q) return 100;
  if (n.startsWith(q)) return 80;
  if (words.every((w) => n.split(/\s+/).some((x) => x.startsWith(w)))) return 60;
  if (words.every((w) => n.includes(w))) return 35;
  return 0;
}

function search(query) {
  const q = norm(query);
  const words = q.split(/\s+/).filter(Boolean);
  const d = store.d;
  const tracks = [];
  for (const t of store.lib.tracks) {
    const hay = d.searchText.get(t.id);
    if (!words.every((w) => hay.includes(w))) continue;
    const s = Math.max(score(t.title, q, words) * 1.2, score(t.artist, q, words) * 0.6, score(t.album, q, words) * 0.5, 20);
    tracks.push({ t, s: s + Math.min(5, d.playCount.get(t.id) || 0) });
  }
  tracks.sort((a, b) => b.s - a.s || cmpText(a.t.title, b.t.title));

  const artists = [];
  for (const ar of d.artists.values()) {
    const s = score(ar.name, q, words);
    if (s) artists.push({ ar, s: s * 1.25 });
  }
  artists.sort((a, b) => b.s - a.s || cmpText(a.ar.name, b.ar.name));

  const albums = [];
  for (const al of d.albums.values()) {
    const hay = norm(`${al.name} ${al.artist}`);
    if (!words.every((w) => hay.includes(w))) continue;
    albums.push({ al, s: Math.max(score(al.name, q, words), score(al.artist, q, words) * 0.5, 15) });
  }
  albums.sort((a, b) => b.s - a.s || cmpText(a.al.name, b.al.name));

  const playlists = [];
  for (const pl of store.lib.playlists) {
    const hay = norm(`${pl.name} ${pl.description || ''}`);
    if (!words.every((w) => hay.includes(w))) continue;
    playlists.push({ pl, s: Math.max(score(pl.name, q, words), 15) });
  }
  playlists.sort((a, b) => b.s - a.s);

  // Best result: the strongest of the top candidates (artists win ties).
  const cands = [
    artists[0] && { kind: 'artist', s: artists[0].s, v: artists[0].ar },
    tracks[0] && { kind: 'track', s: tracks[0].s, v: tracks[0].t },
    albums[0] && { kind: 'album', s: albums[0].s, v: albums[0].al },
    playlists[0] && { kind: 'playlist', s: playlists[0].s, v: playlists[0].pl },
  ].filter(Boolean);
  const best = cands.reduce((a, b) => (b.s > a.s ? b : a), cands[0] || null);

  return { best, tracks: tracks.map((x) => x.t), artists: artists.map((x) => x.ar), albums: albums.map((x) => x.al), playlists: playlists.map((x) => x.pl) };
}

/** The top result; a song plays through playTrack(id), in the results drawn last. */
function bestCard(best, playTrack) {
  const d = store.d;
  let cover;
  let title;
  let chip;
  let href = null;
  let ctx = null;
  let round = false;
  let onPlay = null;
  if (best.kind === 'artist') {
    const ar = best.v;
    ({ cover, title, href, round } = { cover: specs.artist(ar), title: ar.name, href: `/artist/${ar.id}`, round: true });
    chip = ['Artista'];
    ctx = { type: 'artist', id: ar.id };
  } else if (best.kind === 'album') {
    const al = best.v;
    cover = specs.album(al);
    title = al.name;
    href = `/album/${al.id}`;
    chip = ['Album', sep(), al.artist];
    ctx = { type: 'album', id: al.id };
  } else if (best.kind === 'playlist') {
    const pl = best.v;
    cover = specs.playlist(pl);
    title = pl.name;
    href = `/playlist/${pl.id}`;
    chip = ['Playlist'];
    ctx = { type: 'playlist', id: pl.id };
  } else {
    const t = best.v;
    cover = specs.track(t);
    title = t.title;
    chip = ['Brano', sep(), t.artist];
    const al = d.albumOf.get(t.id);
    href = al ? `/album/${al}` : null;
    onPlay = () => playTrack(t.id);
  }
  const el = h('div', { class: 'best' }, coverEl(cover, { cls: 'best-cover', round }), h('div', { class: 'best-title' }, title), h('div', { class: 'best-sub' }, chip));
  if (href) el.append(h('a', { class: 'card-link', href, 'data-link': '', 'aria-label': title }));
  if (ctx) el.append(playCtxButton(ctx, { cls: 'best-play', label: `Riproduci ${title}` }));
  else if (onPlay) {
    const b = h('button', { type: 'button', class: 'play-ctx best-play', 'aria-label': `Riproduci ${title}` }, icon('play', 24, 'i-play'));
    b.addEventListener('click', onPlay);
    el.append(b);
  }
  return el;
}

function browseCard(ar) {
  const rgb = cachedColor(ar.coverId) || nameColor(ar.name);
  const el = h(
    'a',
    { class: 'browse-card', href: `/artist/${ar.id}`, 'data-link': '', style: { '--c': css(rgb) } },
    h('span', { class: 'browse-name' }, ar.name),
    coverEl(specs.artist(ar), { cls: 'browse-cover' })
  );
  if (!cachedColor(ar.coverId) && ar.coverId) dominantColor(ar.coverId).then((c) => c && el.style.setProperty('--c', css(c)));
  return el;
}

export function searchView(query) {
  let q = query.get('q') || '';
  const input = h('input', {
    class: 'search-input',
    type: 'search',
    placeholder: 'Cosa vuoi ascoltare?',
    'aria-label': 'Cosa vuoi ascoltare?',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    enterkeyhint: 'search',
  });
  input.value = q;
  const clear = iconBtn('close', 'Cancella ricerca', () => {
    input.value = '';
    onInput();
    input.focus();
  }, { cls: 'search-clear' });
  const box = h('label', { class: 'search-box' }, icon('search', 22), input, clear);
  const results = h('div', { class: 'search-results' });
  const el = h('div', { class: 'view view-search' }, h('header', { class: 'search-head' }, h('h1', {}, 'Cerca'), box), results);

  // The results drawn last: a song row kept from an earlier draw plays in these.
  let live = { ctx: null, ids: [] };
  const playTrack = (id) => player.playContext(live.ctx, live.ids, live.ids.indexOf(id));
  // A row stays while what it shows stays: its menu takes the song as it is now.
  const menuOf = (t) => openTrackMenu(store.track(t.id) || t);
  let drawnQ = null;
  const rowSig = (t) => [t.id, t.title, t.artist, specs.track(t)];

  function parts() {
    const d = store.d;
    if (!q.trim()) {
      const artists = [...d.artists.values()].sort((a, b) => cmpText(a.name, b.name));
      if (!artists.length) {
        const words = store.loaded ? 'La tua libreria è vuota' : 'Caricamento...';
        return [{ key: 'none', sig: words, build: () => h('p', { class: 'empty-small' }, words) }];
      }
      return [
        { key: 'browse-title', sig: '', build: () => h('h2', { class: 'section-title' }, 'Sfoglia tutto') },
        { key: 'browse', sig: JSON.stringify(artists.map((ar) => [ar.id, ar.name, ar.coverId || null, specs.artist(ar)])), build: () => h('div', { class: 'browse-grid' }, artists.map(browseCard)) },
      ];
    }
    const qt = q.trim();
    const r = search(q);
    if (!r.best) return [{ key: 'nothing', sig: qt, build: () => h('div', { class: 'empty' }, h('h2', {}, `Nessun risultato per "${qt}"`)) }];
    const ctx = { type: 'search', id: qt, name: `Ricerca: ${qt}` };
    live = { ctx, ids: r.tracks.map((t) => t.id) };
    const bv = r.best.v;
    const bestCover = { artist: specs.artist, album: specs.album, playlist: specs.playlist, track: specs.track }[r.best.kind](bv);
    const bestSig = [r.best.kind, bv.id, bv.name || bv.title, bv.artist || '', bestCover, r.best.kind === 'track' ? d.albumOf.get(bv.id) || null : null];
    const top5 = r.tracks.slice(0, 5);
    const out = [
      {
        key: 'top',
        sig: JSON.stringify([qt, bestSig, top5.map(rowSig)]),
        build: () => {
          const top = h('div', { class: 'search-top' });
          top.append(h('section', { class: 'search-best' }, h('h2', { class: 'section-title' }, 'Risultato migliore'), bestCard(r.best, playTrack)));
          if (top5.length) {
            const list = h('div', { class: 'track-list' });
            top5.forEach((t, i) => {
              list.append(trackRow(t, { ctx, ci: i, sub: [t.artist], onPlay: () => playTrack(t.id), onMenu: () => menuOf(t) }));
            });
            top.append(h('section', { class: 'search-tracks' }, h('h2', { class: 'section-title' }, 'Brani'), list));
          }
          return top;
        },
      },
    ];
    const shelfPart = (title, items) => items.length && { key: `shelf:${title}`, sig: JSON.stringify(items), build: () => shelf(title, items.map((o) => card(o))) };
    out.push(
      shelfPart('Artisti', r.artists.slice(0, 20).map((ar) => ({ href: `/artist/${ar.id}`, title: ar.name, sub: 'Artista', cover: specs.artist(ar), round: true, ctx: { type: 'artist', id: ar.id } }))),
      shelfPart('Album', r.albums.slice(0, 20).map((al) => ({ href: `/album/${al.id}`, title: al.name, sub: al.artist, cover: specs.album(al), ctx: { type: 'album', id: al.id } }))),
      shelfPart('Playlist', r.playlists.slice(0, 20).map((pl) => ({ href: `/playlist/${pl.id}`, title: pl.name, sub: 'Playlist', cover: specs.playlist(pl), ctx: { type: 'playlist', id: pl.id } })))
    );
    if (r.tracks.length > 5) {
      const more = r.tracks.slice(5, 50);
      out.push({
        key: 'more',
        sig: JSON.stringify([qt, more.map(rowSig)]),
        build: () => {
          const list = h('div', { class: 'track-list' });
          more.forEach((t, k) => {
            list.append(trackRow(t, { ctx, ci: k + 5, onPlay: () => playTrack(t.id), onMenu: () => menuOf(t) }));
          });
          return h('section', { class: 'shelf' }, h('div', { class: 'shelf-head' }, h('h2', {}, 'Altri brani')), list);
        },
      });
    }
    return out.filter(Boolean);
  }

  function render() {
    clear.hidden = !q;
    // A new search starts its rows from their first card; the same one keeps their offsets.
    const same = q.trim() === drawnQ;
    drawnQ = q.trim();
    if (patchParts(results, parts(), { carry: same })) refreshAllMarks(results);
  }
  const later = whenSettled(render);

  const onInput = debounce(() => {
    q = input.value;
    replaceQuery(q.trim() ? `/search?q=${encodeURIComponent(q)}` : '/search');
    render();
  }, 120);
  input.addEventListener('input', onInput);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur(); // hides the phone keyboard to show the results
  });

  render();
  return {
    el,
    tab: 'search',
    update: later,
    destroy: () => later.cancel(),
    mounted() {
      if (!q && matchMedia('(pointer: fine)').matches) input.focus({ preventScroll: true });
    },
  };
}
