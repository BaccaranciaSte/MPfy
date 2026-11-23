// The people as the page draws them, the same on a phone (Amici, views/friends.js) and in the PC's
// right column (friends-side.js): you at the top (your photo, your name and "Visualizza profilo",
// then the plain rows "Recenti" and "Impostazioni"), a thin line, then ONE list, and the search by
// name or ID that takes the top bar's place.
//
// Without chats (no source holds them): the people of your sources by name; a row shows the photo
// (with the playing badge while they listen now), the name (and the first 4 of the ID when someone
// of your circle has the same name) and one line: what they play now, else what they last played
// with how long ago. A tap opens their page.
//
// With chats: first the groups of your sources (one: its row; two or more: the "Fonti" block, kept
// open or closed on this device, with its own search), then the people you have a conversation
// with, by its last message, then the others by name. Blocked people never show; someone the
// sources show only in a chat, only with that chat. A person's line is the first that applies: an
// unread message, what they play now, the last message, what they last played; on the right the
// time of the last message and the unread count (grey when silenced, with the crossed bell after
// the name). A tap opens the chat; a long press offers to silence it.

import { h, iconBtn, sep, markFresh } from '../js/dom.js';
import { patchParts } from '../js/settle.js';
import { icon, eqEl } from '../icons/icons.js';
import { avatar, avatarSig, personAvatar } from './avatar.js';
import { profile } from '../js/profile.js';
import { social, photoUrlOf } from '../js/social.js';
import { norm } from '../js/util.js';
import { idMatches } from '../js/profile-id.js';
import { relTime, listTime } from '../js/when.js';
import { splitName, KIND_ICON } from '../js/chat-data.js';
import { onLongPress } from '../js/press.js';
import { srcMark, srcStack } from './chat-panel.js';
import { openMuteSheet } from './chat-menus.js';

/** You, at the top. */
export function meBlock() {
  const id = profile.data?.id;
  const main = h(
    'a',
    { class: 'me-main', href: id ? `/persona/${id}` : '/impostazioni/profilo', 'data-link': '', 'aria-label': 'Il tuo profilo' },
    avatar(48, { cls: 'me-av' }),
    h('span', { class: 'me-text' }, h('span', { class: 'me-name' }, profile.name || 'Senza nome'), h('span', { class: 'me-sub' }, 'Visualizza profilo'))
  );
  const row = (ic, label, href) => h('a', { class: 'me-row', href, 'data-link': '' }, h('span', { class: 'me-row-ic' }, icon(ic, 24)), h('span', { class: 'me-row-text' }, label));
  return h('div', { class: 'me' }, main, row('history', 'Recenti', '/recenti'), row('settings', 'Impostazioni', '/impostazioni'));
}

/** What the "you" block shows: it is drawn again only when this changes. */
export const meSig = () => JSON.stringify([profile.data?.id || null, profile.name, avatarSig()]);

const byName = (a, b) => a.name.localeCompare(b.name, 'it', { sensitivity: 'base' }) || (a.pid < b.pid ? -1 : a.pid > b.pid ? 1 : 0);

/** The people of the list without chats: the ones every source shows ("all"), by name, equal names by ID. */
export const listed = (people) => people.filter((p) => p.seen === 'all' && !p.blocked).sort(byName);

/**
 * The query finds the person: in the name (accents and case aside), or, from 2 characters, as
 * the start of the profile ID (read with O as 0, I and L as 1, without hyphens and spaces). Someone
 * you see only in a chat is found by name only.
 */
export function matches(p, q) {
  const n = norm(q);
  if (!n) return true;
  if (norm(p.name).includes(n)) return true;
  return p.seen === 'all' && idMatches(p.pid, q);
}

/** A group matches by its name. */
export const groupMatches = (c, q) => !norm(q) || norm(c.name || c.display).includes(norm(q));

/** The line of a message: its text, or its card's icon and title. */
function msgLine(m, prefix = null) {
  const who = prefix ? h('span', { class: 't t-who' }, `${prefix}: `) : null;
  if (m.card) return [who, icon(KIND_ICON[m.card.kind] || 'note', 16), h('span', { class: 't' }, m.card.title)];
  if (prefix) return [h('span', { class: 't' }, `${prefix}: ${m.text}`)];
  return [h('span', { class: 't' }, m.text)];
}

/** A track's line: playing now (eq, title, artist) or played last (history, title, artist). */
function trackLine(t, now) {
  const artist = t.artist ? [sep(), h('span', { class: now ? 't artist' : 't' }, t.artist)] : [];
  if (now) return [eqEl(), h('span', { class: 't title' }, t.title), ...artist];
  return [icon('history', 16), h('span', { class: 't' }, t.title), ...artist];
}

