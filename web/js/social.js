// The people of your sources, as the local core gives them, and your social settings.
//
//   GET /local/people     { supported, v, me, people }: the union of every social source,
//                         one entry per person (id, pid, name, tag, photo, seen, blocked, chat,
//                         sources, now, last), times already in this device's clock
//   GET /local/social     { supported, privacy: { invisible, showNow, privateSession,
//                         privateUntil, showRecent }, blocked, mutes }
//   PATCH /local/social   { invisible?, showNow?, privateSession?, showRecent? } -> { privacy }
//
// Nothing is asked while no source speaks the people part (sources.social(), as the core says it
// in this session). While the page is visible the people are asked every 30 s, and at once when
// it becomes visible and when Amici, a person's page or the PC column opens; while it is hidden
// there is no timer at all. An answer whose v is the one held changes nothing and tells nobody.
//
// The settings change optimistically: the switch moves at once, the core hears the latest wish of
// each one once the taps rest (a burst is one change; one request at a time, the last state last),
// and when the core refuses, the state it last confirmed comes back with "Qualcosa non ha
// funzionato".
//
// The chats (while some source holds them, social 2):
//   GET /local/chat/conversations   { supported, v, unread, conversations }: asked every 10 s while
//                                   the page is visible, at once when it becomes visible; with the
//                                   v held as If-None-Match, so an unchanged list costs no body
//   GET /local/chat/shared          { v, cards }: the music shared with you, read again only when
//                                   the list's v moved
//   PUT /local/chat/<cid>/mute      { mute: '8h' | '1w' | 'always' | 'off' } -> { mutes }
//   POST /local/social/blocked      { profileId } -> { blocked }; DELETE .../blocked/<profileId>
// Hidden: no timer at all. An answer whose v is the one held changes nothing and tells nobody.

import { localRequest, sources } from './sources.js';
import { pidOf } from './profile-id.js';
import { toast } from '../components/toast.js';
import { normConv, normShared } from './chat-data.js';
import { lsGet, lsSet } from './util.js';

const POLL_MS = 30000;
const CHATS_MS = 10000;
const SEEN_KEY = 'mpfy.shared.seen';
const SEEN_MAX = 200;
const SETTLE_MS = 300; // a burst of taps on a switch is one change, sent once the taps rest
const HEX32 = /^[0-9a-f]{32}$/;
const PHOTO = /^[0-9a-f]{64}$/;
const DEFAULT_PRIVACY = Object.freeze({ invisible: false, showNow: true, privateSession: false, privateUntil: 0, showRecent: true });
const FIELDS = ['invisible', 'showNow', 'privateSession', 'showRecent'];

let people = { supported: false, v: null, me: null, list: [] };
let byId = new Map();
let peopleLoaded = false;
let peopleInflight = null;
let timer = 0;
let started = false;

let chats = { supported: false, v: null, unread: 0, list: [] };
let chatById = new Map(); // every id of a conversation (merged groups have several) -> C
let chatWith = new Map(); // profileId -> its direct conversation
let chatsLoaded = false;
let chatsInflight = null;
let chatsTimer = 0;
let shared = { v: null, cards: [] };
let sharedFor = null; // the list's v the shared cards were read for
let sharedInflight = null;
let blockedIds = [];
let seenShared = new Set(lsGet(SEEN_KEY, []) || []);

let settingsSupported = false;
let settingsLoaded = false;
let settingsInflight = null;
let confirmed = { ...DEFAULT_PRIVACY }; // what the core last said
let wish = {}; // the person's taps the core has not confirmed yet
let sending = false;
let settle = 0;

const listeners = new Set();
function emit() {
  for (const fn of listeners) {
    try {
      fn();
    } catch (err) {
      console.error('social listener', err);
    }
  }
}

const str = (v, max = 400) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Something playing or played: { trackId, title, artist, album, at, artistPage }, or null. */
export function normTrack(t) {
  if (!t || typeof t !== 'object' || typeof t.trackId !== 'string' || !str(t.title)) return null;
  return { trackId: t.trackId, title: str(t.title), artist: str(t.artist), album: str(t.album), at: Number(t.at) || 0, artistPage: t.artistPage === true };
}

