// Amici (/amici): back, "Amici", the search button; you at the top with "Recenti" and
// "Impostazioni"; then one list (components/people.js): the people of your sources by name, or,
// where the sources hold chats, the groups of your sources first ("Fonti" when there are two or
// more), the people you write with by their last message, then the others by name. Nothing else:
// no counts, no hints, no text for an empty list.
//
// The search (/amici?q=<text>, reached with the search button, a step of its own in the history)
// takes the top bar's place: back, the field, "Cancella". It filters here, live, by name or by ID,
// the groups whose name matches first; the address follows the typing without a new history step.
//
// The people and the chats come from the social store (social.js), asked at once when the page
// opens. A change draws again only the rows whose content changed, once the hands rest
// (settle.js); the times move on by themselves while the page shows.

import { h, iconBtn } from '../js/dom.js';
import { whenSettled, patchParts } from '../js/settle.js';
import { goBack, navigate, replaceQuery } from '../js/router.js';
import { social } from '../js/social.js';
import { profile } from '../js/profile.js';
import { debounce } from '../js/util.js';
import { meBlock, meSig, listed, matches, groupMatches, rowParts, chatModel, chatParts, fontiBlock, noResults, searchBar } from '../components/people.js';

const TICK_MS = 30000;

export function friendsView(query) {
  const searching = !!query && query.has('q');
  let q = (query && query.get('q')) || '';
  const el = h('div', { class: 'view view-friends' });
  const list = h('div', { class: 'ami-list' });
  const fonti = fontiBlock({ size: 40 });
  let bar = null;

  function topPart() {
    if (searching) {
      bar = searchBar({ value: q, onInput: (v) => onInput(v), onBack: () => goBack() });
      return bar.el;
    }
    const back = iconBtn('chevronLeft', 'Indietro', () => goBack(), { cls: 'back-btn', size: 26 });
    const find = iconBtn('search', 'Cerca negli amici', () => navigate('/amici?q=', { tab: true }), { cls: 'top-action' });
    return h('header', { class: 'set-top' }, back, h('h1', { class: 'set-top-title' }, 'Amici'), find);
  }

  function drawList() {
    const now = Date.now();
    let parts;
    let empty;
    if (social.chatsSupported) {
      const m = chatModel();
      const groups = searching ? m.groups.filter((c) => groupMatches(c, q)) : m.groups;
      const rows = searching ? m.rows.filter((r) => matches(r.p, q)) : m.rows;
      empty = !groups.length && !rows.length;
      parts = chatParts({ groups, rows, fonti, searching, size: 48, now });
    } else {
      const all = listed(social.people);
      const shown = searching ? all.filter((p) => matches(p, q)) : all;
      empty = !shown.length;
      parts = rowParts(shown, { size: 48, now });
    }
    if (searching && q.trim() && empty) patchParts(list, [{ key: 'none', sig: q.trim(), build: () => noResults(q) }]);
    else patchParts(list, parts);
  }

  function render() {
    patchParts(
      el,
      [
        { key: 'top', sig: searching ? 'search' : 'top', build: topPart },
        searching ? { key: 'gap', sig: '', build: () => h('div', { class: 'list-gap' }) } : { key: 'me', sig: meSig(), build: meBlock },
        { key: 'list', sig: '', build: () => list },
      ],
      { carry: false }
    );
    drawList();
  }
  const later = whenSettled(render);

  // Typing: the address and the results follow once the fingers rest on the keys.
  const onInput = debounce((v) => {
    q = v;
    replaceQuery(`/amici?q=${encodeURIComponent(q)}`);
    drawList();
  }, 120);

  const offs = [social.subscribe(() => later()), profile.subscribe(() => later())];
  let tick = 0;
  const ticking = () => {
    clearInterval(tick);
    tick = document.hidden ? 0 : setInterval(() => later(), TICK_MS);
  };
  document.addEventListener('visibilitychange', ticking);
  ticking();
  render();
  return {
    el,
    tab: 'home',
    update: later,
    mounted() {
      social.refresh();
      social.refreshChats();
      if (searching && bar) bar.input.focus({ preventScroll: true });
    },
    destroy() {
      later.cancel();
      onInput.cancel?.();
      clearInterval(tick);
      document.removeEventListener('visibilitychange', ticking);
      offs.forEach((f) => f());
    },
  };
}
