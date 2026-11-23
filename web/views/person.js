// A person's page (/persona/<profileId>), laid out like an artist's: the photo big in the hero
// (its colour behind it, else a colour of the name), "Profilo", the name, the profile ID, and while
// they listen now what they play (a tap plays the same song from your library); then
// "Ascoltati di recente": the albums of what they played lately and, for the plays started from
// an artist's page, the artist, each only when your library has it.
//
// Where you share a source that holds chats with them, the actions row: "Altre opzioni per <nome>"
// ("Blocca <nome>" or "Sblocca <nome>") and the big button "Scrivi a <nome>" (their chat).
//
// Your own page is the same as the others see it; while you are invisible (no source answers for
// you) only the hero shows, without what you play. A person no source knows: "Profilo non trovato".
//
// GET /local/people/<id> when the page opens and when the people change; the hero shows at once
// from the list the page already has.

import { h, iconBtn, sep } from '../js/dom.js';
import { whenSettled, patchParts } from '../js/settle.js';
import { eqEl } from '../icons/icons.js';
import { goBack } from '../js/router.js';
import { localRequest } from '../js/sources.js';
import { social, normPerson, normTrack, photoUrlOf } from '../js/social.js';
import { profile } from '../js/profile.js';
import { store } from '../js/store.js';
import { clamp } from '../js/util.js';
import { cachedColor, dominantColorOfUrl, nameColor, css, darken } from '../js/color.js';
import { personAvatar } from '../components/avatar.js';
import { card, shelf } from '../components/cards.js';
import { specs } from '../components/cover.js';
import { refreshAllMarks } from '../components/track-row.js';
import { songOf, playTheirs } from '../js/theirs.js';
import { icon } from '../icons/icons.js';
import { navigate } from '../js/router.js';
import { sources } from '../js/sources.js';
import { openSheet } from '../components/sheet.js';
import { personMenuItems } from '../components/chat-menus.js';

const HEX32 = /^[0-9a-f]{32}$/;
const SHELF_MAX = 10;

/** The cards of the shelf: albums, and the artist of a play started from an artist's page. */
export function shelfCards(recent) {
  const d = store.d;
  if (!d) return [];
  const out = [];
  const seen = new Set();
  for (const r of [...recent].sort((a, b) => (b.at || 0) - (a.at || 0))) {
    const s = songOf(r);
    if (!s) continue;
    if (r.artistPage) {
      const ar = d.artists.get(d.artistOf.get(s.id));
      if (!ar || seen.has(`ar:${ar.id}`)) continue;
      seen.add(`ar:${ar.id}`);
      out.push({ href: `/artist/${ar.id}`, title: ar.name, sub: 'Artista', cover: specs.artist(ar), round: true, ctx: { type: 'artist', id: ar.id } });
    } else {
      const al = d.albums.get(d.albumOf.get(s.id));
      if (!al || seen.has(`al:${al.id}`)) continue;
      seen.add(`al:${al.id}`);
      out.push({ href: `/album/${al.id}`, title: al.name, sub: al.artist, cover: specs.album(al), ctx: { type: 'album', id: al.id } });
    }
    if (out.length >= SHELF_MAX) break;
  }
  return out;
}

