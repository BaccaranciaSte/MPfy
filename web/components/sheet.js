// Bottom sheets (menus) and dialogs (prompt, confirm, form). Each one is a history layer, so the
// Android back button closes it. On desktop the sheet becomes a centered panel.

import { h, markFresh } from '../js/dom.js';
import { icon } from '../icons/icons.js';
import { openLayer } from '../js/router.js';

const root = () => document.getElementById('layers');
const desktop = matchMedia('(min-width: 900px)');

// ---- focus containment ----
// aria-modal alone does not keep Tab inside a dialog. While a modal layer is open, everything
// behind it (the app, Now Playing, lower layers) is inert: no focus, no clicks, hidden from screen
// readers. The toasts stay outside this, so their announcements are still read.
const modals = []; // open modal elements, bottom to top

function refreshInert() {
  const top = modals[modals.length - 1] || null;
  const set = (el, v) => {
    if (el && el.inert !== v) el.inert = v;
  };
  set(document.getElementById('app'), !!top);
  const np = document.querySelector('.np');
  if (np) set(np, !!top && top !== np);
  for (const w of root()?.children || []) {
    set(w, !!top && !w.contains(top) && !!(w.compareDocumentPosition(top) & Node.DOCUMENT_POSITION_FOLLOWING));
  }
}

/** Marks el as the top modal until the returned function is called. */
export function holdModal(el) {
  modals.push(el);
  refreshInert();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const i = modals.lastIndexOf(el);
    if (i >= 0) modals.splice(i, 1);
    refreshInert();
  };
}

// The drag under way on a target, shared by all its handles (Now Playing: header and cover).
const drags = new WeakMap();

function dragOf(target) {
  const known = drags.get(target);
  if (known) return known;
  const drag = { id: null, startX: 0, startY: 0, dx: 0, dy: 0, t0: 0 };
  drag.reset = () => {
    drag.id = null;
    target.style.transition = '';
    target.style.transform = '';
  };
  // A second finger anywhere on the target (a pinch, also one finger on each of two handles) ends
  // the drag without dismissing.
  target.addEventListener(
    'pointerdown',
    (e) => {
      if (drag.id != null && e.pointerId !== drag.id) drag.reset();
    },
    true
  );
  drags.set(target, drag);
  return drag;
}

/**
 * Drag down to dismiss (touch only), for a sheet grip or the Now Playing header.
 * target follows the finger; past the threshold onDismiss runs. Only a movement mostly downwards
 * counts, only the first finger drags, and a second finger (a pinch) ends the drag without
 * dismissing. when(): a drag starts only while it says yes (Now Playing: scrolled to the top).
 */
