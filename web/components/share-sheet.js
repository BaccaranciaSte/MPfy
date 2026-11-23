// "Condividi con...": a track, an album or a playlist sent as a music card to people and to the
// groups of your sources. The sheet: the item (cover, title, sub), a field "Cerca", the groups
// (one: its row; two or more: the "Fonti" row, closed, which opens the groups in place), then the
// people with whom you share a source that holds chats, in the order of Amici (never the blocked
// ones, nor someone the sources show only in a chat); a note (at most 300 characters) and "Invia",
// which waits for a first pick. Several picks send one card each, every one with its own id; the
// sheet closes and says "Inviato" (a copy waiting for its source counts as sent).

import { h, sep, repeatTap, markFresh } from '../js/dom.js';
import { icon } from '../icons/icons.js';
import { openSheet } from './sheet.js';
import { coverEl } from './cover.js';
import { toast } from './toast.js';
import { personAvatar } from './avatar.js';
import { srcMark, srcStack } from './chat-panel.js';
import { chatModel, matches, groupMatches } from './people.js';
import { social, photoUrlOf } from '../js/social.js';
import { sources } from '../js/sources.js';
import { sendCard } from '../js/chat.js';
import { cutPoints, NOTE_MAX } from '../js/chat-data.js';
import { charCount, debounce } from '../js/util.js';

/** The people the sheet offers: listed by every source, not blocked, on a source that holds chats with you. */
export function shareTargets() {
  const chatSources = new Set(sources.chatSources());
  const { groups, rows } = chatModel();
  const people = rows.map((r) => r.p).filter((p) => p.seen === 'all' && !p.blocked && p.chat && p.sources.some((s) => chatSources.has(s)));
  return { groups, people };
}

/**
 * Opens the sheet for item: { card, cover (a cover spec), title, sub }. Resolves nothing; the
 * sends go on after it closed.
 */
export function openShareSheet(item) {
  const picked = new Map(); // 'g:<cid>' | 'p:<profileId>' -> the conversation id to write to
  let q = '';
  let fontiOpen = false;
  let sending = false;

  const input = h('input', { class: 'text-input share-search-input', type: 'text', placeholder: 'Cerca', 'aria-label': 'Cerca', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'search' });
  const search = h('label', { class: 'add-search' }, icon('search', 20), input);
  const people = h('div', { class: 'pick-list share-people' });
  const list = h('div', { class: 'share-list' }, people);
  const note = h('textarea', { class: 'text-input', rows: '2', placeholder: 'Aggiungi una nota', 'aria-label': 'Nota', maxlength: String(NOTE_MAX * 2) });
  const send = h('button', { type: 'button', class: 'btn btn-primary btn-wide', disabled: true }, 'Invia');
  const foot = h('div', { class: 'share-foot' }, h('div', { class: 'share-note' }, note), h('div', { class: 'share-send' }, send));
  const header = h(
    'div',
    { class: 'share-head' },
    h('div', { class: 'sheet-title' }, 'Condividi con...'),
    h('div', { class: 'sheet-item-head' }, coverEl(item.cover, { cls: 'sheet-cover' }), h('div', { class: 'sheet-item-text' }, h('div', { class: 'sheet-item-title' }, item.title), item.sub ? h('div', { class: 'sheet-item-sub' }, item.sub) : null))
  );

  note.addEventListener('input', () => {
    if (charCount(note.value) <= NOTE_MAX) return;
    note.value = cutPoints(note.value, NOTE_MAX);
    note.setSelectionRange(note.value.length, note.value.length);
  });

  const mark = (on) => h('span', { class: `pick-check${on ? ' on' : ''}` }, icon(on ? 'checkCircle' : 'plusCircle', 24));

  function pickRow(key, cid, av, nameKids, sub, label) {
    const on = picked.has(key);
    const b = h(
      'button',
      { type: 'button', class: 'pick-row', 'aria-pressed': String(on), 'aria-label': label, dataset: { key } },
      av,
      h('span', { class: 'pick-text' }, h('span', { class: 'pick-name' }, nameKids), sub ? h('span', { class: 'pick-sub' }, sub) : null),
      mark(on)
    );
    b.addEventListener('click', () => {
      // A double tap is one pick, not a pick taken back.
      if (repeatTap(`share|${key}`)) return;
      if (picked.has(key)) picked.delete(key);
      else picked.set(key, cid);
      // The row changes in place: no list is drawn again under the finger.
      const now = picked.has(key);
      b.setAttribute('aria-pressed', String(now));
      b.lastElementChild.replaceWith(mark(now));
      send.disabled = !picked.size;
    });
    return b;
  }

  const groupPick = (c) => pickRow(`g:${c.id}`, c.id, srcMark(48), [h('b', {}, c.name || c.display)], 'Gruppo', c.name || c.display);
  const personPick = (p) => pickRow(`p:${p.id}`, p.chat, personAvatar({ name: p.name, photoUrl: photoUrlOf(p), size: 48 }), [h('b', {}, p.name), p.tag ? h('span', { class: 'id-tag' }, sep(), p.tag) : null], null, p.name);

  function fontiRow(groups) {
    const b = h(
      'button',
      { type: 'button', class: 'pick-row fonti-pick', 'aria-expanded': String(fontiOpen), 'aria-label': fontiOpen ? 'Chiudi le fonti' : 'Apri le fonti' },
      srcStack(),
      h('span', { class: 'pick-text' }, h('span', { class: 'pick-name' }, h('b', {}, 'Fonti'), h('span', { class: 'fonti-n' }, String(groups.length))), h('span', { class: 'pick-sub' }, groups.map((c) => c.name || c.display).join(', '))),
      h('span', { class: `pick-check fonti-chev${fontiOpen ? ' open' : ''}` }, icon('chevronDown', 24))
    );
    b.addEventListener('click', () => {
      fontiOpen = !fontiOpen;
      draw();
      markFresh(people);
    });
    return b;
  }

  function draw() {
    const t = shareTargets();
    const rows = [];
    if (q.trim()) {
      for (const c of t.groups.filter((c) => groupMatches(c, q))) rows.push(groupPick(c));
      for (const p of t.people.filter((p) => matches(p, q))) rows.push(personPick(p));
    } else {
      if (t.groups.length === 1) rows.push(groupPick(t.groups[0]));
      else if (t.groups.length > 1) {
        rows.push(fontiRow(t.groups));
        if (fontiOpen) for (const c of t.groups) rows.push(groupPick(c));
      }
      for (const p of t.people) rows.push(personPick(p));
    }
    people.replaceChildren(...rows);
  }
  input.addEventListener(
    'input',
    debounce(() => {
      q = input.value;
      draw();
    }, 120)
  );
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
  });

  let layer = null;
  send.addEventListener('click', async () => {
    if (sending || !picked.size || (layer && layer.closed)) return;
    sending = true;
    const targets = [...new Set(picked.values())];
    const text = note.value;
    await layer.close();
    const sent = await Promise.all(targets.map((cid) => sendCard(cid, item.card, text)));
    toast(sent.some(Boolean) ? 'Inviato' : 'Messaggio non inviato');
    social.refreshChats();
  });

  draw();
  layer = openSheet({ header, content: h('div', { class: 'share-body' }, search, list, foot), label: 'Condividi con', cls: 'share-sheet' });
  return layer;
}
