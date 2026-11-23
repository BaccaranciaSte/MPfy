// One conversation while it is open (the chat page, or the chat in the PC's column):
//
//   GET /local/chat/<cid>/messages?limit=<n>[&before=<messageId>]   { v, messages, more }
//   POST /local/chat/<cid>/messages { id, text?, card?, replyTo? }  201 { message } (pending
//                                   while no source answered yet; the same id again: 200 with
//                                   that message, nothing sent twice)
//   DELETE /local/chat/<cid>/messages/<id>                          { ok } (own messages only)
//   PUT /local/chat/<cid>/read { id }                               { ok }
//
// The newest messages shown (at most 200) are asked again every 3 s while the conversation is open
// and the page visible, with the v held as If-None-Match: an unchanged conversation costs no body
// and draws nothing. Older pages of 50 come on demand and stay as they were loaded. Hidden: no
// timer at all.
//
// Sending: the page makes the id, shows the message at once (pending), and sends one message at a
// time in the order written; a message's id stays the same until its POST answers, so a request
// repeated after a lost answer is the same message. A message the sources refused goes with
// "Messaggio non inviato".
//
// A playlist shared in a chat is a small card (its id, name, track count and the sources where it
// lives): its tracks are read whole and current from such a source when they are needed
//   GET /local/chat/<cid>/messages/<messageId>/playlist
//       { playlist: { id, name, n, trackIds, cover, updatedAt, live } }   404: it is gone
// The core keeps the last copy it read and gives it (live false) when no such source answers; the
// page keeps what it read in memory only, like the messages themselves: nothing shared in a chat
// is written to this device's disk.

import { localRequest } from './sources.js';
import { normMsg, byTime, mergeWindow, newMessageId, cleanText, cleanNote, cutPoints, TEXT_MAX, NOTE_MAX } from './chat-data.js';
import { toast } from '../components/toast.js';

const POLL_MS = 3000;
const PAGE = 50;
const WINDOW_MAX = 200;
const READ_EVERY_MS = 2000;

/**
 * The conversation cid: call start() when it shows, stop() when it goes. onChange() runs after
 * each change of what it holds (its messages, more, loaded).
 */
