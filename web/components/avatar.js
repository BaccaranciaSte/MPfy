// The person using the app as a round picture: their photo, else the first letter of their name on
// a disc in the app's colours, else the profile icon. A photo that does not load shows the letter.
// Someone else (personAvatar): their photo, else the first letter of their name on grey.
//
// avatarSig() changes exactly when what the picture shows changes (the photo or the letter): a view
// drawn in parts puts it in the sig of the part that holds the picture.

import { h } from '../js/dom.js';
import { icon } from '../icons/icons.js';
import { profile } from '../js/profile.js';

const segmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function' ? new Intl.Segmenter() : null;
// Without Intl.Segmenter (Chrome 81): a letter with its accents, or a flag, or a figure joined to
// the next one.
const FIRST = /^(?:[\u{1F1E6}-\u{1F1FF}]{2}|\P{M}\p{M}*[\u{1F3FB}-\u{1F3FF}]?(?:\u200D\P{M}\p{M}*[\u{1F3FB}-\u{1F3FF}]?)*)/u;

/** The first character of a name as a person reads it, in capitals ('' for no name). */
export function initialOf(name) {
  const s = String(name || '').trim();
  if (!s) return '';
  let first = '';
  if (segmenter) {
    for (const part of segmenter.segment(s)) {
      first = part.segment;
      break;
    }
  } else {
    const m = FIRST.exec(s);
    first = m ? m[0] : Array.from(s)[0];
  }
  return first.toLocaleUpperCase('it');
}

/** What the picture shows: its photo and its letter. */
export const avatarSig = () => `${profile.photoUrl() || ''}|${initialOf(profile.name)}`;

/**
 * The picture, size px wide. cls is added to its class. Hidden from screen readers: the control
 * that holds it says what it does.
 */
export function avatar(size, { cls = '' } = {}) {
  const el = h('span', { class: `avatar${cls ? ' ' + cls : ''}`, 'aria-hidden': 'true', style: { width: `${size}px`, height: `${size}px` } });
  const letter = initialOf(profile.name);
  const fallback = () => {
    if (letter) {
      el.classList.add('avatar-letter');
      el.style.fontSize = `${Math.round(size * 0.46)}px`;
      el.replaceChildren(h('span', { class: 'avatar-initial' }, letter));
    } else {
      el.classList.add('avatar-icon');
      el.replaceChildren(icon('profile', Math.round(size * 0.62)));
    }
  };
  const url = profile.photoUrl();
  if (url) {
    const img = h('img', { class: 'avatar-photo', src: url, alt: '', decoding: 'async', draggable: 'false' });
    img.addEventListener('error', () => {
      if (img.parentNode !== el) return;
      el.classList.remove('has-photo');
      fallback();
    });
    el.classList.add('has-photo');
    el.append(img);
  } else fallback();
  return el;
}

/**
 * Someone's picture, size px (18, 22, 28, 32, 36, 40, 48 or 56): span.avatar.avatar-<size> with
 * their photo, else .avatar-initial with the first letter of their name on grey. Hidden from
 * screen readers like yours.
 */
export function personAvatar({ name, photoUrl = null, size = 40, cls = '' } = {}) {
  const el = h('span', { class: `avatar avatar-${size}${cls ? ' ' + cls : ''}`, 'aria-hidden': 'true' });
  const letter = () => {
    el.classList.remove('has-photo');
    el.classList.add('avatar-initial');
    el.replaceChildren(initialOf(name));
  };
  if (photoUrl) {
    const img = h('img', { class: 'avatar-photo', src: photoUrl, alt: '', decoding: 'async', draggable: 'false' });
    img.addEventListener('error', () => {
      if (img.parentNode === el) letter();
    });
    el.classList.add('has-photo');
    el.append(img);
  } else letter();
  return el;
}