/** One person as the core lists them, or null when it is not one. */
export function normPerson(p) {
  if (!p || typeof p !== 'object' || !HEX32.test(p.id || '') || !str(p.name, 80)) return null;
  return {
    id: p.id,
    pid: pidOf(p.pid, p.id),
    name: str(p.name, 80),
    tag: typeof p.tag === 'string' && p.tag ? p.tag.slice(0, 12) : null,
    photo: typeof p.photo === 'string' && PHOTO.test(p.photo) ? p.photo : null,
    seen: p.seen === 'chat' ? 'chat' : 'all',
    blocked: p.blocked === true,
    chat: typeof p.chat === 'string' ? p.chat : null,
    sources: Array.isArray(p.sources) ? p.sources.filter((s) => typeof s === 'string') : [],
    now: normTrack(p.now),
    last: normTrack(p.last),
  };
}

function normMe(m) {
  if (!m || typeof m !== 'object' || !HEX32.test(m.id || '')) return null;
  return { id: m.id, pid: pidOf(m.pid, m.id), name: str(m.name, 80), tag: typeof m.tag === 'string' && m.tag ? m.tag.slice(0, 12) : null, photo: typeof m.photo === 'string' && PHOTO.test(m.photo) ? m.photo : null };
}

/** Where the page loads a person's photo from, or null without one. */
export const photoUrlOf = (p) => (p && p.photo ? `/local/people/${encodeURIComponent(p.id)}/photo?v=${p.photo}` : null);

function applyPeople(data) {
  const v = typeof data?.v === 'string' ? data.v : null;
  const supported = data?.supported === true;
  if (peopleLoaded && v && v === people.v && supported === people.supported) return false;
  const list = (Array.isArray(data?.people) ? data.people : []).map(normPerson).filter(Boolean);
  people = { supported, v, me: normMe(data?.me), list: supported ? list : [] };
  byId = new Map(people.list.map((p) => [p.id, p]));
  peopleLoaded = true;
  return true;
}

/** Asks the core for the people now (one request at a time). */
function refreshPeople() {
  if (!sources.loaded || !sources.social()) return Promise.resolve(false);
  if (peopleInflight) return peopleInflight;
  peopleInflight = (async () => {
    let changed = false;
    try {
      changed = applyPeople(await localRequest('GET', '/local/people', undefined, 8000));
    } catch {
      /* the core is busy or away: what we have stays, the next poll asks again */
    } finally {
      peopleInflight = null;
    }
    if (changed) emit();
    schedule();
    return changed;
  })();
  return peopleInflight;
}

function schedule() {
  clearTimeout(timer);
  timer = 0;
  if (typeof document !== 'undefined' && document.hidden) return;
  if (!sources.loaded || !sources.social()) return;
  timer = setTimeout(refreshPeople, POLL_MS);
}

// ---- settings ----

/** privacy as the core says it; privateSession follows privateUntil when the core gives one. */
function normPrivacy(p, prev = DEFAULT_PRIVACY) {
  if (!p || typeof p !== 'object') return { ...prev };
  const until = Number(p.privateUntil) || 0;
  return {
    invisible: typeof p.invisible === 'boolean' ? p.invisible : prev.invisible,
    showNow: typeof p.showNow === 'boolean' ? p.showNow : prev.showNow,
    showRecent: typeof p.showRecent === 'boolean' ? p.showRecent : prev.showRecent,
    privateUntil: until,
    privateSession: until > 0 ? until > Date.now() : p.privateSession === true,
  };
}

/** The settings as they show: what the core confirmed, under the taps it has not heard yet. */
function shown() {
  const c = { ...confirmed };
  // A private session ends by itself at privateUntil.
  if (c.privateUntil > 0) c.privateSession = c.privateUntil > Date.now();
  return { ...c, ...wish };
}

