// Recenti (/recenti): your own listening history, only yours, from every device (each device's
// plays reach the principal through the played outbox). Newest first, under the day they were
// played ("Oggi", "Ieri", then the date), each play a row of the library's kind (cover, title,
// artist) followed by the name of what it was played from. The same song played twice is two
// rows. A tap plays it in that context from that song while the context still holds it, else
// alone; a long press opens the usual menu. Songs no longer in your library are left out. No
// statistics anywhere, no text for an empty list.
//
// The plays come from the principal (GET /api/recents), 100 at a time, the next 100 once the end
// of the list comes within 600 px. While they come, and when the principal is away or older, the
// newest 50 the library keeps show (no more pages then).
//
// Each day's plays are a windowed list (vlist.js): only the rows near the screen are drawn, every
// day as tall as all its rows; a new page draws again only the rows drawn whose content changed.
// Rows carry data-ci, the play's place in the whole list, and share one long press listener per
// day (press.js onLongPressIn).

import { h, iconBtn, sep } from '../js/dom.js';
import { whenSettled, patchParts } from '../js/settle.js';
import { goBack } from '../js/router.js';
import { sources } from '../js/sources.js';
import { srcApi } from '../js/api.js';
import { store } from '../js/store.js';
import { player } from '../js/player.js';
import { contextTracks, contextName, contextExists } from '../js/contexts.js';
import { recentsDay } from '../js/when.js';
import { vlist } from '../js/vlist.js';
import { trackRow, trackRowPresses, markRow, refreshAllMarks } from '../components/track-row.js';
import { openTrackMenu } from '../components/menus.js';

const PAGE = 100;
const NEAR_PX = 600;
const CTX_TYPES = ['playlist', 'album', 'artist', 'liked', 'search', 'library'];

/** A play as the page keeps it: { trackId, at, context }, or null. */
export function normPlay(r) {
  if (!r || typeof r.trackId !== 'string' || !Number.isFinite(Number(r.at))) return null;
  const c = r.context && typeof r.context === 'object' && CTX_TYPES.includes(r.context.type) ? { type: r.context.type, id: r.context.id ?? null } : { type: 'library', id: null };
  return { trackId: r.trackId, at: Number(r.at), context: c };
}

/** The name of what a play came from, or null (the library, or a list that is gone). */
export function playFromName(ctx) {
  if (!ctx || ctx.type === 'library') return null;
  if (ctx.type === 'search') return ctx.id ? `Ricerca: ${ctx.id}` : contextName(ctx);
  return contextExists(ctx) ? contextName(ctx) : null;
}

/** The plays by day, newest first: [{ label, plays: [{ play, song }] }]; songs no longer here left out. */
export function groupByDay(plays, now = Date.now()) {
  const out = [];
  if (!store.loaded || !store.d) return out;
  for (const play of [...plays].sort((a, b) => b.at - a.at)) {
    const song = store.track(play.trackId);
    if (!song) continue;
    const label = recentsDay(play.at, now);
    const last = out[out.length - 1];
    if (last && last.label === label) last.plays.push({ play, song });
    else out.push({ label, plays: [{ play, song }] });
  }
  return out;
}

/** Plays it in its context from that song when the context still holds it, else alone. */
export function playRecent(play, song) {
  const ctx = play.context;
  const ids = ctx && ctx.type !== 'library' && ctx.type !== 'search' ? contextTracks(ctx) : [];
  const at = ids.indexOf(song.id);
  if (at >= 0) player.playContext({ type: ctx.type, id: ctx.id ?? null, name: contextName(ctx) }, ids, at);
  else player.playContext({ type: 'library', id: null }, [song.id], 0);
}