/** The line under a person's name (the rules of the header), as [kind, kids]. */
function personLine(p, conv) {
  const last = conv && conv.last;
  if (last && conv.unread > 0 && !last.mine) return ['unread', msgLine(last)];
  if (p.now) return ['now', trackLine(p.now, true)];
  if (last) return ['last', msgLine(last)];
  if (p.last) return ['played', trackLine(p.last, false)];
  return ['none', null];
}

/** The time on the right: the last message's, else how long ago they last played (not while playing now). */
function timeOf(p, conv, now) {
  if (conv && conv.last) return listTime(conv.at || conv.last.at, now);
  return !p.now && p.last ? relTime(p.last.at, now) : '';
}

const countEl = (n, muted) => (n ? h('span', { class: `badge count${muted ? ' muted' : ''}`, 'aria-label': `${n} non letti` }, String(n)) : null);
const mutedEl = () => h('span', { class: 'muted-ic', role: 'img', 'aria-label': 'silenziata' }, icon('bellOff', 14));

/** One person. size: the photo, 48 on the phone, 40 in the column. conv: their chat (with chats on). */
export function personRow(p, { size = 48, now = Date.now(), conv = null, chats = false } = {}) {
  const muted = !!conv && conv.muted;
  const unread = conv ? conv.unread : 0;
  const av = h('span', { class: 'ami-av' }, personAvatar({ name: p.name, photoUrl: photoUrlOf(p), size }), p.now ? h('span', { class: 'now-badge' }, eqEl()) : null);
  const who = h('span', { class: 'ami-who' }, h('span', { class: 'ami-name' }, p.name), p.tag ? h('span', { class: 'id-tag' }, sep(), p.tag) : null, muted ? mutedEl() : null);
  const time = chats ? timeOf(p, conv, now) : timeOf(p, null, now);
  const [, kids] = chats ? personLine(p, conv) : [null, p.now ? trackLine(p.now, true) : p.last ? trackLine(p.last, false) : null];
  const cid = (conv && conv.id) || p.chat;
  const href = chats && cid ? `/chat/${encodeURIComponent(cid)}` : `/persona/${encodeURIComponent(p.id)}`;
  const label = chats && cid ? `Chat con ${p.name}` : `Profilo di ${p.name}`;
  const row = h(
    'a',
    { class: `ami-row${unread ? ' is-unread' : ''}${muted ? ' is-muted' : ''}`, href, 'data-link': '', 'aria-label': label, dataset: chats && cid ? { person: p.id, chat: cid } : { person: p.id } },
    av,
    h(
      'span',
      { class: 'ami-text' },
      h('span', { class: 'ami-top' }, who, time ? h('span', { class: 'ami-time' }, time) : null),
      kids || unread ? h('span', { class: 'ami-line' }, h('span', { class: 'ami-line-text' }, kids), countEl(unread, muted)) : null
    )
  );
  if (chats && cid) onLongPress(row, () => openMuteSheet(cid));
  return row;
}

/** A group of a source: its mark, its name, the last message ("Gruppo" before any), the time, the unread count. */
export function groupRow(c, { size = 48, now = Date.now() } = {}) {
  const name = c.name || c.display;
  const last = c.last;
  const lineKids = last ? msgLine(last, last.mine ? 'Tu' : whoName(last)) : [h('span', { class: 't t-sub' }, 'Gruppo')];
  const row = h(
    'a',
    { class: `ami-row ami-group${c.unread ? ' is-unread' : ''}${c.muted ? ' is-muted' : ''}`, href: `/chat/${encodeURIComponent(c.id)}`, 'data-link': '', 'aria-label': `Gruppo ${name}`, dataset: { chat: c.id } },
    h('span', { class: 'ami-av' }, srcMark(size)),
    h(
      'span',
      { class: 'ami-text' },
      h('span', { class: 'ami-top' }, h('span', { class: 'ami-who' }, h('span', { class: 'ami-name' }, name), c.muted ? mutedEl() : null), last ? h('span', { class: 'ami-time' }, listTime(c.at || last.at, now)) : null),
      h('span', { class: 'ami-line' }, h('span', { class: 'ami-line-text' }, lineKids), countEl(c.unread, c.muted))
    )
  );
  onLongPress(row, () => openMuteSheet(c.id));
  return row;
}

