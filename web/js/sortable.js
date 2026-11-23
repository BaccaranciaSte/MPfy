// Drag to reorder with a handle, for touch and mouse (pointer events, no HTML5 drag and drop).
// The dragged row follows the finger, the others slide out of the way, and the list scrolls when
// the finger gets near the top or bottom edge of the scroll container.
// Keyboard: the handle is a button; with it focused, ArrowUp and ArrowDown move the row by one.
//
// onMove(from, to, how): how is 'key' for a keyboard move. A list rebuilt in place gets the focus
// back on the moved handle here; a caller that replaces the list element restores it itself.
//
// A windowed list (vlist.js, size given: the number of rows in the whole list) draws only some of
// its rows: each carries data-i, its index, and a move is by index. The dragged row stays drawn
// (the list keeps the row last pressed), the rows drawn as the edge scroll moves the window slide
// out of the way like the others.

export function makeSortable(list, { item = '.sortable', handle = '.drag-handle', scroller, onMove, size = null }) {
  const rowsOf = () => [...list.children].filter((el) => el.matches(item));
  const indexOf = (row) => (size ? Number(row.dataset.i) : rowsOf().indexOf(row));
  const rowAt = (i) => (size ? rowsOf().find((r) => r.dataset.i === String(i)) : rowsOf()[i]);
  const count = () => (size ? size() : rowsOf().length);

  list.addEventListener('keydown', (e) => {
    if ((e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const hEl = e.target.closest?.(handle);
    if (!hEl || !list.contains(hEl)) return;
    const row = hEl.closest(item);
    if (!row || row.parentElement !== list) return;
    e.preventDefault(); // the arrows move the row, not the page
    const from = indexOf(row);
    const to = from + (e.key === 'ArrowUp' ? -1 : 1);
    if (from < 0 || to < 0 || to >= count()) return;
    onMove(from, to, 'key');
    if (list.isConnected) rowAt(to)?.querySelector(handle)?.focus();
  });

  list.addEventListener('pointerdown', (e) => {
    const hEl = e.target.closest(handle);
    if (!hEl || !list.contains(hEl) || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const row = hEl.closest(item);
    if (!row || row.parentElement !== list) return;
    e.preventDefault();
    if (size) dragByIndex(e, hEl, row);
    else dragDrawn(e, hEl, row);
  });

  /** Every row of the list is drawn: the rows' own boxes say where the finger is. */
  function dragDrawn(e, hEl, row) {
    const rows = [...list.children].filter((el) => el.matches(item));
    const from = rows.indexOf(row);
    if (from < 0) return;
    const scrollEl = scroller || document.scrollingElement;
    const startScroll = scrollEl.scrollTop;
    const rects = rows.map((r) => r.getBoundingClientRect());
    const step = rows.length > 1 ? Math.abs(rects[1].top - rects[0].top) : rects[from].height;
    const startY = e.clientY;
    let lastY = startY;
    let to = from;

    const layout = () => {
      const scrollDelta = scrollEl.scrollTop - startScroll;
      const dy = lastY - startY + scrollDelta;
      row.style.transform = `translateY(${dy}px)`;
      const center = rects[from].top + rects[from].height / 2 + dy;
      let t = from;
      for (let i = 0; i < from; i++) {
        if (center < rects[i].top + rects[i].height / 2) {
          t = i;
          break;
        }
      }
      if (t === from) {
        for (let i = rows.length - 1; i > from; i--) {
          if (center > rects[i].top + rects[i].height / 2) {
            t = i;
            break;
          }
        }
      }
      to = t;
      rows.forEach((r, i) => {
        if (i === from) return;
        let shift = 0;
        if (from < to && i > from && i <= to) shift = -step;
        else if (from > to && i >= to && i < from) shift = step;
        r.style.transform = shift ? `translateY(${shift}px)` : '';
      });
    };
    follow(e, hEl, row, scrollEl, (y) => (lastY = y), layout, () => {
      for (const r of rows) r.style.transform = '';
      return to;
    }, from);
  }

  /** A windowed list: the index under the finger from the row height, the rows drawn shifted by theirs. */
  function dragByIndex(e, hEl, row) {
    const from = indexOf(row);
    if (!(from >= 0)) return;
    const scrollEl = scroller || document.scrollingElement;
    const startScroll = scrollEl.scrollTop;
    const step = row.getBoundingClientRect().height || 1;
    const startY = e.clientY;
    let lastY = startY;
    let to = from;

    const layout = () => {
      const dy = lastY - startY + (scrollEl.scrollTop - startScroll);
      row.style.transform = `translateY(${dy}px)`;
      to = Math.max(0, Math.min(count() - 1, from + Math.round(dy / step)));
      for (const r of rowsOf()) {
        if (r === row) continue;
        const i = Number(r.dataset.i);
        let shift = 0;
        if (from < to && i > from && i <= to) shift = -step;
        else if (from > to && i >= to && i < from) shift = step;
        const t = shift ? `translateY(${shift}px)` : '';
        if (r.style.transform !== t) r.style.transform = t;
      }
    };
    follow(e, hEl, row, scrollEl, (y) => (lastY = y), layout, () => {
      for (const r of rowsOf()) r.style.transform = '';
      row.style.transform = '';
      return to;
    }, from);
  }

  /** The drag itself: the finger followed, the edges scrolled, the move made on the lift. */
  function follow(e, hEl, row, scrollEl, setY, layout, finish, from) {
    let raf = 0;
    let lastY = e.clientY;
    hEl.setPointerCapture(e.pointerId);
    list.classList.add('sorting');
    row.classList.add('dragging');

    // Auto scroll near the edges of the scroll container.
    const tick = () => {
      raf = 0;
      const box = scrollEl === document.scrollingElement ? { top: 0, bottom: innerHeight } : scrollEl.getBoundingClientRect();
      const edge = 64;
      let v = 0;
      if (lastY < box.top + edge) v = -Math.ceil((box.top + edge - lastY) / 6);
      else if (lastY > box.bottom - edge) v = Math.ceil((lastY - (box.bottom - edge)) / 6);
      if (v) {
        scrollEl.scrollTop += v;
        layout();
        raf = requestAnimationFrame(tick);
      }
    };

    const move = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      lastY = ev.clientY;
      setY(lastY);
      layout();
      if (!raf) raf = requestAnimationFrame(tick);
    };

    const end = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      hEl.removeEventListener('pointermove', move);
      hEl.removeEventListener('pointerup', end);
      hEl.removeEventListener('pointercancel', end);
      cancelAnimationFrame(raf);
      list.classList.remove('sorting');
      row.classList.remove('dragging');
      const to = finish();
      if (to !== from && ev.type === 'pointerup') onMove(from, to);
    };

    hEl.addEventListener('pointermove', move);
    hEl.addEventListener('pointerup', end);
    hEl.addEventListener('pointercancel', end);
  }
}
