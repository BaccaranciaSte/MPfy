// The rules a source applies to a person's playlists, shared by the source and the page so that
// the page lays a change it is still sending exactly as the source will keep it. The source runs
// a byte for byte copy of this file (server/userops.mjs). Pure functions over arrays of ids (or of
// any values compared with ===): no state, no imports.

/** id -> how many times it is in list. */
export function countIds(list) {
  const m = new Map();
  for (const id of list) m.set(id, (m.get(id) || 0) + 1);
  return m;
}

/** The position of `id` in `list` nearest to `at` (at itself first) not in `taken`, or -1. */
export function nearestSlot(list, id, at, taken = new Set()) {
  const from = Math.min(at, list.length - 1);
  for (let d = 0; from - d >= 0 || from + d < list.length; d++) {
    if (from - d >= 0 && list[from - d] === id && !taken.has(from - d)) return from - d;
    if (d > 0 && from + d < list.length && list[from + d] === id && !taken.has(from + d)) return from + d;
  }
  return -1;
}

/**
 * The positions of `list` that removals of `ids`, seen at `indexes`, take: for each id as many
 * as asked, less the copies gone since the client counted them (`counts`), each the copy at its
 * position when it is there, else the nearest one.
 */
export function removalSlots(list, indexes, ids, counts = null) {
  const left = new Map(); // id -> removals still to make
  ids.forEach((id) => left.set(id, (left.get(id) || 0) + 1));
  if (counts) {
    const have = countIds(list);
    const saw = new Map();
    ids.forEach((id, k) => saw.set(id, Math.max(saw.get(id) || 0, counts[k])));
    for (const [id, n] of saw) left.set(id, Math.max(0, left.get(id) - Math.max(0, n - (have.get(id) || 0))));
  }
  const drop = new Set();
  const take = (k, at) => {
    drop.add(at);
    left.set(ids[k], left.get(ids[k]) - 1);
  };
  const done = ids.map((id, k) => {
    const at = indexes[k];
    if (left.get(id) <= 0 || list[at] !== id || drop.has(at)) return false;
    take(k, at);
    return true;
  });
  ids.forEach((id, k) => {
    if (done[k] || left.get(id) <= 0) return;
    const at = nearestSlot(list, id, indexes[k], drop);
    if (at >= 0) take(k, at);
  });
  return drop;
}

/**
 * The order `want`, made from the list `base`, applied to the list as it is now (`cur`): songs
 * the list lost since base stay out, songs it gained stay in, right before the song they stood
 * before in cur (the next one want kept), or at the end; the rest follows want. The same id
 * more than once is matched by count, and a change made both by want and since base (a song
 * added on both sides, as a swap sent twice; a copy removed on both) counts once.
 */
export function rebaseOrder(cur, base, want) {
  const nb = countIds(base);
  const nc = countIds(cur);
  const nw = countIds(want);
  const lost = new Map(); // id -> copies of want the result leaves out (the first ones)
  const extra = new Map(); // id -> copies cur gained that the result keeps (the last ones)
  for (const id of new Set([...nb.keys(), ...nc.keys(), ...nw.keys()])) {
    const b = nb.get(id) || 0;
    const w = nw.get(id) || 0;
    const dc = (nc.get(id) || 0) - b;
    const dw = w - b;
    const n = dc < 0 && dw < 0 ? b + Math.min(dc, dw) : dc > 0 && dw > 0 ? b + Math.max(dc, dw) : b + dc + dw;
    if (n < w) lost.set(id, w - n);
    else if (n > w) extra.set(id, n - w);
  }
  const out = [];
  for (const id of want) {
    const k = lost.get(id) || 0;
    if (k > 0) lost.set(id, k - 1);
    else out.push(id);
  }
  if (extra.size === 0) return out;
  // The gained ones are the last occurrences of an id.
  const gained = new Array(cur.length).fill(false);
  for (let i = cur.length - 1; i >= 0; i--) {
    const k = extra.get(cur[i]) || 0;
    if (k > 0) {
      gained[i] = true;
      extra.set(cur[i], k - 1);
    }
  }
  // Where each other song of cur sits in out: its n-th occurrence there, -1 when want dropped it.
  const slots = new Map();
  out.forEach((id, i) => {
    if (!slots.has(id)) slots.set(id, []);
    slots.get(id).push(i);
  });
  const seen = new Map();
  const at = cur.map((id, i) => {
    if (gained[i]) return -1;
    const r = seen.get(id) || 0;
    seen.set(id, r + 1);
    const s = slots.get(id);
    return s && r < s.length ? s[r] : -1;
  });
  const before = new Map(); // position in out -> gained songs that go right before it
  let next = out.length;
  for (let i = cur.length - 1; i >= 0; i--) {
    if (gained[i]) {
      if (!before.has(next)) before.set(next, []);
      before.get(next).unshift(cur[i]);
    } else if (at[i] >= 0) next = at[i];
  }
  const res = [];
  for (let i = 0; i <= out.length; i++) {
    if (before.has(i)) res.push(...before.get(i));
    if (i < out.length) res.push(out[i]);
  }
  return res;
}