/** The name of a message's sender, as a list line says it. */
function whoName(m) {
  const p = m.from ? social.byId(m.from) : null;
  return p ? p.name : splitName(m.name).name || 'Qualcuno';
}

const groupSig = (c, now) => JSON.stringify([c.name, c.display, c.unread, c.muted, c.last ? [c.last.id, c.last.text, c.last.card && c.last.card.title, c.last.mine, whoName(c.last)] : null, c.last ? listTime(c.at, now) : '']);

const FONTI_KEY = 'mpfy.friends.fonti';
function fontiOpen() {
  try {
    return localStorage.getItem(FONTI_KEY) === '1';
  } catch {
    return false;
  }
}
function saveFonti(on) {
  try {
    localStorage.setItem(FONTI_KEY, on ? '1' : '0');
  } catch {
    /* kept for this session only */
  }
}

/**
 * The "Fonti" block (two or more groups): closed, one row with their marks, "Fonti", how many, the
 * newest group message, its time and the sum of their unread (silenced ones aside); open, the same
 * row with only the mark, "Fonti", the count and the chevron, a field "Cerca una fonte", then the
 * groups by last message. Open or closed is kept on this device.
 */
export function fontiBlock({ size = 40 } = {}) {
  let open = fontiOpen();
  let fq = '';
  let groups = [];
  let now = Date.now();
  const head = h('div', { class: 'fonti-head' });
  const input = h('input', { class: 'text-input fonti-input', type: 'text', placeholder: 'Cerca una fonte', 'aria-label': 'Cerca una fonte', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'search' });
  const search = h('label', { class: 'add-search fonti-search' }, icon('search', 18), input);
  const list = h('div', { class: 'fonti-groups' });
  const el = h('div', { class: 'fonti-block' }, head, search, list);
  input.addEventListener('input', () => {
    fq = input.value;
    drawGroups();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
  });

  function toggle() {
    open = !open;
    saveFonti(open);
    if (!open) {
      fq = '';
      input.value = '';
    }
    draw();
    // The rest of the gesture that opened or closed it does nothing on what moved under it.
    markFresh(el);
  }

  function headRow() {
    const n = h('span', { class: 'fonti-n' }, String(groups.length));
    const chev = h('span', { class: 'fonti-chev' }, icon('chevronDown', 18));
    if (open) {
      const b = h('button', { type: 'button', class: 'ami-row ami-fonti', 'aria-expanded': 'true', 'aria-label': 'Chiudi le fonti' }, h('span', { class: 'ami-av' }, srcStack()), h('span', { class: 'ami-text' }, h('span', { class: 'ami-top' }, h('span', { class: 'ami-who' }, h('span', { class: 'ami-name' }, 'Fonti'), n, chev))));
      b.addEventListener('click', toggle);
      return b;
    }
    const newest = groups.find((c) => c.last) || null;
    const unread = groups.filter((c) => !c.muted).reduce((s, c) => s + c.unread, 0);
    const line = newest ? msgLine(newest.last, newest.last.mine ? 'Tu' : whoName(newest.last)) : null;
    const b = h(
      'button',
      { type: 'button', class: `ami-row ami-fonti${unread ? ' is-unread' : ''}`, 'aria-expanded': 'false', 'aria-label': 'Apri le fonti' },
      h('span', { class: 'ami-av' }, srcStack()),
      h(
        'span',
        { class: 'ami-text' },
        h('span', { class: 'ami-top' }, h('span', { class: 'ami-who' }, h('span', { class: 'ami-name' }, 'Fonti'), n, chev), newest ? h('span', { class: 'ami-time' }, listTime(newest.at, now)) : null),
        line || unread ? h('span', { class: 'ami-line' }, h('span', { class: 'ami-line-text' }, line), countEl(unread, false)) : null
      )
    );
    b.addEventListener('click', toggle);
    return b;
  }

  function drawGroups() {
    const shown = open ? groups.filter((c) => groupMatches(c, fq)) : [];
    patchParts(list, shown.map((c) => ({ key: `g:${c.id}`, sig: groupSig(c, now), build: () => groupRow(c, { size, now }) })));
  }

  function draw() {
    el.classList.toggle('open', open);
    search.hidden = !open;
    const newest = groups.find((c) => c.last);
    const sig = JSON.stringify([open, groups.length, open ? null : [newest ? groupSig(newest, now) : null, groups.filter((c) => !c.muted).reduce((s, c) => s + c.unread, 0)]]);
    patchParts(head, [{ key: 'head', sig, build: headRow }], { carry: false });
    drawGroups();
  }

  return {
    el,
    update(next, at = Date.now()) {
      groups = next;
      now = at;
      draw();
    },
    get open() {
      return open;
    },
  };
}