function readSettings() {
  if (!sources.loaded || !sources.social()) return Promise.resolve(false);
  if (settingsInflight) return settingsInflight;
  settingsInflight = (async () => {
    try {
      const data = await localRequest('GET', '/local/social', undefined, 8000);
      const was = JSON.stringify([settingsSupported, confirmed, settingsLoaded, blockedIds]);
      settingsSupported = data?.supported === true;
      confirmed = normPrivacy(data?.privacy, confirmed);
      if (Array.isArray(data?.blocked)) blockedIds = data.blocked.filter((x) => typeof x === 'string');
      settingsLoaded = true;
      if (JSON.stringify([settingsSupported, confirmed, settingsLoaded, blockedIds]) !== was) emit();
      return true;
    } catch {
      return false;
    } finally {
      settingsInflight = null;
    }
  })();
  return settingsInflight;
}

/** The taps the core has not heard: one PATCH at a time, the newest wish last. */
async function pump() {
  if (sending) return;
  const c = shown();
  const base = { ...confirmed, privateSession: c.privateUntil > 0 ? confirmed.privateUntil > Date.now() : confirmed.privateSession };
  const body = {};
  for (const k of FIELDS) if (k in wish && wish[k] !== base[k]) body[k] = wish[k];
  if (!Object.keys(body).length) {
    if (Object.keys(wish).length) {
      wish = {};
      emit();
    }
    return;
  }
  sending = true;
  const sent = { ...wish };
  let ok = false;
  try {
    const data = await localRequest('PATCH', '/local/social', body, 10000);
    confirmed = normPrivacy(data?.privacy, { ...confirmed, ...body });
    ok = true;
  } catch {
    wish = {};
    toast('Qualcosa non ha funzionato');
  } finally {
    sending = false;
  }
  if (ok) {
    // A wish the core now holds is no longer a wish; one tapped again since is sent next.
    for (const k of Object.keys(sent)) if (wish[k] === sent[k] && confirmed[k] === sent[k]) delete wish[k];
    if (Object.keys(wish).length) {
      emit();
      pump();
      return;
    }
    readSettings();
  }
  emit();
}

