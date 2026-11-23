// Short confirmations at the bottom of the screen ("Aggiunto in coda", "Playlist eliminata").
// action: { label, onClick } adds one small button ("Apri"); such a toast stays a little longer.
// Returns { gone } (true once it left the screen), or null when there is nowhere to show it.

import { h } from '../js/dom.js';

export function toast(message, { ms = 3000, action = null } = {}) {
  const root = document.getElementById('toasts');
  if (!root) return null;
  const btn = action ? h('button', { type: 'button', class: 'toast-action' }, action.label) : null;
  const el = h('div', { class: `toast${btn ? ' has-action' : ''}` }, h('span', { class: 'toast-text' }, message), btn);
  let gone = false;
  const hide = () => {
    if (gone) return;
    gone = true;
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  };
  if (btn) {
    btn.addEventListener('click', () => {
      hide();
      action.onClick?.();
    });
  }
  root.append(el);
  while (root.children.length > 2) root.firstElementChild.remove();
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(hide, btn ? Math.max(ms, 6000) : ms);
  return {
    get gone() {
      return gone || el.isConnected === false;
    },
  };
}
