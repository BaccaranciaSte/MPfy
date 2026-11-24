// Menus and flows: track menu, "Aggiungi alla playlist", create / rename / describe / delete a
// playlist, edit track info, delete a track from a source, covers, the "+" create menu,
// "Aggiungi brani", a song's comments and its lyrics ("Aggiungi testo" with an .lrc or a text
// file, "Togli testo").

import { h, iconBtn, sep } from '../js/dom.js';
import { icon } from '../icons/icons.js';
import { openSheet, openPanel, promptDialog, confirmDialog, formDialog } from './sheet.js';
import { coverEl, specs } from './cover.js';
import { toast } from './toast.js';
import { store } from '../js/store.js';
import { player } from '../js/player.js';
import { navigate } from '../js/router.js';
import { queueCtx } from '../js/actions.js';
import { LIKED_NAME, contextTracks } from '../js/contexts.js';
import { nBrani, norm, debounce } from '../js/util.js';
import { openUploadSheet } from './upload-sheet.js';
import { coverMenuItems, pickFile } from './cover-edit.js';
import { sources } from '../js/sources.js';
import { qualityLabel } from '../js/songs.js';
import { allowedVersion } from '../js/store.js';
import { social } from '../js/social.js';
import { openShareSheet } from './share-sheet.js';
import { cardOfTrack, cardOfAlbum, cardOfPlaylist } from '../js/music-card.js';
import { comments } from '../js/comments.js';
import { lyrics, looksSynced } from '../js/lyrics.js';
import { openComments } from './comments.js';
import { splitGenres } from '../js/genres.js';

const LYRICS_MAX_BYTES = 65536;

/** "Condividi con..." while the sources hold chats. item: what the sheet shows and sends. */
const shareItem = (item) => social.chatsSupported && { icon: 'send', label: 'Condividi con...', onSelect: () => openShareSheet(item) };

export async function toggleLike(t) {
  if (!t) return;
  if (store.isLiked(t.id)) {
    if (await store.unlike(t.id)) toast(`Rimosso da ${LIKED_NAME}`);
  } else if (await store.like(t.id)) toast(`Aggiunto a ${LIKED_NAME}`);
}

function trackHeader(t) {
  return h(
    'div',
    { class: 'sheet-item-head' },
    coverEl(specs.track(t), { cls: 'sheet-cover' }),
    h('div', { class: 'sheet-item-text' }, h('div', { class: 'sheet-item-title' }, t.title), h('div', { class: 'sheet-item-sub' }, t.artist))
  );
}

/**
 * opts: { playlistId, index } when the row belongs to a playlist (enables "Rimuovi da questa
 * playlist"). index is the row's position, or { index, id, list, song } as store.removeFromPlaylist
 * takes it: the trackId drawn there, the list it was drawn from and its song's versions then.
 */
export function openTrackMenu(t, { playlistId = null, index = null } = {}) {
  if (!t) return;
  const d = store.d;
  const liked = store.isLiked(t.id);
  const alId = d.albumOf.get(t.id);
  const arId = d.artistOf.get(t.id);
  const items = [
    { icon: liked ? 'heartFill' : 'heart', label: liked ? 'Rimuovi da Mi piace' : 'Mi piace', active: liked, onSelect: () => toggleLike(t) },
    { icon: 'plusCircle', label: 'Aggiungi alla playlist', onSelect: () => openAddToPlaylist([t.id]) },
    {
      icon: 'queueAdd',
      label: 'Aggiungi in coda',
      onSelect: () => {
        player.addToQueue([t.id]);
        toast('Aggiunto in coda');
      },
    },
    shareItem({ card: cardOfTrack(t), cover: specs.track(t), title: t.title, sub: t.artist }),
    alId && { icon: 'album', label: "Vai all'album", onSelect: () => navigate(`/album/${alId}`) },
    arId && { icon: 'artist', label: "Vai all'artista", onSelect: () => navigate(`/artist/${arId}`) },
    comments.possible(t.id) && { icon: 'chat', label: 'Commenti', onSelect: () => openComments(store.gid(t.id)) },
    // Only where the person may change the song: a member, on the versions that are theirs.
    store.versions(t.id).some(allowedVersion) && { icon: 'edit', label: 'Modifica informazioni', onSelect: () => editTrackInfo(t) },
    lyricsItem(t),
    ...coverMenuItems('track', t.id),
    playlistId != null &&
      index != null && {
        icon: 'minusCircle',
        label: 'Rimuovi da questa playlist',
        onSelect: async () => {
          const pl = d.playlists.get(playlistId);
          if (await store.removeFromPlaylist(playlistId, [index])) toast(`Rimosso da ${pl?.name || 'playlist'}`);
        },
      },
    ...sourceItems(t),
  ].filter(Boolean);
  openSheet({ header: trackHeader(t), items, label: `Opzioni per ${t.title}` });
}

