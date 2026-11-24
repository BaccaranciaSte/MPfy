// "Coda": what is playing, "Prossimi in coda" (added by hand, played first) and
// "Prossimi da: <context>". Tap a row to jump to it, X to remove, drag the handle to reorder
// (inside its own section).

import { h, iconBtn, markFresh } from '../js/dom.js';
import { icon, eqEl } from '../icons/icons.js';
import { player } from '../js/player.js';
import { store } from '../js/store.js';
import { contextName } from '../js/contexts.js';
import { makeSortable } from '../js/sortable.js';
import { coverEl, specs } from './cover.js';
import { openPanel } from './sheet.js';
import { transport } from './controls.js';

const MAX_UPCOMING = 300; // enough to scroll through; the rest is still in the queue

// A row acts on its queue item, found again at the moment of the tap: the index it was drawn
// with may have moved.
const indexOf = (item) => player.state.items.indexOf(item);

function queueRow(t, absIndex, { current = false, removable = true } = {}) {
  const item = player.state.items[absIndex];
  const main = h(
    'button',
    { type: 'button', class: 'tr-main', 'aria-label': current ? `In riproduzione: ${t.title}` : `Riproduci ${t.title}` },
    coverEl(specs.track(t), { cls: 'tr-cover' }),
    h('span', { class: 'tr-text' }, h('span', { class: 'tr-title' }, current ? eqEl() : null, h('span', { class: 'tr-title-text' }, t.title)), h('span', { class: 'tr-sub' }, h('span', { class: 'tr-sub-text' }, t.artist)))
  );
  if (!current) main.addEventListener('click', () => player.skipTo(indexOf(item)));
  const row = h('div', { class: `queue-row sortable${current ? ' is-current' : ''}` }, main);
  row.qItem = item;
  if (removable) {
    row.append(
      iconBtn('close', `Rimuovi ${t.title} dalla coda`, () => player.removeAt([indexOf(item)]), { cls: 'q-remove', size: 20 }),
      // A button: drag it with a finger or the mouse, or focus it and use the arrow keys.
      h('button', { type: 'button', class: 'icon-btn drag-handle', 'aria-label': `Sposta ${t.title}, frecce su e giù`, title: 'Trascina o usa le frecce per riordinare', 'data-qi': String(absIndex) }, icon('drag', 22))
    );
  }
  return row;
}

let openNow = null; // the open queue panel's layer: the queue button toggles it (desktop)

export function openQueue() {
  if (openNow) {
    openNow.close();
    return;
  }
  const st0 = player.state;
  if (st0.index < 0) return;
  const tr = transport({ big: false });
  const { el, body, layer } = openPanel({
    title: 'Coda',
    cls: 'panel-queue',
    modal: false,
    onClose: () => {
      openNow = null;
      offChange();
      offStore();
    },
  });
  openNow = layer;
  let refocus = null; // absolute index whose handle gets the focus back after a keyboard move
  el.append(h('footer', { class: 'queue-foot' }, tr.el));
  let dragId = null; // the pointer dragging a row: the list is not drawn again under it

  function section(title, extra) {
    return h('div', { class: 'q-head' }, h('h3', { class: 'q-title' }, title), extra || null);
  }

  // A drop moves the dragged item next to the one it was dropped on, wherever the queue moved
  // them meanwhile (shuffle from another finger, a song that ended).
  const moveIn = (list) => (from, to, how) => {
    const rows = [...list.children].filter((r) => r.qItem);
    const a = rows[from] ? indexOf(rows[from].qItem) : -1;
    const b = rows[to] ? indexOf(rows[to].qItem) : -1;
    if (a < 0 || b < 0) return;
    if (how === 'key') refocus = b;
    player.move(a, b);
  };

  function render() {
    if (dragId != null) return;
    const st = player.state;
    const d = store.d;
    const cur = player.currentTrack();
    body.replaceChildren();
    if (!cur) return;
    body.append(section('In riproduzione'), h('div', { class: 'q-list' }, queueRow(cur, st.index, { current: true, removable: false })));

    const { start, end } = player.manualRange();
    if (end > start) {
      const clear = h('button', { type: 'button', class: 'link-btn' }, 'Cancella coda');
      clear.addEventListener('click', () => player.clearQueue());
      const list = h('div', { class: 'q-list' });
      for (let i = start; i < end; i++) {
        const t = d.tracks.get(st.items[i].id);
        if (t) list.append(queueRow(t, i));
      }
      makeSortable(list, { item: '.sortable', scroller: body, onMove: moveIn(list) });
      body.append(section('Prossimi in coda', clear), list);
    }

    const restEnd = Math.min(st.items.length, end + MAX_UPCOMING);
    if (restEnd > end) {
      const name = st.context ? contextName(st.context) : 'La tua coda';
      const list = h('div', { class: 'q-list' });
      for (let i = end; i < restEnd; i++) {
        const t = d.tracks.get(st.items[i].id);
        if (t) list.append(queueRow(t, i));
      }
      makeSortable(list, { item: '.sortable', scroller: body, onMove: moveIn(list) });
      body.append(section(`Prossimi da: ${name}`), list);
    } else if (end === start) {
      body.append(h('p', { class: 'empty-small' }, st.repeat === 'all' ? 'Alla fine si riparte dal primo brano.' : 'Nessun altro brano in coda.'));
    }
    tr.update();
    // The lists are rebuilt on every change: give the focus back to the handle that moved.
    if (refocus != null) {
      body.querySelector(`.drag-handle[data-qi="${refocus}"]`)?.focus({ preventScroll: false });
      refocus = null;
    }
    // New rows under the finger: the rest of the tap that moved them (a double tap) does nothing.
    markFresh(body);
  }

  // Do not rebuild the list under the finger while a row is dragged; only that finger ends it.
  body.addEventListener('pointerdown', (e) => {
    if (dragId == null && e.target.closest('.drag-handle')) dragId = e.pointerId;
  });
  const stopDrag = (e) => {
    if (e.pointerId !== dragId) return;
    dragId = null;
    requestAnimationFrame(render);
  };
  body.addEventListener('pointerup', stopDrag);
  body.addEventListener('pointercancel', stopDrag);

  const offChange = player.onChange(render);
  const offStore = store.subscribe(render);
  render();
}
