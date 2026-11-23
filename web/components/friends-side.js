// Amici as a third column on the right of a PC window (from 900 px): the head ("Amici", search,
// "Chiudi"), then the same top as the phone (you, "Recenti", "Impostazioni") and the same list,
// with smaller rows. The search opens in the head's place, as the phone's in its top bar.
// "Recenti", "Impostazioni" and a person's page open in the main area; where the sources hold
// chats a row opens its chat inside the column (the chat panel: its top bar, the log, the composer
// at the column's foot; back returns to the list), and the main area keeps working meanwhile.
//
// Your photo in Home's top bar opens and closes it, each click of a double click too (the photo
// moves aside with the column: the second click, landing where it was, still counts on it, and
// nothing else under it takes that click); it stays as it was left on this device
// (localStorage mpfy.friends.side, "1" or "0", closed at first). Below 900 px, on the way in, and
// while no source speaks the people part it never shows (the photo goes to a page instead).

import { h, iconBtn, markFresh, staleTap } from '../js/dom.js';
import { whenSettled, patchParts } from '../js/settle.js';
import { social } from '../js/social.js';
import { sources } from '../js/sources.js';
import { profile } from '../js/profile.js';
import { debounce } from '../js/util.js';
import { meBlock, meSig, listed, matches, groupMatches, rowParts, chatModel, chatParts, fontiBlock, noResults, searchBar } from './people.js';
import { chatPanel } from './chat-panel.js';

const LS_KEY = 'mpfy.friends.side';
const TICK_MS = 30000;
const desktop = typeof matchMedia === 'function' ? matchMedia('(min-width: 900px)') : { matches: false, addEventListener() {} };

function readOpen() {
  try {
    return localStorage.getItem(LS_KEY) === '1';
  } catch {
    return false;
  }
}
function saveOpen(on) {
  try {
    localStorage.setItem(LS_KEY, on ? '1' : '0');
  } catch {
    /* kept for this session only */
  }
}

let open = readOpen();
let app = null;
let aside = null;
let shownNow = false;
let searching = false;
let q = '';
let bar = null;
let tick = 0;
let panel = null; // the chat open in the column, or null for the list
const listeners = new Set();
const head = h('div', { class: 'side-friends-slot' });
const scroll = h('div', { class: 'friends-scroll' });
const list = h('div', { class: 'ami-list' });
const fonti = fontiBlock({ size: 40 });

function emit() {
  for (const fn of listeners) {
    try {
      fn();
    } catch (err) {
      console.error('friends column listener', err);
    }
  }
}

/** The column may show here: a PC window, past the way in, a source that speaks the people part. */
const usable = () => desktop.matches && sources.social() && !document.body.classList.contains('welcome-on');

function headEl() {
  if (searching) {
    bar = searchBar({
      value: q,
      cls: 'side-lib-head side-friends-head bar-search',
      onInput: (v) => typed(v),
      onBack: () => setSearch(false),
    });
    return bar.el;
  }
  bar = null;
  return h(
    'div',
    { class: 'side-lib-head side-friends-head' },
    h('span', { class: 'side-lib-title active' }, h('span', {}, 'Amici')),
    iconBtn('search', 'Cerca negli amici', () => setSearch(true), { size: 20 }),
    iconBtn('close', 'Chiudi', () => friendsSide.setOpen(false), { size: 20 })
  );
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
    parts = chatParts({ groups, rows, fonti, searching, size: 40, now });
  } else {
    const all = listed(social.people);
    const shown = searching ? all.filter((p) => matches(p, q)) : all;
    empty = !shown.length;
    parts = rowParts(shown, { size: 40, now });
  }
  if (searching && q.trim() && empty) patchParts(list, [{ key: 'none', sig: q.trim(), build: () => noResults(q) }]);
  else patchParts(list, parts);
}