/** "Aggiungi testo" on a song without lyrics, "Togli testo" on one whose lyrics the person may take away; else nothing. */
function lyricsItem(t) {
  const mine = store.lyricsVersions(t.id);
  if (!mine.length) return null;
  if (!store.hasLyrics(t.id)) return { icon: 'file', label: 'Aggiungi testo', onSelect: () => addLyricsFlow(t) };
  if (mine.some((v) => v.t.lyrics === 'synced' || v.t.lyrics === 'plain')) return { icon: 'minusCircle', label: 'Togli testo', onSelect: () => removeLyricsFlow(t) };
  return null;
}

/** The lyrics of a song from a file: on every version the person may change, replacing what was there. */
export async function addLyricsFlow(t) {
  const file = await pickFile('.lrc,text/plain');
  if (!file) return;
  if (file.size > LYRICS_MAX_BYTES) {
    toast('Testo non valido');
    return;
  }
  let text = '';
  try {
    text = await file.text();
  } catch {
    toast('Qualcosa non ha funzionato');
    return;
  }
  if (!text.trim()) {
    toast('Testo non valido');
    return;
  }
  const took = await store.putLyrics(t.id, text, looksSynced(text) ? 'synced' : 'plain');
  if (took) lyrics.forget(took);
}

export async function removeLyricsFlow(t) {
  const took = await store.removeLyrics(t.id);
  if (took) lyrics.forget(took);
}

export async function editTrackInfo(t) {
  const v = await formDialog({
    title: 'Modifica informazioni',
    fields: [
      { name: 'title', label: 'Titolo', value: t.title },
      { name: 'artist', label: 'Artista', value: t.artist },
      { name: 'album', label: 'Album', value: t.album },
      // Several, separated by commas; empty: the tags' and the catalogs'.
      { name: 'genres', label: 'Genere', value: (t.genres || []).join(', ') },
    ],
  });
  if (!v) return;
  const patch = {};
  for (const k of ['title', 'artist', 'album']) {
    const val = v[k].trim();
    if (val && val !== t[k]) patch[k] = val;
  }
  const genres = splitGenres(v.genres);
  if (genres.join('|') !== (t.genres || []).join('|')) patch.genres = genres;
  if (!Object.keys(patch).length) return;
  if (await store.editTrack(t.id, patch)) toast('Info aggiornate');
}

/**
 * "Disponibile su:" with one line per version ("<fonte>: <qualità>"), then "Elimina da <fonte>"
 * for each version the person may delete. Only the names: the state of a source lives in
 * Impostazioni.
 */
function sourceItems(t) {
  const vs = store.versions(t.id).filter((v) => !v.kept);
  if (!vs.length) return [];
  return [
    { info: true, icon: 'server', label: 'Disponibile su:', lines: vs.map((v) => `${sources.name(v.sourceId)}: ${qualityLabel(v.t)}`) },
    ...vs.filter(allowedVersion).map((v) => ({ icon: 'trash', label: `Elimina da ${sources.name(v.sourceId)}`, danger: true, onSelect: () => deleteTrackFlow(t, v.sourceId) })),
  ];
}

/**
 * Deletes one version. A member's track that others own too only loses its claim: the dialog
 * says it stays, nothing leaves the screen, no toast. Otherwise it goes for everyone.
 */
export async function deleteTrackFlow(t, src) {
  const name = sources.name(src);
  const v = store.versions(t.id).find((x) => x.sourceId === src);
  const claimOnly = store.roleOf(src) === 'member' && !!v?.t.others;
  const message = claimOnly ? `Resta su ${name}, è anche di altri.` : `Sparisce da ${name} per tutti.`;
  const ok = await confirmDialog({ title: 'Eliminare il brano?', message, okLabel: 'Elimina', danger: true });
  if (!ok) return;
  const r = await store.deleteVersion(t.id, src);
  if (r?.deleted) toast('Brano eliminato');
}

function defaultPlaylistName() {
  const names = new Set(store.lib.playlists.map((p) => p.name));
  let n = store.lib.playlists.length + 1;
  while (names.has(`La mia playlist n. ${n}`)) n++;
  return `La mia playlist n. ${n}`;
}

