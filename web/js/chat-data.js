// The chats as the local core gives them, made safe to draw, and the small rules the page applies
// to them (pure: no DOM, no requests, so the unit checks run them in Node).
//
//   C (a conversation)  { id, kind: 'group' | 'direct', with, name, display, sources, ids, last,
//                         unread, muted, mutedUntil, at }
//   M (a message)       { id, from, name, mine, at, t: 'text' | 'card', text, card, reply, state:
//                         'sent' | 'pending' | 'failed', preview }
//   a music card        { kind: 'track' | 'album' | 'playlist', id, title, sub } and for a
//                         playlist also n (its tracks), sources (where it lives) and, when it has
//                         one, cover (the id of its cover on those sources)
//
// Texts follow the people's own rules: a chat message keeps its newlines and is at most 2000
// characters (code points, never UTF-16 units), a note is one line of at most 300.

export const TEXT_MAX = 2000;
export const NOTE_MAX = 300;
export const RUN_GAP_MS = 5 * 60000;

const HEX32 = /^[0-9a-f]{32}$/;
const ITEM_ID = /^[0-9a-f]{8,32}$/;
const KINDS = ['track', 'album', 'playlist'];

const str = (v, max = 4000) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v) => (Number.isFinite(v) ? v : Number(v) || 0);

/** At most max code points of s. */
export function cutPoints(s, max) {
  const a = Array.from(String(s ?? ''));
  return a.length > max ? a.slice(0, max).join('') : String(s ?? '');
}

/**
 * A chat message as it is sent: \r\n and \r become \n, the other control characters and the
 * line and paragraph separators go, then it is trimmed; newlines stay.
 */
export function cleanText(s) {
  return String(s ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, '')
    .trim();
}