export const social = {
  /** The people part is there: some source speaks it, and the core said so. */
  get supported() {
    return sources.social() && people.supported;
  },
  /** Some source speaks the people part (the photo opens Amici, the column may open). */
  get wanted() {
    return sources.social();
  },
  get loaded() {
    return peopleLoaded;
  },
  /** You as the core shows you to the others: { id, pid, name, photo, tag }, or null. */
  get me() {
    return people.me;
  },
  /** Everyone of the union, as the core lists them (seen "all" and "chat"). */
  get people() {
    return people.list;
  },
  byId: (id) => byId.get(id) || null,
  /** { name, tag } of a person the core lists, or null. */
  nameOf(id) {
    const p = byId.get(id);
    return p ? { name: p.name, tag: p.tag } : null;
  },
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  /** Amici, a person's page or the column opened: the people now. */
  refresh: refreshPeople,

  /** Settings: the core gave them and the Social section shows. */
  get settingsSupported() {
    return sources.social() && settingsSupported;
  },
  get settingsLoaded() {
    return settingsLoaded;
  },
  /** { invisible, showNow, privateSession, privateUntil, showRecent } as the switches show them. */
  get privacy() {
    return shown();
  },
  readSettings,
  /** One switch, at once; the core hears it right after (see pump). */
  setPrivacy(field, value) {
    if (!FIELDS.includes(field)) return;
    wish = { ...wish, [field]: !!value };
    emit();
    clearTimeout(settle);
    settle = setTimeout(pump, SETTLE_MS);
  },

  /** Starts the polling (once). */
  start() {
    if (started) return;
    started = true;
    // Only on the core's own word (not the list saved by an earlier session): a source that
    // stopped speaking the people part is never asked about them again.
    let was = null;
    const follow = () => {
      const now = sources.loaded && sources.social();
      if (now === was) return;
      was = now;
      if (now) {
        refreshPeople();
        readSettings();
      } else {
        clearTimeout(timer);
        timer = 0;
        emit();
      }
    };
    sources.subscribe(follow);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        clearTimeout(timer);
        timer = 0;
        clearTimeout(chatsTimer);
        chatsTimer = 0;
      } else {
        refreshPeople();
        refreshChats();
      }
    });
    // The chats follow the sources that hold them (social 2), on the core's word as the people do.
    let chatsWas = null;
    const followChats = () => {
      const now = sources.loaded && sources.chats();
      if (now === chatsWas) return;
      chatsWas = now;
      if (now) refreshChats();
      else {
        clearTimeout(chatsTimer);
        chatsTimer = 0;
        if (chats.supported || chats.list.length) {
          applyChats({ supported: false, v: null, unread: 0, conversations: [] });
          emit();
        }
      }
    };
    sources.subscribe(followChats);
    follow();
    followChats();
  },
  /** A timer is set or a request runs (for the checks). */
  get polling() {
    return !!timer || !!peopleInflight;
  },

  // ---- chats ----

  /** Some source holds chats and the core said so. */
  get chatsSupported() {
    return sources.chats() && chats.supported;
  },
  get chatsLoaded() {
    return chatsLoaded;
  },
  /** The conversations, newest first, as the core lists them. */
  get conversations() {
    return chats.list;
  },
  /** The conversation of any of its ids, or null. */
  conversation: (id) => chatById.get(id) || null,
  /** The direct conversation with a person, or null. */
  conversationWith: (profileId) => chatWith.get(profileId) || null,
  /** The unread messages of the conversations not muted. */
  get unread() {
    return chats.unread;
  },
  /** The music shared with you (Home), newest first. */
  get shared() {
    return shared.cards;
  },
  /** That card's dot was cleared here (opened from Home). */
  sharedSeen: (messageId) => seenShared.has(messageId),
  /** Opening a card from Home clears its dot on this device, never the chat's read mark. */
  markSharedSeen(messageId) {
    if (seenShared.has(messageId)) return;
    seenShared.add(messageId);
    const keep = [...seenShared].slice(-SEEN_MAX);
    seenShared = new Set(keep);
    lsSet(SEEN_KEY, keep);
    emit();
  },
  /** The people you blocked (profileIds), as the core last said. */
  get blocked() {
    return blockedIds;
  },
  /** The conversations now, and the shared cards when the list moved. */
  refreshChats: () => refreshChats(),
  /** A timer is set or a request runs for the chats (for the checks). */
  get chatsPolling() {
    return !!chatsTimer || !!chatsInflight;
  },
  /** Silences a conversation (every id of a merged group): '8h', '1w', 'always' or 'off'. */
  mute: (cid, value) => setMute(cid, value),
  /** Blocks a person: their chat and their messages go at once. */
  block: (profileId) => setBlock(profileId, true),
  unblock: (profileId) => setBlock(profileId, false),
};

// ---- chats ----

function indexChats(list) {
  chatById = new Map();
  chatWith = new Map();
  for (const c of list) {
    for (const id of c.ids) chatById.set(id, c);
    if (c.kind === 'direct' && c.with) chatWith.set(c.with, c);
  }
}

const unreadOf = (list) => list.filter((c) => !c.muted).reduce((n, c) => n + c.unread, 0);

function applyChats(data) {
  const v = typeof data?.v === 'string' ? data.v : null;
  const supported = data?.supported === true;
  if (chatsLoaded && v && v === chats.v && supported === chats.supported) return false;
  const list = supported ? (Array.isArray(data?.conversations) ? data.conversations : []).map(normConv).filter(Boolean) : [];
  list.sort((a, b) => b.at - a.at);
  const unread = Number.isFinite(data?.unread) ? Math.max(0, Math.floor(data.unread)) : unreadOf(list);
  chats = { supported, v, unread: supported ? unread : 0, list };
  indexChats(list);
  chatsLoaded = true;
  return true;
}