export function openChat(cid, { onChange = () => {} } = {}) {
  let held = []; // ascending, the core's messages and the ones being sent (local)
  let v = null;
  let more = false;
  let loaded = false;
  let running = false;
  let timer = 0;
  let inflight = null;
  let olderInflight = null;
  const gone = new Set(); // ids seen deleted while open
  const told = new Set(); // ids whose failure was said
  const queue = []; // sends waiting their turn
  let sending = false;
  let lastRead = null;
  let readAt = 0;
  let readTimer = 0;
  let readWant = null;
  const base = `/local/chat/${encodeURIComponent(cid)}`;

  const changed = () => {
    try {
      onChange();
    } catch (err) {
      console.error('chat listener', err);
    }
  };

  /** A message the sources refused: it goes, said once. */
  function failedOnes(list) {
    let any = false;
    const out = [];
    for (const m of list) {
      if (m.state === 'failed' && m.mine) {
        if (!told.has(m.id)) {
          told.add(m.id);
          any = true;
        }
        continue;
      }
      out.push(m);
    }
    if (any) toast('Messaggio non inviato');
    return out;
  }

  /** The newest messages shown, again (one request at a time). */
  function poll() {
    if (inflight) return inflight;
    inflight = (async () => {
      const shown = held.filter((m) => !m.local).length;
      const limit = Math.min(WINDOW_MAX, Math.max(PAGE, shown));
      try {
        const data = await localRequest('GET', `${base}/messages?limit=${limit}`, undefined, 8000, { held: loaded ? v : null });
        if (data && (!loaded || data.v !== v || typeof data.v !== 'string')) {
          const fresh = failedOnes((Array.isArray(data.messages) ? data.messages : []).map(normMsg).filter(Boolean)).sort(byTime);
          // Older ones past the first window: later windows reach back to what is shown, and the
          // older pages say their own.
          if (!loaded) more = data.more === true;
          held = mergeWindow(held, fresh, gone);
          v = typeof data.v === 'string' ? data.v : null;
          loaded = true;
          changed();
        } else if (!loaded) {
          loaded = true;
          changed();
        }
      } catch (err) {
        if (!loaded && err && err.status === 404) {
          loaded = true;
          changed();
        }
      } finally {
        inflight = null;
      }
      schedule();
    })();
    return inflight;
  }

  function schedule() {
    clearTimeout(timer);
    timer = 0;
    if (!running || (typeof document !== 'undefined' && document.hidden)) return;
    timer = setTimeout(poll, POLL_MS);
  }

  const onVisibility = () => {
    if (!running) return;
    if (document.hidden) {
      clearTimeout(timer);
      timer = 0;
    } else poll();
  };

  /** The 50 messages before the oldest shown (one page at a time). Resolves how many came. */
  function loadOlder() {
    if (!more || olderInflight) return olderInflight || Promise.resolve(0);
    const oldest = held.find((m) => !m.local);
    if (!oldest) return Promise.resolve(0);
    olderInflight = (async () => {
      let n = 0;
      try {
        const data = await localRequest('GET', `${base}/messages?limit=${PAGE}&before=${encodeURIComponent(oldest.id)}`, undefined, 8000);
        const page = failedOnes((Array.isArray(data?.messages) ? data.messages : []).map(normMsg).filter(Boolean));
        const have = new Set(held.map((m) => m.id));
        const add = page.filter((m) => !have.has(m.id) && !gone.has(m.id));
        n = add.length;
        held = held.concat(add).sort(byTime);
        // A page with nothing new (the core no longer knows the oldest shown, after a restart, and
        // gives its newest instead) ends the older pages: asking again would bring the same.
        more = data?.more === true && n > 0;
        changed();
      } catch {
        /* asked again at the next scroll to the top */
      } finally {
        olderInflight = null;
      }
      return n;
    })();
    return olderInflight;
  }

  /** The body of a send, or null when there is nothing to send. */
  function bodyOf({ text = '', card = null, replyTo = null }) {
    const body = { id: newMessageId() };
    if (card) {
      body.card = card;
      const note = cutPoints(cleanNote(text), NOTE_MAX);
      if (note) body.text = note;
    } else {
      const t = cutPoints(cleanText(text), TEXT_MAX);
      if (!t) return null;
      body.text = t;
    }
    if (replyTo) body.replyTo = replyTo;
    return body;
  }

  /** What shows at once for a message being sent. */
  function localOf(body, reply) {
    return {
      id: body.id,
      from: null,
      name: '',
      mine: true,
      at: Math.max(Date.now(), held.length ? held[held.length - 1].at + 1 : 0),
      t: body.card ? 'card' : 'text',
      text: body.text || '',
      card: body.card || null,
      reply: reply || null,
      state: 'pending',
      preview: '',
      local: true,
    };
  }

  async function postOne(item) {
    let msg = null;
    try {
      const data = await localRequest('POST', `${base}/messages`, item.body, 15000);
      msg = normMsg(data?.message);
    } catch {
      msg = null;
    }
    const at = held.findIndex((m) => m.id === item.body.id);
    if (!msg || msg.state === 'failed') {
      if (at >= 0) held.splice(at, 1);
      if (!told.has(item.body.id)) {
        told.add(item.body.id);
        toast('Messaggio non inviato');
      }
      changed();
      item.done(null);
      return;
    }
    if (at >= 0) held[at] = msg;
    else if (!gone.has(msg.id)) held.push(msg);
    held.sort(byTime);
    changed();
    item.done(msg);
    // The newest message is now yours: your read mark moved with it.
    lastRead = msg.id;
    poll();
  }

  async function pump() {
    if (sending) return;
    sending = true;
    try {
      while (queue.length) await postOne(queue.shift());
    } finally {
      sending = false;
    }
  }

  /**
   * Sends a message: { text } or { card, text: the note } and replyTo (a message id). Shows it at
   * once; resolves with the core's message, or null when it was refused or there was nothing.
   */
  function send(what, { reply = null } = {}) {
    const body = bodyOf(what);
    if (!body) return Promise.resolve(null);
    held.push(localOf(body, reply));
    held.sort(byTime);
    changed();
    return new Promise((done) => {
      queue.push({ body, done });
      pump();
    });
  }

  /** Deletes one of your messages for everyone: it goes at once. */
  async function remove(id) {
    const at = held.findIndex((m) => m.id === id);
    if (at < 0 || !held[at].mine) return false;
    const [m] = held.splice(at, 1);
    gone.add(id);
    changed();
    try {
      await localRequest('DELETE', `${base}/messages/${encodeURIComponent(id)}`, undefined, 10000);
      v = null; // the next answer is taken whole
      return true;
    } catch (err) {
      if (err && err.status === 404) return true;
      gone.delete(id);
      held.push(m);
      held.sort(byTime);
      changed();
      toast('Qualcosa non ha funzionato');
      return false;
    }
  }

  /** The read mark at id, at most once every 2 s (the last one wanted goes when the time comes). */
  function markRead(id) {
    if (!id || id === lastRead) return;
    readWant = id;
    const wait = readAt + READ_EVERY_MS - Date.now();
    if (wait > 0) {
      if (!readTimer) readTimer = setTimeout(flushRead, wait);
      return;
    }
    flushRead();
  }

  function flushRead() {
    clearTimeout(readTimer);
    readTimer = 0;
    const id = readWant;
    readWant = null;
    if (!id || id === lastRead) return;
    lastRead = id;
    readAt = Date.now();
    localRequest('PUT', `${base}/read`, { id }, 8000).catch(() => {
      if (lastRead === id) lastRead = null;
    });
  }

  return {
    cid,
    /** Ascending: what the conversation holds now (the ones being sent included). */
    get messages() {
      return held;
    },
    get more() {
      return more;
    },
    get loaded() {
      return loaded;
    },
    get busyOlder() {
      return !!olderInflight;
    },
    /** That id was here and was deleted while open. */
    isGone: (id) => gone.has(id),
    find: (id) => held.find((m) => m.id === id) || null,
    start() {
      if (running) return;
      running = true;
      document.addEventListener('visibilitychange', onVisibility);
      poll();
    },
    stop() {
      running = false;
      clearTimeout(timer);
      timer = 0;
      if (readWant) flushRead();
      clearTimeout(readTimer);
      document.removeEventListener('visibilitychange', onVisibility);
    },
    poll,
    loadOlder,
    send,
    remove,
    markRead,
    /** A timer is set or a request runs (for the checks). */
    get polling() {
      return !!timer || !!inflight;
    },
  };
}