/** A note as it is sent: every control and newline a space, spaces collapsed, trimmed. */
export function cleanNote(s) {
  return String(s ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A music card, or null when it is not one. */
export function normCard(c) {
  if (!c || typeof c !== 'object' || !KINDS.includes(c.kind) || typeof c.id !== 'string' || !ITEM_ID.test(c.id) || !str(c.title)) return null;
  const out = { kind: c.kind, id: c.id, title: str(c.title, 400), sub: str(c.sub, 400) };
  if (c.kind === 'playlist') {
    out.n = Math.max(0, Math.floor(num(c.n)));
    out.sources = Array.isArray(c.sources) ? c.sources.filter((x) => typeof x === 'string' && x).slice(0, 16) : [];
    if (typeof c.cover === 'string' && /^[0-9a-f]{8,64}$/.test(c.cover)) out.cover = c.cover;
  }
  return out;
}

/**
 * The quoted part of a reply: { id, from, text, card, gone } (card: { kind, id, title } or null;
 * gone: the core knows the quoted message was deleted for everyone, and sends its sender only).
 */
export function normReply(r) {
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !HEX32.test(r.id)) return null;
  const card = r.card && typeof r.card === 'object' && KINDS.includes(r.card.kind) && str(r.card.title) ? { kind: r.card.kind, id: str(r.card.id, 64), title: str(r.card.title, 400) } : null;
  return { id: r.id, from: HEX32.test(r.from || '') ? r.from : null, text: str(r.text, 600), card, gone: r.gone === true };
}

/** A message, or null when it is not one. */
export function normMsg(m) {
  if (!m || typeof m !== 'object' || !HEX32.test(m.id || '')) return null;
  const t = m.t === 'card' ? 'card' : 'text';
  const card = t === 'card' ? normCard(m.card) : null;
  if (t === 'card' && !card) return null;
  const state = m.state === 'pending' || m.state === 'failed' ? m.state : 'sent';
  return {
    id: m.id,
    from: HEX32.test(m.from || '') ? m.from : null,
    name: str(m.name, 120),
    mine: m.mine === true,
    at: num(m.at),
    t,
    text: str(m.text, 12000),
    card,
    reply: normReply(m.reply),
    state,
    preview: str(m.preview, 400),
  };
}

/** A conversation, or null when it is not one. */
export function normConv(c) {
  if (!c || typeof c !== 'object' || !HEX32.test(c.id || '')) return null;
  const kind = c.kind === 'group' ? 'group' : 'direct';
  const ids = Array.isArray(c.ids) ? c.ids.filter((x) => HEX32.test(x || '')) : [];
  if (!ids.includes(c.id)) ids.unshift(c.id);
  const mutedUntil = c.mutedUntil === null || c.mutedUntil === undefined ? null : num(c.mutedUntil);
  return {
    id: c.id,
    kind,
    with: kind === 'direct' && HEX32.test(c.with || '') ? c.with : null,
    name: typeof c.name === 'string' ? c.name.slice(0, 200) : null,
    display: str(c.display, 200),
    sources: Array.isArray(c.sources) ? c.sources.filter((x) => typeof x === 'string') : [],
    ids,
    last: normMsg(c.last),
    unread: Math.min(999, Math.max(0, Math.floor(num(c.unread)))),
    muted: c.muted === true,
    mutedUntil,
    at: num(c.at) || (c.last ? num(c.last.at) : 0),
  };
}

/** A card of "Condivisi con te": { cid, messageId, from, at, card, note, unseen, muted }, or null. */
export function normShared(x) {
  if (!x || typeof x !== 'object' || !HEX32.test(x.cid || '') || !HEX32.test(x.messageId || '')) return null;
  const card = normCard(x.card);
  if (!card) return null;
  return { cid: x.cid, messageId: x.messageId, from: HEX32.test(x.from || '') ? x.from : null, at: num(x.at), card, note: str(x.note, 600), unseen: x.unseen === true, muted: x.muted === true };
}

/** The one line a card gives in a list: "Brano: <titolo>", "Album: <titolo>", "Playlist: <titolo>". */
export const KIND_WORD = { track: 'Brano', album: 'Album', playlist: 'Playlist' };

/** The icon of a card's kind (Amici's lines, the quotes). */
export const KIND_ICON = { track: 'note', album: 'album', playlist: 'playlist' };

/** Calendar day of ms on this device, as a number (two times of one day give the same). */
export function dayKey(ms) {
  const d = new Date(ms);
  return d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate();
}

/**
 * The places of the messages in the log, in order: for each one whether a day label goes before it
 * (day), whether it opens a run (run) and closes one (end). A run is one sender's messages of one
 * day, each less than 5 minutes after the one before.
 */
export function layoutLog(msgs) {
  const out = msgs.map(() => ({ day: false, run: false, end: false }));
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const p = msgs[i - 1];
    const newDay = !p || dayKey(p.at) !== dayKey(m.at);
    out[i].day = newDay;
    out[i].run = newDay || !p || p.from !== m.from || p.mine !== m.mine || m.at - p.at >= RUN_GAP_MS;
    if (i > 0 && out[i].run) out[i - 1].end = true;
  }
  if (msgs.length) out[msgs.length - 1].end = true;
  return out;
}

/** Message order: by time, then by id. */
export const byTime = (a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** A new message id: 16 random bytes in hex. */
export function newMessageId() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** "Giulia \u00b7 K7Q2" as the core writes a name (the dot is U+00B7): { name, tag }. */
export function splitName(s) {
  const text = String(s || '');
  const at = text.lastIndexOf(' \u00b7 ');
  if (at > 0 && /^[0-9A-Z]{4}$/.test(text.slice(at + 3))) return { name: text.slice(0, at), tag: text.slice(at + 3) };
  return { name: text, tag: null };
}

/**
 * The window of the newest messages the core gave again (ascending), laid over what the page held:
 * what is in it is taken as it is now, what was held inside its time span and is no longer there
 * was deleted (its id goes to gone), what is older than it stays as it was loaded. Returns the
 * merged list, ascending.
 */
export function mergeWindow(held, fresh, gone = null) {
  if (!fresh.length) {
    // The newest messages are none: every message the page held is gone.
    if (gone) for (const m of held) if (!m.local) gone.add(m.id);
    return held.filter((m) => m.local);
  }
  const from = fresh[0];
  const ids = new Set(fresh.map((m) => m.id));
  const out = [];
  for (const m of held) {
    if (ids.has(m.id)) continue;
    if (m.local) {
      out.push(m);
      continue;
    }
    if (byTime(m, from) >= 0) {
      if (gone) gone.add(m.id);
      continue;
    }
    out.push(m);
  }
  for (const m of fresh) out.push(m);
  return out.sort(byTime);
}
