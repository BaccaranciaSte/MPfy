// A conversation on screen: the chat page (views/chat.js, /chat/<cid>) and the chat inside the PC's
// right column (friends-side.js) are this same panel.
//
// The top bar: back; a 1:1 has their photo (36, 32 in the column) and name (with the tag), both to
// their page, and while they listen now what they play (a tap plays the same song from your
// library); a group has its source's mark and name. "Altre opzioni": "Silenzia" or "Riattiva
// notifiche", and in a 1:1 "Blocca <nome>". Someone the sources show only in this chat (invisible
// to you): their photo and name open nothing.
//
// The log: a day label over each day ("Oggi", "Ieri", ...); a run is one sender's messages of one
// day less than 5 minutes apart, in a group with the sender's name and tag on its first bubble and
// their photo by its last; the time in each bubble's corner. A music card is its bubble (cover,
// title, kind, play); a reply shows what it answers (a tap goes to it when it is loaded). A long
// press on a bubble: "Rispondi", "Copia", "Aggiungi in coda" (a card) and on your own "Elimina per
// tutti", which asks first. A message being sent shows faded; one the sources refused goes.
//
// Scrolling: it opens at the bottom; a new message comes into view only when the log was within
// 80 px of the bottom; the 50 older ones load as the top comes near, the messages on screen staying
// where they are. Your read mark follows the newest message while the bottom shows (at most once
// every 2 s). Redraws wait for the hands to rest (settle.js) and touch only the messages that
// changed.

import { h, iconBtn, sep } from '../js/dom.js';
import { icon, eqEl } from '../icons/icons.js';
import { whenSettled, patchParts } from '../js/settle.js';
import { social, photoUrlOf } from '../js/social.js';
import { goBack } from '../js/router.js';
import { profile } from '../js/profile.js';
import { store } from '../js/store.js';
import { openChat, readSharedPlaylist, playlistCopyNow } from '../js/chat.js';
import { layoutLog, dayKey, splitName, KIND_WORD } from '../js/chat-data.js';
import { cardCover, openCard, playCard, queueCard } from '../js/music-card.js';
import { playTheirs } from '../js/theirs.js';
import { clockTime, chatDay } from '../js/when.js';
import { bridgeVersion, nativeCall } from '../js/native.js';
import { onLongPress } from '../js/press.js';
import { personAvatar } from './avatar.js';
import { coverEl } from './cover.js';
import { openSheet, confirmDialog } from './sheet.js';
import { toast } from './toast.js';
import { composer } from './composer.js';
import { muteItem, blockFlow } from './chat-menus.js';

const NEAR_BOTTOM_PX = 80;
const NEAR_TOP_PX = 400;

/** A source's mark (the speaker on grey), 48 px or smaller. */
export const srcMark = (size = 48) => h('span', { class: `src-mark${size === 48 ? '' : ` src-mark-${size}`}`, 'aria-hidden': 'true' }, icon('speaker', 24));

/** Several sources: two marks, one behind the other. */
export const srcStack = () => h('span', { class: 'src-stack', 'aria-hidden': 'true' }, h('span', { class: 'src-mark back' }, icon('speaker', 24)), h('span', { class: 'src-mark front' }, icon('speaker', 24)));

/** A name and, when someone else has it too, the first 4 of the ID: [b, span.id-tag]. */
export const nameEls = (name, tag, tagName = 'b') => [h(tagName, {}, name), tag ? h('span', { class: 'id-tag' }, sep(), tag) : null];

/** { name, tag, person } of a sender: you are "Tu"; someone the people list holds by their card. */
export function whoOf(id, fallback = '') {
  if (id && profile.data && id === profile.data.id) return { name: 'Tu', tag: null, person: null, me: true };
  const p = id ? social.byId(id) : null;
  if (p) return { name: p.name, tag: p.tag, person: p, me: false };
  const s = splitName(fallback);
  return { name: s.name || 'Qualcuno', tag: s.tag, person: null, me: false };
}