export function recentsView() {
  const scroller = document.getElementById('main');
  const el = h('div', { class: 'view view-recents' });
  const list = h('div', { class: 'recents' });
  const end = h('div', { class: 'recents-end', 'aria-hidden': 'true' });
  let plays = []; // from the principal, or the library's
  let fromSource = false; // the plays came from the principal
  let more = false;
  let loading = false;
  let gone = false;
  let settled = false; // the principal gave its first page, or said it has none (an older one)
  const lists = new Map(); // day part key -> { v, plays }: each day's windowed rows

  const libraryPlays = () => (store.loaded ? store.lib.recents : []).map(normPlay).filter(Boolean).sort((a, b) => b.at - a.at).slice(0, 50);

  async function load(before = null) {
    const p = store.principalId; // the home of the person's data (the phone's store too)
    if (loading || !p || !sources.isUp(p) || (!before && settled)) return;
    loading = true;
    try {
      const data = await srcApi(p).recents(before, PAGE);
      if (gone) return;
      const page = (Array.isArray(data?.recents) ? data.recents : []).map(normPlay).filter(Boolean);
      plays = before ? plays.concat(page) : page;
      fromSource = true;
      settled = true;
      more = data?.more === true && page.length > 0;
    } catch (err) {
      // A principal from before "Recenti" (it knows no such page): the library's 50, no more pages.
      // Away: the same for now, asked again when it comes back.
      if (!before && err && err.status >= 400 && err.status < 500) settled = true;
      if (before) more = false;
    } finally {
      loading = false;
    }
    if (!gone) {
      render();
      nearEnd();
    }
  }

  function rowOf({ play, song, ci }) {
    const from = playFromName(play.context);
    const sub = from ? [song.artist, sep(), from] : [song.artist];
    return trackRow(song, { sub, ci, inList: true, onPlay: () => playRecent(play, song), onMenu: () => openTrackMenu(store.track(song.id) || song) });
  }

  /** What a row shows, and its place in the whole list. */
  const rowSig = ({ play, song, ci }) => JSON.stringify([ci, play.trackId, play.at, song.id, song.title, song.artist, playFromName(play.context)]);

  /** A day: its label, then its plays as a windowed list. */
  function dayPart(key, d) {
    const v = vlist({ scroller, cls: 'track-list', rowKind: 'track', items: d.plays, keyOf: ({ play }) => `${play.trackId}|${play.at}`, sigOf: rowSig, renderRow: rowOf, mark: markRow });
    trackRowPresses(v.el);
    const old = lists.get(key);
    if (old) old.v.destroy();
    lists.set(key, { v, plays: d.plays, fresh: true });
    return h('section', { class: 'recents-day' }, h('div', { class: 'chat-day' }, d.label), v.el);
  }

  function render() {
    const shown = fromSource ? plays : libraryPlays();
    const days = groupByDay(shown);
    let ci = 0;
    for (const d of days) for (const p of d.plays) p.ci = ci++;
    const parts = days.map((d) => ({ key: `day:${d.label}`, sig: d.label, plays: d.plays, build: () => dayPart(`day:${d.label}`, d) }));
    const changed = patchParts(list, parts);
    // Every day still drawn takes its plays; a day built now draws its first rows.
    const byKey = new Map(parts.map((p) => [p.key, p.plays]));
    for (const [k, l] of lists) {
      const want = byKey.get(k);
      if (!want || !list.contains(l.v.el)) {
        l.v.destroy();
        lists.delete(k);
      } else if (l.fresh) {
        l.fresh = false;
        if (list.isConnected) l.v.mounted();
      } else {
        l.plays = want;
        l.v.update(want);
      }
    }
    if (changed) refreshAllMarks(list);
  }
  const later = whenSettled(render);

  // The end of the list within 600 px of the bottom of the screen: the next page.
  let raf = 0;
  function nearEnd() {
    if (!more || loading || !fromSource || !end.isConnected) return;
    const gap = end.getBoundingClientRect().top - scroller.getBoundingClientRect().bottom;
    if (gap < NEAR_PX) load(plays.length ? plays[plays.length - 1].at : null);
  }
  const onScroll = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      nearEnd();
    });
  };
  scroller.addEventListener('scroll', onScroll, { passive: true });

  const back = iconBtn('chevronLeft', 'Indietro', () => goBack(), { cls: 'back-btn', size: 26 });
  el.append(h('header', { class: 'set-top' }, back, h('h1', { class: 'set-top-title' }, 'Recenti'), h('span', { class: 'icon-spacer' })), list, end);
  render();
  load();
  // A page opened before the core named the sources (the app just started here), or while the
  // principal was away: its plays are asked once it is there.
  const offSources = sources.subscribe(() => {
    if (!settled) load();
  });
  return {
    el,
    tab: 'home',
    update: later,
    mounted: () => {
      for (const l of lists.values()) l.v.mounted();
      nearEnd();
    },
    destroy() {
      gone = true;
      later.cancel();
      for (const l of lists.values()) l.v.destroy();
      lists.clear();
      offSources();
      scroller.removeEventListener('scroll', onScroll);
    },
  };
}