/** Name prompt, then creates the playlist (with trackIds when given). */
export async function createPlaylistFlow(trackIds = [], { open = true } = {}) {
  const def = defaultPlaylistName();
  const name = await promptDialog({ title: 'Dai un nome alla tua playlist', value: def, okLabel: 'Crea', maxLength: 100 });
  if (name == null) return null;
  const pl = await store.createPlaylist(name.trim() || def, '', trackIds);
  if (!pl) return null;
  toast(trackIds.length ? `Aggiunto a ${pl.name}` : 'Playlist creata');
  if (open) navigate(`/playlist/${pl.id}`);
  return pl;
}

export function openAddToPlaylist(trackIds) {
  if (!trackIds?.length) return;
  const list = h('div', { class: 'pick-list' });
  let layer = null;
  const newBtn = h(
    'button',
    { type: 'button', class: 'pick-row pick-new' },
    h('span', { class: 'pick-new-icon' }, icon('plus', 28)),
    h('span', { class: 'pick-name' }, 'Nuova playlist')
  );
  newBtn.addEventListener('click', async () => {
    if (layer.closed) return; // a double tap: the first one already chose
    await layer.close();
    createPlaylistFlow(trackIds, { open: false });
  });
  list.append(newBtn);
  const playlists = [...store.lib.playlists].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  for (const pl of playlists) {
    const b = h(
      'button',
      { type: 'button', class: 'pick-row' },
      coverEl(specs.playlist(pl), { cls: 'pick-cover' }),
      h('span', { class: 'pick-text' }, h('span', { class: 'pick-name' }, pl.name), h('span', { class: 'pick-sub' }, nBrani(pl.trackIds.length)))
    );
    b.addEventListener('click', async () => {
      if (layer.closed) return; // a double tap would add the tracks twice (duplicates are allowed)
      await layer.close();
      if (await store.addToPlaylist(pl.id, trackIds)) toast(`Aggiunto a ${pl.name}`);
    });
    list.append(b);
  }
  layer = openSheet({ header: h('div', { class: 'sheet-title' }, 'Aggiungi alla playlist'), content: list, label: 'Aggiungi alla playlist', cls: 'sheet-tall' });
}

export async function renamePlaylist(pl) {
  const name = await promptDialog({ title: 'Rinomina playlist', value: pl.name, okLabel: 'Salva', maxLength: 100 });
  if (name == null || !name.trim() || name.trim() === pl.name) return;
  if (await store.updatePlaylist(pl.id, { name: name.trim() })) toast('Playlist rinominata');
}

export async function describePlaylist(pl) {
  const description = await promptDialog({ title: 'Modifica descrizione', value: pl.description || '', placeholder: 'Aggiungi una descrizione facoltativa', okLabel: 'Salva', multiline: true, maxLength: 300 });
  if (description == null || description.trim() === (pl.description || '')) return;
  if (await store.updatePlaylist(pl.id, { description: description.trim() })) toast('Descrizione aggiornata');
}

export async function deletePlaylistFlow(pl) {
  const ok = await confirmDialog({
    title: 'Eliminare la playlist?',
    message: 'I brani restano nella libreria.',
    okLabel: 'Elimina',
    danger: true,
  });
  if (!ok) return;
  if (await store.deletePlaylist(pl.id)) {
    toast('Playlist eliminata');
    if (location.pathname === `/playlist/${pl.id}`) navigate('/library', { replace: true });
  }
}

/** The playlist "..." menu. onEdit enters the reorder/remove mode of the page. */
export function openPlaylistMenu(pl, { onEdit } = {}) {
  const ctx = { type: 'playlist', id: pl.id };
  openSheet({
    header: h(
      'div',
      { class: 'sheet-item-head' },
      coverEl(specs.playlist(pl), { cls: 'sheet-cover' }),
      h('div', { class: 'sheet-item-text' }, h('div', { class: 'sheet-item-title' }, pl.name), h('div', { class: 'sheet-item-sub' }, nBrani(pl.trackIds.length)))
    ),
    label: `Opzioni per ${pl.name}`,
    items: [
      { icon: 'queueAdd', label: 'Aggiungi in coda', onSelect: () => queueCtx(ctx) },
      { icon: 'plusCircle', label: 'Aggiungi brani', onSelect: () => openAddTracks(pl.id) },
      shareItem({ card: cardOfPlaylist(pl), cover: specs.playlist(pl), title: pl.name, sub: nBrani(pl.trackIds.length) }),
      onEdit && { icon: 'drag', label: 'Modifica playlist', onSelect: onEdit },
      { icon: 'edit', label: 'Rinomina', onSelect: () => renamePlaylist(pl) },
      { icon: 'edit', label: 'Modifica descrizione', onSelect: () => describePlaylist(pl) },
      ...coverMenuItems('playlist', pl.id),
      { icon: 'trash', label: 'Elimina playlist', danger: true, onSelect: () => deletePlaylistFlow(pl) },
    ].filter(Boolean),
  });
}

