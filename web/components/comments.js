// Comments on a song: the "Commenti" card under the full player and the sheet with all of them.
//
// Card (cm-card): head "Commenti", the count and the chevron, then the newest two (a tiny photo,
// the name with the first 4 of the ID where a name repeats, the text on one line). With none, the
// line "Aggiungi un commento". A tap opens the sheet; a tap on a photo or a name opens that
// person's page instead (and nothing else).
//
// Sheet (cm-sheet): title "Commenti" and the count; one row per person (photo, name, the time in
// words, the text), yours first; at the foot the composer, "Aggiungi un commento", 300 characters.
// A new comment shows at the top at once. While you have one the composer is not there: a long
// press on your row offers "Modifica" (the composer comes back with your text; sending replaces
// it) and "Elimina"; on someone else's row, "Elimina" only where a source you own returned it;
// otherwise a long press does nothing. A long press that lands on the list while it glides opens
// nothing (press.js). The rows are drawn 60 at a time as the list nears its end (a song may hold
// a thousand comments on each source), and a change touches only the rows that changed.

import { h, sep } from '../js/dom.js';
import { icon } from '../icons/icons.js';
import { comments, COMMENT_MAX } from '../js/comments.js';
import { cleanNote } from '../js/chat-data.js';
import { social, photoUrlOf } from '../js/social.js';
import { profile } from '../js/profile.js';
import { relTime } from '../js/when.js';
import { navigate } from '../js/router.js';
import { onLongPress } from '../js/press.js';
import { avatar, personAvatar } from './avatar.js';
import { openSheet } from './sheet.js';
import { composer } from './composer.js';

const enc = encodeURIComponent;
const PAGE = 60; // rows drawn at a time
const NEAR_END_PX = 600;

/** { name, tag, href, me, person } of a comment's author: you, someone the sources show you, or the name it came with. */
function whoOf(c) {
  const me = profile.data && profile.data.id;
  if (me && c.from === me) return { name: profile.name || c.name || 'Tu', tag: (social.me && social.me.tag) || null, href: `/persona/${enc(me)}`, me: true, person: null };
  const p = social.byId(c.from);
  // Someone the sources no longer show you (removed, invisible to you) opens nothing.
  if (p) return { name: p.name, tag: p.tag, href: p.seen === 'all' ? `/persona/${enc(p.id)}` : null, me: false, person: p };
  return { name: c.name || 'Qualcuno', tag: null, href: null, me: false, person: null };
}

const picture = (w, size) => (w.me ? avatar(size) : personAvatar({ name: w.name, photoUrl: w.person ? photoUrlOf(w.person) : null, size }));
const nameEls = (w) => [h('b', {}, w.name), w.tag ? h('span', { class: 'id-tag' }, sep(), w.tag) : null];

/** A person's photo or name: their page (and nothing under it), or plain when there is none to open. */
function personLink(w, kids, cls) {
  if (!w.href) return h('span', { class: cls }, kids);
  const a = h('a', { class: cls, href: w.href, 'data-link': '', 'aria-label': w.me ? 'Il tuo profilo' : `Profilo di ${w.name}` }, kids);
  a.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    navigate(w.href);
  });
  return a;
}

/** What a comment shows with its author (redrawn when a name or a photo changes, or once it was taken). */
const sigOf = (c) => {
  const w = whoOf(c);
  return `${c.local ? 'p' : ''}${c.id}|${c.at}|${c.text}|${w.name}|${w.tag || ''}|${w.href || ''}|${w.me ? profile.photoUrl() || '' : w.person ? w.person.photo || '' : ''}`;
};

/** The "Commenti" card. show(songId) draws it for that song (hidden where no source holds comments). */
export function commentsCard() {
  const n = h('span', { class: 'n' });
  const head = h('div', { class: 'card-head' }, h('h2', {}, 'Commenti', n), icon('chevronRight', 22));
  const body = h('div', { class: 'cm-minis' });
  const el = h('section', { class: 'cm-card', 'aria-label': 'Commenti', tabindex: '0', hidden: true }, head, body);
  let songId = null;
  let sig = '';

  function draw() {
    if (!songId || !comments.possible(songId)) {
      el.hidden = true;
      sig = '';
      return;
    }
    el.hidden = false;
    const { list, loaded } = comments.of(songId);
    const newest = [...list].sort((a, b) => b.at - a.at).slice(0, 2);
    const s = `${songId}|${loaded}|${list.length}|${newest.map(sigOf).join('/')}`;
    if (s === sig) return;
    sig = s;
    n.textContent = list.length ? String(list.length) : '';
    n.hidden = !list.length;
    if (!list.length) {
      body.replaceChildren(...(loaded ? [h('p', { class: 'cm-empty' }, 'Aggiungi un commento')] : []));
      return;
    }
    body.replaceChildren(
      ...newest.map((c) => {
        const w = whoOf(c);
        return h('div', { class: 'cm-mini' }, personLink(w, picture(w, 22), 'cm-av'), h('span', { class: 'cm-mini-text' }, personLink(w, nameEls(w), 'cm-who'), h('span', { class: 'cm-said' }, c.text)));
      })
    );
  }
  function show(id) {
    if (id !== songId) sig = '';
    songId = id;
    draw();
  }
  el.addEventListener('click', () => {
    if (songId && !el.hidden) openComments(songId);
  });
  el.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target === el) {
      e.preventDefault();
      if (songId) openComments(songId);
    }
  });
  const offs = [comments.subscribe((id) => id === songId && draw()), social.subscribe(draw), profile.subscribe(draw)];
  return { el, show, destroy: () => offs.forEach((f) => f()) };
}

