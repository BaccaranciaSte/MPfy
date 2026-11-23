// The music sources, as the client core reports them on GET /local/sources:
// { id, name, principal, connected, rttMs, throughputKbps, lastError, addedAt, role, named,
// profiles, social }. The UI never hardcodes a source: everything else goes to /s/<id>/api/... of
// one of these. `role` is "owner", "member", or null for a source without profiles (it shows everything);
// `named` says whether its owner already gave it a name. The name is the source's own.
// `profiles`: true when the source has profiles, false when it has none, null until the core knows.
// `social`: what the source speaks of the people part (1 people, 2 chats, 3 songs; 0 none), null
// until the core knows. Nothing social is asked while no source says 1 or more.
//
// The list is polled every 4 s while the page is visible (and at once when it comes back), every
// 15 s while it is hidden but music plays (the screen is off in the car: the queue handed to the
// app must still avoid a source that went down), kept in localStorage so the next start knows it
// before the core answers, and a request that just failed on a source marks it down for a short
// while (until the core's own link state catches up), so a track does not try a dead source again
// a second later.
//
// "Locale", the phone's own music, is not in the list: the core names it apart (`phone`, on a host
// that has music of its own) and serves it at /s/0000/... as a source. It is never principal, never
// social, never offered for uploads; it counts wherever music is read (music(), get, name, isUp,
// best). Its address also serves the person's data while no real source holds it (`home`), so it
// is up whenever the core answers, whatever the permission says.

import { lsGet, lsSet } from './util.js';

const LS_KEY = 'mpfy.sources.v1';
const PHONE_KEY = 'mpfy.sources.phone.v1';
export const PHONE_ID = '0000';
const PHONE_STATES = ['off', 'scanning', 'ready'];
const POLL_MS = 4000;
const HIDDEN_POLL_MS = 15000;
const DOWN_MS = 10000;

const valid = (s) => s && typeof s.id === 'string' && /^[0-9a-f]{4,64}$/i.test(s.id);

function clean(s) {
  return {
    id: s.id,
    name: typeof s.name === 'string' && s.name.trim() ? s.name.trim() : s.id,
    principal: !!s.principal,
    connected: !!s.connected,
    rttMs: Number.isFinite(s.rttMs) ? s.rttMs : null,
    throughputKbps: Number.isFinite(s.throughputKbps) && s.throughputKbps > 0 ? s.throughputKbps : null,
    lastError: typeof s.lastError === 'string' ? s.lastError : null,
    addedAt: Number(s.addedAt) || 0,
    role: s.role === 'owner' || s.role === 'member' ? s.role : null,
    named: typeof s.named === 'boolean' ? s.named : null,
    profiles: typeof s.profiles === 'boolean' ? s.profiles : null,
    social: Number.isInteger(s.social) && s.social >= 0 ? s.social : null,
  };
}

/** The phone entry as the page reads it: a source of rtt 0 that is never principal nor social. */
function cleanPhone(p) {
  if (!p || typeof p !== 'object' || p.id !== PHONE_ID) return null;
  return {
    id: PHONE_ID,
    name: 'Locale',
    principal: false,
    connected: true,
    rttMs: 0,
    throughputKbps: null,
    lastError: null,
    addedAt: 0,
    role: null,
    named: true,
    profiles: false,
    social: 0,
    local: true,
    state: PHONE_STATES.includes(p.state) ? p.state : 'off',
    tracks: Number.isInteger(p.tracks) && p.tracks >= 0 ? p.tracks : 0,
    v: typeof p.v === 'string' ? p.v : '',
    home: p.home === true,
    details: p.details !== false,
    shadowed: p.shadowed !== false,
  };
}

const cached = lsGet(LS_KEY, null);
let list = Array.isArray(cached) ? cached.filter(valid).map((s) => ({ ...clean(s), connected: false })) : [];
let phone = cleanPhone(lsGet(PHONE_KEY, null));
let phoneJson = JSON.stringify(phone);
const hadCache = Array.isArray(cached);
let loaded = false; // the core answered at least once
let coreOk = true; // the last request to /local/sources got an answer
const downUntil = new Map();
const health = new Map(); // id -> { at, data } from /s/<id>/api/health
// A source just renamed by its owner: the new name shows at once and stays until the core, which
// learns it at its next sync of that source, says it too (or a minute passed).
const renamed = new Map(); // id -> { name, until }
const RENAMED_MS = 60000;
const listeners = new Set();
let timer = 0;
let inflight = null;
let background = false; // keep polling while the page is hidden (music is playing)
let lastJson = JSON.stringify(list);