// ---- a playlist shared in a chat ----

const PL_KEEP = 40;
const plMemory = new Map(); // key -> { id, name, n, trackIds, cover, live }, the newest read last
const plGone = new Set(); // keys the core said are gone (the message deleted, the playlist removed)

const plKey = (cid, messageId) => `${cid}:${messageId}`;

/** The copy read last, kept for this session: the 40 newest playlists asked. */
function keepCopy(key, pl) {
  plMemory.delete(key);
  plMemory.set(key, pl);
  while (plMemory.size > PL_KEEP) plMemory.delete(plMemory.keys().next().value);
}

/** The copy held now (drawing never waits for a request), or null. */
export const playlistCopyNow = (cid, messageId) => plMemory.get(plKey(cid, messageId)) || null;

/** The core said that playlist is gone: nothing to show of it. */
export const playlistGone = (cid, messageId) => plGone.has(plKey(cid, messageId));

/** A playlist as the core gives it, or null when it is not one. */
function normPlaylist(p) {
  if (!p || typeof p !== 'object' || !Array.isArray(p.trackIds)) return null;
  const trackIds = p.trackIds.filter((t) => typeof t === 'string');
  return {
    id: typeof p.id === 'string' ? p.id : '',
    name: typeof p.name === 'string' ? p.name : '',
    n: Number.isFinite(p.n) ? Math.max(0, Math.floor(p.n)) : trackIds.length,
    trackIds,
    cover: typeof p.cover === 'string' && /^[0-9a-f]{24}$/.test(p.cover) ? p.cover : null,
    live: p.live !== false,
  };
}

const plInflight = new Map();

/**
 * The playlist shared as message messageId of conversation cid: read whole and current from a
 * source where it lives; when none answers the core gives the last copy it read (live false).
 * Resolves { playlist, stale }, { gone: true } when the core says it is gone (404), or null when
 * nothing came (the core away).
 */
export function readSharedPlaylist(cid, messageId) {
  const key = plKey(cid, messageId);
  if (plInflight.has(key)) return plInflight.get(key);
  const job = (async () => {
    try {
      const data = await localRequest('GET', `/local/chat/${encodeURIComponent(cid)}/messages/${encodeURIComponent(messageId)}/playlist`, undefined, 10000);
      const pl = normPlaylist(data && data.playlist);
      if (!pl) return null;
      plGone.delete(key);
      keepCopy(key, pl);
      return { playlist: pl, stale: !pl.live };
    } catch (err) {
      if (err && err.status === 404) {
        plMemory.delete(key);
        plGone.add(key);
        return { gone: true };
      }
      // The core is busy or away: what this session read stays.
      const copy = plMemory.get(key);
      return copy ? { playlist: copy, stale: true } : null;
    } finally {
      plInflight.delete(key);
    }
  })();
  plInflight.set(key, job);
  return job;
}

/**
 * One card message to conversation cid, outside any open chat ("Condividi con..."): the note as
 * its text, an id of its own. Resolves the core's message (pending when no source answered yet),
 * or null when it was refused.
 */
export async function sendCard(cid, card, note = '') {
  const body = { id: newMessageId(), card };
  const n = cutPoints(cleanNote(note), NOTE_MAX);
  if (n) body.text = n;
  try {
    const data = await localRequest('POST', `/local/chat/${encodeURIComponent(cid)}/messages`, body, 15000);
    const m = normMsg(data && data.message);
    return m && m.state !== 'failed' ? m : null;
  } catch {
    return null;
  }
}