let openFor = null; // the song whose sheet is open

/** The sheet of a song's comments. */
export function openComments(songId) {
  if (!songId || !comments.possible(songId) || openFor === songId) return null;
  openFor = songId;
  comments.load(songId);
  const count = h('span', { class: 'n' });
  const list = h('div', { class: 'cm-list' });
  let editing = false; // your comment is back in the composer
  const comp = composer({
    onSend: (text) => send(text),
    placeholder: 'Aggiungi un commento',
    max: COMMENT_MAX,
    clean: cleanNote,
    cls: 'in-sheet',
  });
  let shown = PAGE; // rows drawn now
  const drawn = new Map(); // comment id -> { el, sig }

  async function send(text) {
    editing = false;
    draw();
    const ok = await comments.post(songId, text);
    if (ok || layer.closed) return;
    // It did not leave: the text is back in the field (yours stays as it was when it was an edit).
    editing = !!comments.mine(songId);
    draw();
    comp.setText(text);
  }

  function rowMenu(c) {
    if (c.local || layer.closed) return;
    const own = !!profile.data && c.from === profile.data.id;
    const items = [];
    if (own) {
      items.push({
        icon: 'edit',
        label: 'Modifica',
        onSelect: () => {
          if (layer.closed) return;
          editing = true;
          draw();
          comp.setText(c.text);
          comp.input.focus({ preventScroll: true });
        },
      });
    }
    if (own || comments.mayModerate(c)) items.push({ icon: 'trash', label: 'Elimina', danger: true, onSelect: () => comments.remove(songId, c) });
    if (items.length) openSheet({ label: 'Altre opzioni', items });
  }

  function row(c) {
    const w = whoOf(c);
    const r = h(
      'div',
      { class: `cm-row${c.local ? ' is-pending' : ''}`, dataset: { id: c.id } },
      personLink(w, picture(w, 32), 'cm-av'),
      h('div', { class: 'cm-body' }, h('div', { class: 'cm-meta' }, personLink(w, nameEls(w), 'cm-who'), sep(), h('span', { class: 'when' }, relTime(c.at))), h('div', { class: 'cm-text' }, c.text))
    );
    onLongPress(r, () => rowMenu(c));
    return r;
  }

  function draw() {
    const { list: cs } = comments.of(songId);
    count.textContent = cs.length ? String(cs.length) : '';
    count.hidden = !cs.length;
    comp.el.hidden = !!comments.mine(songId) && !editing;
    if (comp.el.hidden) comp.closeEmoji();
    // The rows to show, the ones already drawn the same way kept as they are.
    const want = [];
    const keep = new Set();
    for (const c of cs.slice(0, shown)) {
      const sg = sigOf(c);
      let d = drawn.get(c.id);
      if (!d || d.sig !== sg) drawn.set(c.id, (d = { el: row(c), sig: sg }));
      want.push(d.el);
      keep.add(c.id);
    }
    for (const id of [...drawn.keys()]) if (!keep.has(id)) drawn.delete(id);
    let at = list.firstChild;
    for (const el of want) {
      if (at === el) at = at.nextSibling;
      else list.insertBefore(el, at);
    }
    while (at) {
      const next = at.nextSibling;
      at.remove();
      at = next;
    }
  }
  list.addEventListener(
    'scroll',
    () => {
      if (list.scrollTop + list.clientHeight < list.scrollHeight - NEAR_END_PX) return;
      if (shown >= comments.of(songId).list.length) return;
      shown += PAGE;
      draw();
    },
    { passive: true }
  );

  const frag = document.createDocumentFragment();
  frag.append(list, comp.el);
  const offs = [];
  const layer = openSheet({
    header: h('div', { class: 'sheet-title' }, 'Commenti', count),
    content: frag,
    label: 'Commenti',
    cls: 'cm-sheet',
    onClose: () => {
      if (openFor === songId) openFor = null;
      offs.forEach((f) => f());
      comp.destroy();
    },
  });
  offs.push(comments.subscribe((id) => id === songId && draw()), social.subscribe(draw), profile.subscribe(draw));
  draw();
  return layer;
}