function emit() {
  for (const fn of listeners) {
    try {
      fn();
    } catch (err) {
      console.error('sources listener', err);
    }
  }
}

/**
 * Request to the local core: a body is sent as JSON, a Blob as its own bytes and type (the profile
 * photo). Throws { message, status, code, data } like ApiError: the newer /local endpoints answer
 * { error, code } and the UI words come from the code. held: the version (v) of a list the page
 * already has, sent as If-None-Match; a 304 then resolves null and no body is read or parsed (a
 * core that does not compare versions answers the whole list, read as usual).
 */
export async function localRequest(method, path, body, timeout = 8000, { held = null } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  const raw = typeof Blob !== 'undefined' && body instanceof Blob;
  const headers = raw ? { 'Content-Type': body.type || 'application/octet-stream' } : body ? { 'Content-Type': 'application/json' } : {};
  if (held) headers['If-None-Match'] = `"${held}"`;
  let res;
  try {
    res = await fetch(path, {
      method,
      cache: 'no-store',
      signal: ctrl.signal,
      headers,
      body: raw ? body : body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    const e = new Error('Fonte non raggiungibile');
    e.status = 0;
    throw e;
  } finally {
    clearTimeout(t);
  }
  // The version held is still the core's: nothing to read.
  if (held && res.status === 304) return null;
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* no JSON body */
  }
  if (!res.ok) {
    const e = new Error('Qualcosa non ha funzionato');
    e.status = res.status;
    e.raw = typeof data?.error === 'string' ? data.error : '';
    e.code = typeof data?.code === 'string' ? data.code : null;
    e.data = data && typeof data === 'object' ? data : null;
    throw e;
  }
  return data;
}
const local = localRequest;

function apply(raw) {
  const next = (Array.isArray(raw) ? raw : []).filter(valid).map(clean);
  for (const s of next) {
    const r = renamed.get(s.id);
    if (!r) continue;
    if (s.name === r.name || Date.now() > r.until) renamed.delete(s.id);
    else Object.assign(s, { name: r.name, named: true });
  }
  // Exactly one principal when any exists (the core guarantees it; this guards the UI anyway).
  if (next.length && !next.some((s) => s.principal)) next[0].principal = true;
  // The core saw a link come back: a failure noted while it was down is history.
  for (const s of next) if (s.connected && list.some((x) => x.id === s.id && !x.connected)) downUntil.delete(s.id);
  const json = JSON.stringify(next);
  const changed = json !== lastJson;
  lastJson = json;
  list = next;
  for (const id of [...health.keys()]) if (!list.some((s) => s.id === id)) health.delete(id);
  if (changed) persist();
  return changed;
}

const persist = () => lsSet(LS_KEY, list.map(({ id, name, principal, addedAt, role, named, profiles, social }) => ({ id, name, principal, addedAt, role, named, profiles, social })));

async function refresh() {
  if (inflight) return inflight;
  inflight = (async () => {
    let changed = false;
    try {
      const data = await local('GET', '/local/sources', undefined, 6000);
      changed = apply(data?.sources);
      const p = cleanPhone(data?.phone);
      const pj = JSON.stringify(p);
      if (pj !== phoneJson) {
        phone = p;
        phoneJson = pj;
        lsSet(PHONE_KEY, p);
        changed = true;
      }
      // A "down" mark that ran out changes what isUp() says, with nothing else changing: tell the
      // listeners (the player decides the next tracks again, covers and libraries come back).
      for (const [id, until] of downUntil) {
        if (until <= Date.now()) {
          downUntil.delete(id);
          changed = true;
        }
      }
      if (!coreOk || !loaded) changed = true;
      coreOk = true;
      loaded = true;
    } catch {
      if (coreOk) changed = true;
      coreOk = false;
      // The core itself is gone (client-node stopped): nothing is connected.
      if (list.some((s) => s.connected)) {
        list = list.map((s) => ({ ...s, connected: false, rttMs: null }));
        lastJson = JSON.stringify(list);
        changed = true;
      }
    } finally {
      inflight = null;
    }
    if (changed) emit();
    schedule();
  })();
  return inflight;
}

function schedule() {
  clearTimeout(timer);
  timer = 0;
  if (typeof document !== 'undefined' && document.hidden) {
    if (background) timer = setTimeout(refresh, HIDDEN_POLL_MS);
    return;
  }
  timer = setTimeout(refresh, coreOk ? POLL_MS : POLL_MS * 2);
}

const byRtt = (a, b) => (a.rttMs ?? 1e9) - (b.rttMs ?? 1e9) || (b.principal ? 1 : 0) - (a.principal ? 1 : 0) || a.addedAt - b.addedAt;

export const sources = {
  get list() {
    return list;
  },
  /** The core answered at least once in this session. */
  get loaded() {
    return loaded;
  },
  /** A list was saved by an earlier session (so the first render can trust it). */
  get hadCache() {
    return hadCache;
  },
  get coreOk() {
    return coreOk;
  },
  /** "Locale": the phone entry ({ state, tracks, v, home, details, shadowed }), or null on a host without music of its own. */
  get phone() {
    return phone;
  },
  isLocal: (id) => id === PHONE_ID,
  /** Every source of music: the real ones in display order, then the phone's whenever the host has it. */
  music: () => (phone ? [...sources.ordered(), phone] : sources.ordered()),
  get: (id) => (id === PHONE_ID ? phone : list.find((s) => s.id === id) || null),
  principal: () => list.find((s) => s.principal) || list[0] || null,
  name: (id) => (id === PHONE_ID && phone ? phone.name : list.find((s) => s.id === id)?.name || 'La fonte'),
  /** owner | member | null (a source without profiles, or not known yet). */
  role: (id) => list.find((s) => s.id === id)?.role || null,
  /** Some source speaks the people part (social 1 or more). */
  social: () => list.some((s) => s.social >= 1),
  /** Some source holds chats (social 2 or more). */
  chats: () => list.some((s) => s.social >= 2),
  /** The ids of the sources that hold chats. */
  chatSources: () => list.filter((s) => s.social >= 2).map((s) => s.id),
  /**
   * Connected now: the core's link says so and no request failed on it a moment ago. Before the
   * core's first answer a source of the saved list counts as up: the library refresh starts at
   * once (the core itself waits for a link that is still coming up) and rows do not flash dimmed.
   */
  isUp(id) {
    const s = sources.get(id);
    if (!s || !coreOk || (loaded && !s.connected)) return false;
    const until = downUntil.get(id);
    return !until || until < Date.now();
  },
  anyUp: () => list.some((s) => sources.isUp(s.id)),
  /**
   * The connected source with the lowest RTT among ids, skipping the ones in exclude.
   * Ties go to the principal, then to the oldest. null when none of them is connected.
   */
  best(ids, exclude = null) {
    const cands = sources.music().filter((s) => ids.includes(s.id) && !exclude?.has(s.id) && sources.isUp(s.id));
    return cands.length ? cands.sort(byRtt)[0].id : null;
  },
  /** Sources in display order: the principal first, then by the time they were added. */
  ordered: () => [...list].sort((a, b) => (b.principal ? 1 : 0) - (a.principal ? 1 : 0) || a.addedAt - b.addedAt),
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  refresh,
  start() {
    refresh();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refresh();
      else if (!inflight) schedule(); // hidden: the slow poll while music plays, else none
    });
  },
  /** Music plays (or is about to): keep polling, slowly, while the page is hidden. */
  setBackgroundPolling(on) {
    on = !!on;
    if (on === background) return;
    background = on;
    if (typeof document !== 'undefined' && document.hidden && !inflight) schedule();
  },
  /** A poll is scheduled or running (for the dev harness). */
  get polling() {
    return !!timer || !!inflight;
  },

  /** A request on this source just failed with "unreachable": treat it as down for a while. */
  markDown(id) {
    const was = sources.isUp(id);
    downUntil.set(id, Date.now() + DOWN_MS);
    if (was) emit();
    clearTimeout(timer);
    timer = setTimeout(refresh, 300);
  },
  /** A request on this source just worked: forget an earlier failure. */
  markUp(id) {
    if (!downUntil.has(id)) return;
    downUntil.delete(id);
    if (sources.isUp(id)) emit();
  },

  /**
   * POST /local/sources: pairs with the permanent code. Pairing can take a while (DHT). The
   * answer carries role and named (role null when the first sync was slower than the core waits).
   */
  async add(code) {
    const data = await local('POST', '/local/sources', { code }, 90000);
    await refresh();
    const s = data?.source;
    if (!s || !valid(s)) return null;
    const c = clean(s);
    const now = sources.get(c.id);
    return { ...c, role: c.role || now?.role || null, named: c.named ?? now?.named ?? null, profiles: c.profiles ?? now?.profiles ?? null, social: c.social ?? now?.social ?? null };
  },
  /**
   * The role of a source just added, once the core knows it: asked every `every` ms for up to
   * `ms`, only while the core has not said whether it has profiles at all (profiles null). Resolves
   * the source (its role null for a source without profiles, or when it never came).
   */
  async waitForRole(id, ms = 20000, every = 1000) {
    const until = Date.now() + ms;
    for (;;) {
      const s = sources.get(id);
      if (s?.role || (s && s.profiles !== null) || Date.now() >= until) return s;
      await new Promise((r) => setTimeout(r, every));
      await refresh();
    }
  },
  /**
   * The source's own name, set by its owner; every app reads it at its next sync. The sync asked
   * here is not waited for: the core answers it only once every source answered (up to 10 s).
   */
  async renameSource(id, name) {
    let res = null;
    let data = null;
    try {
      res = await fetch(`/s/${encodeURIComponent(id)}/api/admin/source`, {
        method: 'PATCH',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      data = await res.json();
    } catch {
      /* no answer, or no JSON body */
    }
    if (!res || !res.ok) {
      const e = new Error('Qualcosa non ha funzionato');
      e.status = res ? res.status : 0;
      e.code = typeof data?.code === 'string' ? data.code : null;
      e.src = id;
      throw e;
    }
    const saved = typeof data?.source?.name === 'string' && data.source.name ? data.source.name : name;
    renamed.set(id, { name: saved, until: Date.now() + RENAMED_MS });
    if (list.some((s) => s.id === id)) {
      list = list.map((s) => (s.id === id ? { ...s, name: saved, named: true } : s));
      lastJson = JSON.stringify(list);
      persist();
      emit();
    }
    sources.sync();
    return data?.source || null;
  },
  /** POST /local/sync: the core asks every source again (names, roles, the profile). */
  async sync() {
    try {
      await local('POST', '/local/sync', undefined, 15000);
    } catch {
      /* the next poll catches up */
    }
    await refresh();
  },
  async setPrincipal(id) {
    await local('PATCH', `/local/sources/${encodeURIComponent(id)}`, { principal: true });
    await refresh();
  },
  async remove(id) {
    await local('DELETE', `/local/sources/${encodeURIComponent(id)}`, undefined, 15000);
    downUntil.delete(id);
    health.delete(id);
    await refresh();
  },

  /** Last /api/health answer of a source ({ tracks, diskFreeBytes, version, ... }) or null. */
  healthOf: (id) => health.get(id)?.data || null,
  /** Fetches /api/health of every connected source (at most every 30 s each). */
  async loadHealth({ force = false } = {}) {
    const now = Date.now();
    await Promise.all(
      list
        .filter((s) => sources.isUp(s.id) && (force || !health.has(s.id) || now - health.get(s.id).at > 30000))
        .map(async (s) => {
          try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 8000);
            const res = await fetch(`/s/${encodeURIComponent(s.id)}/api/health`, { cache: 'no-store', signal: ctrl.signal });
            clearTimeout(t);
            if (res.ok) health.set(s.id, { at: Date.now(), data: await res.json() });
          } catch {
            /* keep the last answer */
          }
        })
    );
    emit();
  },
};
