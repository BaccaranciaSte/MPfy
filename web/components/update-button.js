// The update button of Home (the Android app): the download glyph's arrow inside a ring that says
// where the update stands. Full ring: ready (or installing); a faint ring with an accent arc that
// grows: downloading. No text, no badge: the label says it to screen readers.

import { h } from '../js/dom.js';
import { updates, RING, ringOffset } from '../js/updates.js';

const LABEL = { available: 'Aggiorna MPfy', downloading: 'Aggiornamento in corso', installing: 'Aggiornamento in corso' };
const LINE = 'fill="none" stroke="currentColor" stroke-width="1.8"';
const SVG =
  '<svg class="ic ic-update" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
  `<circle class="upd-ring" ${LINE} cx="12" cy="12" r="9.2"/>` +
  `<circle class="upd-arc" ${LINE} cx="12" cy="12" r="9.2" stroke-dasharray="${RING}" stroke-dashoffset="${RING}" transform="rotate(-90 12 12)"/>` +
  `<path ${LINE} stroke-linecap="round" stroke-linejoin="round" d="M12 7.2v8.6M8.4 12.6 12 16.2l3.6-3.6"/>` +
  '</svg>';

export function updateButton() {
  const el = h('button', { type: 'button', class: 'icon-btn top-action update-btn', html: SVG });
  const arc = el.querySelector('.upd-arc');
  el.addEventListener('click', () => updates.start());
  const paint = () => {
    const { state, progress } = updates.state;
    el.dataset.state = state;
    const label = LABEL[state] || '';
    el.setAttribute('aria-label', label);
    el.setAttribute('title', label);
    arc.setAttribute('stroke-dashoffset', String(state === 'downloading' ? ringOffset(progress) : RING));
  };
  paint();
  return { el, paint };
}