/** Asks the core for the conversations now (one request at a time). */
function refreshChats() {
  if (!sources.loaded || !sources.chats()) return Promise.resolve(false);
  if (chatsInflight) return chatsInflight;
  chatsInflight = (async () => {
    let changed = false;
    try {
      const data = await localRequest('GET', '/local/chat/conversations', undefined, 8000, { held: chatsLoaded ? chats.v : null });
      if (data) changed = applyChats(data);
    } catch {
      /* the core is busy or away: what we have stays, the next poll asks again */
    } finally {
      chatsInflight = null;
    }
    if (changed) emit();
    if (chats.supported && chats.v !== sharedFor) readShared();
    scheduleChats();
    return changed;
  })();
  return chatsInflight;
}

function scheduleChats() {
  clearTimeout(chatsTimer);
  chatsTimer = 0;
  if (typeof document !== 'undefined' && document.hidden) return;
  if (!sources.loaded || !sources.chats()) return;
  chatsTimer = setTimeout(refreshChats, CHATS_MS);
}

/** The shared cards, read for the list's v now (one request at a time). */
function readShared() {
  if (sharedInflight) return sharedInflight;
  const forV = chats.v;
  sharedInflight = (async () => {
    try {
      const data = await localRequest('GET', '/local/chat/shared', undefined, 8000, { held: shared.v });
      sharedFor = forV;
      if (data) {
        const cards = (Array.isArray(data.cards) ? data.cards : []).map(normShared).filter(Boolean).slice(0, 12);
        const v = typeof data.v === 'string' ? data.v : null;
        if (v !== shared.v || JSON.stringify(cards) !== JSON.stringify(shared.cards)) {
          shared = { v, cards };
          emit();
        }
      }
    } catch {
      /* asked again when the list moves next */
    } finally {
      sharedInflight = null;
    }
  })();
  return sharedInflight;
}

/** The mutes the core holds now: the list shows them at once, the core's next list confirms. */
function applyMutes(map) {
  if (!map || typeof map !== 'object') return;
  const now = Date.now();
  const list = chats.list.map((c) => {
    const until = c.ids.map((id) => map[id]).find((x) => x !== undefined);
    const muted = until === 0 || (typeof until === 'number' && until > now);
    return muted === c.muted ? c : { ...c, muted, mutedUntil: muted ? until : null };
  });
  chats = { ...chats, list, unread: unreadOf(list) };
  indexChats(list);
  shared = { ...shared, cards: shared.cards.map((x) => (map[x.cid] === undefined ? x : { ...x, muted: map[x.cid] === 0 || map[x.cid] > now })) };
  emit();
}

async function setMute(cid, value) {
  if (!['8h', '1w', 'always', 'off'].includes(value)) return false;
  try {
    const data = await localRequest('PUT', `/local/chat/${encodeURIComponent(cid)}/mute`, { mute: value }, 10000);
    applyMutes(data?.mutes);
    chats = { ...chats, v: null }; // the next list is taken whole
    sharedFor = null;
    refreshChats();
    return true;
  } catch {
    toast('Qualcosa non ha funzionato');
    return false;
  }
}

async function setBlock(profileId, on) {
  try {
    const data = on
      ? await localRequest('POST', '/local/social/blocked', { profileId }, 10000)
      : await localRequest('DELETE', `/local/social/blocked/${encodeURIComponent(profileId)}`, undefined, 10000);
    blockedIds = Array.isArray(data?.blocked) ? data.blocked.filter((x) => typeof x === 'string') : blockedIds;
    // The person and their chat change at once here; the core's next answers confirm it.
    const p = byId.get(profileId);
    if (p) {
      const np = { ...p, blocked: on };
      byId.set(profileId, np);
      people = { ...people, v: null, list: people.list.map((x) => (x.id === profileId ? np : x)) };
    }
    if (on) {
      const list = chats.list.filter((c) => !(c.kind === 'direct' && c.with === profileId));
      chats = { ...chats, list, unread: unreadOf(list) };
      indexChats(list);
      shared = { ...shared, cards: shared.cards.filter((x) => x.from !== profileId) };
    }
    chats = { ...chats, v: null };
    sharedFor = null;
    emit();
    refreshPeople();
    refreshChats();
    return true;
  } catch {
    toast('Qualcosa non ha funzionato');
    return false;
  }
}
