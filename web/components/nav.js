// Bottom navigation (mobile) and the desktop sidebar: Home, Cerca, La tua libreria; the sidebar
// also has Impostazioni (on a phone the gear is in the Home top bar).

import { h, iconBtn } from '../js/dom.js';
import { icon, logoEl } from '../icons/icons.js';
import { store } from '../js/store.js';
import { BRAND } from '../js/util.js';
import { libraryPanel } from './library-list.js';
import { openCreateMenu } from './menus.js';

const TABS = [
  { key: 'home', href: '/', label: 'Home', icon: 'home', iconOn: 'homeFill' },
  { key: 'search', href: '/search', label: 'Cerca', icon: 'search', iconOn: 'searchBold' },
  { key: 'library', href: '/library', label: 'La tua libreria', icon: 'library', iconOn: 'libraryBold' },
];

const SETTINGS = { key: 'settings', href: '/impostazioni', label: 'Impostazioni', icon: 'settings', iconOn: 'settings' };

const navLinks = [];

export function setActiveTab(key) {
  for (const a of navLinks) {
    const on = a.dataset.tab === key;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

function tabLink(t, cls) {
  const a = h('a', { class: cls, href: t.href, 'data-link': '', dataset: { tab: t.key } }, icon(t.icon, 24, 'i-off'), icon(t.iconOn, 24, 'i-on'), h('span', { class: `${cls}-label` }, t.label));
  navLinks.push(a);
  return a;
}

export function mountNav(root) {
  root.setAttribute('aria-label', 'Navigazione principale');
  root.replaceChildren(...TABS.map((t) => tabLink(t, 'nav-item')));
}

/** Desktop sidebar, mounted only when the desktop layout is active (saves work on phones). */
export function mountSidebar(root) {
  const nav = h(
    'nav',
    { class: 'side-nav', 'aria-label': 'Navigazione' },
    h('a', { class: 'side-logo', href: '/', 'data-link': '', 'aria-label': `${BRAND}, Home` }, logoEl(32), h('span', {}, BRAND)),
    ...TABS.slice(0, 2).map((t) => tabLink(t, 'side-link')),
    tabLink(SETTINGS, 'side-link')
  );
  const scroll = h('div', { class: 'side-scroll' });
  const panel = libraryPanel({ compact: true, scroller: scroll });
  scroll.append(panel.el);
  const libTitle = h('a', { class: 'side-lib-title', href: '/library', 'data-link': '', dataset: { tab: 'library' } }, icon('library', 24), h('span', {}, 'La tua libreria'));
  navLinks.push(libTitle);
  const head = h('div', { class: 'side-lib-head' }, libTitle, iconBtn('plus', 'Crea playlist o carica brani', () => openCreateMenu(), { size: 20 }));
  root.replaceChildren(nav, h('section', { class: 'side-lib' }, head, scroll));
  store.subscribe(panel.update);
}