/** A person's photo: a link to their page while the sources show them; else it opens nothing. */
function personLink(p, size, cls, name) {
  const av = personAvatar({ name: p ? p.name : name, photoUrl: p ? photoUrlOf(p) : null, size });
  if (p && p.seen === 'all') {
    const a = h('a', { class: cls, href: `/persona/${encodeURIComponent(p.id)}`, 'data-link': '', 'aria-label': `Profilo di ${p.name}` }, av);
    // The photo opens the page and nothing under it.
    a.addEventListener('click', (e) => e.stopPropagation());
    return a;
  }
  return h('span', { class: cls }, av);
}

/**
 * A music card: the cover, the title (2 lines at most), the kind and its sub, play. at: { cid,
 * messageId, from, mine } of the message that carries it.
 */
export function mcardEl(card, at) {
  const who = card.kind === 'playlist' ? (at.mine ? 'Tu' : whoOf(at.from).name) : card.sub;
  const link = h('button', { type: 'button', class: 'mcard-link', 'aria-label': card.title });
  link.addEventListener('click', () => openCard(card, at));
  const play = h('button', { type: 'button', class: 'play-ctx mcard-play', 'aria-label': `Riproduci ${card.title}` }, icon('play', 18));
  play.addEventListener('click', (e) => {
    e.stopPropagation();
    playCard(card, at);
  });
  return h(
    'div',
    { class: 'mcard' },
    coverEl(cardCover(card, at), { cls: 'mcard-cover' }),
    h('span', { class: 'mcard-text' }, h('span', { class: 'mcard-title' }, card.title), h('span', { class: 'mcard-sub' }, h('span', {}, KIND_WORD[card.kind]), who ? sep() : null, who ? h('span', {}, who) : null)),
    link,
    play
  );
}

/**
 * The quote of a reply: the bar, the quoted card's cover, its sender, its body (a card: title and
 * note; else the text). A message known to be deleted: the sender only.
 */
export function quoteEl(reply, { gone = false, original = null, onTap = null } = {}) {
  const w = whoOf(reply.from, original ? original.name : '');
  const card = reply.card || (original && original.card ? { kind: original.card.kind, id: original.card.id, title: original.card.title } : null);
  const kids = [h('span', { class: 'quote-bar', 'aria-hidden': 'true' })];
  if (card && !gone) {
    const full = original && original.card ? original.card : { ...card, sub: '' };
    kids.push(coverEl(cardCover(full, { mine: w.me }), { cls: 'quote-cover' }));
  }
  const body = gone ? null : card ? [h('span', { class: 't' }, card.title), reply.text ? sep() : null, reply.text ? h('span', { class: 't' }, reply.text) : null] : h('span', { class: 't' }, reply.text);
  kids.push(h('span', { class: 'quote-text' }, h('span', { class: 'quote-who' }, nameEls(w.name, w.tag)), body ? h('span', { class: 'quote-body' }, body) : null));
  const el = h('div', { class: 'quote' }, kids);
  if (onTap) el.addEventListener('click', onTap);
  return el;
}

/**
 * The panel of conversation cid. side: inside the PC's column (onBack goes back to its list).
 * Returns { el, mounted(), destroy() }.
 */
