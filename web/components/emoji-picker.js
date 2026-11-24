// Our own emoji panel (no network, no system picker): "Recenti" (the last 24 used on this device),
// then the sections of js/emoji-data.js, in a grid of 40 px cells under headings in the sub colour.
// On a phone it takes the keyboard's place under the composer (260 px); on a PC it is a 320 x 360
// popover above the emoji button. A tap inserts the emoji (the composer puts it at the caret). It
// closes with the emoji button, a tap outside it, Escape or Back (it is a layer of the history).
//
// The cells are drawn in chunks as the panel scrolls (renderChunked): opening it never waits for
// all of them. One listener takes the taps of every cell.

import { h, renderChunked, staleTap } from '../js/dom.js';
import { openLayer } from '../js/router.js';
import { EMOJI_SECTIONS } from '../js/emoji-data.js';

const RECENT_KEY = 'mpfy.emoji.recent';
const RECENT_MAX = 24;
const desktop = typeof matchMedia === 'function' ? matchMedia('(min-width: 900px)') : { matches: false };

const decode = (word) => String.fromCodePoint(...word.split('.').map((x) => parseInt(x, 16)));

let sections = null;
/** The sections decoded, once: [{ name, list: [emoji] }]. */
function allSections() {
  if (!sections) sections = EMOJI_SECTIONS.map((s) => ({ name: s.name, list: s.list.split(' ').filter(Boolean).map(decode) }));
  return sections;
}

/** The recent emoji, newest first. */
export function recentEmoji() {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

/** An emoji used: first in "Recenti", at most 24 kept. */
export function useEmoji(e) {
  const list = [e, ...recentEmoji().filter((x) => x !== e)].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* kept for this session only */
  }
}

/** Every emoji of the panel's sections (for the checks). */
export const emojiSections = () => allSections();

/**
 * Opens the panel. host: where the phone's panel goes (under the composer); button: the emoji
 * button (a tap on it is left to it, which closes); keep: other controls (one or a list) a tap on
 * leaves open (send, the field on a phone: closing first would slide the composer from under the
 * finger and lose the tap); onPick(emoji). Returns { el, close() }.
 */
export function openEmojiPicker({ host, button, keep = null, onPick, onClose = () => {} }) {
  const pop = desktop.matches;
  const grid = h('div', { class: 'emoji-grid' });
  const scroll = h('div', { class: 'emoji-scroll' }, grid);
  const el = h('div', { class: `emoji-panel${pop ? ' emoji-pop' : ''}`, role: 'dialog', 'aria-label': 'Emoji' }, scroll);
  const items = [];
  const recent = recentEmoji();
  if (recent.length) {
    items.push({ head: 'Recenti' });
    for (const e of recent) items.push({ e });
  }
  for (const s of allSections()) {
    items.push({ head: s.name });
    for (const e of s.list) items.push({ e });
  }
  const cell = (it) => (it.head ? h('h3', { class: 'emoji-head' }, it.head) : h('button', { type: 'button', class: 'emoji-cell', dataset: { e: it.e } }, h('span', { class: 'emoji' }, it.e)));

  grid.addEventListener('click', (ev) => {
    const b = ev.target.closest('.emoji-cell');
    if (!b || closed || staleTap(b)) return;
    useEmoji(b.dataset.e);
    onPick(b.dataset.e);
  });
  // Taps in the panel never take the focus from the field (the phone keyboard stays as it is).
  el.addEventListener('mousedown', (ev) => ev.preventDefault());

  let closed = false;
  let stopChunks = () => {};
  const keeps = Array.isArray(keep) ? keep : keep ? [keep] : [];
  const outside = (ev) => {
    if (el.contains(ev.target) || (button && button.contains(ev.target)) || keeps.some((k) => k.contains(ev.target))) return;
    close();
  };
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('resize', place);
    stopChunks();
    el.remove();
    layer.close();
    onClose();
  }
  function place() {
    if (!pop || !button) return;
    const r = button.getBoundingClientRect();
    const w = Math.min(320, window.innerWidth - 16);
    el.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    el.style.bottom = `${Math.max(8, window.innerHeight - r.top + 8)}px`;
    el.style.width = `${w}px`;
  }
  const layer = openLayer(() => close());
  if (pop) {
    document.body.append(el);
    place();
    window.addEventListener('resize', place);
  } else host.append(el);
  stopChunks = renderChunked(grid, items, cell, { chunk: 160, root: scroll });
  document.addEventListener('pointerdown', outside, true);
  return { el, close, get closed() { return closed; } };
}