export function attachDragDismiss(handle, target, onDismiss, { when = null } = {}) {
  const drag = dragOf(target);
  handle.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || !e.isPrimary || drag.id != null || e.target.closest('button, a, input, textarea')) return;
    if (when && !when()) return;
    drag.id = e.pointerId;
    drag.startX = e.clientX;
    drag.startY = e.clientY;
    drag.dx = 0;
    drag.dy = 0;
    drag.t0 = performance.now();
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already gone */
    }
    target.style.transition = 'none';
  });
  handle.addEventListener('pointermove', (e) => {
    if (e.pointerId !== drag.id) return;
    drag.dx = e.clientX - drag.startX;
    drag.dy = Math.max(0, e.clientY - drag.startY);
    target.style.transform = `translateY(${drag.dy}px)`;
  });
  const end = (e) => {
    if (e.pointerId !== drag.id) return;
    drag.reset();
    const { dx, dy } = drag;
    const v = dy / Math.max(1, performance.now() - drag.t0);
    if (dy > Math.abs(dx) && (dy > 110 || (dy > 30 && v > 0.6))) onDismiss();
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

/**
 * modal: false is for the side panels (queue, upload) that on desktop sit beside the page without
 * a backdrop; on a phone they are full screen and modal anyway. required: a step that must be
 * answered (no cancel button): neither the backdrop nor Escape closes it.
 *
 * The rest of the gesture that opened a layer does nothing in it (markFresh, dom.js): the second
 * tap of a double tap neither presses what slid under the finger nor closes it from the backdrop.
 * Closing it marks the page it uncovers the same way.
 */
function mountLayer(cls, panel, { onClose, dismissible = true, modal = true, required = false } = {}) {
  const isModal = modal || !desktop.matches;
  const backdrop = h('div', { class: 'backdrop' });
  const wrap = h('div', { class: `layer ${cls}${modal ? '' : ' layer-side'}` }, backdrop, panel);
  if (!isModal) panel.setAttribute('aria-modal', 'false');
  root().append(wrap);
  markFresh(wrap);
  const prevFocus = document.activeElement;
  const release = isModal ? holdModal(wrap) : null;
  const layer = openLayer(() => {
    // While it slides away the layer still catches taps, so the second tap of a double tap does
    // not fall through to the page below; it does nothing, because a second close returns the
    // pending one (router.js) and menu items and dialog buttons check layer.closed.
    markFresh();
    wrap.classList.remove('open');
    wrap.classList.add('closing');
    wrap.setAttribute('aria-hidden', 'true');
    setTimeout(() => wrap.remove(), 280);
    release?.();
    onClose?.();
    if (prevFocus && document.contains(prevFocus)) prevFocus.focus?.({ preventScroll: true });
  }, { escape: !required });
  if (dismissible && !required) backdrop.addEventListener('click', () => layer.close());
  requestAnimationFrame(() => {
    wrap.classList.add('open');
    const first = panel.querySelector('[autofocus]') || panel;
    first.focus({ preventScroll: true });
  });
  return layer;
}

/**
 * A bottom sheet. items: [{ icon, label, sub, onSelect, active, danger, info }]. Selecting an item
 * closes the sheet first and then runs onSelect, so the action can open another sheet or
 * navigate. An item with info: true is text, not a button: its label, then its lines, one each
 * ("Disponibile su:" then "Mi A2: FLAC").
 */
export function openSheet({ header, items, content, label = 'Menu', cls = '', onClose } = {}) {
  const grip = h('div', { class: 'sheet-grip', 'aria-hidden': 'true' });
  const panel = h('div', { class: `sheet ${cls}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': label, tabindex: '-1' }, grip);
  const head = header ? h('div', { class: 'sheet-head' }, header) : null;
  if (head) panel.append(head);
  let layer = null;
  if (items) {
    const list = h('div', { class: 'menu', role: 'menu' });
    for (const it of items) {
      const text = it.sub ? h('span', { class: 'menu-text' }, h('span', { class: 'menu-label' }, it.label), h('span', { class: 'menu-sub' }, it.sub)) : h('span', { class: 'menu-label' }, it.label);
      if (it.info) {
        const lines = (it.lines || []).map((l) => h('span', { class: 'menu-info-line' }, l));
        list.append(h('div', { class: `menu-info${lines.length ? ' has-lines' : ''}`, role: 'none' }, icon(it.icon, 24), lines.length ? h('span', { class: 'menu-text' }, h('span', { class: 'menu-label' }, it.label), lines) : text));
        continue;
      }
      const b = h(
        'button',
        { type: 'button', class: `menu-item${it.active ? ' active' : ''}${it.danger ? ' danger' : ''}`, role: 'menuitem' },
        icon(it.icon, 24),
        text
      );
      b.addEventListener('click', async () => {
        if (layer.closed) return; // a double tap: the first one already chose
        await layer.close();
        it.onSelect?.();
      });
      list.append(b);
    }
    panel.append(list);
  }
  if (content) panel.append(content);
  layer = mountLayer('layer-sheet', panel, { onClose });
  attachDragDismiss(grip, panel, () => layer.close());
  if (head) attachDragDismiss(head, panel, () => layer.close());
  return layer;
}

/** A centered dialog. Resolves with the value of the chosen action, or null when dismissed. */
export function openDialog({ title, body, actions, initialFocus }) {
  return new Promise((resolve) => {
    let result = null;
    const form = h('form', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabindex: '-1', novalidate: true });
    form.append(h('h2', { class: 'dialog-title' }, title));
    if (body) form.append(body);
    const row = h('div', { class: 'dialog-actions' });
    let layer = null;
    for (const a of actions) {
      const b = h('button', { type: a.submit ? 'submit' : 'button', class: `btn ${a.cls || 'btn-ghost'}` }, a.label);
      if (!a.submit) {
        b.addEventListener('click', () => {
          if (layer.closed) return;
          result = a.value ?? null;
          layer.close();
        });
      }
      row.append(b);
    }
    form.append(row);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (layer.closed) return;
      const a = actions.find((x) => x.submit);
      result = typeof a?.value === 'function' ? a.value() : a?.value ?? true;
      if (result === undefined) return; // invalid input: keep the dialog open
      layer.close();
    });
    layer = mountLayer('layer-dialog', form, { onClose: () => resolve(result) });
    if (initialFocus) {
      requestAnimationFrame(() => {
        initialFocus.focus();
        initialFocus.select?.();
      });
    }
  });
}

/** Asks for a line (or a paragraph) of text. Resolves with the text, or null on cancel. */
export function promptDialog({ title, value = '', placeholder = '', okLabel = 'Salva', multiline = false, maxLength = 200 }) {
  const input = multiline
    ? h('textarea', { class: 'text-input', rows: '4', placeholder, maxlength: String(maxLength), 'aria-label': title })
    : h('input', { class: 'text-input text-input-big', type: 'text', placeholder, maxlength: String(maxLength), 'aria-label': title, enterkeyhint: 'done', autocomplete: 'off' });
  input.value = value;
  return openDialog({
    title,
    body: input,
    initialFocus: input,
    actions: [
      { label: 'Annulla', value: null },
      { label: okLabel, cls: 'btn-primary', submit: true, value: () => input.value },
    ],
  });
}

export function confirmDialog({ title, message, okLabel = 'Conferma', danger = false }) {
  return openDialog({
    title,
    body: message ? h('p', { class: 'dialog-text' }, message) : null,
    actions: [
      { label: 'Annulla', value: false },
      { label: okLabel, cls: danger ? 'btn-danger' : 'btn-primary', submit: true, value: true },
    ],
  }).then((v) => v === true);
}

/**
 * A dialog that shows the progress of a long job and cannot be dismissed by a tap outside it.
 * Returns { set(done, total, label), finish(message), fail(message), close() }.
 */
export function progressDialog({ title }) {
  const label = h('p', { class: 'dialog-text progress-label', 'aria-live': 'polite' }, 'Preparazione...');
  const fill = h('i');
  const bar = h('div', { class: 'progress-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, fill);
  const okBtn = h('button', { type: 'button', class: 'btn btn-primary', hidden: true }, 'OK');
  const actions = h('div', { class: 'dialog-actions is-empty' }, okBtn);
  const form = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabindex: '-1' }, h('h2', { class: 'dialog-title' }, title), label, bar, actions);
  const showOk = () => {
    okBtn.hidden = false;
    actions.classList.remove('is-empty');
    okBtn.focus();
  };
  const layer = mountLayer('layer-dialog', form, { dismissible: false });
  okBtn.addEventListener('click', () => layer.close());
  const setPct = (pct) => {
    fill.style.transform = `scaleX(${pct / 100})`;
    bar.setAttribute('aria-valuenow', String(Math.round(pct)));
  };
  return {
    set(done, total, text) {
      setPct(total ? (done / total) * 100 : 0);
      label.textContent = total ? `${text} (${done} di ${total})` : text;
    },
    finish(message) {
      setPct(100);
      label.textContent = message;
      showOk();
      setTimeout(() => layer.close(), 1500);
    },
    fail(message) {
      bar.classList.add('failed');
      label.textContent = message;
      showOk();
    },
    close: () => layer.close(),
  };
}

/**
 * A dialog whose main button runs an async action. While it runs the button says busyLabel and
 * nothing can be pressed; the action resolves an error line (the dialog stays, the line shows
 * under the fields) or nothing (the dialog closes). body: the fields. Resolves true when the
 * action succeeded, false when dismissed. Without a cancel button (cancelLabel null) it is a step
 * to answer: a tap beside it or Escape leaves it open.
 */
export function actionDialog({ title, body, text = null, okLabel = 'Salva', busyLabel = null, cancelLabel = 'Annulla', onSubmit, initialFocus = null }) {
  return new Promise((resolve) => {
    let ok = false;
    let busy = false;
    const error = h('p', { class: 'dialog-error', role: 'alert' });
    const form = h('form', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabindex: '-1', novalidate: true });
    form.append(h('h2', { class: 'dialog-title' }, title));
    if (text) form.append(h('p', { class: 'dialog-text' }, text));
    if (body) form.append(body);
    form.append(error);
    const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, okLabel);
    const cancel = cancelLabel ? h('button', { type: 'button', class: 'btn btn-ghost' }, cancelLabel) : null;
    form.append(h('div', { class: 'dialog-actions' }, cancel, submit));
    let layer = null;
    cancel?.addEventListener('click', () => {
      if (!busy && !layer.closed) layer.close();
    });
    form.addEventListener('input', () => {
      if (!busy) error.textContent = '';
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy || layer.closed) return;
      busy = true;
      submit.disabled = true;
      if (cancel) cancel.disabled = true;
      if (busyLabel) submit.textContent = busyLabel;
      error.textContent = '';
      let msg = null;
      try {
        msg = await onSubmit();
      } catch {
        msg = 'Qualcosa non ha funzionato';
      }
      busy = false;
      submit.disabled = false;
      if (cancel) cancel.disabled = false;
      submit.textContent = okLabel;
      if (msg) {
        error.textContent = msg;
        return;
      }
      ok = true;
      layer.close();
    });
    layer = mountLayer('layer-dialog', form, { onClose: () => resolve(ok), required: !cancel });
    const first = initialFocus || form.querySelector('input, textarea');
    if (first) {
      requestAnimationFrame(() => {
        first.focus();
        first.select?.();
      });
    }
  });
}

/** fields: [{ name, label, value }]. Resolves with { name: value } or null. */
export function formDialog({ title, fields, okLabel = 'Salva' }) {
  const inputs = {};
  const body = h('div', { class: 'dialog-fields' });
  for (const f of fields) {
    const id = `fld-${f.name}-${Math.random().toString(36).slice(2, 7)}`;
    const input = h('input', { id, class: 'text-input', type: 'text', maxlength: '300', autocomplete: 'off' });
    input.value = f.value || '';
    inputs[f.name] = input;
    body.append(h('label', { class: 'field', for: id }, h('span', { class: 'field-label' }, f.label), input));
  }
  return openDialog({
    title,
    body,
    initialFocus: inputs[fields[0].name],
    actions: [
      { label: 'Annulla', value: null },
      {
        label: okLabel,
        cls: 'btn-primary',
        submit: true,
        value: () => Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value])),
      },
    ],
  });
}

/**
 * A full screen layer (queue, upload) with its own header. Returns { el, body, layer }.
 * modal: false makes it a side panel on desktop (see mountLayer). closeIcon: the close button's
 * icon (a chevron down, or a cross for a screen that is left without keeping anything).
 */
export function openPanel({ title, label = null, cls = '', onClose, headerExtra, modal = true, closeIcon = 'chevronDown' }) {
  const body = h('div', { class: 'panel-body' });
  const closeBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Chiudi' }, icon(closeIcon, closeIcon === 'chevronDown' ? 28 : 24));
  const head = h('header', { class: 'panel-head' }, closeBtn, h('h2', { class: 'panel-title' }, title || ''), headerExtra || h('span', { class: 'icon-spacer' }));
  const el = h('div', { class: `panel ${cls}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': label || title, tabindex: '-1' }, head, body);
  const layer = mountLayer('layer-panel', el, { onClose, dismissible: false, modal });
  closeBtn.addEventListener('click', () => layer.close());
  attachDragDismiss(head, el, () => layer.close());
  return { el, body, layer };
}