/** The people and groups of the list with chats on: { groups, rows: [{ p, conv }] }. */
export function chatModel() {
  const groups = social.conversations.filter((c) => c.kind === 'group');
  const rows = [];
  const seenIds = new Set();
  for (const c of social.conversations) {
    if (c.kind !== 'direct' || !c.with) continue;
    let p = social.byId(c.with);
    if (p && p.blocked) continue;
    if (!p) {
      const s = splitName(c.display);
      p = { id: c.with, pid: '', name: s.name || 'Qualcuno', tag: s.tag, photo: null, seen: 'chat', blocked: false, chat: c.id, sources: c.sources, now: null, last: null };
    }
    seenIds.add(p.id);
    rows.push({ p, conv: c });
  }
  const rest = social.people.filter((p) => p.seen === 'all' && !p.blocked && !seenIds.has(p.id)).sort(byName);
  for (const p of rest) rows.push({ p, conv: null });
  return { groups, rows };
}

/** The sig of a person's row: it is drawn again only when what it shows changed. */
function rowSig(p, conv, size, now, chats) {
  const t = p.now || p.last;
  return JSON.stringify([
    p.name,
    p.tag,
    p.photo,
    !!p.now,
    t ? [t.title, t.artist] : null,
    chats ? timeOf(p, conv, now) : timeOf(p, null, now),
    size,
    chats,
    conv ? [conv.id, conv.unread, conv.muted, conv.last ? [conv.last.id, conv.last.text, conv.last.card && conv.last.card.title, conv.last.mine] : null] : p.chat,
  ]);
}

/** The rows as parts (settle.js patchParts): a row is drawn again only when what it shows changed. */
export function rowParts(people, { size = 48, now = Date.now() } = {}) {
  return people.map((p) => ({ key: `p:${p.id}`, sig: rowSig(p, null, size, now, false), build: () => personRow(p, { size, now }) }));
}

/**
 * The parts of the list with chats on. fonti: the block of this list (fontiBlock), groups: those
 * to show (all of them, or the ones the search finds), rows: [{ p, conv }].
 */
export function chatParts({ groups, rows, fonti, searching = false, size = 48, now = Date.now() }) {
  const parts = [];
  if (searching) {
    for (const c of groups) parts.push({ key: `g:${c.id}`, sig: groupSig(c, now) + '|48', build: () => groupRow(c, { size: 48, now }) });
  } else if (groups.length === 1) {
    const c = groups[0];
    parts.push({ key: `g:${c.id}`, sig: groupSig(c, now) + `|${size}`, build: () => groupRow(c, { size, now }) });
  } else if (groups.length > 1) {
    fonti.update(groups, now);
    parts.push({ key: 'fonti', sig: 'fonti', build: () => fonti.el });
  }
  for (const { p, conv } of rows) parts.push({ key: `p:${p.id}`, sig: rowSig(p, conv, size, now, true), build: () => personRow(p, { size, now, conv, chats: true }) });
  return parts;
}

/** "Nessun risultato per "<q>"". */
export const noResults = (q) => h('div', { class: 'empty ami-none' }, h('h2', {}, `Nessun risultato per "${q.trim()}"`));

/**
 * The search in a top bar's place: back, the field "Cerca per nome o ID", "Cancella" while it is
 * not empty. onInput(text) after each change (the caller waits for the typing to rest).
 */
export function searchBar({ value = '', onInput, onBack, cls = 'set-top bar-search' }) {
  const input = h('input', {
    class: 'text-input ami-search-input',
    type: 'text',
    placeholder: 'Cerca per nome o ID',
    'aria-label': 'Cerca negli amici',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    enterkeyhint: 'search',
  });
  input.value = value;
  const clear = iconBtn(
    'close',
    'Cancella',
    () => {
      input.value = '';
      clear.hidden = true;
      onInput('');
      input.focus();
    },
    { cls: 'search-clear', size: 20 }
  );
  clear.hidden = !value;
  input.addEventListener('input', () => {
    clear.hidden = !input.value;
    onInput(input.value);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur(); // the phone keyboard goes, the results show
  });
  const back = iconBtn('chevronLeft', 'Indietro', () => onBack(), { cls: 'back-btn', size: 26 });
  const el = h('header', { class: cls }, back, h('label', { class: 'add-search' }, icon('search', 20), input, clear));
  return { el, input };
}