function render() {
  if (!aside || !shownNow || panel) return;
  patchParts(head, [{ key: 'head', sig: searching ? 'search' : 'head', build: headEl }], { carry: false });
  patchParts(scroll, [searching ? { key: 'gap', sig: '', build: () => h('div', { class: 'list-gap' }) } : { key: 'me', sig: meSig(), build: meBlock }, { key: 'list', sig: '', build: () => list }], { carry: false });
  drawList();
}
const later = whenSettled(render);

const typed = debounce((v) => {
  q = v;
  drawList();
}, 120);

function setSearch(on) {
  searching = !!on;
  q = '';
  typed.cancel();
  render();
  if (searching && bar) bar.input.focus({ preventScroll: true });
}

/** The chat of cid inside the column, in the list's place. */
function openChatHere(cid) {
  if (panel) return;
  panel = chatPanel(cid, { side: true, onBack: () => closeChat() });
  aside.replaceChildren(panel.el);
  aside.setAttribute('aria-label', panel.el.getAttribute('aria-label') || 'Amici');
  aside.classList.add('with-chat');
  markFresh(aside);
  panel.mounted();
  emit();
}

/** Back to the list. */
function closeChat() {
  if (!panel) return;
  const p = panel;
  panel = null;
  p.destroy();
  aside.classList.remove('with-chat');
  aside.setAttribute('aria-label', 'Amici');
  aside.replaceChildren(head, scroll);
  markFresh(aside);
  render();
  emit();
}

/** Shows or hides the column as the state and the window say. */
function apply() {
  const want = !!aside && open && usable();
  if (want === shownNow) return;
  shownNow = want;
  aside.hidden = !want;
  app.classList.toggle('with-friends', want);
  clearInterval(tick);
  tick = 0;
  if (want) {
    render();
    social.refresh();
    social.refreshChats();
    if (!document.hidden) tick = setInterval(() => later(), TICK_MS);
  } else {
    closeChat();
    if (searching) {
      searching = false;
      q = '';
    }
  }
  emit();
}

export const friendsSide = {
  /** Mounted once, in #app, after the main area. */
  mount(appEl) {
    if (aside) return;
    app = appEl;
    aside = h('aside', { class: 'friends-side', 'aria-label': 'Amici', hidden: true }, head, scroll);
    app.append(aside);
    // A row of a chat opens it here, not as a page; the rest goes where its link says.
    aside.addEventListener('click', (e) => {
      const a = e.target.closest('a.ami-row[data-chat]');
      if (!a || !aside.contains(a) || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      if (staleTap(a)) return;
      openChatHere(a.dataset.chat);
    });
    desktop.addEventListener('change', apply);
    sources.subscribe(apply);
    social.subscribe(() => later());
    profile.subscribe(() => later());
    document.addEventListener('visibilitychange', () => {
      clearInterval(tick);
      tick = shownNow && !document.hidden ? setInterval(() => later(), TICK_MS) : 0;
    });
    apply();
  },
  /** The photo opens the column here (a PC window) instead of going to a page. */
  get usable() {
    return usable();
  },
  /** The column shows now. */
  get shown() {
    return shownNow;
  },
  /** The conversation open in the column, or null. */
  get chat() {
    return panel ? panel.chat.cid : null;
  },
  setOpen(on) {
    open = !!on;
    saveOpen(open);
    const was = shownNow;
    apply();
    // The column comes or goes under the pointer and the page moves aside for it: the rest of the
    // gesture that did it presses nothing on either (the photo takes its own later clicks back,
    // views/home.js).
    if (shownNow !== was) {
      markFresh(aside);
      markFresh(document.getElementById('main'));
    }
    emit();
  },
  toggle() {
    friendsSide.setOpen(!shownNow);
  },
  /** Opens a conversation in the column (opening the column first). */
  openChat(cid) {
    if (!shownNow) friendsSide.setOpen(true);
    if (!shownNow) return false;
    closeChat();
    openChatHere(cid);
    return true;
  },
  /** The way in came or went (app.js). */
  recheck: () => apply(),
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