/** "..." for album, artist and liked pages. */
export function openCollectionMenu({ ctx, title, sub, cover, artistId }) {
  openSheet({
    header: h(
      'div',
      { class: 'sheet-item-head' },
      coverEl(cover, { cls: `sheet-cover${ctx.type === 'artist' ? ' round' : ''}` }),
      h('div', { class: 'sheet-item-text' }, h('div', { class: 'sheet-item-title' }, title), sub ? h('div', { class: 'sheet-item-sub' }, sub) : null)
    ),
    label: `Opzioni per ${title}`,
    items: [
      { icon: 'queueAdd', label: 'Aggiungi in coda', onSelect: () => queueCtx(ctx) },
      {
        icon: 'plusCircle',
        label: 'Aggiungi alla playlist',
        onSelect: () => openAddToPlaylist(contextTracks(ctx)),
      },
      ctx.type === 'album' && store.d.albums.has(ctx.id) && shareItem({ card: cardOfAlbum(store.d.albums.get(ctx.id)), cover, title, sub }),
      artistId && store.d.artists.has(artistId) && { icon: 'artist', label: "Vai all'artista", onSelect: () => navigate(`/artist/${artistId}`) },
      ...(ctx.type === 'album' ? coverMenuItems('album', ctx.id) : []),
    ].filter(Boolean),
  });
}

/** The "+" of the library: create a playlist or upload songs. */
export function openCreateMenu() {
  openSheet({
    label: 'Crea',
    items: [
      { icon: 'addPlaylist', label: 'Crea playlist', onSelect: () => createPlaylistFlow([], { open: true }) },
      // With only the phone's own music there is nowhere to upload.
      sources.list.length > 0 && { icon: 'upload', label: 'Carica brani', onSelect: () => openUploadSheet() },
    ].filter(Boolean),
  });
}

/** "Aggiungi brani": search the library and add songs to a playlist, one tap each. */
export function openAddTracks(playlistId) {
  const pl = store.d.playlists.get(playlistId);
  if (!pl) return;
  const added = new Set();
  const input = h('input', { class: 'text-input search-input-sheet', type: 'search', placeholder: 'Cerca nella tua libreria', 'aria-label': 'Cerca nella tua libreria', autocomplete: 'off', enterkeyhint: 'search' });
  const list = h('div', { class: 'add-list' });
  const { body } = openPanel({ title: `Aggiungi a ${pl.name}`, cls: 'panel-add' });
  body.append(h('div', { class: 'add-search' }, icon('search', 20), input), list);

  const render = () => {
    const q = norm(input.value).split(/\s+/).filter(Boolean);
    const d = store.d;
    let tracks = store.lib.tracks;
    if (q.length) tracks = tracks.filter((t) => q.every((w) => d.searchText.get(t.id).includes(w)));
    else tracks = [...tracks].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    list.replaceChildren();
    for (const t of tracks.slice(0, 100)) {
      const isAdded = added.has(t.id);
      const btn = iconBtn(isAdded ? 'checkCircle' : 'plusCircle', isAdded ? `${t.title} aggiunto` : `Aggiungi ${t.title}`, null, { cls: isAdded ? 'add-btn on' : 'add-btn' });
      btn.addEventListener('click', async () => {
        if (added.has(t.id)) return;
        added.add(t.id);
        render();
        if (!(await store.addToPlaylist(playlistId, [t.id]))) {
          added.delete(t.id);
          render();
        }
      });
      list.append(
        h(
          'div',
          { class: 'add-row' },
          coverEl(specs.track(t), { cls: 'tr-cover' }),
          h('span', { class: 'tr-text' }, h('span', { class: 'tr-title' }, h('span', { class: 'tr-title-text' }, t.title)), h('span', { class: 'tr-sub' }, h('span', { class: 'tr-sub-text' }, t.artist), sep(), h('span', { class: 'tr-sub-text' }, t.album))),
          btn
        )
      );
    }
    if (!tracks.length) list.append(h('p', { class: 'empty-small' }, 'Nessun brano trovato.'));
  };
  input.addEventListener('input', debounce(render, 120));
  render();
}
