// La tua libreria: header with your picture (the logo on a core without profiles) and "+" (Crea
// playlist, Carica brani), filter chips, sort, the list.

import { h, iconBtn } from '../js/dom.js';
import { logoEl } from '../icons/icons.js';
import { profile } from '../js/profile.js';
import { avatar, avatarSig } from '../components/avatar.js';
import { libraryPanel } from '../components/library-list.js';
import { openCreateMenu } from '../components/menus.js';

/** Your picture at the start of the header: photo, else your letter; the logo without a profile. */
function headAvatar() {
  if (!profile.data) return h('span', { class: 'lib-avatar', 'aria-hidden': 'true' }, logoEl(20));
  return h('span', { class: 'lib-avatar has-photo', 'aria-hidden': 'true' }, avatar(32));
}

export function libraryView() {
  const panel = libraryPanel({ compact: false });
  let pic = headAvatar();
  let picSig = `${!!profile.data}|${avatarSig()}`;
  const head = h('header', { class: 'lib-head' }, pic, h('h1', {}, 'La tua libreria'), iconBtn('plus', 'Crea playlist o carica brani', () => openCreateMenu(), { cls: 'top-action' }));
  const off = profile.subscribe(() => {
    const sig = `${!!profile.data}|${avatarSig()}`;
    if (sig === picSig) return;
    picSig = sig;
    const next = headAvatar();
    pic.replaceWith(next);
    pic = next;
  });
  const el = h('div', { class: 'view view-library' }, head, panel.el);
  return {
    el,
    tab: 'library',
    update: panel.update,
    mounted: () => panel.mounted(),
    destroy: () => {
      off();
      panel.destroy?.();
    },
  };
}