export function personView(id) {
  const scroller = document.getElementById('main');
  const el = h('div', { class: 'view view-detail detail-artist detail-person' });
  const valid = HEX32.test(id || '');
  const own = () => !!profile.data && profile.data.id === id;
  // What the page shows: { person, recent, hidden } once the core answered, else the list's entry.
  let page = null;
  let missing = !valid;
  let topbar = null;
  let heroTitle = null;
  let colorSig = null;
  let colorToken = 0;
  let asked = null;

  const person = () => (page && page.person) || social.byId(id) || (own() && social.me ? { ...social.me, now: null, last: null } : null);

  async function load() {
    if (!valid || asked) return asked;
    asked = (async () => {
      try {
        const data = await localRequest('GET', `/local/people/${encodeURIComponent(id)}`, undefined, 8000);
        const p = normPerson(data && data.person);
        if (p) {
          page = { person: p, recent: (Array.isArray(data.recent) ? data.recent : []).map(normTrack).filter(Boolean), hidden: data.hidden === true || data.person.hidden === true };
          missing = false;
        }
      } catch (err) {
        if (err && err.status === 404) {
          page = null;
          missing = true;
        }
        // Anything else (the core busy): what shows stays, the next change of the people asks again.
      } finally {
        asked = null;
      }
      later();
    })();
    return asked;
  }

  // ---- colour ----
  function paint(rgb) {
    el.style.setProperty('--hero', css(rgb, 0.9));
    el.style.setProperty('--hero-mid', css(rgb, 0.45));
    el.style.setProperty('--hero-bar', css(darken(rgb, 0.55)));
  }
  function applyColor(p) {
    const token = ++colorToken;
    const url = photoUrlOf(p);
    const key = p.photo ? `p:${p.photo}` : null;
    const rgb = key ? cachedColor(key) : null;
    paint(rgb || nameColor(p.name));
    if (!rgb && url) dominantColorOfUrl(url, key).then((c) => c && token === colorToken && paint(c));
  }

  // ---- the top bar fills with the colour as the page scrolls ----
  let raf = 0;
  function onScroll() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (!topbar || !heroTitle) return;
      const y = scroller.scrollTop;
      const bottom = heroTitle.offsetTop + heroTitle.offsetHeight;
      topbar.style.setProperty('--tb', String(clamp((y - bottom * 0.35) / (bottom * 0.6), 0, 1)));
      topbar.classList.toggle('show-title', y > bottom - 40);
    });
  }
  scroller.addEventListener('scroll', onScroll, { passive: true });

  function topBar(name) {
    const back = iconBtn('chevronLeft', 'Indietro', () => goBack(), { cls: 'back-btn', size: 26 });
    topbar = h('div', { class: 'topbar' }, back, h('div', { class: 'topbar-title' }, name || ''));
    return topbar;
  }

  function hero(p, now) {
    heroTitle = h('h1', { class: 'hero-title' }, p.name);
    const text = h('div', { class: 'hero-text' }, h('div', { class: 'hero-kind' }, 'Profilo'), heroTitle, h('div', { class: 'hero-id', 'aria-label': 'ID del profilo' }, p.pid));
    if (now) {
      const line = h(
        'button',
        { type: 'button', class: 'meta-now-line', 'aria-label': `Riproduci ${now.title}${now.artist ? ` di ${now.artist}` : ''}` },
        h('span', { class: 'meta-now' }, eqEl(), h('span', { class: 'meta-now-title' }, now.title)),
        now.artist ? sep() : null,
        now.artist ? h('span', { class: 'meta-now-artist' }, now.artist) : null
      );
      line.addEventListener('click', () => playTheirs(now));
      text.append(h('div', { class: 'hero-meta' }, line));
    }
    return h('div', { class: 'hero' }, personAvatar({ name: p.name, photoUrl: photoUrlOf(p), size: 56, cls: 'person-hero-avatar' }), text);
  }

  /** The actions row's content, or null where it does not show (your own page, no chats shared). */
  function actionsOf(p) {
    if (own() || !social.chatsSupported) return null;
    const listedP = social.byId(p.id);
    const chat = (listedP && listedP.chat) || p.chat;
    const shared = new Set(sources.chatSources());
    const where = (listedP && listedP.sources.length ? listedP.sources : p.sources) || [];
    if (!chat || !where.some((s) => shared.has(s))) return null;
    return { id: p.id, name: p.name, chat, blocked: !!(listedP ? listedP.blocked : p.blocked) };
  }

  function actionsRow(a) {
    const more = iconBtn('moreV', `Altre opzioni per ${a.name}`, () => openSheet({ label: `Altre opzioni per ${a.name}`, items: personMenuItems({ id: a.id, name: a.name, blocked: a.blocked }) }));
    const write = h('button', { type: 'button', class: 'play-ctx play-big write-btn', 'aria-label': `Scrivi a ${a.name}`, title: `Scrivi a ${a.name}` }, icon('chatBold', 28));
    write.addEventListener('click', () => navigate(`/chat/${encodeURIComponent(a.chat)}`));
    return h('div', { class: 'actions person-actions' }, h('div', { class: 'actions-left' }, more), h('div', { class: 'actions-right' }, write));
  }

  function parts() {
    if (missing) {
      heroTitle = null;
      return [
        { key: 'bg', sig: '', build: () => h('div', { class: 'hero-bg', 'aria-hidden': 'true' }) },
        { key: 'top', sig: '', build: () => topBar('') },
        { key: 'missing', sig: '', build: () => h('div', { class: 'empty person-missing' }, h('h2', {}, 'Profilo non trovato')) },
      ];
    }
    const p = person();
    if (!p) return [{ key: 'top', sig: '', build: () => topBar('') }];
    const hidden = !!page && page.hidden;
    const now = hidden ? null : p.now;
    const cards = page && !hidden ? shelfCards(page.recent) : [];
    const out = [
      { key: 'bg', sig: '', build: () => h('div', { class: 'hero-bg', 'aria-hidden': 'true' }) },
      { key: 'top', sig: p.name, build: () => topBar(p.name) },
      { key: 'hero', sig: JSON.stringify([p.name, p.pid, p.photo, now ? [now.title, now.artist] : null]), build: () => hero(p, now) },
    ];
    const act = actionsOf(p);
    if (act) out.push({ key: 'actions', sig: JSON.stringify(act), build: () => actionsRow(act) });
    if (cards.length) out.push({ key: 'shelf:Ascoltati di recente', sig: JSON.stringify(cards), build: () => shelf('Ascoltati di recente', cards.map((c) => card(c))) });
    return out;
  }

  function render() {
    const changed = patchParts(el, parts());
    const p = missing ? null : person();
    const cs = p ? JSON.stringify([p.photo, p.name]) : null;
    if (cs !== colorSig) {
      colorSig = cs;
      if (p) applyColor(p);
    }
    if (changed) refreshAllMarks(el);
    onScroll();
  }
  const later = whenSettled(render);

  // The people changed (the 30 s poll, an answer at the open): the page is asked again.
  const offs = [
    social.subscribe(() => {
      later();
      load();
    }),
    profile.subscribe(() => later()),
  ];
  render();
  load();
  return {
    el,
    tab: 'home',
    update: later,
    mounted() {
      social.refresh();
    },
    destroy() {
      later.cancel();
      scroller.removeEventListener('scroll', onScroll);
      offs.forEach((f) => f());
    },
  };
}