export function chatPanel(cid, { side = false, onBack = null } = {}) {
  const top = h('div', { class: 'chat-top-slot' });
  const log = h('div', { class: 'chat-log' });
  const scroller = h('div', { class: side ? 'chat-scroll side-chat-log' : 'chat-scroll' }, log);
  const comp = composer({ onSend: (text, reply) => sendText(text, reply), quoteOf: (m) => quoteEl(replyOf(m), { original: m }) });
  const el = h('div', { class: side ? 'side-chat' : 'view view-chat' }, top, scroller, comp.el);
  let drawnOnce = false;
  let stickToBottom = true;
  const playlistAsked = new Set();
  const chat = openChat(cid, { onChange: () => later() });

  /** What this conversation is: { kind, conv, person, name, tag, ids } (kind null while unknown). */
  function what() {
    const c = social.conversation(cid);
    if (c && c.kind === 'group') return { kind: 'group', conv: c, person: null, name: c.name || c.display, tag: null, ids: c.ids };
    const withId = c ? c.with : (social.people.find((p) => p.chat === cid) || {}).id;
    const p = withId ? social.byId(withId) : null;
    if (c || p) {
      const fallback = splitName(c ? c.display : '');
      return { kind: 'direct', conv: c, person: p, withId, name: p ? p.name : fallback.name, tag: p ? p.tag : fallback.tag, ids: c ? c.ids : [cid] };
    }
    return { kind: null, conv: null, person: null, name: '', tag: null, ids: [cid] };
  }

  /** The quote a reply to m carries, as the core will write it. */
  function replyOf(m) {
    const text = m.text ? Array.from(m.text).slice(0, 100).join('') : '';
    return { id: m.id, from: m.mine ? (profile.data && profile.data.id) || null : m.from, text, card: m.card ? { kind: m.card.kind, id: m.card.id, title: m.card.title } : null };
  }

  function sendText(text, reply) {
    stickToBottom = true;
    chat.send({ text, replyTo: reply ? reply.id : null }, { reply: reply ? replyOf(reply) : null });
  }

  // ---- the top bar ----
  function topBar(w) {
    const back = iconBtn('chevronLeft', 'Indietro', () => (onBack ? onBack() : goBack()), { cls: 'back-btn', size: 26 });
    const more = w.kind ? iconBtn('moreV', 'Altre opzioni', () => openOptions(), { cls: 'chat-more' }) : null;
    if (w.kind === 'group') {
      return h('header', { class: 'chat-top' }, back, h('span', { class: 'chat-av' }, srcMark(side ? 32 : 36)), h('div', { class: 'chat-who' }, h('span', { class: 'chat-name' }, h('b', {}, w.name))), more);
    }
    if (w.kind !== 'direct') return h('header', { class: 'chat-top' }, back);
    const p = w.person;
    const open = !!p && p.seen === 'all';
    const href = open ? `/persona/${encodeURIComponent(p.id)}` : null;
    const av = personAvatar({ name: w.name, photoUrl: p ? photoUrlOf(p) : null, size: side ? 32 : 36 });
    const avEl = open ? h('a', { class: 'chat-av', href, 'data-link': '', 'aria-label': `Profilo di ${w.name}` }, av) : h('span', { class: 'chat-av' }, av);
    const nameEl = open ? h('a', { class: 'chat-name', href, 'data-link': '' }, nameEls(w.name, w.tag)) : h('span', { class: 'chat-name' }, nameEls(w.name, w.tag));
    const now = p && p.now ? p.now : null;
    let nowEl = null;
    if (now) {
      nowEl = h(
        'button',
        { type: 'button', class: 'chat-now', 'aria-label': `Riproduci ${now.title}${now.artist ? ` di ${now.artist}` : ''}` },
        eqEl(),
        h('span', { class: 't title' }, now.title),
        now.artist ? sep() : null,
        now.artist ? h('span', { class: 't artist' }, now.artist) : null
      );
      nowEl.addEventListener('click', () => playTheirs(now));
    }
    return h('header', { class: 'chat-top' }, back, avEl, h('div', { class: 'chat-who' }, nameEl, nowEl), more);
  }

  function openOptions() {
    const w = what();
    if (!w.kind) return;
    const items = [muteItem(w.conv ? w.conv.id : cid)];
    if (w.kind === 'direct' && w.withId) items.push({ icon: 'block', label: `Blocca ${w.name}`, danger: true, onSelect: () => blockFlow({ id: w.withId, name: w.name }, { after: side ? onBack : null }) });
    openSheet({ label: 'Altre opzioni', items });
  }

  // ---- the messages ----
  function atOf(m) {
    return { cid, messageId: m.id, from: m.mine ? (profile.data && profile.data.id) || null : m.from, mine: m.mine };
  }

  function msgMenu(m) {
    if (m.local) return;
    const items = [{ icon: 'reset', label: 'Rispondi', onSelect: () => comp.setReply(m) }];
    if (m.card) items.push({ icon: 'queueAdd', label: 'Aggiungi in coda', onSelect: () => queueCard(m.card, atOf(m)) });
    if (m.text) items.push({ icon: 'copy', label: 'Copia', onSelect: () => copyText(m.text) });
    if (m.mine) items.push({ icon: 'trash', label: 'Elimina per tutti', danger: true, onSelect: () => deleteFlow(m) });
    openSheet({ label: 'Opzioni del messaggio', items });
  }

  async function deleteFlow(m) {
    const ok = await confirmDialog({ title: 'Eliminare il messaggio per tutti?', message: null, okLabel: 'Elimina', danger: true });
    if (ok) chat.remove(m.id);
  }

  async function copyText(text) {
    let ok = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (!ok) {
      // The old way, for a page without the clipboard API.
      const ta = h('textarea', { class: 'visually-hidden', 'aria-hidden': 'true' });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      ta.remove();
    }
    toast(ok ? 'Copiato' : 'Qualcosa non ha funzionato');
  }

  function jumpTo(id) {
    const target = log.querySelector(`.msg[data-id="${id}"]`);
    if (!target) return;
    target.scrollIntoView({ block: 'center' });
    target.classList.remove('is-flash');
    void target.offsetWidth;
    target.classList.add('is-flash');
  }

  function msgEl(m, place, group) {
    const kids = [];
    const w = m.mine ? null : whoOf(m.from, m.name);
    if (group && !m.mine && place.run) kids.push(h('div', { class: 'msg-name' }, nameEls(w.name, w.tag, 'span')));
    if (m.reply) {
      const original = chat.find(m.reply.id);
      kids.push(quoteEl(m.reply, { gone: m.reply.gone || (!original && chat.isGone(m.reply.id)), original, onTap: () => jumpTo(m.reply.id) }));
    }
    if (m.card) kids.push(mcardEl(m.card, atOf(m)));
    kids.push(h('span', { class: 'msg-text' }, m.text || '', h('span', { class: 'msg-pad', 'aria-hidden': 'true' })));
    kids.push(h('span', { class: 'msg-time' }, clockTime(m.at)));
    const bubble = h('div', { class: `bubble${m.card ? ' has-card' : ''}${m.reply ? ' has-quote' : ''}` }, kids);
    onLongPress(bubble, () => msgMenu(m));
    let av = null;
    if (group && !m.mine) av = place.end ? personLink(w.person, 28, 'msg-av', w.name) : h('span', { class: 'msg-av blank' });
    return h('div', { class: `msg ${m.mine ? 'mine' : 'theirs'}${place.run ? ' run' : ''}${place.end ? ' end' : ''}${m.state === 'pending' ? ' is-pending' : ''}`, dataset: { id: m.id } }, av, bubble);
  }

  function sigOf(m, place, group) {
    const w = m.mine ? null : whoOf(m.from, m.name);
    const original = m.reply ? chat.find(m.reply.id) : null;
    return JSON.stringify([
      m.state,
      m.text,
      m.card,
      m.card ? cardCover(m.card, atOf(m)) : null,
      m.reply,
      m.reply ? [!!original, chat.isGone(m.reply.id), original && original.card ? cardCover(original.card, atOf(original)) : null] : null,
      place.run,
      place.end,
      group,
      w ? [w.name, w.tag, w.person ? [w.person.photo, w.person.seen] : null] : null,
      clockTime(m.at),
    ]);
  }

  /** Playlist cards: read once while the chat is open, for their covers (the mosaic). */
  function askPlaylists(msgs) {
    for (const m of msgs) {
      const c = m.card;
      if (!c || c.kind !== 'playlist' || m.local || (m.mine && store.d && store.d.playlists.has(c.id))) continue;
      if (playlistAsked.has(m.id) || playlistCopyNow(cid, m.id)) continue;
      playlistAsked.add(m.id);
      readSharedPlaylist(cid, m.id).then((r) => r && r.playlist && later());
    }
  }

  function render() {
    const w = what();
    patchParts(top, [{ key: 'top', sig: JSON.stringify([w.kind, w.name, w.tag, w.person ? [w.person.photo, w.person.seen, w.person.now && [w.person.now.title, w.person.now.artist]] : null]), build: () => topBar(w) }], { carry: false });
    el.classList.toggle('chat-unknown', !w.kind && chat.loaded && social.chatsLoaded);
    if (side) el.setAttribute('aria-label', w.kind === 'group' ? `Gruppo ${w.name}` : `Chat con ${w.name}`);
    const group = w.kind === 'group';
    const msgs = chat.messages;
    const places = layoutLog(msgs);
    const parts = [];
    msgs.forEach((m, i) => {
      if (places[i].day) {
        const label = chatDay(m.at);
        parts.push({ key: `d:${dayKey(m.at)}`, sig: label, build: () => h('div', { class: 'chat-day' }, label) });
      }
      parts.push({ key: `m:${m.id}`, sig: sigOf(m, places[i], group), build: () => msgEl(m, places[i], group) });
    });
    // What stays on screen stays where it is: the first message in view is the anchor (a day label
    // moves up with the older messages of its day). It is found again by its id: its bubble may be
    // drawn anew (older messages before it change where its run starts).
    const before = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    const atBottom = !drawnOnce || stickToBottom || before <= NEAR_BOTTOM_PX;
    let anchorId = null;
    let anchorTop = 0;
    if (!atBottom) {
      const top0 = scroller.getBoundingClientRect().top;
      const anchor = [...log.querySelectorAll(':scope > .msg')].find((c) => c.getBoundingClientRect().bottom > top0) || null;
      if (anchor) {
        anchorId = anchor.dataset.id;
        anchorTop = anchor.getBoundingClientRect().top;
      }
    }
    patchParts(log, parts, { carry: false });
    const anchorNow = anchorId ? log.querySelector(`:scope > .msg[data-id="${anchorId}"]`) : null;
    if (atBottom) {
      scroller.scrollTop = scroller.scrollHeight;
      pinned = true;
    } else if (anchorNow) scroller.scrollTop += anchorNow.getBoundingClientRect().top - anchorTop;
    if (chat.loaded) {
      drawnOnce = true;
      stickToBottom = false;
    }
    drawn = msgs;
    askPlaylists(msgs);
    afterScroll();
  }
  const later = whenSettled(render);
  // The messages on screen: what the read mark and the older pages go by (a change waiting for the
  // hands to rest is not on screen yet).
  let drawn = [];

  /**
   * The read mark at the bottom (the newest message on screen), the older messages at the top: one
   * page at a time, the next only once the one before is on screen.
   */
  function afterScroll() {
    if (!chat.loaded || (typeof document !== 'undefined' && document.hidden)) return;
    const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (gap <= NEAR_BOTTOM_PX) {
      let newest = null;
      for (let i = drawn.length - 1; i >= 0 && !newest; i--) if (!drawn[i].local) newest = drawn[i];
      if (newest) chat.markRead(newest.id);
    }
    if (scroller.scrollTop <= NEAR_TOP_PX && chat.more && !chat.busyOlder && drawn === chat.messages) chat.loadOlder();
  }
  // The log at its bottom stays there when it gets shorter (the keyboard, the emoji panel, a reply
  // being written, the field growing a line).
  let pinned = true;
  let lastHeight = 0;
  const resized = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => {
        const hgt = scroller.clientHeight;
        if (hgt !== lastHeight && pinned) scroller.scrollTop = scroller.scrollHeight;
        lastHeight = hgt;
      })
    : null;
  if (resized) resized.observe(scroller);
  let raf = 0;
  scroller.addEventListener(
    'scroll',
    () => {
      if (scroller.clientHeight === lastHeight) pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= NEAR_BOTTOM_PX;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        afterScroll();
      });
    },
    { passive: true }
  );

  const offs = [social.subscribe(() => later()), profile.subscribe(() => later()), store.subscribe(() => later())];
  const onVisible = () => {
    if (!document.hidden) afterScroll();
  };
  document.addEventListener('visibilitychange', onVisible);
  render();

  return {
    el,
    composer: comp,
    chat,
    mounted() {
      chat.start();
      social.refresh();
      social.refreshChats();
      // The app's notification of this conversation goes.
      if (bridgeVersion() >= 6) for (const id of what().ids) nativeCall('chatSeen', id);
    },
    destroy() {
      later.cancel();
      chat.stop();
      comp.destroy();
      cancelAnimationFrame(raf);
      if (resized) resized.disconnect();
      document.removeEventListener('visibilitychange', onVisible);
      offs.forEach((f) => f());
      social.refreshChats();
    },
  };
}
