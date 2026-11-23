// The change from one page to the next, in #main. Going deeper ('forward') the new page slides in
// from the right by a few pixels while it fades in, over the old one fading out; going back
// ('back') is the same played backwards: the page left slides away to the right and fades over the
// one it uncovers. A tab or the sidebar ('fade') crossfades, quicker. Only opacity and transform
// move, so an old phone keeps them on the compositor; with reduced motion every change is a plain
// fade.
//
// The page left stays in #main while it fades, frozen as it was on screen: out of the flow, over
// the visible part of #main, scrolled inside itself to where #main was (its rows of cards keep
// their sideways offsets), hidden from screen readers, the focus taken out of it. A tap on it does
// nothing (it takes the tap itself, none of its controls: styles.css .view-leaving). A new change,
// or a page drawn again in place, ends the one under way at once (endSwap): the old page goes, the
// new one stays opaque and in place. Nothing waits on the animation's end event alone: a timer ends
// it too (a hidden page gets no frames).

import { prefersReducedMotion } from './dom.js';

const SHIFT = 28; // px
const EASE = 'cubic-bezier(.2, .8, .2, 1)';
const KINDS = {
  forward: { ms: 210, newOnTop: true, enter: [{ opacity: 0, transform: `translateX(${SHIFT}px)` }, { opacity: 1, transform: 'translateX(0)' }], leave: [{ opacity: 1 }, { opacity: 0 }] },
  back: { ms: 210, newOnTop: false, enter: [{ opacity: 0 }, { opacity: 1 }], leave: [{ opacity: 1, transform: 'translateX(0)' }, { opacity: 0, transform: `translateX(${SHIFT}px)` }] },
  fade: { ms: 150, newOnTop: true, enter: [{ opacity: 0 }, { opacity: 1 }], leave: [{ opacity: 1 }, { opacity: 0 }] },
};

let current = null; // the change under way: { old, nu, anims, timer, styles }

/** Ends the change under way at once: the old page goes, the new one is opaque and in place. */
export function endSwap() {
  const c = current;
  if (!c) return;
  current = null;
  clearTimeout(c.timer);
  for (const a of c.anims) {
    a.onfinish = null;
    try {
      a.cancel();
    } catch {
      /* already gone */
    }
  }
  c.old.remove();
  for (const k in c.styles) c.nu.style[k] = c.styles[k];
}

/**
 * Puts page `nu` in #main (`main`) in place of `old`, scrolled to scrollTop. kind: 'forward',
 * 'back', 'fade', or null for a change at once (the first page, a page drawn again, a hidden page).
 */
export function swapViews(main, old, nu, { kind = null, scrollTop = 0 } = {}) {
  endSwap();
  const how = kind ? (prefersReducedMotion() ? KINDS.fade : KINDS[kind]) : null;
  const height = main.clientHeight;
  // Anything but the old page alone in #main changes at once.
  if (!how || !old || old === nu || main.children.length !== 1 || main.firstElementChild !== old || typeof nu.animate !== 'function' || document.hidden || !height) {
    main.replaceChildren(nu);
    main.scrollTop = scrollTop;
    return;
  }
  const y = main.scrollTop;
  const pad = getComputedStyle(main).paddingBottom;
  if (old.contains(document.activeElement)) document.activeElement.blur();
  old.classList.add('view-leaving');
  old.setAttribute('aria-hidden', 'true');
  Object.assign(old.style, {
    position: 'absolute',
    top: '0px',
    left: '0px',
    width: '100%',
    height: `${height}px`,
    paddingBottom: pad,
    overflow: 'hidden',
    zIndex: how.newOnTop ? '1' : '2',
    willChange: 'opacity, transform',
  });
  main.append(nu);
  old.scrollTop = y;
  main.scrollTop = scrollTop;
  old.style.top = `${main.scrollTop}px`;

  const styles = { position: nu.style.position, zIndex: nu.style.zIndex, willChange: nu.style.willChange };
  if (getComputedStyle(nu).position === 'static') nu.style.position = 'relative';
  nu.style.zIndex = how.newOnTop ? '2' : '1';
  nu.style.willChange = 'opacity, transform';

  const c = { old, nu, anims: [], timer: 0, styles };
  current = c;
  const done = () => {
    if (current === c) endSwap();
  };
  try {
    const opts = { duration: how.ms, easing: EASE, fill: 'both' };
    c.anims.push(old.animate(how.leave, opts), nu.animate(how.enter, opts));
    c.anims[1].onfinish = done;
  } catch {
    endSwap();
    return;
  }
  c.timer = setTimeout(done, how.ms + 250);
}
