// Small pure helpers shared by the whole UI.

/** The visible product name, kept in one place so a rename touches one line. */
export const BRAND = 'MPfy';

/** Version of this web UI (shown in Impostazioni, Informazioni). */
export const APP_VERSION = '1.1.7';

/**
 * Lowercase, strip diacritics and fold apostrophe look-alikes, for accent and case insensitive
 * matching. Italian tags often carry the typographic apostrophe U+2019 where a keyboard types the
 * plain one ("l'ultima"): U+2018, U+2019, U+02BC, U+0060, U+00B4 and U+2032 all become "'".
 * The folding runs before NFD, which would split U+00B4 into a space and a combining accent.
 */
export function norm(s) {
  return String(s ?? '')
    .replace(/[\u2018\u2019\u02bc\u0060\u00b4\u2032]/g, "'")
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

const hashCache = new Map();
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;
const utf8 = new TextEncoder();

/**
 * FNV-1a 64 bit over the UTF-8 bytes, as 16 hex chars. Used for the derived album and artist
 * ids (the derived ids). Memoized: a library has far fewer distinct names than tracks.
 */
export function hashId(str) {
  let v = hashCache.get(str);
  if (v) return v;
  let h = FNV_OFFSET;
  for (const b of utf8.encode(str)) {
    h ^= BigInt(b);
    h = (h * FNV_PRIME) & MASK64;
  }
  v = h.toString(16).padStart(16, '0');
  hashCache.set(str, v);
  return v;
}

/** 3:07 or 1:02:03 */
export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const t = Math.floor(sec);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const r = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

/** Total duration, written short: "1 h 5 min", "23 min 10 s". */
export function fmtTotal(sec) {
  const t = Math.round(sec || 0);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const r = t % 60;
  if (h) return `${h} h ${m} min`;
  if (m) return r ? `${m} min ${r} s` : `${m} min`;
  return `${r} s`;
}

export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
export const nBrani = (n) => plural(n, 'brano', 'brani');

/** Greeting by hour (5-12, 12-18, otherwise). */
export function greeting(d = new Date()) {
  const h = d.getHours();
  if (h >= 5 && h < 12) return 'Buongiorno';
  if (h >= 12 && h < 18) return 'Buon pomeriggio';
  return 'Buonasera';
}

export function debounce(fn, ms) {
  let t = 0;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

/** Fisher-Yates, in place. */
export function shuffleInPlace(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
  return a;
}

const collator = new Intl.Collator('it', { sensitivity: 'base', numeric: true });
export const cmpText = (a, b) => collator.compare(a ?? '', b ?? '');
/** Two albums or artists by the name their files sort them under (the sort tags), else their name. */
export const bySortName = (a, b) => collator.compare(a.sortName || a.name || '', b.sortName || b.name || '') || cmpText(a.name, b.name);

/** "type:id" key of a play context ({ type, id }). */
export const ctxKey = (ctx) => (ctx ? `${ctx.type}:${ctx.id ?? ''}` : '');

export function parseCtxKey(key) {
  const i = key.indexOf(':');
  if (i < 0) return null;
  const id = key.slice(i + 1);
  return { type: key.slice(0, i), id: id === '' ? null : id };
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Stable hue from a string, for placeholder colors. */
export function hueOf(str) {
  let h = 0;
  for (const ch of String(str)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h % 360;
}

export function fmtSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1).replace('.', ',')} GB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

/** "1,2 GB", "340 MB", "12 KB": local space in the Italian form. */
export function fmtSpace(bytes) {
  const b = Math.max(0, Number(bytes) || 0);
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1).replace('.', ',')} GB`;
  if (b >= 1024 * 1024) return `${Math.round(b / (1024 * 1024))} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} KB`;
  return b ? '1 KB' : '0 MB';
}

/** Code points, never UTF-16 units: an emoji is one character of a name. */
export const charCount = (s) => Array.from(String(s ?? '')).length;

/** A name as the sources store it: no control characters, spaces collapsed, trimmed. */
export const cleanName = (s) =>
  String(s ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** 1234567 -> "1.234.567" (Italian thousands separator). */
export const fmtInt = (n) => new Intl.NumberFormat('it-IT').format(Math.round(n || 0));

/** Seeded PRNG (mulberry32): the same seed always gives the same sequence. */
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function lsGet(key, fallback = null) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

export function lsSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked: the feature degrades, the app keeps working */
  }
}

/** decodeURIComponent that never throws: null for a malformed sequence (a hand-typed URL). */
export function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/**
 * The full new order of a playlist after an edit that showed only some of its tracks (those
 * whose source library is loaded: a source offline with nothing cached, or paired a moment ago,
 * hides its tracks). origIds: the playlist when the edit started; kept: the shown entries left,
 * in their new order, each with `index`, its slot in origIds; shown(i): slot i was on screen.
 * The hidden ids are never dropped: each stays right after the shown track it followed (moving
 * with it), or at the top; those after a removed track follow the closest kept one before it.
 */
export function mergePlaylistOrder(origIds, kept, shown) {
  const lead = [];
  const after = new Map(); // slot of a shown track -> hidden ids that followed it
  const follow = (slot, list) => {
    if (slot < 0) lead.push(...list);
    else if (after.has(slot)) after.get(slot).push(...list);
    else after.set(slot, [...list]);
  };
  let anchor = -1;
  for (let i = 0; i < origIds.length; i++) {
    if (shown(i)) anchor = i;
    else follow(anchor, [origIds[i]]);
  }
  const keptSlots = new Set(kept.map((e) => e.index));
  let last = -1;
  for (let i = 0; i < origIds.length; i++) {
    if (!shown(i)) continue;
    if (keptSlots.has(i)) last = i;
    else if (after.has(i)) {
      const moved = after.get(i);
      after.delete(i);
      follow(last, moved);
    }
  }
  const out = [...lead];
  for (const e of kept) out.push(origIds[e.index], ...(after.get(e.index) || []));
  return out;
}
