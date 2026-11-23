// A track row: small cover, title (bright, bold and with an equalizer when it is the current
// track), artist with the downloaded mark, and a "..." button for the track menu. Two sibling
// buttons (play, menu) so there is no interactive element nested inside another. A track that no
// connected source has, and that is not downloaded, shows dimmed. A row of a long list (inList)
// leaves its long press to the list's one listener (press.js onLongPressIn, menuOfRow here).

import { h, iconBtn, repeatTap } from '../js/dom.js';
import { icon, eqEl } from '../icons/icons.js';
import { coverEl, setCover, specs } from './cover.js';
import { player } from '../js/player.js';
import { downloads } from '../js/downloads.js';
import { reachable } from '../js/media.js';
import { store } from '../js/store.js';
import { ctxKey } from '../js/util.js';
import { onLongPress, onLongPressIn } from '../js/press.js';

const menus = new WeakMap(); // row of a long list -> its onMenu

// A row is a copy of a blank row of its kind, made once (its icons and placeholder cover parsed
// once), filled with the song: a long list draws rows as it scrolls, each one must be quick.
const blanks = new Map(); // `${cover}${numbered}${menu}` -> a blank row

function blankRow(cover, numbered, menu) {
  const key = `${cover ? 1 : 0}${numbered ? 1 : 0}${menu ? 1 : 0}`;
  let row = blanks.get(key);
  if (!row) {
    row = h(
      'div',
      { class: 'track-row' },
      h(
        'button',
        { type: 'button', class: 'tr-main' },
        numbered ? h('span', { class: 'tr-num' }) : null,
        cover ? coverEl({ kind: 'ph', icon: 'note' }, { cls: 'tr-cover' }) : null,
        h(
          'span',
          { class: 'tr-text' },
          h('span', { class: 'tr-title' }, eqEl(), h('span', { class: 'tr-title-text' })),
          h('span', { class: 'tr-sub' }, h('span', { class: 'dl-mark' }, icon('downloaded', 14)), h('span', { class: 'tr-sub-text' }))
        )
      ),
      menu ? iconBtn('moreV', '', null, { cls: 'tr-more' }) : null
    );
    blanks.set(key, row);
  }
  return row.cloneNode(true);
}

/** Appends kids (text, nodes, arrays of them; null and false left out) to el. */
function fill(el, kids) {
  if (kids == null || kids === false || kids === true) return;
  if (Array.isArray(kids)) for (const k of kids) fill(el, k);
  else el.append(kids instanceof Node ? kids : String(kids));
}

/**
 * opts: { ctx, ci, cover = true, num, sub, onPlay, onMenu, inList }
 *   ctx/ci identify the row inside its play context, for highlighting the exact duplicate.
 *   inList: the row is drawn in a long list whose own listener takes its long press.
 */
export function trackRow(t, { ctx = null, ci = null, cover = true, num = null, sub = null, onPlay, onMenu, inList = false } = {}) {
  const row = blankRow(cover, num != null, !!onMenu);
  row.dataset.tid = t.id;
  row.dataset.ctx = ctxKey(ctx);
  row.dataset.ci = ci ?? '';
  const main = row.firstChild;
  main.setAttribute('aria-label', `Riproduci ${t.title} di ${t.artist}`);
  let k = main.firstChild;
  if (num != null) {
    k.textContent = String(num);
    k = k.nextSibling;
  }
  if (cover) {
    setCover(k, specs.track(t));
    k = k.nextSibling;
  }
  k.firstChild.lastChild.textContent = t.title;
  fill(k.lastChild.lastChild, sub ?? t.artist);
  // The second tap of a double tap does not load the song again from the start.
  if (onPlay) {
    main.addEventListener('click', (e) => {
      if (!repeatTap(`row|${ctxKey(ctx)}|${ci ?? ''}|${t.id}`)) onPlay(e);
    });
  }
  if (onMenu) {
    const more = row.lastChild;
    more.setAttribute('aria-label', `Altre opzioni per ${t.title}`);
    more.setAttribute('title', `Altre opzioni per ${t.title}`);
    more.addEventListener('click', onMenu);
    // A long press on touch and a right click on desktop open the same menu: through the list's
    // own listener for a row of a long list, else on the row itself.
    if (inList) menus.set(row, onMenu);
    else onLongPress(row, () => onMenu());
  }
  markRow(row);
  return row;
}

/** The menu of a row of a long list (its long press, on the list's listener). */
export function menuOfRow(row) {
  const fn = menus.get(row);
  if (fn) fn();
}

/** One listener for the long presses of every song row in `list`, drawn now or later. */
export function trackRowPresses(list) {
  onLongPressIn(list, '.track-row', (row) => menuOfRow(row));
}

let markCtx = { id: null, gid: null, key: '', ci: null };

function updateMarkCtx() {
  const it = player.currentItem();
  const st = player.state;
  // The queue may hold an older id of the same song (its versions were grouped again).
  markCtx = { id: it?.id || null, gid: it ? store.gid(it.id) : null, key: ctxKey(st.context), ci: it?.ci ?? null };
}

/** Current-track highlight and downloaded mark for one row. */
export function markRow(row) {
  const { tid, ctx, ci } = row.dataset;
  let current = tid === markCtx.id || (!!markCtx.gid && store.gid(tid) === markCtx.gid);
  // Inside the playing context, a playlist with duplicates highlights only the exact row.
  if (current && ctx && ctx === markCtx.key && ci !== '' && markCtx.ci != null) current = String(markCtx.ci) === ci;
  row.classList.toggle('is-current', current);
  const dl = downloads.has(tid);
  row.classList.toggle('is-downloaded', dl);
  row.classList.toggle('is-unavailable', !dl && !reachable(tid));
}

/** The marks of an element standing for a play context (data-play-ctx): playing it now, or not. */
export function markPlayCtx(el) {
  const st = player.state;
  const on = st.index >= 0 && el.dataset.playCtx === ctxKey(st.context);
  el.classList.toggle('ctx-on', on);
  el.classList.toggle('ctx-playing', on && st.playing);
  if (el.matches('.play-ctx')) {
    const label = el.dataset.label || 'Riproduci';
    el.setAttribute('aria-label', on && st.playing ? label.replace(/^Riproduci/, 'Metti in pausa') : label);
  }
}

/** The marks of every row drawn under root (a long list draws only some of its rows: those). */
export function refreshAllMarks(root = document) {
  updateMarkCtx();
  for (const row of root.querySelectorAll('.track-row')) markRow(row);
  for (const el of root.querySelectorAll('[data-play-ctx]')) markPlayCtx(el);
  document.body.classList.toggle('is-playing', player.state.playing);
}

updateMarkCtx();
