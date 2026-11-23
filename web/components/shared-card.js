// A card of Home's "Condivisi con te": the music someone shared with you in a chat, as a Home card
// with who sent it (their photo on the cover, a tap on it opens their page and nothing else), the
// dot of something not opened yet (never for a silenced chat), the sub and the note in quotes.
// A tap does what the card does in the chat (music-card.js) and clears that card's dot on this
// device only: the chat's read mark stays where it was.

import { h } from '../js/dom.js';
import { social, photoUrlOf } from '../js/social.js';
import { cardCover, openCard } from '../js/music-card.js';
import { profile } from '../js/profile.js';
import { coverEl } from './cover.js';
import { personAvatar } from './avatar.js';
import { whoOf } from './chat-panel.js';
import { readSharedPlaylist, playlistCopyNow } from '../js/chat.js';

const atOf = (x) => ({ cid: x.cid, messageId: x.messageId, from: x.from, mine: !!profile.data && x.from === profile.data.id });

/** The dot shows: not opened yet, not silenced, not cleared here. */
export const sharedUnseen = (x) => x.unseen && !x.muted && !social.sharedSeen(x.messageId);

/** What the card shows (a card part is drawn again only when this changes). */
export const sharedSig = (x) => {
  const w = whoOf(x.from);
  return [x.messageId, x.card, x.note, sharedUnseen(x), w.name, w.person ? [w.person.photo, w.person.seen] : null, cardCover(x.card, atOf(x))];
};

export function sharedCard(x) {
  const w = whoOf(x.from);
  const at = atOf(x);
  const round = false;
  const p = w.person;
  const av = personAvatar({ name: w.name, photoUrl: p ? photoUrlOf(p) : null, size: 22, cls: 'card-from' });
  const from = p && p.seen === 'all' ? h('a', { class: 'card-from-link', href: `/persona/${encodeURIComponent(p.id)}`, 'data-link': '', 'aria-label': `Profilo di ${p.name}` }, av) : av;
  if (from !== av) from.addEventListener('click', (e) => e.stopPropagation());
  const sub = x.card.kind === 'playlist' ? 'Playlist' : x.card.sub;
  const link = h('button', { type: 'button', class: 'card-link', 'aria-label': `${x.card.title}, da ${w.name}` });
  link.addEventListener('click', () => {
    social.markSharedSeen(x.messageId);
    openCard(x.card, at);
  });
  return h(
    'div',
    { class: `card card-shared${round ? ' round' : ''}`, dataset: { message: x.messageId } },
    h('div', { class: 'card-cover' }, coverEl(cardCover(x.card, at)), from),
    h('div', { class: 'card-title' }, sharedUnseen(x) ? h('span', { class: 'unseen-dot', role: 'img', 'aria-label': 'nuovo' }) : null, x.card.title),
    sub ? h('div', { class: 'card-sub' }, sub) : null,
    x.note ? h('div', { class: 'card-note' }, `\u00ab${x.note}\u00bb`) : null,
    link
  );
}

const warmed = new Set();
/**
 * The covers of the playlist cards need their tracks: the playlist read from its source once per
 * session (the core answers with its last copy when no source does). onReady() when one came.
 */
export function warmSharedCovers(items, onReady) {
  for (const x of items) {
    if (x.card.kind !== 'playlist') continue;
    if (warmed.has(x.messageId) || playlistCopyNow(x.cid, x.messageId)) continue;
    warmed.add(x.messageId);
    readSharedPlaylist(x.cid, x.messageId).then((r) => r && r.playlist && onReady());
  }
}
